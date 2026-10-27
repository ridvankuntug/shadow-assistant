/**
 * One authenticated WebSocket session: turn handling, permission gate wiring,
 * confirm flow (button / voice / timeout), speech and history.
 *
 * Transport-agnostic: frames come in through `handle()` and go out through
 * the `send` callback, so the whole flow is unit-testable without sockets.
 */
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunner } from "./agent.js";
import type { ConversationLog, SessionLog } from "./conversation-log.js";
import {
  ConfirmBroker,
  parseVoiceAnswer,
  summarizeToolCall,
  type ConfirmRequest,
  type ConfirmResolution,
  type PermissionPolicy,
} from "./permissions.js";
import type { ClientFrame, ErrorCode, ServerFrame } from "./protocol.js";
import type { Router } from "./router.js";
import { SpeechServiceError, type SttClient, type TtsClient } from "./speech.js";

/** whisper-svc rejects > 25 MB; refuse earlier than that. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
export const DEFAULT_HISTORY_LIMIT = 20;
export const MAX_HISTORY_LIMIT = 100;

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
        await this.handleSpeak(frame.id, frame.text);
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

  private async handleSpeak(id: string, text: string): Promise<void> {
    try {
      const { mime, data } = await this.deps.tts.synthesize(text, this.side.signal);
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
      const { model } = await this.deps.router.route({ text, source, device: this.info.device });
      const result = await this.deps.agent.runTurn(
        {
          prompt: text,
          model,
          resume: this.sdkSessionId,
          signal: turn.abort.signal,
          canUseTool: this.gate(turn),
        },
        {
          onDelta: (chunk) => {
            turn.text += chunk;
            if (!turn.abort.signal.aborted) this.emit({ type: "assistant_delta", id, text: chunk });
          },
          onToolResult: (_toolUseId, name, isError) => {
            const tool = this.displayName(name);
            this.emit({ type: "tool", id, name: tool, status: isError ? "error" : "done" });
            void this.slog.append({ kind: "tool_result", id, tool: name ?? "unknown", status: isError ? "error" : "done" });
          },
        },
      );
      if (result.sessionId) this.sdkSessionId = result.sessionId;
      const cancelled = turn.abort.signal.aborted;
      const finalText = result.text || turn.text;

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
      const usage = {
        turnId: id,
        model,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        durationMs: result.durationMs,
        costUsd: result.costUsd,
      };
      void this.slog.append({ kind: "usage", id, ...usage });
      try {
        this.deps.router.onUsage?.(usage);
      } catch (err) {
        this.deps.logger.warn(`[shadow-core] router.onUsage failed: ${(err as Error).message}`);
      }
    } catch (err) {
      this.deps.logger.warn(`[shadow-core] turn ${id} crashed: ${(err as Error).message}`);
      this.error("model_error", "the model could not complete this turn", id);
    } finally {
      this.broker.cancelAll(id);
      if (this.turn === turn) this.turn = null;
      this.emit({ type: "state", state: "idle" });
    }
  }

  /** Tool name shown to the client: service-relative (e.g. `intent__HassTurnOff`). */
  private displayName(full: string | undefined): string {
    if (!full) return "unknown";
    return this.deps.policy.levelFor(full).identity.tool;
  }

  /** Builds the SDK `canUseTool` callback for one turn. */
  gate(turn: ActiveTurn): CanUseTool {
    return async (toolName, input, opts): Promise<PermissionResult> => {
      const decision = this.deps.policy.levelFor(toolName, input);
      const { identity } = decision;
      const tool = identity.tool;
      const id = turn.id;
      void this.slog.append({
        kind: "tool_call",
        id,
        tool: identity.full,
        level: decision.level,
        reason: decision.reason,
        input,
      });

      const deny = (message: string, by?: string, requestId?: string): PermissionResult => {
        this.emit({ type: "tool", id, name: tool, status: "denied" });
        void this.slog.append({
          kind: "permission",
          id,
          tool: identity.full,
          decision: "deny",
          level: decision.level,
          ...(by ? { by } : {}),
          ...(requestId ? { requestId } : {}),
        });
        this.deps.logger.info(`[shadow-core] denied ${identity.full} (${decision.reason}${by ? `, by ${by}` : ""})`);
        return { behavior: "deny", message, toolUseID: opts.toolUseID };
      };
      const allow = (by?: string, requestId?: string): PermissionResult => {
        this.emit({ type: "tool", id, name: tool, status: "started" });
        void this.slog.append({
          kind: "permission",
          id,
          tool: identity.full,
          decision: "allow",
          level: decision.level,
          ...(by ? { by } : {}),
          ...(requestId ? { requestId } : {}),
        });
        if (decision.level !== "read") {
          this.deps.logger.info(
            `[shadow-core] ${decision.level} tool ${identity.full} allowed for device ${this.info.device}${by ? ` (by ${by})` : ""}`,
          );
        }
        return { behavior: "allow", updatedInput: input, toolUseID: opts.toolUseID };
      };

      if (turn.abort.signal.aborted) return deny("Turn was cancelled.");
      if (decision.level === "deny") return deny("Built-in tools are disabled for this assistant.");
      if (this.deps.policy.options.readOnly && decision.level !== "read") {
        return deny("Read-only mode: only read tools may run.");
      }
      if (decision.level === "read" || decision.level === "write") return allow();

      // confirm
      const { request, result } = this.broker.open(id, tool, summarizeToolCall(identity, input));
      const onAbort = () => this.broker.resolve(request.requestId, false, "cancel");
      opts.signal.addEventListener("abort", onAbort, { once: true });
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
      opts.signal.removeEventListener("abort", onAbort);
      if (res.approved) return allow(res.by, request.requestId);
      return deny(
        res.by === "timeout" ? "The user did not confirm in time; do not retry." : "The user declined this action; do not retry.",
        res.by,
        request.requestId,
      );
    };
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
