package app.shadowassistant.android

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

class HelpersTest {
    // --- bridge JS ------------------------------------------------------------

    @Test
    fun callbackScriptQuotesIdAndPayload() {
        val js = BridgeJs.callbackScript("a\"1", BridgeJs.error(ErrorCode.BUSY, "it's </script>\n\"x\""))
        assertTrue(js.startsWith("window.__shadowAndroidCallback&&window.__shadowAndroidCallback(\"a\\\"1\","))
        assertFalse("payload must stay inside a string literal", js.contains("\n"))
        assertFalse(js.contains("</script>"))
        // The second argument is a JS string literal of the JSON text; decode it back.
        val literal = js.substringAfter("\"a\\\"1\",").removeSuffix(")")
        val json = JSONObject(org.json.JSONTokener(literal).nextValue() as String)
        assertFalse(json.getBoolean("ok"))
        assertEquals("busy", json.getJSONObject("error").getString("code"))
    }

    @Test
    fun eventScriptAndVisibility() {
        assertEquals(
            "window.__shadowAndroidEvent&&window.__shadowAndroidEvent(\"visibility\",\"{\\\"visible\\\":false}\")",
            BridgeJs.eventScript("visibility", BridgeJs.visibility(false)),
        )
    }

    @Test
    fun geminiFailedEventHasNoDetails() {
        assertEquals(
            "window.__shadowAndroidEvent&&window.__shadowAndroidEvent(\"geminiFailed\",\"{}\")",
            BridgeJs.eventScript(BridgeJs.GEMINI_FAILED, JSONObject()),
        )
    }

    @Test
    fun infoHasBridgeVersionOne() {
        val o = JSONObject(BridgeJs.info("0.1.57", 57, "phone", null))
        assertEquals(1, o.getInt("bridgeVersion"))
        assertEquals("0.1.57", o.getString("appVersion"))
        assertEquals(57, o.getInt("appVersionCode"))
        assertEquals("phone", o.getString("deviceClass"))
        assertFalse(o.has("reducedMotion"))
        assertTrue(JSONObject(BridgeJs.info("0.1.0", 1, "tablet", true)).getBoolean("reducedMotion"))
        assertEquals("phone", BridgeJs.deviceClass(411))
        assertEquals("tablet", BridgeJs.deviceClass(600))
    }

    @Test
    fun utterancePayload() {
        val p = BridgeJs.utterance(EncodedAudio("audio/wav", "AAEC", 1234))
        assertTrue(p.getBoolean("ok"))
        assertEquals("audio/wav", p.getString("mime"))
        assertEquals("AAEC", p.getString("data"))
        assertEquals(1234L, p.getLong("durationMs"))
        assertEquals(4, p.length())
    }

    // --- WAV --------------------------------------------------------------------

    private fun pcm(vararg samples: Int): ByteArray {
        val b = ByteBuffer.allocate(samples.size * 2).order(ByteOrder.LITTLE_ENDIAN)
        samples.forEach { b.putShort(it.toShort()) }
        return b.array()
    }

    @Test
    fun encodeWritesCanonicalHeaderAndParsesBack() {
        val data = pcm(0, 1000, -1000, 32767)
        val wav = Wav.encodePcm16(data, 16000, 1)
        assertEquals(44 + data.size, wav.size)
        assertEquals("RIFF", String(wav, 0, 4))
        assertEquals("WAVE", String(wav, 8, 4))
        val b = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN)
        assertEquals(36 + data.size, b.getInt(4))
        assertEquals(1, b.getShort(20).toInt())
        assertEquals(16000, b.getInt(24))
        assertEquals(32000, b.getInt(28))
        assertEquals(data.size, b.getInt(40))
        assertEquals(Wav.Pcm16(16000, 1, 44, data.size), Wav.parsePcm16(wav))
    }

    @Test
    fun parseSkipsExtraChunksWithPadding() {
        val base = Wav.encodePcm16(pcm(1, 2, 3), 22050, 1)
        // Insert an odd-sized LIST chunk (padded to even) between fmt and data.
        val list = byteArrayOf('L'.code.toByte(), 'I'.code.toByte(), 'S'.code.toByte(), 'T'.code.toByte(), 3, 0, 0, 0, 9, 9, 9, 0)
        val wav = base.copyOfRange(0, 36) + list + base.copyOfRange(36, base.size)
        val p = Wav.parsePcm16(wav)!!
        assertEquals(22050, p.sampleRate)
        assertEquals(44 + list.size, p.dataOffset)
        assertEquals(6, p.dataLength)
    }

    @Test
    fun streamedDataSizeRunsToEndOfFile() {
        val wav = Wav.encodePcm16(pcm(1, 2, 3, 4), 16000, 2)
        ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN).putInt(40, -1) // 0xFFFFFFFF
        assertEquals(8, Wav.parsePcm16(wav)!!.dataLength)
        assertEquals(2, Wav.parsePcm16(wav)!!.frameCount)
    }

    @Test
    fun nonPcmOrGarbageIsRejected() {
        val float = Wav.encodePcm16(pcm(1, 2), 16000, 1)
        ByteBuffer.wrap(float).order(ByteOrder.LITTLE_ENDIAN).putShort(20, 3) // IEEE float
        assertNull(Wav.parsePcm16(float))
        assertNull(Wav.parsePcm16(ByteArray(0)))
        assertNull(Wav.parsePcm16("ID3 not a wav file".toByteArray()))
        assertNull(Wav.parsePcm16(Wav.encodePcm16(ByteArray(0), 16000, 1)))
    }

    @Test
    fun rmsAndLevel() {
        assertEquals(0f, Wav.rms(ShortArray(4), 4), 0f)
        assertEquals(0.5f, Wav.rms(shortArrayOf(16384, -16384), 2), 1e-4f)
        assertEquals(0.5f, Wav.rmsPcm16(pcm(16384, -16384), 0, 4), 1e-4f)
        assertEquals(1f, Wav.levelFromRms(0.5f), 0f)
        assertEquals(0.2f, Wav.levelFromRms(0.05f), 1e-6f)
    }

    // --- TTS text ---------------------------------------------------------------

    @Test
    fun shortTextIsOnePiece() {
        assertEquals(listOf("Merhaba."), TtsText.split("  Merhaba. ", 100))
        assertTrue(TtsText.split("   ", 100).isEmpty())
    }

    @Test
    fun longTextSplitsAtSentencesWithinLimit() {
        val text = "Birinci cümle. İkinci cümle biraz daha uzun! Üçüncü mü? Evet."
        val parts = TtsText.split(text, 30)
        assertTrue(parts.all { it.length <= 30 })
        assertEquals(text, parts.joinToString(" "))
    }

    @Test
    fun overlongSentenceIsHardSplit() {
        val word = "kelime "
        val text = word.repeat(20).trim()
        val parts = TtsText.split(text, 25)
        assertTrue(parts.all { it.length <= 25 })
        assertEquals(text, parts.joinToString(" "))
        assertEquals(listOf("abcde", "fghij", "k"), TtsText.split("abcdefghijk", 5))
    }

    // --- vibration --------------------------------------------------------------

    @Test
    fun vibrationPatternGetsLeadingOffSegment() {
        assertArrayEquals(longArrayOf(0, 30, 60, 30), Vibration.toWaveform("[30,60,30]"))
        assertArrayEquals(longArrayOf(0, 5000), Vibration.toWaveform("[99999]"))
    }

    @Test
    fun invalidVibrationPatternsAreIgnored() {
        for (bad in listOf(null, "", "[]", "[-1]", "[\"30\"]", "{}", "[0,100]", "[30,", "[" + "1,".repeat(70) + "1]")) {
            assertNull(bad, Vibration.toWaveform(bad))
        }
    }
}
