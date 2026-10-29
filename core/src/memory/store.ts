/**
 * Memory store (docs/06-memory.md §Storage, §Writes; task M1).
 *
 * Layout under `dir` (normally `<SHADOW_DATA_DIR>/memory`):
 *   brief.md, notes/<topic>.md   source of truth for entry texts
 *   index.json                   metadata + tombstones (rebuildable from the .md files)
 *   state.json                   extraction cursors (M4; read/written through here)
 *
 * Rules:
 *   - One store per Core process. Every operation (reads included) runs under
 *     one in-process async mutex (a promise chain), so read-modify-write
 *     sequences never interleave. `transaction()` holds it for several ops.
 *   - Files are read lazily and cached; each operation `stat`s them and re-reads
 *     a file whose mtime or size changed (a hand edit). Before writing, the
 *     stats are checked again; if a file changed meanwhile, the operation is
 *     re-applied by entry id on the fresh content (up to 3 attempts).
 *   - Writes are atomic (atomic-file.ts). A multi-file change writes the .md
 *     files first, then index.json; a crash in between is repaired on the next
 *     load, because the .md is the truth for the text. A written file is never
 *     given a stat taken after the write (a hand edit in between would be
 *     hidden): it is re-read on the next operation.
 *   - Tombstoning removals (forget, UI delete) first write forget-pending.json
 *     (entry ids and text hashes only). It is deleted after index.json is
 *     written; if it is still there (crash, failed write), the forget is
 *     completed before the next operation (retried until it succeeds), so a
 *     tombstone is never lost. Until then its entries are hidden from every
 *     read and its texts count as forgotten.
 *   - A bullet line without an id gets one (derived from its text, so it is
 *     stable until the line is written back with it on the next write).
 *     Non-bullet lines are kept verbatim; CRLF files stay CRLF, a BOM stays.
 *   - index.json missing or corrupt → rebuilt from the .md files (keywords from
 *     the text, provenance `manual`, tombstones lost) with a warning.
 *   - Every proposed text goes through the output filters (`rejectReason`,
 *     tombstones included) before it is stored. So does every entry line read
 *     from a file (tombstones: only new or changed lines): a rejected line
 *     stays in the file verbatim but is ignored (no id, not in the index, the
 *     brief or any list), with a warning log line (counts only). Keywords
 *     (given ones and those read from index.json) are filtered the same way.
 *   - Paths are built only from the fixed TOPICS whitelist; ids are validated.
 *   - Log lines never contain entry texts.
 */
import { randomBytes, createHash } from "node:crypto";
import { stat, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { readJsonOrQuarantine, writeFileAtomic, type AtomicFs, type QuarantineInfo } from "../atomic-file.js";
import { normalizeText, rejectReason, type FilterName } from "./filters.js";
import { deriveKeywords, foldedWords, normalizeKeyword, textHash } from "./match.js";
import {
  isEntryId,
  isMemoryKind,
  KIND_OF_TOPIC,
  MEMORY_BUDGETS,
  TOPIC_OF_KIND,
  TOPIC_TITLES,
  TOPICS,
  warningKey,
  type EntrySource,
  type IndexEntry,
  type MemoryEntry,
  type MemoryIndex,
  type MemoryKind,
  type MemoryLocation,
  type MemoryState,
  type MemoryWarning,
  type Tombstone,
  type Topic,
} from "./types.js";

export interface MemoryLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface MemoryStoreOptions {
  /** The memory folder (created on the first write). */
  dir: string;
  now?: () => number;
  logger?: MemoryLogger;
  /** Called after every successful write; `briefChanged` tells the registry to restart idle queries (M6). */
  onChange?: (change: { briefChanged: boolean }) => void;
  /** Injected into the atomic writer (tests simulate disk failures). */
  atomicFs?: AtomicFs;
  /** Rename retry delays for the atomic writer (tests use []). */
  retryDelaysMs?: readonly number[];
  /** Test seam: awaited after an op was applied and before its files are checked and written. */
  beforePersist?: () => Promise<void>;
}

export type WriteRejection =
  | FilterName
  | "invalid_text"
  | "invalid_kind"
  | "duplicate"
  | "memory_full"
  | "brief_full"
  | "note_full"
  | "not_found"
  | "write_failed";

export type WriteResult =
  | { ok: true; entry: MemoryEntry; briefChanged: boolean }
  | { ok: false; reason: WriteRejection };

export interface AddInput {
  kind: MemoryKind;
  text: string;
  keywords?: readonly string[];
  source?: EntrySource;
}

export interface UpdateInput {
  text?: string;
  keywords?: readonly string[];
  source?: EntrySource;
}

export interface RemoveResult {
  ok: boolean;
  /** Ids that were removed. */
  removed: string[];
  /** Ids that were not found (or invalid). */
  unknown: string[];
  /** Number of tombstones added (entries + extra texts). */
  tombstoned: number;
  briefChanged: boolean;
  /** Set when the write failed. */
  reason?: "write_failed";
  /**
   * With `reason`: the forget was recorded (forget-pending.json) before the
   * failure and is completed before the next store operation; some files may
   * already be written. Without it nothing changed.
   */
  pending?: boolean;
}

export interface ForgetInput {
  ids?: readonly string[];
  /** Forget every entry (brief and notes). */
  all?: boolean;
  /** Extra texts to tombstone (a fact that was never stored, "bunu unut"). */
  texts?: readonly string[];
}

export interface LocationView {
  chars: number;
  entries: MemoryEntry[];
}

export interface MemorySnapshot {
  brief: LocationView & { budget: number };
  topics: (LocationView & { topic: Topic; title: string; budget: number })[];
  warnings: MemoryWarning[];
  /** All entries, brief first, then topics in TOPICS order, file order inside. */
  count: number;
}

/** Operations available inside `transaction()` (no nested locking). */
export interface MemoryTx {
  entries(): Promise<MemoryEntry[]>;
  add(input: AddInput): Promise<WriteResult>;
  update(id: string, input: UpdateInput): Promise<WriteResult>;
  remove(ids: readonly string[], opts?: { tombstone?: boolean }): Promise<RemoveResult>;
  isForgotten(text: string): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Files

/** `raw` of an entry line: the line as read (kept verbatim if the line is rejected on import). */
type Line = { type: "other"; raw: string } | { type: "entry"; prefix: string; text: string; id: string; raw?: string };

interface FileStat {
  mtimeMs: number;
  size: number;
}

interface ParsedFile {
  lines: Line[];
  eol: "\n" | "\r\n";
  bom: boolean;
  /** Stat at read time; undefined = the file did not exist. */
  stat?: FileStat;
  dirty: boolean;
}

/**
 * Stat of a file this process has just written. Never equal to a real stat
 * (size -1), so the next load re-reads the file: a stat taken after the write
 * could belong to a hand edit made right after it.
 */
const WRITTEN_STAT: FileStat = { mtimeMs: -1, size: -1 };

/** forget-pending.json: a tombstoning removal that is not yet fully written. Ids and hashes only. */
interface PendingForget {
  version: 1;
  ids: string[];
  hashes: string[];
}

interface Model {
  files: Record<MemoryLocation, ParsedFile>;
  index: MemoryIndex;
  indexStat?: FileStat;
  indexDirty: boolean;
}

const LOCATIONS: readonly MemoryLocation[] = ["brief", ...TOPICS];

const BULLET_RE = /^(\s*[-*+]\s+)(.*)$/;
const TRAILING_ID_RE = /\s*\^(m-[0-9a-fA-F]{6})\s*$/;
/** An id marker inside a proposed text would be misread as the line's id. */
const ID_MARKER_RE = /\^m-[0-9a-f]{6}/i;

function parseFile(raw: string, fileStat: FileStat | undefined): ParsedFile {
  const bom = raw.charCodeAt(0) === 0xfeff;
  const body = bom ? raw.slice(1) : raw;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines: Line[] = body.split(/\r?\n/).map((rawLine): Line => {
    const m = BULLET_RE.exec(rawLine);
    if (!m) return { type: "other", raw: rawLine };
    let text = (m[2] ?? "").trim();
    let id = "";
    const idm = TRAILING_ID_RE.exec(text);
    if (idm) {
      id = (idm[1] ?? "").toLowerCase();
      text = text.slice(0, idm.index).trim();
    }
    if (text === "") return { type: "other", raw: rawLine };
    return { type: "entry", prefix: m[1] ?? "- ", text, id, raw: rawLine };
  });
  return { lines, eol, bom, stat: fileStat, dirty: false };
}

function serializeFile(f: ParsedFile): string {
  const body = f.lines.map((l) => (l.type === "other" ? l.raw : `${l.prefix}${l.text} ^${l.id}`)).join(f.eol);
  return (f.bom ? "﻿" : "") + body;
}

function emptyFile(): ParsedFile {
  return { lines: [], eol: "\n", bom: false, dirty: false };
}

function entryLines(f: ParsedFile): Extract<Line, { type: "entry" }>[] {
  return f.lines.filter((l): l is Extract<Line, { type: "entry" }> => l.type === "entry");
}

function charsOf(f: ParsedFile): number {
  return entryLines(f).reduce((n, l) => n + l.text.length, 0);
}

function insertEntry(f: ParsedFile, loc: MemoryLocation, line: Line): void {
  if (f.lines.length === 0 || f.lines.every((l) => l.type === "other" && l.raw.trim() === "")) {
    f.lines = [{ type: "other", raw: `# ${TOPIC_TITLES[loc]}` }, { type: "other", raw: "" }, line, { type: "other", raw: "" }];
    return;
  }
  let last = -1;
  f.lines.forEach((l, i) => {
    if (l.type === "entry") last = i;
  });
  if (last >= 0) {
    f.lines.splice(last + 1, 0, line);
    return;
  }
  let end = f.lines.length;
  while (end > 0) {
    const l = f.lines[end - 1];
    if (l?.type === "other" && l.raw.trim() === "") end--;
    else break;
  }
  f.lines.splice(end, 0, line);
  if (end === f.lines.length - 1) f.lines.push({ type: "other", raw: "" });
}

// ---------------------------------------------------------------------------
// Validation of JSON files

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const HASH_RE = /^sha256:[0-9a-f]{16}$/;

function validSource(v: unknown): EntrySource {
  if (!isObj(v) || (v.by !== "extract" && v.by !== "manual" && v.by !== "migrated")) return { by: "manual" };
  const s: EntrySource = { by: v.by };
  for (const k of ["device", "sessionId", "turnId"] as const) {
    const x = v[k];
    if (typeof x === "string" && x.length <= 200) s[k] = x;
  }
  return s;
}

/**
 * index.json validator: the top-level shape must be right (else quarantine and
 * rebuild); single bad entries or tombstones are dropped and re-derived by the
 * reconcile step.
 */
export function validateIndex(v: unknown): MemoryIndex | undefined {
  if (!isObj(v) || v.version !== 1 || !isObj(v.entries) || !Array.isArray(v.forgotten)) return undefined;
  const entries: Record<string, IndexEntry> = {};
  for (const [id, e] of Object.entries(v.entries)) {
    if (!isEntryId(id) || !isObj(e) || !isMemoryKind(e.kind) || typeof e.hash !== "string" || !HASH_RE.test(e.hash)) continue;
    if (!isNum(e.createdAt) || !isNum(e.updatedAt) || !Array.isArray(e.keywords)) continue;
    const keywords = e.keywords.filter((k): k is string => typeof k === "string" && k.length > 0 && k.length <= 40);
    entries[id] = {
      kind: e.kind,
      keywords: keywords.slice(0, MEMORY_BUDGETS.keywordsMax),
      hash: e.hash,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      source: validSource(e.source),
    };
  }
  const forgotten: Tombstone[] = v.forgotten
    .filter((t): t is { hash: string; at: number } => isObj(t) && typeof t.hash === "string" && HASH_RE.test(t.hash) && isNum(t.at))
    .map((t) => ({ hash: t.hash, at: t.at }))
    .slice(-MEMORY_BUDGETS.tombstonesMax);
  return { version: 1, entries, forgotten };
}

export function validatePending(v: unknown): PendingForget | undefined {
  if (!isObj(v) || v.version !== 1 || !Array.isArray(v.ids) || !Array.isArray(v.hashes)) return undefined;
  return {
    version: 1,
    ids: v.ids.filter(isEntryId),
    hashes: v.hashes.filter((h): h is string => typeof h === "string" && HASH_RE.test(h)),
  };
}

export function validateState(v: unknown): MemoryState | undefined {
  if (!isObj(v) || v.version !== 1 || !isObj(v.devices)) return undefined;
  if (typeof v.day !== "string" || !isNum(v.runsToday) || !isNum(v.usageLimitUntil)) return undefined;
  const devices: MemoryState["devices"] = {};
  for (const [name, d] of Object.entries(v.devices)) {
    if (!isObj(d) || !isNum(d.cursorTs) || !isNum(d.lastRunAt) || !isNum(d.modelTurnsSinceRun)) continue;
    devices[name] = {
      cursorTs: d.cursorTs,
      lastRunAt: d.lastRunAt,
      modelTurnsSinceRun: d.modelTurnsSinceRun,
      ...(isNum(d.failures) ? { failures: d.failures } : {}),
    };
  }
  return {
    version: 1,
    devices,
    day: v.day,
    runsToday: v.runsToday,
    usageLimitUntil: v.usageLimitUntil,
    ...(isNum(v.resetAt) ? { resetAt: v.resetAt } : {}),
    ...(isObj(v.pending) && typeof v.pending.device === "string" && isNum(v.pending.fromTs) && isNum(v.pending.toTs)
      ? { pending: { device: v.pending.device, fromTs: v.pending.fromTs, toTs: v.pending.toTs } }
      : {}),
  };
}

/** Filter normal form (invisible characters removed, NFKC), whitespace collapsed; undefined when the text cannot be an entry. */
export function normalizeEntryText(text: string): string | undefined {
  if (typeof text !== "string") return undefined;
  const t = normalizeText(text).replace(/\s+/g, " ").trim();
  if (t === "" || t.length > MEMORY_BUDGETS.textMaxChars || ID_MARKER_RE.test(t)) return undefined;
  return t;
}

const keywordVerdicts = new Map<string, boolean>();

/** True when a keyword passes the output filters, raw and folded (memoized: index loads re-check every keyword). */
function safeKeyword(k: string): boolean {
  const hit = keywordVerdicts.get(k);
  if (hit !== undefined) return hit;
  const ok = rejectReason(k) === undefined && rejectReason(normalizeKeyword(k) ?? "") === undefined;
  if (keywordVerdicts.size > 5000) keywordVerdicts.clear();
  keywordVerdicts.set(k, ok);
  return ok;
}

function safeKeywords(given: readonly string[] | undefined): string[] | undefined {
  return given?.filter((k) => typeof k === "string" && safeKeyword(k));
}

function errCode(err: unknown): string | undefined {
  return isObj(err) && typeof err.code === "string" ? err.code : undefined;
}

class StaleFileError extends Error {}

const NO_HASHES: ReadonlySet<string> = new Set();

// ---------------------------------------------------------------------------
// Store

export class MemoryStore {
  readonly dir: string;
  private readonly now: () => number;
  private readonly logger?: MemoryLogger;
  private chain: Promise<unknown> = Promise.resolve();
  private cache: Model | undefined;
  private loggedWarnings = new Set<string>();
  /** False until forget-pending.json was checked (startup) and again after a forget left it behind. */
  private recovered = false;
  /**
   * Ids and hashes of a forget that is recorded but not yet fully written
   * (forget-pending.json). While set, matching lines are hidden from every
   * read and their texts count as forgotten, so a forgotten text never
   * surfaces while the forget is retried.
   */
  private pendingMask: { ids: Set<string>; hashes: Set<string> } | undefined;

  constructor(private readonly opts: MemoryStoreOptions) {
    this.dir = opts.dir;
    this.now = opts.now ?? Date.now;
    this.logger = opts.logger;
  }

  // ------------------------------------------------------------- public API

  /** All entries: brief first, then topics in TOPICS order, file order inside. */
  entries(): Promise<MemoryEntry[]> {
    return this.lock(async () => this.allEntries(await this.load()));
  }

  /** Topic entries only (the matcher's input; the brief is in the system prompt). */
  async noteEntries(): Promise<MemoryEntry[]> {
    return (await this.entries()).filter((e) => e.location !== "brief");
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    if (!isEntryId(id)) return undefined;
    return (await this.entries()).find((e) => e.id === id);
  }

  /** Brief, topics with char counts, and the current warnings (UI `memory` frame, `memory_list`). */
  snapshot(): Promise<MemorySnapshot> {
    return this.lock(async () => {
      const m = await this.load();
      const view = (loc: MemoryLocation): LocationView => ({
        chars: this.visibleLines(m, loc).reduce((n, l) => n + l.text.length, 0),
        entries: this.entriesOf(m, loc),
      });
      return {
        brief: { ...view("brief"), budget: MEMORY_BUDGETS.briefWarnChars },
        topics: TOPICS.map((topic) => ({ topic, title: TOPIC_TITLES[topic], budget: MEMORY_BUDGETS.noteWarnChars, ...view(topic) })),
        warnings: this.warningsOf(m),
        count: this.allEntries(m).length,
      };
    });
  }

  /**
   * The brief for the system prompt: `- text` lines, whole entries in file
   * order while the summed text stays within the hard limit (1200 chars).
   * Empty string when there is no brief.
   */
  briefForPrompt(): Promise<string> {
    return this.lock(async () => {
      const m = await this.load();
      const out: string[] = [];
      let chars = 0;
      for (const l of this.visibleLines(m, "brief")) {
        if (chars + l.text.length > MEMORY_BUDGETS.briefMaxChars) break;
        out.push(`- ${l.text}`);
        chars += l.text.length;
      }
      return out.join("\n");
    });
  }

  add(input: AddInput): Promise<WriteResult> {
    return this.lock(() => this.addUnlocked(input));
  }

  update(id: string, input: UpdateInput): Promise<WriteResult> {
    return this.lock(() => this.updateUnlocked(id, input));
  }

  /**
   * Removes entries. With `tombstone: true` (forget tool, UI delete) their
   * hashes are tombstoned so the extractor never learns them again; without
   * (extractor `delete`: the user corrected a fact) they are not.
   */
  remove(ids: readonly string[], opts: { tombstone?: boolean } = {}): Promise<RemoveResult> {
    return this.lock(() => this.removeUnlocked(ids, opts.tombstone ?? false, []));
  }

  /** `memory_forget`: removes the given (or all) entries with tombstones, and tombstones extra texts. */
  forget(input: ForgetInput): Promise<RemoveResult> {
    return this.lock(() => this.removeUnlocked(input.all ? "all" : (input.ids ?? []), true, input.texts ?? []));
  }

  isForgotten(text: string): Promise<boolean> {
    return this.lock(async () => this.blockedSet(await this.load()).has(textHash(text)));
  }

  /** Runs `fn` with the mutex held for all its operations (one extraction pass). Do not call store methods inside. */
  transaction<T>(fn: (tx: MemoryTx) => Promise<T>): Promise<T> {
    return this.lock(() =>
      fn({
        entries: async () => this.allEntries(await this.load()),
        add: (input) => this.addUnlocked(input),
        update: (id, input) => this.updateUnlocked(id, input),
        remove: (ids, o) => this.removeUnlocked(ids, o?.tombstone ?? false, []),
        isForgotten: async (text) => this.blockedSet(await this.load()).has(textHash(text)),
      }),
    );
  }

  /** state.json, or undefined when missing or corrupt (corrupt → quarantined, warning logged). */
  readState(): Promise<MemoryState | undefined> {
    return this.lock(() =>
      readJsonOrQuarantine(join(this.dir, "state.json"), validateState, {
        onQuarantine: (info) => this.quarantined("state.json", info),
      }),
    );
  }

  writeState(state: MemoryState): Promise<void> {
    return this.lock(() => this.write(join(this.dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`));
  }

  // -------------------------------------------------------------- internals

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const task = async () => {
      await this.recoverOnce();
      return fn();
    };
    const run = this.chain.then(task, task);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private pathOf(loc: MemoryLocation): string {
    // Only whitelisted names ever reach the file system.
    if (loc === "brief") return join(this.dir, "brief.md");
    if (!(TOPICS as readonly string[]).includes(loc)) throw new Error("unknown memory topic");
    return join(this.dir, "notes", `${loc}.md`);
  }

  private get indexPath(): string {
    return join(this.dir, "index.json");
  }

  private get pendingPath(): string {
    return join(this.dir, "forget-pending.json");
  }

  private readPending(): Promise<PendingForget | undefined> {
    return readJsonOrQuarantine(this.pendingPath, validatePending, {
      onQuarantine: (info) => this.quarantined("forget-pending.json", info),
    });
  }

  /** Completes a forget left in forget-pending.json (startup, or after a failed forget). Never throws. */
  private async recoverOnce(): Promise<void> {
    if (this.recovered) return;
    this.recovered = true;
    try {
      const pending = await this.readPending();
      if (!pending) {
        this.pendingMask = undefined;
        return;
      }
      this.setPendingMask(pending);
      // removeUnlocked reports a failed write as { ok: false } (it does not throw): retry before the next operation.
      const r = await this.removeUnlocked([], true, [], pending);
      if (r.ok) this.logger?.info("[shadow-core] memory: completed a pending forget");
      else {
        this.recovered = false;
        this.logger?.warn(`[shadow-core] memory: pending forget not completed (${r.reason ?? "error"})`);
      }
    } catch (err) {
      this.recovered = false;
      this.logger?.warn(`[shadow-core] memory: pending forget not completed (${errCode(err) ?? (err instanceof Error ? err.name : "error")})`);
    }
  }

  private setPendingMask(p: PendingForget | undefined): void {
    this.pendingMask = p ? { ids: new Set(p.ids), hashes: new Set(p.hashes) } : undefined;
  }

  /** Entry lines minus those of an incomplete forget (pendingMask). */
  private visibleLines(m: Model, loc: MemoryLocation): Extract<Line, { type: "entry" }>[] {
    const mask = this.pendingMask;
    const lines = entryLines(m.files[loc]);
    return mask ? lines.filter((l) => !mask.ids.has(l.id) && !mask.hashes.has(textHash(l.text))) : lines;
  }

  private async clearPending(): Promise<void> {
    try {
      await (this.opts.atomicFs ?? { unlink }).unlink(this.pendingPath);
    } catch (err) {
      if (errCode(err) === "ENOENT") return;
      // Re-applying the forget later is harmless (idempotent).
      this.recovered = false;
      this.logger?.warn(`[shadow-core] memory: forget-pending.json not removed (${errCode(err) ?? "error"})`);
    }
  }

  private async statOf(path: string): Promise<FileStat | undefined> {
    try {
      const s = await stat(path);
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch (err) {
      if (errCode(err) === "ENOENT") return undefined;
      throw err;
    }
  }

  private async write(path: string, data: string): Promise<void> {
    await writeFileAtomic(path, data, {
      ...(this.opts.atomicFs ? { fs: this.opts.atomicFs } : {}),
      ...(this.opts.retryDelaysMs ? { retryDelaysMs: this.opts.retryDelaysMs } : {}),
    });
  }

  private quarantined(file: string, info: QuarantineInfo): void {
    this.logger?.warn(
      `[shadow-core] memory: ${file} ${info.reason}, ${info.movedTo ? "quarantined" : `quarantine failed (${info.renameError ?? "error"})`}`,
    );
  }

  /** Loads (or refreshes) the cached model; re-reads every file whose stat changed. */
  private async load(): Promise<Model> {
    const prev = this.cache;
    let changed = !prev;
    const files = {} as Record<MemoryLocation, ParsedFile>;
    for (const loc of LOCATIONS) {
      const path = this.pathOf(loc);
      const st = await this.statOf(path);
      const cached = prev?.files[loc];
      if (cached && sameStat(cached.stat, st)) {
        files[loc] = cached;
        continue;
      }
      changed = true;
      if (!st) {
        files[loc] = emptyFile();
        continue;
      }
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (err) {
        if (errCode(err) !== "ENOENT") throw err;
        files[loc] = emptyFile();
        continue;
      }
      files[loc] = parseFile(raw, st);
    }
    const indexStat = await this.statOf(this.indexPath);
    let index = prev?.index;
    let indexDirty = prev?.indexDirty ?? false;
    let rebuilt: "missing" | "corrupt" | undefined;
    if (!prev || !sameStat(prev.indexStat, indexStat)) {
      changed = true;
      let corrupt = false;
      index = await readJsonOrQuarantine(this.indexPath, validateIndex, {
        onQuarantine: (info) => {
          corrupt = true;
          this.quarantined("index.json", info);
        },
      });
      if (!index) {
        rebuilt = corrupt ? "corrupt" : "missing";
        index = { version: 1, entries: {}, forgotten: [] };
        indexDirty = true;
      }
      // A keyword that fails the filters (hand edit, older version) is dropped; reconcile re-derives empty lists.
      for (const e of Object.values(index.entries)) {
        const kw = e.keywords.filter(safeKeyword);
        if (kw.length !== e.keywords.length) {
          e.keywords = kw;
          indexDirty = true;
        }
      }
    }
    if (!changed && prev) return prev;
    const model: Model = { files, index: index as MemoryIndex, indexStat, indexDirty };
    const hadEntries = this.reconcile(model);
    if (rebuilt && hadEntries) this.logger?.warn(`[shadow-core] memory: index.json ${rebuilt}, rebuilt from the .md files`);
    this.cache = model;
    this.logWarnings(model);
    return model;
  }

  /**
   * Makes the index agree with the .md files: ids for lines without one (or
   * with a duplicate), index entries for new lines (`manual`), re-derived
   * metadata for hand-edited texts, removal of entries whose line is gone.
   * Every entry line must pass the same checks as a proposed text (normal
   * form, length, output filters; tombstones for new or changed lines only:
   * the folded hash ignores punctuation, so an equal hash is no proof the
   * line was vetted in this form); a rejected line becomes
   * an ignored line (kept verbatim in the file, never in the index, brief or
   * lists) and is counted in one warning log line. Returns whether any entry exists.
   */
  private reconcile(m: Model): boolean {
    const seen = new Set<string>();
    const now = this.now();
    const forgotten = this.forgottenSet(m);
    const rejected = new Map<WriteRejection, number>();
    for (const loc of LOCATIONS) {
      const f = m.files[loc];
      for (const [i, l] of f.lines.entries()) {
        if (l.type !== "entry") continue;
        const fresh = !l.id || seen.has(l.id);
        const known = fresh ? undefined : m.index.entries[l.id];
        // Every line is vetted (normal form, length, output filters): the folded hash ignores
        // punctuation and case, so an unchanged hash does not mean the text passed the checks.
        // Tombstones apply only to new or changed lines (an indexed text is not dropped by a later tombstone).
        const t = this.vet(l.text, !known || known.hash !== textHash(l.text) ? forgotten : NO_HASHES);
        if (typeof t !== "string") {
          rejected.set(t.reject, (rejected.get(t.reject) ?? 0) + 1);
          f.lines[i] = { type: "other", raw: l.raw ?? `${l.prefix}${l.text}` };
          continue;
        }
        if (t !== l.text) {
          l.text = t;
          f.dirty = true;
        }
        if (fresh) {
          l.id = this.newId(m, seen, l.text);
          f.dirty = true;
        }
        seen.add(l.id);
        const hash = textHash(l.text);
        const kindHere = (k: MemoryKind | undefined): MemoryKind => {
          if (loc === "brief") return "identity";
          if (k === "identity" && loc === "kisiler") return k;
          if (k && k !== "identity" && TOPIC_OF_KIND[k] === loc) return k;
          return KIND_OF_TOPIC[loc];
        };
        const e = m.index.entries[l.id];
        if (!e) {
          m.index.entries[l.id] = {
            kind: kindHere(undefined),
            keywords: deriveKeywords(l.text),
            hash,
            createdAt: now,
            updatedAt: now,
            source: { by: "manual" },
          };
          m.indexDirty = true;
          continue;
        }
        if (e.hash !== hash) {
          e.hash = hash;
          e.keywords = deriveKeywords(l.text);
          e.updatedAt = now;
          e.source = { by: "manual" };
          m.indexDirty = true;
        }
        if (e.keywords.length === 0) {
          e.keywords = deriveKeywords(l.text);
          m.indexDirty = true;
        }
        const k = kindHere(e.kind);
        if (k !== e.kind) {
          e.kind = k;
          m.indexDirty = true;
        }
      }
    }
    for (const id of Object.keys(m.index.entries)) {
      if (!seen.has(id)) {
        delete m.index.entries[id];
        m.indexDirty = true;
      }
    }
    if (rejected.size > 0) {
      const counts = [...rejected].map(([k, n]) => `${k}: ${n}`).join(", ");
      this.logger?.warn(`[shadow-core] memory: ignored file lines that fail the memory checks (${counts})`);
    }
    return seen.size > 0;
  }

  /**
   * Id for a line without one: derived from the text (stable across reloads),
   * random on collision. The derived id is not a collision when its index
   * entry holds this same text: that is the line itself, from an earlier load.
   */
  private newId(m: Model, seen: ReadonlySet<string>, text: string | undefined): string {
    const onLine = (id: string) => LOCATIONS.some((loc) => entryLines(m.files[loc]).some((l) => l.id === id));
    if (text !== undefined) {
      const id = `m-${createHash("sha256").update(text, "utf8").digest("hex").slice(0, 6)}`;
      const e = m.index.entries[id];
      if (!seen.has(id) && !onLine(id) && (!e || e.hash === textHash(text))) return id;
    }
    for (;;) {
      const id = `m-${randomBytes(3).toString("hex")}`;
      if (!seen.has(id) && m.index.entries[id] === undefined && !onLine(id)) return id;
    }
  }

  private entriesOf(m: Model, loc: MemoryLocation): MemoryEntry[] {
    return this.visibleLines(m, loc).map((l) => {
      const e = m.index.entries[l.id] as IndexEntry;
      return {
        id: l.id,
        kind: e.kind,
        location: loc,
        text: l.text,
        keywords: [...e.keywords],
        hash: e.hash,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        source: { ...e.source },
      };
    });
  }

  private allEntries(m: Model): MemoryEntry[] {
    return LOCATIONS.flatMap((loc) => this.entriesOf(m, loc));
  }

  private find(m: Model, id: string): { loc: MemoryLocation; line: Extract<Line, { type: "entry" }> } | undefined {
    if (!isEntryId(id)) return undefined;
    for (const loc of LOCATIONS) {
      const line = this.visibleLines(m, loc).find((l) => l.id === id);
      if (line) return { loc, line };
    }
    return undefined;
  }

  private forgottenSet(m: Model): Set<string> {
    return new Set(m.index.forgotten.map((t) => t.hash));
  }

  /** Tombstones plus the hashes of an incomplete forget (for proposed texts and isForgotten, not for reconcile). */
  private blockedSet(m: Model): Set<string> {
    const set = this.forgottenSet(m);
    for (const h of this.pendingMask?.hashes ?? []) set.add(h);
    return set;
  }

  private warningsOf(m: Model): MemoryWarning[] {
    const out: MemoryWarning[] = [];
    const brief = charsOf(m.files.brief);
    if (brief > MEMORY_BUDGETS.briefMaxChars) out.push({ code: "brief_truncated" });
    else if (brief > MEMORY_BUDGETS.briefWarnChars) out.push({ code: "brief_over_budget" });
    for (const topic of TOPICS) {
      const chars = charsOf(m.files[topic]);
      if (chars >= MEMORY_BUDGETS.noteMaxChars) out.push({ code: "note_full", topic });
      else if (chars > MEMORY_BUDGETS.noteWarnChars) out.push({ code: "note_over_budget", topic });
    }
    const count = Object.keys(m.index.entries).length;
    if (count >= MEMORY_BUDGETS.entriesMax) out.push({ code: "memory_full" });
    else if (count > MEMORY_BUDGETS.entriesWarn) out.push({ code: "memory_over_budget" });
    return out;
  }

  /** One log line when a warning appears or disappears. */
  private logWarnings(m: Model): void {
    const keys = new Set(this.warningsOf(m).map(warningKey));
    for (const k of keys) if (!this.loggedWarnings.has(k)) this.logger?.warn(`[shadow-core] memory: warning ${k}`);
    for (const k of this.loggedWarnings) if (!keys.has(k)) this.logger?.info(`[shadow-core] memory: warning cleared ${k}`);
    this.loggedWarnings = keys;
  }

  /**
   * Applies `op` to a copy of the current model and persists the dirty files
   * (.md first, then index.json). If a file changed on disk since it was read,
   * the model is reloaded and `op` re-applied (by id), up to 3 attempts. The
   * cache is replaced only after a successful write; on a write error it is
   * dropped so the next operation re-reads the disk.
   */
  private async mutate<R>(
    op: (m: Model) => R | { reject: WriteRejection },
    intent?: () => PendingForget | undefined,
  ): Promise<{ result: R } | { reject: WriteRejection; intentWritten?: boolean }> {
    // Sticky across attempts: a forget-pending.json written by an earlier attempt stays on disk.
    const written = { intent: false };
    for (let attempt = 0; ; attempt++) {
      const base = await this.load();
      const m = structuredClone(base);
      const r = op(m);
      if (isReject(r)) return r;
      try {
        await this.persist(m, intent?.(), written);
      } catch (err) {
        this.cache = undefined;
        if (err instanceof StaleFileError && attempt < 2) continue;
        this.logger?.warn(`[shadow-core] memory: write failed (${errCode(err) ?? (err instanceof Error ? err.name : "error")})`);
        return { reject: "write_failed", intentWritten: written.intent };
      }
      this.cache = m;
      this.logWarnings(m);
      return { result: r };
    }
  }

  private async persist(m: Model, intent: PendingForget | undefined, written: { intent: boolean }): Promise<void> {
    await this.opts.beforePersist?.();
    const dirty = LOCATIONS.filter((loc) => m.files[loc].dirty);
    // Optimistic check: nothing we are about to overwrite changed since it was read.
    for (const loc of dirty) {
      if (!sameStat(m.files[loc].stat, await this.statOf(this.pathOf(loc)))) throw new StaleFileError(loc);
    }
    if (m.indexDirty && !sameStat(m.indexStat, await this.statOf(this.indexPath))) throw new StaleFileError("index");
    if (intent) {
      await this.write(this.pendingPath, `${JSON.stringify(intent)}\n`);
      written.intent = true;
    }
    for (const loc of dirty) {
      const f = m.files[loc];
      await this.write(this.pathOf(loc), serializeFile(f));
      f.stat = WRITTEN_STAT;
      f.dirty = false;
    }
    if (m.indexDirty) {
      await this.write(this.indexPath, `${JSON.stringify(m.index, null, 2)}\n`);
      m.indexStat = WRITTEN_STAT;
      m.indexDirty = false;
    }
    if (intent) await this.clearPending();
  }

  /** Normal form + output filters (tombstones included): the normalized text or the rejection. */
  private vet(text: string, forgotten: ReadonlySet<string>): string | { reject: WriteRejection } {
    const t = normalizeEntryText(text);
    if (t === undefined) return { reject: "invalid_text" };
    const reason = rejectReason(t, { isForgotten: (x) => forgotten.has(textHash(x)) });
    return reason ? { reject: reason } : t;
  }

  private checkText(m: Model, text: string, selfId?: string): string | { reject: WriteRejection } {
    const t = this.vet(text, this.blockedSet(m));
    if (typeof t !== "string") return t;
    const hash = textHash(t);
    if (Object.entries(m.index.entries).some(([id, e]) => id !== selfId && e.hash === hash)) return { reject: "duplicate" };
    return t;
  }

  private async addUnlocked(input: AddInput): Promise<WriteResult> {
    if (!isMemoryKind(input.kind)) return { ok: false, reason: "invalid_kind" };
    const r = await this.mutate((m) => {
      const t = this.checkText(m, input.text);
      if (typeof t !== "string") return t;
      if (Object.keys(m.index.entries).length >= MEMORY_BUDGETS.entriesMax) return { reject: "memory_full" as const };
      let loc: MemoryLocation;
      if (input.kind === "identity") {
        const brief = charsOf(m.files.brief);
        loc = brief < MEMORY_BUDGETS.briefWarnChars && brief + t.length <= MEMORY_BUDGETS.briefMaxChars ? "brief" : "kisiler";
      } else loc = TOPIC_OF_KIND[input.kind];
      if (loc !== "brief" && charsOf(m.files[loc]) + t.length > MEMORY_BUDGETS.noteMaxChars) return { reject: "note_full" as const };
      const id = this.newId(m, new Set(), undefined);
      const now = this.now();
      m.index.entries[id] = {
        kind: input.kind,
        keywords: deriveKeywords(t, safeKeywords(input.keywords) ?? []),
        hash: textHash(t),
        createdAt: now,
        updatedAt: now,
        source: validSource(input.source ?? { by: "extract" }),
      };
      m.indexDirty = true;
      const f = m.files[loc];
      insertEntry(f, loc, { type: "entry", prefix: "- ", text: t, id });
      f.dirty = true;
      return { id, loc };
    });
    if ("reject" in r) return { ok: false, reason: r.reject };
    return this.written(r.result.id, r.result.loc === "brief");
  }

  private async updateUnlocked(id: string, input: UpdateInput): Promise<WriteResult> {
    const r = await this.mutate((m) => {
      const found = this.find(m, id);
      if (!found) return { reject: "not_found" as const };
      const e = m.index.entries[id] as IndexEntry;
      let text = found.line.text;
      if (input.text !== undefined) {
        const t = this.checkText(m, input.text, id);
        if (typeof t !== "string") return t;
        text = t;
      }
      const textChanged = text !== found.line.text;
      if (textChanged) {
        // The file total may not grow past its hard limit (a file already over it by hand may still shrink).
        const before = charsOf(m.files[found.loc]);
        const after = before - found.line.text.length + text.length;
        const max = found.loc === "brief" ? MEMORY_BUDGETS.briefMaxChars : MEMORY_BUDGETS.noteMaxChars;
        if (after > max && after > before) return { reject: found.loc === "brief" ? ("brief_full" as const) : ("note_full" as const) };
      }
      found.line.text = text;
      e.hash = textHash(text);
      e.keywords = deriveKeywords(text, safeKeywords(input.keywords) ?? (textChanged ? [] : e.keywords));
      e.updatedAt = this.now();
      if (input.source) e.source = validSource(input.source);
      m.indexDirty = true;
      if (textChanged) m.files[found.loc].dirty = true;
      return { loc: found.loc };
    });
    if ("reject" in r) return { ok: false, reason: r.reject };
    return this.written(id, r.result.loc === "brief");
  }

  /**
   * Removes `which`; with `tombstone`, their hashes and those of `texts` are
   * tombstoned. A tombstoning removal records its ids and hashes in
   * forget-pending.json before it writes (module comment) and also completes
   * an earlier pending forget (`pending`, read from the file when not given).
   */
  private async removeUnlocked(
    which: readonly string[] | "all",
    tombstone: boolean,
    texts: readonly string[],
    pending?: PendingForget,
  ): Promise<RemoveResult> {
    if (tombstone) pending ??= await this.readPending();
    const removed: string[] = [];
    const unknown: string[] = [];
    let tombstoned = 0;
    let briefChanged = false;
    let changed = false;
    let intent: PendingForget | undefined;
    const r = await this.mutate(
      (m) => {
        removed.length = unknown.length = tombstoned = 0;
        briefChanged = changed = false;
        const hashes: string[] = [];
        const drop = (loc: MemoryLocation, gone: (l: Extract<Line, { type: "entry" }>) => boolean) => {
          const f = m.files[loc];
          f.lines = f.lines.filter((l) => {
            if (l.type !== "entry" || !gone(l)) return true;
            const e = m.index.entries[l.id];
            if (e) hashes.push(e.hash);
            delete m.index.entries[l.id];
            m.indexDirty = f.dirty = changed = true;
            if (loc === "brief") briefChanged = true;
            return false;
          });
        };
        const ids = which === "all" ? this.allEntries(m).map((e) => e.id) : which;
        for (const id of new Set(ids)) {
          const found = this.find(m, id);
          if (!found) {
            unknown.push(id);
            continue;
          }
          drop(found.loc, (l) => l === found.line);
          removed.push(id);
        }
        if (pending) {
          // An earlier forget that did not finish: its entries go (by id or text hash), its hashes are tombstoned.
          const pIds = new Set(pending.ids);
          const pHashes = new Set(pending.hashes);
          for (const loc of LOCATIONS) drop(loc, (l) => pIds.has(l.id) || pHashes.has(textHash(l.text)));
          hashes.push(...pending.hashes);
        }
        if (tombstone) {
          for (const t of texts) if (foldedWords(t).length > 0) hashes.push(textHash(t));
          const at = this.now();
          const byHash = new Map(m.index.forgotten.map((x) => [x.hash, x]));
          for (const h of new Set(hashes)) {
            byHash.delete(h);
            byHash.set(h, { hash: h, at });
            tombstoned++;
          }
          if (tombstoned > 0) {
            m.index.forgotten = [...byHash.values()].slice(-MEMORY_BUDGETS.tombstonesMax);
            m.indexDirty = changed = true;
          }
        }
        intent =
          tombstone && (tombstoned > 0 || pending)
            ? { version: 1, ids: [...new Set([...removed, ...(pending?.ids ?? [])])], hashes: [...new Set(hashes)] }
            : undefined;
        return true;
      },
      () => intent,
    );
    if ("reject" in r) {
      // A recorded forget is completed before the next operation.
      if (r.intentWritten) {
        this.recovered = false;
        if (intent) this.setPendingMask(intent);
      }
      return {
        ok: false,
        removed: [],
        unknown: which === "all" ? [] : [...which],
        tombstoned: 0,
        briefChanged: false,
        reason: "write_failed",
        ...(r.intentWritten ? { pending: true } : {}),
      };
    }
    // A successful tombstoning removal also completed any earlier pending forget.
    if (tombstone) this.pendingMask = undefined;
    if (changed) this.notify(briefChanged);
    return { ok: true, removed, unknown, tombstoned, briefChanged };
  }

  private written(id: string, briefChanged: boolean): WriteResult {
    const m = this.cache as Model;
    const loc = this.find(m, id)?.loc as MemoryLocation;
    const entry = this.entriesOf(m, loc).find((e) => e.id === id) as MemoryEntry;
    this.notify(briefChanged);
    return { ok: true, entry, briefChanged };
  }

  private notify(briefChanged: boolean): void {
    try {
      this.opts.onChange?.({ briefChanged });
    } catch (err) {
      this.logger?.warn(`[shadow-core] memory: change listener failed (${err instanceof Error ? err.name : "error"})`);
    }
  }
}

function sameStat(a: FileStat | undefined, b: FileStat | undefined): boolean {
  if (!a || !b) return a === b;
  return a.mtimeMs === b.mtimeMs && a.size === b.size;
}

function isReject(v: unknown): v is { reject: WriteRejection } {
  return isObj(v) && typeof v.reject === "string";
}
