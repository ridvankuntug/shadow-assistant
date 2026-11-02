package app.shadowassistant.android

import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler

/** Attributes of everything Shadow plays or speaks (assistant speech). */
fun speechAttributes(): AudioAttributes =
    AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ASSISTANT)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
        .build()

/**
 * One transient audio focus request shared by recording, playback and speech
 * (docs/03 §4.4). Separate requests from the same app would take focus from
 * each other; here it is held while at least one owner needs it. On a real
 * loss every owner's `onLoss` runs (playback/speech stop and answer `ok`).
 * Main thread only.
 */
class AudioFocus(private val audio: AudioManager, private val main: Handler) {
    private val owners = LinkedHashMap<String, () -> Unit>()
    private var held = false

    /**
     * Streamed replies arrive as one `playAudio` per sentence; abandoning focus
     * between two clips would let other media jump back in for a moment, so
     * focus is given back only after a short idle grace period.
     */
    private val abandon = Runnable {
        if (owners.isEmpty() && held) {
            audio.abandonAudioFocusRequest(request)
            held = false
        }
    }

    private val request: AudioFocusRequest =
        AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
            .setAudioAttributes(speechAttributes())
            .setOnAudioFocusChangeListener({ change -> onChange(change) }, main)
            .build()

    fun acquire(owner: String, onLoss: () -> Unit) {
        main.removeCallbacks(abandon)
        owners[owner] = onLoss
        if (!held) {
            // A refusal (e.g. during a phone call) is not fatal: we play anyway and the system mixes/ducks.
            held = audio.requestAudioFocus(request) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        }
    }

    fun release(owner: String) {
        owners.remove(owner)
        if (owners.isEmpty() && held) main.postDelayed(abandon, ABANDON_DELAY_MS)
    }

    /** Activity teardown: give focus back now. */
    fun releaseAll() {
        owners.clear()
        main.removeCallbacks(abandon)
        audio.abandonAudioFocusRequest(request) // harmless when not held; also unregisters the listener
        held = false
    }

    private fun onChange(change: Int) {
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS, AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                held = false
                // Copy: onLoss handlers release their ownership while we iterate.
                for (onLoss in owners.values.toList()) onLoss()
                // Leave the focus stack, or the system hands focus back to us after a
                // transient loss (call ended) and the interrupted music never resumes.
                if (owners.isEmpty()) audio.abandonAudioFocusRequest(request)
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                held = true
                if (owners.isEmpty()) main.postDelayed(abandon, ABANDON_DELAY_MS)
            }
            // LOSS_TRANSIENT_CAN_DUCK: the system lowers our volume itself.
        }
    }

    private companion object {
        const val ABANDON_DELAY_MS = 600L
    }
}
