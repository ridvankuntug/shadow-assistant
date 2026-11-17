package app.shadowassistant.android

import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * [WakeHttp] over [HttpURLConnection]. Callers pass only URLs that passed the
 * cleartext gate ([CoreAddress.cleartextAllowed] / [WakeAddress.check]: TLS, or
 * plain HTTP to a private IPv4 address). [healthTimeoutMs] is shorter for the
 * Core's home address probe ([CoreProbe]). No redirects,
 * no caches, bodies read up to [MAX_BODY_BYTES]. The token goes only into the
 * `Authorization` header; nothing here logs.
 */
class UrlConnectionWakeHttp(private val healthTimeoutMs: Int = HEALTH_TIMEOUT_MS) : WakeHttp {
    override fun postWake(wakeUrl: String, token: String): HttpAnswer =
        request(wakeUrl, "POST", WAKE_TIMEOUT_MS) { conn ->
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.doOutput = true
            conn.setFixedLengthStreamingMode(0)
        }

    override fun getHealth(healthUrl: String): HttpAnswer = request(healthUrl, "GET", healthTimeoutMs) {}

    private fun request(url: String, method: String, timeoutMs: Int, setup: (HttpURLConnection) -> Unit): HttpAnswer {
        val conn = URL(url).openConnection() as? HttpURLConnection ?: throw IOException("not an HTTP URL")
        try {
            conn.requestMethod = method
            conn.instanceFollowRedirects = false
            conn.useCaches = false
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            conn.setRequestProperty("Accept", "application/json")
            setup(conn)
            if (conn.doOutput) conn.outputStream.close()
            val status = conn.responseCode
            if (status < 0) throw IOException("no HTTP status")
            // The status is the answer: a body that fails or stalls while being read is treated as
            // empty (docs/12 D1: an unreadable 429 body is rate_limited without a wait).
            val body = try {
                val stream = if (status >= 400) conn.errorStream else conn.inputStream
                stream?.use { readCapped(it, System.nanoTime() + timeoutMs * 1_000_000L) }.orEmpty()
            } catch (_: IOException) {
                ""
            }
            return HttpAnswer(status, body)
        } finally {
            conn.disconnect()
        }
    }

    companion object {
        const val WAKE_TIMEOUT_MS = 5_000
        const val HEALTH_TIMEOUT_MS = 3_000
        const val MAX_BODY_BYTES = 16 * 1024

        /**
         * Reads at most [MAX_BODY_BYTES] and stops at [deadlineNanos] (System.nanoTime), so a
         * server that trickles bytes cannot hold a request beyond its timeout (each read is
         * still bounded by the read timeout). A cut body is not valid JSON: callers treat it as
         * unknown. Throws [IOException] if reading fails.
         */
        fun readCapped(input: InputStream, deadlineNanos: Long, now: () -> Long = System::nanoTime): String {
            val buf = ByteArray(MAX_BODY_BYTES)
            var n = 0
            while (n < buf.size && now() - deadlineNanos < 0) {
                val r = input.read(buf, n, buf.size - n)
                if (r < 0) break
                n += r
            }
            return String(buf, 0, n, Charsets.UTF_8)
        }
    }
}

/** [WakeScheduler] on one daemon thread. [shutdown] when the activity goes away. */
class ExecutorWakeScheduler : WakeScheduler {
    private val executor: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "shadow-wake").apply { isDaemon = true }
    }

    override fun schedule(delayMs: Long, task: () -> Unit): () -> Unit {
        val future = try {
            executor.schedule(task, delayMs, TimeUnit.MILLISECONDS)
        } catch (_: RejectedExecutionException) {
            return {} // shut down: the activity is gone
        }
        return { future.cancel(false) }
    }

    fun shutdown() {
        executor.shutdownNow()
    }
}
