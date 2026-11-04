package app.shadowassistant.android

import app.shadowassistant.android.CaseBattery.Outcome
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

class CaseBatteryTest {
    private val now = 1_790_000_000_000L

    // --- provider row → reading ---------------------------------------------------

    @Test
    fun validRowBecomesAReading() {
        assertEquals(CaseBattery.Reading(64, now - 1000, "BT_EVENT"), CaseBattery.reading(64, now - 1000, "BT_EVENT", now))
        assertEquals(CaseBattery.Reading(0, now, null), CaseBattery.reading(0, now, null, now))
        assertEquals(CaseBattery.Reading(100, now, "TAP"), CaseBattery.reading(100, now, " TAP ", now))
    }

    @Test
    fun percentOutsideRangeOrMissingIsNotSent() {
        assertNull(CaseBattery.reading(-1, now, null, now))
        assertNull(CaseBattery.reading(101, now, null, now))
        assertNull(CaseBattery.reading(Int.MAX_VALUE.toLong() + 1, now, null, now))
        assertNull(CaseBattery.reading(null, now, null, now))
    }

    @Test
    fun readTimeMustBePlausible() {
        assertNull(CaseBattery.reading(50, null, null, now))
        assertNull(CaseBattery.reading(50, 0, null, now))
        assertNull(CaseBattery.reading(50, -5, null, now))
        // Up to 5 minutes ahead (clock steps) is fine, beyond is not.
        assertEquals(now + CaseBattery.MAX_FUTURE_SKEW_MS, CaseBattery.reading(50, now + CaseBattery.MAX_FUTURE_SKEW_MS, null, now)?.atEpochMs)
        assertNull(CaseBattery.reading(50, now + CaseBattery.MAX_FUTURE_SKEW_MS + 1, null, now))
        // At most 365 days old (the Core refuses older ones).
        assertEquals(now - CaseBattery.MAX_AGE_MS, CaseBattery.reading(50, now - CaseBattery.MAX_AGE_MS, null, now)?.atEpochMs)
        assertNull(CaseBattery.reading(50, now - CaseBattery.MAX_AGE_MS - 1, null, now))
    }

    @Test
    fun unusableSourceIsDroppedNotTheReading() {
        assertNull(CaseBattery.reading(50, now, "", now)!!.source)
        assertNull(CaseBattery.reading(50, now, "   ", now)!!.source)
        assertNull(CaseBattery.reading(50, now, "x".repeat(65), now)!!.source)
        assertEquals("x".repeat(64), CaseBattery.reading(50, now, "x".repeat(64), now)!!.source)
    }

    // --- JSON body -----------------------------------------------------------------

    @Test
    fun bodyMatchesTheCoreContract() {
        val json = JSONObject(CaseBattery.body(CaseBattery.Reading(35, 1_790_000_123_456L, "BT_EVENT")))
        assertEquals(setOf("caseBattery"), json.keys().asSequence().toSet())
        val cb = json.getJSONObject("caseBattery")
        assertEquals(setOf("percent", "atEpochMs", "source"), cb.keys().asSequence().toSet())
        assertEquals(35, cb.getInt("percent"))
        assertEquals(1_790_000_123_456L, cb.getLong("atEpochMs"))
        assertEquals("BT_EVENT", cb.getString("source"))
    }

    @Test
    fun bodyOmitsMissingSourceAndStaysSmall() {
        val cb = JSONObject(CaseBattery.body(CaseBattery.Reading(5, now, null))).getJSONObject("caseBattery")
        assertFalse(cb.has("source"))
        val big = CaseBattery.body(CaseBattery.Reading(100, Long.MAX_VALUE, "\"\\".repeat(32)))
        assertTrue(big.toByteArray(Charsets.UTF_8).size <= 4096)
        assertEquals("\"\\".repeat(32), JSONObject(big).getJSONObject("caseBattery").getString("source"))
    }

    // --- Core URL ------------------------------------------------------------------

    @Test
    fun deviceStateUrlFromTheStoredWebSocketUrl() {
        assertEquals("http://192.168.1.2:8700/device/state", CaseBattery.deviceStateUrl(CoreAddress.DEFAULT_URL))
        assertEquals("https://core.example:443/device/state", CaseBattery.deviceStateUrl("wss://core.example/ws"))
        assertEquals("https://core.example:9443/device/state", CaseBattery.deviceStateUrl("WSS://core.example:9443/ws?x=1"))
        assertEquals("https://[::1]:8700/device/state", CaseBattery.deviceStateUrl("wss://[::1]:8700/ws"))
    }

    @Test
    fun deviceStateUrlRefusesUnusableOrNonAllowlistedCleartext() {
        assertNull(CaseBattery.deviceStateUrl(null))
        assertNull(CaseBattery.deviceStateUrl(""))
        assertNull(CaseBattery.deviceStateUrl("http://192.168.1.2:8700/ws"))
        assertNull(CaseBattery.deviceStateUrl("not a url"))
        // Plain HTTP only to the network security config's host.
        assertNull(CaseBattery.deviceStateUrl("ws://192.0.2.10:8700/ws"))
        assertNull(CaseBattery.deviceStateUrl("ws://localhost:8700/ws"))
    }

    // --- HTTP status → decision ----------------------------------------------------

    @Test
    fun successCodes() {
        assertEquals(Outcome.SENT, CaseBattery.outcome(204, 0))
        assertEquals(Outcome.SENT, CaseBattery.outcome(200, 7))
    }

    @Test
    fun clientErrorsGiveUpAtOnce() {
        for (code in listOf(301, 302, 400, 401, 403, 404, 405, 408, 413, 415, 429)) {
            assertEquals("HTTP $code", Outcome.GIVE_UP, CaseBattery.outcome(code, 0))
        }
    }

    @Test
    fun transientErrorsRetryABoundedNumberOfTimes() {
        for (code in listOf(null, 500, 502, 503, 599)) {
            for (attempt in 0 until CaseBattery.MAX_RETRIES) {
                assertEquals("$code attempt $attempt", Outcome.RETRY, CaseBattery.outcome(code, attempt))
            }
            assertEquals("$code", Outcome.GIVE_UP, CaseBattery.outcome(code, CaseBattery.MAX_RETRIES))
        }
        assertEquals(5, CaseBattery.MAX_RETRIES)
    }

    @Test
    fun onlyVisibleAsciiTokensGoIntoTheHeader() {
        assertTrue(CaseBattery.headerSafeToken("abc-DEF_123.~+/="))
        assertFalse(CaseBattery.headerSafeToken(null))
        assertFalse(CaseBattery.headerSafeToken(""))
        assertFalse(CaseBattery.headerSafeToken("abc def"))
        assertFalse(CaseBattery.headerSafeToken("abc\r\nX-Evil: 1"))
        assertFalse(CaseBattery.headerSafeToken("abc\u200b"))
        assertFalse(CaseBattery.headerSafeToken("\u00e7\u011f"))
    }

    // --- startup permission --------------------------------------------------------

    @Test
    fun askedOnceAndOnlyWhenBudsCaseWidgetIsInstalled() {
        assertTrue(CaseBattery.shouldAsk(installed = true, granted = false, askedBefore = false))
        assertFalse(CaseBattery.shouldAsk(installed = false, granted = false, askedBefore = false))
        assertFalse(CaseBattery.shouldAsk(installed = true, granted = true, askedBefore = false))
        assertFalse(CaseBattery.shouldAsk(installed = true, granted = false, askedBefore = true))
    }

    @Test
    fun startupRequestAddsTheCasePermissionToTheSameDialogSequence() {
        assertEquals(
            listOf(LocalNetworkPermission.PERMISSION, "android.permission.POST_NOTIFICATIONS", CaseBattery.PERMISSION),
            LocalNetworkPermission.startupRequest(sdk = 37, localNetworkGranted = false, askNotifications = true, askCaseBattery = true),
        )
        assertEquals(
            listOf(CaseBattery.PERMISSION),
            LocalNetworkPermission.startupRequest(sdk = 29, localNetworkGranted = false, askNotifications = true, askCaseBattery = true),
        )
    }

    // --- manifest ------------------------------------------------------------------

    @Test
    fun manifestDeclaresPermissionVisibilityAndReceiver() {
        val xml = File("src/main/AndroidManifest.xml")
        assertTrue("run from the app module directory", xml.isFile)
        val doc = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }.newDocumentBuilder().parse(xml)
        val ns = "http://schemas.android.com/apk/res/android"
        fun names(tag: String) = (0 until doc.getElementsByTagName(tag).length)
            .map { (doc.getElementsByTagName(tag).item(it) as Element).getAttributeNS(ns, "name") }

        assertTrue(CaseBattery.PERMISSION in names("uses-permission"))
        assertTrue(CaseBattery.PACKAGE in names("package"))

        val receivers = doc.getElementsByTagName("receiver")
        val receiver = (0 until receivers.length).map { receivers.item(it) as Element }
            .single { it.getAttributeNS(ns, "name") == ".CaseBatteryReceiver" }
        assertEquals(CaseBatteryReceiver::class.java.name, "app.shadowassistant.android" + receiver.getAttributeNS(ns, "name"))
        assertEquals("true", receiver.getAttributeNS(ns, "exported"))
        val actions = receiver.getElementsByTagName("action")
        assertEquals(1, actions.length)
        assertEquals(CaseBattery.ACTION_CHANGED, (actions.item(0) as Element).getAttributeNS(ns, "name"))
    }
}
