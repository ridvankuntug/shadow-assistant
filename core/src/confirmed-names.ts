/**
 * Confirmed-name store (docs/14 Decision 6, T4.4a):
 * `<SHADOW_DATA_DIR>/device-names/names.json`.
 *
 * A confirmed name maps the words a user said for a device ("spoken", matched
 * through its folded stem forms, "keys") to a device **fingerprint** (canonical
 * name, domain, areas as seen in the live context at confirmation time). The
 * Core has no entity id; the fingerprint is the identity (user decision 2).
 *
 *   add() ──▶ active ──(30 days without a break missing in valid snapshots)──▶ passive
 *               ▲  │                                                            │
 *               │  └── missingSince set on the first miss, cleared when seen     │
 *               └──────────── add() for the same key (a fresh "Evet, hep bu") ◀──┘
 *   delete() removes an entry in any status.
 *
 * - One key maps to one entry: `add()` replaces every entry that shares a key
 *   with the new one (active or passive); the new entry is active with no
 *   missing clock.
 * - Cap MAX_NAMES entries. At the cap a new entry is refused with one log line;
 *   nothing is ever evicted (the user deletes rows in the panel).
 * - `sweep(snapshot)` runs the missing clock over all active entries. A snapshot
 *   that is not valid (not a list, empty, or any malformed entity) changes
 *   nothing. Present (one match) or ambiguous (two or more matches) clears the
 *   clock; missing sets it, and after MISSING_TO_PASSIVE_MS of uninterrupted
 *   absence the entry becomes passive. Passive entries are not swept and never
 *   become active by themselves (a device with the same fingerprint after 30
 *   days may be a different device; only a fresh confirmation revives it).
 * - `lookup(keys)` / `verify(entry, snapshot)` are synchronous and in-memory:
 *   lookup finds an active entry by its keys, verify says whether the snapshot
 *   holds exactly one entity with the fingerprint. An ambiguous or missing
 *   fingerprint is never used.
 * - Writes are atomic (writeFileAtomic) and serialized on one chain. A corrupt
 *   file, a version other than 1 or any malformed entry quarantines the whole
 *   file (one warning; the Core starts with no confirmed names). An invalid
 *   file that could not be moved aside is never overwritten. `add()` and
 *   `delete()` are all or nothing (applied in memory only once on disk);
 *   `sweep()` and `recordUse()` apply in memory at once and a failed write is
 *   retried by the next change.
 *
 * The file holds the user's words and device names; neither is ever logged
 * (log lines carry ids and counts only).
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readJsonOrQuarantine, writeFileAtomic, type AtomicFs } from "./atomic-file.js";
import type { LiveEntity } from "./live-context.js";

export type ConfirmedNameStatus = "active" | "passive";

/** Device fingerprint: canonical name (first of `names`), domain, areas. */
export interface NameTarget {
  name: string;
  domain: string;
  areas: string[];
}

export interface ConfirmedName {
  /** `n-` + 6 hex chars. */
  id: string;
  /** The words the user said (display only). */
  spoken: string;
  /** Folded stem forms of `spoken` (match keys); unique across the file. */
  keys: string[];
  target: NameTarget;
  status: ConfirmedNameStatus;
  /** ISO 8601 of the first valid snapshot that lacked the fingerprint since it was last seen, else null. */
  missingSince: string | null;
  /** ISO 8601. */
  createdAt: string;
  lastUsedAt: string | null;
  uses: number;
}

export interface ConfirmedNamesFile {
  version: 1;
  names: ConfirmedName[];
}

export const CONFIRMED_NAMES_DIR = "device-names";
export const CONFIRMED_NAMES_FILE = "names.json";
export const MAX_NAMES = 200;
/** "Aralıksız 30 gün" (user decision 4). */
export const MISSING_TO_PASSIVE_MS = 30 * 24 * 60 * 60 * 1000;
/** Upper bounds that keep a hand-edited or hostile file small; far above real use. */
export const MAX_KEYS_PER_NAME = 16;
export const MAX_TEXT_LENGTH = 200;
export const MAX_AREAS = 16;

const ID_RE = /^n-[0-9a-f]{6}$/;
const DOMAIN_RE = /^[a-z0-9_]{1,64}$/;
const STATUSES: ReadonlySet<string> = new Set<ConfirmedNameStatus>(["active", "passive"]);

/** Trim, NFC, single spaces. Applied to keys, spoken text and fingerprint parts on add, lookup and compare. */
export function normalizeText(s: string): string {
  return s.normalize("NFC").replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------- snapshot checks (pure)

/**
 * A valid snapshot is a parsed `GetLiveContext` result with at least one
 * entity, every entity well formed (a non-blank canonical name and domain). Anything else (an error the caller mapped
 * to `undefined`, an empty list, a malformed element) is not valid and must
 * neither start nor clear a missing clock.
 */
export function isValidSnapshot(snapshot: unknown): snapshot is readonly LiveEntity[] {
  if (!Array.isArray(snapshot) || snapshot.length === 0) return false;
  return snapshot.every((e: unknown) => {
    if (typeof e !== "object" || e === null) return false;
    const o = e as Record<string, unknown>;
    return (
      Array.isArray(o.names) &&
      o.names.length > 0 &&
      o.names.every((n) => typeof n === "string") &&
      // An entity without a canonical name or domain would make every fingerprint look missing.
      normalizeText(o.names[0] as string) !== "" &&
      typeof o.domain === "string" &&
      o.domain.trim() !== "" &&
      Array.isArray(o.areas) &&
      o.areas.every((a) => typeof a === "string")
    );
  });
}

function areaKey(areas: readonly string[]): string {
  return JSON.stringify([...new Set(areas.map(normalizeText))].sort());
}

/** Exact fingerprint equality (after normalizeText; areas as a set). `state` and attributes are not part of it. */
export function matchesFingerprint(target: NameTarget, entity: LiveEntity): boolean {
  const first = entity.names[0];
  return (
    first !== undefined &&
    normalizeText(first) === normalizeText(target.name) &&
    entity.domain === target.domain &&
    areaKey(entity.areas) === areaKey(target.areas)
  );
}

/** The fingerprint as a live entity would give it (for building an `add()` target). */
export function fingerprintOf(entity: LiveEntity): NameTarget {
  return { name: normalizeText(entity.names[0] ?? ""), domain: entity.domain, areas: entity.areas.map(normalizeText) };
}

export type Verification =
  /** Exactly one entity with the fingerprint: usable. */
  | { status: "present"; entity: LiveEntity }
  /** Two or more: not used, but the device exists (counts as present for the clock). */
  | { status: "ambiguous"; count: number }
  /** None: not used. */
  | { status: "missing" }
  /** The snapshot is not valid: not used, says nothing about the device. */
  | { status: "invalid_snapshot" };

/** Checks one fingerprint against a snapshot. Pure. */
export function verifyTarget(target: NameTarget, snapshot: unknown): Verification {
  if (!isValidSnapshot(snapshot)) return { status: "invalid_snapshot" };
  const hits = snapshot.filter((e) => matchesFingerprint(target, e));
  if (hits.length === 1) return { status: "present", entity: hits[0] as LiveEntity };
  if (hits.length === 0) return { status: "missing" };
  return { status: "ambiguous", count: hits.length };
}

// ---------------------------------------------------------------- store

export interface AddInput {
  spoken: string;
  keys: readonly string[];
  target: NameTarget;
}

export type AddResult =
  | { ok: true; entry: ConfirmedName; replaced: string[] }
  /**
   * `invalid`: empty or oversized input; `cap`: MAX_NAMES entries already
   * (logged); `unavailable`: the file cannot be read; `write_failed`: not on
   * disk, so not applied.
   */
  | { ok: false; reason: "invalid" | "cap" | "unavailable" | "write_failed" };

export type DeleteResult =
  | { ok: true }
  | { ok: false; reason: "unknown" | "unavailable" | "write_failed" };

export interface SweepResult {
  /** The snapshot was valid and the entries were checked. */
  checked: boolean;
  /** Entries whose missing clock started in this sweep. */
  started: number;
  /** Entries whose missing clock was cleared. */
  cleared: number;
  /** Entries that became passive. */
  passivated: number;
}

export interface ConfirmedNameStoreOptions {
  /** `<SHADOW_DATA_DIR>/device-names`. */
  dir: string;
  now?: () => number;
  log?: (msg: string) => void;
  maxNames?: number;
  /** Id source (tests); default 3 random bytes. */
  randomId?: () => string;
  fs?: AtomicFs;
  retryDelaysMs?: readonly number[];
}

type Change<T> = { result: T; changed: boolean };

export class ConfirmedNameStore {
  readonly file: string;
  private readonly now: () => number;
  private data: ConfirmedNamesFile | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private pending = false;
  /** Active entries by key (frozen copies); swapped after each committed change. */
  private index: ReadonlyMap<string, Readonly<ConfirmedName>> = new Map();

  constructor(private readonly o: ConfirmedNameStoreOptions) {
    this.file = join(o.dir, CONFIRMED_NAMES_FILE);
    this.now = o.now ?? Date.now;
  }

  /** Loads the file now (startup). Never rejects. */
  async load(): Promise<void> {
    await this.change(undefined, () => ({ result: undefined, changed: false }));
  }

  /**
   * The active entry for the given keys (the caller's folded stem forms of the
   * spoken name). Synchronous, in memory; empty before `load()`. When the keys
   * hit two or more different entries the result is `undefined`: no guess.
   */
  lookup(keys: readonly string[]): Readonly<ConfirmedName> | undefined {
    let found: Readonly<ConfirmedName> | undefined;
    for (const k of keys) {
      const e = this.index.get(normalizeText(k));
      if (!e) continue;
      if (found && found.id !== e.id) return undefined;
      found = e;
    }
    return found;
  }

  /** Whether the entry's fingerprint can be used with this snapshot (see verifyTarget). Passive entries are never usable. */
  verify(entry: Pick<ConfirmedName, "target" | "status">, snapshot: unknown): Verification {
    if (entry.status !== "active") return { status: "missing" };
    return verifyTarget(entry.target, snapshot);
  }

  /**
   * Runs the missing clock over the active entries against a snapshot the
   * Core already holds. An invalid snapshot changes nothing. Never rejects.
   * The snapshot must be a full, unfiltered `GetLiveContext` read (tier-0
   * parse, gate rule-4 read): a filtered read would start the clock of every
   * device outside the filter.
   */
  sweep(snapshot: unknown): Promise<SweepResult> {
    const none: SweepResult = { checked: false, started: 0, cleared: 0, passivated: 0 };
    if (!isValidSnapshot(snapshot)) return Promise.resolve(none);
    // Copy the fingerprint parts now: the caller may change its snapshot while the chain waits.
    const entities: LiveEntity[] = snapshot.map((e) => ({ names: [...e.names], domain: e.domain, state: "", areas: [...e.areas], attributes: {} }));
    return this.change<SweepResult>(none, (data) => {
      const now = this.now();
      const stamp = new Date(now).toISOString();
      const r: SweepResult = { checked: true, started: 0, cleared: 0, passivated: 0 };
      for (const e of data.names) {
        if (e.status !== "active") continue;
        const v = verifyTarget(e.target, entities);
        if (v.status === "present" || v.status === "ambiguous") {
          if (e.missingSince !== null) {
            e.missingSince = null;
            r.cleared++;
          }
          continue;
        }
        if (v.status !== "missing") continue;
        if (e.missingSince === null) {
          e.missingSince = stamp;
          r.started++;
        }
        const since = Date.parse(e.missingSince);
        if (Number.isFinite(since) && now - since >= MISSING_TO_PASSIVE_MS) {
          e.status = "passive";
          r.passivated++;
          this.o.log?.(`[shadow-core] confirmed name ${e.id} is passive: missing for 30 days`);
        }
      }
      return { result: r, changed: r.started + r.cleared + r.passivated > 0 };
    });
  }

  /**
   * Stores a confirmed name ("Evet, hep bu" after a successful call). Every
   * entry sharing a key with the new one is replaced (whatever its status).
   * All or nothing: applied only once written.
   */
  add(input: AddInput): Promise<AddResult> {
    const clean = cleanInput(input);
    if (!clean) return Promise.resolve({ ok: false, reason: "invalid" });
    return this.transaction<AddResult>({ ok: false, reason: "unavailable" }, (data) => {
      const keySet = new Set(clean.keys);
      const replaced = data.names.filter((e) => e.keys.some((k) => keySet.has(k)));
      const kept = data.names.filter((e) => !replaced.includes(e));
      const max = this.o.maxNames ?? MAX_NAMES;
      if (kept.length >= max) {
        this.o.log?.(`[shadow-core] confirmed names: cap of ${max} reached, new name refused`);
        return { ok: false, reason: "cap" };
      }
      const ids = new Set(data.names.map((e) => e.id));
      let id = "";
      for (let i = 0; i < 32 && (id === "" || ids.has(id)); i++) id = `n-${this.o.randomId?.() ?? randomBytes(3).toString("hex")}`;
      if (!ID_RE.test(id) || ids.has(id)) return { ok: false, reason: "invalid" };
      const entry: ConfirmedName = {
        id,
        spoken: clean.spoken,
        keys: clean.keys,
        target: clean.target,
        status: "active",
        missingSince: null,
        createdAt: new Date(this.now()).toISOString(),
        lastUsedAt: null,
        uses: 0,
      };
      data.names = [...kept, entry];
      return { ok: true, entry: structuredClone(entry), replaced: replaced.map((e) => e.id) };
    });
  }

  /** Removes an entry in any status ("Sil" in the panel). All or nothing. */
  delete(id: string): Promise<DeleteResult> {
    return this.transaction<DeleteResult>({ ok: false, reason: "unavailable" }, (data) => {
      const before = data.names.length;
      data.names = data.names.filter((e) => e.id !== id);
      return data.names.length === before ? { ok: false, reason: "unknown" } : { ok: true };
    });
  }

  /** Counts one successful use of an active entry (`uses`, `lastUsedAt`). Resolves whether it was counted. Never rejects. */
  recordUse(id: string): Promise<boolean> {
    return this.change(false, (data) => {
      const e = data.names.find((x) => x.id === id);
      if (!e || e.status !== "active") return { result: false, changed: false };
      e.uses++;
      e.lastUsedAt = new Date(this.now()).toISOString();
      return { result: true, changed: true };
    });
  }

  /** All entries (copies), for the names panel. Empty if the file cannot be read. */
  list(): Promise<ConfirmedName[]> {
    return this.change<ConfirmedName[]>([], (data) => ({ result: structuredClone(data.names), changed: false }));
  }

  /** Retries a failed write now (shutdown). Never rejects. */
  async flush(): Promise<void> {
    await this.change(undefined, () => ({ result: undefined, changed: false }));
  }

  // ---------------------------------------------------------------- internals

  private rebuildIndex(data: ConfirmedNamesFile): void {
    const index = new Map<string, Readonly<ConfirmedName>>();
    for (const e of data.names) {
      if (e.status !== "active") continue;
      const copy = deepFreeze(structuredClone(e));
      for (const k of e.keys) index.set(k, copy);
    }
    this.index = index;
  }

  private async write(data: ConfirmedNamesFile): Promise<void> {
    await writeFileAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`, { fs: this.o.fs, retryDelaysMs: this.o.retryDelaysMs });
  }

  /** Runs `fn` on the loaded data under the chain; writes when it changed anything (or an earlier write failed). */
  private change<T>(fallback: T, fn: (data: ConfirmedNamesFile) => Change<T>): Promise<T> {
    const run = this.chain.then(async () => {
      let data: ConfirmedNamesFile;
      try {
        data = await this.loaded();
      } catch (err) {
        this.o.log?.(`[shadow-core] confirmed names file could not be read: ${errName(err)}`);
        return fallback;
      }
      const { result, changed } = fn(data);
      if (changed || this.pending) {
        try {
          await this.write(data);
          this.pending = false;
        } catch (err) {
          this.pending = true;
          this.o.log?.(`[shadow-core] confirmed names write failed: ${errName(err)}`);
        }
      }
      if (changed) this.rebuildIndex(data);
      return result;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  /** Like `change`, but all or nothing: `fn` works on a copy that replaces the state only once written. */
  private transaction<T extends { ok: boolean }>(fallback: T, fn: (data: ConfirmedNamesFile) => T): Promise<T | { ok: false; reason: "write_failed" }> {
    const run = this.chain.then(async (): Promise<T | { ok: false; reason: "write_failed" }> => {
      let current: ConfirmedNamesFile;
      try {
        current = await this.loaded();
      } catch (err) {
        this.o.log?.(`[shadow-core] confirmed names file could not be read: ${errName(err)}`);
        return fallback;
      }
      const next = structuredClone(current);
      const result = fn(next);
      if (!result.ok) return result;
      try {
        await this.write(next);
      } catch (err) {
        this.o.log?.(`[shadow-core] confirmed names write failed, change not applied: ${errName(err)}`);
        return { ok: false, reason: "write_failed" };
      }
      this.pending = false;
      this.data = next;
      this.rebuildIndex(next);
      return result;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private async loaded(): Promise<ConfirmedNamesFile> {
    if (this.data) return this.data;
    let leftInPlace = false;
    const read = await readJsonOrQuarantine(this.file, validateFile, {
      fs: this.o.fs,
      retryDelaysMs: this.o.retryDelaysMs,
      now: this.now,
      onQuarantine: (info) => {
        if (info.movedTo) this.o.log?.("[shadow-core] confirmed names file was invalid and was moved aside; starting with no confirmed names");
        else leftInPlace = true;
      },
    });
    if (leftInPlace) throw Object.assign(new Error("invalid file could not be moved aside"), { code: "QUARANTINE_FAILED" });
    const data = read ?? { version: 1 as const, names: [] };
    this.data = data;
    this.rebuildIndex(data);
    return data;
  }
}

// ---------------------------------------------------------------- input and file validation

function textOk(s: string): boolean {
  return s.length > 0 && s.length <= MAX_TEXT_LENGTH;
}

/** Normalized add() input, or undefined when it cannot be stored. */
function cleanInput(input: AddInput): { spoken: string; keys: string[]; target: NameTarget } | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  if (typeof input.spoken !== "string" || !Array.isArray(input.keys) || typeof input.target !== "object" || input.target === null) return undefined;
  const spoken = normalizeText(input.spoken);
  const keys = [...new Set(input.keys.filter((k): k is string => typeof k === "string").map(normalizeText))];
  const t = input.target;
  if (typeof t.name !== "string" || typeof t.domain !== "string" || !Array.isArray(t.areas)) return undefined;
  if (!t.areas.every((a) => typeof a === "string")) return undefined;
  const target: NameTarget = { name: normalizeText(t.name), domain: t.domain, areas: [...new Set(t.areas.map(normalizeText))] };
  if (!textOk(spoken) || keys.length === 0 || keys.length > MAX_KEYS_PER_NAME || !keys.every(textOk)) return undefined;
  if (!textOk(target.name) || !DOMAIN_RE.test(target.domain) || target.areas.length > MAX_AREAS || !target.areas.every(textOk)) return undefined;
  return { spoken, keys, target };
}

const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
/** A stored text field, normalized (a hand edit may leave extra spaces or another Unicode form), or undefined. */
const text = (v: unknown): string | undefined => (typeof v === "string" && textOk(normalizeText(v)) ? normalizeText(v) : undefined);
const texts = (v: unknown, max: number): string[] | undefined => {
  if (!Array.isArray(v) || v.length > max) return undefined;
  const out = v.map(text);
  return out.every((x): x is string => x !== undefined) ? out : undefined;
};

function validateTarget(v: unknown): NameTarget | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const name = text(o.name);
  const areas = texts(o.areas, MAX_AREAS);
  if (name === undefined || areas === undefined || typeof o.domain !== "string" || !DOMAIN_RE.test(o.domain)) return undefined;
  return { name, domain: o.domain, areas };
}

function validateEntry(v: unknown): ConfirmedName | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !ID_RE.test(o.id)) return undefined;
  const spoken = text(o.spoken);
  const keys = texts(o.keys, MAX_KEYS_PER_NAME);
  if (spoken === undefined || keys === undefined || keys.length === 0 || new Set(keys).size !== keys.length) return undefined;
  const target = validateTarget(o.target);
  if (!target) return undefined;
  if (typeof o.status !== "string" || !STATUSES.has(o.status)) return undefined;
  if (o.missingSince !== null && !isIso(o.missingSince)) return undefined;
  if (!isIso(o.createdAt)) return undefined;
  if (o.lastUsedAt !== null && !isIso(o.lastUsedAt)) return undefined;
  if (!isCount(o.uses)) return undefined;
  return {
    id: o.id,
    spoken,
    keys,
    target,
    status: o.status as ConfirmedNameStatus,
    missingSince: o.missingSince as string | null,
    createdAt: o.createdAt,
    lastUsedAt: o.lastUsedAt as string | null,
    uses: o.uses,
  };
}

/**
 * The whole file or nothing: one malformed entry, a duplicate id or a key used
 * by two entries quarantines it. More than MAX_NAMES entries (a hand edit) is
 * accepted as is: nothing is dropped, `add()` refuses until rows are deleted.
 */
export function validateFile(v: unknown): ConfirmedNamesFile | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (o.version !== 1 || !Array.isArray(o.names)) return undefined;
  const names: ConfirmedName[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const raw of o.names as unknown[]) {
    const e = validateEntry(raw);
    if (!e || ids.has(e.id) || e.keys.some((k) => keys.has(k))) return undefined;
    ids.add(e.id);
    for (const k of e.keys) keys.add(k);
    names.push(e);
  }
  return { version: 1, names };
}

function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v)) deepFreeze(x);
  }
  return v;
}

function errName(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
    if (err instanceof Error) return err.name;
  }
  return "error";
}
