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
  CoreFeature,
  DevAction,
  DevItem,
  HistoryItem,
  MemoryMessage,
  NotificationAction,
  NotificationInfo,
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
  /** `usage_limit`: when the limit resets (epoch ms), if the Core knows it. */
  retryAt?: number;
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

/** The memory contents as the Core last sent them (`memory` frame without type/id). */
export type MemoryContents = Pick<MemoryMessage, "brief" | "topics" | "warnings">;

/**
 * The memory settings panel (Core feature `memory`). One request at a time:
 * `memory_list` (refresh) or `memory_delete` (`deleting` = its entry id).
 * `error` keeps the last contents; `errorCode` is the Core error code or
 * `timeout` / `connection` (local). Closing the panel abandons the request
 * in flight (`memory_closed`): its late answer or error changes nothing.
 */
export type MemoryView = {
  status: "idle" | "loading" | "ready" | "error";
  /** Id of the request in flight (or last answered). */
  requestId: string | null;
  deleting: string | null;
  contents: MemoryContents | null;
  errorCode: string | null;
  errorMessage: string | null;
  /**
   * Earlier request ids replaced by a newer one or abandoned by closing the
   * panel. A late error for one of them is dropped instead of becoming a
   * chat notice (as `DevView.staleIds`).
   */
  staleIds: string[];
};

/**
 * The Development panel (Core feature `dev`). One request at a time:
 * `dev_list` (refresh) or `dev_action` (`acting` = its item and action).
 * `error` keeps the last items; `errorCode` is the Core error code or
 * `timeout` / `connection` (local). `open` is the badge count, null until the
 * Core told one (a `dev` answer or a `dev_count` broadcast).
 */
export type DevView = {
  status: "idle" | "loading" | "ready" | "error";
  /** Id of the request in flight (or last answered). */
  requestId: string | null;
  acting: { itemId: string; action: DevAction } | null;
  items: DevItem[] | null;
  open: number | null;
  /** This device may use `add_rule` / `remove_rule` (from the last `dev` answer; false until then). */
  canManage: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  /**
   * Earlier request ids replaced by a newer one (e.g. "Yenile" after a
   * timeout). A late error for one of them is dropped instead of becoming a
   * chat notice.
   */
  staleIds: string[];
};

/**
 * The notification inbox (Core feature `notifications`). Same request model
 * as the Development panel: one `notifications_list` / `notification_action`
 * at a time (`acting` = its item and action), `error` keeps the last items.
 * `items` is the whole inbox (most recently updated first) once a list
 * arrived; the `notification` / `notification_removed` broadcasts keep it
 * current. `unread` is the badge count, null until the Core told one.
 * `unavailable`: the Core answered the latest request with
 * `notifications_unavailable` (it cannot read its notifications file): the
 * inbox is unknown, not empty; cleared by the next `notifications` reply.
 */
export type NotificationsView = {
  status: "idle" | "loading" | "ready" | "error";
  requestId: string | null;
  acting: { notificationId: string; action: NotificationAction } | null;
  items: NotificationInfo[] | null;
  unread: number | null;
  unavailable: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  /** Replaced request ids whose late errors are dropped (as `DevView.staleIds`). */
  staleIds: string[];
};

/** A "Dene" voice sample: a `speak` that belongs to no turn. */
export type VoicePreview = { id: string; failed: boolean };

export type AssistantState = {
  connection: StatusEvent;
  sessionId: string | null;
  /** `welcome.features` of the connected Core (empty for an older Core). */
  features: string[];
  serverState: ServerState;
  capture: CaptureState;
  /**
   * Turn whose reply is playing (speaking phase). With streamed speech it is
   * set from the first `speech_chunk` until the turn's queue has drained
   * after its `final` chunk.
   */
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
  memory: MemoryView;
  dev: DevView;
  notifications: NotificationsView;
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
  | { type: "voice_preview_requested"; id: string }
  | { type: "memory_requested"; id: string; entryId?: string }
  | { type: "memory_timeout"; id: string }
  | { type: "memory_closed" }
  | { type: "dev_requested"; id: string; acting?: { itemId: string; action: DevAction } }
  | { type: "dev_timeout"; id: string }
  | { type: "notifications_requested"; id: string; acting?: { notificationId: string; action: NotificationAction } }
  | { type: "notifications_timeout"; id: string };

export const MAX_MESSAGES = 100;
const MAX_CANCELLED = 20;
const MAX_STALE_MEMORY = 8;
const MAX_STALE_DEV = 8;
const MAX_STALE_NOTIFICATIONS = 8;

export const initialState: AssistantState = {
  connection: { status: "closed", attempt: 0 },
  sessionId: null,
  features: [],
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
  memory: { status: "idle", requestId: null, deleting: null, contents: null, errorCode: null, errorMessage: null, staleIds: [] },
  dev: {
    status: "idle",
    requestId: null,
    acting: null,
    items: null,
    open: null,
    canManage: false,
    errorCode: null,
    errorMessage: null,
    staleIds: [],
  },
  notifications: {
    status: "idle",
    requestId: null,
    acting: null,
    items: null,
    unread: null,
    unavailable: false,
    errorCode: null,
    errorMessage: null,
    staleIds: [],
  },
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

/** The connected Core advertised `feature` in its `welcome`. */
export function hasFeature(s: AssistantState, feature: CoreFeature): boolean {
  return s.features.includes(feature);
}

/** The memory panel may be offered: connected to a Core with the `memory` feature. */
export function memoryAvailable(s: AssistantState): boolean {
  return s.connection.status === "connected" && hasFeature(s, "memory");
}

/** The Development panel and badge may be offered: connected to a Core with the `dev` feature. */
export function devAvailable(s: AssistantState): boolean {
  return s.connection.status === "connected" && hasFeature(s, "dev");
}

/** The Development badge count (0 = no badge): only while the panel is available. */
export function devBadgeCount(s: AssistantState): number {
  return devAvailable(s) ? (s.dev.open ?? 0) : 0;
}

/**
 * The actions offered for an item, per the docs/08 action table: a rule
 * candidate or a suspended rule can be added / re-opened (only when this
 * device may: `canManage`) or ignored, an active rule removed (`canManage`
 * only), an open note fixed or ignored. Ignored / fixed notes and unknown
 * statuses get none.
 */
export function devItemActions(item: DevItem, canManage: boolean): DevAction[] {
  if (item.type === "rule") {
    if (item.status === "candidate" || item.status === "suspended") return canManage ? ["add_rule", "ignore"] : ["ignore"];
    return item.status === "active" && canManage ? ["remove_rule"] : [];
  }
  return item.status === "open" ? ["fixed", "ignore"] : [];
}

/** The inbox and its badge may be offered: connected to a Core with the `notifications` feature. */
export function notificationsAvailable(s: AssistantState): boolean {
  return s.connection.status === "connected" && hasFeature(s, "notifications");
}

/** "Tekrar gösterme" (`suppress`) may be offered: the inbox is available and the Core has `notifications_suppress`. */
export function notificationsSuppressAvailable(s: AssistantState): boolean {
  return notificationsAvailable(s) && hasFeature(s, "notifications_suppress");
}

/** The inbox badge count (0 = no count): only while the inbox is available. */
export function notificationsBadgeCount(s: AssistantState): number {
  return notificationsAvailable(s) ? (s.notifications.unread ?? 0) : 0;
}

/** The Core could not read its notifications file (badge "!", panel "Bildirimler okunamadı"): only while the inbox is available. */
export function notificationsUnavailable(s: AssistantState): boolean {
  return notificationsAvailable(s) && s.notifications.unavailable;
}

/** The action that toggles an item: `read` while unread, `unread` once read. */
export function notificationToggleAction(item: NotificationInfo): "read" | "unread" {
  return item.readAt === null ? "read" : "unread";
}

/** Inbox order (as the Core lists it): most recently updated first, then by id. */
function byUpdated(a: NotificationInfo, b: NotificationInfo): number {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Applies a `notification` broadcast (new or changed item) to the loaded
 * inbox. Before the first list the item is not stored: that list is computed
 * after the change (frames on one socket keep their order), so it holds the
 * item. The badge moves by the item's own unread change.
 */
function upsertNotification(n: NotificationsView, item: NotificationInfo): NotificationsView {
  if (n.items === null) return n;
  const old = n.items.find((i) => i.id === item.id);
  const delta = (item.readAt === null ? 1 : 0) - (old && old.readAt === null ? 1 : 0);
  const items = [...n.items.filter((i) => i.id !== item.id), item].sort(byUpdated);
  return { ...n, items, unread: n.unread === null ? null : Math.max(0, n.unread + delta) };
}

/** Applies a `notification_removed` broadcast. */
function removeNotification(n: NotificationsView, id: string): NotificationsView {
  if (n.items === null) return n;
  const old = n.items.find((i) => i.id === id);
  if (!old) return n;
  const unread = n.unread === null ? null : Math.max(0, n.unread - (old.readAt === null ? 1 : 0));
  return { ...n, items: n.items.filter((i) => i.id !== id), unread };
}

/** A failed or unanswered inbox request (keeps the shown items). Only the Core's `notifications_unavailable` sets `unavailable`. */
function notificationsFailed(n: NotificationsView, code: string, message?: string): NotificationsView {
  return {
    ...n,
    status: "error",
    acting: null,
    unavailable: n.unavailable || code === "notifications_unavailable",
    errorCode: code,
    errorMessage: message ?? null,
  };
}

/** A failed or unanswered Development request (keeps the shown items). */
function devFailed(d: DevView, code: string, message?: string): DevView {
  return { ...d, status: "error", acting: null, errorCode: code, errorMessage: message ?? null };
}

/** A failed or unanswered memory request (keeps the shown contents). */
function memoryFailed(m: MemoryView, code: string, message?: string): MemoryView {
  return { ...m, status: "error", deleting: null, errorCode: code, errorMessage: message ?? null };
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
        // Its answer can no longer arrive.
        memory: s.memory.status === "loading" ? memoryFailed(s.memory, "connection") : s.memory,
        dev: s.dev.status === "loading" ? devFailed(s.dev, "connection") : s.dev,
        notifications: s.notifications.status === "loading" ? notificationsFailed(s.notifications, "connection") : s.notifications,
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

    case "memory_requested": {
      const prev = s.memory.requestId;
      const staleIds = prev && prev !== a.id ? [...s.memory.staleIds, prev].slice(-MAX_STALE_MEMORY) : s.memory.staleIds;
      return {
        ...s,
        memory: { ...s.memory, status: "loading", requestId: a.id, deleting: a.entryId ?? null, errorCode: null, errorMessage: null, staleIds },
      };
    }

    case "memory_timeout":
      return s.memory.status === "loading" && s.memory.requestId === a.id
        ? { ...s, memory: memoryFailed(s.memory, "timeout") }
        : s;

    case "memory_closed": {
      // The panel was closed: the request in flight (or its late answer after
      // a timeout) no longer belongs to anything shown. A delete already sent
      // cannot be taken back (no frame for it); the next open lists anew.
      const m = s.memory;
      if (m.requestId === null) return s;
      return {
        ...s,
        memory: {
          ...m,
          status: m.contents ? "ready" : "idle",
          requestId: null,
          deleting: null,
          errorCode: null,
          errorMessage: null,
          staleIds: [...m.staleIds, m.requestId].slice(-MAX_STALE_MEMORY),
        },
      };
    }

    case "dev_requested": {
      const prev = s.dev.requestId;
      const staleIds = prev && prev !== a.id ? [...s.dev.staleIds, prev].slice(-MAX_STALE_DEV) : s.dev.staleIds;
      return {
        ...s,
        dev: { ...s.dev, status: "loading", requestId: a.id, acting: a.acting ?? null, errorCode: null, errorMessage: null, staleIds },
      };
    }

    case "dev_timeout":
      return s.dev.status === "loading" && s.dev.requestId === a.id ? { ...s, dev: devFailed(s.dev, "timeout") } : s;

    case "notifications_requested": {
      const n = s.notifications;
      const prev = n.requestId;
      const staleIds = prev && prev !== a.id ? [...n.staleIds, prev].slice(-MAX_STALE_NOTIFICATIONS) : n.staleIds;
      return {
        ...s,
        notifications: { ...n, status: "loading", requestId: a.id, acting: a.acting ?? null, errorCode: null, errorMessage: null, staleIds },
      };
    }

    case "notifications_timeout":
      return s.notifications.status === "loading" && s.notifications.requestId === a.id
        ? { ...s, notifications: notificationsFailed(s.notifications, "timeout") }
        : s;

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
        features: msg.features ?? [],
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
        // Another Core may have other (or no) memory; the panel asks again.
        memory: initialState.memory,
        // Same for the Development items and the badge (the controller asks again).
        dev: initialState.dev,
        // And the inbox (the controller asks again, also for the phone catch-up).
        notifications: initialState.notifications,
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
    case "speech_chunk":
      // Playback itself is a side effect (controller); nothing to store here.
      return s;

    case "memory":
      // Only the answer to the latest request of the open panel; it still
      // counts after the local timeout (a slow Core). Closing the panel or a
      // newer request makes it stale.
      if (s.memory.requestId === null || msg.id !== s.memory.requestId) return s;
      return {
        ...s,
        memory: {
          status: "ready",
          requestId: msg.id,
          deleting: null,
          contents: { brief: msg.brief, topics: msg.topics, warnings: msg.warnings },
          errorCode: null,
          errorMessage: null,
          staleIds: s.memory.staleIds,
        },
      };

    case "history":
      return { ...s, history: msg.items, historyLoaded: true };

    case "error": {
      // Errors of the voice picker stay in the picker, not in the chat.
      if (msg.id !== undefined && msg.id === s.voices.requestId) {
        return s.voices.status === "loading" ? { ...s, voices: { ...s.voices, status: "unavailable" } } : s;
      }
      // Errors of the memory panel stay in the panel.
      if (msg.id !== undefined && msg.id === s.memory.requestId) {
        return s.memory.status === "loading" ? { ...s, memory: memoryFailed(s.memory, msg.code, msg.message) } : s;
      }
      if (msg.id !== undefined && s.memory.staleIds.includes(msg.id)) return s;
      // So do errors of the Development panel (unknown_item, not_allowed, …).
      if (msg.id !== undefined && msg.id === s.dev.requestId) {
        return s.dev.status === "loading" ? { ...s, dev: devFailed(s.dev, msg.code, msg.message) } : s;
      }
      if (msg.id !== undefined && s.dev.staleIds.includes(msg.id)) return s;
      // And errors of the inbox. An action on an item that is no longer listed
      // (another device deleted it and its `notification_removed` came first)
      // answers `unknown_item`: the wanted outcome, not an error.
      if (msg.id !== undefined && msg.id === s.notifications.requestId) {
        const n = s.notifications;
        if (n.status !== "loading") return s;
        const target = n.acting?.notificationId;
        const gone = msg.code === "unknown_item" && target !== undefined && !n.items?.some((i) => i.id === target);
        return { ...s, notifications: gone ? { ...n, status: "ready", acting: null } : notificationsFailed(n, msg.code, msg.message) };
      }
      if (msg.id !== undefined && s.notifications.staleIds.includes(msg.id)) return s;
      if (msg.id !== undefined && msg.id === s.voicePreview?.id) {
        return {
          ...s,
          voicePreview: { id: msg.id, failed: true },
          awaitingSpeech: s.awaitingSpeech === msg.id ? null : s.awaitingSpeech,
        };
      }
      if (msg.code === "unauthorized") return { ...s, notice: { code: msg.code, message: msg.message } };
      const id = msg.id;
      // With streamed speech a synthesis failure can arrive while the turn is
      // still running (the text answer goes on, a `final` chunk follows): it
      // must not end or fail the turn. Before streaming it only ever answered
      // a `speak`, after the turn.
      if (msg.code === "tts_unavailable") {
        return {
          ...s,
          notice: { code: msg.code, message: msg.message, turnId: id },
          awaitingSpeech: id !== undefined && s.awaitingSpeech === id ? null : s.awaitingSpeech,
        };
      }
      // `busy` for a voice answer: it was not a yes/no and the paused turn is
      // still running, so the confirm still needs an answer.
      const code = id && id === s.voiceAnswer && msg.code === "busy" ? "not_an_answer" : msg.code;
      const notice: Notice = { code, message: msg.message, turnId: id };
      if (msg.code === "usage_limit" && msg.retryAt !== undefined) notice.retryAt = msg.retryAt;
      const next: AssistantState = { ...s, notice };
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

    case "dev":
      // Only the answer to the latest request (as with memory); it still
      // counts after the local timeout.
      if (msg.id !== s.dev.requestId) return s;
      return {
        ...s,
        dev: {
          status: "ready",
          requestId: msg.id,
          acting: null,
          items: msg.items,
          open: msg.open,
          canManage: msg.canManage,
          errorCode: null,
          errorMessage: null,
          staleIds: s.dev.staleIds,
        },
      };

    case "dev_count":
      // Badge only; the list is refreshed when the panel opens (or "Yenile").
      return msg.open === s.dev.open ? s : { ...s, dev: { ...s.dev, open: msg.open } };

    case "notifications":
      // Only the answer to the latest request (as with dev); it still counts
      // after the local timeout.
      if (msg.id !== s.notifications.requestId) return s;
      return {
        ...s,
        notifications: {
          status: "ready",
          requestId: msg.id,
          acting: null,
          items: msg.items,
          unread: msg.unread,
          unavailable: false,
          errorCode: null,
          errorMessage: null,
          staleIds: s.notifications.staleIds,
        },
      };

    case "notification":
      return { ...s, notifications: upsertNotification(s.notifications, msg.item) };

    case "notification_removed":
      return { ...s, notifications: removeNotification(s.notifications, msg.notificationId) };
  }
}
