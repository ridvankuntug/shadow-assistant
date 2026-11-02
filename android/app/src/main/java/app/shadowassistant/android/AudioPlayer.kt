package app.shadowassistant.android

import android.content.Context
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.MediaPlayer
import android.os.Handler
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.io.File

/**
 * `playAudio` / `stopAudio` / `getOutputLevel` (docs/03 §4.1).
 *
 * 16-bit PCM WAV (what tts-svc returns) is played with [AudioTrack] so the
 * output level can be computed from the samples being written. Anything else
 * goes through [MediaPlayer] from a temporary cache file (level stays 0).
 * The callback is answered exactly once: when the clip ends, when it is
 * stopped (`ok`), or with `playback_failed`. Main thread only, except
 * [level].
 */
class AudioPlayer(
    private val context: Context,
    private val main: Handler,
    private val focus: AudioFocus,
    private val reply: (String, JSONObject) -> Unit,
) {
    private abstract inner class Playback(val id: String) {
        @Volatile
        var stopped = false
        abstract fun halt()
    }

    private var current: Playback? = null

    @Volatile
    private var level = 0f

    fun level(): Float = level

    fun play(id: String, mime: String, base64: String) {
        stop() // a new clip ends the old one, answering it ok
        val bytes = try {
            Base64.decode(base64, Base64.DEFAULT)
        } catch (_: IllegalArgumentException) {
            reply(id, BridgeJs.error(ErrorCode.PLAYBACK_FAILED, "invalid base64"))
            return
        }
        val wav = Wav.parsePcm16(bytes)
        val playback = try {
            if (wav != null) PcmPlayback(id, bytes, wav) else MediaPlayback(id, bytes, mime)
        } catch (e: Exception) {
            Log.w(TAG, "playback could not start: ${e.javaClass.simpleName}")
            reply(id, BridgeJs.error(ErrorCode.PLAYBACK_FAILED, "clip could not be played"))
            return
        }
        current = playback
        focus.acquire(FOCUS_OWNER) { stop() }
    }

    fun stop() {
        val p = current ?: return
        p.stopped = true
        p.halt()
        finish(p, BridgeJs.ok())
    }

    fun release() = stop()

    private fun finish(p: Playback, result: JSONObject) {
        if (current !== p) return
        current = null
        level = 0f
        focus.release(FOCUS_OWNER)
        reply(p.id, result)
    }

    /** Streams PCM to an AudioTrack on its own thread and tracks the level. */
    private inner class PcmPlayback(id: String, private val bytes: ByteArray, private val wav: Wav.Pcm16) : Playback(id) {
        private val track: AudioTrack
        private val thread: Thread

        init {
            val channelMask = if (wav.channels == 2) AudioFormat.CHANNEL_OUT_STEREO else AudioFormat.CHANNEL_OUT_MONO
            val minBuffer = AudioTrack.getMinBufferSize(wav.sampleRate, channelMask, AudioFormat.ENCODING_PCM_16BIT)
            require(minBuffer > 0) { "unsupported format" }
            track = AudioTrack.Builder()
                .setAudioAttributes(speechAttributes())
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(wav.sampleRate)
                        .setChannelMask(channelMask)
                        .build(),
                )
                .setTransferMode(AudioTrack.MODE_STREAM)
                .setBufferSizeInBytes(minBuffer * 2)
                .build()
            thread = Thread({ run() }, "shadow-playback")
            try {
                track.play()
                thread.start()
            } catch (e: Exception) {
                track.release()
                throw e
            }
        }

        private fun run() {
            var ok = true
            try {
                val frameBytes = wav.channels * 2
                val chunk = (wav.sampleRate / 50) * frameBytes // 20 ms
                var pos = wav.dataOffset
                val end = wav.dataOffset + wav.dataLength
                while (!stopped && pos < end) {
                    val len = minOf(chunk, end - pos)
                    val l = Wav.levelFromRms(Wav.rmsPcm16(bytes, pos, len))
                    if (stopped) break // stop() already reset the level
                    level = l
                    val written = track.write(bytes, pos, len)
                    if (written < 0) {
                        ok = false
                        break
                    }
                    pos += written
                }
                // Wait until the buffered tail has actually been heard.
                val deadline = SystemClock.uptimeMillis() + 2_000
                while (ok && !stopped && track.playbackHeadPosition < wav.frameCount &&
                    SystemClock.uptimeMillis() < deadline
                ) {
                    if (!stopped) level *= 0.8f
                    Thread.sleep(20)
                }
            } catch (_: InterruptedException) {
                // stopped
            } catch (e: Exception) {
                Log.w(TAG, "PCM playback failed: ${e.javaClass.simpleName}")
                ok = false
            } finally {
                try {
                    track.stop()
                } catch (_: IllegalStateException) {
                }
                track.release()
            }
            val result = if (ok) BridgeJs.ok() else BridgeJs.error(ErrorCode.PLAYBACK_FAILED, "clip could not be played")
            main.post { finish(this, result) }
        }

        override fun halt() {
            try {
                track.pause()
                track.flush()
            } catch (_: IllegalStateException) {
            }
            thread.interrupt()
        }
    }

    /** Generic fallback for non-WAV clips (mp3/ogg/…): MediaPlayer from a temp file. */
    private inner class MediaPlayback(id: String, bytes: ByteArray, mime: String) : Playback(id) {
        private val file: File = File.createTempFile("clip", extensionFor(mime), context.cacheDir)
        private val player = MediaPlayer()
        private var released = false

        init {
            player.setAudioAttributes(speechAttributes())
            player.setOnPreparedListener { if (!stopped) it.start() }
            player.setOnCompletionListener { done(BridgeJs.ok()) }
            player.setOnErrorListener { _, _, _ ->
                done(BridgeJs.error(ErrorCode.PLAYBACK_FAILED, "clip could not be decoded"))
                true
            }
            try {
                file.writeBytes(bytes)
                player.setDataSource(file.path)
                player.prepareAsync()
            } catch (e: Exception) {
                cleanup()
                throw e
            }
        }

        private fun done(result: JSONObject) {
            cleanup()
            finish(this, result)
        }

        override fun halt() = cleanup()

        private fun cleanup() {
            if (released) return
            released = true
            player.release()
            file.delete()
        }
    }

    private companion object {
        const val TAG = "ShadowPlayback"
        const val FOCUS_OWNER = "playback"

        fun extensionFor(mime: String): String = when (mime.substringBefore(';').trim().lowercase()) {
            "audio/mpeg" -> ".mp3"
            "audio/wav", "audio/x-wav", "audio/wave" -> ".wav"
            "audio/ogg" -> ".ogg"
            "audio/mp4", "audio/aac" -> ".m4a"
            "audio/webm" -> ".webm"
            else -> ".bin"
        }
    }
}
