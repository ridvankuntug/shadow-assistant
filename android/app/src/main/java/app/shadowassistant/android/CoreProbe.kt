package app.shadowassistant.android

import android.os.Handler
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/** What the native error screen should say about the Core. */
sealed interface CoreStatus {
    /** Nothing configured yet, or reachable: no native error. */
    data object Fine : CoreStatus
    data class CleartextBlocked(val endpoint: CoreAddress.Endpoint) : CoreStatus
    data class Unreachable(val endpoint: CoreAddress.Endpoint) : CoreStatus
}

/**
 * Checks whether the Core can be reached so the shell can show a clear native
 * error instead of a page that silently keeps reconnecting. It asks the Core's
 * own `GET /health` (same host and port as the WebSocket, ws→http, wss→https;
 * no token, no other data; the app still talks to nothing but the Core). The
 * WebSocket itself is made by the UI.
 *
 * Not a bare TCP connect: through the recommended path (docs/05 §5) the address
 * belongs to the always-on box's Tailscale HTTPS proxy, which accepts the
 * connection even while the PC (the Core) is off and answers 502. Only a real
 * `/health` answer from the Core counts, the same check the waking flow uses
 * ([WakeFlow.coreAnswered]), so the "Çekirdeğe ulaşılamıyor" panel with its wake
 * button still appears when the PC sleeps.
 */
class CoreProbe(private val main: Handler, private val http: WakeHttp = UrlConnectionWakeHttp()) {
    private val io: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "shadow-probe") }
    private var generation = 0

    /** Probes [url]; [done] runs on the main thread, only for the latest call. */
    fun check(url: String?, done: (CoreStatus) -> Unit) {
        val gen = ++generation
        when (val first = precheck(url)) {
            is Precheck.Done -> done(first.status)
            is Precheck.Ask -> io.execute {
                val status = statusOf(first, http)
                main.post { if (gen == generation) done(status) }
            }
        }
    }

    fun shutdown() {
        io.shutdownNow()
    }

    /** What can be decided without the network, or which `/health` to ask. */
    sealed interface Precheck {
        data class Done(val status: CoreStatus) : Precheck
        data class Ask(val endpoint: CoreAddress.Endpoint, val healthUrl: String) : Precheck
    }

    companion object {
        fun precheck(url: String?, cleartextHost: String = CoreAddress.CLEARTEXT_HOST): Precheck {
            // The UI's connect screen handles a missing/invalid address.
            val endpoint = CoreAddress.parse(url) ?: return Precheck.Done(CoreStatus.Fine)
            if (!CoreAddress.cleartextAllowed(endpoint, cleartextHost)) return Precheck.Done(CoreStatus.CleartextBlocked(endpoint))
            val health = WakeAddress.coreHealthUrl(url) ?: return Precheck.Done(CoreStatus.Fine)
            return Precheck.Ask(endpoint, health)
        }

        /** Blocking: Fine only if the Core itself answers `/health` (a proxy's 502, a timeout etc. → Unreachable). */
        fun statusOf(ask: Precheck.Ask, http: WakeHttp): CoreStatus {
            val up = try {
                WakeFlow.coreAnswered(http.getHealth(ask.healthUrl))
            } catch (_: Exception) {
                false
            }
            return if (up) CoreStatus.Fine else CoreStatus.Unreachable(ask.endpoint)
        }
    }
}
