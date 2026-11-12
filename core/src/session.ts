/**
 * One authenticated WebSocket session: turn handling, permission gate wiring,
 * confirm flow (button / voice / timeout), speech and history.
 *
 * Transport-agnostic: frames come in through `handle()` and go out through
 * the `send` callback, so the whole flow is unit-testable without sockets.
 */
import { createHash } from "node:crypto";
// Type-only: agent.ts loads the provider SDK, which session.ts must never do.
import type { AgentRunner, TurnResult } from "./agent.js";
import type { ConversationLog, SessionLog } from "./conversation-log.js";
import {
  classifyToolError,
  toolNoteKey,
  turnNoteKey,
  type DevNotes,
  type NoteStatus,
  type TurnNoteInput,
  type TurnNotes,
} from "./dev-notes.js";
import type { DeviceRegistry } from "./device-registry.js";
import { runDirectPlan, type DenyReason, type DirectOutcome, type GatedCall } from "./direct.js";
import { checkTurn, extractPattern, type LearnPolicy, type ObservedCall } from "./learn/extract.js";
import type { LearnedRuleRecord, LearnedRuleStore } from "./learn/store.js";
import { parseLiveContext } from "./live-context.js";
import type { DirectToolClient } from "./mcp-direct.js";
import type { DeviceMaintenance } from "./memory/lifecycle.js";
import { renderMemoryBlock, selectRelevant, SentEntries } from "./memory/match.js";
import type { MemorySnapshot, MemoryStore } from "./memory/store.js";
import { isEntryId, MEMORY_BUDGETS, type MemoryEntry } from "./memory/types.js";
import {
  SessionBusyError,
  SessionClosedError,
  type AttemptHandle,
  type AttemptOutcome,
  type PermissionCallback,
  type PermissionDecision,
  type ProviderSession,
} from "./model-provider.js";
import {
  ConfirmBroker,
  parseVoiceAnswer,
  summarizeToolCall,
  type ConfirmRequest,
  type ConfirmResolution,
  type PermissionPolicy,
} from "./permissions.js";
import {
  inQuietHours,
  NotificationsUnavailableError,
  type NotificationItem,
  type NotificationStore,
  type QuietHours,
  type RaiseInput,
  type RaiseResult,
} from "./notifications.js";
import type {
  ClientFrame,
  DevAction,
  DevItem,
  ErrorCode,
  MemoryFrame,
  NotificationAction,
  NotificationInfo,
  ServerFrame,
  SpeechMode,
} from "./protocol.js";
import { LEARNABLE_SERVICE, LIVE_CONTEXT_TOOL, type DirectPlan } from "./router-config.js";
import { ESCALATION_MARKER, type ModelTier, type RouteDecision, type Router, type UsageOutcome, type UsageRecord } from "./router.js";
import type { PermissionLevel } from "./services.js";
import { EMPTY_LEXICON, type Lexicon } from "./pronunciation.js";
import { clipForTts, describeVoice, SpeechServiceError, type SttClient, type TtsClient } from "./speech.js";
import { SpeechStream } from "./speech-stream.js";
import { buildTurnEnvelope, ESCALATION_CONTINUE, wrapDirectNotes } from "./turn-envelope.js";

/** whisper-svc rejects > 25 MB; refuse earlier than that. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const DEFAULT_HISTORY_LIMIT = 20;
export const MAX_HISTORY_LIMIT = 100;
/** Tier-0 exchanges remembered for the model's next turn. */
export const MAX_DIRECT_NOTES = 5;

/** A tier-0 exchange not yet shown to the model; `seq` is its creation order. */
interface DirectNote {
  seq: number;
  text: string;
}

/** Gated calls kept per model turn for learning; a turn with more is never learned from (one action is the limit anyway). */
export const MAX_OBSERVED_CALLS = 8;

/**
 * Learned-rule fallbacks that count toward suspension (docs/08 §Lifecycle):
 * the rule's own failures. Anything else (no client, service disabled,
 * denial, cancel, unreachable service) is neutral.
 */
const LEARNED_FAILURES: ReadonlySet<string> = new Set([
  "name_not_found",
  "name_ambiguous",
  "target_refused",
  "tool_error",
  "live_context_error",
  "live_context_unparseable",
  "no_name",
  "no_brightness",
]);

/** Model tool calls in one turn from which it counts as `wandering` (docs/08 §T7.w.3). */
export const DEFAULT_WANDER_CALLS = 5;
/** Distinct tool names kept per turn for the `wandering` note (the note keeps at most 5). */
const MAX_TURN_TOOL_NAMES = 16;

/** close() waits at most this long for turn tails (usage at `settled`, timing, speech) before session_end. */
export const TAIL_WAIT_MS = 3_000;

const LEVEL_RANK: Record<PermissionLevel, number> = { read: 0, write: 1, confirm: 2 };

/** What the model is told when the gate denies one of its tool calls. */
const DENY_MESSAGES: Record<GateDeny, string> = {
  tier_service: "This tool is not available in this mode.",
  cancelled: "Turn was cancelled.",
  builtin: "Built-in tools are disabled for this assistant.",
  read_only: "Read-only mode: only read tools may run.",
  timeout: "The user did not confirm in time; do not retry.",
  declined: "The user declined this action; do not retry.",
};

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
}

/** What a session needs from the device registry (device-registry.ts). */
export type SessionRegistry = Pick<
  DeviceRegistry,
  "acquire" | "live" | "prewarm" | "beginTurn" | "endTurn" | "fallbackResume" | "turnEnded" | "capabilities"
> &
  // Memory and compaction (docs/06); optional so a registry without them still works.
  Partial<Pick<DeviceRegistry, "sentEntries" | "peekSeedNote" | "seedDelivered" | "isHeld" | "beginActivity" | "waitHold">>;

/** What a session needs from the memory store (docs/06); absent = CORE_MEMORY=off. */
export type SessionMemory = Pick<MemoryStore, "entries" | "snapshot" | "forget">;

/** Turn notifications for extraction triggers and compaction (memory/lifecycle.ts). */
export type SessionMaintenance = Pick<DeviceMaintenance, "turnStarted" | "turnEnded" | "modelTurnEnded">;

export interface SessionDeps {
  /** Legacy runner: a fresh query per turn (CORE_AGENT_PERSISTENT=off, and the fallback when a device session cannot start). */
  agent: AgentRunner;
  /** Persistent per-device sessions (docs/07 A1); absent = every turn on `agent`. */
  registry?: SessionRegistry;
  policy: PermissionPolicy;
  router: Router;
  stt: SttClient;
  tts: TtsClient;
  log: ConversationLog;
  logger: Logger;
  confirmTimeoutMs?: number;
  /** Tier 0 MCP client; without it every direct plan falls back to the model. */
  direct?: DirectToolClient;
  /**
   * MCP services per model tier (router.yaml `tierN.services`); absent = all.
   * Legacy runner: only these servers are loaded. Persistent mode: all are
   * loaded and the gate denies tools of other services.
   */
  tierServices?: Partial<Record<ModelTier, readonly string[]>>;
  /** pronunciations.yaml: applied to `speak` text sent to tts-svc only; absent = none. */
  pronunciations?: Lexicon;
  /** Memory store (CORE_MEMORY on): `<hafiza>` blocks and the `memory_list`/`memory_delete` frames. */
  memory?: SessionMemory;
  /** Extraction triggers and compaction; absent = none. */
  maintenance?: SessionMaintenance;
  /** Pattern learning (T7.w.2, docs/08); absent = nothing observed, learned outcomes not counted. */
  learning?: SessionLearning;
  /** Turn dev-notes (T7.w.3, `dev-notes/turns.json`); absent = none recorded. Never holds text, arguments or results. */
  turnNotes?: Pick<TurnNotes, "record">;
  /** Model tool calls per turn from which a `wandering` note is recorded; default DEFAULT_WANDER_CALLS. */
  wanderCalls?: number;
  /** The Development tab (T7.w.4, feature `dev`): `dev_list` / `dev_action`; absent = `bad_request`. */
  dev?: Pick<DevelopmentTab, "view" | "act" | "canManage">;
  /**
   * The notification inbox (T7.w.5, feature `notifications`): the session
   * attaches itself for the `notification` broadcasts, reports its turns (for
   * the urgent speaker), tells when it turns speech on (pending urgent
   * speech, T7.w.11.4) and answers `notifications_list` /
   * `notification_action`; absent = `bad_request`.
   */
  notifications?: Pick<NotificationCenter, "attach" | "turnStarted" | "speechOn" | "list" | "act">;
}

/** What a session needs for pattern learning. */
export interface SessionLearning {
  store: Pick<LearnedRuleStore, "observe" | "recordOutcome">;
  policy: LearnPolicy;
  /** router.yaml `learning.min_observations` (only for the "candidate" log line). */
  minObservations?: number;
}

/** The gated calls of one model turn, for the learner (arguments in memory for the turn only). */
interface TurnObservation {
  calls: ObservedCall[];
  byUseId: Map<string, ObservedCall>;
  /** More than MAX_OBSERVED_CALLS: never learned from. */
  overflow: boolean;
}

export interface SessionInfo {
  sessionId: string;
  device: string;
  client?: string;
  clientVersion?: string;
}

interface ActiveTurn {
  id: string;
  abort: AbortController;
  text: string;
  /** Turn start (frame received; for voice: transcript ready), epoch ms. */
  startedAt: number;
  /** First `assistant_delta` sent, epoch ms. */
  firstDeltaAt?: number;
  /** Sentence-by-sentence speech for a client that opted in (A2). */
  speech?: SpeechStream;
  /**
   * The model attempt ended cancelled without a user cancel (e.g. the device
   * session closed): like a cancel, nothing more is spoken.
   */
  cancelled?: boolean;
  /** Time the turn waited for a running compaction (docs/06), for the `timing` record. */
  waitedForCompactMs?: number;
  /** Set for a turn the learner may look at (`source: "default"`, learning on). */
  observed?: TurnObservation;
  /** Model tool calls that reached the Core gate in this turn (all attempts; `wandering`). */
  toolCalls: number;
  /** Their distinct tool names (service-relative), bounded by MAX_TURN_TOOL_NAMES. */
  toolNames: Set<string>;
  /** Tool use ids the gate allowed: only their `isError` results are `tool_error` notes (a denial is not an error). */
  allowedUseIds: Set<string>;
}

/** Latest `speech_prefs` of the client; absent = no `speech_chunk` frames. */
interface SpeechPrefs {
  mode: SpeechMode;
  voice?: string;
}

/** Messages the model gets for gate denials. */
type GateDeny = DenyReason | "tier_service";
/** The level the gate applied (`deny`: built-in tool). */
type GateLevel = PermissionLevel | "deny";

export class Session {
  private turn: ActiveTurn | null = null;
  /** SDK session id carried across turns so the model keeps the conversation context. */
  private sdkSessionId: string | undefined;
  private readonly broker: ConfirmBroker;
  private readonly slog: SessionLog;
  private readonly side = new AbortController();
  /** Audio utterances being transcribed, by turn id (so `cancel` can stop them). */
  private readonly transcribing = new Map<string, AbortController>();
  /** Settles when the running turn has finished (used by close()). */
  private turnDone: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private closed = false;
  /** Tier-0 exchanges not yet shown to the model. */
  private readonly directNotes: DirectNote[] = [];
  /** Sequence number of the next tier-0 note (keeps refused batches in creation order). */
  private noteSeq = 0;
  private speechPrefs: SpeechPrefs | undefined;
  /** Speech streams of turns still being spoken, by turn id (a late `cancel` stops them). */
  private readonly speaking = new Map<string, SpeechStream>();
  /** Work that finishes after a turn's visible end (usage at `settled`, timing); close() waits for it, bounded. */
  private readonly tails = new Set<Promise<unknown>>();
  /** Memory entries already sent in this socket's conversation, when no registry keeps them per device (legacy mode). */
  private readonly sentHere = new SentEntries();
  /** The "result not paired" learning note is logged once per session. */
  private unpairedLogged = false;
  /** This socket as the notification center sees it (undefined without the center). */
  private readonly notificationListener: NotificationListener | undefined;
  /** Stops the notification broadcasts to this socket (close()). */
  private readonly detachNotifications: (() => void) | undefined;

  constructor(
    private readonly deps: SessionDeps,
    readonly info: SessionInfo,
    private readonly send: (frame: ServerFrame) => void,
  ) {
    this.slog = deps.log.session(info.sessionId);
    this.broker = new ConfirmBroker(deps.confirmTimeoutMs, (req, res) => this.onConfirmResolved(req, res));
    void this.slog.append({
      kind: "session_start",
      device: info.device,
      client: info.client,
      clientVersion: info.clientVersion,
    });
    // Start the device's model session now, so the first turn finds it warm (07 §Prewarm).
    deps.registry?.prewarm(info.device);
    // Synchronous with the server's welcome: a broadcast (always after an await) never precedes it.
    if (deps.notifications) {
      this.notificationListener = {
        sessionId: info.sessionId,
        device: info.device,
        speaks: () => this.speechPrefs !== undefined,
        deliver: (frame) => this.emit(frame),
      };
      this.detachNotifications = deps.notifications.attach(this.notificationListener);
    }
  }

  get busy(): boolean {
    return this.turn !== null;
  }

  private emit(frame: ServerFrame): void {
    if (!this.closed) this.send(frame);
  }

  private error(code: ErrorCode, message: string, id?: string): void {
    this.emit(id === undefined ? { type: "error", code, message } : { type: "error", id, code, message });
  }

  /** Handles one validated client frame (hello is handled by the server). */
  async handle(frame: ClientFrame): Promise<void> {
    // Frames still in flight when the socket closed must not start work: a turn
    // begun now would never be aborted and could write after session_end.
    if (this.closing) return;
    switch (frame.type) {
      case "hello":
        this.error("bad_request", "already authenticated");
        return;
      case "ping":
        this.emit({ type: "pong" });
        return;
      case "user_text":
        if (this.turn) {
          this.error("busy", "a turn is already running", frame.id);
          return;
        }
        await this.startTurn(frame.id, frame.text, "text");
        return;
      case "audio":
        await this.handleAudio(frame.id, frame.mime, frame.data);
        return;
      case "confirm_response":
        // Unknown or already-resolved ids are ignored: the button may lose the race to voice/timeout.
        this.broker.resolve(frame.requestId, frame.approved, "button");
        return;
      case "speak":
        await this.handleSpeak(frame.id, frame.text, frame.voice);
        return;
      case "voices":
        await this.handleVoices(frame.id);
        return;
      case "speech_prefs": {
        const wasOn = this.speechPrefs !== undefined;
        this.speechPrefs = frame.enabled ? { mode: frame.mode, ...(frame.voice ? { voice: frame.voice } : {}) } : undefined;
        // Speech just turned on (first prefs after welcome, or on again): urgent items still pending speech are spoken here.
        if (!wasOn && this.speechPrefs && this.notificationListener) await this.deps.notifications?.speechOn(this.notificationListener);
        return;
      }
      case "cancel":
        // An utterance still being transcribed must never become a turn.
        this.transcribing.get(frame.id)?.abort();
        // Barge-in after the visible end: stop the answer that is still being spoken.
        this.speaking.get(frame.id)?.cancel();
        if (this.turn && this.turn.id === frame.id) {
          this.broker.cancelAll(frame.id);
          this.turn.abort.abort();
        }
        return;
      case "history_request": {
        const limit = Math.min(frame.limit ?? DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
        await this.slog.flush(); // include this session's not-yet-written lines
        const items = await this.deps.log.history(limit);
        this.emit({ type: "history", items });
        return;
      }
      case "memory_list":
        await this.handleMemory(frame.id);
        return;
      case "memory_delete":
        await this.handleMemory(frame.id, frame.entryId);
        return;
      case "dev_list":
        await this.handleDev(frame.id);
        return;
      case "dev_action":
        await this.handleDev(frame.id, { itemId: frame.itemId, action: frame.action });
        return;
      case "notifications_list":
        await this.handleNotifications(frame.id);
        return;
      case "notification_action":
        await this.handleNotifications(frame.id, { notificationId: frame.notificationId, action: frame.action });
        return;
    }
  }

  // ------------------------------------------------------------ notifications (T7.w.5)

  /**
   * `notifications_list` (no `action`) and `notification_action`: answered
   * with a fresh `notifications` frame to this socket only, or an `error`
   * with the request id. The change itself reaches every socket as a
   * `notification` / `notification_removed` broadcast (this one included).
   */
  private async handleNotifications(id: string, action?: { notificationId: string; action: NotificationAction }): Promise<void> {
    const center = this.deps.notifications;
    if (!center) {
      this.error("bad_request", "notifications are disabled", id);
      return;
    }
    try {
      if (action) {
        const r = await center.act(this.info.device, action.notificationId, action.action);
        if (!r.ok) {
          this.error(r.code, r.message, id);
          return;
        }
      }
      const v = await center.list();
      this.emit({ type: "notifications", id, items: v.items, unread: v.unread });
    } catch (err) {
      // The store logs why the file could not be read (once, when it became unreadable).
      if (err instanceof NotificationsUnavailableError) {
        this.error("notifications_unavailable", "notifications could not be read", id);
        return;
      }
      this.deps.logger.warn(`[shadow-core] notifications request failed: ${(err as Error)?.name ?? "error"}`);
      this.error("internal", "notifications are unavailable", id);
    }
  }

  // ------------------------------------------------------------ Development tab (T7.w.4)

  /**
   * `dev_list` (no `action`) and `dev_action`: answered with a fresh `dev`
   * frame to this socket only, or an `error` with the request id. The device
   * is the one from the token (`info.device`), never `hello.client`.
   */
  private async handleDev(id: string, action?: { itemId: string; action: DevAction }): Promise<void> {
    const dev = this.deps.dev;
    if (!dev) {
      this.error("bad_request", "development tab is disabled", id);
      return;
    }
    try {
      if (action) {
        const r = await dev.act(this.info.device, action.itemId, action.action);
        if (!r.ok) {
          this.error(r.code, r.message, id);
          return;
        }
      }
      const v = await dev.view();
      this.emit({ type: "dev", id, items: v.items, open: v.open, canManage: dev.canManage(this.info.device) });
    } catch (err) {
      this.deps.logger.warn(`[shadow-core] development request failed: ${(err as Error)?.name ?? "error"}`);
      this.error("internal", "development items are unavailable", id);
    }
  }

  // ------------------------------------------------------------ memory (docs/06)

  /**
   * `memory_list` (no `deleteId`) and `memory_delete`: answered with a fresh
   * `memory` frame to this socket only. A deletion tombstones the entry, like
   * `memory_forget`; an unknown or malformed id is `bad_request`.
   */
  private async handleMemory(id: string, deleteId?: string): Promise<void> {
    const memory = this.deps.memory;
    if (!memory) {
      this.error("bad_request", "memory is disabled", id);
      return;
    }
    try {
      if (deleteId !== undefined) {
        if (!isEntryId(deleteId)) {
          this.error("bad_request", "unknown memory entry", id);
          return;
        }
        const r = await memory.forget({ ids: [deleteId] });
        // `pending`: recorded and hidden already; completed before the next store operation.
        if (!r.ok && !r.pending) {
          this.error("internal", "memory could not be written", id);
          return;
        }
        if (r.ok && r.removed.length === 0) {
          this.error("bad_request", "unknown memory entry", id);
          return;
        }
        this.deps.logger.info(`[shadow-core] memory entry ${deleteId} deleted by device ${this.info.device}`);
      }
      this.emit(memoryFrame(id, await memory.snapshot()));
    } catch (err) {
      this.deps.logger.warn(`[shadow-core] memory request failed: ${(err as Error)?.name ?? "error"}`);
      this.error("internal", "memory is unavailable", id);
    }
  }

  /** The device's (or, without a registry, this socket's) "already sent" set. */
  private sentEntries(): SentEntries {
    return this.deps.registry?.sentEntries?.(this.info.device) ?? this.sentHere;
  }

  /**
   * Memory entries for one model turn, not yet marked as sent: topic entries
   * relevant to `text` (memory/match.ts), and with `withBrief` (legacy runner,
   * whose system prompt has no brief) the brief entries first. Only entries not
   * sent yet in this conversation; `commit()` marks them once the attempt is
   * accepted. Never throws: memory problems leave the turn without a block.
   */
  private async memoryForTurn(text: string, withBrief: boolean): Promise<{ block: string; commit: () => void }> {
    const none = { block: "", commit: () => {} };
    const memory = this.deps.memory;
    if (!memory) return none;
    try {
      const sent = this.sentEntries();
      const fresh = (await memory.entries()).filter((e) => sent.isFresh(e));
      const brief: MemoryEntry[] = [];
      let briefChars = 0;
      // Whole entries in file order within the brief's hard limit, as in the system prompt.
      for (const e of withBrief ? fresh.filter((x) => x.location === "brief") : []) {
        if (briefChars + e.text.length > MEMORY_BUDGETS.briefMaxChars) break;
        brief.push(e);
        briefChars += e.text.length;
      }
      const notes = selectRelevant(
        text,
        fresh.filter((e) => e.location !== "brief"),
      );
      const picked: MemoryEntry[] = [...brief, ...notes];
      if (picked.length === 0) return none;
      return { block: renderMemoryBlock(picked), commit: () => sent.markSent(picked) };
    } catch (err) {
      this.deps.logger.warn(`[shadow-core] memory unavailable for this turn: ${(err as Error)?.name ?? "error"}`);
      return none;
    }
  }

  private async handleAudio(id: string, mime: string, data: string): Promise<void> {
    // Mid-turn audio is only meaningful as a confirm answer.
    if (this.turn && this.broker.size === 0) {
      this.error("busy", "a turn is already running", id);
      return;
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
      this.error("bad_request", "audio.data is not valid base64", id);
      return;
    }
    const audio = Buffer.from(data, "base64");
    if (audio.length === 0 || audio.length > MAX_AUDIO_BYTES) {
      this.error("bad_request", "audio is empty or larger than 25 MB", id);
      return;
    }
    // A voice answer belongs to the confirmation that was open when the user
    // spoke, never to one opened while whisper was still working.
    const target = this.broker.oldest()?.requestId;
    const abort = new AbortController();
    this.transcribing.get(id)?.abort();
    this.transcribing.set(id, abort);
    let text: string;
    try {
      ({ text } = await this.deps.stt.transcribe(audio, mime, AbortSignal.any([this.side.signal, abort.signal])));
    } catch (err) {
      if (abort.signal.aborted || this.closed) return; // cancelled by the client
      const code = err instanceof SpeechServiceError ? err.code : "stt_unavailable";
      this.error(code, err instanceof Error ? err.message : "transcription failed", id);
      return;
    } finally {
      if (this.transcribing.get(id) === abort) this.transcribing.delete(id);
    }
    if (abort.signal.aborted || this.closed) return;
    this.emit({ type: "transcript", id, text });
    if (text === "") {
      this.error("bad_request", "no speech recognized", id);
      return;
    }

    if (target !== undefined) {
      const answer = parseVoiceAnswer(text);
      if (answer !== null) {
        void this.slog.append({ kind: "user", id, text, source: "voice" });
        // If the target was meanwhile resolved (button/timeout), the answer is dropped.
        if (this.broker.isPending(target)) this.broker.resolve(target, answer, "voice");
        return;
      }
    }
    if (this.turn) {
      this.error("busy", "a turn is already running", id);
      return;
    }
    await this.startTurn(id, text, "voice");
  }

  private startTurn(id: string, text: string, source: "text" | "voice"): Promise<void> {
    // Second guard for paths that awaited (e.g. transcription) after handle()'s check.
    if (this.closing) return Promise.resolve();
    // The device with the latest turn speaks the next urgent notification.
    this.deps.notifications?.turnStarted(this.info.device, this.info.sessionId);
    const done = this.runTurn(id, text, source);
    this.turnDone = done;
    return done;
  }

  private async handleVoices(id: string): Promise<void> {
    try {
      const catalog = await this.deps.tts.voices();
      this.emit({ type: "voices", id, default: catalog.default, voices: catalog.voices.map(describeVoice) });
    } catch (err) {
      this.error("tts_unavailable", err instanceof Error ? err.message : "voice list unavailable", id);
    }
  }

  private async handleSpeak(id: string, text: string, voice?: string): Promise<void> {
    try {
      // Spoken form only ("Shadow" → "Şadov"); the client keeps displaying its own text.
      // Clip after the lexicon (it can lengthen the text; the Core also accepts
      // longer speak texts than tts-svc), or tts-svc answers 413 and nothing is spoken.
      const spoken = clipForTts(this.deps.pronunciations?.apply(text) ?? text);
      const { mime, data } = await this.deps.tts.synthesize(spoken, this.side.signal, voice);
      this.emit({ type: "speech", id, mime, data: data.toString("base64") });
    } catch (err) {
      const code = err instanceof SpeechServiceError ? err.code : "tts_unavailable";
      this.error(code, err instanceof Error ? err.message : "synthesis failed", id);
    }
  }

  private async runTurn(id: string, text: string, source: "text" | "voice"): Promise<void> {
    const turn: ActiveTurn = {
      id,
      abort: new AbortController(),
      text: "",
      startedAt: Date.now(),
      toolCalls: 0,
      toolNames: new Set(),
      allowedUseIds: new Set(),
    };
    this.turn = turn;
    // Any tier, for the whole turn (tier-0 confirmations included): no compaction starts meanwhile.
    const endActivity = this.deps.registry?.beginActivity?.(this.info.device);
    this.deps.maintenance?.turnStarted(this.info.device);
    turn.speech = this.openSpeech(turn);
    this.emit({ type: "state", state: "thinking" });
    void this.slog.append({ kind: "user", id, text, source });

    try {
      const decision = await this.deps.router.route({ text, source, device: this.info.device });
      const routeMs = Date.now() - turn.startedAt;
      if (decision.tier === 0 && decision.direct) {
        // A compaction already running: wait for it, so this exchange's note goes
        // to the conversation that follows it (model turns wait in acquire).
        await this.waitHold(turn);
        if (await this.runDirect(turn, text, decision, decision.direct)) return;
        // Fallback: the cheap model takes over (nothing was changed in the home).
        // Silent for a learned rule too; such a recovery turn is never learned from.
        await this.runModel(
          turn,
          text,
          { model: decision.model, tier: 1, escalateTo: decision.escalateTo, rule: decision.rule, source: decision.source },
          routeMs,
        );
        return;
      }
      if (decision.source === "default" && decision.text && this.deps.learning) {
        turn.observed = { calls: [], byUseId: new Map(), overflow: false };
      }
      await this.runModel(turn, text, decision, routeMs);
    } catch (err) {
      this.deps.logger.warn(`[shadow-core] turn ${id} crashed: ${(err as Error).message}`);
      this.error("model_error", "the model could not complete this turn", id);
    } finally {
      this.broker.cancelAll(id);
      if (this.turn === turn) this.turn = null;
      this.finishSpeech(turn);
      this.emit({ type: "state", state: "idle" });
      endActivity?.();
      this.deps.maintenance?.turnEnded(this.info.device);
    }
  }

  /** Waits while maintenance holds the device (docs/06 §Trigger); a cancel stops the wait. */
  private async waitHold(turn: ActiveTurn): Promise<void> {
    const signal = turn.abort.signal;
    const held = this.deps.registry?.isHeld?.(this.info.device) ? this.deps.registry.waitHold?.(this.info.device) : undefined;
    if (!held || signal.aborted) return;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve;
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([held, aborted]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  // ------------------------------------------------------------ speech (A2)

  /** A speech stream for this turn when the client sent `speech_prefs` (enabled). */
  private openSpeech(turn: ActiveTurn): SpeechStream | undefined {
    const prefs = this.speechPrefs;
    if (!prefs) return undefined;
    const stream = new SpeechStream({
      turnId: turn.id,
      mode: prefs.mode,
      voice: prefs.voice,
      tts: this.deps.tts,
      lexicon: this.deps.pronunciations ?? EMPTY_LEXICON,
      send: (frame) => this.emit(frame),
      onError: (err) => this.error(err.code, err.message, turn.id),
      signals: [turn.abort.signal, this.side.signal],
    });
    this.speaking.set(turn.id, stream);
    void stream.done.then(() => {
      if (this.speaking.get(turn.id) === stream) this.speaking.delete(turn.id);
    });
    return stream;
  }

  /** End of the turn's text: the rest is spoken (nothing after a cancel). */
  private finishSpeech(turn: ActiveTurn): void {
    const s = turn.speech;
    if (!s) return;
    if (turn.abort.signal.aborted || turn.cancelled) s.cancel();
    else void s.end();
  }

  /** Sends answer text to the client (and to the turn's speech stream). */
  private live(turn: ActiveTurn, chunk: string): void {
    turn.text += chunk;
    if (turn.abort.signal.aborted) return;
    turn.firstDeltaAt ??= Date.now();
    this.emit({ type: "assistant_delta", id: turn.id, text: chunk });
    turn.speech?.push(chunk);
  }

  /** Keeps work that ends after the visible turn end, so close() can wait for it (bounded). */
  private track(p: Promise<unknown>): void {
    const guarded = p.then(
      () => {},
      (err: unknown) => {
        this.deps.logger.warn(`[shadow-core] turn tail failed: ${(err as Error)?.message ?? String(err)}`);
      },
    );
    this.tails.add(guarded);
    void guarded.then(() => this.tails.delete(guarded));
  }

  /** `timing` log entry (07 §Usage records), written once usage and the first speech are known. */
  private writeTiming(
    turn: ActiveTurn,
    tier: ModelTier,
    routeMs: number,
    doneAt: number,
    tail: Promise<{ sdkDurationMs: number; warm: boolean; queryAgeMs: number }>,
  ): void {
    const speech = turn.speech;
    this.track(
      Promise.all([tail, speech?.done]).then(([t]) => {
        const firstSpeechAt = speech?.firstChunkAt;
        return this.slog.append({
          kind: "timing",
          id: turn.id,
          tier,
          warm: t.warm,
          queryAgeMs: t.queryAgeMs,
          routeMs,
          ...(turn.firstDeltaAt !== undefined ? { firstDeltaMs: turn.firstDeltaAt - turn.startedAt } : {}),
          doneMs: doneAt - turn.startedAt,
          sdkDurationMs: t.sdkDurationMs,
          ...(firstSpeechAt !== undefined ? { firstSpeechMs: firstSpeechAt - turn.startedAt } : {}),
          ...(turn.waitedForCompactMs !== undefined ? { waitedForCompactMs: turn.waitedForCompactMs } : {}),
        });
      }),
    );
  }

  // ------------------------------------------------------------ tier 0

  /** Runs a direct (model-free) plan. Returns false when the turn must fall back to the model. */
  private async runDirect(turn: ActiveTurn, text: string, decision: RouteDecision, plan: DirectPlan): Promise<boolean> {
    const id = turn.id;
    const started = Date.now();
    const tools: string[] = [];
    let outcome: DirectOutcome;
    const client = this.deps.direct;
    if (turn.abort.signal.aborted) {
      // Cancelled while it waited for a compaction: nothing is run.
      outcome = { kind: "cancelled" };
    } else if (!client) {
      outcome = { kind: "fallback", reason: "no_direct_client" };
    } else if (!this.deps.policy.serviceNames.includes(plan.service)) {
      // Service disabled (e.g. token missing): the model path decides what to tell the user.
      outcome = { kind: "fallback", reason: "service_disabled" };
    } else {
      const call: GatedCall = async (tool, args) => {
        const full = `mcp__${plan.service}__${tool}`;
        const auth = await this.authorize(turn, full, args, turn.abort.signal, tool === plan.tool ? plan.permission : undefined);
        if (!auth.allowed) return { status: "denied", reason: auth.reason };
        tools.push(tool);
        try {
          const result = await client.callTool(plan.service, tool, args, turn.abort.signal);
          this.toolFinished(id, full, result.isError);
          // A result that arrives after the user cancelled the turn is not a tool error (T7.w.10k).
          if (result.isError && !turn.abort.signal.aborted) this.noteToolError(plan.service, tool, result.text, "error", id);
          return { status: "ok", result };
        } catch (err) {
          if (turn.abort.signal.aborted) return { status: "denied", reason: "cancelled" };
          this.toolFinished(id, full, true);
          const message = (err as Error).message;
          // A thrown call is a transport failure: `unreachable` unless its message says more (e.g. a timeout).
          this.noteToolError(plan.service, tool, message, "unreachable", id);
          this.deps.logger.warn(`[shadow-core] direct ${plan.service}/${tool} failed: ${message}`);
          return { status: "unavailable", message };
        }
      };
      outcome = await runDirectPlan(plan, call, { fallbackOnError: decision.fallbackOnError === true });
    }
    if (turn.abort.signal.aborted) outcome = { kind: "cancelled" };
    if (decision.source === "learned" && decision.learnedId !== undefined) this.reportLearned(decision.learnedId, outcome, id);

    const usage = (o: UsageOutcome): UsageRecord => ({
      turnId: id,
      sessionId: this.info.sessionId,
      tier: 0,
      model: "none",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs: Date.now() - started,
      services: tools.length > 0 ? [plan.service] : [],
      tools,
      outcome: o,
    });

    if (outcome.kind === "fallback") {
      // The spoken name matched no entity (static or learned rule): a missing HA alias, most likely (T7.w.10i).
      if (outcome.reason === "name_not_found" && plan.name !== undefined) this.note({ kind: "unknown_name", name: plan.name, turnId: id });
      void this.slog.append({ kind: "route", id, tier: 0, rule: plan.rule, fallback: outcome.reason });
      this.recordUsage(usage("fallback"));
      return false;
    }
    void this.slog.append({ kind: "route", id, tier: 0, rule: plan.rule });
    if (outcome.kind === "cancelled") {
      this.emit({ type: "assistant_done", id, text: "" });
      void this.slog.append({ kind: "assistant", id, text: "", cancelled: true });
      this.recordUsage(usage("cancelled"));
      return true;
    }
    turn.text = "";
    this.live(turn, outcome.text);
    this.emit({ type: "assistant_done", id, text: outcome.text });
    void this.slog.append({ kind: "assistant", id, text: outcome.text });
    // The model never saw this exchange; tell it.
    this.addDirectNote(`Kullanıcı: ${text}\nShadow: ${outcome.text}`);
    this.recordUsage(usage(outcome.status === "done" ? "done" : outcome.status));
    return true;
  }

  /**
   * Counts one run of an active learned rule (off the turn path): a success,
   * a fallback of the rule's own (toward suspension) or neutral.
   */
  private reportLearned(id: string, outcome: DirectOutcome, turnId: string): void {
    const store = this.deps.learning?.store;
    if (!store) return;
    let p: Promise<unknown> | undefined;
    if (outcome.kind === "reply" && outcome.status === "done") p = store.recordOutcome(id, "success");
    else if (outcome.kind === "fallback" && LEARNED_FAILURES.has(outcome.reason)) {
      const reason = outcome.reason;
      p = store.recordOutcome(id, "failure", reason).then((r) => {
        // The reason is the fallback's enum value (LEARNED_FAILURES), never a message.
        if (r.suspended) this.note({ kind: "rule_suspended", ruleId: id, reason, turnId });
      });
    }
    if (p) this.track(p);
  }

  // ------------------------------------------------------------ turn dev-notes (T7.w.3)

  /** Records one turn dev-note. Never throws; fire and forget (TurnNotes coalesces the writes). */
  private note(input: TurnNoteInput): void {
    const notes = this.deps.turnNotes;
    if (!notes) return;
    try {
      void notes.record(input).catch(() => {});
    } catch {
      // a broken recorder must never affect the turn
    }
  }

  /**
   * A model tool result: `isError` of a call the gate allowed is a `tool_error`,
   * classified from its error text (`classifyToolError`; no text = `error`).
   * Denied calls (user, gate) and calls the gateway refused before the gate
   * (unknown tool: `missing_capability`) are not errors; nor is a result of a
   * turn the user cancelled (Durdur, barge-in, socket close), or one that only
   * says the turn was cancelled or is over (T7.w.10k).
   */
  private noteModelResult(turn: ActiveTurn, toolUseId: string, name: string | undefined, isError: boolean, errorText?: string): void {
    if (!isError || !turn.allowedUseIds.has(toolUseId) || turn.abort.signal.aborted || !name) return;
    const { identity } = this.deps.policy.levelFor(name);
    if (identity.service === undefined) return;
    this.noteToolError(identity.service, identity.tool, errorText, "error", turn.id);
  }

  /** One failed tool call as a `tool_error` note; the text is only classified, never stored or logged. */
  private noteToolError(service: string, tool: string, text: string | undefined, fallback: "error" | "unreachable", turnId: string): void {
    const verdict = classifyToolError(text, fallback);
    if (verdict === "cancelled") return;
    this.note({ kind: "tool_error", service, tool, errorClass: verdict, turnId });
  }

  /** One model tool call reached the gate: counted for `wandering`. */
  private countToolCall(turn: ActiveTurn, toolName: string): void {
    turn.toolCalls++;
    if (turn.toolNames.size < MAX_TURN_TOOL_NAMES) turn.toolNames.add(this.deps.policy.levelFor(toolName).identity.tool);
  }

  /** A model turn with many tool calls, or one the tool-call cap stopped, is `wandering`. */
  private noteWandering(turn: ActiveTurn, decision: RouteDecision, tier: ModelTier, toolCap: boolean): void {
    const limit = this.deps.wanderCalls ?? DEFAULT_WANDER_CALLS;
    if (!toolCap && turn.toolCalls < limit) return;
    this.note({
      kind: "wandering",
      trigger: toolCap ? "tool_cap" : "calls",
      tier,
      routeSource: decision.source ?? "none",
      ...(decision.rule !== undefined ? { routeRule: decision.rule } : {}),
      tools: [...turn.toolNames],
      turnId: turn.id,
    });
  }

  // ------------------------------------------------------------ pattern learning (T7.w.2)

  /** Keeps one gated call of an observed model turn. */
  private observeCall(turn: ActiveTurn, toolName: string, input: Record<string, unknown>, toolUseId: string, allowed: boolean, level: ObservedCall["level"]): void {
    const obs = turn.observed;
    if (!obs || obs.overflow) return;
    if (obs.calls.length >= MAX_OBSERVED_CALLS) {
      obs.overflow = true;
      obs.calls.length = 0;
      obs.byUseId.clear();
      return;
    }
    const { identity } = this.deps.policy.levelFor(toolName);
    const call: ObservedCall = {
      ...(identity.service !== undefined ? { service: identity.service } : {}),
      tool: identity.tool,
      args: { ...input },
      level,
      allowed,
    };
    obs.calls.push(call);
    // A tool use id seen twice is not a call we can pair with its result.
    if (obs.byUseId.has(toolUseId)) obs.overflow = true;
    obs.byUseId.set(toolUseId, call);
  }

  /** Pairs a tool result with its observed call. */
  private observeResult(turn: ActiveTurn, toolUseId: string, isError: boolean): void {
    const call = turn.observed?.byUseId.get(toolUseId);
    if (call) call.isError = call.isError === true || isError;
  }

  /**
   * Hands an observed model turn to the learner once every attempt has
   * settled (docs/07 §Turn boundaries), off the turn path. `completed` is
   * read then: the turn ended `done` (not cancelled, no error, no limit).
   */
  private learnAtSettle(turn: ActiveTurn, decision: RouteDecision, settled: Promise<unknown>, completed: () => boolean): void {
    const obs = turn.observed;
    turn.observed = undefined;
    const learning = this.deps.learning;
    const text = decision.text;
    if (!obs || !learning || !text || decision.source !== "default") return;
    this.track(settled.then(() => this.learnFrom(learning, obs, text, completed())));
  }

  private async learnFrom(learning: SessionLearning, obs: TurnObservation, text: NonNullable<RouteDecision["text"]>, completed: boolean): Promise<void> {
    if (obs.overflow) return;
    const policy = this.deps.policy;
    const check = checkTurn({ routedByDefault: true, completed, readOnly: policy.options.readOnly === true, text, calls: obs.calls }, learning.policy);
    if (!check.ok) {
      // Fail closed, but visible: a result the gate's tool use id could not be paired with means nothing is ever learned.
      if (check.reason === "no_result" && !this.unpairedLogged) {
        this.unpairedLogged = true;
        this.deps.logger.info("[shadow-core] learning: a tool result could not be paired with its call; the turn is not learned from");
      }
      return;
    }
    // The learner's own live-context read: only through the direct client and only while it is a `read` tool (no prompt possible).
    const client = this.deps.direct;
    if (!client || !policy.serviceNames.includes(LEARNABLE_SERVICE)) return;
    if (policy.levelFor(`mcp__${LEARNABLE_SERVICE}__${LIVE_CONTEXT_TOOL}`).level !== "read") return;
    let entities;
    try {
      const ctx = await client.callTool(LEARNABLE_SERVICE, LIVE_CONTEXT_TOOL, {}, this.side.signal);
      if (ctx.isError) return;
      entities = parseLiveContext(ctx.text);
    } catch {
      return; // unreachable or unparseable: the observation is dropped silently
    }
    const x = extractPattern(text, check.value, entities, learning.policy);
    if (!x.ok) return;
    const r = await learning.store.observe(x.value);
    if (r?.status === "candidate" && r.observations === learning.minObservations) {
      this.deps.logger.info(`[shadow-core] learned rule ${r.id} is a candidate (waits for approval)`);
    }
  }

  /**
   * A tier-0 exchange for the model. With a live session that stores notes, it
   * goes into the conversation at once (`appendNote`, no model call); otherwise
   * (legacy runner, no session running, or the note was refused) it is kept and
   * put in front of the next model turn. Either way it is wrapped in the
   * `<bilgi>` delimiters (turn-envelope.ts `wrapDirectNotes`).
   */
  private addDirectNote(note: string): void {
    const registry = this.deps.registry;
    const live = registry?.capabilities.notes ? registry.live(this.info.device) : undefined;
    const entry: DirectNote = { seq: this.noteSeq++, text: note };
    if (!live) {
      this.bufferDirectNotes([entry]);
      return;
    }
    // Older notes still buffered go first, in the same note, so the model sees them in order.
    const batch = [...this.directNotes.splice(0), entry];
    this.track(
      live.appendNote(wrapDirectNotes(batch.map((n) => n.text))).then((ok) => {
        if (!ok) this.bufferDirectNotes(batch);
      }),
    );
  }

  /**
   * Keeps notes for the next model turn, merged with those already buffered in
   * creation order (`seq`): a refused batch can come back after a later note
   * was buffered, and concurrent refused batches can come back in any order.
   * The oldest notes are dropped beyond MAX_DIRECT_NOTES.
   */
  private bufferDirectNotes(notes: readonly DirectNote[]): void {
    this.directNotes.push(...notes);
    this.directNotes.sort((a, b) => a.seq - b.seq);
    if (this.directNotes.length > MAX_DIRECT_NOTES) this.directNotes.splice(0, this.directNotes.length - MAX_DIRECT_NOTES);
  }

  // ------------------------------------------------------------ tiers 1-3

  private async runModel(turn: ActiveTurn, text: string, decision: RouteDecision, routeMs: number): Promise<void> {
    const id = turn.id;
    const tier: ModelTier = decision.tier === 1 || decision.tier === 3 ? decision.tier : 2;
    const escalateTo = tier === 1 ? decision.escalateTo : undefined;
    void this.slog.append({ kind: "route", id, tier, model: decision.model, ...(decision.rule ? { rule: decision.rule } : {}) });

    const registry = this.deps.registry;
    const device = this.info.device;
    if (!registry) {
      const result = await this.runModelLegacy(turn, text, decision, tier, escalateTo, this.sdkSessionId, routeMs);
      if (!result) return; // cancelled before the call: no model turn
      if (result.sessionId) this.sdkSessionId = result.sessionId;
      this.deps.maintenance?.modelTurnEnded(device);
      return;
    }
    // One model turn per device across its sockets, also on the legacy fallback
    // (the session's own busy check does not cover a turn that runs beside it).
    if (!registry.beginTurn(device)) {
      this.error("busy", "a turn is already running on this device", id);
      return;
    }
    try {
      // A compaction in progress makes this turn wait in acquire (docs/06 §Trigger).
      const waitStart = registry.isHeld?.(device) ? Date.now() : undefined;
      const session = await this.acquire(turn, registry);
      if (waitStart !== undefined) turn.waitedForCompactMs = Date.now() - waitStart;
      if (session === "cancelled") {
        this.finishCancelledBeforeModel(turn, tier, decision.model);
        return;
      }
      // The summary of a compacted conversation that could not be stored as a note;
      // the registry keeps it until an attempt carrying it is taken (`seedDelivered`).
      const seed = registry.peekSeedNote?.(device);
      const delivered = seed === undefined ? () => {} : () => registry.seedDelivered?.(device, seed);
      if (session && (await this.runModelPersistent(turn, text, decision, tier, escalateTo, session, routeMs, seed, delivered))) return;
      // No session (start failed, restart backoff) or it closed under us: this turn runs on the legacy runner.
      const base = await registry.fallbackResume(device);
      const result = await this.runModelLegacy(turn, text, decision, tier, escalateTo, base, routeMs, seed, delivered);
      // Cancelled before the call: nothing was sent, so continuity stays where it was.
      if (!result) return;
      this.track(registry.turnEnded(device, result.sessionId));
      this.deps.maintenance?.modelTurnEnded(device);
    } finally {
      registry.endTurn(device);
    }
  }

  /** The device's session (undefined: use the legacy runner), or "cancelled" when the turn was cancelled while it started. */
  private async acquire(turn: ActiveTurn, registry: SessionRegistry): Promise<ProviderSession | undefined | "cancelled"> {
    const signal = turn.abort.signal;
    if (signal.aborted) return "cancelled";
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<"cancelled">((resolve) => {
      onAbort = () => resolve("cancelled");
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([registry.acquire(this.info.device), aborted]);
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private finishCancelledBeforeModel(turn: ActiveTurn, tier: ModelTier, model: string): void {
    this.emit({ type: "assistant_done", id: turn.id, text: "" });
    void this.slog.append({ kind: "assistant", id: turn.id, text: "", cancelled: true });
    this.recordModelUsage(turn, tier, model, { text: "", inputTokens: 0, outputTokens: 0, durationMs: Date.now() - turn.startedAt }, "cancelled");
  }

  /**
   * Legacy runner: a fresh query per turn; tier-1 attempts fork, escalation resumes (behaviour before 07).
   * Undefined when the turn was cancelled before the call (nothing was sent).
   */
  private async runModelLegacy(
    turn: ActiveTurn,
    text: string,
    decision: RouteDecision,
    tier: ModelTier,
    escalateTo: RouteDecision["escalateTo"],
    base: string | undefined,
    routeMs: number,
    seed?: string,
    seedDelivered: () => void = () => {},
  ): Promise<TurnResult | undefined> {
    const id = turn.id;
    // A fresh query per turn: its system prompt has no brief, so the brief goes in the memory block.
    const memory = await this.memoryForTurn(text, true);
    if (turn.abort.signal.aborted) {
      // Cancelled while memory was read: no call, so notes, entries and the seed stay for the next turn.
      this.finishCancelledBeforeModel(turn, tier, decision.model);
      return undefined;
    }
    const notes = this.directNotes.splice(0).map((n) => n.text);
    const prompt = buildTurnEnvelope({ text, notes: seed ? [seed, ...notes] : notes, memoryBlock: memory.block });
    memory.commit();
    seedDelivered();

    let call = await this.callModel(turn, { prompt, model: decision.model, tier, escalatable: escalateTo !== undefined, resume: base });
    let model = decision.model;
    let callTier: ModelTier = tier;
    if (escalateTo && call.escalate && !turn.abort.signal.aborted) {
      this.recordModelUsage(turn, callTier, model, call.result, "escalated");
      void this.slog.append({ kind: "route", id, tier: escalateTo.tier, model: escalateTo.model, escalated: true });
      // If the cheap model already ran tools, continue in its session so nothing is done twice;
      // otherwise start again from the context before this turn.
      const fork = call.result.sessionId;
      const resumeFork = (call.result.tools ?? []).length > 0 && fork !== undefined;
      model = escalateTo.model;
      callTier = escalateTo.tier;
      call = await this.callModel(turn, {
        prompt: resumeFork ? ESCALATION_CONTINUE : prompt,
        model,
        tier: callTier,
        escalatable: false,
        resume: resumeFork ? fork : base,
      });
    }

    const result = call.result;
    const cancelled = turn.abort.signal.aborted;
    const finalText = turn.text;
    if (result.error && !cancelled) {
      this.deps.logger.warn(`[shadow-core] turn ${id} failed: ${result.error}`);
      void this.slog.append({ kind: "error", id, code: "model_error", message: result.error });
      this.error("model_error", "the model could not complete this turn", id);
      if (finalText) this.emit({ type: "assistant_done", id, text: finalText });
    } else {
      this.emit({ type: "assistant_done", id, text: finalText });
    }
    const doneAt = Date.now();
    if (finalText || cancelled) {
      void this.slog.append({ kind: "assistant", id, text: finalText, ...(cancelled ? { cancelled: true } : {}) });
    }
    this.recordModelUsage(turn, callTier, model, result, cancelled ? "cancelled" : result.error ? "error" : "done");
    this.writeTiming(turn, callTier, routeMs, doneAt, Promise.resolve({ sdkDurationMs: result.durationMs, warm: false, queryAgeMs: 0 }));
    // Legacy results are final on return.
    this.learnAtSettle(turn, decision, Promise.resolve(), () => !cancelled && !result.error);
    // The legacy runner has no tool-call cap of its own (maxTurns ends it as an error): calls only.
    this.noteWandering(turn, decision, callTier, false);
    return result;
  }

  /**
   * One legacy model call. Escalatable (tier 1) calls are buffered: their text reaches
   * the client only once it is clear the model did not hand the turn on, so the
   * escalation marker is never shown or spoken.
   */
  private async callModel(
    turn: ActiveTurn,
    o: { prompt: string; model: string; tier: ModelTier; escalatable: boolean; resume?: string },
  ): Promise<{ result: TurnResult; escalate: boolean }> {
    const id = turn.id;
    let buffer = "";
    const result = await this.deps.agent.runTurn(
      {
        prompt: o.prompt,
        model: o.model,
        resume: o.resume,
        signal: turn.abort.signal,
        canUseTool: this.gate(turn),
        escalatable: o.escalatable,
        // Keep the pre-turn session intact in case the turn is escalated.
        forkSession: o.escalatable,
        mcpServerNames: this.deps.tierServices?.[o.tier],
      },
      {
        onDelta: (chunk) => {
          if (o.escalatable) buffer += chunk;
          else this.live(turn, chunk);
        },
        onToolResult: (toolUseId, name, isError, errorText) => {
          this.toolFinished(id, name, isError);
          this.observeResult(turn, toolUseId, isError);
          this.noteModelResult(turn, toolUseId, name, isError, errorText);
        },
      },
    );
    if (!o.escalatable) return { result, escalate: false };
    const marked = buffer.includes(ESCALATION_MARKER);
    const escalate = marked && !result.error && !turn.abort.signal.aborted;
    if (!escalate) {
      const clean = buffer.split(ESCALATION_MARKER).join("").trim();
      if (clean) this.live(turn, clean);
    }
    return { result, escalate };
  }

  /**
   * Persistent mode (07 A1): the turn runs as attempts on the device's live
   * session. Escalation continues in the same session (no fork): the tier-2
   * attempt sees the request, the tier-1 marker and any tool results.
   * Returns false when the session closed before the first attempt was taken
   * (the caller then uses the legacy runner).
   */
  private async runModelPersistent(
    turn: ActiveTurn,
    text: string,
    decision: RouteDecision,
    tier: ModelTier,
    escalateTo: RouteDecision["escalateTo"],
    session: ProviderSession,
    routeMs: number,
    seed?: string,
    seedDelivered: () => void = () => {},
  ): Promise<boolean> {
    const id = turn.id;
    const escalatable = escalateTo !== undefined;
    // Notes buffered while no session was running go in front of the request.
    const notes = this.directNotes.slice();
    // The brief is in this session's system prompt; only relevant topic entries go in the envelope.
    const memory = await this.memoryForTurn(text, false);
    if (turn.abort.signal.aborted) {
      // Cancelled while memory was read: no attempt, so notes, entries and the seed stay for the next turn.
      this.finishCancelledBeforeModel(turn, tier, decision.model);
      return true;
    }
    const noteTexts = notes.map((n) => n.text);
    const envelope = buildTurnEnvelope({ text, escalatable, notes: seed ? [seed, ...noteTexts] : noteTexts, memoryBlock: memory.block });
    let model = decision.model;
    let callTier: ModelTier = tier;

    const first = this.attempt(turn, session, { text: envelope, model, tier, escalatable });
    if (first === "closed") return false;
    if (first === "busy") {
      this.error("busy", "a turn is already running on this device", id);
      return true;
    }
    // Remove exactly the notes taken (a refused batch may have been merged in meanwhile).
    // Taken at once so a tier-0 note batch cannot pick them up while the attempt waits in the queue.
    for (const n of notes) {
      const i = this.directNotes.indexOf(n);
      if (i >= 0) this.directNotes.splice(i, 1);
    }
    // Accepted is not sent: the attempt may wait behind a model switch or earlier work and end
    // unsent (cancelled meanwhile). Only a sent prompt consumes the entries and the seed.
    const sent = await first.sent;
    if (sent) {
      memory.commit();
      seedDelivered();
    } else if (notes.length > 0) {
      this.bufferDirectNotes(notes);
    }
    let call = first;
    /** Every attempt's `settled`: the learner waits for all of them. */
    const attemptsSettled: Promise<AttemptOutcome>[] = [first.settled];
    let out = await call.done;
    /** The escalation attempt could not start: the turn ends as an error of the first attempt. */
    let escalationFailed = false;
    if (escalateTo && call.escalate() && !turn.abort.signal.aborted) {
      void this.slog.append({ kind: "route", id, tier: escalateTo.tier, model: escalateTo.model, escalated: true });
      const next = this.attempt(turn, session, { text: ESCALATION_CONTINUE, model: escalateTo.model, tier: escalateTo.tier, escalatable: false });
      if (next === "closed" || next === "busy") {
        // Usage stays the first attempt's, recorded once below under its own tier and model.
        escalationFailed = true;
        out = { ...out, status: "error", error: `escalation could not start (session ${next})` };
      } else {
        this.recordAtSettle(turn, callTier, model, call.settled, "escalated");
        model = escalateTo.model;
        callTier = escalateTo.tier;
        call = next;
        attemptsSettled.push(next.settled);
        out = await call.done;
      }
    }

    const cancelled = turn.abort.signal.aborted || out.status === "cancelled";
    turn.cancelled = cancelled;
    const finalText = turn.text;
    if (out.status === "usage_limit" && !cancelled) {
      // The limit message is an error frame, never an answer (07 §Usage limit).
      void this.slog.append({ kind: "error", id, code: "usage_limit", message: "usage limit reached" });
      this.emit({
        type: "error",
        id,
        code: "usage_limit",
        message: "usage limit reached",
        ...(out.retryAt !== undefined ? { retryAt: out.retryAt } : {}),
      });
    } else if (out.status !== "ok" && !cancelled) {
      const why = out.error ?? out.status;
      this.deps.logger.warn(`[shadow-core] turn ${id} failed: ${why}`);
      void this.slog.append({ kind: "error", id, code: "model_error", message: why });
      this.error("model_error", "the model could not complete this turn", id);
      if (finalText) this.emit({ type: "assistant_done", id, text: finalText });
    } else {
      this.emit({ type: "assistant_done", id, text: finalText });
    }
    const doneAt = Date.now();
    if (out.status !== "usage_limit" && (finalText || cancelled)) {
      void this.slog.append({ kind: "assistant", id, text: finalText, ...(cancelled ? { cancelled: true } : {}) });
    }
    const settled = call.settled;
    this.recordAtSettle(turn, callTier, model, settled, cancelled ? "cancelled" : escalationFailed ? "error" : undefined);
    this.writeTiming(
      turn,
      callTier,
      routeMs,
      doneAt,
      settled.then((o) => ({ sdkDurationMs: o.durationMs, warm: o.warm, queryAgeMs: o.queryAgeMs })),
    );
    const registry = this.deps.registry;
    const device = this.info.device;
    // An unsent turn did not move the conversation: no continuity update, no model turn counted.
    if (!sent) {
      turn.observed = undefined;
      return true;
    }
    const wanderTier = callTier;
    this.track(
      Promise.all(attemptsSettled).then((all) => this.noteWandering(turn, decision, wanderTier, all.some((o) => o.status === "tool_cap"))),
    );
    let lastStatus: AttemptOutcome["status"] | undefined;
    this.learnAtSettle(
      turn,
      decision,
      Promise.all(attemptsSettled).then((all) => (lastStatus = all[all.length - 1]?.status)),
      () => !cancelled && !escalationFailed && out.status === "ok" && lastStatus === "ok",
    );
    this.track(
      settled.then(async (o) => {
        if (registry) await registry.turnEnded(device);
        // Context size of the live conversation = this turn's input total (docs/06 §Trigger).
        this.deps.maintenance?.modelTurnEnded(device, {
          contextTokens: o.inputTokens,
          ...(o.status === "usage_limit" ? { usageLimited: true, ...(o.retryAt !== undefined ? { retryAt: o.retryAt } : {}) } : {}),
        });
      }),
    );
    return true;
  }

  /** Submits one attempt; "busy" (another socket of this device runs one) or "closed" (the session is gone). */
  private attempt(
    turn: ActiveTurn,
    session: ProviderSession,
    o: { text: string; model: string; tier: ModelTier; escalatable: boolean },
  ):
    | { done: Promise<AttemptOutcome>; settled: Promise<AttemptOutcome>; sent: Promise<boolean>; escalate: () => boolean }
    | "busy"
    | "closed" {
    let buffer = "";
    let handle: AttemptHandle;
    try {
      handle = session.runAttempt({
        text: o.text,
        model: o.model,
        canUseTool: this.gate(turn, this.deps.tierServices?.[o.tier]),
        signal: turn.abort.signal,
        turnId: turn.id,
        callbacks: {
          onDelta: (chunk) => {
            if (o.escalatable) buffer += chunk;
            else this.live(turn, chunk);
          },
          onToolResult: (toolUseId, name, isError, errorText) => {
            this.toolFinished(turn.id, name, isError);
            this.observeResult(turn, toolUseId, isError);
            this.noteModelResult(turn, toolUseId, name, isError, errorText);
          },
        },
      });
    } catch (err) {
      if (err instanceof SessionBusyError) return "busy";
      if (err instanceof SessionClosedError) return "closed";
      throw err;
    }
    let escalate = false;
    const done = handle.done.then((out) => {
      if (o.escalatable) {
        // Buffered tier-1 text is shown only when the model did not hand the turn on.
        escalate = buffer.includes(ESCALATION_MARKER) && out.status === "ok" && !turn.abort.signal.aborted;
        // A cancelled attempt (also one the provider cancelled, without a user
        // abort) shows nothing: turn.cancelled is set only after `done`, too late
        // to stop the speech stream from sending these sentences.
        if (!escalate && out.status !== "usage_limit" && out.status !== "cancelled") {
          const clean = buffer.split(ESCALATION_MARKER).join("").trim();
          if (clean) this.live(turn, clean);
        }
      }
      return out;
    });
    return { done, settled: handle.settled, sent: handle.sent, escalate: () => escalate };
  }

  /** Usage is final only at `settled` (07 §Turn boundaries). `outcome` undefined = from the status. */
  private recordAtSettle(turn: ActiveTurn, tier: ModelTier, model: string, settled: Promise<AttemptOutcome>, outcome?: UsageOutcome): void {
    this.track(
      settled.then((o) => {
        const u: UsageOutcome = outcome ?? (o.status === "ok" ? "done" : o.status === "cancelled" ? "cancelled" : "error");
        this.recordModelUsage(turn, tier, o.model || model, o, u);
      }),
    );
  }

  private recordModelUsage(turn: ActiveTurn, tier: ModelTier, model: string, r: TurnResult, outcome: UsageOutcome): void {
    const tools: string[] = [];
    const services = new Set<string>();
    for (const full of r.tools ?? []) {
      const ident = this.deps.policy.levelFor(full).identity;
      tools.push(ident.tool);
      if (ident.service) services.add(ident.service);
    }
    this.recordUsage({
      turnId: turn.id,
      sessionId: this.info.sessionId,
      tier,
      model,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheReadTokens: r.cacheReadTokens,
      cacheWriteTokens: r.cacheWriteTokens,
      durationMs: r.durationMs,
      costUsd: r.costUsd,
      services: [...services],
      tools,
      outcome,
    });
  }

  private recordUsage(u: UsageRecord): void {
    void this.slog.append({
      kind: "usage",
      id: u.turnId,
      tier: u.tier,
      model: u.model,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWriteTokens: u.cacheWriteTokens,
      durationMs: u.durationMs,
      costUsd: u.costUsd,
      outcome: u.outcome,
    });
    try {
      this.deps.router.onUsage?.(u);
    } catch (err) {
      this.deps.logger.warn(`[shadow-core] router.onUsage failed: ${(err as Error).message}`);
    }
  }

  /** Emits the `tool` done/error frame and logs the result. */
  private toolFinished(id: string, full: string | undefined, isError: boolean): void {
    this.emit({ type: "tool", id, name: this.displayName(full), status: isError ? "error" : "done" });
    void this.slog.append({ kind: "tool_result", id, tool: full ?? "unknown", status: isError ? "error" : "done" });
  }

  /** Tool name shown to the client: service-relative (e.g. `intent__HassTurnOff`). */
  private displayName(full: string | undefined): string {
    if (!full) return "unknown";
    return this.deps.policy.levelFor(full).identity.tool;
  }

  /**
   * The provider-neutral permission callback for one model call. `services`
   * (persistent mode, router.yaml `tierN.services`): tools of any other
   * service are denied ("not available in this mode") without asking.
   */
  gate(turn: ActiveTurn, services?: readonly string[]): PermissionCallback & { readonly turnId: string } {
    // `turnId`: a per-turn gate tells the gateway which turn its calls belong to
    // (legacy runner; `GatewayGate.turnId`), for turn dev-notes such as `unknown_tool`.
    const gate: PermissionCallback = async (toolName, input, opts): Promise<PermissionDecision> => {
      this.countToolCall(turn, toolName);
      const r = services && !this.inTierServices(toolName, services)
        ? this.denyOutsideTier(turn, toolName, input)
        : await this.authorize(turn, toolName, input, opts.signal);
      this.observeCall(turn, toolName, input, opts.toolUseID, r.allowed, r.level);
      if (r.allowed) turn.allowedUseIds.add(opts.toolUseID);
      return r.allowed
        ? { behavior: "allow", updatedInput: input, toolUseID: opts.toolUseID }
        : { behavior: "deny", message: DENY_MESSAGES[r.reason], toolUseID: opts.toolUseID };
    };
    return Object.assign(gate, { turnId: turn.id });
  }

  private inTierServices(toolName: string, services: readonly string[]): boolean {
    const service = this.deps.policy.levelFor(toolName).identity.service;
    return service !== undefined && services.includes(service);
  }

  /** Same records as a gate denial, for a tool of a service outside the current tier. */
  private denyOutsideTier(turn: ActiveTurn, toolName: string, input: Record<string, unknown>): { allowed: false; reason: GateDeny; level: "deny" } {
    const { identity } = this.deps.policy.levelFor(toolName, input);
    const id = turn.id;
    void this.slog.append({ kind: "tool_call", id, tool: identity.full, level: "deny", reason: "tier_service", input });
    this.emit({ type: "tool", id, name: identity.tool, status: "denied" });
    void this.slog.append({ kind: "permission", id, tool: identity.full, decision: "deny", level: "deny" });
    this.deps.logger.info(`[shadow-core] denied ${identity.full} (not in this tier's services)`);
    this.note({
      kind: "missing_capability",
      reason: "tier_service",
      tool: identity.tool,
      ...(identity.service !== undefined ? { service: identity.service } : {}),
      turnId: id,
    });
    return { allowed: false, reason: "tier_service", level: "deny" };
  }

  /**
   * The permission gate, shared by model tool calls (via `gate`) and tier-0
   * direct calls. `minLevel` (router.yaml rule `permission`) can only raise
   * the services.yaml level, never lower it.
   */
  private async authorize(
    turn: ActiveTurn,
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    minLevel?: PermissionLevel,
  ): Promise<{ allowed: true; level: GateLevel } | { allowed: false; reason: DenyReason; level: GateLevel }> {
    const decision = this.deps.policy.levelFor(toolName, input);
    const { identity } = decision;
    let level = decision.level;
    let reason = decision.reason;
    if (minLevel && level !== "deny" && LEVEL_RANK[minLevel] > LEVEL_RANK[level]) {
      level = minLevel;
      reason = `${reason}+route:${minLevel}`;
    }
    const tool = identity.tool;
    const id = turn.id;
    void this.slog.append({ kind: "tool_call", id, tool: identity.full, level, reason, input });

    const deny = (why: DenyReason, by?: string, requestId?: string): { allowed: false; reason: DenyReason; level: GateLevel } => {
      this.emit({ type: "tool", id, name: tool, status: "denied" });
      void this.slog.append({
        kind: "permission",
        id,
        tool: identity.full,
        decision: "deny",
        level,
        ...(by ? { by } : {}),
        ...(requestId ? { requestId } : {}),
      });
      this.deps.logger.info(`[shadow-core] denied ${identity.full} (${reason}${by ? `, by ${by}` : ""})`);
      return { allowed: false, reason: why, level };
    };
    const allow = (by?: string, requestId?: string): { allowed: true; level: GateLevel } => {
      this.emit({ type: "tool", id, name: tool, status: "started" });
      void this.slog.append({
        kind: "permission",
        id,
        tool: identity.full,
        decision: "allow",
        level,
        ...(by ? { by } : {}),
        ...(requestId ? { requestId } : {}),
      });
      if (level !== "read") {
        this.deps.logger.info(
          `[shadow-core] ${level} tool ${identity.full} allowed for device ${this.info.device}${by ? ` (by ${by})` : ""}`,
        );
      }
      return { allowed: true, level };
    };

    if (turn.abort.signal.aborted) return deny("cancelled");
    if (level === "deny") {
      // Tool name only (the SDK's own guard denies most built-ins before they get here).
      this.note({ kind: "missing_capability", reason: "builtin", tool, turnId: id });
      return deny("builtin");
    }
    if (this.deps.policy.options.readOnly && level !== "read") return deny("read_only");
    if (level === "read" || level === "write") return allow();

    // confirm
    const { request, result } = this.broker.open(id, tool, summarizeToolCall(identity, input));
    const onAbort = () => this.broker.resolve(request.requestId, false, "cancel");
    signal.addEventListener("abort", onAbort, { once: true });
    this.emit({ type: "state", state: "awaiting_confirm" });
    this.emit({
      type: "confirm_request",
      requestId: request.requestId,
      id,
      tool,
      summary: request.summary,
      expiresAt: request.expiresAt,
    });
    const res = await result;
    signal.removeEventListener("abort", onAbort);
    if (res.approved) return allow(res.by, request.requestId);
    return deny(res.by === "timeout" ? "timeout" : "declined", res.by, request.requestId);
  }

  private onConfirmResolved(req: ConfirmRequest, res: ConfirmResolution): void {
    const by = res.by === "cancel" ? "button" : res.by; // see ConfirmResolution
    this.emit({ type: "confirm_resolved", requestId: req.requestId, approved: res.approved, by });
    // Back to thinking unless another confirmation is still waiting.
    if (this.turn && this.broker.size === 0) this.emit({ type: "state", state: "thinking" });
  }

  /** Socket closed: stop the running turn, deny pending confirms, stop speech calls. */
  /** Idempotent: every caller gets the same promise, settled once all records are written. */
  close(reason: string): Promise<void> {
    this.closing ??= this.doClose(reason);
    return this.closing;
  }

  private async doClose(reason: string): Promise<void> {
    this.detachNotifications?.();
    this.broker.cancelAll();
    this.closed = true;
    this.turn?.abort.abort();
    this.side.abort();
    for (const a of this.transcribing.values()) a.abort();
    // Let the aborted turn write its final records before session_end.
    if (this.turnDone) await this.turnDone.catch(() => {});
    // Tails (usage at `settled`, timing) normally end within milliseconds of a cancel; never wait long.
    if (this.tails.size > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([...this.tails]),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, TAIL_WAIT_MS);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    }
    await this.slog.append({ kind: "session_end", reason });
    await this.slog.flush();
  }
}

/** The `memory` frame (docs/06 §Protocol) from a store snapshot: ids and texts only, no keywords or provenance. */
export function memoryFrame(id: string, snap: MemorySnapshot): MemoryFrame {
  return {
    type: "memory",
    id,
    brief: { chars: snap.brief.chars, budget: snap.brief.budget, entries: snap.brief.entries.map((e) => ({ id: e.id, text: e.text })) },
    topics: snap.topics.map((t) => ({
      topic: t.topic,
      title: t.title,
      chars: t.chars,
      entries: t.entries.map((e) => ({ id: e.id, text: e.text, updatedAt: e.updatedAt })),
    })),
    warnings: snap.warnings.map((w) => (w.topic ? { code: w.code, topic: w.topic } : { code: w.code })),
  };
}

// ---------------------------------------------------------------------------
// Development tab (T7.w.4b; docs/08 §T7.w.4, docs/02 §Development)

/** Where the tab's items come from; each source is optional (learning off = no rules). */
export interface DevelopmentSources {
  rules?: Pick<LearnedRuleStore, "list" | "activate" | "reject" | "remove">;
  /** `dev-notes/tools.json` (MCP gateway's tool lists). */
  toolNotes?: Pick<DevNotes, "read" | "setStatus">;
  /** `dev-notes/turns.json` (T7.w.3). */
  turnNotes?: Pick<TurnNotes, "read" | "setStatus">;
  /** CORE_DEV_DEVICES: devices that may `add_rule` / `remove_rule`; empty = nobody (fail closed). */
  managers: readonly string[];
  logger: Logger;
  /** Delay that coalesces `changed()` calls into one recount. Default DEV_RECOUNT_MS. */
  recountMs?: number;
}

export type DevActResult = { ok: true } | { ok: false; code: Extract<ErrorCode, "unknown_item" | "not_allowed" | "internal">; message: string };

/** Device names `LearnedRuleStore.activate()` / `remove()` store as `activatedBy` / `removedBy` (its NAME_RE). */
const ACTIVATING_DEVICE_RE = /^[A-Za-z0-9_.-]{1,128}$/;

/** `changed()` calls within this many ms cause one recount (and at most one `dev_count`). */
export const DEV_RECOUNT_MS = 500;

/** Learned-rule statuses the tab lists (observing, rejected and blocked entries are not shown). */
const LISTED_RULE_STATUSES: ReadonlySet<string> = new Set(["candidate", "active", "suspended"]);
const RULE_MESSAGES: Record<string, string> = {
  candidate: "öğrenilen kural adayı: onay bekliyor",
  active: "öğrenilen kural etkin",
  suspended: "öğrenilen kural askıya alındı",
};

/** Opaque item ids: `r-<rule id>`, `t-<hash>` (tools.json), `n-<hash>` (turns.json). The hash is of the note's key. */
const ruleItemId = (id: string) => `r-${id}`;
const noteItemId = (prefix: "t" | "n", key: string) => `${prefix}-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;

interface NoteLike {
  kind: string;
  message: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
  status?: NoteStatus;
}

function noteItem(itemId: string, n: NoteLike): DevItem {
  return {
    itemId,
    type: "note",
    kind: n.kind,
    status: n.status ?? "open",
    message: n.message,
    count: n.count,
    firstSeen: n.firstSeen,
    lastSeen: n.lastSeen,
  };
}

function ruleItem(r: LearnedRuleRecord): DevItem {
  return {
    itemId: ruleItemId(r.id),
    type: "rule",
    kind: "learned_rule",
    status: r.status,
    message: RULE_MESSAGES[r.status] ?? "",
    count: r.observations,
    firstSeen: r.firstSeen,
    lastSeen: r.lastSeen,
    // The rule file has no number range (it is optional in the frame).
    rule: { tokens: [...r.tokens], tool: r.tool, domains: [...r.domains], observations: r.observations },
  };
}

/**
 * The Development tab over the learned-rule store and both dev-note files:
 * listing, the four actions, and the badge count (`open` = rule candidates
 * + suspended rules + open notes; active rules are listed, not counted). One instance serves every socket; the
 * count goes to `subscribe()` listeners (the server's `dev_count` broadcast)
 * whenever it changes. Display only: items carry the fields of the files.
 */
export class DevelopmentTab {
  private readonly managers: ReadonlySet<string>;
  private readonly listeners = new Set<(open: number) => void>();
  private lastOpen: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Serializes views so a count is never published out of order. */
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly o: DevelopmentSources) {
    this.managers = new Set(o.managers);
  }

  /** Whether `device` may use `add_rule` / `remove_rule` (CORE_DEV_DEVICES; unset = nobody). */
  canManage(device: string): boolean {
    return this.managers.has(device);
  }

  /** Last published badge count; undefined before the first view. */
  get open(): number | undefined {
    return this.lastOpen;
  }

  /** Called with the new count whenever it changes. Returns the unsubscribe function. */
  subscribe(listener: (open: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Something the tab lists may have changed: recount soon (coalesced). Never throws. */
  changed(): void {
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.view().catch((err: unknown) => this.o.logger.warn(`[shadow-core] development count failed: ${(err as Error)?.name ?? "error"}`));
    }, this.o.recountMs ?? DEV_RECOUNT_MS);
    this.timer.unref?.();
  }

  /** Stops pending recounts and drops the listeners (shutdown). */
  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.listeners.clear();
  }

  /** The current items and badge count; publishes the count if it changed. */
  view(): Promise<{ items: DevItem[]; open: number }> {
    const run = this.chain.then(async () => {
      const v = await this.collect();
      this.publish(v.open);
      return v;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  /**
   * One action by `device` (from its token). Idempotent: an action whose
   * result is already in place (`add_rule` on an active rule, `ignore` or
   * `remove_rule` on a rejected one, the same note status again) succeeds
   * without a change. `ignore` rejects a candidate or a suspended rule, never
   * an active one; `remove_rule` rejects an active rule only (T7.w.8).
   */
  async act(device: string, itemId: string, action: DevAction): Promise<DevActResult> {
    if (action === "add_rule" && !this.canManage(device)) {
      return { ok: false, code: "not_allowed", message: "this device may not add rules (CORE_DEV_DEVICES)" };
    }
    if (action === "remove_rule" && !this.canManage(device)) {
      return { ok: false, code: "not_allowed", message: "this device may not remove rules (CORE_DEV_DEVICES)" };
    }
    if (itemId.startsWith("r-")) return this.actOnRule(device, itemId, action);
    if (itemId.startsWith("t-") || itemId.startsWith("n-")) return this.actOnNote(device, itemId, action);
    return unknownItem();
  }

  private async actOnRule(device: string, itemId: string, action: DevAction): Promise<DevActResult> {
    const rules = this.o.rules;
    if (!rules) return unknownItem();
    const find = async () => (await rules.list()).find((r) => ruleItemId(r.id) === itemId);
    const rule = await find();
    if (!rule) return unknownItem();
    const listed = LISTED_RULE_STATUSES.has(rule.status);
    const notValid = (): DevActResult => (listed ? notAllowed() : unknownItem());
    switch (action) {
      case "add_rule": {
        if (rule.status === "active") return { ok: true };
        // A candidate ("Kuralı ekle") or a suspended rule ("Yeniden aç", T7.w.8); both re-validated by the store.
        if (rule.status !== "candidate" && rule.status !== "suspended") return notValid();
        // The store keeps `activatedBy` only in this form; say so instead of blaming router.yaml.
        if (!ACTIVATING_DEVICE_RE.test(device)) {
          return { ok: false, code: "not_allowed", message: "this device name cannot be stored as the approving device" };
        }
        const r = await rules.activate(rule.id, device);
        if (r.ok) {
          const verb = rule.status === "suspended" ? "re-opened" : "activated";
          this.o.logger.info(`[shadow-core] learned rule ${rule.id} ${verb} by device ${device}`);
          return { ok: true };
        }
        if (r.reason === "not_candidate") return (await find())?.status === "active" ? { ok: true } : notAllowed();
        if (r.reason === "unknown") return unknownItem();
        if (r.reason === "not_allowed") return { ok: false, code: "not_allowed", message: "the rule is no longer allowed by router.yaml" };
        return { ok: false, code: "internal", message: "the rule could not be stored" };
      }
      case "ignore": {
        if (rule.status === "rejected") return { ok: true };
        // Candidates and suspended rules; an active rule is removed with `remove_rule` (CORE_DEV_DEVICES only).
        if (rule.status !== "candidate" && rule.status !== "suspended") return notValid();
        if (await rules.reject(rule.id)) {
          this.o.logger.info(`[shadow-core] learned rule ${rule.id} rejected by device ${device}`);
          return { ok: true };
        }
        return (await find())?.status === "rejected" ? { ok: true } : notAllowed();
      }
      case "remove_rule": {
        // Already rejected (removed, or ignored earlier): the result is in place.
        if (rule.status === "rejected") return { ok: true };
        // Active rules only; a candidate or a suspended rule is "Yok say" (`ignore`).
        if (rule.status !== "active") return notValid();
        if (!ACTIVATING_DEVICE_RE.test(device)) {
          return { ok: false, code: "not_allowed", message: "this device name cannot be stored as the removing device" };
        }
        const r = await rules.remove(rule.id, device);
        if (r.ok) {
          this.o.logger.info(`[shadow-core] learned rule ${rule.id} removed by device ${device}`);
          return { ok: true };
        }
        if (r.reason === "not_active") return (await find())?.status === "rejected" ? { ok: true } : notAllowed();
        if (r.reason === "unknown") return unknownItem();
        if (r.reason === "not_allowed") {
          return { ok: false, code: "not_allowed", message: "this device name cannot be stored as the removing device" };
        }
        return { ok: false, code: "internal", message: "the rule could not be stored" };
      }
      case "fixed":
        return notValid();
    }
  }

  private async actOnNote(device: string, itemId: string, action: DevAction): Promise<DevActResult> {
    const found = await this.findNote(itemId);
    if (!found) return unknownItem();
    if (action === "add_rule" || action === "remove_rule") return notAllowed();
    const status: NoteStatus = action === "ignore" ? "ignored" : "fixed";
    if (!(await found.set(status))) return unknownItem();
    this.o.logger.info(`[shadow-core] dev-note ${itemId} marked ${status} by device ${device}`);
    return { ok: true };
  }

  private async findNote(itemId: string): Promise<{ set: (s: NoteStatus) => Promise<boolean> } | undefined> {
    if (itemId.startsWith("t-") && this.o.toolNotes) {
      const src = this.o.toolNotes;
      for (const n of (await src.read()).notes) {
        const key = toolNoteKey(n);
        if (noteItemId("t", key) === itemId) return { set: (s) => src.setStatus(key, s) };
      }
    }
    if (itemId.startsWith("n-") && this.o.turnNotes) {
      const src = this.o.turnNotes;
      for (const n of (await src.read()).notes) {
        const key = turnNoteKey(n);
        if (noteItemId("n", key) === itemId) return { set: (s) => src.setStatus(key, s) };
      }
    }
    return undefined;
  }

  private async collect(): Promise<{ items: DevItem[]; open: number }> {
    const [rules, tools, turns] = await Promise.all([
      this.o.rules ? this.o.rules.list() : Promise.resolve([]),
      this.o.toolNotes ? this.o.toolNotes.read().then((f) => f.notes) : Promise.resolve([]),
      this.o.turnNotes ? this.o.turnNotes.read().then((f) => f.notes) : Promise.resolve([]),
    ]);
    const ruleItems = rules.filter((r) => LISTED_RULE_STATUSES.has(r.status)).map(ruleItem);
    const noteItems = [
      ...tools.map((n) => noteItem(noteItemId("t", toolNoteKey(n)), n)),
      ...turns.map((n) => noteItem(noteItemId("n", turnNoteKey(n)), n)),
    ].sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
    const open =
      ruleItems.filter((i) => i.status === "candidate" || i.status === "suspended").length +
      noteItems.filter((i) => i.status === "open").length;
    return { items: [...ruleItems, ...noteItems], open };
  }

  private publish(open: number): void {
    if (open === this.lastOpen) return;
    this.lastOpen = open;
    for (const l of [...this.listeners]) {
      try {
        l(open);
      } catch {
        // a listener must not break the count
      }
    }
  }
}

function unknownItem(): DevActResult {
  return { ok: false, code: "unknown_item", message: "unknown development item" };
}

function notAllowed(): DevActResult {
  return { ok: false, code: "not_allowed", message: "this action is not valid for the item" };
}

// ---------------------------------------------------------------------------
// Notifications (T7.w.5b; docs/08 §T7.w.5 Delivery, docs/02 §Notifications)

/** One authenticated socket as the notification center sees it. */
export interface NotificationListener {
  readonly sessionId: string;
  /** From the token. */
  readonly device: string;
  /** Whether the client has speech on (`speech_prefs` enabled); only such a socket is asked to speak. */
  speaks(): boolean;
  deliver(frame: ServerFrame): void;
}

/** While the notifications file cannot be read, the center tries to read it again this often (T7.w.13). */
export const NOTIFICATIONS_RETRY_MS = 60_000;

export interface NotificationCenterOptions {
  store: Pick<NotificationStore, "raise" | "resolve" | "get" | "markRead" | "markUnread" | "delete" | "list" | "unreadCount" | "flush">;
  logger: Logger;
  /** Default NOTIFICATIONS_RETRY_MS. */
  retryMs?: number;
  /** Timer for the retry (tests: a fake fired by hand). Returns a cancel function. Default: setTimeout, unref'd. */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /**
   * Quiet hours for urgent speech (T7.w.11.9): inside the window no socket is asked to speak.
   * Default none (never quiet); the Core passes CORE_QUIET_HOURS (default 00:00-09:00).
   */
  quietHours?: QuietHours | null;
  /** Clock for the quiet-hours check (tests: a fake). Default: the real local time. */
  now?: () => Date;
}

/** The retry never keeps the process alive; shutdown calls close(). */
const unrefRetryTimer = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

export type NotificationActResult = { ok: true } | { ok: false; code: Extract<ErrorCode, "unknown_item">; message: string };

/** The item as clients see it: the stored fields without the producer's dedupe `key`. */
export function notificationInfo(item: NotificationItem): NotificationInfo {
  return {
    id: item.id,
    source: item.source,
    urgency: item.urgency,
    title: item.title,
    body: item.body,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    readAt: item.readAt,
    raised: item.raised,
  };
}

/**
 * The one inbox of the home over the notification store: the producer API
 * (`raise` / `resolve`), the user's list and actions, and the broadcasts.
 * Every change goes to every attached socket as `notification` (new or
 * changed) or `notification_removed`. One instance serves every socket; all
 * changes run on one chain, so broadcasts follow the store's order.
 *
 * Urgent speech: when an urgent item is raised (new, or raised again with
 * `renotify`), exactly one socket gets `speak: true`: among the sockets with
 * speech on, the one whose device had the most recent turn (ties: the
 * socket's own latest turn, then the newest socket).
 *
 * Pending speech (T7.w.11.4, docs/09): when no socket has speech on at that
 * raise, the item id is kept (in memory only). The next socket that turns
 * speech on (`speechOn()`) gets `notification {item, speak: true}` for each
 * pending item that still exists and is still urgent and unread, then the set
 * is empty, so each is spoken once, on one socket. Read, delete and resolve
 * cancel it. Nothing else speaks: a `notifications` list never carries
 * `speak`, and an item already spoken is not spoken on a reconnect.
 *
 * Quiet hours (T7.w.11.9, `quietHours`): inside the window an urgent item is
 * raised and broadcast but no socket gets `speak: true`; it is pending speech,
 * and a `speechOn()` inside the window speaks nothing and keeps the ids. After
 * the window the next `speechOn()` speaks them once (see `canSpeak`).
 *
 * While the store cannot read its file, `list()`, `act()` and `resolve()`
 * reject with NotificationsUnavailableError (the session answers
 * `notifications_unavailable`), `raise()` answers `unavailable`, `unread`
 * keeps its last value and `unavailable` is true (/health `inbox`, T7.w.12)
 * until a later call reads the file again (`refresh()`, `list()`, an action, a producer call).
 * While `unavailable` is true the center itself calls `refresh()` once per
 * `retryMs` (T7.w.13), so the flag clears without a client or producer;
 * `close()` (shutdown) stops it.
 */
export class NotificationCenter {
  /** Attached sockets → attach order. */
  private readonly listeners = new Map<NotificationListener, number>();
  /** Order of the latest turn per device and per socket. */
  private readonly deviceTurns = new Map<string, number>();
  private readonly sessionTurns = new Map<string, number>();
  /** One counter for attach and turn order (no clock ties). */
  private seq = 0;
  /** Ids of urgent items raised while no socket could speak them, in raise order (T7.w.11.4). In memory only. */
  private readonly pendingSpeech = new Set<string>();
  private lastUnread = 0;
  /** The last store call could not read the file (cleared by the next one that could). */
  private lastUnavailable = false;
  /** Serializes store calls, their broadcasts and the unread count. */
  private chain: Promise<unknown> = Promise.resolve();
  /** Cancels the scheduled retry read; undefined when none is scheduled. */
  private cancelRetry: (() => void) | undefined;
  private closed = false;

  constructor(private readonly o: NotificationCenterOptions) {}

  /** Unread items after the last change (sync, for /health `inbox`); `refresh()` once at startup. */
  get unread(): number {
    return this.lastUnread;
  }

  /**
   * The notifications file could not be read on the last attempt (sync, for /health
   * `inbox.notificationsUnavailable`): `unread` is then a stale count (startup: 0), not "nothing unread".
   */
  get unavailable(): boolean {
    return this.lastUnavailable;
  }

  /**
   * The notification fields of GET /health `inbox` (loopback only): `notifications` is the
   * unread count as before; `notificationsUnavailable` (T7.w.12) tells a stale count apart from a real 0.
   */
  healthInbox(): { notifications: number; notificationsUnavailable: boolean } {
    return { notifications: this.lastUnread, notificationsUnavailable: this.lastUnavailable };
  }

  /** Re-reads the unread count from the store. Never rejects: an unreadable file keeps the last count (startup: 0) and sets `unavailable`. */
  refresh(): Promise<number> {
    return this.serial(() => this.recount()).catch(() => this.lastUnread);
  }

  /** Starts the broadcasts to one socket. Returns the detach function (socket closed). */
  attach(listener: NotificationListener): () => void {
    this.listeners.set(listener, ++this.seq);
    return () => {
      this.listeners.delete(listener);
      this.sessionTurns.delete(listener.sessionId);
    };
  }

  /** A turn started on `device` (socket `sessionId`): that device speaks the next urgent item. */
  turnStarted(device: string, sessionId: string): void {
    const n = ++this.seq;
    this.deviceTurns.set(device, n);
    this.sessionTurns.set(sessionId, n);
  }

  /**
   * Producer API: creates an item or updates the keyed one (NotificationStore.raise) and broadcasts it.
   * Only a new urgent item, or an urgent raise with `renotify`, is spoken: a producer that raises a
   * keyed item again as urgent (e.g. normal → urgent) must pass `renotify: true` to have it spoken.
   */
  raise(input: RaiseInput): Promise<RaiseResult> {
    return this.serial(async () => {
      const r = await this.o.store.raise(input);
      if (!r.ok) {
        if (r.reason === "unavailable") this.lastUnavailable = true;
        else await this.settle();
        return r;
      }
      const speak = r.item.urgency === "urgent" && (r.created || input.renotify === true);
      const speaker = speak ? this.speaker() : undefined;
      if (speak && !speaker) this.pendingSpeech.add(r.item.id);
      else if (speaker) this.pendingSpeech.delete(r.item.id); // spoken now; an older pending entry is used up
      this.broadcast({ type: "notification", item: notificationInfo(r.item) }, speaker);
      await this.recount();
      return r;
    });
  }

  /**
   * Producer API: removes the keyed item (the condition is over) and broadcasts the removal. Resolves whether one was removed;
   * rejects with NotificationsUnavailableError when the file cannot be read (the producer retries later).
   */
  resolve(source: string, key: string): Promise<boolean> {
    return this.serial(async () => {
      const item = await this.o.store.resolve(source, key);
      if (!item) {
        await this.settle();
        return false;
      }
      this.pendingSpeech.delete(item.id);
      this.broadcast({ type: "notification_removed", notificationId: item.id });
      await this.recount();
      return true;
    });
  }

  /**
   * `listener` turned speech on (its first `speech_prefs` with `enabled:true`
   * after `welcome`, or on again after off): it alone gets
   * `notification {item, speak: true}` for each item pending speech that
   * still exists and is still urgent and unread (oldest raise first); every
   * pending id is then used up (spoken or dropped), so a second socket speaks
   * nothing. A listener that is detached or no longer speaks consumes nothing.
   * While the file cannot be read the ids stay pending. Never rejects.
   */
  speechOn(listener: NotificationListener): Promise<void> {
    if (this.pendingSpeech.size === 0) return Promise.resolve();
    return this.serial(async () => {
      for (const id of [...this.pendingSpeech]) {
        // Checked again after each read: the socket may close or turn speech off meanwhile.
        if (!this.listeners.has(listener) || !this.canSpeak(listener)) return;
        const item = await this.o.store.get(id);
        if (!this.listeners.has(listener) || !this.canSpeak(listener)) return;
        if (!this.pendingSpeech.delete(id)) continue;
        if (!item || item.urgency !== "urgent" || item.readAt !== null) continue;
        safe(() => listener.deliver({ type: "notification", item: notificationInfo(item), speak: true }), undefined);
      }
      await this.settle();
    }).catch(() => {});
  }

  /** All items (most recently updated first) and the unread count. */
  list(): Promise<{ items: NotificationInfo[]; unread: number }> {
    return this.serial(async () => {
      const items = await this.o.store.list(notificationInfo);
      const unread = items.filter((i) => i.readAt === null).length;
      // The file was read: this is the current count (also after an unreadable spell).
      this.lastUnread = unread;
      this.lastUnavailable = false;
      return { items, unread };
    });
  }

  /**
   * One user action by `device` (from its token). `read` / `unread` are
   * idempotent (no broadcast when nothing changed); `delete` of an unknown
   * or already deleted item is `unknown_item`.
   */
  act(device: string, notificationId: string, action: NotificationAction): Promise<NotificationActResult> {
    return this.serial(async () => {
      const r = await this.actOnStore(device, notificationId, action);
      // Every answer here read the file; one that changed nothing has not recounted yet.
      await this.settle();
      return r;
    });
  }

  /** `act()` on the chain: the store call, its broadcast and the recount of a change. */
  private async actOnStore(device: string, notificationId: string, action: NotificationAction): Promise<NotificationActResult> {
    if (action === "delete") {
      if (!(await this.o.store.delete(notificationId))) return unknownNotification();
      this.pendingSpeech.delete(notificationId);
      this.o.logger.info(`[shadow-core] notification ${notificationId} deleted by device ${device}`);
      this.broadcast({ type: "notification_removed", notificationId });
      await this.recount();
      return { ok: true };
    }
    const before = await this.o.store.get(notificationId);
    if (!before) return unknownNotification();
    const after = action === "read" ? await this.o.store.markRead(notificationId) : await this.o.store.markUnread(notificationId);
    if (!after) return unknownNotification();
    // Read on any device cancels pending speech; marking it unread again does not bring it back.
    if (action === "read") this.pendingSpeech.delete(notificationId);
    if (after.readAt !== before.readAt) {
      this.broadcast({ type: "notification", item: notificationInfo(after) });
      await this.recount();
    }
    return { ok: true };
  }

  /** Waits for the changes in flight, then retries a failed store write (shutdown). Never rejects. */
  flush(): Promise<void> {
    return this.serial(() => this.o.store.flush()).catch(() => {});
  }

  /** Stops the retry read (shutdown); no new one is scheduled afterwards. Calls still work. */
  close(): void {
    this.closed = true;
    this.stopRetry();
  }

  /**
   * After every call on the chain: while the file is unreadable, keep one
   * retry read scheduled (`refresh()`, which comes back here); once it could
   * be read, cancel it.
   */
  private syncRetry(): void {
    if (!this.lastUnavailable || this.closed) {
      this.stopRetry();
      return;
    }
    if (this.cancelRetry) return;
    try {
      this.cancelRetry = (this.o.setTimer ?? unrefRetryTimer)(() => {
        this.cancelRetry = undefined;
        void this.refresh();
      }, this.o.retryMs ?? NOTIFICATIONS_RETRY_MS);
    } catch (err) {
      this.o.logger.warn(`[shadow-core] notifications retry not scheduled: ${(err as Error)?.name ?? "error"}`);
    }
  }

  private stopRetry(): void {
    const cancel = this.cancelRetry;
    this.cancelRetry = undefined;
    cancel?.();
  }

  /** The socket that speaks an urgent item now, or undefined (no socket has speech on). */
  private speaker(): NotificationListener | undefined {
    let best: { l: NotificationListener; rank: number[] } | undefined;
    for (const [l, attached] of this.listeners) {
      if (!this.canSpeak(l)) continue;
      const rank = [this.deviceTurns.get(l.device) ?? 0, this.sessionTurns.get(l.sessionId) ?? 0, attached];
      if (!best || compareRank(rank, best.rank) > 0) best = { l, rank };
    }
    return best?.l;
  }

  /**
   * Whether `l` may be asked to speak an urgent item now. The one check for both
   * the raise path (`speaker()`) and pending speech (`speechOn()`).
   *
   * Quiet hours (T7.w.11.9): inside the window nobody speaks. A raise then finds
   * no speaker, so the item goes to the pending-speech set; `speechOn()` stops
   * before using any id up, so the ids stay pending. Nothing is spoken by itself
   * when the window ends: a socket that already has speech on at its end speaks
   * the pending items only when it (or another socket) next turns speech on, or
   * a later urgent raise is spoken by it (that raise only).
   */
  private canSpeak(l: NotificationListener): boolean {
    if (this.quietNow()) return false;
    return safe(() => l.speaks(), false);
  }

  /** Inside the quiet-hours window now. A failing clock counts as not quiet (speech as before T7.w.11.9). */
  private quietNow(): boolean {
    const q = this.o.quietHours;
    if (!q) return false;
    return safe(() => inQuietHours(q, (this.o.now ?? (() => new Date()))()), false);
  }

  private broadcast(frame: ServerFrame, speaker?: NotificationListener): void {
    for (const l of [...this.listeners.keys()]) {
      const out: ServerFrame = l === speaker && frame.type === "notification" ? { ...frame, speak: true } : frame;
      safe(() => l.deliver(out), undefined);
    }
  }

  /**
   * After a call that answered without recounting (nothing changed, unknown id, a full
   * store): if the flag is still set from an unreadable spell, recount now, so /health
   * shows the real count again. A recount that still cannot read leaves the flag set.
   */
  private async settle(): Promise<void> {
    if (!this.lastUnavailable) return;
    try {
      await this.recount();
    } catch (err) {
      if (!(err instanceof NotificationsUnavailableError)) throw err;
    }
  }

  private async recount(): Promise<number> {
    this.lastUnread = await this.o.store.unreadCount();
    this.lastUnavailable = false;
    return this.lastUnread;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch((err: unknown) => {
      // An unreadable file is logged by the store, once per spell (when it becomes unreadable and when it recovers).
      if (err instanceof NotificationsUnavailableError) this.lastUnavailable = true;
      else this.o.logger.warn(`[shadow-core] notifications failed: ${(err as Error)?.name ?? "error"}`);
    }).then(() => this.syncRetry());
    return run;
  }
}

function compareRank(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
  return 0;
}

/** A listener must never break a broadcast or the speaker choice. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function unknownNotification(): NotificationActResult {
  return { ok: false, code: "unknown_item", message: "unknown notification" };
}
