package app.shadowassistant.android

import android.os.Handler
import java.net.InetSocketAddress
import java.net.Socket
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
 * error instead of a page that silently keeps reconnecting. It only opens and
 * closes a TCP connection to the Core's own host/port (no data is sent; the
 * app still talks to nothing but the Core). The WebSocket itself is made by
 * the UI.
 */
class CoreProbe(private val main: Handler) {
    private val io: ExecutorService = Executors.newSingleThreadExecutor { r -> Thread(r, "shadow-probe") }
    private var generation = 0

    /** Probes [url]; [done] runs on the main thread, only for the latest call. */
    fun check(url: String?, done: (CoreStatus) -> Unit) {
        val gen = ++generation
        val endpoint = CoreAddress.parse(url)
        val immediate = when {
            endpoint == null -> CoreStatus.Fine // the UI's connect screen handles a missing/invalid address
            !CoreAddress.cleartextAllowed(endpoint) -> CoreStatus.CleartextBlocked(endpoint)
            else -> null
        }
        if (immediate != null) {
            done(immediate)
            return
        }
        io.execute {
            val reachable = try {
                Socket().use { it.connect(InetSocketAddress(endpoint!!.host, endpoint.port), TIMEOUT_MS) }
                true
            } catch (_: Exception) {
                false
            }
            val status = if (reachable) CoreStatus.Fine else CoreStatus.Unreachable(endpoint!!)
            main.post { if (gen == generation) done(status) }
        }
    }

    fun shutdown() {
        io.shutdownNow()
    }

    private companion object {
        const val TIMEOUT_MS = 4_000
    }
}
