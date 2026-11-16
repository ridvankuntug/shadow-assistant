package app.shadowassistant.android

import com.sun.net.httpserver.HttpServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress

/** [UrlConnectionWakeHttp] against a loopback server (the JVM has no network security config). */
class WakeNetTest {
    private val server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0).apply { start() }
    private val base = "http://127.0.0.1:${server.address.port}"
    private val http = UrlConnectionWakeHttp()

    @After
    fun stop() {
        runCatching { server.stop(0) }
    }

    private fun route(path: String, status: Int, body: String, headers: Map<String, String> = emptyMap(), seen: MutableList<String?>? = null) {
        server.createContext(path) { ex ->
            seen?.add(ex.requestHeaders.getFirst("Authorization"))
            seen?.add(ex.requestMethod)
            headers.forEach { (k, v) -> ex.responseHeaders.add(k, v) }
            val bytes = body.toByteArray()
            ex.sendResponseHeaders(status, if (bytes.isEmpty()) -1 else bytes.size.toLong())
            if (bytes.isNotEmpty()) ex.responseBody.use { it.write(bytes) } else ex.close()
        }
    }

    @Test
    fun sendsTheBearerTokenAndReadsTheErrorBody() {
        val seen = mutableListOf<String?>()
        route("/wake", 429, """{"error":"auth_locked","retryAfterS":120}""", seen = seen)
        val answer = http.postWake("$base/wake", "tok_123")
        assertEquals(429, answer.status)
        assertEquals(WakeState.Stopped(WakeStop.AuthLocked(120)), WakeFlow.interpretWake(answer))
        assertEquals(listOf("Bearer tok_123", "POST"), seen)
    }

    @Test
    fun accepted() {
        route("/wake", 202, """{"sent":true}""")
        assertEquals(HttpAnswer(202, """{"sent":true}"""), http.postWake("$base/wake", "t"))
    }

    @Test
    fun redirectsAreNotFollowed() {
        route("/wake", 302, "", mapOf("Location" to "$base/elsewhere"))
        route("/elsewhere", 202, """{"sent":true}""")
        assertEquals(WakeState.Stopped(WakeStop.Unexpected(302)), WakeFlow.interpretWake(http.postWake("$base/wake", "t")))
    }

    @Test
    fun healthGet() {
        val seen = mutableListOf<String?>()
        route("/health", 200, """{"status":"ok","service":"core"}""", seen = seen)
        assertTrue(WakeFlow.coreAnswered(http.getHealth("$base/health")))
        assertEquals(listOf(null, "GET"), seen) // no token to the Core
    }

    @Test
    fun aBodyThatBreaksOffKeepsTheStatus() {
        // Announces 100 bytes, sends 5 and closes: the status still decides (docs/12 D1).
        server.createContext("/wake") { ex ->
            ex.sendResponseHeaders(429, 100)
            ex.responseBody.write("{\"err".toByteArray())
            ex.responseBody.flush()
            ex.close()
        }
        val answer = http.postWake("$base/wake", "t")
        assertEquals(429, answer.status)
        assertEquals(WakeState.Stopped(WakeStop.RateLimited(null)), WakeFlow.interpretWake(answer))
    }

    @Test
    fun noServerIsAnIOException() {
        server.stop(0)
        val result = runCatching { http.postWake("$base/wake", "t") }
        assertTrue(result.exceptionOrNull() is java.io.IOException)
    }

    @Test
    fun bodyIsCappedAndStopsAtTheDeadline() {
        val big = ByteArray(UrlConnectionWakeHttp.MAX_BODY_BYTES * 2) { 'a'.code.toByte() }
        assertEquals(UrlConnectionWakeHttp.MAX_BODY_BYTES, UrlConnectionWakeHttp.readCapped(ByteArrayInputStream(big), Long.MAX_VALUE).length)
        // A trickling server: one byte per read, the clock passes the deadline after three reads.
        var now = 0L
        val trickle = object : InputStream() {
            override fun read(): Int = 'x'.code
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                now += 10
                b[off] = 'x'.code.toByte()
                return 1
            }
        }
        assertEquals("xxx", UrlConnectionWakeHttp.readCapped(trickle, deadlineNanos = 30, now = { now }))
    }
}
