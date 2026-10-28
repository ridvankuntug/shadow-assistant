/**
 * One authenticated WebSocket session: turn handling, permission gate wiring,
 * confirm flow (button / voice / timeout), speech and history.
 *
 * Transport-agnostic: frames come in through `handle()` and go out through
 * the `send` callback, so the whole flow is unit-testable without sockets.
 */
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunner, TurnResult } from "./agent.js";
import type { ConversationLog, SessionLog } from "./conversation-log.js";
import { runDirectPlan, type DenyReason, type DirectOutcome, type GatedCall } from "./direct.js";
import type { DirectToolClient } from "./mcp-direct.js";
import {
  ConfirmBroker,
  parseVoiceAnswer,
  summarizeToolCall,
  type ConfirmRequest,
  type ConfirmResolution,
  type PermissionPolicy,
} from "./permissions.js";
import type { ClientFrame, ErrorCode, ServerFrame } from "./protocol.js";
import type { DirectPlan } from "./router-config.js";
import { ESCALATION_MARKER, type ModelTier, type RouteDecision, type Router, type UsageOutcome, type UsageRecord } from "./router.js";
import type { PermissionLevel } from "./services.js";
import type { Lexicon } from "./pronunciation.js";
import { clipForTts, describeVoice, SpeechServiceError, type SttClient, type TtsClient } from "./speech.js";

/** whisper-svc rejects > 25 MB; refuse earlier than that. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const DEFAULT_HISTORY_LIMIT = 20;
export const MAX_HISTORY_LIMIT = 100;
/** Tier-0 exchanges remembered for the model's next turn. */
export const MAX_DIRECT_NOTES = 5;
export const DIRECT_NOTES_HEADER = "(Bilgi: aşağıdaki kısa komutları sistem modelsiz yanıtladı; sen görmedin.)";
/** Prompt for the stronger model when the cheap one escalated after running tools. */
export const ESCALATION_CONTINUE =
  "(Önceki adım bu isteği tamamlayamadı. Yukarıdaki araç sonuçlarını kullan, başarılı olmuş işlemleri tekrarlama ve kullanıcının son isteğini tamamla.)";

const LEVEL_RANK: Record<PermissionLevel, number> = { read: 0, write: 1, confirm: 2 };

/** What the model is told when the gate denies one of its tool calls. */
const DENY_MESSAGES: Record<DenyReason, string> = {
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

export interface SessionDeps {
  agent: AgentRunner;
  policy: PermissionPolicy;
  router: Router;
  stt: SttClient;
  tts: TtsClient;
  log: ConversationLog;
  logger: Logger;
  confirmTimeoutMs?: number;
  /** Tier 0 MCP client; without it every direct plan falls back to the model. */
  direct?: DirectToolClient;
  /** MCP servers loaded per model tier (router.yaml `tierN.services`); absent = all. */
  tierServices?: Partial<Record<ModelTier, readonly string[]>>;
  /** pronunciations.yaml: applied to `speak` text sent to tts-svc only; absent = none. */
  pronunciations?: Lexicon;
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
}

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
  private readonly directNotes: string[] = [];

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
      case "cancel":
        // An utterance still being transcribed must never become a turn.
        this.transcribing.get(frame.id)?.abort();
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
    const turn: ActiveTurn = { id, abort: new AbortController(), text: "" };
    this.turn = turn;
    this.emit({ type: "state", state: "thinking" });
    void this.slog.append({ kind: "user", id, text, source });

    try {
      const decision = await this.deps.router.route({ text, source, device: this.info.device });
      if (decision.tier === 0 && decision.direct) {
        if (await this.runDirect(turn, text, decision, decision.direct)) return;
        // Fallback: the cheap model takes over (nothing was changed in the home).
        await this.runModel(turn, text, { model: decision.model, tier: 1, escalateTo: decision.escalateTo, rule: decision.rule });
        return;
      }
      await this.runModel(turn, text, decision);
    } catch (err) {
      this.deps.logger.warn(`[shadow-core] turn ${id} crashed: ${(err as Error).message}`);
      this.error("model_error", "the model could not complete this turn", id);
    } finally {
      this.broker.cancelAll(id);
      if (this.turn === turn) this.turn = null;
      this.emit({ type: "state", state: "idle" });
    }
  }

  // ------------------------------------------------------------ tier 0

  /** Runs a direct (model-free) plan. Returns false when the turn must fall back to the model. */
  private async runDirect(turn: ActiveTurn, text: string, decision: RouteDecision, plan: DirectPlan): Promise<boolean> {
    const id = turn.id;
    const started = Date.now();
    const tools: string[] = [];
    let outcome: DirectOutcome;
    const client = this.deps.direct;
    if (!client) {
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
    turn.text = outcome.text;
    this.emit({ type: "assistant_delta", id, text: outcome.text });
    this.emit({ type: "assistant_done", id, text: outcome.text });
    void this.slog.append({ kind: "assistant", id, text: outcome.text });
    // The model never saw this exchange; tell it on its next turn.
    this.directNotes.push(`Kullanıcı: ${text}\nShadow: ${outcome.text}`);
    if (this.directNotes.length > MAX_DIRECT_NOTES) this.directNotes.shift();
    this.recordUsage(usage(outcome.status === "done" ? "done" : outcome.status));
    return true;
  }

  /** Prefixes tier-0 exchanges the model has not seen yet (then forgets them). */
  private withDirectNotes(text: string): string {
    if (this.directNotes.length === 0) return text;
    const notes = this.directNotes.splice(0).join("\n");
    return `${DIRECT_NOTES_HEADER}\n${notes}\n\n${text}`;
  }

  // ------------------------------------------------------------ tiers 1-3

  private async runModel(turn: ActiveTurn, text: string, decision: RouteDecision): Promise<void> {
    const id = turn.id;
    const tier: ModelTier = decision.tier === 1 || decision.tier === 3 ? decision.tier : 2;
    const escalateTo = tier === 1 ? decision.escalateTo : undefined;
    const prompt = this.withDirectNotes(text);
    const base = this.sdkSessionId;
    void this.slog.append({ kind: "route", id, tier, model: decision.model, ...(decision.rule ? { rule: decision.rule } : {}) });

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
    if (result.sessionId) this.sdkSessionId = result.sessionId;
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
    if (finalText || cancelled) {
      void this.slog.append({ kind: "assistant", id, text: finalText, ...(cancelled ? { cancelled: true } : {}) });
    }
    this.recordModelUsage(turn, callTier, model, result, cancelled ? "cancelled" : result.error ? "error" : "done");
  }

  /**
   * One model call. Escalatable (tier 1) calls are buffered: their text reaches
   * the client only once it is clear the model did not hand the turn on, so the
   * escalation marker is never shown or spoken.
   */
  private async callModel(
    turn: ActiveTurn,
    o: { prompt: string; model: string; tier: ModelTier; escalatable: boolean; resume?: string },
  ): Promise<{ result: TurnResult; escalate: boolean }> {
    const id = turn.id;
    let buffer = "";
    const live = (chunk: string) => {
      turn.text += chunk;
      if (!turn.abort.signal.aborted) this.emit({ type: "assistant_delta", id, text: chunk });
    };
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
          else live(chunk);
        },
        onToolResult: (_toolUseId, name, isError) => this.toolFinished(id, name, isError),
      },
    );
    if (!o.escalatable) return { result, escalate: false };
    const marked = buffer.includes(ESCALATION_MARKER);
    const escalate = marked && !result.error && !turn.abort.signal.aborted;
    if (!escalate) {
      const clean = buffer.split(ESCALATION_MARKER).join("").trim();
      if (clean) live(clean);
    }
    return { result, escalate };
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

  /** Builds the SDK `canUseTool` callback for one turn. */
  gate(turn: ActiveTurn): CanUseTool {
    return async (toolName, input, opts): Promise<PermissionResult> => {
      const r = await this.authorize(turn, toolName, input, opts.signal);
      return r.allowed
        ? { behavior: "allow", updatedInput: input, toolUseID: opts.toolUseID }
        : { behavior: "deny", message: DENY_MESSAGES[r.reason], toolUseID: opts.toolUseID };
    };
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
    await this.slog.append({ kind: "session_end", reason });
    await this.slog.flush();
  }
}
