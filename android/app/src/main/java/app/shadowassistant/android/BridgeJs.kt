package app.shadowassistant.android

import org.json.JSONObject

/** Error codes of the platform adapter contract (docs/03-platform-adapter.md §1). */
object ErrorCode {
    const val PERMISSION_DENIED = "permission_denied"
    const val NOT_SUPPORTED = "not_supported"
    const val BUSY = "busy"
    const val NOT_RECORDING = "not_recording"
    const val CAPTURE_ABORTED = "capture_aborted"
    const val PLAYBACK_FAILED = "playback_failed"
    const val CANCELLED = "cancelled"
    const val UNKNOWN = "unknown"
}

/**
 * Builds the payloads and JavaScript snippets of the `ShadowAndroid` bridge
 * (docs/03-platform-adapter.md §4.2 callbacks, §4.3 events).
 *
 * Both arguments are passed through [JSONObject.quote], which yields a valid JS
 * string literal, so neither a request id nor any payload text can break out
 * of the call expression. The `&&` guard keeps a missing handler (e.g. the
 * page fell back to the web adapter) from throwing.
 */
object BridgeJs {
    const val BRIDGE_VERSION = 1

    fun callbackScript(requestId: String, payload: JSONObject): String =
        "window.__shadowAndroidCallback&&window.__shadowAndroidCallback(" +
            "${JSONObject.quote(requestId)},${JSONObject.quote(payload.toString())})"

    fun eventScript(name: String, payload: JSONObject): String =
        "window.__shadowAndroidEvent&&window.__shadowAndroidEvent(" +
            "${JSONObject.quote(name)},${JSONObject.quote(payload.toString())})"

    fun ok(): JSONObject = JSONObject().put("ok", true)

    fun error(code: String, message: String? = null): JSONObject {
        val err = JSONObject().put("code", code)
        if (message != null) err.put("message", message)
        return JSONObject().put("ok", false).put("error", err)
    }

    fun utterance(audio: EncodedAudio): JSONObject =
        ok().put("mime", audio.mime).put("data", audio.base64).put("durationMs", audio.durationMs)

    fun visibility(visible: Boolean): JSONObject = JSONObject().put("visible", visible)

    /** Event `geminiFailed` (T16.3): the shell could not start any Gemini target. No details. */
    const val GEMINI_FAILED = "geminiFailed"

    /**
     * `getInfo()` result; `reducedMotion` is omitted when unknown (the UI then asks the WebView).
     * `appVersionCode` (T16.2) is the installed versionCode, shown on the UI's version page.
     */
    fun info(appVersion: String, appVersionCode: Int, deviceClass: String, reducedMotion: Boolean?): String {
        val o = JSONObject()
            .put("bridgeVersion", BRIDGE_VERSION)
            .put("appVersion", appVersion)
            .put("appVersionCode", appVersionCode)
            .put("deviceClass", deviceClass)
        if (reducedMotion != null) o.put("reducedMotion", reducedMotion)
        return o.toString()
    }

    /** `phone` below 600 dp smallest width, `tablet` from there (docs/03 §1 device class). */
    fun deviceClass(smallestScreenWidthDp: Int): String = if (smallestScreenWidthDp >= 600) "tablet" else "phone"
}

/** One encoded utterance as returned by `stopCapture`. */
data class EncodedAudio(val mime: String, val base64: String, val durationMs: Long)
