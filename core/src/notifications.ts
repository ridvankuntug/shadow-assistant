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
 * Not wired to any producer or client yet (T7.w.5b).
 *
 * - `key` (optional, unique per `source`) dedupes a recurring condition: a
 *   raise on an existing key replaces title / body / urgency and bumps
 *   `updatedAt` and `raised`; it becomes unread again only with
 *   `renotify: true`. Without a key every raise is a new item.
 * - Items are kept until deleted or resolved; nothing is pruned. The hard limit
 *   (MAX_ITEMS) only refuses new keyless raises (logged).
 * - `readAt` is shared across devices.
 * - Writes are atomic (writeFileAtomic) and serialized. A corrupt file (not
 *   JSON, wrong version, or any malformed item) is quarantined as a whole
 *   (`.corrupt-<ts>` copy kept) and the store starts empty with one warning,
 *   so a bad item is never dropped silently by the next write. A file that
 *   cannot be read (other than missing), or an invalid one that could not be
 *   moved aside, is never overwritten: operations fail
 *   until it can be read. A failed write keeps the in-memory state and is
 *   retried by the next change (or `flush()`).
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
}

export class NotificationStore {
  readonly file: string;
  private readonly now: () => number;
  private readonly maxItems: number;
  private data: NotificationsFile | undefined;
  /** Serializes load + change + write. */
  private chain: Promise<unknown> = Promise.resolve();
  /** In-memory changes a failed write did not persist. */
  private pending = false;

  constructor(private readonly o: NotificationStoreOptions) {
    this.file = join(o.dir, NOTIFICATIONS_FILE);
    this.now = o.now ?? Date.now;
    this.maxItems = o.maxItems ?? MAX_ITEMS;
  }

  /** Creates an item or updates the keyed one. Never rejects. */
  raise(input: RaiseInput): Promise<RaiseResult> {
    const clean = normalizeInput(input);
    if (!clean) {
      this.o.log?.("[shadow-core] notifications: invalid raise ignored");
      return Promise.resolve({ ok: false, reason: "invalid" });
    }
    return this.change<RaiseResult>({ ok: false, reason: "unavailable" }, (data) => {
      const stamp = this.stamp();
      if (clean.key !== undefined) {
        const existing = data.items.find((i) => i.source === clean.source && i.key === clean.key);
        if (existing) {
          existing.title = clean.title;
          existing.body = clean.body;
          existing.urgency = clean.urgency;
          existing.updatedAt = stamp;
          existing.raised++;
          if (clean.renotify) existing.readAt = null;
          return { result: { ok: true, item: structuredClone(existing), created: false }, changed: true };
        }
      } else if (data.items.length >= this.maxItems) {
        this.o.log?.(`[shadow-core] notifications: limit of ${this.maxItems} items reached; keyless raise from "${clean.source}" refused`);
        return { result: { ok: false, reason: "full" }, changed: false };
      }
      const item: NotificationItem = {
        id: newId(data.items),
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
      data.items.push(item);
      return { result: { ok: true, item: structuredClone(item), created: true }, changed: true };
    });
  }

  /** The producer removes its keyed item (the condition is over). Resolves whether one was removed. */
  resolve(source: string, key: string): Promise<boolean> {
    return this.removeWhere((i) => i.source === source && i.key === key);
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
    return this.removeWhere((i) => i.id === id);
  }

  /** All items, most recently updated first (copies). Empty if the file cannot be read. */
  async list(): Promise<NotificationItem[]> {
    const items = await this.change<NotificationItem[]>([], (data) => ({
      result: structuredClone(data.items),
      changed: false,
    }));
    return items.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? -1 : 1));
  }

  /** Number of unread items. */
  async unreadCount(): Promise<number> {
    return this.change(0, (data) => ({ result: data.items.filter((i) => i.readAt === null).length, changed: false }));
  }

  /** Retries a failed write now (shutdown). Never rejects. */
  async flush(): Promise<void> {
    await this.change(undefined, () => ({ result: undefined, changed: false }));
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  private async changeItem(id: string, fn: (item: NotificationItem) => boolean): Promise<NotificationItem | undefined> {
    return this.change<NotificationItem | undefined>(undefined, (data) => {
      const item = data.items.find((i) => i.id === id);
      if (!item) return { result: undefined, changed: false };
      const changed = fn(item);
      return { result: structuredClone(item), changed };
    });
  }

  private removeWhere(match: (i: NotificationItem) => boolean): Promise<boolean> {
    return this.change(false, (data) => {
      const index = data.items.findIndex(match);
      if (index < 0) return { result: false, changed: false };
      data.items.splice(index, 1);
      return { result: true, changed: true };
    });
  }

  /**
   * Runs `fn` on the loaded data under the chain and writes if it changed
   * anything (or a previous write failed). `fallback` is returned if the file
   * cannot be loaded. A write failure is logged; `fn`'s result still stands
   * (the change is kept in memory and retried by the next write).
   */
  private change<T>(fallback: T, fn: (data: NotificationsFile) => { result: T; changed: boolean }): Promise<T> {
    const run = this.chain.then(async () => {
      let data: NotificationsFile;
      try {
        data = await this.load();
      } catch (err) {
        this.o.log?.(`[shadow-core] notifications file could not be read: ${errName(err)}`);
        return fallback;
      }
      const { result, changed } = fn(data);
      if (changed || this.pending) {
        try {
          await writeFileAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`, {
            fs: this.o.fs,
            retryDelaysMs: this.o.retryDelaysMs,
          });
          this.pending = false;
        } catch (err) {
          this.pending = true;
          this.o.log?.(`[shadow-core] notifications write failed: ${errName(err)}`);
        }
      }
      return result;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private async load(): Promise<NotificationsFile> {
    if (!this.data) {
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
      this.data = loaded ?? { version: 1, items: [] };
    }
    return this.data;
  }
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

function newId(items: readonly NotificationItem[]): string {
  for (;;) {
    const id = `n-${randomBytes(8).toString("hex")}`;
    if (!items.some((i) => i.id === id)) return id;
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
