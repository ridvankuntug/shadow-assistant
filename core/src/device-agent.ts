/**
 * Claude Agent SDK implementation of the provider interface
 * (`model-provider.ts`, docs/07-speed.md §A1): `ClaudeSdkProvider` is the
 * `ModelProvider`, `DeviceAgent` its `ProviderSession`. The Core above uses only
 * the interface; nothing SDK-specific leaks out of this file.
 *
 * DeviceAgent: one long-lived streaming-input SDK `query()` per device. It owns
 * the Claude Code process, its MCP connections and the conversation.
 *
 * Message flow:
 *   - Every sent user message (attempt or `shouldQuery: false` note) yields
 *     exactly one `result` (spike Q2, Q7). Messages are sent strictly one at a
 *     time: the next one only after the previous `result`, so a `result` always
 *     belongs to the one message in flight and nothing is folded into a running
 *     turn. Messages with nothing in flight (stray `user` echoes) are ignored.
 *   - Visible turn end vs `result` (spike Q12): the CLI runs an end-of-turn
 *     summary classifier for ~2 to 2.5 s between the last `message_stop` and
 *     `result`. An attempt therefore has two promises: `done` resolves at the
 *     top-level `message_stop` whose `message_delta` carried `stop_reason:
 *     "end_turn"` (the user-facing end), or at `result` if that comes first;
 *     `settled` resolves at `result` (usage, cost, internal boundary). The next
 *     attempt may be submitted after `done`; it is queued until `settled`.
 *   - Cancel: `interrupt()` → `Query.interrupt()`; the following `result`
 *     (`error_during_execution`, spike Q5) maps to `cancelled`. A watchdog
 *     closes the agent if no `result` follows within `interruptWatchdogMs`.
 *   - Death: the output pump ending or throwing outside `close()` marks the agent
 *     dead; in-flight work resolves with `dead` (partial text kept, nothing is
 *     replayed). The owner (registry) starts a replacement with `resume` set to
 *     `sessionId`, throttled by `RestartBackoff`.
 */
import { randomUUID } from "node:crypto";
import {
  USAGE_LIMIT_ERROR_PREFIXES as SDK_USAGE_LIMIT_PREFIXES,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { TurnStream, type TurnCallbacks } from "./agent.js";
import {
  SessionBusyError,
  SessionClosedError,
  type AttemptHandle,
  type AttemptOutcome,
  type AttemptRequest,
  type AttemptStatus,
  type ModelProvider,
  type OneShotRequest,
  type OneShotResult,
  type OpenSessionOptions,
  type ProviderCapabilities,
  type ProviderSession,
} from "./model-provider.js";

export type { AttemptHandle, AttemptOutcome, AttemptRequest, AttemptStatus };
/** Old names, kept for callers and tests written against S4. */
export { SessionBusyError as DeviceAgentBusyError, SessionClosedError as DeviceAgentDeadError };

export const CLAUDE_SDK_PROVIDER_ID = "claude-sdk";

/**
 * Copy of the SDK's `USAGE_LIMIT_ERROR_PREFIXES` (`@alpha` in 0.3.311). Used if
 * the export disappears; a unit test fails when the SDK list changes.
 */
export const USAGE_LIMIT_PREFIXES_FALLBACK: readonly string[] = [
  "You've hit your",
  "You've reached your",
  "You're out of usage credits",
  "Your org is out of usage · add funds to continue",
  "Your org is out of usage · contact your admin",
  "Your seat type doesn't include usage credits",
  "Your seat type doesn't include usage",
  "Your usage allocation has been disabled by your admin",
  "Your group's usage limit is set to $0",
  "Fable 5 requires usage credits",
  "You're out of extra usage",
  "Your seat type doesn't include extra usage",
];

export const USAGE_LIMIT_PREFIXES: readonly string[] =
  Array.isArray(SDK_USAGE_LIMIT_PREFIXES) && SDK_USAGE_LIMIT_PREFIXES.length > 0
    ? SDK_USAGE_LIMIT_PREFIXES
    : USAGE_LIMIT_PREFIXES_FALLBACK;

export function isUsageLimitText(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.trimStart();
  return USAGE_LIMIT_PREFIXES.some((p) => t.startsWith(p));
}

/** `rate_limit_info.resetsAt` → epoch ms (the CLI reports epoch seconds; ms values pass through). */
export function resetsAtToMs(resetsAt: number | undefined): number | undefined {
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) return undefined;
  return resetsAt < 1e12 ? Math.round(resetsAt * 1000) : Math.round(resetsAt);
}

class SetModelTimeoutError extends Error {
  constructor(ms: number) {
    super(`setModel got no answer within ${ms} ms`);
    this.name = "SetModelTimeoutError";
  }
}

/**
 * Holds back the start of each top-level text block until it can no longer be
 * the start of a usage-limit message (the CLI streams that text like an answer).
 * `pending` buffers, `open` forwards, `limit` drops everything for the attempt.
 */
export class LimitGate {
  private buf = "";
  private state: "pending" | "open" | "limit" = "pending";

  constructor(
    private readonly forward: (text: string) => void,
    private readonly onLimit: () => void,
  ) {}

  get isLimit(): boolean {
    return this.state === "limit";
  }

  /** A new text block starts: check its beginning again. */
  newBlock(): void {
    if (this.state === "limit") return;
    this.flush();
    this.state = "pending";
  }

  push(chunk: string): void {
    if (this.state === "open") return this.forward(chunk);
    if (this.state === "limit") return;
    this.buf += chunk;
    const t = this.buf.trimStart();
    if (t === "") return;
    if (USAGE_LIMIT_PREFIXES.some((p) => t.startsWith(p))) {
      this.state = "limit";
      this.buf = "";
      this.onLimit();
      return;
    }
    if (USAGE_LIMIT_PREFIXES.some((p) => p.startsWith(t))) return; // still ambiguous
    this.flush();
  }

  /** Releases held text (the turn ended without becoming a limit message). */
  flush(): void {
    if (this.state === "limit") return;
    this.state = "open";
    const b = this.buf;
    this.buf = "";
    if (b) this.forward(b);
  }
}

export type QueryFactory = (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;

export interface DeviceAgentOptions {
  device: string;
  /** Initial model (tier 1). */
  model: string;
  /** Session to continue (A4). Without a baseline the first result's `costUsd` is omitted. */
  resume?: string;
  /** Builds the query options (agent.ts `SdkAgentRunner.buildPersistentOptions`). */
  buildOptions: (p: { model: string; resume?: string; canUseTool: CanUseTool; abortController: AbortController }) => Omit<Options, "prompt">;
  /** `query` from the SDK; injected by tests. */
  queryFn: QueryFactory;
  /** Close after this long without an attempt (0 = never). Default 10 min. */
  idleMs?: number;
  /** Host-side limit per attempt, from send to `result`. Default 120 s. */
  turnTimeoutMs?: number;
  /** Close the agent if `interrupt()` gets no `result` within this time. Default 5 s. */
  interruptWatchdogMs?: number;
  /** Close the agent if a `shouldQuery: false` note gets no `result` within this time. Default 10 s. */
  noteTimeoutMs?: number;
  /** Close the agent if `setModel()` gets no answer within this time. Default 10 s. */
  setModelTimeoutMs?: number;
  /** Interrupt an attempt after this many top-level tool calls (defence in depth beside `maxTurns`). Default 12. */
  maxToolCalls?: number;
  /** Check MCP status before an attempt when the previous one is older than `afterMs`. */
  mcpFreshness?: { servers: readonly string[]; afterMs?: number; timeoutMs?: number };
  onSessionId?: (sessionId: string) => void;
  onDead?: (reason: string) => void;
  onIdleClose?: () => void;
  log?: (event: string, detail?: Record<string, unknown>) => void;
  now?: () => number;
}

/** A never-ending input stream for streaming-input mode; `end()` finishes it on close. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | undefined;
  private ended = false;

  push(m: SDKUserMessage): void {
    if (this.ended) return;
    const w = this.waiter;
    if (w) {
      this.waiter = undefined;
      w({ value: m, done: false });
    } else {
      this.items.push(m);
    }
  }

  end(): void {
    this.ended = true;
    const w = this.waiter;
    this.waiter = undefined;
    w?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const m = this.items.shift();
        if (m) return Promise.resolve({ value: m, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiter = resolve));
      },
      return: () => {
        this.end();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

interface Attempt {
  kind: "attempt";
  req: AttemptRequest;
  stream: TurnStream;
  gate: LimitGate;
  submittedAt: number;
  warm: boolean;
  queryAgeMs: number;
  sent: boolean;
  visibleDone: boolean;
  settled: boolean;
  /** Why the host stopped it; decides the status of the interrupted `result`. */
  stopReason?: "cancelled" | "timeout" | "tool_cap";
  toolCalls: number;
  model?: string;
  lastStopReason?: string | null;
  rateLimitRejected: boolean;
  resetsAt?: number;
  assistantRateLimit: boolean;
  usageLimitText: boolean;
  costUsd?: number;
  done: ReturnType<typeof deferred<AttemptOutcome>>;
  settledP: ReturnType<typeof deferred<AttemptOutcome>>;
  visibleOutcome?: AttemptOutcome;
  turnTimer?: NodeJS.Timeout;
  watchdog?: NodeJS.Timeout;
  onAbort?: () => void;
}

interface Note {
  kind: "note";
  text: string;
  result: ReturnType<typeof deferred<boolean>>;
  timer?: NodeJS.Timeout;
}

type Slot = Attempt | Note;

const CANCELLED_DENY: PermissionResult = { behavior: "deny", message: "Turn was cancelled." };

function userMessage(text: string, shouldQuery: boolean): SDKUserMessage {
  return {
    type: "user",
    message: { role: "user", content: text },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    ...(shouldQuery ? {} : { shouldQuery: false }),
  } as SDKUserMessage;
}

export class DeviceAgent implements ProviderSession {
  readonly provider = CLAUDE_SDK_PROVIDER_ID;
  readonly device: string;
  private readonly opts: DeviceAgentOptions;
  private readonly now: () => number;
  private readonly input = new InputQueue();
  private readonly abortController = new AbortController();
  private readonly q: Query;
  private readonly startedAt: number;
  private readonly readyP: Promise<void>;
  private initialized = false;
  private currentModel: string;
  private sessionIdValue: string | undefined;
  /** Previous cumulative `total_cost_usd` of this query; undefined after a resume until the first result. */
  private costBaseline: number | undefined;
  /** A total below the baseline (zeroed error result, or the start of a real counter reset). */
  private lowTotal: number | undefined;
  /** Serial send chain: one message in flight at a time. */
  private chain: Promise<void> = Promise.resolve();
  /** The message whose `result` is awaited. */
  private inflight: Slot | undefined;
  /** The attempt the user is waiting for (submitted, not visibly done). Enforces one at a time. */
  private active: Attempt | undefined;
  private readonly queued = new Set<Slot>();
  private pendingGateCalls = 0;
  private lastAttemptAt: number | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private closing = false;
  private deadReason: string | undefined;

  constructor(opts: DeviceAgentOptions) {
    this.opts = opts;
    this.device = opts.device;
    this.now = opts.now ?? Date.now;
    this.currentModel = opts.model;
    this.sessionIdValue = opts.resume;
    this.costBaseline = opts.resume ? undefined : 0;
    this.startedAt = this.now();
    const options = opts.buildOptions({
      model: opts.model,
      resume: opts.resume,
      canUseTool: this.dispatch,
      abortController: this.abortController,
    });
    this.q = opts.queryFn({ prompt: this.input, options: { ...options, abortController: this.abortController } as Options });
    // Readiness for prewarm = `initializationResult()` (spike Q1: `system/init`
    // repeats per turn and is not sent before the first message).
    this.readyP = Promise.resolve()
      .then(() => this.q.initializationResult())
      .then(
        () => {
          this.initialized = true;
        },
        (err: unknown) => {
          if (!this.closing) this.die(`init failed: ${(err as Error)?.message ?? String(err)}`);
          throw err;
        },
      );
    this.readyP.catch(() => {});
    void this.pump();
    this.armIdle();
  }

  /** Last `session_id` seen (or the resumed one); the continuity pointer. */
  get sessionId(): string | undefined {
    return this.sessionIdValue;
  }

  get model(): string {
    return this.currentModel;
  }

  get isDead(): boolean {
    return this.deadReason !== undefined;
  }

  get isClosed(): boolean {
    return this.closing || this.isDead;
  }

  /** An attempt is waiting for its visible end (a new `runAttempt` would throw busy). */
  get busy(): boolean {
    return this.active !== undefined;
  }

  /** Resolves when the process is up and MCP is connected; rejects if start-up fails. */
  ready(): Promise<void> {
    return this.readyP;
  }

  /**
   * Sends one attempt. Throws `DeviceAgentBusyError` while another attempt has not
   * reached its visible end, `DeviceAgentDeadError` after death or close.
   */
  runAttempt(req: AttemptRequest): AttemptHandle {
    if (this.closing || this.deadReason !== undefined) throw new SessionClosedError(this.deadReason ?? "closed");
    if (this.active) throw new SessionBusyError();
    const now = this.now();
    const cb = this.safeCallbacks(req.callbacks);
    const gate = new LimitGate(cb.onDelta, () => (a.usageLimitText = true));
    const a: Attempt = {
      kind: "attempt",
      req,
      stream: new TurnStream({ ...cb, onDelta: (t) => gate.push(t) }),
      gate,
      submittedAt: now,
      warm: this.initialized,
      queryAgeMs: now - this.startedAt,
      sent: false,
      visibleDone: false,
      settled: false,
      toolCalls: 0,
      rateLimitRejected: false,
      assistantRateLimit: false,
      usageLimitText: false,
      done: deferred<AttemptOutcome>(),
      settledP: deferred<AttemptOutcome>(),
    };
    this.active = a;
    this.clearIdle();
    if (req.signal) {
      a.onAbort = () => void this.interruptAttempt(a, "cancelled");
      if (req.signal.aborted) a.stopReason = "cancelled";
      else req.signal.addEventListener("abort", a.onAbort, { once: true });
    }
    this.enqueue(a, () => this.sendAttempt(a));
    return { done: a.done.promise, settled: a.settledP.promise };
  }

  /**
   * Appends a tier-0 exchange to the transcript without a model call
   * (`shouldQuery: false`, spike Q7). Queued behind running work; resolves
   * true once its own `result` arrived, false if the agent is gone.
   */
  appendNote(text: string): Promise<boolean> {
    if (this.closing || this.deadReason !== undefined) return Promise.resolve(false);
    const n: Note = { kind: "note", text, result: deferred<boolean>() };
    this.enqueue(n, () => this.sendNote(n));
    return n.result.promise;
  }

  /**
   * Switches the model for the following attempts, queued behind running work.
   * `runAttempt` switches by itself; this is for callers that switch ahead.
   */
  setModel(model: string): Promise<void> {
    if (this.closing || this.deadReason !== undefined) return Promise.reject(new SessionClosedError(this.deadReason ?? "closed"));
    const p = this.chain.then(() => {
      if (this.closing || this.deadReason !== undefined) throw new SessionClosedError(this.deadReason ?? "closed");
      return this.switchModel(model);
    });
    this.chain = p.catch((err: unknown) => {
      if (err instanceof SetModelTimeoutError) this.die(err.message);
    });
    return p;
  }

  /** Barge-in: interrupts the attempt that has not reached its visible end. */
  async interrupt(): Promise<void> {
    const a = this.active;
    if (a) await this.interruptAttempt(a, "cancelled");
  }

  /** Ends the process (idle close, shutdown). In-flight work resolves as `cancelled`. */
  close(): void {
    if (this.closing) return;
    this.closing = true;
    this.clearIdle();
    this.finishAll("cancelled", "agent closed");
    this.input.end();
    try {
      this.q.close();
    } catch {
      // already gone
    }
    this.abortController.abort();
  }

  // --- internals -----------------------------------------------------------

  private enqueue(slot: Slot, send: () => Promise<void>): void {
    this.queued.add(slot);
    this.chain = this.chain.then(async () => {
      this.queued.delete(slot);
      if (this.closing || this.deadReason !== undefined) return;
      try {
        await send();
      } catch (err) {
        this.log("send_failed", { error: (err as Error)?.message ?? String(err) });
      }
    });
  }

  private async sendAttempt(a: Attempt): Promise<void> {
    if (a.stopReason && !a.settled) this.settleAttempt(a, a.stopReason); // cancelled before it was sent
    if (a.settled) return; // nothing reaches the model
    await this.ensureMcpFresh();
    try {
      await this.switchModel(a.req.model);
    } catch (err) {
      // A hung control call means a hung process: die() resolves this and every queued attempt.
      if (err instanceof SetModelTimeoutError) this.die(err.message);
      if (a.settled) return;
      a.stream.fail(`setModel failed: ${(err as Error)?.message ?? String(err)}`);
      this.settleAttempt(a, "error");
      return;
    }
    if (a.settled) return;
    if (a.stopReason || this.closing || this.deadReason !== undefined) {
      this.settleAttempt(a, a.stopReason ?? "cancelled");
      return;
    }
    a.sent = true;
    this.lastAttemptAt = this.now();
    this.inflight = a;
    const timeout = this.opts.turnTimeoutMs ?? 120_000;
    if (timeout > 0) {
      a.turnTimer = setTimeout(() => {
        this.log("turn_timeout", { device: this.device });
        void this.interruptAttempt(a, "timeout");
      }, timeout);
    }
    this.input.push(userMessage(a.req.text, true));
    await a.settledP.promise;
  }

  private async sendNote(n: Note): Promise<void> {
    this.inflight = n;
    const ms = this.opts.noteTimeoutMs ?? 10_000;
    n.timer = setTimeout(() => this.die("note got no result"), ms);
    this.input.push(userMessage(n.text, false));
    await n.result.promise;
  }

  /** `setModel` on the query when the model differs, bounded by `setModelTimeoutMs`. */
  private async switchModel(model: string): Promise<void> {
    if (model === this.currentModel) return;
    const ms = this.opts.setModelTimeoutMs ?? 10_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new SetModelTimeoutError(ms)), ms);
    });
    try {
      await Promise.race([this.q.setModel(model), timeout]);
      this.currentModel = model;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Caller callbacks must never break the pump or leave an attempt unresolved. */
  private safeCallbacks(cb: TurnCallbacks): TurnCallbacks {
    const run = (name: string, f: () => void): void => {
      try {
        f();
      } catch (err) {
        this.log("callback_failed", { callback: name, error: (err as Error)?.message ?? String(err) });
      }
    };
    return {
      onDelta: (t) => run("onDelta", () => cb.onDelta(t)),
      ...(cb.onToolUse ? { onToolUse: (id: string, name: string) => run("onToolUse", () => cb.onToolUse?.(id, name)) } : {}),
      ...(cb.onToolResult
        ? {
            onToolResult: (id: string, name: string | undefined, isError: boolean) =>
              run("onToolResult", () => cb.onToolResult?.(id, name, isError)),
          }
        : {}),
    };
  }

  private async ensureMcpFresh(): Promise<void> {
    const f = this.opts.mcpFreshness;
    if (!f || f.servers.length === 0 || this.lastAttemptAt === undefined) return;
    if (this.now() - this.lastAttemptAt < (f.afterMs ?? 5 * 60_000)) return;
    const timeoutMs = f.timeoutMs ?? 10_000;
    const bounded = <T>(p: Promise<T>) =>
      Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), timeoutMs).unref())]);
    try {
      const status = await bounded(this.q.mcpServerStatus());
      for (const name of f.servers) {
        const s = status.find((x) => x.name === name);
        if (s && s.status === "connected") continue;
        this.log("mcp_reconnect", { server: name, status: s?.status });
        await bounded(this.q.reconnectMcpServer(name)).catch((err: unknown) =>
          this.log("mcp_reconnect_failed", { server: name, error: (err as Error)?.message }),
        );
      }
    } catch (err) {
      // Never blocks the turn: the model sees the tool error, as before.
      this.log("mcp_status_failed", { error: (err as Error)?.message });
    }
  }

  private async interruptAttempt(a: Attempt, reason: "cancelled" | "timeout" | "tool_cap"): Promise<void> {
    if (a.settled) return;
    if (a.visibleDone) {
      // The user already has the answer; only a stuck `result` (timeout) is worth cutting.
      if (reason !== "timeout") return;
    } else {
      a.stopReason ??= reason;
    }
    if (!a.sent) {
      // Still queued (e.g. behind the previous attempt's `result`): end it now; it is never sent.
      this.settleAttempt(a, a.stopReason ?? reason);
      return;
    }
    if (!a.watchdog) {
      a.watchdog = setTimeout(() => {
        this.log("interrupt_watchdog", { device: this.device });
        this.die("no result after interrupt");
      }, this.opts.interruptWatchdogMs ?? 5_000);
    }
    try {
      await this.q.interrupt();
    } catch (err) {
      this.log("interrupt_failed", { error: (err as Error)?.message });
    }
  }

  /** The one `canUseTool` of the query: forwards to the attempt that is current when the call starts. */
  private readonly dispatch: CanUseTool = async (toolName, input, options) => {
    const a = this.inflight;
    if (!a || a.kind !== "attempt" || a.settled || a.stopReason) return CANCELLED_DENY;
    this.pendingGateCalls++;
    try {
      const r: PermissionResult = await a.req.canUseTool(toolName, input, { signal: options.signal, toolUseID: options.toolUseID });
      // The attempt may have been cancelled while the confirmation was open.
      if (a.settled || a.stopReason) return CANCELLED_DENY;
      return r;
    } finally {
      this.pendingGateCalls--;
    }
  };

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.q) this.route(msg);
      if (!this.closing) this.die("query ended");
    } catch (err) {
      if (!this.closing) this.die((err as Error)?.message || "query failed");
    }
  }

  private route(msg: SDKMessage): void {
    if ("session_id" in msg && typeof msg.session_id === "string" && msg.session_id !== this.sessionIdValue) {
      this.sessionIdValue = msg.session_id;
      this.opts.onSessionId?.(msg.session_id);
    }
    const slot = this.inflight;
    if (msg.type === "result") {
      if (!slot) return; // stray
      this.updateCost(msg.total_cost_usd, slot.kind === "attempt" ? slot : undefined);
      if (slot.kind === "note") {
        this.inflight = undefined;
        clearTimeout(slot.timer);
        slot.result.resolve(true);
        return;
      }
      slot.stream.consume(msg);
      this.settleFromResult(slot, msg);
      return;
    }
    if (msg.type === "rate_limit_event") {
      const info = msg.rate_limit_info;
      if (info.status === "allowed_warning") this.log("rate_limit_warning", { resetsAt: info.resetsAt, type: info.rateLimitType });
      if (slot?.kind === "attempt" && info.status === "rejected") {
        slot.rateLimitRejected = true;
        slot.resetsAt = info.resetsAt;
      }
      return;
    }
    if (!slot || slot.kind !== "attempt" || slot.settled) return;
    const a = slot;
    if (msg.type === "stream_event" && !msg.parent_tool_use_id && msg.event.type === "content_block_start") a.gate.newBlock();
    a.stream.consume(msg);
    if (msg.type === "assistant" && !msg.parent_tool_use_id) {
      if (msg.message?.model) a.model = msg.message.model;
      if (msg.error === "rate_limit") a.assistantRateLimit = true;
      for (const block of msg.message?.content ?? []) {
        if (block.type === "tool_use") a.toolCalls++;
        if (block.type === "text" && isUsageLimitText(block.text)) a.usageLimitText = true;
      }
      const cap = this.opts.maxToolCalls ?? 12;
      if (cap > 0 && a.toolCalls > cap && !a.stopReason) {
        this.log("tool_cap", { device: this.device, toolCalls: a.toolCalls });
        void this.interruptAttempt(a, "tool_cap");
      }
      return;
    }
    if (msg.type === "stream_event" && !msg.parent_tool_use_id) {
      const ev = msg.event;
      if (ev.type === "message_start") a.lastStopReason = undefined;
      else if (ev.type === "message_delta") a.lastStopReason = ev.delta.stop_reason;
      // A limit-marked turn is not a visible answer: it ends at `result` as `usage_limit`.
      else if (ev.type === "message_stop" && a.lastStopReason === "end_turn" && !a.stopReason && !a.usageLimitText)
        this.markVisibleDone(a);
    }
  }

  /**
   * `total_cost_usd` is cumulative per query. A crash/startup-error result may
   * carry a zeroed total: it gets no diff and does not move the baseline down
   * (that would over-count the next turn). Only a second total in a row below the
   * baseline that did not shrink further counts as a real counter reset.
   */
  private updateCost(total: number | undefined, a: Attempt | undefined): void {
    if (typeof total !== "number" || !Number.isFinite(total)) return;
    const base = this.costBaseline;
    let diff: number | undefined;
    if (base === undefined) {
      if (total > 0) this.costBaseline = total; // first total after a resume; a zeroed one is no baseline
    } else if (total >= base) {
      diff = total - base;
      this.costBaseline = total;
      this.lowTotal = undefined;
    } else if (this.lowTotal !== undefined && total > 0 && total >= this.lowTotal) {
      diff = total - this.lowTotal;
      this.costBaseline = total;
      this.lowTotal = undefined;
    } else {
      this.lowTotal = total;
    }
    if (a) a.costUsd = diff;
  }

  private build(a: Attempt, status: AttemptStatus, fallbackText: boolean): AttemptOutcome {
    const r = a.stream.result(this.now() - a.submittedAt, { fallbackText });
    let error = r.error;
    // `cancelled`, or an answer already delivered before an internal tail error.
    if (status === "cancelled" || (status === "ok" && a.visibleDone)) error = undefined;
    else if (status === "timeout") error = "turn timeout";
    else if (status === "tool_cap") error = `tool call limit (${this.opts.maxToolCalls ?? 12}) reached`;
    else if (status === "usage_limit") error = error ?? "usage limit reached";
    return {
      ...r,
      error,
      costUsd: a.costUsd,
      status,
      model: a.model ?? a.req.model,
      ...(status === "usage_limit" && resetsAtToMs(a.resetsAt) !== undefined ? { retryAt: resetsAtToMs(a.resetsAt) } : {}),
      warm: a.warm,
      queryAgeMs: a.queryAgeMs,
      doneMs: a.visibleOutcome?.doneMs ?? this.now() - a.submittedAt,
    };
  }

  private markVisibleDone(a: Attempt): void {
    if (a.visibleDone) return;
    a.visibleDone = true;
    clearTimeout(a.turnTimer);
    a.gate.flush();
    // Restart the timer for the internal tail (classifier) so a stuck `result` cannot block the queue.
    const timeout = this.opts.turnTimeoutMs ?? 120_000;
    if (timeout > 0) a.turnTimer = setTimeout(() => void this.interruptAttempt(a, "timeout"), timeout);
    a.visibleOutcome = this.build(a, "ok", false);
    if (this.active === a) this.active = undefined;
    a.done.resolve(a.visibleOutcome);
  }

  private settleFromResult(a: Attempt, msg: Extract<SDKMessage, { type: "result" }>): void {
    let status: AttemptStatus;
    const resultText = msg.subtype === "success" ? msg.result : (msg.errors ?? []).join("; ");
    // Checked even after a visible end: the settled outcome must report the limit.
    const limit = isUsageLimitText(resultText) || a.usageLimitText || (a.assistantRateLimit && a.rateLimitRejected);
    if (a.stopReason) status = a.stopReason; // error_during_execution after our interrupt (never set after a visible end)
    else if (limit) status = "usage_limit";
    else if (a.visibleDone) status = "ok";
    else if (msg.subtype !== "success" || msg.is_error) status = "error";
    else status = "ok";
    this.settleAttempt(a, status);
  }

  private settleAttempt(a: Attempt, status: AttemptStatus): void {
    if (a.settled) return;
    a.settled = true;
    clearTimeout(a.turnTimer);
    clearTimeout(a.watchdog);
    if (a.onAbort) a.req.signal?.removeEventListener("abort", a.onAbort);
    if (this.inflight === a) this.inflight = undefined;
    if (this.active === a) this.active = undefined;
    const finalStatus = a.visibleDone && status !== "usage_limit" ? (a.visibleOutcome?.status ?? "ok") : status;
    let out: AttemptOutcome | undefined;
    try {
      // The usage-limit text goes out as an error frame, not as an answer.
      const fallback = !a.visibleDone && status !== "usage_limit";
      out = this.build(a, finalStatus, fallback);
      // Held-back text of a normal answer still reaches the user; nothing after a cancel or a limit.
      if (finalStatus !== "usage_limit" && finalStatus !== "cancelled") a.gate.flush();
    } catch (err) {
      this.log("settle_failed", { error: (err as Error)?.message ?? String(err) });
    } finally {
      out ??= {
        text: a.stream.streamedText,
        inputTokens: 0,
        outputTokens: 0,
        durationMs: this.now() - a.submittedAt,
        error: "internal error while finishing the turn",
        status: finalStatus,
        model: a.model ?? a.req.model,
        warm: a.warm,
        queryAgeMs: a.queryAgeMs,
        doneMs: this.now() - a.submittedAt,
      };
      if (!a.visibleDone) {
        a.visibleDone = true;
        a.done.resolve(out);
      }
      a.settledP.resolve(out);
      if (a.sent) this.lastAttemptAt = this.now();
      this.armIdle();
    }
  }

  /** Resolves every in-flight or queued item (close or death). */
  private finishAll(status: AttemptStatus, message: string): void {
    const slots = new Set<Slot>(this.queued);
    if (this.inflight) slots.add(this.inflight);
    if (this.active) slots.add(this.active);
    for (const s of slots) {
      if (s.kind === "note") {
        clearTimeout(s.timer);
        s.result.resolve(false);
      } else {
        if (status !== "cancelled") s.stream.fail(message);
        this.settleAttempt(s, status);
      }
    }
    this.queued.clear();
    this.inflight = undefined;
    this.active = undefined;
  }

  private die(reason: string): void {
    if (this.deadReason !== undefined || this.closing) return;
    this.deadReason = reason;
    this.log("dead", { device: this.device, reason });
    this.clearIdle();
    this.finishAll("dead", `agent process ended: ${reason}`);
    this.input.end();
    try {
      this.q.close();
    } catch {
      // already gone
    }
    this.abortController.abort();
    this.opts.onDead?.(reason);
  }

  private armIdle(): void {
    this.clearIdle();
    const ms = this.opts.idleMs ?? 10 * 60_000;
    if (ms <= 0 || this.closing || this.deadReason !== undefined) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.active || this.inflight || this.queued.size > 0 || this.pendingGateCalls > 0) {
        this.armIdle();
        return;
      }
      this.log("idle_close", { device: this.device });
      this.close();
      this.opts.onIdleClose?.();
    }, ms);
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private log(event: string, detail?: Record<string, unknown>): void {
    this.opts.log?.(event, detail);
  }
}

export interface ClaudeSdkProviderOptions {
  /** `query` from the SDK; injected by tests. */
  queryFn: QueryFactory;
  /** Options of a live session (agent.ts `SdkAgentRunner.buildPersistentOptions`). */
  buildOptions: DeviceAgentOptions["buildOptions"];
  /**
   * Options of a one-shot background call: no tools, no MCP, no persisted
   * session, the agent's subprocess environment. `maxTokens` is applied by the
   * builder (the SDK has no per-call option for it).
   */
  buildOneShotOptions: (p: {
    model: string;
    system?: string;
    schema?: Record<string, unknown>;
    maxTokens: number;
    abortController: AbortController;
  }) => Omit<Options, "prompt">;
  /** Defaults for every live session (timeouts, MCP freshness, log). */
  session?: Pick<
    DeviceAgentOptions,
    "idleMs" | "turnTimeoutMs" | "interruptWatchdogMs" | "noteTimeoutMs" | "setModelTimeoutMs" | "maxToolCalls" | "mcpFreshness" | "log" | "now"
  >;
}

/** The Claude Agent SDK as a `ModelProvider`. */
export class ClaudeSdkProvider implements ModelProvider {
  readonly id = CLAUDE_SDK_PROVIDER_ID;
  /** `compact` stays off until `/compact` on a live streaming query is verified (06 §Context compression). */
  readonly capabilities: ProviderCapabilities = { setModel: true, compact: false, notes: true, resume: true };

  constructor(private readonly o: ClaudeSdkProviderOptions) {}

  openSession(s: OpenSessionOptions): DeviceAgent {
    return new DeviceAgent({ ...this.o.session, ...s, queryFn: this.o.queryFn, buildOptions: this.o.buildOptions });
  }

  async oneShot(req: OneShotRequest): Promise<OneShotResult> {
    const base = { text: "", inputTokens: 0, outputTokens: 0, model: req.model };
    if (req.signal?.aborted) return { ...base, status: "cancelled" };
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    req.signal?.addEventListener("abort", onAbort, { once: true });
    const input = new InputQueue();
    let q: Query | undefined;
    let res: Extract<SDKMessage, { type: "result" }> | undefined;
    let assistantText = "";
    let model = req.model;
    let rejected = false;
    let resetsAt: number | undefined;
    let failure: string | undefined;
    try {
      const options = this.o.buildOneShotOptions({
        model: req.model,
        ...(req.system !== undefined ? { system: req.system } : {}),
        ...(req.schema !== undefined ? { schema: req.schema } : {}),
        maxTokens: req.maxTokens,
        abortController: ac,
      });
      q = this.o.queryFn({ prompt: input, options: { ...options, abortController: ac } as Options });
      input.push(userMessage(req.prompt, true));
      for await (const m of q) {
        if (m.type === "assistant" && !m.parent_tool_use_id) {
          if (m.message?.model) model = m.message.model;
          for (const b of m.message?.content ?? []) if (b.type === "text") assistantText += b.text;
        } else if (m.type === "rate_limit_event" && m.rate_limit_info.status === "rejected") {
          rejected = true;
          resetsAt = m.rate_limit_info.resetsAt;
        } else if (m.type === "result") {
          res = m;
          break;
        }
      }
    } catch (err) {
      failure = (err as Error)?.message ?? String(err);
    } finally {
      input.end();
      try {
        q?.close();
      } catch {
        // already gone
      }
      req.signal?.removeEventListener("abort", onAbort);
    }
    if (ac.signal.aborted) return { ...base, model, status: "cancelled" };
    const u = (res?.usage ?? {}) as unknown as Record<string, number | undefined>;
    const usage = {
      inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
      outputTokens: u.output_tokens ?? 0,
      ...(typeof res?.total_cost_usd === "number" ? { costUsd: res.total_cost_usd } : {}),
    };
    const resultText = res ? (res.subtype === "success" ? res.result : (res.errors ?? []).join("; ")) : "";
    if (isUsageLimitText(resultText) || isUsageLimitText(assistantText) || (rejected && (!res || res.is_error))) {
      const retryAt = resetsAtToMs(resetsAt);
      return { ...base, ...usage, model, status: "usage_limit", error: "usage limit reached", ...(retryAt !== undefined ? { retryAt } : {}) };
    }
    if (!res || res.subtype !== "success" || res.is_error) {
      return { ...base, ...usage, model, status: "error", error: failure ?? (resultText || "no result") };
    }
    const text = res.result || assistantText;
    let json: unknown;
    if (req.schema) {
      json = res.structured_output;
      if (json === undefined) {
        try {
          json = JSON.parse(text);
        } catch {
          return { ...base, ...usage, text, model, status: "error", error: "no structured output" };
        }
      }
    }
    return { ...base, ...usage, text, model, status: "ok", ...(json !== undefined ? { json } : {}) };
  }
}

/**
 * Restart throttle for a device's agent (docs/07 §Process death): after
 * `threshold` deaths within `windowMs`, no replacement starts for `backoffMs`
 * after the last death; turns use the legacy runner meanwhile.
 */
export class RestartBackoff {
  private deaths: number[] = [];

  constructor(
    private readonly o: { windowMs?: number; threshold?: number; backoffMs?: number; now?: () => number } = {},
  ) {}

  private get now(): number {
    return (this.o.now ?? Date.now)();
  }

  recordDeath(): void {
    const now = this.now;
    const windowMs = this.o.windowMs ?? 5 * 60_000;
    this.deaths = [...this.deaths.filter((t) => now - t <= windowMs), now];
  }

  /** May a replacement agent start now? */
  canStart(): boolean {
    const now = this.now;
    const windowMs = this.o.windowMs ?? 5 * 60_000;
    const recent = this.deaths.filter((t) => now - t <= windowMs);
    if (recent.length < (this.o.threshold ?? 2)) return true;
    const last = recent[recent.length - 1] as number;
    return now - last >= (this.o.backoffMs ?? 30_000);
  }
}
