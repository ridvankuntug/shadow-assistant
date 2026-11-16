package app.shadowassistant.android

import org.json.JSONException
import org.json.JSONObject
import java.util.Locale

/** An HTTP answer: status and (capped) body text. */
data class HttpAnswer(val status: Int, val body: String)

/** The two requests of the waking flow. Both throw (usually [java.io.IOException]) when there is no answer (incl. timeouts). */
interface WakeHttp {
    /** `POST <wakeUrl>` with `Authorization: Bearer <token>`, empty body, no redirects, timeout 5 s. */
    fun postWake(wakeUrl: String, token: String): HttpAnswer

    /** `GET <healthUrl>`, no redirects, timeout 3 s. */
    fun getHealth(healthUrl: String): HttpAnswer
}

/** Runs tasks later on one background thread; the returned function cancels the task. */
interface WakeScheduler {
    fun schedule(delayMs: Long, task: () -> Unit): () -> Unit
}

/** Why the flow stopped without the Core answering (docs/12 D1 response contract, D2 flow). */
sealed interface WakeStop {
    /** `401`: the token was missing, malformed or wrong. */
    data object Unauthorized : WakeStop

    /** `429 auth_locked`: the address is locked after wrong tokens; nothing was sent. */
    data class AuthLocked(val retryAfterS: Int?) : WakeStop

    /** `429 rate_limited` (or another / unreadable `429`: [retryAfterS] null): an earlier wake was just accepted. */
    data class RateLimited(val retryAfterS: Int?) : WakeStop

    /** `503 send_failed`: the box could not send the packet. */
    data object SendFailed : WakeStop

    /** No answer from the box (connection refused, timeout, no route). */
    data object Unreachable : WakeStop

    /** Any other answer (not produced by wake-svc for `POST /wake`: wrong address, proxy, redirect). */
    data class Unexpected(val status: Int) : WakeStop

    /** The packet was sent but the Core did not answer within [WakeFlow.GIVE_UP_MS]. */
    data object TimedOut : WakeStop
}

sealed interface WakeState {
    data object Idle : WakeState
    data object Sending : WakeState

    /** `202`: polling the Core since [sinceMs] (on the flow's clock). */
    data class Waking(val sinceMs: Long) : WakeState

    /** The Core answered `/health`. */
    data object Done : WakeState
    data class Stopped(val reason: WakeStop) : WakeState
}

/** What one press needs: where to send, the token, and which Core to wait for. */
data class WakeTarget(val wakeUrl: String, val token: String, val coreHealthUrl: String) {
    override fun toString() = "WakeTarget(wakeUrl=$wakeUrl, token=<redacted>, coreHealthUrl=$coreHealthUrl)"
}

/**
 * The "Bilgisayarı uyandır" state machine (docs/12 D2), free of Android so it
 * can be tested with a fake clock, scheduler and HTTP:
 *
 * ```
 * Idle ─start─▶ Sending ─202─▶ Waking ─/health 200 "core"─▶ Done
 *                  │             └─ GIVE_UP_MS without it ─▶ Stopped(TimedOut)
 *                  └─ 401 / 429 / 503 / other / no answer ─▶ Stopped(reason)
 * ```
 *
 * A `429` never enters [WakeState.Waking]: the branch is on the body's `error`
 * (`auth_locked` / `rate_limited`; anything else counts as `rate_limited`
 * without a wait), not on the status. [cancel] (activity destroyed, panel
 * closed) and [coreAddressChanged] return to Idle; a result that arrives after
 * that is ignored (every run has its own generation).
 *
 * Threading: network calls run in [scheduler] tasks, outside the lock, so
 * [cancel] from the main thread never waits for a request. [onState] is called
 * on the scheduler thread or on the thread that called [start] / [cancel]; the
 * caller hands it to the UI thread itself.
 */
class WakeFlow(
    private val http: WakeHttp,
    private val scheduler: WakeScheduler,
    private val clock: () -> Long,
    private val onState: (WakeState) -> Unit,
) {
    private val lock = Any()
    private var generation = 0
    private var target: WakeTarget? = null
    private var pending: (() -> Unit)? = null
    private var current: WakeState = WakeState.Idle

    val state: WakeState get() = synchronized(lock) { current }

    /** Sending or Waking. */
    val active: Boolean get() = state.let { it is WakeState.Sending || it is WakeState.Waking }

    /** Starts a press; ignored (false) while one is already sending or waking. */
    fun start(target: WakeTarget): Boolean {
        val gen = synchronized(lock) {
            if (current is WakeState.Sending || current is WakeState.Waking) return false
            this.target = target
            ++generation
        }
        if (!set(gen, WakeState.Sending)) return false
        schedule(gen, 0) { send(gen) }
        return true
    }

    /** Back to Idle; any request still in flight is ignored when it answers. */
    fun cancel() {
        val changed = synchronized(lock) {
            generation++
            pending?.invoke()
            pending = null
            target = null
            val was = current
            current = WakeState.Idle
            was != WakeState.Idle
        }
        if (changed) onState(WakeState.Idle)
    }

    /** The Core address changed (docs/12 D2): a running flow would wait for the wrong Core, so it stops. */
    fun coreAddressChanged(newCoreUrl: String?) {
        val waitingFor = synchronized(lock) { target?.coreHealthUrl } ?: return
        if (WakeAddress.coreHealthUrl(newCoreUrl) != waitingFor) cancel()
    }

    private fun send(gen: Int) {
        val t = targetFor(gen) ?: return
        val next = try {
            interpretWake(http.postWake(t.wakeUrl, t.token))
        } catch (_: Exception) {
            // IOException: no answer / timeout / refused by the network security config; anything
            // else (e.g. a malformed URL that slipped through) must not leave the flow in Sending.
            WakeState.Stopped(WakeStop.Unreachable)
        }
        if (next is WakeState.Waking) {
            val since = clock()
            if (set(gen, WakeState.Waking(since))) schedule(gen, POLL_INTERVAL_MS) { poll(gen, since) }
        } else {
            set(gen, next)
        }
    }

    private fun poll(gen: Int, sinceMs: Long) {
        val t = targetFor(gen) ?: return
        // A slow previous request can push a poll past the limit: give up without starting it.
        if (clock() - sinceMs >= GIVE_UP_MS) {
            set(gen, WakeState.Stopped(WakeStop.TimedOut))
            return
        }
        val up = try {
            coreAnswered(http.getHealth(t.coreHealthUrl))
        } catch (_: Exception) {
            false
        }
        when {
            up -> set(gen, WakeState.Done)
            clock() - sinceMs >= GIVE_UP_MS -> set(gen, WakeState.Stopped(WakeStop.TimedOut))
            else -> schedule(gen, POLL_INTERVAL_MS) { poll(gen, sinceMs) }
        }
    }

    private fun targetFor(gen: Int): WakeTarget? = synchronized(lock) { if (gen == generation) target else null }

    /** Applies [next] only if run [gen] is still current; false if it was cancelled meanwhile. */
    private fun set(gen: Int, next: WakeState): Boolean {
        synchronized(lock) {
            if (gen != generation) return false
            current = next
            if (next !is WakeState.Sending && next !is WakeState.Waking) {
                target = null
                pending = null
            }
        }
        onState(next)
        return true
    }

    private fun schedule(gen: Int, delayMs: Long, task: () -> Unit) {
        synchronized(lock) {
            if (gen != generation) return
            pending = scheduler.schedule(delayMs, task)
        }
    }

    companion object {
        const val POLL_INTERVAL_MS = 5_000L

        /** docs/12 Q9: 4 min (cold boot + boot task delay + Core start); tune after measuring. */
        const val GIVE_UP_MS = 4 * 60_000L

        private const val MAX_RETRY_AFTER_S = 24 * 3600

        /**
         * docs/12 D1 response contract → next state ([WakeState.Waking]'s time is
         * set by the caller). Branches on the body's `error` for `429`.
         */
        fun interpretWake(answer: HttpAnswer): WakeState = when (answer.status) {
            202 -> WakeState.Waking(0)
            401 -> WakeState.Stopped(WakeStop.Unauthorized)
            429 -> {
                val body = jsonOrNull(answer.body)
                when (body?.optString("error")) {
                    "auth_locked" -> WakeState.Stopped(WakeStop.AuthLocked(retryAfter(body)))
                    "rate_limited" -> WakeState.Stopped(WakeStop.RateLimited(retryAfter(body)))
                    else -> WakeState.Stopped(WakeStop.RateLimited(null))
                }
            }
            503 -> if (jsonOrNull(answer.body)?.optString("error") == "send_failed") {
                WakeState.Stopped(WakeStop.SendFailed)
            } else {
                WakeState.Stopped(WakeStop.Unexpected(503))
            }
            else -> WakeState.Stopped(WakeStop.Unexpected(answer.status))
        }

        /** docs/12 D2: any `200` whose body says `"service":"core"`. */
        fun coreAnswered(answer: HttpAnswer): Boolean =
            answer.status == 200 && jsonOrNull(answer.body)?.optString("service") == "core"

        private fun jsonOrNull(text: String): JSONObject? = try {
            JSONObject(text)
        } catch (_: JSONException) {
            null
        }

        /** `retryAfterS` as a whole number of seconds ≥ 1, else null (the hint is shown without a wait). */
        private fun retryAfter(body: JSONObject): Int? {
            val value = body.opt("retryAfterS") as? Number ?: return null
            val d = value.toDouble()
            if (d.isNaN() || d < 1 || d > MAX_RETRY_AFTER_S || d != Math.floor(d)) return null
            return d.toInt()
        }
    }
}

/** Time texts of the waking panel, without Android (unit-tested). */
object WakeTime {
    /** Elapsed time as `m:ss` (negative counts as 0). */
    fun elapsed(ms: Long): String {
        val s = (ms.coerceAtLeast(0) / 1000)
        return String.format(Locale.ROOT, "%d:%02d", s / 60, s % 60)
    }

    /** A wait in whole seconds (< 60) or whole minutes, rounded up: (value, inMinutes). */
    fun waitParts(seconds: Int): Pair<Int, Boolean> =
        if (seconds < 60) seconds.coerceAtLeast(1) to false else (seconds + 59) / 60 to true
}
