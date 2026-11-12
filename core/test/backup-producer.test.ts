/**
 * T7.w.11.2: the backup notification producer (docs/09 (a)). Fixture status
 * files in a temp dir, a fake clock and a fake notification port that records
 * raise / resolve and keeps the items (for startup adoption).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  BACKUP_KEY_FAILED,
  BACKUP_KEY_STALE,
  BACKUP_STALE_MS,
  BACKUP_STUCK_MS,
  BACKUP_URGENT_MS,
  BackupProducer,
  backupStatusPath,
  parseBackupStatus,
  type BackupNotificationPort,
} from "../src/backup-producer.js";
import type { NotificationItem, RaiseInput, RaiseResult } from "../src/notifications.js";

const base = mkdtempSync(join(tmpdir(), "shadow-backup-producer-test-"));
after(() => rmSync(base, { recursive: true, force: true }));

const H = 3_600_000;
const T0 = Date.parse("2026-11-10T03:30:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

type Stored = Pick<NotificationItem, "source" | "key" | "urgency" | "title" | "body" | "createdAt" | "updatedAt">;

/** Records every call; keeps keyed items like the store does. */
class FakeCenter implements BackupNotificationPort {
  readonly raises: RaiseInput[] = [];
  readonly resolves: string[] = [];
  readonly items = new Map<string, Stored>();
  unavailable = false;
  constructor(private readonly clock: () => number) {}
  async raise(input: RaiseInput): Promise<RaiseResult> {
    if (this.unavailable) return { ok: false, reason: "unavailable" };
    this.raises.push(input);
    const k = `${input.source}|${input.key}`;
    const prev = this.items.get(k);
    const stamp = iso(this.clock());
    const item = {
      source: input.source,
      key: input.key,
      urgency: input.urgency ?? "normal",
      title: input.title,
      body: input.body ?? "",
      createdAt: prev?.createdAt ?? stamp,
      updatedAt: stamp,
    };
    this.items.set(k, item);
    return { ok: true, item: { ...item, id: "n-0", readAt: null, raised: 1 } as NotificationItem, created: !prev };
  }
  async resolve(source: string, key: string): Promise<boolean> {
    if (this.unavailable) throw new Error("unavailable");
    this.resolves.push(key);
    return this.items.delete(`${source}|${key}`);
  }
  async list(): Promise<Stored[]> {
    if (this.unavailable) throw new Error("unavailable");
    return [...this.items.values()];
  }
}

let n = 0;
function setup(o: { items?: Stored[] } = {}) {
  const dataDir = join(base, `d${++n}`);
  mkdirSync(join(dataDir, "backup"), { recursive: true });
  const file = backupStatusPath(dataDir);
  let now = T0;
  const center = new FakeCenter(() => now);
  for (const i of o.items ?? []) center.items.set(`${i.source}|${i.key}`, i);
  const warns: string[] = [];
  const producer = new BackupProducer({
    statusFile: file,
    notifications: center,
    logger: { info: () => {}, warn: (m) => warns.push(m) },
    now: () => now,
  });
  let mtime = 1_000_000;
  return {
    file,
    center,
    warns,
    producer,
    set: (ms: number) => {
      now = ms;
    },
    /** Writes the status; every write gets a new mtime so the mtime check sees it. */
    write(status: Record<string, unknown> | string) {
      writeFileSync(file, typeof status === "string" ? status : JSON.stringify({ version: 1, ...status }));
      mtime += 10;
      utimesSync(file, mtime, mtime);
    },
    check: () => producer.checkNow(),
  };
}

const ok = (runId: string, at: number) => ({ runId, startedAt: iso(at - 60_000), finishedAt: iso(at), result: "ok", lastSuccessAt: iso(at) });
const failed = (runId: string, at: number, lastSuccess: number | null, stage = "upload") => ({
  runId,
  startedAt: iso(at - 60_000),
  finishedAt: iso(at),
  result: "failed",
  stage,
  lastSuccessAt: lastSuccess === null ? null : iso(lastSuccess),
});
const running = (runId: string, at: number, lastSuccess: number | null) => ({
  runId,
  startedAt: iso(at),
  result: "running",
  lastSuccessAt: lastSuccess === null ? null : iso(lastSuccess),
});

test("missing file: no notification", async () => {
  const h = setup();
  await h.check();
  h.set(T0 + 100 * H);
  await h.check();
  assert.deepEqual(h.center.raises, []);
  assert.deepEqual(h.center.resolves, []);
  assert.deepEqual(h.warns, []);
});

test("running (not stuck): nothing raised", async () => {
  const h = setup();
  h.write(running("r1", T0, T0 - 24 * H));
  h.set(T0 + BACKUP_STUCK_MS);
  await h.check();
  assert.deepEqual(h.center.raises, []);
});

test("ok: nothing raised; ok after failed resolves backup:failed", async () => {
  const h = setup();
  h.write(ok("r1", T0));
  await h.check();
  assert.deepEqual(h.center.raises, []);
  h.write(failed("r2", T0 + 24 * H, T0));
  h.set(T0 + 24 * H);
  await h.check();
  assert.equal(h.center.raises.length, 1);
  h.write(ok("r3", T0 + 48 * H));
  h.set(T0 + 48 * H);
  await h.check();
  assert.deepEqual(h.center.resolves, [BACKUP_KEY_FAILED]);
  assert.equal(h.center.items.size, 0);
});

test("failed: backup:failed normal, stage in Turkish, no error text", async () => {
  const h = setup();
  h.write(failed("r1", T0, T0 - 24 * H, "upload"));
  await h.check();
  assert.equal(h.center.raises.length, 1);
  const r = h.center.raises[0]!;
  assert.equal(r.source, "backup");
  assert.equal(r.key, BACKUP_KEY_FAILED);
  assert.equal(r.urgency, "normal");
  assert.equal(r.title, "Yedekleme başarısız");
  assert.match(r.body ?? "", /yükleme aşamasında/);
  // Re-reads without change raise nothing more.
  h.set(T0 + 60_000);
  await h.check();
  assert.equal(h.center.raises.length, 1);
});

test("a new failed runId re-raises with renotify; the same runId does not", async () => {
  const h = setup();
  h.write(failed("r1", T0, T0 - 24 * H));
  await h.check();
  // Next day's run starts: running holds the item.
  h.write(running("r2", T0 + 24 * H, T0 - 24 * H));
  h.set(T0 + 24 * H);
  await h.check();
  assert.equal(h.center.raises.length, 1);
  // Same runId written again (e.g. a touch): no renotify, no raise.
  h.write(failed("r1", T0, T0 - 24 * H));
  await h.check();
  assert.equal(h.center.raises.length, 1);
  h.write(failed("r2", T0 + 24 * H + 60_000, T0 - 24 * H));
  h.set(T0 + 24 * H + 60_000);
  await h.check();
  assert.equal(h.center.raises.length, 2);
  assert.equal(h.center.raises[1]!.renotify, true);
});

test("running older than 2 h 15 min: backup:failed 'takıldı'; later failed for the same run does not renotify", async () => {
  const h = setup();
  h.write(running("r1", T0, T0 - 24 * H));
  h.set(T0 + BACKUP_STUCK_MS + 1);
  await h.check();
  assert.equal(h.center.raises.length, 1);
  assert.equal(h.center.raises[0]!.key, BACKUP_KEY_FAILED);
  assert.match(h.center.raises[0]!.title, /takıldı/);
  h.write(failed("r1", T0 + BACKUP_STUCK_MS + 2 * 60_000, T0 - 24 * H, "archive"));
  h.set(T0 + BACKUP_STUCK_MS + 3 * 60_000);
  await h.check();
  assert.equal(h.center.raises.length, 2);
  assert.equal(h.center.raises[1]!.renotify, false);
  assert.match(h.center.raises[1]!.body ?? "", /arşivleme/);
});

test("stale: 26 h boundary, ok after resolves", async () => {
  const h = setup();
  h.write(ok("r1", T0));
  h.set(T0 + BACKUP_STALE_MS);
  await h.check();
  assert.deepEqual(h.center.raises, []);
  h.set(T0 + BACKUP_STALE_MS + 1);
  await h.check();
  assert.equal(h.center.raises.length, 1);
  const r = h.center.raises[0]!;
  assert.equal(r.key, BACKUP_KEY_STALE);
  assert.equal(r.urgency, "normal");
  assert.equal(r.title, "Yedek alınmadı");
  h.set(T0 + BACKUP_STALE_MS + 10 * 60_000);
  await h.check();
  assert.equal(h.center.raises.length, 1);
  h.write(ok("r2", T0 + 27 * H));
  h.set(T0 + 27 * H);
  await h.check();
  assert.deepEqual(h.center.resolves, [BACKUP_KEY_STALE]);
});

test("a failure explains a missing backup: stale is resolved, failed shown", async () => {
  const h = setup();
  h.write(ok("r1", T0));
  h.set(T0 + 30 * H);
  await h.check();
  assert.equal(h.center.raises[0]!.key, BACKUP_KEY_STALE);
  h.write(failed("r2", T0 + 30 * H, T0));
  await h.check();
  assert.deepEqual(h.center.resolves, [BACKUP_KEY_STALE]);
  assert.equal(h.center.raises.at(-1)!.key, BACKUP_KEY_FAILED);
});

test("older than 72 h: the open item is re-raised urgent with renotify once", async () => {
  const h = setup();
  h.write(ok("r1", T0));
  h.set(T0 + 30 * H);
  await h.check();
  h.set(T0 + BACKUP_URGENT_MS);
  await h.check();
  assert.equal(h.center.raises.length, 1);
  h.set(T0 + BACKUP_URGENT_MS + 1);
  await h.check();
  assert.equal(h.center.raises.length, 2);
  assert.equal(h.center.raises[1]!.key, BACKUP_KEY_STALE);
  assert.equal(h.center.raises[1]!.urgency, "urgent");
  assert.equal(h.center.raises[1]!.renotify, true);
  for (let i = 1; i <= 5; i++) {
    h.set(T0 + BACKUP_URGENT_MS + i * 60_000);
    await h.check();
  }
  assert.equal(h.center.raises.length, 2);
});

test("failed for 3 days: backup:failed becomes urgent once", async () => {
  const h = setup();
  h.write(failed("r1", T0 + 70 * H, T0));
  h.set(T0 + 70 * H);
  await h.check();
  assert.equal(h.center.raises[0]!.urgency, "normal");
  h.set(T0 + BACKUP_URGENT_MS + 1);
  await h.check();
  h.set(T0 + BACKUP_URGENT_MS + 2 * 60_000);
  await h.check();
  assert.equal(h.center.raises.length, 2);
  assert.equal(h.center.raises[1]!.urgency, "urgent");
  assert.equal(h.center.raises[1]!.renotify, true);
});

test("never succeeded: failed covers it; urgency counts from the first known start", async () => {
  const h = setup();
  h.write(failed("r1", T0, null, "setup"));
  await h.check();
  assert.equal(h.center.raises.length, 1);
  assert.equal(h.center.raises[0]!.urgency, "normal");
  assert.match(h.center.raises[0]!.body ?? "", /hazırlık/);
  // Later failing runs: the reference stays at the first start seen.
  h.write(failed("r2", T0 + 24 * H, null));
  h.set(T0 + 24 * H);
  await h.check();
  h.write(failed("r3", T0 + 73 * H, null));
  h.set(T0 + 73 * H);
  await h.check();
  assert.equal(h.center.raises.at(-1)!.urgency, "urgent");
  assert.ok(!h.center.raises.some((r) => r.key === BACKUP_KEY_STALE));
});

test("invalid JSON: logged once, no item; a valid file afterwards works", async () => {
  const h = setup();
  h.write("{ not json");
  await h.check();
  h.set(T0 + 60_000);
  await h.check();
  h.write("{\"version\":2}");
  await h.check();
  assert.equal(h.warns.length, 1);
  assert.deepEqual(h.center.raises, []);
  h.write(failed("r1", T0, T0 - 24 * H));
  await h.check();
  assert.equal(h.center.raises.length, 1);
});

test("invalid file keeps open items; a missing file resolves them", async () => {
  const h = setup();
  h.write(failed("r1", T0, T0 - 24 * H));
  await h.check();
  h.write("garbage");
  await h.check();
  assert.deepEqual(h.center.resolves, []);
  unlinkSync(h.file);
  await h.check();
  assert.deepEqual(h.center.resolves, [BACKUP_KEY_FAILED]);
});

test("startup adoption: an existing item is resolved by recovery", async () => {
  const stamp = iso(T0 - 24 * H);
  const h = setup({
    items: [
      { source: "backup", key: BACKUP_KEY_FAILED, urgency: "normal", title: "Yedekleme başarısız", body: "x", createdAt: stamp, updatedAt: stamp },
      { source: "service", key: BACKUP_KEY_FAILED, urgency: "normal", title: "other", body: "", createdAt: stamp, updatedAt: stamp },
    ],
  });
  h.write(ok("r1", T0));
  await h.check();
  assert.deepEqual(h.center.raises, []);
  assert.deepEqual(h.center.resolves, [BACKUP_KEY_FAILED]);
  assert.equal(h.center.items.size, 1); // the other source's item stays
});

test("startup adoption: same failure is not renotified; a newer failed run is", async () => {
  const at = T0;
  const h = setup();
  h.write(failed("r1", at, at - 24 * H));
  await h.check();
  const stored = [...h.center.items.values()];
  // A restarted Core over the same inbox.
  const h2 = setup({ items: stored });
  h2.write(failed("r1", at, at - 24 * H));
  h2.set(at + H);
  await h2.check();
  assert.deepEqual(h2.center.raises, []);
  h2.write(failed("r2", at + 24 * H, at - 24 * H));
  h2.set(at + 24 * H);
  await h2.check();
  assert.equal(h2.center.raises.length, 1);
  assert.equal(h2.center.raises[0]!.renotify, true);

  // Adopted item older than the failed run in the file (it failed while the Core was down): renotify.
  const old = iso(at - 48 * H);
  const h3 = setup({
    items: [{ source: "backup", key: BACKUP_KEY_FAILED, urgency: "normal", title: "Yedekleme başarısız", body: "y", createdAt: old, updatedAt: old }],
  });
  h3.write(failed("r9", at, at - 72 * H + H));
  await h3.check();
  assert.equal(h3.center.raises.length, 1);
  assert.equal(h3.center.raises[0]!.renotify, true);
});

test("inbox unreadable: adoption and resolve are retried next round", async () => {
  const stamp = iso(T0 - H);
  const h = setup({
    items: [{ source: "backup", key: BACKUP_KEY_STALE, urgency: "normal", title: "Yedek alınmadı", body: "", createdAt: stamp, updatedAt: stamp }],
  });
  h.write(ok("r1", T0));
  h.center.unavailable = true;
  await h.check();
  await h.check();
  assert.equal(h.warns.length, 1);
  h.center.unavailable = false;
  await h.check();
  assert.deepEqual(h.center.resolves, [BACKUP_KEY_STALE]);
});

test("close stops the timer; start after close does nothing", async () => {
  const h = setup();
  await h.producer.close();
  h.producer.start();
  h.write(failed("r1", T0, T0));
  await h.check();
  assert.deepEqual(h.center.raises, []);
});

test("parseBackupStatus: BOM, ok without lastSuccessAt, bad timestamps", () => {
  const s = parseBackupStatus(String.fromCharCode(0xfeff) + JSON.stringify({ version: 1, runId: "a", startedAt: iso(T0), finishedAt: iso(T0 + 1000), result: "ok" }));
  assert.equal(s?.lastSuccessAt, T0 + 1000);
  assert.equal(parseBackupStatus(JSON.stringify({ version: 1, runId: "a", startedAt: "nope", result: "ok" })), undefined);
  assert.equal(parseBackupStatus(JSON.stringify({ version: 1, runId: "a", startedAt: iso(T0), result: "done" })), undefined);
  assert.equal(parseBackupStatus("[]"), undefined);
});
