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
    fun theBuildsCoreHostIsAPlainHostOrNothing() {
        // No built-in address (T21.3.3); a development build may name one cleartext host.
        val host = CoreAddress.CLEARTEXT_HOST
        assertTrue(host, host.isEmpty() || Regex("""^[A-Za-z0-9.-]+$""").matches(host))
    }

    @Test
    fun parsesSchemesAndDefaultPorts() {
        assertEquals(CoreAddress.Endpoint(true, "core.example", 443), CoreAddress.parse("wss://core.example/ws"))
        assertEquals(CoreAddress.Endpoint(false, "localhost", 80), CoreAddress.parse("WS://localhost/ws"))
        assertEquals(CoreAddress.Endpoint(false, "::1", 8700), CoreAddress.parse("ws://[::1]:8700/ws"))
        assertNull(CoreAddress.parse("http://192.0.2.10:8700/ws"))
        assertNull(CoreAddress.parse("ws:///ws"))
        assertNull(CoreAddress.parse("not a url"))
        assertNull(CoreAddress.parse(""))
        assertNull(CoreAddress.parse(null))
    }

    @Test
    fun withoutADevHostEveryPlainWebSocketIsRefused() {
        assertFalse(CoreAddress.cleartextAllowed(CoreAddress.parse("ws://192.0.2.10:8700/ws")!!, ""))
        assertFalse(CoreAddress.cleartextAllowed(CoreAddress.parse("ws://localhost:8700/ws")!!, ""))
        assertTrue(CoreAddress.cleartextAllowed(CoreAddress.parse("wss://box.example.ts.net/ws")!!, ""))
    }

    @Test
    fun aDevHostAllowsPlainWebSocketsToThatHostOnly() {
        val dev = "192.0.2.10"
        assertTrue(CoreAddress.cleartextAllowed(CoreAddress.parse("ws://192.0.2.10:8700/ws")!!, dev))
        assertTrue(CoreAddress.cleartextAllowed(CoreAddress.parse("ws://Dev.Example:8700/ws")!!, "dev.example"))
        assertFalse(CoreAddress.cleartextAllowed(CoreAddress.parse("ws://192.0.2.11:8700/ws")!!, dev))
        assertFalse(CoreAddress.cleartextAllowed(CoreAddress.parse("ws://192.0.2.10.example:8700/ws")!!, dev))
        assertTrue(CoreAddress.cleartextAllowed(CoreAddress.parse("wss://box.example.ts.net/ws")!!, dev))
    }

    @Test
    fun privateIpv4LiteralsOnly() {
        // The 192.168/16 literals are built from a prefix: the repository holds no LAN address (docs/12).
        val p192 = "192.168"
        for (ok in listOf(
            "10.0.0.1", "10.255.255.255", "10.0.0.0", "172.16.0.1", "172.31.255.255", "$p192.0.1", "$p192.255.254",
        )) {
            assertTrue(ok, CoreAddress.isPrivateIpv4Literal(ok))
        }
        for (bad in listOf(
            // Outside the ranges (incl. the neighbours of 172.16/12 and 192.168/16, CGNAT, loopback).
            "11.0.0.1", "9.255.255.255", "172.15.0.1", "172.32.0.1", "192.167.0.1", "192.169.0.1", "100.64.0.1",
            "127.0.0.1", "0.0.0.0", "255.255.255.255", "192.0.2.10", "8.8.8.8",
            // Not a plain dotted quad.
            "10.1", "10.0.1", "10.0.0.1.5", "010.0.0.1", "10.00.0.1", "10.0.0.01", "0x0a.0.0.1", "10.0.0.256",
            "10.0.0.1000", "10.0.0.-1", "10.0.0.1.", ".10.0.0.1", "10..0.1", " 10.0.0.1", "10.0.0.1 ", "1e1.0.0.1",
            "\uFF11\uFF10.0.0.1", "",
            // Hostnames that look like one, IPv6 forms.
            "10.0.0.1.evil.example", "evil.example.10.0.0.1x", "localhost", "::1", "[::ffff:10.0.0.1]", "::ffff:10.0.0.1",
            "fd00::1",
        )) {
            assertFalse(bad, CoreAddress.isPrivateIpv4Literal(bad))
        }
    }

    @Test
    fun plainWebSocketsOnlyToPrivateIpv4() {
        fun allowed(url: String) = CoreAddress.parse(url)?.let { CoreAddress.cleartextAllowed(it, "") } ?: false
        assertTrue(allowed("ws://10.0.0.2:8700/ws"))
        assertTrue(allowed("WS://172.20.1.2:8700/ws"))
        assertTrue(allowed("ws://10.0.0.2/ws"))
        for (bad in listOf(
            "ws://172.15.0.2:8700/ws", "ws://172.32.0.2:8700/ws", "ws://11.0.0.2:8700/ws", "ws://198.51.100.7:8700/ws",
            "ws://10.0.0.1.evil.example:8700/ws", "ws://box.example.test:8700/ws", "ws://localhost:8700/ws",
            // User info: the host is evil.example (refused), and even a private host with user info is refused.
            "ws://10.0.0.2@evil.example:8700/ws", "ws://user:pw@10.0.0.2:8700/ws", "ws://10.0.0.2:8700@evil.example/ws",
            "ws://[::1]:8700/ws", "ws://[::ffff:10.0.0.2]:8700/ws", "ws://[fd00::1]:8700/ws",
            "ws://010.0.0.2:8700/ws", "ws://10.2:8700/ws", "ws://0x0a.0.0.2:8700/ws", "ws://10.0.0.2.:8700/ws",
        )) {
            assertFalse(bad, allowed(bad))
        }
        // Unparsable tricks never reach the gate as allowed.
        assertFalse(CoreAddress.usable("ws://10.0.0.2\\@evil.example/ws", ""))
        assertFalse(CoreAddress.usable("ws://10.0.0.2%2eevil.example/ws", ""))
        assertTrue(CoreAddress.usable("wss://box.example.ts.net/ws", ""))
    }

    @Test
    fun unusableMeansAPlainAddressThisBuildRefuses() {
        // A plain ws:// to a non-private address is unusable without a dev host; a private one is fine.
        assertTrue(CoreAddress.unusable("ws://192.0.2.10:8700/ws", ""))
        assertTrue(CoreAddress.unusable("ws://box.example.test:8700/ws", ""))
        assertFalse(CoreAddress.unusable("ws://10.0.0.2:8700/ws", ""))
        assertFalse(CoreAddress.unusable("ws://192.0.2.10:8700/ws", "192.0.2.10"))
        assertFalse(CoreAddress.unusable("wss://box.example.ts.net/ws", ""))
        // Missing or unparsable values are left to the UI's connect screen.
        assertFalse(CoreAddress.unusable(null, ""))
        assertFalse(CoreAddress.unusable("", ""))
        assertFalse(CoreAddress.unusable("not a url", ""))
    }

    @Test
    fun networkSecurityConfigMatchesTheAllowlist() {
        // The build generates the NSC from src/main/nsc/ (wake host from the build, docs/12 D2).
        val dir = System.getProperty("shadow.generatedNscDir")
        assertTrue("run through Gradle (generateNetworkSecurityConfig<BuildType>)", !dir.isNullOrEmpty())
        val xml = File(dir, "xml/network_security_config.xml")
        assertTrue("generated network security config missing: $xml", xml.isFile)
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(xml)
        val base = doc.getElementsByTagName("base-config").item(0)
        // T21.3.3: LAN addresses are not known at build time and NSC has no ranges, so cleartext is
        // open here and the gate is CoreAddress / WakeAddress / the page CSP (tested below).
        assertEquals("true", base.attributes.getNamedItem("cleartextTrafficPermitted").nodeValue)
        val configs = doc.getElementsByTagName("domain-config")
        for (i in 0 until configs.length) {
            assertEquals("true", configs.item(i).attributes.getNamedItem("cleartextTrafficPermitted").nodeValue)
        }
        val domains = doc.getElementsByTagName("domain")
        val hosts = (0 until domains.length).map { domains.item(it).textContent.trim() }
        val expected = listOf(CoreAddress.CLEARTEXT_HOST, WakeAddress.CLEARTEXT_HOST)
            .filter { it.isNotEmpty() }.distinctBy { it.lowercase() }
        assertEquals(expected, hosts)
        // No development host (every CI/release build): no cleartext domain-config at all.
        assertEquals(if (expected.isEmpty()) 0 else 1, configs.length)
        for (i in 0 until domains.length) {
            assertEquals("false", domains.item(i).attributes.getNamedItem("includeSubdomains").nodeValue)
        }
    }

    @Test
    fun networkSecurityConfigTemplateHasTheMarkerOnceAndNoAddress() {
        val text = File("src/main/nsc/network_security_config.xml").readText()
        assertEquals(2, text.split("<!-- CLEARTEXT_HOSTS -->").size)
        // The template holds no address at all; development hosts come from the build only.
        val doc = DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(File("src/main/nsc/network_security_config.xml"))
        assertEquals(0, doc.getElementsByTagName("domain").length)
        assertEquals(0, doc.getElementsByTagName("domain-config").length)
        assertFalse(File("src/main/res/xml/network_security_config.xml").exists())
    }

    private fun cspDirectives(csp: String) = csp.split(';').map { it.trim() }
        .associate { d -> d.substringBefore(' ') to d.substringAfter(' ').split(' ').toSet() }

    @Test
    fun cspLimitsScriptsFramesAndPlainWebSockets() {
        val directives = cspDirectives(UiOrigin.CONTENT_SECURITY_POLICY)
        assertEquals(setOf("'none'"), directives["default-src"])
        assertEquals(setOf("'self'"), directives["script-src"]) // no inline, no eval
        assertEquals(setOf("'none'"), directives["frame-src"])
        assertEquals(setOf("'none'"), directives["object-src"])
        assertEquals(cspDirectives(UiOrigin.contentSecurityPolicy(CoreAddress.CLEARTEXT_HOST)), directives)
    }

    @Test
    fun cspAllowsPlainWebSocketsOnlyToTheDevHost() {
        assertEquals(setOf("'self'", "wss:"), cspDirectives(UiOrigin.contentSecurityPolicy(""))["connect-src"])
        assertEquals(
            setOf("'self'", "ws://192.0.2.10:*", "wss:"),
            cspDirectives(UiOrigin.contentSecurityPolicy("192.0.2.10"))["connect-src"],
        )
    }

    @Test
    fun pagePolicyAddsOnlyTheConfiguredPrivateAddressesAndMixedContentOnlyThen() {
        val tls = UiOrigin.pagePolicy(listOf(null, "wss://box.example.ts.net/ws"), "")
        assertFalse(tls.mixedContent)
        assertEquals(setOf("'self'", "wss:"), cspDirectives(tls.csp)["connect-src"])
        assertEquals(UiOrigin.contentSecurityPolicy(""), tls.csp)

        val home = UiOrigin.pagePolicy(listOf("ws://10.0.0.2:8700/ws", "wss://box.example.ts.net/ws"), "")
        assertTrue(home.mixedContent)
        assertEquals(setOf("'self'", "ws://10.0.0.2:8700", "wss:"), cspDirectives(home.csp)["connect-src"])
        // Default port spelled out; duplicates collapse.
        assertEquals(
            setOf("'self'", "ws://10.0.0.2:80", "wss:"),
            cspDirectives(UiOrigin.pagePolicy(listOf("ws://10.0.0.2/ws", "ws://10.0.0.2:80/ws"), "").csp)["connect-src"],
        )
        // Refused addresses never become a source, and then mixed content stays off.
        for (bad in listOf("ws://box.example.test:8700/ws", "ws://198.51.100.7:8700/ws", "ws://10.0.0.2@evil.example/ws", "not a url")) {
            val p = UiOrigin.pagePolicy(listOf(bad, null), "")
            assertFalse(bad, p.mixedContent)
            assertEquals(bad, setOf("'self'", "wss:"), cspDirectives(p.csp)["connect-src"])
        }
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
