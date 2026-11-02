package app.shadowassistant.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

class AddressAndOriginTest {
    @Test
    fun defaultUrlIsTheHomeCore() {
        assertEquals("ws://192.168.1.2:8700/ws", CoreAddress.DEFAULT_URL)
        val e = CoreAddress.parse(CoreAddress.DEFAULT_URL)!!
        assertEquals(CoreAddress.Endpoint(false, "192.168.1.2", 8700), e)
        assertTrue(CoreAddress.cleartextAllowed(e))
    }

    @Test
    fun parsesSchemesAndDefaultPorts() {
        assertEquals(CoreAddress.Endpoint(true, "core.example", 443), CoreAddress.parse("wss://core.example/ws"))
        assertEquals(CoreAddress.Endpoint(false, "localhost", 80), CoreAddress.parse("WS://localhost/ws"))
        assertEquals(CoreAddress.Endpoint(false, "::1", 8700), CoreAddress.parse("ws://[::1]:8700/ws"))
        assertNull(CoreAddress.parse("http://192.168.1.2:8700/ws"))
        assertNull(CoreAddress.parse("ws:///ws"))
        assertNull(CoreAddress.parse("not a url"))
        assertNull(CoreAddress.parse(""))
        assertNull(CoreAddress.parse(null))
    }

    @Test
    fun cleartextOnlyToHomeAddress() {
        assertFalse(CoreAddress.cleartextAllowed(CoreAddress.parse("ws://192.0.2.10:8700/ws")!!))
        assertFalse(CoreAddress.cleartextAllowed(CoreAddress.parse("ws://localhost:8700/ws")!!))
        assertTrue(CoreAddress.cleartextAllowed(CoreAddress.parse("wss://anything.example/ws")!!))
    }

    @Test
    fun networkSecurityConfigMatchesTheAllowlist() {
        val xml = File("src/main/res/xml/network_security_config.xml")
        assertTrue("run from the app module directory", xml.isFile)
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(xml)
        val base = doc.getElementsByTagName("base-config").item(0)
        assertEquals("false", base.attributes.getNamedItem("cleartextTrafficPermitted").nodeValue)
        val configs = doc.getElementsByTagName("domain-config")
        assertEquals(1, configs.length)
        assertEquals("true", configs.item(0).attributes.getNamedItem("cleartextTrafficPermitted").nodeValue)
        val domains = doc.getElementsByTagName("domain")
        assertEquals(1, domains.length)
        assertEquals(CoreAddress.CLEARTEXT_HOST, domains.item(0).textContent.trim())
        assertEquals("false", domains.item(0).attributes.getNamedItem("includeSubdomains").nodeValue)
    }

    @Test
    fun cspLimitsScriptsFramesAndPlainWebSockets() {
        val directives = UiOrigin.CONTENT_SECURITY_POLICY.split(';').map { it.trim() }
            .associate { d -> d.substringBefore(' ') to d.substringAfter(' ').split(' ').toSet() }
        assertEquals(setOf("'none'"), directives["default-src"])
        assertEquals(setOf("'self'"), directives["script-src"]) // no inline, no eval
        assertEquals(setOf("'none'"), directives["frame-src"])
        assertEquals(setOf("'none'"), directives["object-src"])
        assertEquals(setOf("'self'", "ws://${CoreAddress.CLEARTEXT_HOST}:*", "wss:"), directives["connect-src"])
    }

    @Test
    fun onlyTheBundledOriginIsTrusted() {
        assertTrue(UiOrigin.isTrustedUrl(UiOrigin.START_URL))
        assertTrue(UiOrigin.isTrusted("https", "appassets.androidplatform.net"))
        assertFalse(UiOrigin.isTrusted("http", "appassets.androidplatform.net"))
        assertFalse(UiOrigin.isTrustedUrl("https://appassets.androidplatform.net.evil.example/x"))
        assertFalse(UiOrigin.isTrustedUrl("https://evil.example/?u=https://appassets.androidplatform.net/"))
        assertFalse(UiOrigin.isTrustedUrl("file:///android_asset/ui/index.html"))
        assertFalse(UiOrigin.isTrustedUrl("about:blank"))
        assertFalse(UiOrigin.isTrustedUrl(null))
    }
}
