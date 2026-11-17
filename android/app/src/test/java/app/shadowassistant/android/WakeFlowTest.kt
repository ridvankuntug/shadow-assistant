package app.shadowassistant.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.SocketTimeoutException

class WakeFlowTest {
    /** Virtual time: tasks run in due order when the test advances the clock. */
    private class FakeScheduler {
        var now = 1_000_000L
        private var seq = 0
        private val tasks = mutableListOf<Triple<Long, Int, () -> Unit>>()

        val scheduler = object : WakeScheduler {
            override fun schedule(delayMs: Long, task: () -> Unit): () -> Unit {
                val entry = Triple(now + delayMs, seq++, task)
                tasks += entry
                return { tasks.remove(entry) }
            }
        }

        fun pending() = tasks.size

        /** Runs everything due within [ms] (tasks may schedule more). */
        fun advance(ms: Long) {
            val end = now + ms
            while (true) {
                val next = tasks.filter { it.first <= end }.minWithOrNull(compareBy({ it.first }, { it.second })) ?: break
                tasks.remove(next)
                now = maxOf(now, next.first)
                next.third()
            }
            now = end
        }
    }

    private class FakeHttp(private val clock: FakeScheduler) : WakeHttp {
        val wakeAnswers = ArrayDeque<() -> HttpAnswer>()
        var health: () -> HttpAnswer = { throw IOException("refused") }
        val wakeCalls = mutableListOf<Pair<String, String>>()
        var healthCalls = 0

        /** Simulated duration of a health request (it uses up its timeout). */
        var healthTakesMs = 0L

        override fun postWake(wakeUrl: String, token: String): HttpAnswer {
            wakeCalls += wakeUrl to token
            return wakeAnswers.removeFirst()()
        }

        override fun getHealth(healthUrl: String): HttpAnswer {
            healthCalls++
            clock.now += healthTakesMs
            return health()
        }
    }

    private val sched = FakeScheduler()
    private val http = FakeHttp(sched)
    private val states = mutableListOf<WakeState>()
    private val flow = WakeFlow(http, sched.scheduler, { sched.now }) { states += it }
    private val target = WakeTarget("http://wake.test:8704/wake", "secret-wake-token", "http://core.test:8700/health")

    private fun answer(status: Int, body: String = "") = { HttpAnswer(status, body) }

    private fun pressWith(status: Int, body: String = ""): WakeState {
        http.wakeAnswers += answer(status, body)
        assertTrue(flow.start(target))
        sched.advance(0)
        return flow.state
    }

    private val coreUp = HttpAnswer(200, """{"status":"ok","service":"core","version":"1"}""")

    // --- the wake answer (docs/12 D1 response contract) ------------------------

    @Test
    fun accepted202EntersWakingAndSendsTheToken() {
        val s = pressWith(202, """{"sent":true}""")
        assertEquals(WakeState.Waking(sched.now), s)
        assertEquals(listOf(target.wakeUrls.single() to target.token), http.wakeCalls)
        assertEquals(listOf(WakeState.Sending, s), states)
        assertTrue(flow.active)
    }

    @Test
    fun unauthorized401NeverWakes() {
        assertEquals(WakeState.Stopped(WakeStop.Unauthorized), pressWith(401, """{"error":"unauthorized"}"""))
        assertNoWaking()
    }

    @Test
    fun authLocked429IsTheLockoutNotTheRateLimit() {
        val s = pressWith(429, """{"error":"auth_locked","retryAfterS":287}""")
        assertEquals(WakeState.Stopped(WakeStop.AuthLocked(287)), s)
        assertNoWaking()
    }

    @Test
    fun rateLimited429CarriesTheWait() {
        val s = pressWith(429, """{"error":"rate_limited","retryAfterS":7}""")
        assertEquals(WakeState.Stopped(WakeStop.RateLimited(7)), s)
        assertNoWaking()
    }

    @Test
    fun unknownOrUnreadable429IsRateLimitedWithoutAWait() {
        for (body in listOf("""{"error":"something_else","retryAfterS":5}""", "", "not json", "[1,2]", """{"retryAfterS":5}""")) {
            assertEquals(body, WakeState.Stopped(WakeStop.RateLimited(null)), WakeFlow.interpretWake(HttpAnswer(429, body)))
        }
        assertEquals(WakeState.Stopped(WakeStop.RateLimited(null)), pressWith(429, "<html>busy</html>"))
        assertNoWaking()
    }

    @Test
    fun badRetryAfterValuesAreDropped() {
        for (v in listOf("0", "-3", "1.5", "\"10\"", "null", "99999999")) {
            assertEquals(
                v,
                WakeState.Stopped(WakeStop.RateLimited(null)),
                WakeFlow.interpretWake(HttpAnswer(429, """{"error":"rate_limited","retryAfterS":$v}""")),
            )
        }
        assertEquals(
            WakeState.Stopped(WakeStop.AuthLocked(null)),
            WakeFlow.interpretWake(HttpAnswer(429, """{"error":"auth_locked"}""")),
        )
    }

    @Test
    fun sendFailed503() {
        assertEquals(WakeState.Stopped(WakeStop.SendFailed), pressWith(503, """{"error":"send_failed"}"""))
        assertNoWaking()
        // Another 503 (not wake-svc's) is not called "could not send".
        assertEquals(WakeState.Stopped(WakeStop.Unexpected(503)), WakeFlow.interpretWake(HttpAnswer(503, "")))
    }

    @Test
    fun otherStatusesAreUnexpected() {
        for (status in listOf(200, 204, 301, 302, 400, 403, 404, 405, 500)) {
            assertEquals(WakeState.Stopped(WakeStop.Unexpected(status)), WakeFlow.interpretWake(HttpAnswer(status, """{"sent":true}""")))
        }
    }

    @Test
    fun noConnectionOrTimeoutIsUnreachable() {
        http.wakeAnswers += { throw SocketTimeoutException("timeout") }
        flow.start(target)
        sched.advance(0)
        assertEquals(WakeState.Stopped(WakeStop.Unreachable), flow.state)
        http.wakeAnswers += { throw IOException("refused") }
        flow.start(target)
        sched.advance(0)
        assertEquals(WakeState.Stopped(WakeStop.Unreachable), flow.state)
        // Not an IOException (e.g. a bad URL that slipped through): still ends, never stuck in Sending.
        http.wakeAnswers += { throw IllegalArgumentException("bad") }
        flow.start(target)
        sched.advance(0)
        assertEquals(WakeState.Stopped(WakeStop.Unreachable), flow.state)
        assertNoWaking()
    }

    private fun assertNoWaking() {
        assertFalse(states.any { it is WakeState.Waking })
        assertFalse(flow.active)
        assertEquals("nothing left to run", 0, sched.pending())
        assertEquals(0, http.healthCalls)
    }

    // --- waking: polling the Core -------------------------------------------------

    @Test
    fun pollsEveryFiveSecondsUntilTheCoreAnswers() {
        pressWith(202)
        sched.advance(4_999)
        assertEquals(0, http.healthCalls)
        sched.advance(1)
        assertEquals(1, http.healthCalls)
        sched.advance(10_000)
        assertEquals(3, http.healthCalls)
        http.health = { coreUp }
        sched.advance(5_000)
        assertEquals(WakeState.Done, flow.state)
        assertEquals(WakeState.Done, states.last())
        assertEquals(0, sched.pending())
    }

    @Test
    fun onlyACoreHealthAnswerCounts() {
        assertTrue(WakeFlow.coreAnswered(coreUp))
        assertFalse(WakeFlow.coreAnswered(HttpAnswer(200, """{"status":"ok","service":"wake-svc"}""")))
        assertFalse(WakeFlow.coreAnswered(HttpAnswer(200, "OK")))
        assertFalse(WakeFlow.coreAnswered(HttpAnswer(503, """{"service":"core"}""")))
        pressWith(202)
        http.health = { HttpAnswer(200, "<html>router login</html>") }
        sched.advance(30_000)
        assertTrue(flow.state is WakeState.Waking)
    }

    @Test
    fun givesUpAfterFourMinutes() {
        val waking = pressWith(202) as WakeState.Waking
        sched.advance(WakeFlow.GIVE_UP_MS - 1)
        assertTrue(flow.state is WakeState.Waking)
        sched.advance(WakeFlow.POLL_INTERVAL_MS)
        assertEquals(WakeState.Stopped(WakeStop.TimedOut), flow.state)
        assertTrue(sched.now - waking.sinceMs >= WakeFlow.GIVE_UP_MS)
        assertEquals(0, sched.pending())
        val polls = http.healthCalls
        sched.advance(60_000)
        assertEquals(polls, http.healthCalls)
    }

    @Test
    fun slowHealthRequestsCountTowardsTheFourMinutes() {
        // Every poll uses up its 3 s timeout: polls are 8 s apart, the limit is still 4 min of wall time.
        http.healthTakesMs = 3_000
        val waking = pressWith(202) as WakeState.Waking
        sched.advance(WakeFlow.GIVE_UP_MS + 20_000)
        assertEquals(WakeState.Stopped(WakeStop.TimedOut), flow.state)
        assertTrue(http.healthCalls in 29..31)
        assertTrue(sched.now - waking.sinceMs >= WakeFlow.GIVE_UP_MS)
    }

    @Test
    fun noPollStartsAfterTheLimit() {
        // One very slow request (e.g. a trickling answer) ends past the limit: the next poll is not sent.
        pressWith(202)
        http.healthTakesMs = WakeFlow.GIVE_UP_MS
        sched.advance(WakeFlow.POLL_INTERVAL_MS)
        assertEquals(1, http.healthCalls)
        assertEquals(WakeState.Stopped(WakeStop.TimedOut), flow.state)
        sched.advance(60_000)
        assertEquals(1, http.healthCalls)
    }

    @Test
    fun coreAnsweringOnTheLastPollStillCounts() {
        pressWith(202)
        // Polls run at 5 s … 235 s; at 240 s the limit is reached and no further request is sent.
        sched.advance(WakeFlow.GIVE_UP_MS - 2 * WakeFlow.POLL_INTERVAL_MS)
        http.health = { coreUp }
        sched.advance(WakeFlow.POLL_INTERVAL_MS)
        assertEquals(WakeState.Done, flow.state)
    }

    // --- cancellation ---------------------------------------------------------------

    @Test
    fun cancelStopsPollingAndIgnoresLateAnswers() {
        pressWith(202)
        flow.cancel()
        assertEquals(WakeState.Idle, flow.state)
        assertEquals(WakeState.Idle, states.last())
        http.health = { coreUp }
        sched.advance(60_000)
        assertEquals(0, http.healthCalls)
        assertEquals(WakeState.Idle, flow.state)
    }

    @Test
    fun answerArrivingAfterCancelIsIgnored() {
        // The request is in flight (cancel happens while postWake runs).
        http.wakeAnswers += {
            flow.cancel()
            HttpAnswer(202, "")
        }
        flow.start(target)
        sched.advance(0)
        assertEquals(WakeState.Idle, flow.state)
        assertFalse(states.any { it is WakeState.Waking })
        assertEquals(0, sched.pending())
    }

    @Test
    fun coreAddressChangeCancelsOnlyForAnotherCore() {
        pressWith(202)
        flow.coreAddressChanged("ws://core.test:8700/ws") // same Core, saved again
        assertTrue(flow.state is WakeState.Waking)
        flow.coreAddressChanged("ws://other.test:8700/ws")
        assertEquals(WakeState.Idle, flow.state)
        http.health = { coreUp }
        sched.advance(60_000)
        assertEquals(WakeState.Idle, flow.state)
        // No running flow: nothing to cancel, a finished result stays.
        pressWith(401)
        flow.coreAddressChanged("ws://third.test:8700/ws")
        assertEquals(WakeState.Stopped(WakeStop.Unauthorized), flow.state)
    }

    @Test
    fun homeAddressFirstThenAwayOnlyWithoutAnAnswer() {
        val both = WakeTarget(
            listOf("http://10.0.0.5:8704/wake", "https://wake.example.test:8443/wake"),
            "secret-wake-token",
            listOf("http://10.0.0.2:8700/health", "https://core.example.test:443/health"),
        )
        http.wakeAnswers += { throw IOException("no route") }
        http.wakeAnswers += answer(202)
        assertTrue(flow.start(both))
        sched.advance(0)
        assertTrue(flow.state is WakeState.Waking)
        assertEquals(listOf("http://10.0.0.5:8704/wake", "https://wake.example.test:8443/wake"), http.wakeCalls.map { it.first })
        // Any of the Core's addresses answering ends the wait.
        var asked = 0
        http.health = { if (asked++ % 2 == 0) throw IOException("no route") else coreUp }
        sched.advance(WakeFlow.POLL_INTERVAL_MS)
        assertEquals(WakeState.Done, flow.state)
        // Same Core at the other address: a running flow keeps going.
        flow.cancel()
        http.wakeAnswers += answer(202)
        assertTrue(flow.start(both))
        sched.advance(0)
        flow.coreAddressChanged("wss://core.example.test/ws")
        assertTrue(flow.state is WakeState.Waking)
        flow.coreAddressChanged("wss://other.example.test/ws")
        assertEquals(WakeState.Idle, flow.state)
    }

    @Test
    fun anAnswerFromHomeIsFinal() {
        val both = WakeTarget(listOf("http://10.0.0.5:8704/wake", "https://wake.example.test:8443/wake"), "t", listOf("http://10.0.0.2:8700/health"))
        http.wakeAnswers += answer(401)
        assertTrue(flow.start(both))
        sched.advance(0)
        assertEquals(WakeState.Stopped(WakeStop.Unauthorized), flow.state)
        assertEquals(1, http.wakeCalls.size)
    }

    @Test
    fun secondPressWhileRunningIsIgnoredAndAFinishedOneCanRestart() {
        pressWith(202)
        assertFalse(flow.start(target))
        assertEquals(1, http.wakeCalls.size)
        flow.cancel()
        assertEquals(WakeState.Stopped(WakeStop.RateLimited(9)), pressWith(429, """{"error":"rate_limited","retryAfterS":9}"""))
        assertEquals(WakeState.Waking(sched.now), pressWith(202))
    }

    @Test
    fun cancelInIdleDoesNotNotify() {
        flow.cancel()
        assertTrue(states.isEmpty())
    }

    @Test
    fun tokenStaysOutOfToString() {
        assertFalse(target.toString().contains(target.token))
    }

    // --- texts ----------------------------------------------------------------------

    @Test
    fun timeTexts() {
        assertEquals("0:00", WakeTime.elapsed(0))
        assertEquals("0:00", WakeTime.elapsed(-5))
        assertEquals("0:59", WakeTime.elapsed(59_999))
        assertEquals("1:05", WakeTime.elapsed(65_000))
        assertEquals("4:00", WakeTime.elapsed(240_000))
        assertEquals(7 to false, WakeTime.waitParts(7))
        assertEquals(59 to false, WakeTime.waitParts(59))
        assertEquals(1 to true, WakeTime.waitParts(60))
        assertEquals(2 to true, WakeTime.waitParts(61))
        assertEquals(60 to true, WakeTime.waitParts(3600))
    }
}
