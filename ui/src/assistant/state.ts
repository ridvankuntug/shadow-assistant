/**
 * Assistant UI state: a pure reducer over Core protocol messages and local
 * events (microphone, playback), plus derivation of the five visible phases.
 *
 * Server-side states (idle / thinking / awaiting_confirm) come from the Core;
 * listening and speaking are local (microphone / playback), see §5.
 */
import type { StatusEvent } from "../protocol/client.ts";
import type {
  ConfirmResolvedBy,
  HistoryItem,
  ServerMessage,
  ServerState,
  ServiceHealth,
  ToolStatus,
  Voice,
} from "../protocol/types.ts";

export type Phase = "idle" | "listening" | "thinking" | "speaking" | "awaiting_confirm";

export type CaptureState = "off" | "starting" | "recording" | "sending";

export type ChatMessage = {
  /** `${turnId}:${role}` — unique per turn and side. */
  key: string;
  turnId: string;
  role: "user" | "assistant";
  text: string;
  /** User audio awaiting its transcript, or assistant text still streaming. */
  pending: boolean;
  tools: { name: string; status: ToolStatus }[];
  cancelled?: boolean;
  failed?: boolean;
};

export type PendingConfirm = {
  requestId: string;
  turnId: string;
  tool: string;
  summary: string;
  expiresAt: number;
  /** A button answer was sent; waiting for `confirm_resolved`. */
  responding: boolean;
};

export type Notice = {
  /** Core error code or a local code (mic_*, playback_failed, too_short…). */
  code: string;
  message?: string;
  turnId?: string;
};

export type ActiveTurn = {
  id: string;
  /**
   * The Core has shown activity for this turn. A `state: idle` only ends the
   * turn after that — otherwise the idle that answers a barge-in `cancel` could
   * end the new turn that was sent right after it.
   */
  seen: boolean;
};

/**
 * The tts-svc voice list (settings picker, core TTS mode only). `unavailable`
 * covers `error tts_unavailable`, any other error for the request and a Core
 * that never answers (older Core without `voices`).
 */
export type VoiceCatalog = {
  status: "idle" | "loading" | "ready" | "unavailable";
  /** Id of the `voices` request in flight (or last answered). */
  requestId: string | null;
  /** The Core's default voice id (used when the user chose none). */
  defaultVoice: string | null;
  voices: Voice[];
};

/** A "Dene" voice sample: a `speak` that belongs to no turn. */
export type VoicePreview = { id: string; failed: boolean };

export type AssistantState = {
  connection: StatusEvent;
  sessionId: string | null;
  serverState: ServerState;
  capture: CaptureState;
  /** Turn whose reply is playing (speaking phase). */
  playing: string | null;
  /** Turn whose `speech` clip has been requested but not received yet. */
  awaitingSpeech: string | null;
  activeTurn: ActiveTurn | null;
  /**
   * A turn the user already sent that the controller is holding back until the
   * Core has wound down a cancelled turn (see controller CANCEL_SETTLE_MS). It
   * becomes `activeTurn` only when it is actually sent, so the old turn's late
   * `state` frames cannot be attributed to it.
   */
  queuedTurn: string | null;
  /** Audio sent as a (possible) voice answer to a pending confirmation. */
  voiceAnswer: string | null;
  messages: ChatMessage[];
  history: HistoryItem[];
  historyLoaded: boolean;
  /**
   * Pending confirmations, oldest first. The Core applies a voice answer to the
   * oldest one, so that is the one shown (see currentConfirm).
   */
  confirms: PendingConfirm[];
  lastResolved: { requestId: string; approved: boolean; by: ConfirmResolvedBy } | null;
  /** Recently cancelled turn ids; late frames for them are dropped. */
  cancelled: string[];
  notice: Notice | null;
  /** Latest `services` frame from the Core (empty until the first one). */
  services: ServiceHealth[];
  voices: VoiceCatalog;
  voicePreview: VoicePreview | null;
};

export type Action =
  | { type: "status"; ev: StatusEvent }
  | { type: "server"; msg: ServerMessage }
  | { type: "user_text_sent"; id: string; text: string; queued?: boolean }
  | { type: "audio_sent"; id: string; queued?: boolean }
  | { type: "queued_turn_sent"; id: string }
  | { type: "queued_turn_dropped"; id: string }
  | { type: "capture"; state: CaptureState }
  | { type: "speech_requested"; id: string }
  | { type: "playback_started"; id: string }
  | { type: "playback_ended"; id: string }
  | { type: "speech_stopped" }
  | { type: "barge_in"; turnId: string }
  | { type: "confirm_sent"; requestId: string }
  | { type: "notice"; notice: Notice }
  | { type: "dismiss_notice" }
  | { type: "reset_conversation" }
  | { type: "voices_requested"; id: string }
  | { type: "voices_timeout"; id: string }
  | { type: "voice_preview_requested"; id: string };

export const MAX_MESSAGES = 100;
const MAX_CANCELLED = 20;

export const initialState: AssistantState = {
  connection: { status: "closed", attempt: 0 },
  sessionId: null,
  serverState: "idle",
  capture: "off",
  playing: null,
  awaitingSpeech: null,
  activeTurn: null,
  queuedTurn: null,
  voiceAnswer: null,
  messages: [],
  history: [],
  historyLoaded: false,
  confirms: [],
  lastResolved: null,
  cancelled: [],
  notice: null,
  services: [],
  voices: { status: "idle", requestId: null, defaultVoice: null, voices: [] },
  voicePreview: null,
};

// ---------------------------------------------------------------------------
// Phase derivation

/** The confirmation shown on screen (the oldest pending one). */
export function currentConfirm(s: AssistantState): PendingConfirm | null {
  return s.confirms[0] ?? null;
}

export function derivePhase(s: AssistantState): Phase {
  // Holding the talk button always reads as listening, even while a confirm is
  // pending — that is how the user answers it by voice.
  if (s.capture === "starting" || s.capture === "recording") return "listening";
  if (s.confirms.length > 0 || s.serverState === "awaiting_confirm") return "awaiting_confirm";
  if (s.playing) return "speaking";
  if (
    s.serverState === "thinking" ||
    s.activeTurn !== null ||
    s.queuedTurn !== null ||
    s.voiceAnswer !== null ||
    s.awaitingSpeech !== null ||
    s.capture === "sending"
  ) {
    return "thinking";
  }
  return "idle";
}

/**
 * The turn a barge-in has to cancel, or null. Nothing is cancelled while a
 * confirm is pending: the user is about to answer it by voice, and cancelling
 * would throw the paused turn away.
 */
export function bargeInTarget(s: AssistantState): string | null {
  // serverState covers the gap between `state: awaiting_confirm` and its
  // `confirm_request` frame.
  if (s.confirms.length > 0 || s.serverState === "awaiting_confirm") return null;
  return s.playing ?? s.awaitingSpeech ?? s.activeTurn?.id ?? s.queuedTurn ?? null;
}

/**
 * Whether the "Durdur" button has something to stop (`controller.stop()` is a
 * barge-in without listening). Hidden while recording, and while a confirm is
 * pending: stop() never cancels the paused turn — the confirm is answered with
 * its own buttons or by voice.
 */
export function canStop(s: AssistantState): boolean {
  if (s.capture === "starting" || s.capture === "recording") return false;
  return bargeInTarget(s) !== null;
}

/**
 * A voice sample may be played: nothing of a turn is in flight (a sample would
 * otherwise become the barge-in target instead of the turn), no confirm is
 * pending and the mic is off. A reply that is only being spoken is fine; the
 * sample replaces it.
 */
export function canPreviewVoice(s: AssistantState): boolean {
  return (
    s.connection.status === "connected" &&
    s.capture === "off" &&
    !confirmPending(s) &&
    s.serverState === "idle" &&
    s.activeTurn === null &&
    s.queuedTurn === null &&
    s.voiceAnswer === null
  );
}

/** A confirmation is pending (an utterance now is a possible voice answer). */
export function confirmPending(s: AssistantState): boolean {
  return s.confirms.length > 0 || s.serverState === "awaiting_confirm";
}

export function isCancelled(s: AssistantState, turnId: string): boolean {
  return s.cancelled.includes(turnId);
}

/** Should an incoming `speech` clip be played? */
export function shouldPlaySpeech(s: AssistantState, turnId: string): boolean {
  return s.awaitingSpeech === turnId && !isCancelled(s, turnId);
}

// ---------------------------------------------------------------------------
// Helpers

const keyOf = (turnId: string, role: ChatMessage["role"]) => `${turnId}:${role}`;

function upsertMessage(
  messages: ChatMessage[],
  turnId: string,
  role: ChatMessage["role"],
  update: (m: ChatMessage) => ChatMessage,
): ChatMessage[] {
  const key = keyOf(turnId, role);
  const i = messages.findIndex((m) => m.key === key);
  if (i >= 0) {
    const next = messages.slice();
    next[i] = update(messages[i]);
    return next;
  }
  const created = update({ key, turnId, role, text: "", pending: true, tools: [] });
  return [...messages, created].slice(-MAX_MESSAGES);
}

/**
 * Server activity for `turnId`: marks the active turn as seen. A frame for a
 * pending voice answer means the Core started a real turn from it (the confirm
 * had already gone, e.g. by timeout), so it becomes the active turn.
 */
function touchTurn(s: AssistantState, turnId: string): Pick<AssistantState, "activeTurn" | "voiceAnswer"> {
  if (s.voiceAnswer === turnId) return { activeTurn: { id: turnId, seen: true }, voiceAnswer: null };
  const activeTurn = s.activeTurn && s.activeTurn.id === turnId ? { ...s.activeTurn, seen: true } : s.activeTurn;
  return { activeTurn, voiceAnswer: s.voiceAnswer };
}

/** Marks the messages of a turn that never reached the Core as failed. */
function failTurn(messages: ChatMessage[], turnId: string): ChatMessage[] {
  return messages.map((m) => (m.turnId === turnId ? { ...m, pending: false, failed: true } : m));
}

/** A new user turn: active at once, or held back by the controller (queued). */
function startTurn(s: AssistantState, id: string, queued?: boolean): Pick<AssistantState, "activeTurn" | "queuedTurn"> {
  return queued ? { activeTurn: s.activeTurn, queuedTurn: id } : { activeTurn: { id, seen: false }, queuedTurn: s.queuedTurn };
}

// ---------------------------------------------------------------------------
// Reducer

export function reducer(s: AssistantState, a: Action): AssistantState {
  switch (a.type) {
    case "status": {
      const next = { ...s, connection: a.ev };
      // 4400 arrives right after an id-less `error bad_request`; the
      // "incompatible" banner says it all, so that notice is dropped.
      if (a.ev.status === "incompatible" && s.notice && !s.notice.turnId) next.notice = null;
      if (a.ev.status === "connected") return { ...next, notice: s.notice?.code === "connection" ? null : s.notice };
      // Anything in flight on the server died with the socket; a queued turn
      // was never sent.
      const messages = s.queuedTurn ? failTurn(s.messages, s.queuedTurn) : s.messages;
      return {
        ...next,
        voices: s.voices.status === "loading" ? initialState.voices : s.voices,
        serverState: "idle",
        activeTurn: null,
        queuedTurn: null,
        voiceAnswer: null,
        awaitingSpeech: null,
        confirms: [],
        messages: messages.map((m) => (m.pending ? { ...m, pending: false, failed: m.role === "user" && !m.text } : m)),
      };
    }

    case "user_text_sent":
      return {
        ...s,
        ...startTurn(s, a.id, a.queued),
        messages: upsertMessage(s.messages, a.id, "user", (m) => ({ ...m, text: a.text, pending: false })),
        notice: null,
      };

    case "audio_sent": {
      // While a confirm is pending the utterance is first a possible voice
      // answer: it must not replace the paused turn as the active one.
      const turn = confirmPending(s) && !a.queued ? { voiceAnswer: a.id } : startTurn(s, a.id, a.queued);
      return {
        ...s,
        ...turn,
        capture: "off",
        messages: upsertMessage(s.messages, a.id, "user", (m) => ({ ...m, pending: true })),
        notice: null,
      };
    }

    case "queued_turn_sent":
      return s.queuedTurn === a.id ? { ...s, queuedTurn: null, activeTurn: { id: a.id, seen: false } } : s;

    case "queued_turn_dropped":
      return s.queuedTurn === a.id ? { ...s, queuedTurn: null, messages: failTurn(s.messages, a.id) } : s;

    case "capture":
      return { ...s, capture: a.state };

    case "speech_requested":
      return { ...s, awaitingSpeech: a.id };

    case "playback_started":
      return { ...s, playing: a.id, awaitingSpeech: s.awaitingSpeech === a.id ? null : s.awaitingSpeech };

    case "playback_ended":
      return s.playing === a.id ? { ...s, playing: null } : s;

    case "speech_stopped":
      return { ...s, playing: null, awaitingSpeech: null };

    case "barge_in":
      return {
        ...s,
        playing: s.playing === a.turnId ? null : s.playing,
        awaitingSpeech: s.awaitingSpeech === a.turnId ? null : s.awaitingSpeech,
        activeTurn: s.activeTurn?.id === a.turnId ? null : s.activeTurn,
        queuedTurn: s.queuedTurn === a.turnId ? null : s.queuedTurn,
        cancelled: [...s.cancelled.filter((id) => id !== a.turnId), a.turnId].slice(-MAX_CANCELLED),
        messages: s.messages.map((m) =>
          m.turnId === a.turnId && ((m.role === "assistant" && m.pending) || s.queuedTurn === a.turnId)
            ? { ...m, pending: false, cancelled: true }
            : m,
        ),
      };

    case "confirm_sent":
      return {
        ...s,
        confirms: s.confirms.map((c) => (c.requestId === a.requestId ? { ...c, responding: true } : c)),
      };

    case "notice":
      return { ...s, notice: a.notice };

    case "dismiss_notice":
      return { ...s, notice: null };

    case "reset_conversation":
      return { ...s, messages: [], cancelled: [] };

    case "voices_requested":
      return { ...s, voices: { ...s.voices, status: "loading", requestId: a.id } };

    case "voices_timeout":
      return s.voices.status === "loading" && s.voices.requestId === a.id
        ? { ...s, voices: { ...s.voices, status: "unavailable" } }
        : s;

    case "voice_preview_requested":
      return { ...s, voicePreview: { id: a.id, failed: false }, awaitingSpeech: a.id };

    case "server":
      return reduceServer(s, a.msg);
  }
}

function reduceServer(s: AssistantState, msg: ServerMessage): AssistantState {
  switch (msg.type) {
    case "welcome":
      return {
        ...s,
        sessionId: msg.sessionId,
        serverState: "idle",
        activeTurn: null,
        queuedTurn: null,
        voiceAnswer: null,
        awaitingSpeech: null,
        confirms: [],
        // A (possibly different) Core sends its own list right after welcome.
        services: [],
        // Its voices may differ too; the settings panel asks again.
        voices: initialState.voices,
        voicePreview: null,
      };

    case "state": {
      let activeTurn = s.activeTurn;
      if (msg.state !== "idle" && activeTurn) activeTurn = { ...activeTurn, seen: true };
      if (msg.state === "idle" && activeTurn?.seen) activeTurn = null;
      // A turn starting while nothing else runs and no confirm is left can only
      // be the pending voice answer, which the Core took as a new request
      // (its confirm had already gone). Own it now so it can be cancelled.
      let voiceAnswer = s.voiceAnswer;
      if (msg.state === "thinking" && !activeTurn && voiceAnswer && s.confirms.length === 0) {
        activeTurn = { id: voiceAnswer, seen: true };
        voiceAnswer = null;
      }
      // awaiting_confirm without its confirm_request yet still shows the phase;
      // leaving it clears a card the Core no longer waits for.
      const confirms = msg.state === "idle" ? [] : s.confirms;
      return { ...s, serverState: msg.state, activeTurn, voiceAnswer, confirms };
    }

    case "transcript":
      return {
        ...s,
        // A transcript alone does not promote a voice answer: the Core may
        // still apply it to the confirm (then `confirm_resolved` follows).
        activeTurn: s.voiceAnswer === msg.id ? s.activeTurn : touchTurn(s, msg.id).activeTurn,
        messages: upsertMessage(s.messages, msg.id, "user", (m) => ({ ...m, text: msg.text, pending: false, failed: false })),
      };

    case "assistant_delta":
      if (isCancelled(s, msg.id)) return s;
      return {
        ...s,
        ...touchTurn(s, msg.id),
        messages: upsertMessage(s.messages, msg.id, "assistant", (m) => ({ ...m, text: m.text + msg.text, pending: true })),
      };

    case "assistant_done":
      if (isCancelled(s, msg.id)) return s;
      return {
        ...s,
        ...touchTurn(s, msg.id),
        messages: upsertMessage(s.messages, msg.id, "assistant", (m) => ({ ...m, text: msg.text, pending: false })),
      };

    case "tool":
      if (isCancelled(s, msg.id)) return s;
      return {
        ...s,
        ...touchTurn(s, msg.id),
        messages: upsertMessage(s.messages, msg.id, "assistant", (m) => {
          const tools = m.tools.filter((t) => t.name !== msg.name);
          return { ...m, tools: [...tools, { name: msg.name, status: msg.status }] };
        }),
      };

    case "confirm_request":
      // Raced with our cancel: the Core denies it itself (confirm_resolved).
      if (isCancelled(s, msg.id)) return s;
      return {
        ...s,
        ...touchTurn(s, msg.id),
        confirms: [
          ...s.confirms.filter((c) => c.requestId !== msg.requestId),
          {
            requestId: msg.requestId,
            turnId: msg.id,
            tool: msg.tool,
            summary: msg.summary,
            expiresAt: msg.expiresAt,
            responding: false,
          },
        ],
      };

    case "confirm_resolved":
      // Only report requests that were shown (not ones dropped above).
      if (!s.confirms.some((c) => c.requestId === msg.requestId)) {
        return msg.by === "voice" ? { ...s, voiceAnswer: null } : s;
      }
      return {
        ...s,
        confirms: s.confirms.filter((c) => c.requestId !== msg.requestId),
        // A voice resolution consumed the pending voice answer.
        voiceAnswer: msg.by === "voice" ? null : s.voiceAnswer,
        lastResolved: { requestId: msg.requestId, approved: msg.approved, by: msg.by },
      };

    case "speech":
      // Playback itself is a side effect (controller); nothing to store here.
      return s;

    case "history":
      return { ...s, history: msg.items, historyLoaded: true };

    case "error": {
      // Errors of the voice picker stay in the picker, not in the chat.
      if (msg.id !== undefined && msg.id === s.voices.requestId) {
        return s.voices.status === "loading" ? { ...s, voices: { ...s.voices, status: "unavailable" } } : s;
      }
      if (msg.id !== undefined && msg.id === s.voicePreview?.id) {
        return {
          ...s,
          voicePreview: { id: msg.id, failed: true },
          awaitingSpeech: s.awaitingSpeech === msg.id ? null : s.awaitingSpeech,
        };
      }
      if (msg.code === "unauthorized") return { ...s, notice: { code: msg.code, message: msg.message } };
      const id = msg.id;
      // `busy` for a voice answer: it was not a yes/no and the paused turn is
      // still running, so the confirm still needs an answer.
      const code = id && id === s.voiceAnswer && msg.code === "busy" ? "not_an_answer" : msg.code;
      const next: AssistantState = { ...s, notice: { code, message: msg.message, turnId: id } };
      if (!id) return next;
      return {
        ...next,
        voiceAnswer: s.voiceAnswer === id ? null : s.voiceAnswer,
        activeTurn: s.activeTurn?.id === id ? null : s.activeTurn,
        awaitingSpeech: s.awaitingSpeech === id ? null : s.awaitingSpeech,
        messages: s.messages.map((m) =>
          m.turnId === id && m.pending ? { ...m, pending: false, failed: m.role === "user" ? !m.text : true } : m,
        ),
      };
    }

    case "services":
      return { ...s, services: msg.items };

    case "voices":
      // Only the answer to the latest request; it still counts after the
      // local timeout (a slow tts-svc), but never replaces a ready list.
      if (msg.id !== s.voices.requestId || s.voices.status === "ready") return s;
      return { ...s, voices: { status: "ready", requestId: msg.id, defaultVoice: msg.default, voices: msg.voices } };

    case "pong":
      return s;
  }
}
