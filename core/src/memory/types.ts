/**
 * Assistant memory: shared types, fixed topics and budgets (docs/06-memory.md,
 * task M1). Pure module: no I/O.
 */

/**
 * Entry kinds. `identity` lives in the brief while it has room, else in `kisiler`.
 * `lesson` (T5): a behaviour lesson that only makes the assistant more careful
 * ("X'i kapatmadan önce onay iste"); its texts pass the stricter lesson filter
 * (filters.ts) and are loaded into the system prompt under a heading that says
 * they grant nothing. The permission gate never reads memory.
 */
export type MemoryKind = "alias" | "preference" | "person" | "routine" | "fact" | "identity" | "lesson";
export const MEMORY_KINDS: readonly MemoryKind[] = ["alias", "preference", "person", "routine", "fact", "identity", "lesson"];

/**
 * The fixed topic notes. This list is a whitelist: file names are only
 * ever built from it (`notes/<topic>.md`), never from caller input.
 */
export type Topic = "ev" | "tercihler" | "kisiler" | "rutinler" | "genel" | "dersler";
export const TOPICS: readonly Topic[] = ["ev", "tercihler", "kisiler", "rutinler", "genel", "dersler"];

/** The topic of `lesson` entries: in the system prompt, not in the per-turn `<hafiza>` match. */
export const LESSON_TOPIC = "dersler" satisfies Topic;

/** Where an entry is stored: the always-loaded brief or one topic note. */
export type MemoryLocation = "brief" | Topic;

export const TOPIC_OF_KIND: Readonly<Record<Exclude<MemoryKind, "identity">, Topic>> = {
  alias: "ev",
  preference: "tercihler",
  person: "kisiler",
  routine: "rutinler",
  fact: "genel",
  lesson: "dersler",
};

/** Kind of an entry found in a topic file without index metadata. */
export const KIND_OF_TOPIC: Readonly<Record<Topic, MemoryKind>> = {
  ev: "alias",
  tercihler: "preference",
  kisiler: "person",
  rutinler: "routine",
  genel: "fact",
  dersler: "lesson",
};

/** Heading written into a new file. */
export const TOPIC_TITLES: Readonly<Record<MemoryLocation, string>> = {
  brief: "Kullanıcı hakkında",
  ev: "Ev ve cihaz adları",
  tercihler: "Tercihler",
  kisiler: "Kişiler",
  rutinler: "Rutinler",
  genel: "Genel",
  dersler: "Dersler",
};

export function isTopic(value: unknown): value is Topic {
  return typeof value === "string" && (TOPICS as readonly string[]).includes(value);
}

export function isMemoryKind(value: unknown): value is MemoryKind {
  return typeof value === "string" && (MEMORY_KINDS as readonly string[]).includes(value);
}

/** Entry id: `m-` + 6 lower-case hex digits (Obsidian block-id syntax `^m-…` in the file). */
export const ENTRY_ID_RE = /^m-[0-9a-f]{6}$/;

export function isEntryId(value: unknown): value is string {
  return typeof value === "string" && ENTRY_ID_RE.test(value);
}

export const MEMORY_BUDGETS = {
  /** Brief: summed entry text length. */
  briefWarnChars: 800,
  briefMaxChars: 1200,
  /** One topic note: summed entry text length. */
  noteWarnChars: 2000,
  noteMaxChars: 4000,
  /** All entries (brief + notes). */
  entriesWarn: 150,
  entriesMax: 200,
  /** Per-turn `<hafiza>` block. */
  turnMaxChars: 1200,
  turnMaxEntries: 8,
  /** Lessons in the system prompt: summed entry text length (whole entries, file order). */
  lessonsPromptMaxChars: 800,
  /** One entry text. */
  textMaxChars: 160,
  keywordsMax: 6,
  /** Tombstones kept in index.json (oldest dropped). */
  tombstonesMax: 500,
} as const;

/** `tool`: written by the model's `memory_note` tool ("not al", T5.2). */
export type EntrySourceBy = "extract" | "manual" | "migrated" | "tool";

export interface EntrySource {
  by: EntrySourceBy;
  device?: string;
  sessionId?: string;
  turnId?: string;
}

/** One entry as returned by the store. */
export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  location: MemoryLocation;
  text: string;
  /** Folded keywords (1-6). */
  keywords: string[];
  /** `sha256:<16 hex>` of the folded, punctuation-free text. */
  hash: string;
  createdAt: number;
  updatedAt: number;
  source: EntrySource;
}

/** index.json entry metadata (text lives in the `.md` files). */
export interface IndexEntry {
  kind: MemoryKind;
  keywords: string[];
  hash: string;
  createdAt: number;
  updatedAt: number;
  source: EntrySource;
}

export interface Tombstone {
  hash: string;
  at: number;
}

export interface MemoryIndex {
  version: 1;
  entries: Record<string, IndexEntry>;
  forgotten: Tombstone[];
}

/** state.json: extraction cursors and counters (owned by the extractor, M4; stored here). */
export interface DeviceExtractionState {
  cursorTs: number;
  lastRunAt: number;
  modelTurnsSinceRun: number;
  /** Failed passes in a row (the cursor moves on after two). */
  failures?: number;
}

export interface MemoryState {
  version: 1;
  devices: Record<string, DeviceExtractionState>;
  /** Local date `YYYY-MM-DD` that `runsToday` counts. */
  day: string;
  runsToday: number;
  usageLimitUntil: number;
  /** Set when state.json was found missing or corrupt: devices without a cursor start no earlier than this. */
  resetAt?: number;
  /**
   * Written just before a pass applies ops, cleared with the cursor move after
   * it: still set on load means the pass crashed in between, so the range
   * `(fromTs, toTs]` of `device` counts as applied (no second model call).
   */
  pending?: PendingExtraction;
}

export interface PendingExtraction {
  device: string;
  /** The device's cursor when the pass read its turns. */
  fromTs: number;
  /** Newest log entry the pass read (the cursor after it). */
  toTs: number;
}

export type MemoryWarningCode =
  | "brief_over_budget"
  | "brief_truncated"
  | "note_over_budget"
  | "note_full"
  | "memory_over_budget"
  | "memory_full";

export interface MemoryWarning {
  code: MemoryWarningCode;
  /** Set for `note_*` codes. */
  topic?: Topic;
}

/** Log/tool form of a warning: `note_full:ev`, `memory_full`. */
export function warningKey(w: MemoryWarning): string {
  return w.topic ? `${w.code}:${w.topic}` : w.code;
}
