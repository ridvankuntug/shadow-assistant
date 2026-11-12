/**
 * "Tekrar gösterme" suppression records (T7.w.11.7, docs/09 *Dismiss options*).
 * One small file next to the inbox,
 * `<SHADOW_DATA_DIR>/notifications/suppressed.json`:
 *
 *   { "version": 1, "items": [ { source, key, at } ] }
 *
 * A record says "the user asked not to see `source` + `key` again while the
 * condition lasts". It holds no title, body or anything a producer wrote:
 * only the producer name, its fixed dedupe key and when it was suppressed.
 * `NotificationCenter` checks it in the raise path and removes it on
 * `resolve(source, key)` (the condition ended).
 *
 * Failure policy: this file only hides items, so losing it means items are
 * shown again, never that one is lost. No method rejects except `list()`
 * (startup adoption, see there).
 * - Missing file: empty.
 * - Corrupt file (not JSON, wrong shape): quarantined (`.corrupt-<ts>` copy
 *   kept, one warning) and empty.
 * - Unreadable file (locked, permissions) or a corrupt one that could not be
 *   moved aside: one warning, and the store behaves as empty for now, keeping
 *   its own changes in memory only. It never writes over that file; every
 *   later call tries to read it again, and once it can, the changes made in
 *   the meantime are applied on top of it and written.
 * - Writes are atomic (writeFileAtomic) and immediate (the actions are rare);
 *   a failed write keeps the in-memory state and is retried by the next
 *   change or by `flush()` (shutdown).
 */
import { join } from "node:path";
import { readJsonOrQuarantine, writeFileAtomic, type AtomicFs } from "./atomic-file.js";
import { MAX_KEY_CHARS } from "./notifications.js";

export const SUPPRESSIONS_FILE = "suppressed.json";
/** Hard limit on records; at the limit a new suppression is not recorded (logged). */
export const MAX_SUPPRESSIONS = 1000;

const SOURCE_RE = /^[a-z][a-z0-9-]{0,31}$/;

export interface SuppressionRecord {
  source: string;
  key: string;
  /** ISO 8601, when the user suppressed it. */
  at: string;
}

interface SuppressionsFile {
  version: 1;
  items: SuppressionRecord[];
}

export interface SuppressionStoreOptions {
  /** `<SHADOW_DATA_DIR>/notifications`. */
  dir: string;
  now?: () => number;
  log?: (msg: string) => void;
  /** Default MAX_SUPPRESSIONS (tests use a small one). */
  maxItems?: number;
  /** File system for reads and writes (tests simulate failures). */
  fs?: AtomicFs;
  /** Rename retry delays (tests: none). */
  retryDelaysMs?: readonly number[];
}

const idOf = (source: string, key: string) => `${source}\u0000${key}`;

/** A valid (source, key) pair, as the notification store accepts it. */
export function isSuppressible(source: unknown, key: unknown): key is string {
  return (
    typeof source === "string" &&
    SOURCE_RE.test(source) &&
    typeof key === "string" &&
    key.length > 0 &&
    key.length <= MAX_KEY_CHARS
  );
}

/** `list()` while the suppression file cannot be read (startup adoption retries later). */
export class SuppressionsUnavailableError extends Error {
  readonly code = "SUPPRESSIONS_UNAVAILABLE";
  constructor() {
    super("notification suppressions file could not be read");
    this.name = "SuppressionsUnavailableError";
  }
}

export class SuppressionStore {
  readonly file: string;
  private readonly now: () => number;
  private readonly maxItems: number;
  /** The records as last read from (and written to) the file; undefined until it could be read. */
  private loaded: Map<string, SuppressionRecord> | undefined;
  /**
   * Changes made while the file could not be read: a record (added) or null
   * (removed), applied on top of the file once it can be read.
   */
  private readonly overlay = new Map<string, SuppressionRecord | null>();
  /** In-memory changes not yet on disk (a failed write). */
  private pending = false;
  /** The last read failed: logged once per spell. */
  private unreadable = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: SuppressionStoreOptions) {
    this.file = join(o.dir, SUPPRESSIONS_FILE);
    this.now = o.now ?? Date.now;
    this.maxItems = o.maxItems ?? MAX_SUPPRESSIONS;
  }

  /** Whether `source` + `key` is suppressed now. */
  has(source: string, key: string): Promise<boolean> {
    return this.run(false, (view) => view.has(idOf(source, key)));
  }

  /**
   * Every record (copies), oldest first. Producers adopt these at startup. The one call that
   * rejects (SuppressionsUnavailableError) while the file cannot be read: an adoption that saw
   * "none" would never resolve (and so never clear) a record it did not see; it retries instead.
   */
  list(): Promise<SuppressionRecord[]> {
    const run = this.chain.then(async () => {
      const file = await this.load();
      if (!file) throw new SuppressionsUnavailableError();
      if (this.pending) await this.write(file);
      return [...file.values()].map((r) => ({ ...r }));
    });
    this.chain = run.catch(() => {});
    return run;
  }

  /**
   * Records a suppression. Resolves false for an invalid pair or at the limit
   * (logged); an existing record keeps its first `at`.
   */
  add(source: string, key: string): Promise<boolean> {
    if (!isSuppressible(source, key)) return Promise.resolve(false);
    return this.change(false, (view) => {
      const id = idOf(source, key);
      if (view.has(id)) return { result: true, set: undefined };
      if (view.size >= this.maxItems) {
        this.o.log?.(`[shadow-core] notification suppressions: limit of ${this.maxItems} reached; "${source}" not recorded`);
        return { result: false, set: undefined };
      }
      return { result: true, set: [id, { source, key, at: new Date(this.now()).toISOString() }] };
    });
  }

  /**
   * Removes a suppression (the condition ended). Resolves whether one was known. While the file
   * cannot be read the removal is kept anyway (a record only on disk is removed once it can be read).
   */
  remove(source: string, key: string): Promise<boolean> {
    return this.change(false, (view, loaded) => {
      const id = idOf(source, key);
      if (!view.has(id)) return { result: false, set: loaded ? undefined : [id, null] };
      return { result: true, set: [id, null] };
    });
  }

  /** Writes a failed change again (shutdown). Never rejects. */
  flush(): Promise<void> {
    return this.run(undefined, () => undefined);
  }

  /** Read-only call on the current view. */
  private run<T>(fallback: T, fn: (view: ReadonlyMap<string, SuppressionRecord>) => T): Promise<T> {
    return this.change(fallback, (view) => ({ result: fn(view), set: undefined }));
  }

  /**
   * Runs `fn` on the current view under the chain and applies its one change
   * (`set`: a record, or null = remove). With the file loaded the change goes
   * to it and is written; while it cannot be read, to the overlay only. Never
   * rejects: an unexpected error answers `fallback`.
   */
  private change<T>(
    fallback: T,
    fn: (
      view: ReadonlyMap<string, SuppressionRecord>,
      loaded: boolean,
    ) => { result: T; set: [string, SuppressionRecord | null] | undefined },
  ): Promise<T> {
    const run = this.chain.then(async () => {
      const file = await this.load();
      const view = file ?? this.overlayView();
      const { result, set } = fn(view, file !== undefined);
      if (set) {
        const [id, rec] = set;
        if (file) {
          if (rec) file.set(id, rec);
          else file.delete(id);
          this.pending = true;
        } else {
          this.overlay.set(id, rec);
        }
      }
      if (file && this.pending) await this.write(file);
      return result;
    });
    this.chain = run.catch(() => {});
    return run.catch((err: unknown) => {
      this.o.log?.(`[shadow-core] notification suppressions failed: ${errName(err)}`);
      return fallback;
    });
  }

  /** While the file cannot be read: the changes made since, as if the file were empty. */
  private overlayView(): Map<string, SuppressionRecord> {
    const view = new Map<string, SuppressionRecord>();
    for (const [id, rec] of this.overlay) if (rec) view.set(id, rec);
    return view;
  }

  /** The loaded records, or undefined when the file cannot be read now (logged once per spell). */
  private async load(): Promise<Map<string, SuppressionRecord> | undefined> {
    if (this.loaded) return this.loaded;
    let leftInPlace = false;
    let data: SuppressionsFile | undefined;
    try {
      data = await readJsonOrQuarantine(this.file, validateFile, {
        fs: this.o.fs,
        retryDelaysMs: this.o.retryDelaysMs,
        now: this.now,
        onQuarantine: (info) => {
          if (info.movedTo) this.o.log?.("[shadow-core] notification suppressions file was invalid and was moved aside; starting empty");
          else leftInPlace = true;
        },
      });
    } catch (err) {
      return this.cannotRead(errName(err));
    }
    // An invalid file that could not be moved aside is not replaced: retried on the next call.
    if (leftInPlace) return this.cannotRead("invalid file could not be moved aside");
    if (this.unreadable) {
      this.unreadable = false;
      this.o.log?.("[shadow-core] notification suppressions file can be read again");
    }
    const map = new Map<string, SuppressionRecord>();
    for (const r of data?.items ?? []) map.set(idOf(r.source, r.key), r);
    // Changes made while it could not be read go on top of it.
    for (const [id, rec] of this.overlay) {
      if (rec) {
        if (!map.has(id) && map.size < this.maxItems) map.set(id, rec);
      } else {
        map.delete(id);
      }
    }
    if (this.overlay.size > 0) this.pending = true;
    this.overlay.clear();
    this.loaded = map;
    return map;
  }

  private cannotRead(why: string): undefined {
    if (!this.unreadable) {
      this.unreadable = true;
      this.o.log?.(`[shadow-core] notification suppressions file could not be read (${why}); treated as empty for now`);
    }
    return undefined;
  }

  /** Writes the records; on failure keeps `pending` (retried by the next change or `flush()`) and logs. Never throws. */
  private async write(map: Map<string, SuppressionRecord>): Promise<void> {
    const file: SuppressionsFile = { version: 1, items: [...map.values()] };
    try {
      await writeFileAtomic(this.file, `${JSON.stringify(file, null, 2)}\n`, {
        fs: this.o.fs,
        retryDelaysMs: this.o.retryDelaysMs,
      });
      this.pending = false;
    } catch (err) {
      this.pending = true;
      this.o.log?.(`[shadow-core] notification suppressions write failed: ${errName(err)}`);
    }
  }
}

/** Error code or name only: an fs message holds the path. */
function errName(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
    if (err instanceof Error) return err.name;
  }
  return "error";
}

/** The whole file or nothing: one malformed record quarantines it. Duplicates are merged (first kept). */
function validateFile(v: unknown): SuppressionsFile | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (o.version !== 1 || !Array.isArray(o.items)) return undefined;
  const items: SuppressionRecord[] = [];
  const seen = new Set<string>();
  for (const raw of o.items as unknown[]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const r = raw as Record<string, unknown>;
    if (!isSuppressible(r.source, r.key)) return undefined;
    if (typeof r.at !== "string" || Number.isNaN(Date.parse(r.at))) return undefined;
    const id = idOf(r.source as string, r.key);
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({ source: r.source as string, key: r.key, at: r.at });
  }
  return { version: 1, items };
}
