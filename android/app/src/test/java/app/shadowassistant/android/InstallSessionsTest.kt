package app.shadowassistant.android

import app.shadowassistant.android.InstallSessions.Verdict
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class InstallSessionsTest {
    private val none = InstallSessions.NONE

    @Test
    fun currentSessionResultsAreShownUntilTheTerminalOne() {
        val s = InstallSessions()
        s.begin(5)
        assertEquals(Verdict.CURRENT, s.onResult(5, terminal = false))
        assertFalse(s.hasEnded(5))
        assertEquals(Verdict.CURRENT, s.onResult(5, terminal = true))
        assertTrue(s.hasEnded(5))
        // A duplicate delivery after the terminal one is stale.
        assertEquals(Verdict.STALE, s.onResult(5, terminal = true))
    }

    @Test
    fun abortOfAReplacedSessionDoesNotReachTheNewFlow() {
        val s = InstallSessions()
        s.begin(5) // first flow; its confirmation was never answered
        s.replace(listOf(5, 3)) // second flow marks it (and an older leftover) before abandoning
        // ABORTED of the abandoned sessions arrives before the new session even exists.
        assertEquals(Verdict.STALE, s.onResult(5, terminal = true))
        assertEquals(Verdict.STALE, s.onResult(3, terminal = true))
        s.begin(9)
        // ...or after it.
        assertEquals(Verdict.STALE, s.onResult(5, terminal = true))
        assertEquals(Verdict.CURRENT, s.onResult(9, terminal = false))
    }

    @Test
    fun replaceEndsTheCurrentSessionEvenIfNotListed() {
        val s = InstallSessions()
        s.begin(5)
        s.replace(emptyList())
        assertTrue(s.hasEnded(5))
        s.begin(6)
        assertEquals(Verdict.STALE, s.onResult(5, terminal = true))
    }

    @Test
    fun beginReplacesAnotherCurrentSession() {
        val s = InstallSessions()
        s.begin(5)
        s.begin(6)
        assertEquals(Verdict.STALE, s.onResult(5, terminal = true))
        assertEquals(Verdict.CURRENT, s.onResult(6, terminal = true))
    }

    @Test
    fun retiredSessionIsStale() {
        val s = InstallSessions()
        s.begin(5)
        s.retire(5) // commit failed, session abandoned
        assertEquals(Verdict.STALE, s.onResult(5, terminal = true))
    }

    @Test
    fun otherSessionWhileOneIsCurrentIsStale() {
        val s = InstallSessions()
        s.begin(5)
        assertEquals(Verdict.STALE, s.onResult(7, terminal = true))
        assertEquals(Verdict.STALE, s.onResult(none, terminal = true))
        assertEquals(Verdict.CURRENT, s.onResult(5, terminal = true))
    }

    @Test
    fun resultAfterProcessDeathIsShownAndTracked() {
        val s = InstallSessions() // fresh process: nothing known
        assertEquals(Verdict.UNKNOWN, s.onResult(8, terminal = false))
        // The pending session became current: its terminal result is shown, another is not.
        assertEquals(Verdict.STALE, s.onResult(4, terminal = true))
        assertEquals(Verdict.CURRENT, s.onResult(8, terminal = true))
        assertEquals(Verdict.STALE, s.onResult(8, terminal = true))
    }

    @Test
    fun missingSessionIdWithNothingKnownIsShownButNotTracked() {
        val s = InstallSessions()
        assertEquals(Verdict.UNKNOWN, s.onResult(none, terminal = false))
        assertFalse(s.hasEnded(none))
        assertEquals(Verdict.UNKNOWN, s.onResult(none, terminal = true))
    }

    @Test
    fun fastFailureEndsTheSessionBeforeTheWaitingScreen() {
        // The status (failure) is handled on the main thread before the background flow's
        // "waiting for confirmation" post runs: that post must see the session as ended.
        val s = InstallSessions()
        s.begin(5)
        assertEquals(Verdict.CURRENT, s.onResult(5, terminal = true))
        assertTrue(s.hasEnded(5))
        // The normal order: pending first, so "waiting" is still right.
        s.begin(6)
        s.onResult(6, terminal = false)
        assertFalse(s.hasEnded(6))
    }

    @Test
    fun endedMemoryIsBounded() {
        val s = InstallSessions(memory = 3)
        for (id in 1..5) {
            s.begin(id)
            s.retire(id)
        }
        assertFalse(s.hasEnded(1))
        assertFalse(s.hasEnded(2))
        assertTrue(s.hasEnded(3))
        assertTrue(s.hasEnded(5))
    }

    @Test
    fun beginOfAnEndedIdMakesItCurrentAgain() {
        val s = InstallSessions()
        s.begin(5)
        s.retire(5)
        s.begin(5)
        assertFalse(s.hasEnded(5))
        assertEquals(Verdict.CURRENT, s.onResult(5, terminal = true))
    }
}
