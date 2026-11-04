package app.shadowassistant.android

import org.json.JSONObject
import java.net.URI
import java.net.URISyntaxException

/**
 * Galaxy Buds case battery (plan T11). Shadow never reads the case itself: Buds Case
 * Widget (github.com/ridvankuntug/BudsCaseWidget, v0.2.0 "Sharing with other apps")
 * does, and shares the last value through a read-only content provider plus a
 * change broadcast, both guarded by a `dangerous` permission. Shadow forwards the
 * value to the Core (`POST /device/state`).
 *
 * Pure decisions only (unit-tested); [CaseBatterySync] does the platform calls.
 */
object CaseBattery {
    // --- Buds Case Widget contract (checked against its v0.2.0 sources) -------------

    const val PACKAGE = "io.github.budscasewidget"
    const val PERMISSION = "io.github.budscasewidget.permission.READ_CASE_BATTERY"
    const val AUTHORITY = "io.github.budscasewidget.case"
    const val CONTENT_URI = "content://$AUTHORITY/battery"
    const val ACTION_CHANGED = "io.github.budscasewidget.action.CASE_BATTERY_CHANGED"
    const val COLUMN_PERCENT = "percent"
    const val COLUMN_AT = "at_epoch_ms"
    const val COLUMN_SOURCE = "source"
    val COLUMNS = arrayOf(COLUMN_PERCENT, COLUMN_AT, COLUMN_SOURCE)

    // --- Core contract ---------------------------------------------------------------

    const val DEVICE_STATE_PATH = "/device/state"
    const val SOURCE_MAX_CHARS = 64

    /** Same bounds the Core checks (relative to its clock; 400 otherwise): at most 5 minutes ahead… */
    const val MAX_FUTURE_SKEW_MS = 5 * 60 * 1000L

    /** …and at most 365 days old. */
    const val MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000L

    /** Retries after a network error / 5xx: attempts 0..4 retry, the 6th try gives up. */
    const val MAX_RETRIES = 5

    data class Reading(val percent: Int, val atEpochMs: Long, val source: String?)

    /**
     * Validates one provider row. Null (nothing is sent) if the percent is outside
     * 0–100 or the read time is missing, not positive, more than [MAX_FUTURE_SKEW_MS]
     * ahead or more than [MAX_AGE_MS] old. An unusable
     * `source` (blank or longer than [SOURCE_MAX_CHARS]) is dropped, not the reading:
     * the field is optional for the Core.
     */
    fun reading(percent: Long?, atEpochMs: Long?, source: String?, nowMs: Long): Reading? {
        if (percent == null || percent !in 0L..100L) return null
        if (atEpochMs == null || atEpochMs <= 0L) return null
        if (atEpochMs > nowMs + MAX_FUTURE_SKEW_MS || atEpochMs < nowMs - MAX_AGE_MS) return null
        val src = source?.trim()?.takeIf { it.isNotEmpty() && it.length <= SOURCE_MAX_CHARS }
        return Reading(percent.toInt(), atEpochMs, src)
    }

    /** `{"caseBattery":{"percent":…,"atEpochMs":…,"source":…}}`; `source` omitted when null. */
    fun body(reading: Reading): String {
        val battery = JSONObject()
            .put("percent", reading.percent)
            .put("atEpochMs", reading.atEpochMs)
        if (reading.source != null) battery.put("source", reading.source)
        return JSONObject().put("caseBattery", battery).toString()
    }

    /**
     * The Core's HTTP address for [DEVICE_STATE_PATH], derived from the stored WebSocket
     * URL (same host and port: ws→http, wss→https). Null when the URL is unusable or
     * plain HTTP would go to a host the network security config does not allow.
     */
    fun deviceStateUrl(coreUrl: String?): String? {
        val endpoint = CoreAddress.parse(coreUrl) ?: return null
        if (!CoreAddress.cleartextAllowed(endpoint)) return null
        val scheme = if (endpoint.secure) "https" else "http"
        return try {
            // The multi-argument constructor adds the brackets around an IPv6 literal.
            URI(scheme, null, endpoint.host, endpoint.port, DEVICE_STATE_PATH, null, null).toASCIIString()
        } catch (_: URISyntaxException) {
            null
        }
    }

    /**
     * The token may go into an `Authorization` header only if it is visible ASCII
     * (no spaces, CR/LF or other control/Unicode characters). Otherwise the HTTP stack
     * would throw with the header value in the exception message.
     */
    fun headerSafeToken(token: String?): Boolean =
        !token.isNullOrEmpty() && token.all { it in '!'..'~' }

    enum class Outcome { SENT, RETRY, GIVE_UP }

    /**
     * What to do after an attempt. [httpCode] null means no HTTP answer (network
     * error). 2xx: done (the Core answers 204, also for an older reading it ignores).
     * Network error and 5xx: retry while [attempt] (WorkManager's runAttemptCount, 0
     * on the first run) is below [MAX_RETRIES]. Everything else (3xx, any 4xx) will
     * not get better by repeating: give up.
     */
    fun outcome(httpCode: Int?, attempt: Int): Outcome {
        if (httpCode != null && httpCode in 200..299) return Outcome.SENT
        val transient = httpCode == null || httpCode in 500..599
        return if (transient && attempt < MAX_RETRIES) Outcome.RETRY else Outcome.GIVE_UP
    }

    /**
     * Ask for [PERMISSION] at startup only when Buds Case Widget (the permission's
     * owner) is installed — asking for an undefined permission is pointless — and only
     * once: a refusal leaves just this feature off; the user can still allow it in Settings.
     */
    fun shouldAsk(installed: Boolean, granted: Boolean, askedBefore: Boolean): Boolean =
        installed && !granted && !askedBefore
}
