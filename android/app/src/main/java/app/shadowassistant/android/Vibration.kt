package app.shadowassistant.android

import org.json.JSONArray
import org.json.JSONException

/** Parses the bridge `vibrate` argument (docs/03 §4.1). */
object Vibration {
    const val MAX_ENTRIES = 64
    const val MAX_SEGMENT_MS = 5_000L

    /**
     * `"[30,60,30]"` (on/off milliseconds, starting with "on") → Android waveform
     * timings, which start with an "off" segment, so a leading 0 is added.
     * Returns null for invalid input or a pattern without any "on" time.
     */
    fun toWaveform(patternJson: String?): LongArray? {
        if (patternJson == null) return null
        val arr = try {
            JSONArray(patternJson)
        } catch (_: JSONException) {
            return null
        }
        if (arr.length() == 0 || arr.length() > MAX_ENTRIES) return null
        val timings = LongArray(arr.length() + 1)
        for (i in 0 until arr.length()) {
            val v = arr.opt(i) as? Number ?: return null
            val d = v.toDouble()
            if (d.isNaN() || d < 0) return null
            timings[i + 1] = minOf(d.toLong(), MAX_SEGMENT_MS)
        }
        val anyOn = (1 until timings.size step 2).any { timings[it] > 0 }
        return if (anyOn) timings else null
    }
}
