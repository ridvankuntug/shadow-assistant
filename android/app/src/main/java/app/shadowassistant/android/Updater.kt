package app.shadowassistant.android

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URI
import java.net.URISyntaxException
import java.net.URL
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * In-app update from this repository's GitHub Releases (docs/10). Pure decisions
 * only (unit-tested); [Updater] does the network and platform calls.
 *
 * Trust chain: the release JSON comes from `api.github.com` over HTTPS; the
 * `update.json` asset (written by CI from the built APK) gives the expected
 * versionCode and SHA-256; the downloaded APK must match that digest, carry our
 * package name and that versionCode (> installed), and be signed by the key of
 * the installed app (or a rotation lineage from it). Android itself refuses a
 * different signer or a lower versionCode as well; these checks only fail earlier
 * and with a clear message.
 */
object UpdateRules {
    const val REPOSITORY = "ridvankuntug/shadow-assistant"
    const val LATEST_URL = "https://api.github.com/repos/$REPOSITORY/releases/latest"

    /** Every asset URL must be exactly `<prefix><tag>/<name>`: only this repository's release downloads. */
    const val DOWNLOAD_PREFIX = "https://github.com/$REPOSITORY/releases/download/"

    /** Hosts allowed on the API call and on every redirect hop (HTTPS only, default port). */
    val ALLOWED_HOSTS = setOf(
        "api.github.com",
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
    )

    const val MANIFEST_ASSET = "update.json"
    const val MAX_REDIRECTS = 5
    const val MAX_APK_BYTES = 60L * 1024 * 1024
    const val MAX_JSON_BYTES = 256 * 1024

    private val TAG_RE = Regex("""^v(\d{1,6})\.(\d{1,6})\.(\d{1,6})$""")
    private val SHA256_RE = Regex("^[0-9a-f]{64}$")

    enum class Failure {
        NETWORK, NO_RELEASE, BAD_RELEASE, BLOCKED_URL, TOO_LARGE,
        HASH_MISMATCH, WRONG_PACKAGE, NOT_NEWER, SIGNER_MISMATCH, INSTALL,
    }

    /** Message is for logs only (never a URL with a token: there are none); the UI maps [failure]. */
    class UpdateException(val failure: Failure, message: String) : IOException(message)

    /** The latest release: its tag and the two asset URLs (already checked against [DOWNLOAD_PREFIX]). */
    data class Release(val tag: String, val manifestUrl: String, val apkUrl: String, val apkSize: Long) {
        val versionName: String get() = tag.removePrefix("v")
        val apkName: String get() = apkName(tag)
    }

    /** Contents of `update.json`, validated against the [Release] it came with. */
    data class Manifest(val versionCode: Long, val versionName: String, val apk: String, val sha256: String)

    fun apkName(tag: String) = "shadow-$tag.apk"

    private fun fail(failure: Failure, message: String): Nothing = throw UpdateException(failure, message)

    /** Parses `releases/latest`. Needs a strict `vX.Y.Z` tag plus `update.json` and `shadow-<tag>.apk`. */
    fun parseRelease(json: String): Release {
        val root = try {
            JSONObject(json)
        } catch (_: JSONException) {
            fail(Failure.BAD_RELEASE, "release is not JSON")
        }
        val tag = root.optString("tag_name")
        if (!TAG_RE.matches(tag)) fail(Failure.BAD_RELEASE, "unexpected tag")
        val assets = root.optJSONArray("assets") ?: fail(Failure.BAD_RELEASE, "no assets")
        var manifestUrl: String? = null
        var apkUrl: String? = null
        var apkSize = -1L
        for (i in 0 until assets.length()) {
            val asset = assets.optJSONObject(i) ?: continue
            val name = asset.optString("name")
            if (name != MANIFEST_ASSET && name != apkName(tag)) continue
            val url = asset.optString("browser_download_url")
            if (url != "$DOWNLOAD_PREFIX$tag/$name") fail(Failure.BLOCKED_URL, "asset url outside this repository's release")
            if (name == MANIFEST_ASSET) {
                manifestUrl = url
            } else {
                apkUrl = url
                apkSize = asset.optLong("size", -1L)
            }
        }
        if (manifestUrl == null || apkUrl == null) fail(Failure.BAD_RELEASE, "missing update.json or apk asset")
        checkApkSize(apkSize)
        return Release(tag, manifestUrl, apkUrl, apkSize)
    }

    /** The asset size GitHub reports must be positive and within [MAX_APK_BYTES]. */
    fun checkApkSize(size: Long) {
        if (size <= 0) fail(Failure.BAD_RELEASE, "apk size unknown")
        if (size > MAX_APK_BYTES) fail(Failure.TOO_LARGE, "apk too large")
    }

    /** Parses `update.json`; it must describe exactly the APK of [release]. */
    fun parseManifest(json: String, release: Release): Manifest {
        val root = try {
            JSONObject(json)
        } catch (_: JSONException) {
            fail(Failure.BAD_RELEASE, "update.json is not JSON")
        }
        // An integral JSON number only: no string, no fraction.
        val versionCode = when (val v = root.opt("versionCode")) {
            is Int -> v.toLong()
            is Long -> v
            else -> fail(Failure.BAD_RELEASE, "versionCode missing or not an integer")
        }
        if (versionCode <= 0) fail(Failure.BAD_RELEASE, "versionCode not positive")
        val versionName = root.opt("versionName") as? String
        val apk = root.opt("apk") as? String
        val sha256 = root.opt("sha256") as? String
        if (versionName != release.versionName) fail(Failure.BAD_RELEASE, "versionName does not match the tag")
        if (apk != release.apkName) fail(Failure.BAD_RELEASE, "apk name does not match the tag")
        if (sha256 == null || !SHA256_RE.matches(sha256)) fail(Failure.BAD_RELEASE, "sha256 missing or malformed")
        return Manifest(versionCode, versionName, apk, sha256)
    }

    /** Only a strictly higher versionCode is an update (equal and lower are refused; docs/10 D1). */
    fun isNewer(candidate: Long, installed: Long): Boolean = candidate > installed

    /**
     * Accepts [url] only if it is `https`, has no user info, uses the default port and
     * its host is in [ALLOWED_HOSTS]. Returns the normalised URL.
     */
    fun checkUrl(url: String): String {
        val uri = try {
            URI(url)
        } catch (_: URISyntaxException) {
            fail(Failure.BLOCKED_URL, "malformed url")
        }
        val host = uri.host?.lowercase(Locale.ROOT)
        if (!"https".equals(uri.scheme, ignoreCase = true) ||
            host == null || host !in ALLOWED_HOSTS ||
            uri.rawUserInfo != null ||
            (uri.port != -1 && uri.port != 443)
        ) {
            fail(Failure.BLOCKED_URL, "blocked url")
        }
        return uri.toASCIIString()
    }

    /** The next hop of a redirect: [location] resolved against [current], then [checkUrl]. */
    fun redirectTarget(current: String, location: String?): String {
        if (location.isNullOrBlank()) fail(Failure.NETWORK, "redirect without location")
        val next = try {
            URI(current).resolve(location.trim())
        } catch (_: IllegalArgumentException) {
            fail(Failure.BLOCKED_URL, "malformed redirect")
        } catch (_: URISyntaxException) {
            fail(Failure.BLOCKED_URL, "malformed redirect")
        }
        return checkUrl(next.toString())
    }

    fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it.toInt() and 0xff) }

    fun sha256Hex(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))

    /** Constant-time comparison of two lowercase hex digests. */
    fun digestsEqual(actual: String, expected: String): Boolean =
        MessageDigest.isEqual(actual.toByteArray(Charsets.US_ASCII), expected.toByteArray(Charsets.US_ASCII))

    /**
     * Whether an APK may replace the installed app, as far as signing goes. All values are
     * SHA-256 hex of certificates. Same current signer set → yes. Otherwise only with one
     * signer on each side and the installed signer in the APK's rotation history (APK
     * Signature Scheme v3 lineage, docs/10 option B) → yes. Anything else (debug vs
     * release key, a stranger's key, missing data) → no.
     */
    fun signersCompatible(installedCurrent: Set<String>, apkCurrent: Set<String>, apkHistory: List<String>): Boolean {
        if (installedCurrent.isEmpty() || apkCurrent.isEmpty()) return false
        if (installedCurrent == apkCurrent) return true
        return installedCurrent.size == 1 && apkCurrent.size == 1 && installedCurrent.single() in apkHistory
    }

    /** Package and version checks of the downloaded archive (signer is checked separately). */
    fun checkArchive(packageName: String?, versionCode: Long, ourPackage: String, manifest: Manifest, installedVersionCode: Long) {
        if (packageName != ourPackage) fail(Failure.WRONG_PACKAGE, "apk is for another package")
        if (versionCode != manifest.versionCode) fail(Failure.WRONG_PACKAGE, "apk versionCode differs from update.json")
        if (!isNewer(versionCode, installedVersionCode)) fail(Failure.NOT_NEWER, "apk is not newer than the installed app")
    }
}

/**
 * Network and platform side of [UpdateRules]: runs only on user action from
 * [UpdateActivity], on a background thread. One flow per process ([inFlight]).
 * The APK lives in `cacheDir/update/` (app-private) and is deleted once it was
 * copied into the install session, or on any failure.
 */
class Updater(context: Context) {
    private val app = context.applicationContext
    private val pm = app.packageManager

    sealed interface Check {
        data class UpToDate(val installedName: String) : Check
        data class Available(val release: UpdateRules.Release, val manifest: UpdateRules.Manifest, val installedName: String) : Check
    }

    fun installedVersionName(): String = packageInfo(0).versionName.orEmpty()

    private fun installedVersionCode(): Long = packageInfo(0).longVersionCode

    /** Latest release vs installed versionCode. Throws [UpdateRules.UpdateException]. */
    fun check(): Check {
        val release = UpdateRules.parseRelease(fetchJson(UpdateRules.LATEST_URL, api = true))
        val manifest = UpdateRules.parseManifest(fetchJson(release.manifestUrl, api = false), release)
        val installedName = installedVersionName()
        return if (UpdateRules.isNewer(manifest.versionCode, installedVersionCode())) {
            Check.Available(release, manifest, installedName)
        } else {
            Check.UpToDate(installedName)
        }
    }

    /**
     * Downloads and fully verifies the APK (size, SHA-256, package, versionCode, signer).
     * [progress] gets (bytes so far, expected total). Returns the verified file.
     */
    fun download(release: UpdateRules.Release, manifest: UpdateRules.Manifest, progress: (Long, Long) -> Unit): File {
        val dir = File(app.cacheDir, UPDATE_DIR).apply { mkdirs() }
        // Runs under [inFlight]: leftovers of an earlier, interrupted flow can go.
        dir.listFiles()?.forEach { it.delete() }
        val file = File(dir, release.apkName)
        try {
            val digest = MessageDigest.getInstance("SHA-256")
            open(release.apkUrl, api = false).use { conn ->
                val declared = conn.contentLength
                if (declared > UpdateRules.MAX_APK_BYTES) throw UpdateRules.UpdateException(UpdateRules.Failure.TOO_LARGE, "content-length too large")
                conn.input.use { input ->
                    file.outputStream().use { out ->
                        val buf = ByteArray(64 * 1024)
                        var total = 0L
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            total += n
                            if (total > UpdateRules.MAX_APK_BYTES) throw UpdateRules.UpdateException(UpdateRules.Failure.TOO_LARGE, "apk too large")
                            digest.update(buf, 0, n)
                            out.write(buf, 0, n)
                            progress(total, release.apkSize)
                        }
                    }
                }
            }
            if (file.length() != release.apkSize) throw UpdateRules.UpdateException(UpdateRules.Failure.BAD_RELEASE, "size differs from the release asset")
            // Digest before parsing: the archive parser only ever sees the published file.
            if (!UpdateRules.digestsEqual(UpdateRules.hex(digest.digest()), manifest.sha256)) {
                throw UpdateRules.UpdateException(UpdateRules.Failure.HASH_MISMATCH, "sha256 mismatch")
            }
            verifyArchive(file, manifest)
        } catch (e: Throwable) {
            file.delete()
            throw e
        }
        return file
    }

    private fun verifyArchive(file: File, manifest: UpdateRules.Manifest) {
        val archive = archiveInfo(file) ?: throw UpdateRules.UpdateException(UpdateRules.Failure.WRONG_PACKAGE, "not a readable apk")
        UpdateRules.checkArchive(archive.packageName, archive.longVersionCode, app.packageName, manifest, installedVersionCode())
        val apkSigning = archive.signingInfo ?: throw UpdateRules.UpdateException(UpdateRules.Failure.SIGNER_MISMATCH, "apk has no signing info")
        val installedSigning = packageInfo(PackageManager.GET_SIGNING_CERTIFICATES).signingInfo
            ?: throw UpdateRules.UpdateException(UpdateRules.Failure.SIGNER_MISMATCH, "installed app has no signing info")
        val apkHistory = if (apkSigning.hasMultipleSigners()) emptyList() else certDigests(apkSigning.signingCertificateHistory)
        val compatible = UpdateRules.signersCompatible(
            installedCurrent = certDigests(installedSigning.apkContentsSigners).toSet(),
            apkCurrent = certDigests(apkSigning.apkContentsSigners).toSet(),
            apkHistory = apkHistory,
        )
        if (!compatible) throw UpdateRules.UpdateException(UpdateRules.Failure.SIGNER_MISMATCH, "signer differs from the installed app")
    }

    private fun certDigests(certs: Array<android.content.pm.Signature>?): List<String> =
        certs.orEmpty().map { UpdateRules.sha256Hex(it.toByteArray()) }

    /**
     * Hands the verified APK to a [PackageInstaller] session. The system always shows its
     * confirmation (USER_ACTION_REQUIRED); the result arrives as an intent to [UpdateActivity].
     * The file is deleted afterwards in every case.
     *
     * The lock ([inFlight]) ends when the session is committed, not when the user answers the
     * system dialog: if that answer never reaches us (app in the background, process death),
     * a lock held until then would block every later attempt. So a new flow started from the
     * shortcut replaces a still-pending one (its session is abandoned here), and
     * [activeSessionId] lets [UpdateActivity] ignore late results of replaced sessions.
     */
    fun install(apk: File) {
        val installer = pm.packageInstaller
        try {
            // Sessions of an earlier flow (e.g. the confirmation was never answered): replaced.
            activeSessionId.set(NO_SESSION)
            for (old in installer.mySessions) runCatching { installer.abandonSession(old.sessionId) }
            val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply {
                setAppPackageName(app.packageName)
                setSize(apk.length())
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
                }
            }
            val sessionId = installer.createSession(params)
            activeSessionId.set(sessionId)
            try {
                installer.openSession(sessionId).use { session ->
                    apk.inputStream().use { input ->
                        session.openWrite("base.apk", 0, apk.length()).use { out ->
                            input.copyTo(out)
                            session.fsync(out)
                        }
                    }
                    session.commit(statusIntent(sessionId).intentSender)
                }
            } catch (e: Exception) {
                activeSessionId.compareAndSet(sessionId, NO_SESSION)
                runCatching { installer.abandonSession(sessionId) }
                throw e
            }
        } catch (e: UpdateRules.UpdateException) {
            throw e
        } catch (e: Exception) {
            Log.w(TAG, "update: install session failed (${e.javaClass.simpleName})")
            throw UpdateRules.UpdateException(UpdateRules.Failure.INSTALL, "install session failed")
        } finally {
            apk.delete()
        }
    }

    /**
     * Explicit intent to the non-exported [UpdateActivity]. MUTABLE because the installer
     * adds the status extras; explicit component, so nothing else can receive it.
     */
    private fun statusIntent(sessionId: Int): PendingIntent {
        val intent = Intent(app, UpdateActivity::class.java)
            .setAction(UpdateActivity.ACTION_INSTALL_STATUS)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(app, sessionId, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
    }

    private fun packageInfo(flags: Int): PackageInfo =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.getPackageInfo(app.packageName, PackageManager.PackageInfoFlags.of(flags.toLong()))
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(app.packageName, flags)
        }

    private fun archiveInfo(file: File): PackageInfo? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.getPackageArchiveInfo(file.path, PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()))
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageArchiveInfo(file.path, PackageManager.GET_SIGNING_CERTIFICATES)
        }

    private fun fetchJson(url: String, api: Boolean): String = open(url, api).use { conn ->
        if (conn.contentLength > UpdateRules.MAX_JSON_BYTES) throw UpdateRules.UpdateException(UpdateRules.Failure.BAD_RELEASE, "json too large")
        String(readLimited(conn.input, UpdateRules.MAX_JSON_BYTES), Charsets.UTF_8)
    }

    private fun readLimited(input: InputStream, max: Int): ByteArray = input.use {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(8 * 1024)
        while (true) {
            val n = it.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            if (out.size() > max) throw UpdateRules.UpdateException(UpdateRules.Failure.BAD_RELEASE, "json too large")
        }
        out.toByteArray()
    }

    /**
     * GET [start] with redirects followed by hand, each hop re-checked by [UpdateRules.checkUrl].
     * Any I/O problem becomes [UpdateRules.Failure.NETWORK]; 404 on the latest-release call
     * means "no release yet".
     */
    private fun open(start: String, api: Boolean): Connection {
        var current = UpdateRules.checkUrl(start)
        repeat(UpdateRules.MAX_REDIRECTS + 1) {
            val conn = try {
                (URL(current).openConnection() as HttpURLConnection).apply {
                    instanceFollowRedirects = false
                    useCaches = false
                    connectTimeout = CONNECT_TIMEOUT_MS
                    readTimeout = READ_TIMEOUT_MS
                    setRequestProperty("User-Agent", "ShadowAssistant-Android")
                    if (api) {
                        setRequestProperty("Accept", "application/vnd.github+json")
                        setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
                    }
                }
            } catch (e: IOException) {
                throw UpdateRules.UpdateException(UpdateRules.Failure.NETWORK, "connect failed (${e.javaClass.simpleName})")
            }
            val code = try {
                conn.responseCode
            } catch (e: IOException) {
                conn.disconnect()
                throw UpdateRules.UpdateException(UpdateRules.Failure.NETWORK, "request failed (${e.javaClass.simpleName})")
            }
            when (code) {
                HttpURLConnection.HTTP_OK -> return Connection(conn)
                301, 302, 303, 307, 308 -> {
                    val location = conn.getHeaderField("Location")
                    conn.disconnect()
                    current = UpdateRules.redirectTarget(current, location)
                }
                else -> {
                    conn.disconnect()
                    if (code == HttpURLConnection.HTTP_NOT_FOUND && start == UpdateRules.LATEST_URL) {
                        throw UpdateRules.UpdateException(UpdateRules.Failure.NO_RELEASE, "no release yet")
                    }
                    throw UpdateRules.UpdateException(UpdateRules.Failure.NETWORK, "http $code")
                }
            }
        }
        throw UpdateRules.UpdateException(UpdateRules.Failure.NETWORK, "too many redirects")
    }

    /** Wraps read errors in [UpdateRules.Failure.NETWORK] so the UI shows a network message. */
    private class Connection(private val conn: HttpURLConnection) : AutoCloseable {
        val contentLength: Long get() = conn.contentLengthLong
        val input: InputStream by lazy {
            val raw = try {
                conn.inputStream
            } catch (e: IOException) {
                throw UpdateRules.UpdateException(UpdateRules.Failure.NETWORK, "read failed (${e.javaClass.simpleName})")
            }
            object : InputStream() {
                override fun read(): Int = guard { raw.read() }
                override fun read(b: ByteArray, off: Int, len: Int): Int = guard { raw.read(b, off, len) }
                override fun close() = raw.close()
            }
        }

        override fun close() = conn.disconnect()

        private inline fun guard(block: () -> Int): Int = try {
            block()
        } catch (e: UpdateRules.UpdateException) {
            throw e
        } catch (e: IOException) {
            throw UpdateRules.UpdateException(UpdateRules.Failure.NETWORK, "read failed (${e.javaClass.simpleName})")
        }
    }

    companion object {
        private const val TAG = "Shadow"
        private const val UPDATE_DIR = "update"
        private const val CONNECT_TIMEOUT_MS = 15_000
        private const val READ_TIMEOUT_MS = 30_000

        /** One check/download/install at a time per process (also across activity instances). */
        val inFlight = AtomicBoolean(false)

        const val NO_SESSION = -1

        /** The session whose result is still expected; [NO_SESSION] if none is known (e.g. after process death). */
        val activeSessionId = AtomicInteger(NO_SESSION)
    }
}
