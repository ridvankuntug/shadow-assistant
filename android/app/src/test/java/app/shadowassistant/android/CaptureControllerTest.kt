package app.shadowassistant.android

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class CaptureControllerTest {
    private class FakeSession : RecordingSession {
        var stopDone: ((EncodedAudio?) -> Unit)? = null
        var discarded = false
        override fun stop(done: (EncodedAudio?) -> Unit) {
            stopDone = done
        }
        override fun discard() {
            discarded = true
        }
    }

    private class FakeRecorder : Recorder {
        val starts = mutableListOf<(RecordingSession?, String?) -> Unit>()
        override fun start(done: (RecordingSession?, String?) -> Unit) {
            starts += done
        }
        override fun level() = 0.5f
    }

    private class FakePermission(var isGranted: Boolean) : MicPermission {
        var requests = 0
        override fun granted() = isGranted
        override fun request() {
            requests++
        }
    }

    private lateinit var recorder: FakeRecorder
    private lateinit var permission: FakePermission
    private var hasMic = true
    private val replies = mutableListOf<Pair<String, JSONObject>>()
    private lateinit var c: CaptureController

    @Before
    fun setUp() {
        recorder = FakeRecorder()
        permission = FakePermission(true)
        hasMic = true
        replies.clear()
        c = CaptureController(recorder, permission, { hasMic }) { id, p -> replies += id to p }
        c.onResume()
    }

    private fun code(i: Int) = replies[i].second.getJSONObject("error").getString("code")
    private fun ok(i: Int) = replies[i].second.getBoolean("ok")

    /** Starts a capture and lets the microphone open successfully. */
    private fun record(id: String = "a1"): FakeSession {
        c.startCapture(id)
        val s = FakeSession()
        recorder.starts.last()(s, null)
        return s
    }

    @Test
    fun startThenStopReturnsTheUtterance() {
        val s = record()
        assertEquals("a1" to true, replies[0].first to ok(0))
        c.stopCapture("a2")
        s.stopDone!!(EncodedAudio("audio/wav", "UklGRg==", 1840))
        val p = replies[1].second
        assertEquals("a2", replies[1].first)
        assertTrue(p.getBoolean("ok"))
        assertEquals("audio/wav", p.getString("mime"))
        assertEquals("UklGRg==", p.getString("data"))
        assertEquals(1840, p.getLong("durationMs"))
        assertTrue(c.isIdle)
    }

    @Test
    fun secondStartIsBusy() {
        record()
        c.startCapture("a2")
        assertEquals("a2", replies[1].first)
        assertEquals(ErrorCode.BUSY, code(1))
    }

    @Test
    fun noMicrophoneIsNotSupported() {
        hasMic = false
        c.startCapture("a1")
        assertEquals(ErrorCode.NOT_SUPPORTED, code(0))
        assertTrue(recorder.starts.isEmpty())
    }

    @Test
    fun recorderErrorIsPassedThrough() {
        c.startCapture("a1")
        recorder.starts.last()(null, ErrorCode.BUSY)
        assertEquals(ErrorCode.BUSY, code(0))
        assertTrue(c.isIdle)
    }

    @Test
    fun permissionDeniedAnswersOnce() {
        permission.isGranted = false
        c.startCapture("a1")
        assertEquals(1, permission.requests)
        assertTrue(replies.isEmpty())
        c.onPause() // dialog pauses the activity; the pending start survives
        c.onPermissionResult(false)
        assertEquals(1, replies.size)
        assertEquals(ErrorCode.PERMISSION_DENIED, code(0))
        assertTrue(recorder.starts.isEmpty())
    }

    @Test
    fun grantWhilePausedStartsOnlyAfterResume() {
        permission.isGranted = false
        c.startCapture("a1")
        c.onPause()
        permission.isGranted = true
        c.onPermissionResult(true)
        assertTrue("must not record in the background", recorder.starts.isEmpty())
        c.onResume()
        assertEquals(1, recorder.starts.size)
        recorder.starts[0](FakeSession(), null)
        assertTrue(ok(0))
    }

    @Test
    fun cancelWhileAwaitingPermissionAnswersCancelledAndIgnoresLaterGrant() {
        permission.isGranted = false
        c.startCapture("a1")
        c.cancelCapture()
        assertEquals("a1", replies[0].first)
        assertEquals(ErrorCode.CANCELLED, code(0))
        c.onPermissionResult(true)
        c.onResume()
        assertTrue(recorder.starts.isEmpty())
        assertEquals(1, replies.size)
    }

    @Test
    fun cancelWhileMicIsOpeningReleasesItWithoutTouchingANewerCapture() {
        c.startCapture("a1")
        c.cancelCapture()
        assertEquals(ErrorCode.CANCELLED, code(0))
        c.startCapture("a2") // the UI may start again once a1 is answered
        val late = FakeSession()
        recorder.starts[0](late, null) // a1's microphone finally opens
        assertTrue(late.discarded)
        val fresh = FakeSession()
        recorder.starts[1](fresh, null)
        assertFalse(fresh.discarded)
        assertEquals("a2", replies[1].first)
        assertTrue(ok(1))
        assertEquals(2, replies.size)
    }

    @Test
    fun pauseCutsRecordingAndNextStopIsAbortedOnce() {
        val s = record()
        c.onPause()
        assertTrue(s.discarded)
        c.onResume()
        c.stopCapture("a2")
        assertEquals(ErrorCode.CAPTURE_ABORTED, code(1))
        c.stopCapture("a3")
        assertEquals(ErrorCode.NOT_RECORDING, code(2))
    }

    @Test
    fun micOpeningWhilePausedIsReleasedAndAborted() {
        c.startCapture("a1")
        c.onPause()
        val s = FakeSession()
        recorder.starts[0](s, null)
        assertTrue(s.discarded)
        assertEquals(ErrorCode.CAPTURE_ABORTED, code(0))
    }

    @Test
    fun stopCalledBeforePauseIsAnsweredNormally() {
        val s = record()
        c.stopCapture("a2")
        c.onPause()
        assertFalse(s.discarded)
        s.stopDone!!(EncodedAudio("audio/wav", "AA==", 500))
        assertTrue(ok(1))
    }

    @Test
    fun cancelDiscardsRecordingWithoutCallbackAndIsSafeWhenIdle() {
        c.cancelCapture()
        assertTrue(replies.isEmpty())
        val s = record()
        c.cancelCapture()
        assertTrue(s.discarded)
        assertEquals(1, replies.size) // only the start answer
        c.stopCapture("a2")
        assertEquals(ErrorCode.NOT_RECORDING, code(1))
    }

    @Test
    fun stopWithoutRecordingIsNotRecording() {
        c.stopCapture("a1")
        assertEquals(ErrorCode.NOT_RECORDING, code(0))
    }

    @Test
    fun startWhileBackgroundedWaitsForResume() {
        c.onPause()
        c.startCapture("a1")
        assertTrue(recorder.starts.isEmpty())
        c.onResume()
        assertEquals(1, recorder.starts.size)
    }

    @Test
    fun levelComesFromRecorder() {
        assertEquals(0.5f, c.level())
    }
}
