package app.shadowassistant.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.Cursor
import android.os.Build
import android.util.Log
import androidx.core.net.toUri
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Platform side of [CaseBattery]: permission checks, the one-off unique WorkManager
 * job and the provider read. Nothing runs in the background except that job, which
 * is enqueued by [CaseBatteryReceiver] (a Buds Case Widget broadcast) or by the
 * activity at startup (catch-up for a broadcast that was missed).
 *
 * Sender check: the change broadcast is sent by Buds Case Widget with
 * `sendBroadcast(intent, READ_CASE_BATTERY)`, so only a holder of the permission
 * receives it. Buds Case Widget itself does not hold that permission (it only
 * defines it), so `android:permission` on the receiver would block the real sender;
 * and any app can send an explicit intent to an exported receiver. So the broadcast
 * is only a trigger: its extras are ignored and the worker reads the value from the
 * permission-protected provider, after checking the provider belongs to
 * [CaseBattery.PACKAGE]. A forged broadcast can at most cause a re-send of the real value.
 */
object CaseBatterySync {
    private const val TAG = "Shadow"
    private const val WORK_NAME = "caseBattery.send"

    /** Buds Case Widget is installed and is the owner of the permission (not some other app defining the same name). */
    fun installed(context: Context): Boolean = try {
        context.packageManager.getPermissionInfo(CaseBattery.PERMISSION, 0).packageName == CaseBattery.PACKAGE
    } catch (_: PackageManager.NameNotFoundException) {
        false
    }

    fun granted(context: Context): Boolean =
        context.checkSelfPermission(CaseBattery.PERMISSION) == PackageManager.PERMISSION_GRANTED

    /**
     * Enqueues the send job if the user allowed the permission; silent no-op otherwise
     * (feature off). REPLACE: a newer trigger replaces a pending or running one, and the
     * job reads the provider when it runs, so the newest value is what gets sent.
     */
    fun syncIfAllowed(context: Context) {
        if (!granted(context)) return
        val request = OneTimeWorkRequestBuilder<CaseBatteryWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .build()
        try {
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.REPLACE, request)
        } catch (e: IllegalStateException) {
            // WorkManager could not initialise (e.g. its database is unusable): only this feature is affected.
            Log.w(TAG, "case battery: could not enqueue (${e.javaClass.simpleName})")
        }
    }

    /** The provider's row, validated; null if there is none, it is unusable or the provider is not Buds Case Widget's. */
    fun readProvider(context: Context, nowMs: Long): CaseBattery.Reading? {
        val owner = context.packageManager.resolveContentProvider(CaseBattery.AUTHORITY, 0)?.packageName
        if (owner != CaseBattery.PACKAGE) return null
        return try {
            context.contentResolver.query(CaseBattery.CONTENT_URI.toUri(), CaseBattery.COLUMNS, null, null, null)?.use { c ->
                if (!c.moveToFirst()) return@use null
                CaseBattery.reading(
                    percent = c.longOrNull(CaseBattery.COLUMN_PERCENT),
                    atEpochMs = c.longOrNull(CaseBattery.COLUMN_AT),
                    source = c.stringOrNull(CaseBattery.COLUMN_SOURCE),
                    nowMs = nowMs,
                )
            }
        } catch (e: RuntimeException) {
            // SecurityException (permission revoked meanwhile), IllegalArgumentException, provider crash.
            Log.w(TAG, "case battery: provider read failed (${e.javaClass.simpleName})")
            null
        }
    }

    private fun Cursor.longOrNull(column: String): Long? {
        val i = getColumnIndex(column)
        return if (i >= 0 && getType(i) == Cursor.FIELD_TYPE_INTEGER) getLong(i) else null
    }

    private fun Cursor.stringOrNull(column: String): String? {
        val i = getColumnIndex(column)
        return if (i >= 0 && getType(i) == Cursor.FIELD_TYPE_STRING) getString(i) else null
    }
}

/**
 * Buds Case Widget's change broadcast (explicit, permission-guarded; see [CaseBatterySync]).
 * No network or provider work here: it only enqueues the job.
 */
class CaseBatteryReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != CaseBattery.ACTION_CHANGED) return
        CaseBatterySync.syncIfAllowed(context)
    }
}

/**
 * Reads the case value from the provider and posts it to the Core with the app's
 * current connection settings (address and device token as the UI stored them).
 * Gives up quietly when anything needed is missing (permission, token, address,
 * local network permission); retries only network errors and 5xx, a bounded number
 * of times. The token never appears in a log line or exception message.
 */
class CaseBatteryWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result = try {
        send()
    } catch (e: Exception) {
        // Never let an exception reach WorkManager's log: its message could carry a header value.
        Log.w(TAG, "case battery: unexpected ${e.javaClass.simpleName}; giving up")
        Result.failure()
    }

    private fun send(): Result {
        val ctx = applicationContext
        if (!CaseBatterySync.granted(ctx)) return Result.success()
        if (LocalNetworkPermission.missing(
                Build.VERSION.SDK_INT,
                ctx.checkSelfPermission(LocalNetworkPermission.PERMISSION) == PackageManager.PERMISSION_GRANTED,
            )
        ) {
            Log.i(TAG, "case battery: local network permission missing; not sent")
            return Result.success()
        }
        val storage = AppStorage.bridge(ctx) { Log.w(TAG, it) }
        // One atomic snapshot; null while the UI is between writing the address and the token
        // (a new address must never go out with the old token). The token write re-triggers this job.
        val connection = storage.connection() ?: return Result.success()
        val url = CaseBattery.deviceStateUrl(connection.coreUrl) ?: return Result.success()
        val token = connection.token
        if (!CaseBattery.headerSafeToken(token)) return Result.success()
        val reading = CaseBatterySync.readProvider(ctx, System.currentTimeMillis()) ?: return Result.success()
        // Replaced (REPLACE) or stopped while reading: the newer job sends instead.
        if (isStopped) return Result.success()

        val code = try {
            post(url, token, CaseBattery.body(reading))
        } catch (e: IOException) {
            Log.w(TAG, "case battery: send failed (${e.javaClass.simpleName})")
            null
        }
        return when (CaseBattery.outcome(code, runAttemptCount)) {
            CaseBattery.Outcome.SENT -> Result.success()
            CaseBattery.Outcome.RETRY -> Result.retry()
            CaseBattery.Outcome.GIVE_UP -> {
                Log.w(TAG, "case battery: Core answered ${code ?: "nothing"}; giving up")
                Result.failure()
            }
        }
    }

    /** Returns the HTTP status. Redirects are not followed, so the bearer token only ever goes to the configured Core. */
    private fun post(url: String, token: String, body: String): Int {
        val bytes = body.toByteArray(Charsets.UTF_8)
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.instanceFollowRedirects = false
            conn.useCaches = false
            conn.connectTimeout = TIMEOUT_MS
            conn.readTimeout = TIMEOUT_MS
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setFixedLengthStreamingMode(bytes.size)
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.setRequestProperty("Content-Type", "application/json")
            conn.outputStream.use { it.write(bytes) }
            return conn.responseCode
        } finally {
            conn.disconnect()
        }
    }

    private companion object {
        const val TAG = "Shadow"
        const val TIMEOUT_MS = 10_000
    }
}
