package app.shadowassistant.android

import app.shadowassistant.android.UpdateRules.Failure
import app.shadowassistant.android.UpdateRules.UpdateException
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class UpdaterTest {
    private val prefix = UpdateRules.DOWNLOAD_PREFIX
    private val sha = "0123456789abcdef".repeat(4)

    private fun asset(name: String, url: String = "${prefix}v0.2.0/$name", size: Long = 1000) =
        JSONObject().put("name", name).put("browser_download_url", url).put("size", size)

    private fun releaseJson(tag: String = "v0.2.0", vararg assets: JSONObject = arrayOf(asset("update.json"), asset("shadow-v0.2.0.apk"))) =
        JSONObject().put("tag_name", tag).put("assets", JSONArray(assets.toList())).toString()

    private val release = UpdateRules.Release("v0.2.0", "${prefix}v0.2.0/update.json", "${prefix}v0.2.0/shadow-v0.2.0.apk", 1000)

    private fun manifestJson(
        versionCode: Any? = 12,
        versionName: Any? = "0.2.0",
        apk: Any? = "shadow-v0.2.0.apk",
        sha256: Any? = sha,
    ): String {
        val o = JSONObject()
        if (versionCode != null) o.put("versionCode", versionCode)
        if (versionName != null) o.put("versionName", versionName)
        if (apk != null) o.put("apk", apk)
        if (sha256 != null) o.put("sha256", sha256)
        return o.toString()
    }

    private fun expectFailure(expected: Failure, block: () -> Unit) {
        try {
            block()
            fail("expected $expected")
        } catch (e: UpdateException) {
            assertEquals(expected, e.failure)
        }
    }

    // --- releases/latest ---------------------------------------------------------------

    @Test
    fun validReleaseIsParsed() {
        assertEquals(release, UpdateRules.parseRelease(releaseJson()))
        assertEquals("0.2.0", release.versionName)
        assertEquals("shadow-v0.2.0.apk", release.apkName)
    }

    @Test
    fun otherAssetsAreIgnored() {
        val json = releaseJson(
            "v0.2.0",
            asset("notes.txt", "https://evil.example/notes.txt"),
            asset("update.json"),
            asset("shadow-v0.2.0.apk"),
        )
        assertEquals(release, UpdateRules.parseRelease(json))
    }

    @Test
    fun tagMustBeStrictSemver() {
        for (tag in listOf("0.2.0", "v0.2", "v0.2.0-rc1", "v0.2.0 ", "v1.2.3.4", "vx.y.z", "", "v0.2.0/../x")) {
            expectFailure(Failure.BAD_RELEASE) { UpdateRules.parseRelease(releaseJson(tag)) }
        }
    }

    @Test
    fun bothAssetsAreRequired() {
        expectFailure(Failure.BAD_RELEASE) { UpdateRules.parseRelease(releaseJson("v0.2.0", asset("update.json"))) }
        expectFailure(Failure.BAD_RELEASE) { UpdateRules.parseRelease(releaseJson("v0.2.0", asset("shadow-v0.2.0.apk"))) }
        // An APK named for another tag is not ours.
        expectFailure(Failure.BAD_RELEASE) {
            UpdateRules.parseRelease(releaseJson("v0.2.0", asset("update.json"), asset("shadow-v0.1.0.apk")))
        }
        expectFailure(Failure.BAD_RELEASE) { UpdateRules.parseRelease("not json") }
        expectFailure(Failure.BAD_RELEASE) { UpdateRules.parseRelease(JSONObject().put("tag_name", "v0.2.0").toString()) }
    }

    @Test
    fun assetUrlsMustBeThisRepositorysReleaseDownloads() {
        val bad = listOf(
            "https://github.com/someone/shadow-assistant/releases/download/v0.2.0/shadow-v0.2.0.apk",
            "https://github.com/ridvankuntug/shadow-assistant/releases/download/v0.1.0/shadow-v0.2.0.apk",
            "http://github.com/ridvankuntug/shadow-assistant/releases/download/v0.2.0/shadow-v0.2.0.apk",
            "https://evil.example/ridvankuntug/shadow-assistant/releases/download/v0.2.0/shadow-v0.2.0.apk",
            "${prefix}v0.2.0/shadow-v0.2.0.apk?x=1",
        )
        for (url in bad) {
            expectFailure(Failure.BLOCKED_URL) {
                UpdateRules.parseRelease(releaseJson("v0.2.0", asset("update.json"), asset("shadow-v0.2.0.apk", url)))
            }
        }
    }

    @Test
    fun apkSizeIsCapped() {
        expectFailure(Failure.TOO_LARGE) {
            UpdateRules.parseRelease(
                releaseJson("v0.2.0", asset("update.json"), asset("shadow-v0.2.0.apk", size = UpdateRules.MAX_APK_BYTES + 1)),
            )
        }
        expectFailure(Failure.BAD_RELEASE) {
            UpdateRules.parseRelease(releaseJson("v0.2.0", asset("update.json"), asset("shadow-v0.2.0.apk", size = 0)))
        }
        UpdateRules.checkApkSize(UpdateRules.MAX_APK_BYTES)
    }

    // --- update.json -------------------------------------------------------------------

    @Test
    fun validManifestIsParsed() {
        assertEquals(
            UpdateRules.Manifest(12, "0.2.0", "shadow-v0.2.0.apk", sha),
            UpdateRules.parseManifest(manifestJson(), release),
        )
        assertEquals(5_000_000_000L, UpdateRules.parseManifest(manifestJson(versionCode = 5_000_000_000L), release).versionCode)
    }

    @Test
    fun manifestVersionCodeMustBeAPositiveInteger() {
        for (bad in listOf<Any?>(null, "12", 12.5, 0, -3, true)) {
            expectFailure(Failure.BAD_RELEASE) { UpdateRules.parseManifest(manifestJson(versionCode = bad), release) }
        }
    }

    @Test
    fun manifestMustDescribeTheReleaseApk() {
        expectFailure(Failure.BAD_RELEASE) { UpdateRules.parseManifest(manifestJson(versionName = "0.3.0"), release) }
        expectFailure(Failure.BAD_RELEASE) { UpdateRules.parseManifest(manifestJson(versionName = null), release) }
        expectFailure(Failure.BAD_RELEASE) { UpdateRules.parseManifest(manifestJson(apk = "other.apk"), release) }
        expectFailure(Failure.BAD_RELEASE) { UpdateRules.parseManifest(manifestJson(apk = 5), release) }
        expectFailure(Failure.BAD_RELEASE) { UpdateRules.parseManifest("[]", release) }
    }

    @Test
    fun manifestShaMustBe64LowercaseHex() {
        for (bad in listOf<Any?>(null, sha.uppercase(), sha.dropLast(1), sha + "0", "z".repeat(64), 42)) {
            expectFailure(Failure.BAD_RELEASE) { UpdateRules.parseManifest(manifestJson(sha256 = bad), release) }
        }
    }

    // --- versions ----------------------------------------------------------------------

    @Test
    fun onlyAStrictlyHigherVersionCodeIsNewer() {
        assertTrue(UpdateRules.isNewer(13, 12))
        assertFalse(UpdateRules.isNewer(12, 12))
        assertFalse(UpdateRules.isNewer(11, 12))
    }

    @Test
    fun archiveMustBeOurPackageWithTheAnnouncedNewerVersion() {
        val manifest = UpdateRules.Manifest(12, "0.2.0", "shadow-v0.2.0.apk", sha)
        val ours = "app.shadowassistant.android"
        UpdateRules.checkArchive(ours, 12, ours, manifest, installedVersionCode = 11)
        expectFailure(Failure.WRONG_PACKAGE) { UpdateRules.checkArchive("evil.app", 12, ours, manifest, 11) }
        expectFailure(Failure.WRONG_PACKAGE) { UpdateRules.checkArchive(null, 12, ours, manifest, 11) }
        expectFailure(Failure.WRONG_PACKAGE) { UpdateRules.checkArchive(ours, 13, ours, manifest, 11) }
        expectFailure(Failure.NOT_NEWER) { UpdateRules.checkArchive(ours, 12, ours, manifest, 12) }
        expectFailure(Failure.NOT_NEWER) { UpdateRules.checkArchive(ours, 12, ours, manifest, 20) }
    }

    // --- URLs and redirects --------------------------------------------------------------

    @Test
    fun allowedUrls() {
        for (url in listOf(
            UpdateRules.LATEST_URL,
            "${prefix}v0.2.0/update.json",
            "https://objects.githubusercontent.com/github-production-release-asset/1?X-Amz=1",
            "https://release-assets.githubusercontent.com/github-production-release-asset/1",
            "https://GitHub.com/x",
            "https://github.com:443/x",
        )) {
            UpdateRules.checkUrl(url)
        }
    }

    @Test
    fun blockedUrls() {
        for (url in listOf(
            "http://github.com/x",
            "ftp://github.com/x",
            "https://evil.example/x",
            "https://github.com.evil.example/x",
            "https://evilgithub.com/x",
            "https://user@github.com/x",
            "https://github.com:8443/x",
            "https://raw.githubusercontent.com/x",
            "file:///data/x",
            "not a url",
            "",
        )) {
            expectFailure(Failure.BLOCKED_URL) { UpdateRules.checkUrl(url) }
        }
    }

    @Test
    fun redirectsAreResolvedAndRechecked() {
        val from = "${prefix}v0.2.0/shadow-v0.2.0.apk"
        assertEquals(
            "https://release-assets.githubusercontent.com/a?b=c",
            UpdateRules.redirectTarget(from, "https://release-assets.githubusercontent.com/a?b=c"),
        )
        assertEquals("https://github.com/other/path", UpdateRules.redirectTarget(from, "/other/path"))
        expectFailure(Failure.BLOCKED_URL) { UpdateRules.redirectTarget(from, "https://evil.example/apk") }
        expectFailure(Failure.BLOCKED_URL) { UpdateRules.redirectTarget(from, "http://objects.githubusercontent.com/a") }
        expectFailure(Failure.BLOCKED_URL) { UpdateRules.redirectTarget(from, "//evil.example/a") }
        expectFailure(Failure.NETWORK) { UpdateRules.redirectTarget(from, null) }
        expectFailure(Failure.NETWORK) { UpdateRules.redirectTarget(from, " ") }
    }

    // --- digests and signers ---------------------------------------------------------------

    @Test
    fun sha256OfKnownInput() {
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            UpdateRules.sha256Hex("abc".toByteArray()),
        )
        assertTrue(UpdateRules.digestsEqual(sha, sha))
        assertFalse(UpdateRules.digestsEqual(sha, sha.replaceRange(63, 64, "e")))
        assertFalse(UpdateRules.digestsEqual(sha, sha.dropLast(1)))
    }

    @Test
    fun signerChecks() {
        val release = "aa"
        val debug = "bb"
        val rotated = "cc"
        assertTrue(UpdateRules.signersCompatible(setOf(release), setOf(release), listOf(release)))
        // Debug build on the phone, release APK downloaded (or a stranger's key): refused.
        assertFalse(UpdateRules.signersCompatible(setOf(debug), setOf(release), listOf(release)))
        // Key rotation: the APK's lineage contains the installed key.
        assertTrue(UpdateRules.signersCompatible(setOf(debug), setOf(rotated), listOf(debug, rotated)))
        // The reverse (installed already rotated, APK signed with the old key only) is refused.
        assertFalse(UpdateRules.signersCompatible(setOf(rotated), setOf(debug), listOf(debug)))
        // Multiple signers: exact set only.
        assertTrue(UpdateRules.signersCompatible(setOf("a", "b"), setOf("b", "a"), emptyList()))
        assertFalse(UpdateRules.signersCompatible(setOf("a", "b"), setOf("a"), listOf("a")))
        assertFalse(UpdateRules.signersCompatible(setOf("a"), setOf("a", "b"), emptyList()))
        // Missing data never passes.
        assertFalse(UpdateRules.signersCompatible(emptySet(), emptySet(), emptyList()))
        assertFalse(UpdateRules.signersCompatible(setOf(release), emptySet(), listOf(release)))
    }
}
