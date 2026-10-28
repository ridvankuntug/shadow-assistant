/**
 * Continuity store (docs/07-speed.md A4, task S7): device → last SDK session
 * id, in `<SHADOW_DATA_DIR>/sessions/devices.json`.
 *
 *   { "version": 1,
 *     "devices": { "browser": { "sdkSessionId": "7c0e…", "lastTurnAt": 1767340800000, "updatedAt": 1767340801000 } } }
 *
 * The file is only a pointer: the conversation itself is the SDK transcript.
 * It holds device names, session ids and timestamps, never text, tokens or
 * client data; session ids that do not look like ids are refused.
 *
 * - Lookup: no entry → new conversation; older than the window → new
 *   conversation and the entry is removed; otherwise the injected
 *   `getSessionInfo` checks that the transcript still exists.
 * - Writes are serialized in-process (one writer, a promise chain; writes that
 *   queue up while one runs are coalesced into one), atomic (atomic-file.ts)
 *   and happen only when an entry actually changed. Expired entries are pruned
 *   on load and on every write. A failed write marks the store dirty: the
 *   next write, an unchanged record() and flush() try again, so a removal
 *   that only reached memory is not resurrected by a restart.
 * - A corrupt file (invalid JSON, wrong shape, unknown version) is quarantined
 *   by readJsonOrQuarantine; the store starts empty and logs one warning.
 *   Neither corruption nor a failing write ever throws to the caller: the turn
 *   goes on, continuity is simply lost.
 *
 * Wiring into the device registry is task S8.
 */
import { join } from "node:path";
import { readJsonOrQuarantine, writeFileAtomic, type AtomicFs } from "./atomic-file.js";

export const CONTINUITY_FILE_VERSION = 1;
/** Default for CORE_CONTINUITY_MIN. */
export const DEFAULT_CONTINUITY_MIN = 30;

/** Device names as auth.ts derives them (lower-case env suffix); bounded, no separators or controls. */
const DEVICE_RE = /^[\p{L}\p{N}_.-]{1,64}$/u;
/** SDK session ids are UUIDs; accept any short id-like token, nothing that could hold text. */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** Transcript checks per lookup when the entry's session keeps changing under the check. */
const MAX_LOOKUP_CHECKS = 3;

export interface ContinuityEntry {
  /** Last `session_id` seen in the device's query. */
  sdkSessionId: string;
  /** End of the last model turn (epoch ms). */
  lastTurnAt: number;
  /** When this entry was last written (epoch ms). */
  updatedAt: number;
}

export type ContinuityLookup =
  | { resume: true; sdkSessionId: string }
  | {
      resume: false;
      /**
       * none: no entry; expired: older than the window; missing: the transcript
       * is gone; check_failed: getSessionInfo threw (entry kept for a later try).
       */
      reason: "none" | "expired" | "missing" | "check_failed";
    };

export type ContinuityLog = (level: "info" | "warn", message: string) => void;

export interface ContinuityStoreOptions {
  /** Full path of devices.json; see continuityFilePath(). */
  file: string;
  /** CORE_CONTINUITY_MIN; default 30. Values ≤ 0 or non-finite fall back to the default. */
  windowMin?: number;
  now?: () => number;
  /**
   * Checks that the SDK transcript still exists (the SDK's `getSessionInfo`,
   * bound to the agent cwd by the caller). A falsy result means "gone". When
   * omitted, the check is skipped.
   */
  getSessionInfo?: (sdkSessionId: string) => Promise<unknown>;
  log?: ContinuityLog;
  fs?: AtomicFs;
  retryDelaysMs?: readonly number[];
}

/** `<dataDir>/sessions/devices.json` */
export function continuityFilePath(dataDir: string): string {
  return join(dataDir, "sessions", "devices.json");
}

function isTimestamp(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}

/**
 * Validates the parsed file. Any deviation (unknown version, a bad entry) makes
 * the whole file invalid: it is only ever written by this module, so a bad
 * entry means the file was damaged or hand-edited wrongly.
 */
export function parseContinuityFile(value: unknown): Map<string, ContinuityEntry> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const v = value as { version?: unknown; devices?: unknown };
  if (v.version !== CONTINUITY_FILE_VERSION) return undefined;
  if (typeof v.devices !== "object" || v.devices === null || Array.isArray(v.devices)) return undefined;
  const map = new Map<string, ContinuityEntry>();
  for (const [device, raw] of Object.entries(v.devices as Record<string, unknown>)) {
    if (!DEVICE_RE.test(device)) return undefined;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const e = raw as Record<string, unknown>;
    if (typeof e.sdkSessionId !== "string" || !SESSION_ID_RE.test(e.sdkSessionId)) return undefined;
    if (!isTimestamp(e.lastTurnAt) || !isTimestamp(e.updatedAt)) return undefined;
    // Unknown extra fields are dropped: only the three known ones are ever kept.
    map.set(device, { sdkSessionId: e.sdkSessionId, lastTurnAt: e.lastTurnAt, updatedAt: e.updatedAt });
  }
  return map;
}

export class ContinuityStore {
  private readonly file: string;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly log: ContinuityLog;
  private entries = new Map<string, ContinuityEntry>();
  private loading: Promise<void> | undefined;
  /** Tail of the write chain; never rejects. */
  private chain: Promise<void> = Promise.resolve();
  /** A write that is queued but has not started yet; new changes join it. */
  private queued: Promise<void> | undefined;
  /**
   * The last write failed, so the file is behind memory (e.g. a forget() or an
   * expiry removal is not on disk and a restart would bring the entry back).
   * Retried by the next write, by a record() that changes nothing, and once
   * per flush().
   */
  private dirty = false;
  /** Public calls that have not finished yet (they may still be waiting for the load). */
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(private readonly options: ContinuityStoreOptions) {
    this.file = options.file;
    const min =
      options.windowMin !== undefined && Number.isFinite(options.windowMin) && options.windowMin > 0
        ? options.windowMin
        : DEFAULT_CONTINUITY_MIN;
    this.windowMs = min * 60_000;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  /** Loads the file once (later calls share the first load). Never throws. */
  load(): Promise<void> {
    this.loading ??= this.doLoad();
    return this.loading;
  }

  private async doLoad(): Promise<void> {
    let loaded: Map<string, ContinuityEntry> | undefined;
    try {
      loaded = await readJsonOrQuarantine(this.file, parseContinuityFile, {
        fs: this.options.fs,
        retryDelaysMs: this.options.retryDelaysMs,
        now: this.now,
        onQuarantine: (info) =>
          this.log(
            "warn",
            info.movedTo
              ? `continuity: devices.json was invalid (${info.reason}); moved to ${info.movedTo}, starting empty`
              : `continuity: devices.json was invalid (${info.reason}) and could not be moved (${info.renameError}); starting empty`,
          ),
      });
    } catch (err) {
      this.log("warn", `continuity: cannot read devices.json (${describeError(err)}); starting empty`);
    }
    // Entries recorded before the load finished (none in practice: every public
    // method awaits load first) would win over the file.
    const merged = loaded ?? new Map<string, ContinuityEntry>();
    for (const [device, entry] of this.entries) merged.set(device, entry);
    this.entries = merged;
    this.prune();
  }

  private isExpired(e: ContinuityEntry, now: number): boolean {
    // A lastTurnAt far in the future (clock moved back, damaged file) also counts as expired,
    // so an entry can never live forever.
    return now - e.lastTurnAt > this.windowMs || e.lastTurnAt - now > this.windowMs;
  }

  /** Removes expired entries from memory; returns how many were removed. */
  private prune(): number {
    const now = this.now();
    let removed = 0;
    for (const [device, e] of this.entries) {
      if (this.isExpired(e, now)) {
        this.entries.delete(device);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Decides whether a device's new agent resumes its previous SDK session.
   * Expired and missing entries are removed (and the removal is written).
   */
  lookup(device: string): Promise<ContinuityLookup> {
    return this.track(this.doLookup(device));
  }

  private async doLookup(device: string): Promise<ContinuityLookup> {
    await this.load();
    // The transcript check is async: forget() or record() can change the entry
    // meanwhile. The decision is always made on the record current after the
    // check; when its session id changed, the new one is checked (bounded).
    for (let attempt = 0; attempt < MAX_LOOKUP_CHECKS; attempt++) {
      const entry = this.entries.get(device);
      if (!entry) return { resume: false, reason: "none" };
      if (this.isExpired(entry, this.now())) {
        this.entries.delete(device);
        void this.scheduleWrite();
        return { resume: false, reason: "expired" };
      }
      const check = this.options.getSessionInfo;
      if (!check) return { resume: true, sdkSessionId: entry.sdkSessionId };
      let info: unknown;
      try {
        info = await check(entry.sdkSessionId);
      } catch (err) {
        this.log("warn", `continuity: transcript check failed for device ${device} (${describeError(err)})`);
        return { resume: false, reason: "check_failed" };
      }
      const current = this.entries.get(device);
      // Forgotten while checking: the user asked for a new conversation.
      if (!current) return { resume: false, reason: "none" };
      // Replaced by a newer session while checking: check that one instead.
      if (current.sdkSessionId !== entry.sdkSessionId) continue;
      if (this.isExpired(current, this.now())) {
        this.entries.delete(device);
        void this.scheduleWrite();
        return { resume: false, reason: "expired" };
      }
      if (!info) {
        this.log("info", `continuity: missing (device ${device})`);
        this.entries.delete(device);
        void this.scheduleWrite();
        return { resume: false, reason: "missing" };
      }
      return { resume: true, sdkSessionId: current.sdkSessionId };
    }
    // The session kept changing under the check: start fresh this time, keep the entry.
    return { resume: false, reason: "check_failed" };
  }

  /**
   * Records the end of a model turn. Writes only when the session id or
   * `lastTurnAt` changed. Resolves when the resulting write has finished;
   * never rejects (failures are logged and retried with the next write).
   */
  record(device: string, sdkSessionId: string, lastTurnAt: number = this.now()): Promise<void> {
    return this.track(this.doRecord(device, sdkSessionId, lastTurnAt));
  }

  private async doRecord(device: string, sdkSessionId: string, lastTurnAt: number): Promise<void> {
    if (!DEVICE_RE.test(device)) {
      this.log("warn", "continuity: refusing an invalid device name");
      return;
    }
    if (!SESSION_ID_RE.test(sdkSessionId)) {
      this.log("warn", `continuity: refusing an invalid session id for device ${device}`);
      return;
    }
    if (!isTimestamp(lastTurnAt)) {
      this.log("warn", `continuity: refusing an invalid turn time for device ${device}`);
      return;
    }
    await this.load();
    const prev = this.entries.get(device);
    if (prev && prev.sdkSessionId === sdkSessionId && prev.lastTurnAt === lastTurnAt) {
      if (this.dirty) await this.scheduleWrite();
      return;
    }
    this.entries.set(device, { sdkSessionId, lastTurnAt, updatedAt: this.now() });
    await this.scheduleWrite();
  }

  /** Removes a device's entry (e.g. the user starts a new conversation). */
  forget(device: string): Promise<void> {
    return this.track(this.doForget(device));
  }

  private async doForget(device: string): Promise<void> {
    await this.load();
    if (!this.entries.delete(device)) return;
    await this.scheduleWrite();
  }

  /** Current entry (after expiry), for diagnostics and tests. */
  async get(device: string): Promise<ContinuityEntry | undefined> {
    await this.load();
    const e = this.entries.get(device);
    return e && !this.isExpired(e, this.now()) ? { ...e } : undefined;
  }

  /**
   * Waits until every call made so far has finished and its write is on disk
   * (shutdown chain). Never rejects.
   */
  async flush(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
    await this.chain;
    // One more try for a failed write (bounded: a flush never loops on a broken disk).
    if (this.dirty) await this.scheduleWrite();
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inflight.add(p);
    const done = () => this.inflight.delete(p);
    p.then(done, done);
    return p;
  }

  private scheduleWrite(): Promise<void> {
    if (this.queued) return this.queued;
    const run = this.chain.then(() => {
      this.queued = undefined;
      return this.writeNow();
    });
    this.queued = run;
    this.chain = run;
    return run;
  }

  /** Writes a snapshot of the current entries. Never rejects. */
  private async writeNow(): Promise<void> {
    this.prune();
    // Null prototype: a device named "__proto__" stays an ordinary key.
    const devices = Object.create(null) as Record<string, ContinuityEntry>;
    for (const [device, e] of [...this.entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      devices[device] = { sdkSessionId: e.sdkSessionId, lastTurnAt: e.lastTurnAt, updatedAt: e.updatedAt };
    }
    const body = `${JSON.stringify({ version: CONTINUITY_FILE_VERSION, devices }, null, 2)}\n`;
    // The snapshot above holds every change so far; a later change queues its own write.
    this.dirty = false;
    try {
      await writeFileAtomic(this.file, body, { fs: this.options.fs, retryDelaysMs: this.options.retryDelaysMs });
    } catch (err) {
      this.dirty = true;
      this.log("warn", `continuity: cannot write devices.json (${describeError(err)}); continuity may be lost`);
    }
  }
}

function describeError(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
    if (err instanceof Error) return err.name;
  }
  return "unknown error";
}
