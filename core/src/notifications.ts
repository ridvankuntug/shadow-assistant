/**
 * Notification store (T7.w.5a; docs/08-learning-fast-path.md "T7.w.5
 * Notification store"). One shared inbox for the home, in
 * `<SHADOW_DATA_DIR>/notifications/notifications.json`:
 *
 *   { "version": 1, "items": [ { id, key?, source, urgency, title, body,
 *                                createdAt, updatedAt, readAt, raised } ] }
 *
 * Producers inside the Core (backup, service health, HA events, T11-B) call
 * `raise()` / `resolve()`; the user marks items read / unread or deletes them.
 * Clients reach it through `NotificationCenter` (session.ts, T7.w.5b); no producer yet.
 * T7.w.10f/g: unavailable reported, id access, coalesced writes.
 *
 * - `key` (optional, unique per `source`) dedupes a recurring condition: a
 *   raise on an existing key replaces title / body / urgency and bumps
 *   `updatedAt` and `raised`; it becomes unread again only with
 *   `renotify: true`. Without a key every raise is a new item.
 * - Items are kept until deleted or resolved; nothing is pruned. The hard limit
 *   (MAX_ITEMS) only refuses new keyless raises (logged).
 * - `readAt` is shared across devices.
 * - Items are held by id (a Map in file order, plus a source + key index):
 *   an action touches one item and copies only that one.
 * - Writes are atomic (writeFileAtomic), serialized and coalesced: changes
 *   are kept in memory and written at most once per `coalesceMs` (default
 *   DEFAULT_COALESCE_MS) and on `flush()` (shutdown). A corrupt file (not
 *   JSON, wrong version, or any malformed item) is quarantined as a whole
 *   (`.corrupt-<ts>` copy kept) and the store starts empty with one warning,
 *   so a bad item is never dropped silently by the next write. A file that
 *   cannot be read (other than missing), or an invalid one that could not be
 *   moved aside, is never overwritten: `raise()` answers `unavailable`, the
 *   other operations reject with NotificationsUnavailableError (never an
 *   empty inbox), until it can be read. A failed write keeps the in-memory
 *   state and is retried by the next operation (or `flush()`).
 */
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { readJsonOrQuarantine, writeFileAtomic, type AtomicFs } from "./atomic-file.js";

export type NotificationUrgency = "normal" | "urgent";

export interface NotificationItem {
  /** `n-` + 16 hex chars; stable for the item's life. */
  id: string;
  /** Dedupe key, unique per `source`. */
  key?: string;
  /** Short fixed producer name (`service`, `backup`, `ha`, `device-state`, `test`). */
  source: string;
  urgency: NotificationUrgency;
  title: string;
  body: string;
  /** ISO 8601. */
  createdAt: string;
  updatedAt: string;
  /** ISO 8601 when read, null while unread. */
  readAt: string | null;
  /** How many times the producer raised it (1 for a new item). */
  raised: number;
}

export interface NotificationsFile {
  version: 1;
  items: NotificationItem[];
}

export interface RaiseInput {
  source: string;
  key?: string;
  /** Default `normal`. */
  urgency?: NotificationUrgency;
  title: string;
  body?: string;
  /** On an existing key: make the item unread again. */
  renotify?: boolean;
}

export type RaiseResult =
  | { ok: true; item: NotificationItem; created: boolean }
  /**
   * `invalid`: bad input (a producer bug); `full`: keyless raise at the hard
   * limit; `unavailable`: the file could not be read.
   */
  | { ok: false; reason: "invalid" | "full" | "unavailable" };

export const NOTIFICATIONS_DIR = "notifications";
export const NOTIFICATIONS_FILE = "notifications.json";
/** Hard limit: at this many items new keyless raises are refused. */
export const MAX_ITEMS = 5000;
export const MAX_TITLE_CHARS = 200;
export const MAX_BODY_CHARS = 2000;
export const MAX_KEY_CHARS = 128;

const SOURCE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ID_RE = /^n-[0-9a-f]{16}$/;
const URGENCIES: ReadonlySet<string> = new Set<NotificationUrgency>(["normal", "urgent"]);

/** Changes are written at most this often (and on `flush()`, at shutdown). */
export const DEFAULT_COALESCE_MS = 1_000;

export interface NotificationStoreOptions {
  /** `<SHADOW_DATA_DIR>/notifications`. */
  dir: string;
  now?: () => number;
  log?: (msg: string) => void;
  /** Default MAX_ITEMS (tests use a small one). */
  maxItems?: number;
  /** File system for reads and writes (tests simulate failures). */
  fs?: AtomicFs;
  /** Rename retry delays (tests: none). */
  retryDelaysMs?: readonly number[];
  /**
   * Default DEFAULT_COALESCE_MS: changes are kept in memory and written at
   * most once per this many ms (and on `flush()`). 0 writes every change
   * before its promise settles.
   */
  coalesceMs?: number;
  /**
   * Timer for the coalesced write (tests: a fake fired by hand). Returns a
   * cancel function. Default: setTimeout, unref'd.
   */
  setTimer?: (fn: () => void, ms: number) => () => void;
}

/** A pending write never keeps the process alive; shutdown calls flush(). */
const unrefTimer = (fn: () => void, ms: number): (() => void) => {
  const t = setTimeout(fn, ms);
  t.unref?.();
  return () => clearTimeout(t);
};

/**
 * The notifications file cannot be read (other than missing), or an invalid
 * one could not be moved aside. The store then changes nothing and writes
 * nothing; the next call tries to read the file again.
 */
export class NotificationsUnavailableError extends Error {
  readonly code = "NOTIFICATIONS_UNAVAILABLE";
  constructor() {
    super("notifications file could not be read");
    this.name = "NotificationsUnavailableError";
  }
}

/** The loaded inbox: items by id (insertion order = file order) and the dedupe index. */
interface Inbox {
  items: Map<string, NotificationItem>;
  /** `keyOf(source, key)` → item id. */
  byKey: Map<string, string>;
}

const keyOf = (source: string, key: string) => `${source}\u0000${key}`;

/** A copy of one item: every field is a primitive, so a spread copies it fully. */
const copy = (item: NotificationItem): NotificationItem => ({ ...item });

export class NotificationStore {
  readonly file: string;
  private readonly now: () => number;
  private readonly maxItems: number;
  private readonly coalesceMs: number;
  private inbox: Inbox | undefined;
  /** Serializes load + change + write. */
  private chain: Promise<unknown> = Promise.resolve();
  /** In-memory changes not yet on disk (a coalesced change, or a failed write). */
  private pending = false;
  private readonly setTimer: (fn: () => void, ms: number) => () => void;
  /** Cancels the scheduled coalesced write; undefined when none is scheduled. */
  private cancelScheduled: (() => void) | undefined;

  constructor(private readonly o: NotificationStoreOptions) {
    this.file = join(o.dir, NOTIFICATIONS_FILE);
    this.now = o.now ?? Date.now;
    this.maxItems = o.maxItems ?? MAX_ITEMS;
    this.coalesceMs = o.coalesceMs ?? DEFAULT_COALESCE_MS;
    this.setTimer = o.setTimer ?? unrefTimer;
  }

  /** Creates an item or updates the keyed one. Never rejects (`unavailable` when the file cannot be read). */
  async raise(input: RaiseInput): Promise<RaiseResult> {
    const clean = normalizeInput(input);
    if (!clean) {
      this.o.log?.("[shadow-core] notifications: invalid raise ignored");
      return { ok: false, reason: "invalid" };
    }
    try {
      return await this.change<RaiseResult>((inbox) => {
        const stamp = this.stamp();
        if (clean.key !== undefined) {
          const id = inbox.byKey.get(keyOf(clean.source, clean.key));
          const existing = id === undefined ? undefined : inbox.items.get(id);
          if (existing) {
            existing.title = clean.title;
            existing.body = clean.body;
            existing.urgency = clean.urgency;
            existing.updatedAt = stamp;
            existing.raised++;
            if (clean.renotify) existing.readAt = null;
            return { result: { ok: true, item: copy(existing), created: false }, changed: true };
          }
        } else if (inbox.items.size >= this.maxItems) {
          this.o.log?.(`[shadow-core] notifications: limit of ${this.maxItems} items reached; keyless raise from "${clean.source}" refused`);
          return { result: { ok: false, reason: "full" }, changed: false };
        }
        const item: NotificationItem = {
          id: newId(inbox.items),
          ...(clean.key !== undefined ? { key: clean.key } : {}),
          source: clean.source,
          urgency: clean.urgency,
          title: clean.title,
          body: clean.body,
          createdAt: stamp,
          updatedAt: stamp,
          readAt: null,
          raised: 1,
        };
        add(inbox, item);
        return { result: { ok: true, item: copy(item), created: true }, changed: true };
      });
    } catch (err) {
      if (err instanceof NotificationsUnavailableError) return { ok: false, reason: "unavailable" };
      throw err;
    }
  }

  /**
   * The producer removes its keyed item (the condition is over). Resolves the
   * removed item, or undefined if there was none. Rejects with
   * NotificationsUnavailableError when the file cannot be read.
   */
  resolve(source: string, key: string): Promise<NotificationItem | undefined> {
    return this.change((inbox) => {
      const id = inbox.byKey.get(keyOf(source, key));
      const item = id === undefined ? undefined : inbox.items.get(id);
      if (!item) return { result: undefined, changed: false };
      remove(inbox, item);
      return { result: copy(item), changed: true };
    });
  }

  /** One item (a copy), or undefined if unknown. Rejects with NotificationsUnavailableError when the file cannot be read. */
  get(id: string): Promise<NotificationItem | undefined> {
    return this.change((inbox) => {
      const item = inbox.items.get(id);
      return { result: item && copy(item), changed: false };
    });
  }

  /** Marks an item read (shared across devices). An already read item keeps its `readAt`. Undefined if unknown. */
  markRead(id: string): Promise<NotificationItem | undefined> {
    return this.changeItem(id, (item) => {
      if (item.readAt !== null) return false;
      item.readAt = this.stamp();
      return true;
    });
  }

  /** Marks an item unread. Undefined if unknown. */
  markUnread(id: string): Promise<NotificationItem | undefined> {
    return this.changeItem(id, (item) => {
      if (item.readAt === null) return false;
      item.readAt = null;
      return true;
    });
  }

  /** Deletes an item (the user). Resolves whether it existed. */
  delete(id: string): Promise<boolean> {
    return this.change((inbox) => {
      const item = inbox.items.get(id);
      if (!item) return { result: false, changed: false };
      remove(inbox, item);
      return { result: true, changed: true };
    });
  }

  /**
   * All items, most recently updated first, each passed through `map`
   * (default: a copy; a caller that builds its own objects passes its mapper,
   * so the list is copied once). Rejects with NotificationsUnavailableError
   * when the file cannot be read: an unreadable inbox is never reported as an
   * empty one.
   */
  list(): Promise<NotificationItem[]>;
  list<T>(map: (item: Readonly<NotificationItem>) => T): Promise<T[]>;
  list<T>(map?: (item: Readonly<NotificationItem>) => T): Promise<Array<T | NotificationItem>> {
    const out: (item: NotificationItem) => T | NotificationItem = map ?? copy;
    return this.change((inbox) => ({
      result: [...inbox.items.values()].sort(byUpdated).map((item) => out(item)),
      changed: false,
    }));
  }

  /** Number of unread items. Rejects with NotificationsUnavailableError when the file cannot be read. */
  unreadCount(): Promise<number> {
    return this.change((inbox) => {
      let n = 0;
      for (const item of inbox.items.values()) if (item.readAt === null) n++;
      return { result: n, changed: false };
    });
  }

  /** Writes pending changes now (coalesced, or a failed write; shutdown). Never rejects. */
  flush(): Promise<void> {
    this.cancelTimer();
    const run = this.chain.then(async () => {
      if (this.pending && this.inbox) await this.write(this.inbox);
    });
    this.chain = run.catch(() => {});
    return run.catch(() => {});
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  private changeItem(id: string, fn: (item: NotificationItem) => boolean): Promise<NotificationItem | undefined> {
    return this.change((inbox) => {
      const item = inbox.items.get(id);
      if (!item) return { result: undefined, changed: false };
      const changed = fn(item);
      return { result: copy(item), changed };
    });
  }

  /**
   * Runs `fn` on the loaded inbox under the chain. A change (or a pending one
   * from a failed write) is written at once with `coalesceMs` 0, else within
   * `coalesceMs`. Rejects with NotificationsUnavailableError when the file
   * cannot be loaded; nothing is then written, so the file on disk is never
   * replaced by an empty inbox. A write failure is logged; `fn`'s result
   * still stands (the change is kept in memory and retried by the next write).
   */
  private change<T>(fn: (inbox: Inbox) => { result: T; changed: boolean }): Promise<T> {
    const run = this.chain.then(async () => {
      let inbox: Inbox;
      try {
        inbox = await this.load();
      } catch (err) {
        this.o.log?.(`[shadow-core] notifications file could not be read: ${errName(err)}`);
        throw new NotificationsUnavailableError();
      }
      const { result, changed } = fn(inbox);
      if (changed) this.pending = true;
      if (this.pending) {
        if (this.coalesceMs > 0) this.schedule();
        else await this.write(inbox);
      }
      return result;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  /** Writes the inbox; on success clears `pending`, on failure keeps it and logs. Never throws. */
  private async write(inbox: Inbox): Promise<void> {
    const file: NotificationsFile = { version: 1, items: [...inbox.items.values()] };
    try {
      await writeFileAtomic(this.file, `${JSON.stringify(file, null, 2)}\n`, {
        fs: this.o.fs,
        retryDelaysMs: this.o.retryDelaysMs,
      });
      this.pending = false;
    } catch (err) {
      this.pending = true;
      this.o.log?.(`[shadow-core] notifications write failed: ${errName(err)}`);
    }
  }

  private schedule(): void {
    if (this.cancelScheduled) return;
    this.cancelScheduled = this.setTimer(() => {
      this.cancelScheduled = undefined;
      void this.flush();
    }, this.coalesceMs);
  }

  private cancelTimer(): void {
    this.cancelScheduled?.();
    this.cancelScheduled = undefined;
  }

  private async load(): Promise<Inbox> {
    if (!this.inbox) {
      let leftInPlace = false;
      const loaded = await readJsonOrQuarantine(this.file, validateFile, {
        fs: this.o.fs,
        retryDelaysMs: this.o.retryDelaysMs,
        now: this.now,
        onQuarantine: (info) => {
          if (info.movedTo) this.o.log?.("[shadow-core] notifications file was invalid and was moved aside");
          else leftInPlace = true;
        },
      });
      // An invalid file that could not be moved aside must not be replaced by
      // an empty store on the next write: stay unavailable and retry later.
      if (leftInPlace) throw Object.assign(new Error("invalid file could not be moved aside"), { code: "QUARANTINE_FAILED" });
      const inbox: Inbox = { items: new Map(), byKey: new Map() };
      // validateFile already refused duplicate ids and keys.
      for (const item of loaded?.items ?? []) add(inbox, item);
      this.inbox = inbox;
    }
    return this.inbox;
  }
}

/** Most recently updated first, then by id. */
function byUpdated(a: NotificationItem, b: NotificationItem): number {
  return Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? -1 : 1);
}

function add(inbox: Inbox, item: NotificationItem): void {
  inbox.items.set(item.id, item);
  if (item.key !== undefined) inbox.byKey.set(keyOf(item.source, item.key), item.id);
}

function remove(inbox: Inbox, item: NotificationItem): void {
  inbox.items.delete(item.id);
  if (item.key !== undefined) inbox.byKey.delete(keyOf(item.source, item.key));
}

/** Error code or name only: an fs message holds the path, never needed in the log line. */
function errName(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
    if (err instanceof Error) return err.message;
  }
  return String(err);
}

function newId(items: ReadonlyMap<string, NotificationItem>): string {
  for (;;) {
    const id = `n-${randomBytes(8).toString("hex")}`;
    if (!items.has(id)) return id;
  }
}

function normalizeInput(input: RaiseInput): Required<Omit<RaiseInput, "key">> & { key?: string } | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const { source, key, urgency = "normal", title, body = "", renotify = false } = input;
  if (typeof source !== "string" || !SOURCE_RE.test(source)) return undefined;
  if (key !== undefined && (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_CHARS)) return undefined;
  if (typeof urgency !== "string" || !URGENCIES.has(urgency)) return undefined;
  if (typeof title !== "string" || title.trim().length === 0) return undefined;
  if (typeof body !== "string" || typeof renotify !== "boolean") return undefined;
  return {
    source,
    ...(key !== undefined ? { key } : {}),
    urgency,
    title: title.trim().slice(0, MAX_TITLE_CHARS),
    body: body.trim().slice(0, MAX_BODY_CHARS),
    renotify,
  };
}

const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

function validateItem(v: unknown): NotificationItem | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !ID_RE.test(o.id)) return undefined;
  if (typeof o.source !== "string" || !SOURCE_RE.test(o.source)) return undefined;
  if (o.key !== undefined && (typeof o.key !== "string" || o.key.length === 0 || o.key.length > MAX_KEY_CHARS)) return undefined;
  if (typeof o.urgency !== "string" || !URGENCIES.has(o.urgency)) return undefined;
  if (typeof o.title !== "string" || typeof o.body !== "string") return undefined;
  if (!isIso(o.createdAt) || !isIso(o.updatedAt)) return undefined;
  if (o.readAt !== null && !isIso(o.readAt)) return undefined;
  if (typeof o.raised !== "number" || !Number.isInteger(o.raised) || o.raised < 1) return undefined;
  return {
    id: o.id,
    ...(o.key !== undefined ? { key: o.key as string } : {}),
    source: o.source,
    urgency: o.urgency as NotificationUrgency,
    title: o.title,
    body: o.body,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    readAt: o.readAt as string | null,
    raised: o.raised,
  };
}

/**
 * The whole file or nothing: one malformed item, a duplicate id or a
 * duplicate source + key quarantines the file (the copy is kept), so the next
 * write never drops an item silently.
 */
function validateFile(v: unknown): NotificationsFile | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (o.version !== 1 || !Array.isArray(o.items)) return undefined;
  const items: NotificationItem[] = [];
  const ids = new Set<string>();
  const keys = new Set<string>();
  for (const raw of o.items as unknown[]) {
    const item = validateItem(raw);
    if (!item || ids.has(item.id)) return undefined;
    ids.add(item.id);
    if (item.key !== undefined) {
      const k = JSON.stringify([item.source, item.key]);
      if (keys.has(k)) return undefined;
      keys.add(k);
    }
    items.push(item);
  }
  return { version: 1, items };
}
