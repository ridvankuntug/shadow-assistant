package app.shadowassistant.android

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Handler
import android.util.Base64
import android.util.Log
import java.io.ByteArrayOutputStream
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * Records one utterance with [AudioRecord] as 16 kHz mono 16-bit PCM and
 * returns it as `audio/wav` (base64 NO_WRAP). WAV is accepted unchanged by the
 * Core `audio` message (any audio mime type) and by whisper-svc (PyAV/FFmpeg), needs
 * no encoder, and gives us the samples for an exact input level.
 *
 * 60 s (the UI's auto-stop) is ~1.9 MB WAV / ~2.6 MB base64, far below the
 * Core frame limit (36 MiB) and whisper-svc's upload limit (25 MB).
 */
class AudioRecordRecorder(
    private val main: Handler,
    private val focus: AudioFocus,
) : Recorder {
    private val io: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "shadow-mic") }

    @Volatile
    private var level = 0f

    /** Set by [shutdown] (activity teardown): no new microphone is opened after it. */
    @Volatile
    private var closed = false

    /** The open recording, if any (io thread only). */
    private var live: Session? = null

    override fun level(): Float = level

    // RECORD_AUDIO is checked by CaptureController before start() is called;
    // a revoked permission still surfaces as SecurityException below.
    @SuppressLint("MissingPermission")
    override fun start(done: (RecordingSession?, String?) -> Unit) {
        if (closed) return
        runOnIo {
            if (closed) return@runOnIo
            // At most one AudioRecord: a session still open here belongs to a start
            // that was cancelled while the microphone was opening (its discard is queued behind us).
            live?.shutDown()
            val minBuffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
            if (minBuffer <= 0) {
                main.post { done(null, ErrorCode.NOT_SUPPORTED) }
                return@runOnIo
            }
            val record = try {
                AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SAMPLE_RATE,
                    AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT,
                    maxOf(minBuffer, SAMPLE_RATE / 5 * 2), // ≥ 200 ms
                )
            } catch (_: SecurityException) {
                main.post { done(null, ErrorCode.PERMISSION_DENIED) }
                return@runOnIo
            } catch (e: Exception) {
                Log.w(TAG, "AudioRecord could not be created: ${e.javaClass.simpleName}")
                main.post { done(null, ErrorCode.BUSY) }
                return@runOnIo
            }
            val started = try {
                record.state == AudioRecord.STATE_INITIALIZED &&
                    record.also { it.startRecording() }.recordingState == AudioRecord.RECORDSTATE_RECORDING
            } catch (e: Exception) {
                Log.w(TAG, "startRecording failed: ${e.javaClass.simpleName}")
                false
            }
            if (!started) {
                record.release()
                // Another app holds the microphone (or it cannot be opened right now).
                main.post { done(null, ErrorCode.BUSY) }
                return@runOnIo
            }
            val session = Session(record)
            live = session
            session.reader.start()
            main.post {
                if (closed) {
                    session.discard() // torn down while opening: release, nobody to answer
                    return@post
                }
                focus.acquire(FOCUS_OWNER) { /* recording keeps going; the UI decides */ }
                done(session, null)
            }
        }
    }

    /** Runs [task] on [io]; after [shutdown] on a one-off thread so a microphone is always released. */
    private fun runOnIo(task: () -> Unit) {
        try {
            io.execute(task)
        } catch (_: RejectedExecutionException) {
            Thread(task, "shadow-mic-late").start()
        }
    }

    private inner class Session(private val record: AudioRecord) : RecordingSession {
        @Volatile
        private var running = true
        private val pcm = ByteArrayOutputStream(SAMPLE_RATE * 2 * 10)
        private var ended = false // main thread
        private var shut = false // io thread
        private var recorded = ByteArray(0)

        val reader = Thread({ readLoop() }, "shadow-mic-read")

        private fun readLoop() {
            val buf = ShortArray(SAMPLE_RATE / 25) // 40 ms
            val bytes = ByteArray(buf.size * 2)
            while (running) {
                val n = record.read(buf, 0, buf.size)
                if (n <= 0) {
                    if (n < 0) break // error: device gone, invalid state …
                    continue
                }
                level = Wav.levelFromRms(Wav.rms(buf, n))
                if (pcm.size() >= MAX_BYTES) continue // keep the level alive, drop audio past the cap
                for (i in 0 until n) {
                    bytes[2 * i] = (buf[i].toInt() and 0xFF).toByte()
                    bytes[2 * i + 1] = (buf[i].toInt() shr 8).toByte()
                }
                pcm.write(bytes, 0, n * 2)
            }
        }

        /** Runs on [io]; idempotent; returns the PCM recorded. */
        fun shutDown(): ByteArray {
            if (shut) return recorded
            shut = true
            if (live === this) live = null
            running = false
            try {
                record.stop()
            } catch (_: IllegalStateException) {
                // already stopped
            }
            reader.join(1_000)
            record.release()
            level = 0f
            recorded = pcm.toByteArray()
            return recorded
        }

        override fun stop(done: (EncodedAudio?) -> Unit) {
            if (!end()) return
            runOnIo {
                val raw = shutDown()
                val audio = if (raw.isEmpty()) {
                    null
                } else {
                    EncodedAudio(
                        mime = "audio/wav",
                        base64 = Base64.encodeToString(Wav.encodePcm16(raw, SAMPLE_RATE, 1), Base64.NO_WRAP),
                        durationMs = raw.size.toLong() * 1000 / (SAMPLE_RATE * 2),
                    )
                }
                main.post { done(audio) }
            }
        }

        override fun discard() {
            if (!end()) return
            runOnIo { shutDown() }
        }

        private fun end(): Boolean {
            if (ended) return false
            ended = true
            focus.release(FOCUS_OWNER)
            return true
        }
    }

    fun shutdown() {
        closed = true
        io.shutdown()
    }

    private companion object {
        const val TAG = "ShadowMic"
        const val SAMPLE_RATE = 16_000
        const val FOCUS_OWNER = "mic"

        /** 65 s of audio; the UI stops at 60 s. */
        const val MAX_BYTES = SAMPLE_RATE * 2 * 65
    }
}
