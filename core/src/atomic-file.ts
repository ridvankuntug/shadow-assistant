/**
 * Atomic file writes and a quarantining JSON reader for the Core's persistent
 * data (docs/07-speed.md S3; used by the continuity store and by memory, 06).
 *
 * Write: the data goes to `<path>.tmp-<pid>-<rand>` in the same directory, is
 * `fsync`ed and then renamed over the target. A crash at any point leaves
 * either the old file or the new one, never a half-written target. On Windows
 * a rename can fail for a moment with EPERM/EBUSY/EACCES while an antivirus
 * scanner or a sync client holds the target open; the rename is retried with
 * backoff for those codes only.
 *
 * Read: `readJsonOrQuarantine` returns the validated value, or `undefined` for a
 * missing file. A file that is not JSON or fails validation is renamed to
 * `<path>.corrupt-<epoch ms>` (the newest QUARANTINE_KEEP are kept) and
 * `undefined` is returned, so corruption never blocks a caller.
 *
 * Writes and reads of one path are serialized in-process (withPathLock), so a
 * quarantine never moves a file that a concurrent write has just replaced.
 *
 * File contents never appear in errors or callbacks from this module.
 */
import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

/** The `fs/promises` subset this module uses; injectable so tests can simulate failures. */
export interface AtomicFs {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  open(path: string, flags: string, mode?: number): Promise<AtomicFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readdir(path: string): Promise<string[]>;
}

export interface AtomicFileHandle {
  writeFile(data: string | Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

const realFs: AtomicFs = {
  mkdir: (p, o) => nodeFs.mkdir(p, o),
  open: (p, f, m) => nodeFs.open(p, f, m),
  rename: (a, b) => nodeFs.rename(a, b),
  unlink: (p) => nodeFs.unlink(p),
  readFile: (p, e) => nodeFs.readFile(p, e),
  readdir: (p) => nodeFs.readdir(p),
};

/** Error codes for which a rename is retried (Windows: file briefly held by another process). */
export const RETRYABLE_RENAME_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "EACCES"]);
/** Delay before each rename retry: 3 retries after the first attempt. */
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [50, 150, 400];
/** How many quarantined copies of one file are kept (newest first). */
export const QUARANTINE_KEEP = 3;

export interface AtomicWriteOptions {
  fs?: AtomicFs;
  /** One entry per retry; default DEFAULT_RETRY_DELAYS_MS. */
  retryDelaysMs?: readonly number[];
  /** File mode for a newly created file (POSIX only). Default 0o600: runtime data is private. */
  mode?: number;
}

function errCode(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && typeof (err as { code?: unknown }).code === "string"
    ? (err as { code: string }).code
    : undefined;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Tail of each path's lock chain; an entry is removed when its chain goes idle. */
const pathLocks = new Map<string, Promise<void>>();

/**
 * Runs `fn` while holding an in-process lock on `path`, shared by
 * writeFileAtomic and readJsonOrQuarantine. Without it, a quarantine rename
 * that is waiting to retry (EBUSY) could move a valid file that a concurrent
 * write has just put in place to `.corrupt-*`. Same-process only: other
 * processes do not write the Core's data files.
 */
async function withPathLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const r = resolve(path);
  const key = process.platform === "win32" ? r.toLowerCase() : r;
  const prev = pathLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  // The chain never rejects: each link only waits for the previous gate.
  const tail = prev.then(() => gate);
  pathLocks.set(key, tail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (pathLocks.get(key) === tail) pathLocks.delete(key);
  }
}

/** `rename` with retries on RETRYABLE_RENAME_CODES; any other error is thrown at once. */
async function renameWithRetry(fs: AtomicFs, from: string, to: string, delays: readonly number[]): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = errCode(err);
      const delay = delays[attempt];
      if (code === undefined || !RETRYABLE_RENAME_CODES.has(code) || delay === undefined) throw err;
      await sleep(delay);
    }
  }
}

/**
 * Writes `data` to `path` atomically (temp file in the same directory, fsync,
 * rename). Creates the parent directory. On failure the temp file is removed
 * (best effort), the previous content of `path` is untouched and the error is
 * rethrown.
 */
export function writeFileAtomic(path: string, data: string | Uint8Array, options: AtomicWriteOptions = {}): Promise<void> {
  return withPathLock(path, () => writeUnlocked(path, data, options));
}

async function writeUnlocked(path: string, data: string | Uint8Array, options: AtomicWriteOptions): Promise<void> {
  const fs = options.fs ?? realFs;
  const delays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const dir = dirname(path);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  let created = false;
  try {
    // `wx`: never reuse (or follow) an existing file under the temp name.
    const handle = await fs.open(tmp, "wx", options.mode ?? 0o600);
    created = true;
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(fs, tmp, path, delays);
    created = false;
  } finally {
    if (created) await fs.unlink(tmp).catch(() => {});
  }
  await syncDir(fs, dir);
}

/**
 * Makes the rename itself durable on POSIX by syncing the directory. Windows
 * cannot open a directory this way (and NTFS journals the rename), so any
 * failure here is ignored: the data file itself is already synced.
 */
async function syncDir(fs: AtomicFs, dir: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await fs.open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // best effort
  }
}

export interface QuarantineInfo {
  /** The file that was invalid. */
  path: string;
  /** Where it was moved, or undefined if the rename itself failed. */
  movedTo?: string;
  /** Why it was rejected, without any file content: "invalid_json" or "invalid_shape". */
  reason: "invalid_json" | "invalid_shape";
  /** Set when the rename failed; the file is then left in place (the next write replaces it). */
  renameError?: string;
}

export interface ReadJsonOptions {
  fs?: AtomicFs;
  retryDelaysMs?: readonly number[];
  /** Clock for the quarantine suffix. */
  now?: () => number;
  /** Called once per quarantined file, so the caller can log one warning. */
  onQuarantine?: (info: QuarantineInfo) => void;
}

/**
 * Reads and validates a JSON file.
 *
 * - missing file (ENOENT) → `undefined`;
 * - not JSON, or `validate` returns `undefined` / throws → the file is
 *   quarantined (renamed to `<path>.corrupt-<ts>`, older copies beyond
 *   QUARANTINE_KEEP deleted), `onQuarantine` is called, `undefined` is returned;
 * - any other read error (EACCES, EISDIR, …) is thrown: an unreadable file is
 *   not proof of corruption and must not be moved away.
 *
 * `validate` returns the typed value (it may normalize it) or `undefined`.
 */
export function readJsonOrQuarantine<T>(
  path: string,
  validate: (value: unknown) => T | undefined,
  options: ReadJsonOptions = {},
): Promise<T | undefined> {
  // Read, validate and quarantine under one lock: the file that is moved away
  // is the file that was found invalid, never a newer write.
  return withPathLock(path, () => readUnlocked(path, validate, options));
}

async function readUnlocked<T>(
  path: string,
  validate: (value: unknown) => T | undefined,
  options: ReadJsonOptions,
): Promise<T | undefined> {
  const fs = options.fs ?? realFs;
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    if (errCode(err) === "ENOENT") return undefined;
    throw err;
  }
  let parsed: unknown;
  try {
    // A BOM can appear after a hand edit with some Windows editors.
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    await quarantine(path, "invalid_json", fs, options);
    return undefined;
  }
  let value: T | undefined;
  try {
    value = validate(parsed);
  } catch {
    value = undefined;
  }
  if (value === undefined) {
    await quarantine(path, "invalid_shape", fs, options);
    return undefined;
  }
  return value;
}

async function quarantine(
  path: string,
  reason: QuarantineInfo["reason"],
  fs: AtomicFs,
  options: ReadJsonOptions,
): Promise<void> {
  const now = options.now ?? Date.now;
  const target = `${path}.corrupt-${now()}`;
  const info: QuarantineInfo = { path, reason };
  try {
    await renameWithRetry(fs, path, target, options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS);
    info.movedTo = target;
    await pruneQuarantined(fs, path);
  } catch (err) {
    info.renameError = errCode(err) ?? (err instanceof Error ? err.name : "unknown");
  }
  options.onQuarantine?.(info);
}

/** Deletes quarantined copies of `path` beyond the newest QUARANTINE_KEEP (best effort). */
async function pruneQuarantined(fs: AtomicFs, path: string): Promise<void> {
  const dir = dirname(path);
  const prefix = `${basename(path)}.corrupt-`;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const copies = names
    .filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length)))
    .map((n) => ({ name: n, ts: Number(n.slice(prefix.length)) }))
    .sort((a, b) => b.ts - a.ts);
  for (const old of copies.slice(QUARANTINE_KEEP)) {
    await fs.unlink(join(dir, old.name)).catch(() => {});
  }
}
