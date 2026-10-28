/**
 * Provider-neutral model interface (docs/07-speed.md §A1 Components).
 *
 * Every model call goes through the Core; the Core talks to a model only through
 * these types, so a provider (Claude Agent SDK today; Codex or Ollama later) can be
 * swapped without touching the registry, session, continuity or memory code.
 * Nothing here may import a provider SDK.
 *
 * - `ModelProvider` opens per-device live sessions and runs one-shot background
 *   calls (memory extraction, Core-side compaction summary).
 * - `ProviderSession` is one live conversation: attempts, notes, model switch,
 *   cancel, optional compaction.
 * - Tools stay where they are: the permission gate is passed in per attempt as a
 *   neutral `PermissionCallback`; each provider adapts it to its own mechanism.
 */
import type { TurnCallbacks, TurnResult } from "./agent.js";

export type { TurnCallbacks, TurnResult };

/** The gate's answer for one tool call. */
export type PermissionDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; toolUseID?: string }
  | { behavior: "deny"; message: string; toolUseID?: string };

/** The Core's permission gate for one tool call (provider-neutral). */
export type PermissionCallback = (
  toolName: string,
  input: Record<string, unknown>,
  ctx: { signal: AbortSignal; toolUseID: string },
) => Promise<PermissionDecision>;

/**
 * How an attempt ended.
 * - `ok`: normal answer. `error`: model/API error, text may be partial.
 * - `cancelled`: `interrupt()`, the request signal, or `close()`.
 * - `usage_limit`: the provider's usage limit is reached (`retryAt` when known); no retry, no escalation.
 * - `timeout`: the host time limit passed. `tool_cap`: too many tool calls.
 * - `dead`: the session's backend died mid-attempt.
 */
export type AttemptStatus = "ok" | "error" | "cancelled" | "usage_limit" | "timeout" | "tool_cap" | "dead";

export interface AttemptRequest {
  /** The turn envelope (agent.ts `buildTurnEnvelope`). */
  text: string;
  /** Model for this attempt; the session switches only when it differs from the current one. */
  model: string;
  /** This attempt's permission gate. */
  canUseTool: PermissionCallback;
  callbacks: TurnCallbacks;
  /** Aborting it interrupts the attempt (barge-in / socket close). */
  signal?: AbortSignal;
}

/** Result of one attempt: neutral usage fields come from `TurnResult`. */
export interface AttemptOutcome extends TurnResult {
  status: AttemptStatus;
  /** Model that answered (else the requested model). */
  model: string;
  /** `usage_limit` only: reset time (epoch ms) when known. */
  retryAt?: number;
  /** The session was ready before this attempt was submitted. */
  warm: boolean;
  /** Age of the session when the attempt was submitted (ms). */
  queryAgeMs: number;
  /** Submit → visible end (ms). */
  doneMs: number;
}

export interface AttemptHandle {
  /** User-facing end. Usage fields may still be 0. */
  done: Promise<AttemptOutcome>;
  /** Internal end: usage and cost are final. Never rejects. */
  settled: Promise<AttemptOutcome>;
}

export interface ProviderCapabilities {
  /** Model switch inside a live session (else a model change means a new session). */
  setModel: boolean;
  /** `ProviderSession.compact()` exists; otherwise the Core summarizes and reseeds (06). */
  compact: boolean;
  /** `appendNote()` stores a note without a model call; otherwise the Core prefixes notes to the next prompt. */
  notes: boolean;
  /** A session can be continued by id after a restart (continuity, 07 A4). */
  resume: boolean;
}

export class SessionBusyError extends Error {
  constructor() {
    super("an attempt is already running on this device");
    this.name = "SessionBusyError";
  }
}

export class SessionClosedError extends Error {
  constructor(reason: string) {
    super(`model session is not running: ${reason}`);
    this.name = "SessionClosedError";
  }
}

/** One live conversation of one device with one provider. */
export interface ProviderSession {
  /** `ModelProvider.id`; continuity stores `{ provider, sessionId }`. */
  readonly provider: string;
  readonly sessionId: string | undefined;
  readonly model: string;
  /** An attempt has not reached its visible end (`runAttempt` would throw `SessionBusyError`). */
  readonly busy: boolean;
  readonly isClosed: boolean;
  /** Resolves when the backend is up; rejects if start-up fails. */
  ready(): Promise<void>;
  /** Throws `SessionBusyError` / `SessionClosedError`. */
  runAttempt(req: AttemptRequest): AttemptHandle;
  /** Adds a record to the conversation without a model call; false if the session is gone. */
  appendNote(text: string): Promise<boolean>;
  /** Switches the model for the next attempts (queued behind running work). */
  setModel(model: string): Promise<void>;
  /** Barge-in: interrupts the running attempt. */
  interrupt(): Promise<void>;
  /** Present only when `capabilities.compact`: shrinks the context in place; false on failure. */
  compact?(instructions: string): Promise<boolean>;
  /** Ends the session; in-flight work resolves as `cancelled`. */
  close(): void;
}

export interface OpenSessionOptions {
  device: string;
  model: string;
  /** Session id to continue (only if `capabilities.resume`). */
  resume?: string;
  onSessionId?: (sessionId: string) => void;
  onDead?: (reason: string) => void;
  onIdleClose?: () => void;
}

/** A background call outside any conversation (memory extraction, compaction summary). */
export interface OneShotRequest {
  model: string;
  /** System instructions (optional). */
  system?: string;
  prompt: string;
  /** JSON schema for a structured answer; the result then carries `json`. */
  schema?: Record<string, unknown>;
  maxTokens: number;
  signal?: AbortSignal;
}

export interface OneShotResult {
  status: "ok" | "error" | "cancelled" | "usage_limit";
  text: string;
  /** The structured answer when a schema was given and the provider returned one. */
  json?: unknown;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  /** `usage_limit` only, epoch ms. */
  retryAt?: number;
  error?: string;
  model: string;
}

export interface ModelProvider {
  /** Stable id, e.g. `claude-sdk`. */
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  openSession(o: OpenSessionOptions): ProviderSession;
  oneShot(req: OneShotRequest): Promise<OneShotResult>;
}
