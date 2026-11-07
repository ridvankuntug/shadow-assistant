/**
 * Development notes (T7.y, T7.w.3; docs/08-learning-fast-path.md): counted,
 * privacy-safe notes for the Development tab. Two files in
 * `<SHADOW_DATA_DIR>/dev-notes/`, both version 1:
 *
 * `tools.json` (writer: the MCP gateway's tool-list refresh):
 *
 *   {
 *     "version": 1,
 *     "catalog": { "<service>": ["<tool>", …] },   // last tool list seen
 *     "notes": [ { kind, service, tool, level?, count, firstSeen, lastSeen, status?, statusAt? } ]
 *   }
 *
 *   Note kinds (one note per kind + service + tool; repeats only bump `count`
 *   and `lastSeen`, at most once per `touchMs`, so the file does not grow):
 *   - `new_tool`       "new tool: classify" — listed, but no services.yaml rule names it
 *                      (it runs at `confirm` until classified)
 *   - `tool_added`     appeared since the previous list (not on the first list)
 *   - `tool_removed`   was in the previous list, gone now (a rename shows as removed + added)
 *   - `rule_unmatched` an exact services.yaml rule names a tool the service does not list
 *
 * `turns.json` (writers: the session and the gateway's call path, T7.w.3b):
 *
 *   { "version": 1, "notes": [ { kind, …key fields, message, count, firstSeen, lastSeen,
 *                                 lastTurnId?, status?, statusAt? } ] }
 *
 *   - `missing_capability` key: reason + service + tool
 *   - `wandering`          key: tier + route source/rule + sorted unique tool names (max 5)
 *   - `tool_error`         key: service + tool + errorClass
 *   - `rule_suspended`     key: rule id + reason
 *   Every occurrence counts; writes are coalesced (at most one per `coalesceMs`,
 *   `flush()` on shutdown).
 *
 * Both files share the counting logic (`observeNote`: find by key, bump
 * `count` / `lastSeen`; `capNotes`: keep the MAX_NOTES most recently seen) and
 * the file handling (`CountedNotesFile`: quarantine on corruption, serialized
 * atomic writes). `status` (`ignored` / `fixed`, absent = open) is set by the
 * Development tab; a `fixed` note observed again after `statusAt` is open again,
 * an `ignored` note keeps counting.
 *
 * Privacy: only enum values, tool / service / rule names, tier, counts, times
 * and the opaque turn id are stored. Never user text, arguments, results,
 * entity or room names, error messages, URLs or tokens. TurnNotes copies the
 * whitelisted fields of its input one by one (never spreads it), and names it
 * cannot trust (a tool name the model made up) must look like an identifier.
 */
import { join } from "node:path";
import { readJsonOrQuarantine, writeFileAtomic } from "./atomic-file.js";

// ---------------------------------------------------------------------------
// Shared counted-notes helper

export type NoteStatus = "ignored" | "fixed";

/** The fields every counted note has. */
export interface CountedNote {
  count: number;
  firstSeen: string;
  lastSeen: string;
  /** Development-tab state; absent = open. */
  status?: NoteStatus;
  /** When `status` was set (ISO). */
  statusAt?: string;
}

export interface ObserveResult<N> {
  note: N;
  created: boolean;
  /** Whether anything in the note list changed (the file needs a write). */
  changed: boolean;
}

/**
 * Finds the note whose `keyOf` equals `key` and records one observation, or
 * appends `create(stamp)`. With `touchMs` set, a repeat bumps `count` /
 * `lastSeen` only if the last one is at least `touchMs` old; without it every
 * observation counts. A `fixed` note observed after its `statusAt` is opened
 * again (status cleared), whether or not the observation counts.
 */
export function observeNote<N extends CountedNote>(
  notes: N[],
  keyOf: (n: N) => string,
  key: string,
  nowMs: number,
  create: (stamp: string) => N,
  touchMs?: number,
): ObserveResult<N> {
  const stamp = new Date(nowMs).toISOString();
  const existing = notes.find((n) => keyOf(n) === key);
  if (!existing) {
    const note = create(stamp);
    notes.push(note);
    return { note, created: true, changed: true };
  }
  let changed = false;
  // `!(now <= at)` also reopens a note whose statusAt is missing or unparsable.
  if (existing.status === "fixed" && !(nowMs <= Date.parse(existing.statusAt ?? ""))) {
    delete existing.status;
    delete existing.statusAt;
    changed = true;
  }
  if (touchMs === undefined || nowMs - Date.parse(existing.lastSeen) >= touchMs) {
    existing.count++;
    existing.lastSeen = stamp;
    changed = true;
  }
  return { note: existing, created: false, changed };
}

/** Drops the least recently seen notes beyond `max`. Returns whether it dropped any. */
export function capNotes<N extends CountedNote>(notes: N[], max: number): boolean {
  if (notes.length <= max) return false;
  notes.sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
  notes.length = max;
  return true;
}

/**
 * Sets `status` on the note with `key`. Returns false if there is no such note.
 * Setting the status a note already has is a no-op (statusAt unchanged).
 */
export function setNoteStatus<N extends CountedNote>(
  notes: N[],
  keyOf: (n: N) => string,
  key: string,
  status: NoteStatus,
  nowMs: number,
): { found: boolean; changed: boolean } {
  const note = notes.find((n) => keyOf(n) === key);
  if (!note) return { found: false, changed: false };
  if (note.status === status) return { found: true, changed: false };
  note.status = status;
  note.statusAt = new Date(nowMs).toISOString();
  return { found: true, changed: true };
}

export interface CountedNotesFileOptions<F> {
  /** `<SHADOW_DATA_DIR>/dev-notes`. */
  dir: string;
  /** File name inside `dir`. */
  name: string;
  /** Log prefix after "[shadow-core] ", e.g. "dev-notes". */
  label: string;
  validate: (value: unknown) => F | undefined;
  empty: () => F;
  log?: (msg: string) => void;
  /**
   * 0 / undefined: every changing update is written before its promise
   * settles. > 0: changes are kept in memory and written at most once per
   * this many ms (and on `flush()`); a failed write is retried by the next
   * write.
   */
  coalesceMs?: number;
}

/**
 * One JSON file of counted notes: lazy load (an invalid file is quarantined and
 * a fresh one started), updates serialized in-process, atomic writes. Never
 * throws from `update()` / `flush()`: failures are logged and the in-memory
 * state is kept.
 */
export class CountedNotesFile<F> {
  readonly file: string;
  private data: F | undefined;
  /** Serializes load + update + write. */
  private chain: Promise<unknown> = Promise.resolve();
  /** In-memory changes not yet on disk (a coalesced change, or a failed write). */
  private pending = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly coalesceMs: number;

  constructor(private readonly o: CountedNotesFileOptions<F>) {
    this.file = join(o.dir, o.name);
    this.coalesceMs = o.coalesceMs ?? 0;
  }

  /**
   * Runs `fn` on the loaded data; `fn` returns whether it changed anything.
   * The promise settles once the change is applied (and, without coalescing,
   * written or failed to write). Never rejects.
   */
  update(fn: (data: F) => boolean): Promise<void> {
    return this.enqueue(async () => {
      const data = await this.load();
      if (!fn(data)) return;
      // Set in both modes and cleared only by a successful write, so flush()
      // retries a failed immediate write too.
      this.pending = true;
      if (this.coalesceMs > 0) {
        this.schedule();
        return;
      }
      await this.write(data);
      this.pending = false;
    });
  }

  /** Writes pending coalesced changes now (shutdown). Never rejects. */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    return this.enqueue(async () => {
      if (!this.pending || this.data === undefined) return;
      await this.write(this.data);
      this.pending = false;
    });
  }

  /** A copy of the current contents, after all queued updates. */
  async read(): Promise<F> {
    await this.chain;
    return structuredClone(await this.load());
  }

  private enqueue(step: () => Promise<void>): Promise<void> {
    const run = this.chain.then(step);
    this.chain = run.catch(() => {});
    return run.catch((err: unknown) =>
      this.o.log?.(`[shadow-core] ${this.o.label} write failed: ${(err as Error)?.message ?? String(err)}`),
    );
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.coalesceMs);
    // A pending write never keeps the process alive; shutdown calls flush().
    this.timer.unref?.();
  }

  private async load(): Promise<F> {
    if (this.data === undefined) {
      const loaded = await readJsonOrQuarantine(this.file, this.o.validate, {
        onQuarantine: () => this.o.log?.(`[shadow-core] ${this.o.label} file was invalid and was moved aside`),
      });
      this.data = loaded ?? this.o.empty();
    }
    return this.data;
  }

  private async write(data: F): Promise<void> {
    // writeFileAtomic creates the directory.
    await writeFileAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`);
  }
}

// ---------------------------------------------------------------------------
// tools.json (T7.y)

export type DevNoteKind = "new_tool" | "tool_added" | "tool_removed" | "rule_unmatched";

export interface DevNote extends CountedNote {
  kind: DevNoteKind;
  service: string;
  tool: string;
  /** Short Turkish text for the Development tab. */
  message: string;
  /** Permission level a plain call gets (new_tool / tool_added). */
  level?: string;
}

export interface DevNotesFile {
  version: 1;
  catalog: Record<string, string[]>;
  notes: DevNote[];
}

/** One tool of a fresh list, as the policy classifies it. */
export interface CatalogEntry {
  name: string;
  classified: boolean;
  level: string;
}

export const DEV_NOTES_FILE = "tools.json";
/** A repeated observation updates `count`/`lastSeen` at most this often. */
export const DEFAULT_TOUCH_MS = 60 * 60_000;
/** Hard cap so a service with a huge or churning tool list cannot grow the file without bound. */
export const MAX_NOTES = 500;

const MESSAGES: Record<DevNoteKind, string> = {
  new_tool: "yeni araç: sınıflandır",
  tool_added: "araç eklendi",
  tool_removed: "araç kayboldu (adı değişmiş olabilir)",
  rule_unmatched: "services.yaml kuralındaki araç listede yok (adı değişmiş olabilir)",
};

/** Identity of a tools.json note (one note per key). */
export function toolNoteKey(n: Pick<DevNote, "kind" | "service" | "tool">): string {
  return JSON.stringify([n.kind, n.service, n.tool]);
}

export interface DevNotesOptions {
  /** `<SHADOW_DATA_DIR>/dev-notes`. */
  dir: string;
  now?: () => number;
  touchMs?: number;
  log?: (msg: string) => void;
}

export class DevNotes {
  readonly file: string;
  private readonly now: () => number;
  private readonly touchMs: number;
  private readonly store: CountedNotesFile<DevNotesFile>;

  constructor(o: DevNotesOptions) {
    this.now = o.now ?? Date.now;
    this.touchMs = o.touchMs ?? DEFAULT_TOUCH_MS;
    this.store = new CountedNotesFile({
      dir: o.dir,
      name: DEV_NOTES_FILE,
      label: "dev-notes",
      validate: validateToolsFile,
      empty: () => ({ version: 1, catalog: {}, notes: [] }),
      log: o.log,
    });
    this.file = this.store.file;
  }

  /**
   * Records one successful tool list of `service`. `exactRules` are the
   * services.yaml exact rule names of the service. Never throws; the
   * returned promise settles once the file is written (or the write failed).
   */
  recordCatalog(service: string, tools: readonly CatalogEntry[], exactRules: readonly string[] = []): Promise<void> {
    return this.store.update((data) => this.apply(data, service, tools, exactRules));
  }

  /**
   * Sets the Development-tab status of the note with `key` (see toolNoteKey).
   * Resolves false if there is no such note. Never rejects.
   */
  async setStatus(key: string, status: NoteStatus): Promise<boolean> {
    let found = false;
    await this.store.update((data) => {
      const r = setNoteStatus(data.notes, toolNoteKey, key, status, this.now());
      found = r.found;
      return r.changed;
    });
    return found;
  }

  /** Current contents (for tests and the Development tab). */
  read(): Promise<DevNotesFile> {
    return this.store.read();
  }

  private apply(data: DevNotesFile, service: string, tools: readonly CatalogEntry[], exactRules: readonly string[]): boolean {
    const nowMs = this.now();
    let dirty = false;
    const observe = (kind: DevNoteKind, tool: string, level?: string) => {
      const r = observeNote(
        data.notes,
        toolNoteKey,
        toolNoteKey({ kind, service, tool }),
        nowMs,
        (stamp) => ({
          kind,
          service,
          tool,
          message: MESSAGES[kind],
          ...(level !== undefined ? { level } : {}),
          count: 1,
          firstSeen: stamp,
          lastSeen: stamp,
        }),
        this.touchMs,
      );
      if (r.changed) dirty = true;
      if (!r.created && level !== undefined && r.note.level !== level) {
        r.note.level = level;
        dirty = true;
      }
    };

    const names = new Set(tools.map((t) => t.name));
    const previous = data.catalog[service];
    for (const t of tools) {
      if (!t.classified) observe("new_tool", t.name, t.level);
      if (previous && !previous.includes(t.name)) observe("tool_added", t.name, t.level);
    }
    for (const old of previous ?? []) if (!names.has(old)) observe("tool_removed", old);
    for (const rule of exactRules) if (!names.has(rule)) observe("rule_unmatched", rule);

    const sorted = [...names].sort();
    if (!previous || previous.length !== sorted.length || previous.some((n, i) => n !== sorted[i])) {
      data.catalog[service] = sorted;
      dirty = true;
    }
    if (capNotes(data.notes, MAX_NOTES)) dirty = true;
    return dirty;
  }
}

function validateToolsFile(v: unknown): DevNotesFile | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (o.version !== 1 || typeof o.catalog !== "object" || o.catalog === null || !Array.isArray(o.notes)) return undefined;
  const catalog: Record<string, string[]> = {};
  for (const [k, list] of Object.entries(o.catalog as Record<string, unknown>)) {
    if (Array.isArray(list)) catalog[k] = list.filter((x): x is string => typeof x === "string");
  }
  const notes = (o.notes as unknown[]).filter(
    (n): n is DevNote =>
      isCountedNote(n) &&
      typeof (n as DevNote).kind === "string" &&
      typeof (n as DevNote).service === "string" &&
      typeof (n as DevNote).tool === "string",
  );
  return { version: 1, catalog, notes };
}

function isCountedNote(n: unknown): n is CountedNote {
  return (
    typeof n === "object" &&
    n !== null &&
    typeof (n as CountedNote).count === "number" &&
    typeof (n as CountedNote).firstSeen === "string" &&
    typeof (n as CountedNote).lastSeen === "string"
  );
}

// ---------------------------------------------------------------------------
// turns.json (T7.w.3)

export type TurnNoteKind = "missing_capability" | "wandering" | "tool_error" | "rule_suspended";
/** Why a capability is missing: a built-in tool (gate), a tool outside the tier's services, a name the gateway does not list. */
export type MissingReason = "builtin" | "tier_service" | "unknown_tool";
/** What made a turn wander: ≥ `wander_calls` tool calls, or the tool-call cap stopped it. */
export type WanderTrigger = "calls" | "tool_cap";
/** A tool result with `isError`, or the service could not be reached. */
export type ToolErrorClass = "error" | "unavailable";
/** Model tiers (router.ts `Tier`). */
export type NoteTier = 0 | 1 | 2 | 3;

/** What a caller reports. Only these fields are read; anything else on the object is ignored. */
export type TurnNoteInput =
  | { kind: "missing_capability"; reason: MissingReason; tool: string; service?: string; turnId?: string }
  | {
      kind: "wandering";
      trigger: WanderTrigger;
      tier: NoteTier;
      /** Route source (e.g. "static", "learned", "default"). */
      routeSource: string;
      /** Static rule id or learned rule id, if the route came from one. */
      routeRule?: string;
      /** Tool names called in the turn (any order, repeats allowed). */
      tools: readonly string[];
      turnId?: string;
    }
  | { kind: "tool_error"; service: string; tool: string; errorClass: ToolErrorClass; turnId?: string }
  | { kind: "rule_suspended"; ruleId: string; reason: string; turnId?: string };

export interface TurnNote extends CountedNote {
  kind: TurnNoteKind;
  reason?: string;
  service?: string;
  tool?: string;
  tier?: NoteTier;
  routeSource?: string;
  routeRule?: string;
  tools?: string[];
  /** Latest trigger of a `wandering` note (not part of its key). */
  trigger?: WanderTrigger;
  errorClass?: ToolErrorClass;
  ruleId?: string;
  /** Short Turkish text for the Development tab. */
  message: string;
  /** Opaque id of the last turn that produced this note (points into the local conversation log). */
  lastTurnId?: string;
}

export interface TurnNotesFile {
  version: 1;
  notes: TurnNote[];
}

export const TURN_NOTES_FILE = "turns.json";
/** Turn notes are written at most this often (and on flush). */
export const DEFAULT_COALESCE_MS = 3_000;
/** Most tool names kept in a `wandering` note (and its key). */
export const MAX_WANDER_TOOLS = 5;
/** Stand-in for a name that does not look like an identifier (it could be anything the model wrote). */
export const INVALID_NAME = "?";

const TURN_KINDS: ReadonlySet<string> = new Set<TurnNoteKind>(["missing_capability", "wandering", "tool_error", "rule_suspended"]);
const MISSING_REASONS: ReadonlySet<string> = new Set<MissingReason>(["builtin", "tier_service", "unknown_tool"]);
const WANDER_TRIGGERS: ReadonlySet<string> = new Set<WanderTrigger>(["calls", "tool_cap"]);
const ERROR_CLASSES: ReadonlySet<string> = new Set<ToolErrorClass>(["error", "unavailable"]);

/** Tool, service and rule names: identifier characters only, bounded. Anything else is not stored. */
const NAME_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Enum-like reasons from other modules (e.g. a suspension reason): lower snake case. */
const REASON_RE = /^[a-z][a-z0-9_]{0,39}$/;
/** Turn ids are generated by the Core; anything else is dropped. */
const TURN_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

const MISSING_MESSAGES: Record<MissingReason, string> = {
  builtin: "model kapalı bir yerleşik araç istedi",
  tier_service: "istenen araç bu katmanın servislerinde yok",
  unknown_tool: "model listede olmayan bir araç istedi",
};
const ERROR_MESSAGES: Record<ToolErrorClass, string> = {
  error: "araç hata döndürdü",
  unavailable: "servise ulaşılamadı",
};
const WANDER_MESSAGE = "tur dağıldı: çok fazla araç çağrısı";
const SUSPENDED_MESSAGE = "öğrenilen kural askıya alındı";

function safeName(v: unknown): string {
  return typeof v === "string" && NAME_RE.test(v) ? v : INVALID_NAME;
}

function safeOptionalName(v: unknown): string | undefined {
  return v === undefined ? undefined : safeName(v);
}

/** Identity of a turns.json note (one note per key). */
export function turnNoteKey(n: Pick<TurnNote, "kind" | "reason" | "service" | "tool" | "tier" | "routeSource" | "routeRule" | "tools" | "errorClass" | "ruleId">): string {
  switch (n.kind) {
    case "missing_capability":
      return JSON.stringify([n.kind, n.reason, n.service ?? "", n.tool]);
    case "wandering":
      return JSON.stringify([n.kind, n.tier, n.routeSource, n.routeRule ?? "", n.tools ?? []]);
    case "tool_error":
      return JSON.stringify([n.kind, n.service, n.tool, n.errorClass]);
    case "rule_suspended":
      return JSON.stringify([n.kind, n.ruleId, n.reason]);
  }
}

/**
 * Builds the stored key fields + message from an input, copying whitelisted
 * fields only. Returns undefined for an input that is not a known kind or has
 * an invalid enum value (a programming error; nothing is recorded).
 */
function normalizeTurnInput(input: TurnNoteInput): Omit<TurnNote, keyof CountedNote | "lastTurnId"> | undefined {
  switch (input.kind) {
    case "missing_capability": {
      if (!MISSING_REASONS.has(input.reason)) return undefined;
      const service = safeOptionalName(input.service);
      return {
        kind: input.kind,
        reason: input.reason,
        ...(service !== undefined ? { service } : {}),
        tool: safeName(input.tool),
        message: MISSING_MESSAGES[input.reason],
      };
    }
    case "wandering": {
      if (!WANDER_TRIGGERS.has(input.trigger) || ![0, 1, 2, 3].includes(input.tier)) return undefined;
      const tools = [...new Set((Array.isArray(input.tools) ? input.tools : []).map(safeName))].sort().slice(0, MAX_WANDER_TOOLS);
      const routeRule = safeOptionalName(input.routeRule);
      return {
        kind: input.kind,
        tier: input.tier,
        routeSource: safeName(input.routeSource),
        ...(routeRule !== undefined ? { routeRule } : {}),
        tools,
        trigger: input.trigger,
        message: WANDER_MESSAGE,
      };
    }
    case "tool_error": {
      if (!ERROR_CLASSES.has(input.errorClass)) return undefined;
      return {
        kind: input.kind,
        service: safeName(input.service),
        tool: safeName(input.tool),
        errorClass: input.errorClass,
        message: ERROR_MESSAGES[input.errorClass],
      };
    }
    case "rule_suspended": {
      if (typeof input.reason !== "string" || !REASON_RE.test(input.reason)) return undefined;
      return { kind: input.kind, ruleId: safeName(input.ruleId), reason: input.reason, message: SUSPENDED_MESSAGE };
    }
    default:
      return undefined;
  }
}

export interface TurnNotesOptions {
  /** `<SHADOW_DATA_DIR>/dev-notes`. */
  dir: string;
  now?: () => number;
  /** Default DEFAULT_COALESCE_MS; 0 writes on every record. */
  coalesceMs?: number;
  log?: (msg: string) => void;
}

export class TurnNotes {
  readonly file: string;
  private readonly now: () => number;
  private readonly store: CountedNotesFile<TurnNotesFile>;

  constructor(o: TurnNotesOptions) {
    this.now = o.now ?? Date.now;
    this.store = new CountedNotesFile({
      dir: o.dir,
      name: TURN_NOTES_FILE,
      label: "dev-notes (turns)",
      validate: validateTurnsFile,
      empty: () => ({ version: 1, notes: [] }),
      log: o.log,
      coalesceMs: o.coalesceMs ?? DEFAULT_COALESCE_MS,
    });
    this.file = this.store.file;
  }

  /**
   * Records one occurrence. Never throws; the promise settles once the
   * in-memory state is updated (the file follows within `coalesceMs` or on
   * `flush()`). An input with an unknown kind or enum value is ignored.
   */
  record(input: TurnNoteInput): Promise<void> {
    const fields = normalizeTurnInput(input);
    if (!fields) return Promise.resolve();
    const turnId = typeof input.turnId === "string" && TURN_ID_RE.test(input.turnId) ? input.turnId : undefined;
    return this.store.update((data) => {
      const r = observeNote<TurnNote>(data.notes, turnNoteKey, turnNoteKey(fields), this.now(), (stamp) => ({
        ...fields,
        count: 1,
        firstSeen: stamp,
        lastSeen: stamp,
      }));
      if (!r.created && fields.trigger !== undefined) r.note.trigger = fields.trigger;
      if (turnId !== undefined) r.note.lastTurnId = turnId;
      capNotes(data.notes, MAX_NOTES);
      return true;
    });
  }

  /** Sets the Development-tab status of the note with `key` (see turnNoteKey). Resolves false if there is none. */
  async setStatus(key: string, status: NoteStatus): Promise<boolean> {
    let found = false;
    await this.store.update((data) => {
      const r = setNoteStatus(data.notes, turnNoteKey, key, status, this.now());
      found = r.found;
      return r.changed;
    });
    return found;
  }

  /** Writes pending notes now (shutdown). Never rejects. */
  flush(): Promise<void> {
    return this.store.flush();
  }

  /** Current contents, including notes not yet written. */
  read(): Promise<TurnNotesFile> {
    return this.store.read();
  }
}

function validateTurnsFile(v: unknown): TurnNotesFile | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (o.version !== 1 || !Array.isArray(o.notes)) return undefined;
  // Notes of an unknown kind are dropped (they have no key); known ones are kept as they are.
  const notes = (o.notes as unknown[]).filter(
    (n): n is TurnNote => isCountedNote(n) && typeof (n as TurnNote).kind === "string" && TURN_KINDS.has((n as TurnNote).kind),
  );
  return { version: 1, notes };
}
