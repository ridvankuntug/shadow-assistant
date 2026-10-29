/**
 * One authenticated WebSocket session: turn handling, permission gate wiring,
 * confirm flow (button / voice / timeout), speech and history.
 *
 * Transport-agnostic: frames come in through `handle()` and go out through
 * the `send` callback, so the whole flow is unit-testable without sockets.
 */
// Type-only: agent.ts loads the provider SDK, which session.ts must never do.
import type { AgentRunner, TurnResult } from "./agent.js";
import type { ConversationLog, SessionLog } from "./conversation-log.js";
import type { DeviceRegistry } from "./device-registry.js";
import { runDirectPlan, type DenyReason, type DirectOutcome, type GatedCall } from "./direct.js";
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
import type { ClientFrame, ErrorCode, MemoryFrame, ServerFrame, SpeechMode } from "./protocol.js";
import type { DirectPlan } from "./router-config.js";
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
}

/** Latest `speech_prefs` of the client; absent = no `speech_chunk` frames. */
interface SpeechPrefs {
  mode: SpeechMode;
  voice?: string;
}

/** Messages the model gets for gate denials. */
type GateDeny = DenyReason | "tier_service";

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
      case "speech_prefs":
        this.speechPrefs = frame.enabled ? { mode: frame.mode, ...(frame.voice ? { voice: frame.voice } : {}) } : undefined;
        return;
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
    const turn: ActiveTurn = { id, abort: new AbortController(), text: "", startedAt: Date.now() };
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
        await this.runModel(turn, text, { model: decision.model, tier: 1, escalateTo: decision.escalateTo, rule: decision.rule }, routeMs);
        return;
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
          return { status: "ok", result };
        } catch (err) {
          if (turn.abort.signal.aborted) return { status: "denied", reason: "cancelled" };
          this.toolFinished(id, full, true);
          const message = (err as Error).message;
          this.deps.logger.warn(`[shadow-core] direct ${plan.service}/${tool} failed: ${message}`);
          return { status: "unavailable", message };
        }
      };
      outcome = await runDirectPlan(plan, call, { fallbackOnError: decision.fallbackOnError === true });
    }
    if (turn.abort.signal.aborted) outcome = { kind: "cancelled" };

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
        onToolResult: (_toolUseId, name, isError) => this.toolFinished(id, name, isError),
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
    if (!sent) return true;
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
        callbacks: {
          onDelta: (chunk) => {
            if (o.escalatable) buffer += chunk;
            else this.live(turn, chunk);
          },
          onToolResult: (_toolUseId, name, isError) => this.toolFinished(turn.id, name, isError),
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
  gate(turn: ActiveTurn, services?: readonly string[]): PermissionCallback {
    return async (toolName, input, opts): Promise<PermissionDecision> => {
      const r = services && !this.inTierServices(toolName, services)
        ? this.denyOutsideTier(turn, toolName, input)
        : await this.authorize(turn, toolName, input, opts.signal);
      return r.allowed
        ? { behavior: "allow", updatedInput: input, toolUseID: opts.toolUseID }
        : { behavior: "deny", message: DENY_MESSAGES[r.reason], toolUseID: opts.toolUseID };
    };
  }

  private inTierServices(toolName: string, services: readonly string[]): boolean {
    const service = this.deps.policy.levelFor(toolName).identity.service;
    return service !== undefined && services.includes(service);
  }

  /** Same records as a gate denial, for a tool of a service outside the current tier. */
  private denyOutsideTier(turn: ActiveTurn, toolName: string, input: Record<string, unknown>): { allowed: false; reason: GateDeny } {
    const { identity } = this.deps.policy.levelFor(toolName, input);
    const id = turn.id;
    void this.slog.append({ kind: "tool_call", id, tool: identity.full, level: "deny", reason: "tier_service", input });
    this.emit({ type: "tool", id, name: identity.tool, status: "denied" });
    void this.slog.append({ kind: "permission", id, tool: identity.full, decision: "deny", level: "deny" });
    this.deps.logger.info(`[shadow-core] denied ${identity.full} (not in this tier's services)`);
    return { allowed: false, reason: "tier_service" };
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
  ): Promise<{ allowed: true } | { allowed: false; reason: DenyReason }> {
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

    const deny = (why: DenyReason, by?: string, requestId?: string): { allowed: false; reason: DenyReason } => {
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
      return { allowed: false, reason: why };
    };
    const allow = (by?: string, requestId?: string): { allowed: true } => {
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
      return { allowed: true };
    };

    if (turn.abort.signal.aborted) return deny("cancelled");
    if (level === "deny") return deny("builtin");
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
