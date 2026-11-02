package app.shadowassistant.android

import android.content.Context
import android.os.Handler
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.util.Log
import org.json.JSONObject
import java.util.Locale

/**
 * `speak` / `stopSpeaking` with the system [TextToSpeech] in Turkish
 * (docs/03 §4.1). Since the "one voice" decision the UI uses Core audio
 * (`playAudio`) and calls this only as a fallback.
 *
 * Each request is answered exactly once: `ok` when the text has been spoken
 * or was stopped (`stopSpeaking`, a newer `speak`, audio focus loss, onPause);
 * `not_supported` when no Turkish voice is available; `playback_failed` on an
 * engine error. Main thread only, except [level].
 */
class Speaker(
    private val context: Context,
    private val main: Handler,
    private val focus: AudioFocus,
    private val reply: (String, JSONObject) -> Unit,
) {
    private enum class Engine { NONE, INITIALIZING, READY }

    private class Utterance(val id: String, val tag: String, val parts: Int)

    private var tts: TextToSpeech? = null
    private var engine = Engine.NONE
    private var waiting: Pair<String, String>? = null // (id, text) queued until the engine is ready
    private var current: Utterance? = null
    private var seq = 0

    @Volatile
    private var speaking = false

    @Volatile
    private var lastWordAt = 0L

    /** Synthetic loudness: a pulse on each word boundary (TTS gives us no samples). */
    fun level(): Float {
        if (!speaking) return 0f
        val since = SystemClock.uptimeMillis() - lastWordAt
        return 0.15f + 0.5f * (1f - since / 250f).coerceIn(0f, 1f)
    }

    fun speak(id: String, text: String) {
        stop()
        if (text.isBlank()) {
            reply(id, BridgeJs.ok())
            return
        }
        when (engine) {
            Engine.READY -> start(id, text)
            Engine.NONE, Engine.INITIALIZING -> {
                waiting = id to text
                initEngine()
            }
        }
    }

    fun stop() {
        waiting?.let { (id, _) ->
            waiting = null
            reply(id, BridgeJs.ok())
        }
        val u = current ?: return
        tts?.stop()
        finish(u, BridgeJs.ok())
    }

    fun shutdown() {
        stop()
        tts?.shutdown()
        tts = null
        engine = Engine.NONE
    }

    private fun initEngine() {
        if (engine == Engine.INITIALIZING) return
        engine = Engine.INITIALIZING
        var created: TextToSpeech? = null
        created = TextToSpeech(context.applicationContext) { status ->
            main.post { onEngineReady(created, status) }
        }
        tts = created
    }

    private fun onEngineReady(instance: TextToSpeech?, status: Int) {
        if (instance == null || instance !== tts) return // shut down meanwhile
        val languageOk = status == TextToSpeech.SUCCESS &&
            instance.setLanguage(Locale.forLanguageTag("tr-TR")) >= TextToSpeech.LANG_AVAILABLE
        if (languageOk) {
            instance.setAudioAttributes(speechAttributes())
            instance.setOnUtteranceProgressListener(listener)
            engine = Engine.READY
        } else {
            // Not permanent: the next speak() tries again (the user may install a Turkish voice meanwhile).
            Log.w(TAG, "TextToSpeech unavailable or no Turkish voice (status=$status)")
            instance.shutdown()
            tts = null
            engine = Engine.NONE
            waiting?.let { (id, _) ->
                waiting = null
                reply(id, BridgeJs.error(ErrorCode.NOT_SUPPORTED, "no Turkish text-to-speech voice"))
            }
            return
        }
        val w = waiting ?: return
        waiting = null
        speak(w.first, w.second)
    }

    private fun start(id: String, text: String) {
        val t = tts ?: return reply(id, BridgeJs.error(ErrorCode.NOT_SUPPORTED))
        val parts = TtsText.split(text, TextToSpeech.getMaxSpeechInputLength())
        val tag = "u${++seq}"
        val u = Utterance(id, tag, parts.size)
        current = u
        speaking = true
        lastWordAt = SystemClock.uptimeMillis()
        focus.acquire(FOCUS_OWNER) { stop() }
        parts.forEachIndexed { i, part ->
            val mode = if (i == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
            if (t.speak(part, mode, null, "$tag:$i") != TextToSpeech.SUCCESS) {
                t.stop()
                finish(u, BridgeJs.error(ErrorCode.PLAYBACK_FAILED, "text-to-speech refused the text"))
                return
            }
        }
    }

    private fun finish(u: Utterance, result: JSONObject) {
        if (current !== u) return
        current = null
        speaking = false
        focus.release(FOCUS_OWNER)
        reply(u.id, result)
    }

    /** Finds the utterance an engine callback belongs to, or null for a stale one. */
    private fun match(utteranceId: String?): Pair<Utterance, Int>? {
        val u = current ?: return null
        val tag = utteranceId?.substringBefore(':') ?: return null
        val index = utteranceId.substringAfter(':').toIntOrNull() ?: return null
        return if (tag == u.tag) u to index else null
    }

    private val listener = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {
            lastWordAt = SystemClock.uptimeMillis()
        }

        override fun onRangeStart(utteranceId: String?, start: Int, end: Int, frame: Int) {
            lastWordAt = SystemClock.uptimeMillis()
        }

        override fun onDone(utteranceId: String?) {
            main.post {
                val (u, index) = match(utteranceId) ?: return@post
                if (index == u.parts - 1) finish(u, BridgeJs.ok())
            }
        }

        override fun onStop(utteranceId: String?, interrupted: Boolean) {
            main.post { match(utteranceId)?.let { (u, _) -> finish(u, BridgeJs.ok()) } }
        }

        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) {
            onError(utteranceId, TextToSpeech.ERROR)
        }

        override fun onError(utteranceId: String?, errorCode: Int) {
            main.post {
                match(utteranceId)?.let { (u, _) ->
                    finish(u, BridgeJs.error(ErrorCode.PLAYBACK_FAILED, "text-to-speech error $errorCode"))
                }
            }
        }
    }

    private companion object {
        const val TAG = "ShadowTts"
        const val FOCUS_OWNER = "tts"
    }
}
