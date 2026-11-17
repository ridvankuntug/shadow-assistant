package app.shadowassistant.android

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.IOException

class CoreProbeTest {
    private class FakeHttp(private val answer: () -> HttpAnswer) : WakeHttp {
        val asked = mutableListOf<String>()
        override fun postWake(wakeUrl: String, token: String): HttpAnswer = throw AssertionError("not used")
        override fun getHealth(healthUrl: String): HttpAnswer {
            asked += healthUrl
            return answer()
        }
    }

    private val box = "wss://box.example.ts.net/ws"
    private val lan = "ws://10.0.0.2:8700/ws"
    private val lanEndpoint = CoreAddress.Endpoint(false, "10.0.0.2", 8700)
    private val coreUp = { HttpAnswer(200, """{"status":"ok","service":"core","version":"0.1.0"}""") }
    private val down: () -> HttpAnswer = { throw IOException("timeout") }
    private val boxEndpoint = CoreAddress.Endpoint(true, "box.example.ts.net", 443)

    @Test
    fun nothingToProbeWithoutAUsableAddress() {
        assertEquals(CoreProbe.Precheck.Done(CoreStatus.Fine), CoreProbe.precheck(null, ""))
        assertEquals(CoreProbe.Precheck.Done(CoreStatus.Fine), CoreProbe.precheck("not a url", ""))
    }

    @Test
    fun plainAddressWithoutDevHostIsBlockedBeforeAnyRequest() {
        assertEquals(
            CoreProbe.Precheck.Done(CoreStatus.CleartextBlocked(CoreAddress.Endpoint(false, "192.0.2.10", 8700))),
            CoreProbe.precheck("ws://192.0.2.10:8700/ws", ""),
        )
        assertEquals(
            CoreProbe.Precheck.Ask(CoreAddress.Endpoint(false, "192.0.2.10", 8700), "http://192.0.2.10:8700/health"),
            CoreProbe.precheck("ws://192.0.2.10:8700/ws", "192.0.2.10"),
        )
    }

    @Test
    fun asksTheCoresHealthOnTheSameHostAndPort() {
        assertEquals(CoreProbe.Precheck.Ask(boxEndpoint, "https://box.example.ts.net:443/health"), CoreProbe.precheck(box, ""))
    }

    @Test
    fun homeIsAskedFirstWithItsOwnClientAndWins() {
        val home = FakeHttp(coreUp)
        val away = FakeHttp { throw AssertionError("away must not be asked") }
        assertEquals(CoreSelection(true, CoreStatus.Fine), CoreProbe.select(lan, box, away, home, ""))
        assertEquals(listOf("http://10.0.0.2:8700/health"), home.asked)
    }

    @Test
    fun awayIsUsedWhenHomeDoesNotAnswer() {
        val home = FakeHttp(down)
        val away = FakeHttp(coreUp)
        assertEquals(CoreSelection(false, CoreStatus.Fine), CoreProbe.select(lan, box, away, home, ""))
        assertEquals(listOf("https://box.example.ts.net:443/health"), away.asked)
        // Neither answers: keep the current choice, report the away address.
        assertEquals(
            CoreSelection(null, CoreStatus.Unreachable(boxEndpoint)),
            CoreProbe.select(lan, box, FakeHttp(down), FakeHttp(down), ""),
        )
    }

    @Test
    fun eitherAddressMayBeMissing() {
        assertEquals(CoreSelection(null, CoreStatus.Fine), CoreProbe.select(null, box, FakeHttp(coreUp), FakeHttp(down), ""))
        assertEquals(CoreSelection(true, CoreStatus.Fine), CoreProbe.select(lan, null, FakeHttp(down), FakeHttp(coreUp), ""))
        assertEquals(
            CoreSelection(null, CoreStatus.Unreachable(lanEndpoint)),
            CoreProbe.select(lan, "", FakeHttp(down), FakeHttp(down), ""),
        )
        // Nothing configured: nothing asked, the UI's connect screen takes over.
        assertEquals(CoreSelection(null, CoreStatus.Fine), CoreProbe.select(null, null, FakeHttp(down), FakeHttp(down), ""))
    }

    @Test
    fun aRefusedHomeAddressIsNeverAsked() {
        val home = FakeHttp(coreUp)
        val selection = CoreProbe.select("ws://box.example.test:8700/ws", box, FakeHttp(coreUp), home, "")
        assertEquals(CoreSelection(false, CoreStatus.Fine), selection)
        assertEquals(emptyList<String>(), home.asked)
    }

    @Test
    fun onlyTheCoreItselfCountsAsReachable() {
        val ask = CoreProbe.precheck(box, "") as CoreProbe.Precheck.Ask
        val core = FakeHttp { HttpAnswer(200, """{"status":"ok","service":"core","version":"0.1.0"}""") }
        assertEquals(CoreStatus.Fine, CoreProbe.statusOf(ask, core))
        assertEquals(listOf("https://box.example.ts.net:443/health"), core.asked)
        // The box's HTTPS proxy is up but the PC is off: Tailscale serve answers 502.
        assertEquals(CoreStatus.Unreachable(boxEndpoint), CoreProbe.statusOf(ask, FakeHttp { HttpAnswer(502, "") }))
        // Something else answers 200 (not the Core).
        assertEquals(CoreStatus.Unreachable(boxEndpoint), CoreProbe.statusOf(ask, FakeHttp { HttpAnswer(200, "<html>") }))
        // No answer at all (timeout, no route, TLS failure).
        assertEquals(CoreStatus.Unreachable(boxEndpoint), CoreProbe.statusOf(ask, FakeHttp { throw IOException("timeout") }))
    }
}
