/**
 * Backup notification producer (docs/09 (a), T7.w.11.2).
 *
 * Reads the status file `backup-data.ps1` writes to
 * `<data dir>/backup/status.json`:
 *   {version: 1, runId, startedAt, finishedAt?, result: running|ok|failed,
 *    stage?: setup|archive|upload|prune, lastSuccessAt}   (ISO 8601 UTC,
 *    lastSuccessAt null until the first success)
 * once per interval (default 60 s; `stat` first, the file is parsed again only
 * when its mtime or size changed) and keeps two keyed items of source `backup`:
 *
 * - `backup:failed` (normal): `result: failed`, or `running` for longer than
 *   2 h 15 min (the task's 2 h limit + margin: "takıldı"). Each new failed
 *   `runId` re-raises it with `renotify` (one unread reminder per failed run);
 *   the same run never renotifies (a stuck run that later reads `failed` only
 *   updates the text).
 * - `backup:stale` (normal, "Yedek alınmadı"): the last success is older than
 *   26 h and no failure explains it (a failure resolves it: `backup:failed`
 *   says more).
 * - No successful backup for more than 72 h: the open item is re-raised as
 *   **urgent** with `renotify` (spoken once by NotificationCenter); it is
 *   raised again only when its run or content changes, never every interval.
 * - `result: ok` resolves `backup:failed`; `backup:stale` resolves once the
 *   last success is recent again (a fresh `ok` always is).
 * - A run in progress (`running`, not stuck) changes nothing: the open items
 *   wait for its result.
 * - No file = backup not set up = no notification (open items are resolved).
 *   An unreadable or invalid file is logged once (until a valid read) and
 *   changes nothing.
 *
 * Reference for "no success for N hours" when `lastSuccessAt` is null (no run
 * ever succeeded): the earliest known start of a failing setup, i.e. the
 * earliest `startedAt` seen since the Core started, or the `createdAt` of an
 * open backup item adopted at startup (it persists across restarts). Default
 * decision, awaiting the user's approval (docs/09).
 *
 * Startup reconcile: before the first evaluation the existing `backup` items
 * are read from the store and adopted as raised, so recovery resolves them and
 * an unchanged condition is not raised again. An adopted `backup:failed` item
 * is treated as a new failure (renotify) only when the status run ended after
 * the item was last updated.
 *
 * Texts are Turkish; they never hold remote names, paths or error text (the
 * script does not write the error either, only the stage).
 */
import { stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NotificationItem, NotificationUrgency, RaiseInput, RaiseResult } from "./notifications.js";
import type { Logger } from "./session.js";

export const BACKUP_SOURCE = "backup";
export const BACKUP_KEY_FAILED = "backup:failed";
export const BACKUP_KEY_STALE = "backup:stale";
export const BACKUP_STATUS_DIR = "backup";
export const BACKUP_STATUS_FILE = "status.json";

export const DEFAULT_BACKUP_INTERVAL_MS = 60_000;
const HOUR = 3_600_000;
/** Task limit (2 h) + 15 min margin: a `running` status older than this is stuck. */
export const BACKUP_STUCK_MS = 2 * HOUR + 15 * 60_000;
/** Daily run + 2 h: no success for longer than this → `backup:stale`. */
export const BACKUP_STALE_MS = 26 * HOUR;
/** No success for longer than this → the open item becomes urgent. */
export const BACKUP_URGENT_MS = 72 * HOUR;

/** `<data dir>/backup/status.json`, the file backup-data.ps1 writes. */
export function backupStatusPath(dataDir: string): string {
  return join(dataDir, BACKUP_STATUS_DIR, BACKUP_STATUS_FILE);
}

/** What the producer needs from NotificationCenter (raise / resolve) and the store (startup adoption). */
export interface BackupNotificationPort {
  raise(input: RaiseInput): Promise<RaiseResult>;
  /** Rejects when the inbox cannot be read; the producer retries on the next round. */
  resolve(source: string, key: string): Promise<boolean>;
  /** Every item (any source); rejects when the inbox cannot be read. */
  list(): Promise<ReadonlyArray<Pick<NotificationItem, "source" | "key" | "urgency" | "title" | "body" | "createdAt" | "updatedAt">>>;
}

export interface BackupProducerOptions {
  /** Full path of the status file (`backupStatusPath(cfg.dataDir)`). */
  statusFile: string;
  notifications: BackupNotificationPort;
  logger: Logger;
  now?: () => number;
  intervalMs?: number;
}

export type BackupResult = "running" | "ok" | "failed";

/** A valid status file, timestamps as epoch ms. */
export interface BackupStatus {
  runId: string;
  startedAt: number;
  finishedAt: number | undefined;
  result: BackupResult;
  stage: string | undefined;
  lastSuccessAt: number | null;
}

/** Parses the status file text; undefined when it is not valid JSON of the version 1 shape. */
export function parseBackupStatus(text: string): BackupStatus | undefined {
  let raw: unknown;
  try {
    // PowerShell may write a UTF-8 BOM; JSON.parse does not accept it.
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) return undefined;
  if (typeof o.runId !== "string" || o.runId === "") return undefined;
  if (o.result !== "running" && o.result !== "ok" && o.result !== "failed") return undefined;
  const startedAt = time(o.startedAt);
  if (startedAt === undefined) return undefined;
  let finishedAt: number | undefined;
  if (o.finishedAt !== undefined && o.finishedAt !== null) {
    finishedAt = time(o.finishedAt);
    if (finishedAt === undefined) return undefined;
  }
  let lastSuccessAt: number | null = null;
  if (o.lastSuccessAt !== undefined && o.lastSuccessAt !== null) {
    const t = time(o.lastSuccessAt);
    if (t === undefined) return undefined;
    lastSuccessAt = t;
  }
  // An `ok` run is itself a success (the script writes lastSuccessAt = finishedAt).
  if (o.result === "ok" && lastSuccessAt === null) lastSuccessAt = finishedAt ?? startedAt;
  const stage = typeof o.stage === "string" && o.stage !== "" ? o.stage : undefined;
  return { runId: o.runId, startedAt, finishedAt, result: o.result, stage, lastSuccessAt };
}

function time(v: unknown): number | undefined {
  if (typeof v !== "string" || v === "") return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}

const STAGE_TR: Record<string, string> = {
  setup: "hazırlık",
  archive: "arşivleme",
  upload: "yükleme",
  prune: "eski yedekleri temizleme",
};

const URGENT_NOTE = "3 günden uzun süredir başarılı yedek yok.";
const LOG_NOTE = "Ayrıntı yedekleme günlüğünde.";

/** What one key should show now. */
interface Desired {
  urgency: NotificationUrgency;
  title: string;
  body: string;
  /** The run behind a `backup:failed` item; undefined for `backup:stale`. */
  runId: string | undefined;
  /** When the condition arose (adopted-item comparison). */
  at: number;
}

/** What the producer believes the inbox shows for one key. */
interface Open {
  urgency: NotificationUrgency;
  title: string;
  body: string;
  /** Undefined for an adopted item (the run is not stored in the inbox). */
  runId: string | undefined;
  /** Adopted items only: their `updatedAt` (ms). */
  updatedAt: number | undefined;
}

/** `hold`: change nothing for this key; `none`: the key should not exist. */
type Want = Desired | "none" | "hold";

interface Cached {
  mtimeMs: number;
  size: number;
  status: BackupStatus | undefined;
}

export class BackupProducer {
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly open = new Map<string, Open>();
  private adopted = false;
  /** Earliest known start of a never-succeeded setup (see the module comment). */
  private firstNoSuccess: number | undefined;
  private cached: Cached | undefined;
  /** An invalid / unreadable file was logged; cleared by a valid read or a missing file. */
  private loggedBad = false;
  private loggedAdoptFailure = false;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private closed = false;

  constructor(private readonly o: BackupProducerOptions) {
    this.now = o.now ?? Date.now;
    const ms = o.intervalMs ?? DEFAULT_BACKUP_INTERVAL_MS;
    this.intervalMs = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_BACKUP_INTERVAL_MS;
  }

  /** Runs the first round now and then one round per interval. */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    void this.checkNow();
  }

  /** Runs a round now; joins the running one instead of starting a second. Never rejects. */
  checkNow(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.running = this.round()
      .catch((err: unknown) => this.o.logger.warn(`[shadow-core] backup producer: round failed (${(err as Error)?.name ?? "error"})`))
      .finally(() => {
        this.running = null;
        this.schedule();
      });
    return this.running;
  }

  /** Stops the timer and waits for the running round. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running;
  }

  private schedule(): void {
    if (this.closed || !this.started || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.checkNow();
    }, this.intervalMs);
    // The HTTP server keeps the process alive; the producer alone must not.
    this.timer.unref?.();
  }

  private async round(): Promise<void> {
    if (!this.adopted && !(await this.adopt())) return;
    const read = await this.read();
    if (read === "bad") return; // logged once; the open items stay as they are
    if (read === "missing") {
      await this.apply(BACKUP_KEY_FAILED, "none");
      await this.apply(BACKUP_KEY_STALE, "none");
      return;
    }
    const { failed, stale } = this.evaluate(read, this.now());
    await this.apply(BACKUP_KEY_FAILED, failed);
    await this.apply(BACKUP_KEY_STALE, stale);
  }

  /** Startup reconcile: the store's `backup` items count as raised. False when the inbox could not be read (retried next round). */
  private async adopt(): Promise<boolean> {
    let items: Awaited<ReturnType<BackupNotificationPort["list"]>>;
    try {
      items = await this.o.notifications.list();
    } catch {
      if (!this.loggedAdoptFailure) {
        this.loggedAdoptFailure = true;
        this.o.logger.warn("[shadow-core] backup producer: notifications unreadable; startup reconcile retried next round");
      }
      return false;
    }
    for (const item of items) {
      if (item.source !== BACKUP_SOURCE) continue;
      if (item.key !== BACKUP_KEY_FAILED && item.key !== BACKUP_KEY_STALE) continue;
      const updatedAt = Date.parse(item.updatedAt);
      this.open.set(item.key, {
        urgency: item.urgency,
        title: item.title,
        body: item.body,
        runId: undefined,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
      });
      const createdAt = Date.parse(item.createdAt);
      if (Number.isFinite(createdAt)) this.firstNoSuccess = min(this.firstNoSuccess, createdAt);
    }
    this.adopted = true;
    return true;
  }

  /** The current status, "missing" (no file) or "bad" (unreadable / invalid, logged once). */
  private async read(): Promise<BackupStatus | "missing" | "bad"> {
    let mtimeMs: number;
    let size: number;
    try {
      const st = await stat(this.o.statusFile);
      if (!st.isFile()) return this.bad("not a file");
      mtimeMs = st.mtimeMs;
      size = st.size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.cached = undefined;
        this.loggedBad = false;
        return "missing";
      }
      return this.bad("unreadable");
    }
    const c = this.cached;
    if (!c || c.mtimeMs !== mtimeMs || c.size !== size) {
      let text: string;
      try {
        text = await readFile(this.o.statusFile, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
          this.cached = undefined;
          this.loggedBad = false;
          return "missing";
        }
        return this.bad("unreadable");
      }
      this.cached = { mtimeMs, size, status: parseBackupStatus(text) };
    }
    const status = this.cached?.status;
    if (!status) return this.bad("invalid");
    this.loggedBad = false;
    return status;
  }

  private bad(why: "invalid" | "unreadable" | "not a file"): "bad" {
    if (!this.loggedBad) {
      this.loggedBad = true;
      this.o.logger.warn(`[shadow-core] backup producer: status file ${why}; ignored until it changes`);
    }
    return "bad";
  }

  /** The rules of docs/09 (a) for one status at `now`. */
  private evaluate(s: BackupStatus, now: number): { failed: Want; stale: Want } {
    if (s.lastSuccessAt === null) this.firstNoSuccess = min(this.firstNoSuccess, s.startedAt);
    else this.firstNoSuccess = undefined;
    const ref = s.lastSuccessAt ?? this.firstNoSuccess;
    const urgent = ref !== undefined && now - ref > BACKUP_URGENT_MS;
    const urgency: NotificationUrgency = urgent ? "urgent" : "normal";

    if (s.result === "failed") {
      const where = s.stage ? STAGE_TR[s.stage] : undefined;
      const lead = where ? `Yedekleme ${where} aşamasında başarısız oldu.` : "Son yedekleme başarısız oldu.";
      return {
        failed: {
          urgency,
          title: "Yedekleme başarısız",
          body: [lead, urgent ? URGENT_NOTE : "", LOG_NOTE].filter(Boolean).join(" "),
          runId: s.runId,
          at: s.finishedAt ?? s.startedAt,
        },
        // A failure explains the missing backup: the failed item says more.
        stale: "none",
      };
    }
    if (s.result === "running") {
      if (now - s.startedAt <= BACKUP_STUCK_MS) return { failed: "hold", stale: "hold" };
      return {
        failed: {
          urgency,
          title: "Yedekleme takıldı",
          body: ["Yedekleme 2 saat 15 dakikadır bitmedi; görev durdurulmuş ya da takılmış olabilir.", urgent ? URGENT_NOTE : "", LOG_NOTE]
            .filter(Boolean)
            .join(" "),
          runId: s.runId,
          at: s.startedAt + BACKUP_STUCK_MS,
        },
        stale: "none",
      };
    }
    // ok: the last run succeeded; stale only if that success is old (PC off since).
    const last = s.lastSuccessAt ?? s.finishedAt ?? s.startedAt;
    if (now - last <= BACKUP_STALE_MS) return { failed: "none", stale: "none" };
    return {
      failed: "none",
      stale: {
        urgency,
        title: "Yedek alınmadı",
        body: [
          urgent ? URGENT_NOTE : "Son başarılı yedek 26 saatten eski.",
          "Zamanlanmış yedekleme görevi çalışmamış olabilir (bilgisayar kapalı mıydı?).",
        ].join(" "),
        runId: undefined,
        at: last + BACKUP_STALE_MS,
      },
    };
  }

  /** Brings one key to `want`; a failed store call leaves the state as it was (retried next round). */
  private async apply(key: string, want: Want): Promise<void> {
    if (want === "hold") return;
    const cur = this.open.get(key);
    if (want === "none") {
      if (!cur) return;
      try {
        await this.o.notifications.resolve(BACKUP_SOURCE, key);
      } catch {
        return; // inbox unreadable: still open, retried next round
      }
      this.open.delete(key);
      this.o.logger.info(`[shadow-core] backup producer: ${key} resolved`);
      return;
    }
    let renotify: boolean;
    if (!cur) {
      renotify = true;
    } else {
      const newRun =
        want.runId !== undefined &&
        (cur.runId !== undefined ? cur.runId !== want.runId : cur.updatedAt !== undefined && want.at > cur.updatedAt);
      const escalated = want.urgency === "urgent" && cur.urgency !== "urgent";
      renotify = newRun || escalated;
      const changed = cur.urgency !== want.urgency || cur.title !== want.title || cur.body !== want.body;
      if (!renotify && !changed) {
        cur.runId = want.runId; // an adopted item now belongs to this run
        cur.updatedAt = undefined;
        return;
      }
    }
    const r = await this.o.notifications.raise({
      source: BACKUP_SOURCE,
      key,
      urgency: want.urgency,
      title: want.title,
      body: want.body,
      renotify,
    });
    if (!r.ok) {
      if (r.reason !== "unavailable") this.o.logger.warn(`[shadow-core] backup producer: ${key} raise refused (${r.reason})`);
      return;
    }
    this.open.set(key, { urgency: want.urgency, title: want.title, body: want.body, runId: want.runId, updatedAt: undefined });
    this.o.logger.info(`[shadow-core] backup producer: ${key} raised (${want.urgency}${renotify ? ", renotify" : ""})`);
  }
}

function min(a: number | undefined, b: number): number {
  return a === undefined ? b : Math.min(a, b);
}
