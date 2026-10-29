/**
 * Device registry (docs/07-speed.md §A1 Components, tasks S6/S8): device name →
 * one live `ProviderSession`.
 *
 * - Lazy: a device's session is opened on its first model turn, or earlier by
 *   `prewarm()` on `hello`. Concurrent callers share one start.
 * - A session that fails to start (or is not ready within `startTimeoutMs`)
 *   yields `undefined`: the caller runs that turn on the legacy runner.
 * - Idle close and death are reported by the session (`onIdleClose`, `onDead`);
 *   the next turn opens a replacement that continues the same conversation
 *   (`resume` = the last session id). Deaths are throttled per device by a
 *   `RestartGuard` (two deaths within 5 minutes → no replacement for 30 s;
 *   turns use the legacy runner meanwhile).
 * - Continuity (A4, S8): the first session of a device after a Core start
 *   resumes the pointer `{ provider, sessionId }` from the continuity port when
 *   it belongs to this provider and is still inside the window; every model
 *   turn updates the pointer; `close()` flushes it. The same window applies
 *   inside a running process: a replacement session (or a legacy fallback turn)
 *   started more than `continuityMin` after the device's last model turn
 *   starts a new conversation.
 * - Turn lock (`beginTurn`/`endTurn`): one model turn per device at a time,
 *   whether it runs on the session or on the legacy fallback, so two sockets
 *   of one device never write the same conversation concurrently. `prewarm()`
 *   skips a locked device.
 *
 * Provider-neutral: this module knows only `ModelProvider` / `ProviderSession`
 * (model-provider.ts) and never imports a provider SDK.
 */
import { DEFAULT_CONTINUITY_MIN, type ContinuityStore } from "./continuity.js";
import type { ModelProvider, ProviderCapabilities, ProviderSession } from "./model-provider.js";

/** What continuity stores per device: which provider's conversation, and its id. */
export interface ContinuityPointer {
  provider: string;
  sessionId: string;
  /** End of the conversation's last model turn (epoch ms); set by `lookup`, ignored by `record`. */
  lastTurnAt?: number;
}

/** Persistence of the per-device pointer (A4). */
export interface ContinuityPort {
  /** The pointer to continue, or undefined (none, expired or the conversation is gone). */
  lookup(device: string): Promise<ContinuityPointer | undefined>;
  /** End of a model turn. Never rejects. */
  record(device: string, pointer: ContinuityPointer, at: number): Promise<void>;
  /** Waits for pending writes (shutdown). Never rejects. */
  flush(): Promise<void>;
}

/** Restart throttle of one device (device-agent.ts `RestartBackoff` has this shape). */
export interface RestartGuard {
  recordDeath(): void;
  canStart(): boolean;
}

export type RegistryLog = (level: "info" | "warn", message: string) => void;

export interface DeviceRegistryOptions {
  provider: ModelProvider;
  /** Model a new session starts on (tier 1); other tiers switch per attempt. */
  model: string;
  continuity?: ContinuityPort;
  /** One guard per device; absent = no throttle. */
  restartGuard?: () => RestartGuard;
  /** Fall back to the legacy runner when a session is not ready by then. Default 30 s. */
  startTimeoutMs?: number;
  /** CORE_CONTINUITY_MIN: a conversation idle longer than this is not resumed. Default 30. */
  continuityMin?: number;
  /** `prewarm()` does nothing when false (CORE_AGENT_PREWARM=off). Default true. */
  prewarm?: boolean;
  log?: RegistryLog;
  now?: () => number;
}

interface Entry {
  session?: ProviderSession;
  /** A start in progress; shared by concurrent callers. */
  starting?: Promise<ProviderSession | undefined>;
  /** Last conversation id of this device in this process (from the session or a legacy turn). */
  lastSessionId?: string;
  /** End of the last model turn of `lastSessionId` (epoch ms); undefined = no turn yet (an empty conversation). */
  lastTurnAt?: number;
  /** A model turn of this device is running (any socket, session or legacy fallback). */
  turnBusy?: boolean;
  /** The continuity port was asked once for this device (only the first start after a Core start needs it). */
  looked?: boolean;
  guard?: RestartGuard;
}

export const DEFAULT_START_TIMEOUT_MS = 30_000;

export class DeviceRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly log: RegistryLog;
  private readonly now: () => number;
  private readonly windowMs: number;
  private closed = false;
  /** Aborted by close(): sessions still starting stop waiting for `ready`. */
  private readonly closing = new AbortController();

  constructor(private readonly o: DeviceRegistryOptions) {
    this.log = o.log ?? (() => {});
    this.now = o.now ?? Date.now;
    const min = o.continuityMin;
    this.windowMs = (min !== undefined && Number.isFinite(min) && min > 0 ? min : DEFAULT_CONTINUITY_MIN) * 60_000;
  }

  get capabilities(): ProviderCapabilities {
    return this.o.provider.capabilities;
  }

  get providerId(): string {
    return this.o.provider.id;
  }

  private entry(device: string): Entry {
    let e = this.entries.get(device);
    if (!e) {
      e = { guard: this.o.restartGuard?.() };
      this.entries.set(device, e);
    }
    return e;
  }

  /** The device's running session, without starting one. */
  live(device: string): ProviderSession | undefined {
    const s = this.entries.get(device)?.session;
    return s && !s.isClosed ? s : undefined;
  }

  /**
   * The device's ready session, starting one if needed. `undefined` means
   * "run this turn on the legacy runner" (start failed, start timeout,
   * restart backoff, or the registry is closed).
   */
  async acquire(device: string): Promise<ProviderSession | undefined> {
    if (this.closed) return undefined;
    const e = this.entry(device);
    // A start in progress (e.g. prewarm) already set `e.session` but is not
    // ready yet: wait for it, so a failed start yields the legacy fallback.
    if (e.starting) return e.starting;
    const running = this.live(device);
    if (running) return running;
    e.starting ??= this.start(device, e).finally(() => {
      e.starting = undefined;
    });
    return e.starting;
  }

  /**
   * Starts the device's session in the background (on `hello`), unless one
   * runs. Skipped while a turn of the device runs: a legacy fallback turn may
   * still be writing the conversation a new session would resume.
   */
  prewarm(device: string): void {
    if (this.o.prewarm === false || this.closed) return;
    if (this.entries.get(device)?.turnBusy) return;
    void this.acquire(device).catch(() => {});
  }

  /**
   * Takes the device's turn lock; false when another turn of the device (from
   * any socket) is running: that turn gets `busy`. Release with `endTurn`.
   */
  beginTurn(device: string): boolean {
    const e = this.entry(device);
    if (e.turnBusy) return false;
    e.turnBusy = true;
    return true;
  }

  endTurn(device: string): void {
    const e = this.entries.get(device);
    if (e) e.turnBusy = false;
  }

  /** Conversation id a legacy fallback turn should resume (persistent mode). */
  async fallbackResume(device: string): Promise<string | undefined> {
    const e = this.entry(device);
    const live = this.live(device);
    if (live?.sessionId) return live.sessionId;
    await this.lookupOnce(device, e);
    this.expire(device, e);
    return e.lastSessionId;
  }

  /**
   * End of a model turn (not tier 0): updates the continuity pointer.
   * `sessionId` is given by legacy fallback turns; otherwise the live session's id is used.
   */
  turnEnded(device: string, sessionId?: string): Promise<void> {
    const e = this.entry(device);
    const sid = sessionId ?? this.live(device)?.sessionId ?? e.session?.sessionId ?? e.lastSessionId;
    if (!sid) return Promise.resolve();
    e.lastSessionId = sid;
    e.lastTurnAt = this.now();
    e.looked = true; // a newer pointer exists; the stored one is no longer of interest
    if (!this.o.continuity) return Promise.resolve();
    return this.o.continuity.record(device, { provider: this.o.provider.id, sessionId: sid }, this.now()).catch(() => {});
  }

  /**
   * Closes every session and flushes the continuity pointers (shutdown chain).
   * Sessions are closed first (also those still starting, which then stop
   * waiting for `ready`), so shutdown never waits for a start timeout.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.closing.abort();
    for (const e of this.entries.values()) {
      if (e.session?.sessionId) e.lastSessionId = e.session.sessionId;
      e.session?.close();
      e.session = undefined;
    }
    const starting = [...this.entries.values()].map((e) => e.starting).filter((p) => p !== undefined);
    await Promise.allSettled(starting);
    await this.o.continuity?.flush().catch(() => {});
  }

  // --- internals -------------------------------------------------------------

  /** Forgets the device's last conversation id when its last turn is older than the continuity window. */
  private expire(device: string, e: Entry): void {
    if (e.lastSessionId === undefined || e.lastTurnAt === undefined) return;
    if (this.now() - e.lastTurnAt <= this.windowMs) return;
    this.log("info", `[shadow-core] continuity: device ${device} idle longer than the window; starting a new conversation`);
    e.lastSessionId = undefined;
    e.lastTurnAt = undefined;
  }

  /** The stored pointer, asked once per device and process; undefined for another provider. */
  private async lookupOnce(device: string, e: Entry): Promise<string | undefined> {
    if (e.looked || !this.o.continuity || !this.capabilities.resume) return undefined;
    e.looked = true;
    let p: ContinuityPointer | undefined;
    try {
      p = await this.o.continuity.lookup(device);
    } catch (err) {
      this.log("warn", `[shadow-core] continuity lookup failed for ${device}: ${(err as Error)?.message ?? String(err)}`);
      return undefined;
    }
    if (!p) return undefined;
    if (p.provider !== this.o.provider.id) {
      this.log("info", `[shadow-core] continuity: device ${device} was on provider ${p.provider}; starting a new conversation`);
      return undefined;
    }
    if (e.lastSessionId === undefined) {
      e.lastSessionId = p.sessionId;
      e.lastTurnAt = p.lastTurnAt;
    }
    return p.sessionId;
  }

  private async start(device: string, e: Entry): Promise<ProviderSession | undefined> {
    if (e.guard && !e.guard.canStart()) {
      this.log("warn", `[shadow-core] agent for ${device} restarted too often; this turn uses the legacy runner`);
      return undefined;
    }
    await this.lookupOnce(device, e);
    this.expire(device, e);
    const resume = this.capabilities.resume ? e.lastSessionId : undefined;
    // A new conversation has had no turn yet.
    if (!resume) e.lastTurnAt = undefined;
    if (this.closed) return undefined;
    let session: ProviderSession;
    try {
      session = this.o.provider.openSession({
        device,
        model: this.o.model,
        ...(resume ? { resume } : {}),
        onSessionId: (id) => {
          e.lastSessionId = id;
        },
        onDead: (reason) => {
          if (e.session === session) e.session = undefined;
          e.guard?.recordDeath();
          this.log("warn", `[shadow-core] agent for ${device} died: ${reason}`);
        },
        onIdleClose: () => {
          if (e.session === session) e.session = undefined;
          this.log("info", `[shadow-core] agent for ${device} closed after idle time`);
        },
      });
    } catch (err) {
      e.guard?.recordDeath();
      this.log("warn", `[shadow-core] agent for ${device} could not start: ${(err as Error)?.message ?? String(err)}`);
      return undefined;
    }
    e.session = session;
    const startedAt = this.now();
    const ok = await this.waitReady(session);
    if (ok === "closed") {
      session.close();
      return undefined;
    }
    if (ok !== true) {
      if (e.session === session) e.session = undefined;
      // A start-up failure already reported itself through onDead; a timeout did not.
      if (ok === "timeout") e.guard?.recordDeath();
      session.close();
      this.log("warn", `[shadow-core] agent for ${device} not ready (${ok}); this turn uses the legacy runner`);
      return undefined;
    }
    if (this.closed) {
      session.close();
      return undefined;
    }
    this.log("info", `[shadow-core] agent for ${device} ready in ${this.now() - startedAt} ms${resume ? " (resumed)" : ""}`);
    return session;
  }

  private waitReady(session: ProviderSession): Promise<true | "failed" | "timeout" | "closed"> {
    const ms = this.o.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS;
    const closing = this.closing.signal;
    return new Promise((resolve) => {
      const finish = (r: true | "failed" | "timeout" | "closed") => {
        clearTimeout(timer);
        closing.removeEventListener("abort", onClose);
        resolve(r);
      };
      const onClose = () => finish("closed");
      const timer = setTimeout(() => finish("timeout"), ms);
      timer.unref?.();
      if (closing.aborted) return finish("closed");
      closing.addEventListener("abort", onClose, { once: true });
      session.ready().then(
        () => finish(true),
        () => finish("failed"),
      );
    });
  }
}

/**
 * `ContinuityPort` over the S7 `ContinuityStore` (devices.json version 2 keeps
 * the provider of every pointer; version 1 entries read as "claude-sdk"). The
 * registry decides whether a stored pointer's provider is its own.
 */
export function continuityPort(store: Pick<ContinuityStore, "lookup" | "record" | "flush">): ContinuityPort {
  return {
    async lookup(device) {
      const r = await store.lookup(device);
      return r.resume ? { provider: r.provider, sessionId: r.sessionId, lastTurnAt: r.lastTurnAt } : undefined;
    },
    record: (device, pointer, at) => store.record(device, { provider: pointer.provider, sessionId: pointer.sessionId }, at),
    flush: () => store.flush(),
  };
}
