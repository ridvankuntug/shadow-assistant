package app.shadowassistant.android

import org.json.JSONObject

/** Opens the microphone. All callbacks arrive on the main thread. */
interface Recorder {
    /**
     * Starts recording; [done] gets the running session, or null and an
     * [ErrorCode] (`busy`, `permission_denied` …).
     */
    fun start(done: (session: RecordingSession?, error: String?) -> Unit)

    /** Current input loudness 0..1 (a field read; called from the JS bridge thread). */
    fun level(): Float
}

/** One open microphone recording. Exactly one of [stop] / [discard] ends it. */
interface RecordingSession {
    /** Stops and encodes; [done] (main thread) gets null if there was nothing to encode. */
    fun stop(done: (EncodedAudio?) -> Unit)

    /** Stops and throws the audio away. */
    fun discard()
}

/** RECORD_AUDIO runtime permission; [request]'s answer comes back through [CaptureController.onPermissionResult]. */
interface MicPermission {
    fun granted(): Boolean
    fun request()
}

/**
 * The microphone half of the bridge contract (docs/03-platform-adapter.md
 * §4.1, §4.2, §4.4, §4.5) as a main-thread state machine, kept free of
 * Android classes so it can be unit-tested:
 *
 * - one capture at a time; a second `startCapture` is answered `busy`;
 * - a `startCapture` waits for the permission dialog and, after a grant, for
 *   the activity to be resumed — recording never starts in the background;
 * - `cancelCapture` answers a pending `startCapture` with `cancelled` exactly
 *   once and never starts recording for it, even if the grant arrives later;
 * - `onPause` cuts a running recording; the next `stopCapture` answers
 *   `capture_aborted` once, then `not_recording`;
 * - a microphone that finishes opening while the activity is paused is
 *   released and the start is answered `capture_aborted`.
 *
 * Every request id gets exactly one [reply].
 */
class CaptureController(
    private val recorder: Recorder,
    private val permission: MicPermission,
    private val hasMicrophone: () -> Boolean,
    private val reply: (requestId: String, payload: JSONObject) -> Unit,
) {
    private sealed interface State {
        data object Idle : State
        data class AwaitingPermission(val id: String) : State
        data class AwaitingResume(val id: String) : State
        data class Starting(val id: String) : State
        data class Recording(val id: String, val session: RecordingSession) : State
        data class Stopping(val id: String) : State
    }

    private var state: State = State.Idle
    private var resumed = false
    private var abortedSinceStart = false

    val isIdle: Boolean get() = state == State.Idle

    fun startCapture(id: String) {
        if (state != State.Idle) {
            reply(id, BridgeJs.error(ErrorCode.BUSY, "a capture is already running"))
            return
        }
        if (!hasMicrophone()) {
            reply(id, BridgeJs.error(ErrorCode.NOT_SUPPORTED, "no microphone"))
            return
        }
        abortedSinceStart = false
        if (permission.granted()) {
            beginWhenResumed(id)
        } else {
            state = State.AwaitingPermission(id)
            // A "don't ask again" denial comes back at once, without a dialog.
            permission.request()
        }
    }

    fun onPermissionResult(granted: Boolean) {
        val s = state as? State.AwaitingPermission ?: return // cancelled meanwhile: ignore the grant
        if (granted) {
            beginWhenResumed(s.id)
        } else {
            state = State.Idle
            reply(s.id, BridgeJs.error(ErrorCode.PERMISSION_DENIED, "microphone permission denied"))
        }
    }

    fun stopCapture(id: String) {
        when (val s = state) {
            is State.Recording -> {
                state = State.Stopping(s.id)
                s.session.stop { audio ->
                    state = State.Idle
                    if (audio == null) {
                        reply(id, BridgeJs.error(ErrorCode.NOT_RECORDING, "no audio was recorded"))
                    } else {
                        reply(id, BridgeJs.utterance(audio))
                    }
                }
            }
            State.Idle -> if (abortedSinceStart) {
                abortedSinceStart = false
                reply(id, BridgeJs.error(ErrorCode.CAPTURE_ABORTED, "recording was cut when the app went to the background"))
            } else {
                reply(id, BridgeJs.error(ErrorCode.NOT_RECORDING, "nothing is recording"))
            }
            else -> reply(id, BridgeJs.error(ErrorCode.NOT_RECORDING, "nothing is recording"))
        }
    }

    fun cancelCapture() {
        abortedSinceStart = false
        when (val s = state) {
            is State.AwaitingPermission -> cancelPending(s.id)
            is State.AwaitingResume -> cancelPending(s.id)
            // The recorder finishes opening later; onStarted sees the state change and releases it.
            is State.Starting -> cancelPending(s.id)
            is State.Recording -> {
                state = State.Idle
                s.session.discard()
            }
            // The recording has already ended; its stopCapture is answered normally.
            is State.Stopping, State.Idle -> Unit
        }
    }

    fun onResume() {
        resumed = true
        val s = state
        if (s is State.AwaitingResume) begin(s.id)
    }

    fun onPause() {
        resumed = false
        val s = state
        if (s is State.Recording) {
            state = State.Idle
            s.session.discard()
            abortedSinceStart = true
        }
        // A pending start (permission dialog) is kept: the dialog itself pauses the activity.
    }

    /** Activity teardown: release the microphone; pending requests die with the page. */
    fun release() {
        val s = state
        state = State.Idle
        if (s is State.Recording) s.session.discard()
    }

    fun level(): Float = recorder.level()

    private fun cancelPending(id: String) {
        state = State.Idle
        reply(id, BridgeJs.error(ErrorCode.CANCELLED))
    }

    private fun beginWhenResumed(id: String) {
        if (resumed) begin(id) else state = State.AwaitingResume(id)
    }

    private fun begin(id: String) {
        state = State.Starting(id)
        recorder.start { session, error -> onStarted(id, session, error) }
    }

    private fun onStarted(id: String, session: RecordingSession?, error: String?) {
        val s = state
        if (s !is State.Starting || s.id != id) {
            // Cancelled while the microphone was opening (already answered).
            session?.discard()
            return
        }
        when {
            session == null -> {
                state = State.Idle
                reply(id, BridgeJs.error(error ?: ErrorCode.UNKNOWN))
            }
            !resumed -> {
                state = State.Idle
                session.discard()
                reply(id, BridgeJs.error(ErrorCode.CAPTURE_ABORTED, "the app went to the background"))
            }
            else -> {
                state = State.Recording(id, session)
                reply(id, BridgeJs.ok())
            }
        }
    }
}
