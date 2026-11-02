package app.shadowassistant.android

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.sqrt

/**
 * Minimal WAV (RIFF, 16-bit PCM) helpers. The microphone utterance is sent as
 * 16 kHz mono PCM WAV (`audio/wav`, which whisper-svc decodes with PyAV), and
 * tts-svc clips (`audio/wav`) are played sample by sample so the output level
 * is known.
 */
object Wav {
    const val HEADER_BYTES = 44

    /** Wraps little-endian 16-bit PCM in a canonical 44-byte WAV header. */
    fun encodePcm16(pcm: ByteArray, sampleRate: Int, channels: Int): ByteArray {
        val out = ByteBuffer.allocate(HEADER_BYTES + pcm.size).order(ByteOrder.LITTLE_ENDIAN)
        out.put(ascii("RIFF"))
        out.putInt(36 + pcm.size)
        out.put(ascii("WAVE"))
        out.put(ascii("fmt "))
        out.putInt(16) // fmt chunk size
        out.putShort(1) // integer PCM
        out.putShort(channels.toShort())
        out.putInt(sampleRate)
        out.putInt(sampleRate * channels * 2) // byte rate
        out.putShort((channels * 2).toShort()) // block align
        out.putShort(16) // bits per sample
        out.put(ascii("data"))
        out.putInt(pcm.size)
        out.put(pcm)
        return out.array()
    }

    /** Where the PCM samples of a parsed WAV file are. */
    data class Pcm16(val sampleRate: Int, val channels: Int, val dataOffset: Int, val dataLength: Int) {
        val frameCount: Int get() = dataLength / (channels * 2)
    }

    /**
     * Parses a RIFF/WAVE file with 16-bit integer PCM (format 1, 1–2 channels).
     * Returns null for anything else so the caller can fall back to a generic
     * decoder. A data chunk whose declared size is 0 or larger than the file
     * (streamed WAV) is taken to run to the end of the file.
     */
    fun parsePcm16(bytes: ByteArray): Pcm16? {
        if (bytes.size < 12) return null
        val b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        if (tag(bytes, 0) != "RIFF" || tag(bytes, 8) != "WAVE") return null
        var pos = 12L
        var format = -1
        var channels = 0
        var sampleRate = 0
        var bits = 0
        while (pos + 8 <= bytes.size) {
            val at = pos.toInt()
            val id = tag(bytes, at)
            val size = b.getInt(at + 4).toLong() and 0xFFFFFFFFL
            val body = at + 8
            if (id == "fmt ") {
                if (size < 16 || body + 16 > bytes.size) return null
                format = b.getShort(body).toInt() and 0xFFFF
                channels = b.getShort(body + 2).toInt() and 0xFFFF
                sampleRate = b.getInt(body + 4)
                bits = b.getShort(body + 14).toInt() and 0xFFFF
            } else if (id == "data") {
                if (format != 1 || bits != 16 || channels !in 1..2 || sampleRate !in 4000..192000) return null
                val available = (bytes.size - body).toLong()
                var length = if (size == 0L || size > available) available else size
                length -= length % (channels * 2) // whole frames only
                if (length <= 0) return null
                return Pcm16(sampleRate, channels, body, length.toInt())
            }
            pos = body + size + (size and 1L) // chunks are word aligned
        }
        return null
    }

    /** RMS of little-endian 16-bit samples in `bytes[offset, offset+length)`, 0..1. */
    fun rmsPcm16(bytes: ByteArray, offset: Int, length: Int): Float {
        val n = length / 2
        if (n <= 0) return 0f
        var sum = 0.0
        var i = offset
        repeat(n) {
            val s = ((bytes[i].toInt() and 0xFF) or (bytes[i + 1].toInt() shl 8)).toShort() / 32768.0
            sum += s * s
            i += 2
        }
        return sqrt(sum / n).toFloat()
    }

    /** RMS of `samples[0, count)`, 0..1. */
    fun rms(samples: ShortArray, count: Int): Float {
        if (count <= 0) return 0f
        var sum = 0.0
        for (i in 0 until count) {
            val s = samples[i] / 32768.0
            sum += s * s
        }
        return sqrt(sum / count).toFloat()
    }

    /** Maps an RMS value to the 0..1 loudness the visuals expect (speech RMS is small). */
    fun levelFromRms(rms: Float): Float = (rms * 4f).coerceIn(0f, 1f)

    private fun ascii(s: String) = s.toByteArray(Charsets.US_ASCII)

    private fun tag(bytes: ByteArray, at: Int): String =
        if (at < 0 || at + 4 > bytes.size) "" else String(bytes, at, 4, Charsets.US_ASCII)
}
