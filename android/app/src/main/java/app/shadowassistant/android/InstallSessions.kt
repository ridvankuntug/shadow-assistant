package app.shadowassistant.android

/**
 * Which `PackageInstaller` session results [UpdateActivity] may act on. Pure (no Android
 * types) and thread-safe: the background flow registers sessions, the main thread reads
 * results. One instance per process ([Updater.sessions]).
 *
 * - A session is **current** from [begin] until its first terminal result or [retire].
 * - Sessions that a newer flow replaced ([replace]), that were abandoned after a failed
 *   commit ([retire]) or that already delivered a terminal result are **ended**: their late
 *   results (typically ABORTED of an abandoned session) are [Verdict.STALE] and never land
 *   on the screen of a newer flow.
 * - A result for a session this process has not seen, while no session is current, is
 *   [Verdict.UNKNOWN]: the process was restarted while the system dialog was open. It is
 *   shown, and a non-terminal one becomes current.
 *
 * [hasEnded] lets the flow that committed a session skip its "waiting for confirmation"
 * screen when the result was faster (Android can fail a session at once).
 */
class InstallSessions(private val memory: Int = 32) {
    enum class Verdict { CURRENT, UNKNOWN, STALE }

    private var current = NONE

    /** Ended session ids, oldest first; bounded by [memory] (ids are not reused in practice). */
    private val ended = LinkedHashSet<Int>()

    /** A new flow replaces the current session and [previous] ones (e.g. `mySessions`) before abandoning them. */
    @Synchronized
    fun replace(previous: Iterable<Int>) {
        end(current)
        previous.forEach(::end)
    }

    /** [id] was just created by the current flow; any other current session is replaced. */
    @Synchronized
    fun begin(id: Int) {
        if (current != id) end(current)
        ended.remove(id)
        current = id
    }

    /** [id] will never deliver a result worth showing (e.g. abandoned after a failed commit). */
    @Synchronized
    fun retire(id: Int) = end(id)

    /** Classifies a result for [id]; a terminal accepted result ends the session. */
    @Synchronized
    fun onResult(id: Int, terminal: Boolean): Verdict {
        val verdict = when {
            id in ended -> Verdict.STALE
            current == NONE -> Verdict.UNKNOWN
            id == current -> Verdict.CURRENT
            else -> Verdict.STALE
        }
        when {
            verdict == Verdict.STALE -> Unit
            terminal -> end(id)
            id != NONE -> current = id
        }
        return verdict
    }

    @Synchronized
    fun hasEnded(id: Int): Boolean = id in ended

    private fun end(id: Int) {
        if (id == NONE) return
        if (id == current) current = NONE
        ended.remove(id)
        ended.add(id)
        while (ended.size > memory) ended.remove(ended.first())
    }

    companion object {
        /** "No session" (also the default for a missing `EXTRA_SESSION_ID`); real ids are positive. */
        const val NONE = -1
    }
}
