package app.shadowassistant.android

import android.os.Handler
import android.webkit.JavascriptInterface

/**
 * `window.ShadowAndroid` (docs/03-platform-adapter.md §4, bridgeVersion 1).
 *
 * Methods run on the WebView's JavaBridge thread. Anything stateful is posted
 * to the main thread (where all audio state machines live); only field reads
 * and storage answer directly. Arguments are nullable because JavaScript can
 * pass `null`/`undefined`; bad input is ignored quietly as the contract asks.
 *
 * [trusted] is false whenever the main frame is not the bundled UI: then every
 * method does nothing (getInfo returns `{}`, so the page would not even accept
 * the bridge). Navigation away from the bundle is blocked anyway; this is the
 * second line of defence.
 */
class ShadowBridge(
    private val main: Handler,
    private val trusted: () -> Boolean,
    private val info: String,
    private val capture: CaptureController,
    private val player: AudioPlayer,
    private val speaker: Speaker,
    private val storage: BridgeStorage,
    private val vibrate: (LongArray) -> Unit,
    private val notify: (String, String) -> Unit,
    private val notifyItem: (String, String, String, Boolean) -> Unit,
    private val onStorageChanged: (String) -> Unit,
    private val geminiAvailable: () -> Boolean,
    private val launchGemini: () -> Unit,
) {
    @JavascriptInterface
    fun getInfo(): String = if (trusted()) info else "{}"

    @JavascriptInterface
    fun startCapture(requestId: String?) = onMain(requestId) { capture.startCapture(it) }

    @JavascriptInterface
    fun stopCapture(requestId: String?) = onMain(requestId) { capture.stopCapture(it) }

    @JavascriptInterface
    fun cancelCapture() {
        if (trusted()) main.post { capture.cancelCapture() }
    }

    @JavascriptInterface
    fun getInputLevel(): Float = if (trusted()) capture.level() else 0f

    @JavascriptInterface
    fun playAudio(requestId: String?, mime: String?, base64: String?) = onMain(requestId) {
        player.play(it, mime.orEmpty(), base64.orEmpty())
    }

    @JavascriptInterface
    fun stopAudio() {
        if (trusted()) main.post { player.stop() }
    }

    @JavascriptInterface
    fun getOutputLevel(): Float = if (trusted()) maxOf(player.level(), speaker.level()) else 0f

    @JavascriptInterface
    fun speak(requestId: String?, text: String?) = onMain(requestId) { speaker.speak(it, text.orEmpty()) }

    @JavascriptInterface
    fun stopSpeaking() {
        if (trusted()) main.post { speaker.stop() }
    }

    @JavascriptInterface
    fun vibrate(patternJson: String?) {
        if (!trusted()) return
        Vibration.toWaveform(patternJson)?.let { timings -> main.post { vibrate(timings) } }
    }

    @JavascriptInterface
    fun notify(title: String?, body: String?) {
        if (!trusted()) return
        val t = title.orEmpty().take(MAX_TITLE)
        val b = body.orEmpty().take(MAX_BODY)
        if (t.isNotBlank() || b.isNotBlank()) main.post { notify(t, b) }
    }

    /**
     * An inbox item as its own system notification (T7.w.5d; optional for the
     * page, which falls back to [notify] on older shells). A bad id is ignored.
     */
    @JavascriptInterface
    fun notifyItem(id: String?, title: String?, body: String?, urgent: Boolean) {
        if (!trusted()) return
        val itemId = Notifier.validItemId(id) ?: return
        val t = title.orEmpty().take(MAX_TITLE)
        val b = body.orEmpty().take(MAX_BODY)
        if (t.isNotBlank() || b.isNotBlank()) main.post { notifyItem(itemId, t, b, urgent) }
    }

    /**
     * Gemini hand-off (T15; optional for the page). Only a fixed target the shell
     * picks ([GeminiLauncher]); the page passes nothing, so it cannot start an
     * arbitrary intent.
     */
    @JavascriptInterface
    fun canOpenGemini(): Boolean = trusted() && geminiAvailable()

    @JavascriptInterface
    fun openGemini() {
        if (trusted()) main.post { launchGemini() }
    }

    @JavascriptInterface
    fun getItem(key: String?): String? = if (trusted() && key != null) storage.get(key) else null

    @JavascriptInterface
    fun setItem(key: String?, value: String?) {
        if (!trusted() || key == null || value == null) return
        storage.set(key, value)
        main.post { onStorageChanged(key) }
    }

    @JavascriptInterface
    fun removeItem(key: String?) {
        if (!trusted() || key == null) return
        storage.remove(key)
        main.post { onStorageChanged(key) }
    }

    private inline fun onMain(requestId: String?, crossinline action: (String) -> Unit) {
        if (!trusted() || requestId == null) return
        main.post { action(requestId) }
    }

    private companion object {
        const val MAX_TITLE = 120
        const val MAX_BODY = 1_000
    }
}
