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
        // The build generates the NSC from src/main/nsc/ (wake host from the build, docs/12 D2).
        val dir = System.getProperty("shadow.generatedNscDir")
        assertTrue("run through Gradle (generateNetworkSecurityConfig)", !dir.isNullOrEmpty())
        val xml = File(dir, "xml/network_security_config.xml")
        assertTrue("generated network security config missing: $xml", xml.isFile)
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(xml)
        val base = doc.getElementsByTagName("base-config").item(0)
        assertEquals("false", base.attributes.getNamedItem("cleartextTrafficPermitted").nodeValue)
        val configs = doc.getElementsByTagName("domain-config")
        assertEquals(1, configs.length)
        assertEquals("true", configs.item(0).attributes.getNamedItem("cleartextTrafficPermitted").nodeValue)
        val domains = doc.getElementsByTagName("domain")
        val hosts = (0 until domains.length).map { domains.item(it).textContent.trim() }
        val expected = listOfNotNull(CoreAddress.CLEARTEXT_HOST, WakeAddress.CLEARTEXT_HOST.takeIf { it.isNotEmpty() })
        assertEquals(expected, hosts)
        for (i in 0 until domains.length) {
            assertEquals("false", domains.item(i).attributes.getNamedItem("includeSubdomains").nodeValue)
        }
    }

    @Test
    fun networkSecurityConfigTemplateHasTheWakeMarkerOnce() {
        val text = File("src/main/nsc/network_security_config.xml").readText()
        assertEquals(2, text.split("<!-- WAKE_HOST -->").size)
        // The template itself holds only the Core's address; the wake host never enters the repository.
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(File("src/main/nsc/network_security_config.xml"))
        assertEquals(1, doc.getElementsByTagName("domain").length)
        assertFalse(File("src/main/res/xml/network_security_config.xml").exists())
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
