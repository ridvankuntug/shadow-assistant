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
 * The result of one check (T21.3.3): [useHome] null keeps the current choice
 * (nothing answered, so switching would not help); true/false: the home / away
 * address answered and should be used.
 */
data class CoreSelection(val useHome: Boolean?, val status: CoreStatus)

/**
 * Checks whether the Core can be reached so the shell can show a clear native
 * error instead of a page that silently keeps reconnecting, and picks between
 * the Core's home and away address (T21.3.3): the home address is asked first
 * with a short timeout ([HOME_TIMEOUT_MS], [homeHttp]); if it does not answer,
 * the away address is asked. It asks the Core's own `GET /health` (same host and
 * port as the WebSocket, ws→http, wss→https; no token, no other data; the app
 * still talks to nothing but the Core). The WebSocket itself is made by the UI.
 *
 * Not a bare TCP connect: through the recommended path (docs/05 §5) the away
 * address belongs to the always-on box's Tailscale HTTPS proxy, which accepts
 * the connection even while the PC (the Core) is off and answers 502. Only a real
 * `/health` answer from the Core counts, the same check the waking flow uses
 * ([WakeFlow.coreAnswered]), so the "Çekirdeğe ulaşılamıyor" panel with its wake
 * button still appears when the PC sleeps.
 */
class CoreProbe(
    private val main: Handler,
    private val http: WakeHttp = UrlConnectionWakeHttp(),
    private val homeHttp: WakeHttp = UrlConnectionWakeHttp(HOME_TIMEOUT_MS),
) {
    private val io: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "shadow-probe") }
    private var generation = 0

    /** Checks [home] (if any) and then [away]; [done] runs on the main thread, only for the latest call. */
    fun check(home: String?, away: String?, done: (CoreSelection) -> Unit) {
        val gen = ++generation
        io.execute {
            val selection = select(home, away, http, homeHttp)
            main.post { if (gen == generation) done(selection) }
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
        /** T21.3.3: long enough for a LAN answer, short enough not to hold up the away address. */
        const val HOME_TIMEOUT_MS = 1_500

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

        private fun statusOf(url: String?, http: WakeHttp, cleartextHost: String): CoreStatus =
            when (val first = precheck(url, cleartextHost)) {
                is Precheck.Done -> first.status
                is Precheck.Ask -> statusOf(first, http)
            }

        /**
         * Blocking. Home first: if it answers, use it. Otherwise the away address
         * decides the status (with only a home address, the home one does).
         */
        fun select(
            home: String?,
            away: String?,
            http: WakeHttp,
            homeHttp: WakeHttp,
            cleartextHost: String = CoreAddress.CLEARTEXT_HOST,
        ): CoreSelection {
            val awayUrl = away?.takeIf { it.isNotBlank() }
            val homeUrl = home?.takeIf { it.isNotBlank() }
                ?: return CoreSelection(null, statusOf(awayUrl, http, cleartextHost))
            val homeStatus = statusOf(homeUrl, homeHttp, cleartextHost)
            val homeAnswered = homeStatus == CoreStatus.Fine && precheck(homeUrl, cleartextHost) is Precheck.Ask
            if (homeAnswered) return CoreSelection(true, CoreStatus.Fine)
            if (awayUrl == null) return CoreSelection(null, homeStatus)
            val awayStatus = statusOf(awayUrl, http, cleartextHost)
            val awayAnswered = awayStatus == CoreStatus.Fine && precheck(awayUrl, cleartextHost) is Precheck.Ask
            return CoreSelection(if (awayAnswered) false else null, awayStatus)
        }
    }
}
