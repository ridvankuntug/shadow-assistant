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
 * - Memory (docs/06): a session starts with the memory brief appended to its
 *   system prompt (`systemAppend`). `briefChanged()` makes every running
 *   session stale; an idle one is replaced at once (with `resume`, so the
 *   conversation stays), a busy one after its turn. Each device keeps the
 *   "memory entries already sent" set of its conversation; it is cleared when a
 *   session starts or the conversation is compacted.
 * - Maintenance (06 §Context compression): `hold()` runs work while the
 *   device's turns wait in `acquire()` (tier-0 turns in `waitHold()`);
 *   `reseed()` replaces the session with a new conversation seeded with a
 *   summary. `beginActivity()` marks a turn of any tier (tier 0 and its
 *   confirmations included) so maintenance sees the device as busy.
 *
 * Provider-neutral: this module knows only `ModelProvider` / `ProviderSession`
 * (model-provider.ts) and never imports a provider SDK.
 */
import { DEFAULT_CONTINUITY_MIN, type ContinuityStore } from "./continuity.js";
import { SentEntries } from "./memory/match.js";
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
  /** Text appended to the system prompt of every new session (memory brief); read at each start. */
  systemAppend?: () => Promise<string>;
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
  /** Turns of any tier in progress (tier 0 and its confirmations included): maintenance treats the device as busy. */
  active: number;
  /** The continuity port was asked once for this device (only the first start after a Core start needs it). */
  looked?: boolean;
  guard?: RestartGuard;
  /** Memory entries already sent in this device's conversation (docs/06 §Relevant note entries). */
  sent: SentEntries;
  /** `briefGen` the running session started with. */
  gen?: number;
  /** Maintenance in progress (compaction): `acquire()` waits for it. */
  hold?: Promise<void>;
  /** Seed of a reseeded conversation that could not be stored as a note: goes in front of the next prompt. */
  seed?: string;
}

export const DEFAULT_START_TIMEOUT_MS = 30_000;

export class DeviceRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly log: RegistryLog;
  private readonly now: () => number;
  private readonly windowMs: number;
  private closed = false;
  /** Incremented on every brief change; a session started with an older value is stale. */
  private briefGen = 0;
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
      e = { guard: this.o.restartGuard?.(), sent: new SentEntries(), active: 0 };
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
    for (;;) {
      // Compaction in progress: the turn waits for it (the client sees `thinking`).
      while (e.hold) await e.hold;
      if (this.closed) return undefined;
      // A start in progress (e.g. prewarm) already set `e.session` but is not
      // ready yet: wait for it, so a failed start yields the legacy fallback.
      if (e.starting) {
        const started = await e.starting;
        // A failed start is not retried here (the turn uses the legacy runner).
        if (!started || this.closed) return started;
        // Another waiter already replaces it (see below): wait for that start.
        // (The cast re-reads the field: TypeScript keeps the narrowing across the await.)
        if ((e.starting as Entry["starting"] | undefined) !== undefined) continue;
        // The brief changed while it started: loop, so the stale-and-idle check below replaces it.
        if (this.isStale(e) && started === this.live(device)) continue;
        return started;
      }
      const running = this.live(device);
      if (running && !(this.isStale(e) && !running.busy)) return running;
      // The brief changed since this session started: continue the conversation in a new one.
      if (running) this.retire(device, e);
      e.starting = this.start(device, e).finally(() => {
        e.starting = undefined;
      });
    }
  }

  /**
   * Starts the device's session in the background (on `hello`), unless one
   * runs. Skipped while a turn of the device runs: a legacy fallback turn may
   * still be writing the conversation a new session would resume.
   */
  prewarm(device: string): void {
    if (this.o.prewarm === false || this.closed) return;
    const e = this.entries.get(device);
    if (e?.turnBusy || e?.hold) return;
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
    // A session made stale by a brief change during this turn is replaced once the device is idle.
    this.restartIfIdle(device, e);
    if (!this.o.continuity) return Promise.resolve();
    return this.o.continuity.record(device, { provider: this.o.provider.id, sessionId: sid }, this.now()).catch(() => {});
  }

  // --- memory and maintenance (docs/06) ---------------------------------------

  /** The device's "memory entries already sent" set for its current conversation. */
  sentEntries(device: string): SentEntries {
    return this.entry(device).sent;
  }

  /**
   * The memory brief changed (an identity fact was learned, or a brief entry
   * was deleted): every running session is stale. Idle ones are replaced now
   * (with `resume`); busy ones after their turn, or at the latest when the
   * next turn acquires them.
   */
  briefChanged(): void {
    this.briefGen++;
    for (const [device, e] of this.entries) this.restartIfIdle(device, e);
  }

  /**
   * The device is not idle for maintenance: a model turn holds the turn lock,
   * or a turn of any tier (tier 0 with a pending confirmation included) is in
   * progress (`beginActivity`).
   */
  isTurnBusy(device: string): boolean {
    const e = this.entries.get(device);
    return e !== undefined && (e.turnBusy === true || e.active > 0);
  }

  /**
   * A turn of the device (any tier, any socket) starts. Not exclusive, unlike
   * `beginTurn`; compaction only waits until none is in progress. Returns the
   * release (idempotent).
   */
  beginActivity(device: string): () => void {
    const e = this.entry(device);
    e.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      e.active--;
    };
  }

  /** Resolves once no maintenance of the device runs (tier-0 turns wait here; model turns wait in `acquire`). */
  async waitHold(device: string): Promise<void> {
    const e = this.entries.get(device);
    while (e?.hold) await e.hold;
  }

  /** Maintenance of the device is running (its turns wait for it). */
  isHeld(device: string): boolean {
    return this.entries.get(device)?.hold !== undefined;
  }

  /**
   * Runs `fn` while the device's turns wait in `acquire()` (compaction). The
   * caller checks first that no turn is running; `fn` must not call `acquire()`.
   */
  async hold<T>(device: string, fn: () => Promise<T>): Promise<T> {
    const e = this.entry(device);
    while (e.hold) await e.hold;
    let release!: () => void;
    e.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      return await fn();
    } finally {
      e.hold = undefined;
      release();
    }
  }

  /**
   * Compaction without `capabilities.compact` (06 §Core-side summary): opens a
   * new conversation (no `resume`), stores `note` in it (`appendNote`; when
   * notes are not supported or the note is refused, it goes in front of the
   * next prompt, see `peekSeedNote`), then replaces the running session. The
   * persisted continuity pointer moves to the new conversation only once it
   * holds the summary: at once for a stored note, otherwise at the end of the
   * first model turn that delivered the seed (`turnEnded`). A Core restart
   * before that resumes the old, uncompacted conversation, never an empty one.
   * On failure the running session is kept and false is returned.
   */
  async reseed(device: string, note: string): Promise<boolean> {
    if (this.closed) return false;
    const e = this.entry(device);
    const gen = this.briefGen;
    const systemAppend = await this.readSystemAppend(device);
    let fresh: ProviderSession;
    try {
      fresh = this.openFor(device, e, undefined, systemAppend, true);
    } catch (err) {
      this.log("warn", `[shadow-core] compaction: new session for ${device} could not start: ${(err as Error)?.message ?? String(err)}`);
      return false;
    }
    const ready = await this.waitReady(fresh);
    if (ready !== true || this.closed) {
      fresh.close();
      if (ready !== "closed") this.log("warn", `[shadow-core] compaction: new session for ${device} not ready (${ready}); keeping the old one`);
      return false;
    }
    const stored = this.capabilities.notes ? await fresh.appendNote(note).catch(() => false) : false;
    if (fresh.isClosed || this.closed) {
      fresh.close();
      return false;
    }
    const old = e.session;
    e.session = fresh;
    e.gen = gen;
    e.sent.clear();
    e.seed = stored ? undefined : note;
    e.lastSessionId = fresh.sessionId;
    // The new conversation carries the summary; the continuity window counts from now.
    e.lastTurnAt = this.now();
    e.looked = true;
    old?.close();
    if (stored && fresh.sessionId && this.o.continuity) {
      await this.o.continuity.record(device, { provider: this.o.provider.id, sessionId: fresh.sessionId }, this.now()).catch(() => {});
    }
    return true;
  }

  /**
   * The seed note of a reseeded conversation not stored yet. The caller puts
   * it in front of the prompt and calls `seedDelivered` once the attempt
   * carrying it was taken; until then it stays (a turn cancelled before its
   * attempt, or a refused attempt, leaves it for the next turn).
   */
  peekSeedNote(device: string): string | undefined {
    return this.entries.get(device)?.seed;
  }

  /** `seed` reached the conversation; a newer seed (another reseed meanwhile) is kept. */
  seedDelivered(device: string, seed: string): void {
    const e = this.entries.get(device);
    if (e?.seed === seed) e.seed = undefined;
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

  private isStale(e: Entry): boolean {
    return e.gen !== undefined && e.gen !== this.briefGen;
  }

  /** Closes the device's session but keeps its conversation id, so the next start resumes it. */
  private retire(device: string, e: Entry): void {
    const s = e.session;
    if (!s) return;
    if (s.sessionId) e.lastSessionId = s.sessionId;
    e.session = undefined;
    s.close();
    this.log("info", `[shadow-core] agent for ${device} restarts: memory brief changed`);
  }

  /** Replaces a stale session when the device is idle; it starts again in the background when prewarm is on. */
  private restartIfIdle(device: string, e: Entry): void {
    if (this.closed || e.turnBusy || e.hold || e.starting) return;
    const s = this.live(device);
    if (!s || s.busy || !this.isStale(e)) return;
    this.retire(device, e);
    if (this.o.prewarm !== false) void this.acquire(device).catch(() => {});
  }

  /** The text appended to a new session's system prompt; "" when there is none or it cannot be read. */
  private async readSystemAppend(device: string): Promise<string> {
    if (!this.o.systemAppend) return "";
    try {
      return await this.o.systemAppend();
    } catch (err) {
      this.log("warn", `[shadow-core] memory brief unavailable for ${device}: ${(err as Error)?.message ?? String(err)}`);
      return "";
    }
  }

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
    const gen = this.briefGen;
    const systemAppend = await this.readSystemAppend(device);
    if (this.closed) return undefined;
    let session: ProviderSession;
    try {
      session = this.openFor(device, e, resume, systemAppend);
    } catch (err) {
      e.guard?.recordDeath();
      this.log("warn", `[shadow-core] agent for ${device} could not start: ${(err as Error)?.message ?? String(err)}`);
      return undefined;
    }
    e.session = session;
    e.gen = gen;
    // A new query: memory entries are sent again (06 §Relevant note entries).
    e.sent.clear();
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

  /**
   * Opens a session of the device; its callbacks act only while it is (or may
   * become) the device's session. `candidate` (reseed): it becomes the
   * device's session only at the handover and never moves the conversation
   * pointer before that, even when the old session is gone meanwhile.
   */
  private openFor(device: string, e: Entry, resume: string | undefined, systemAppend: string, candidate = false): ProviderSession {
    const session: ProviderSession = this.o.provider.openSession({
      device,
      model: this.o.model,
      ...(resume ? { resume } : {}),
      ...(systemAppend ? { systemAppend } : {}),
      onSessionId: (id) => {
        // `e.session === undefined`: a normal start may report its id before it is assigned.
        if (e.session === session || (!candidate && e.session === undefined)) e.lastSessionId = id;
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
