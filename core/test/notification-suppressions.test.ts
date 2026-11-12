/**
 * T7.w.11.7: "Tekrar gösterme" (docs/09 *Dismiss options*). Real
 * NotificationStore + SuppressionStore in a temp dir, a NotificationCenter
 * with fake sockets, and the real producers wired like index.ts. Generic
 * names and texts only.
 *
 * - the suppression persists across a restart (new instances, same dir) and
 *   blocks raise (no item, no broadcast, no speech, no pending speech);
 * - resolve removes the record, so the next raise is shown;
 * - plain delete ("Gördüm") records nothing;
 * - producers adopt suppressed keys at startup and clear them on recovery; an
 *   unreadable suppression file does not stop them (keys adopted once readable);
 * - the suppression file: corrupt → quarantined and empty, unreadable → empty
 *   and never overwritten, changes applied once it can be read;
 * - the `notification_action` frame accepts `suppress` and rejects the rest.
 */
import assert from "node:assert/strict";
import * as nodeFs from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AtomicFs } from "../src/atomic-file.js";
import { BACKUP_KEY_FAILED, BACKUP_KEY_STALE, BACKUP_SOURCE, BackupProducer, backupStatusPath } from "../src/backup-producer.js";
import { SUPPRESSIONS_FILE, SuppressionStore } from "../src/notification-suppressions.js";
import { NOTIFICATIONS_DIR, NotificationStore } from "../src/notifications.js";
import { parseClientFrame, type ServerFrame, type ServiceHealth } from "../src/protocol.js";
import { SERVICE_SOURCE, ServiceProducer, type ProducerTimers } from "../src/service-producer.js";
import { NotificationCenter, type NotificationListener } from "../src/session.js";

const base = mkdtempSync(join(tmpdir(), "shadow-suppressions-test-"));
after(() => rmSync(base, { recursive: true, force: true }));
let counter = 0;
const newDataDir = () => join(base, `d${++counter}`);

/** File system whose reads of the suppression file fail while `locked.on` (EBUSY). */
function lockableFs(locked: { on: boolean }): AtomicFs {
  return {
    mkdir: (p, o) => nodeFs.mkdir(p, o),
    open: (p, f, m) => nodeFs.open(p, f, m),
    rename: (a, b) => nodeFs.rename(a, b),
    unlink: (p) => nodeFs.unlink(p),
    readFile: (p, e) => (locked.on ? Promise.reject(Object.assign(new Error("locked"), { code: "EBUSY" })) : nodeFs.readFile(p, e)),
    readdir: (p) => nodeFs.readdir(p),
  };
}

/** One Core "run" on `dataDir`: store, suppressions and center as index.ts builds them. */
function core(dataDir: string, o: { fs?: AtomicFs } = {}) {
  const dir = join(dataDir, NOTIFICATIONS_DIR);
  const logs: string[] = [];
  const store = new NotificationStore({ dir, log: (m) => logs.push(m), coalesceMs: 0 });
  const suppressions = new SuppressionStore({ dir, log: (m) => logs.push(m), ...(o.fs ? { fs: o.fs, retryDelaysMs: [] } : {}) });
  const center = new NotificationCenter({
    store,
    suppressions,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  });
  return { dir, store, suppressions, center, logs };
}

function socket(o: { speaks?: boolean } = {}) {
  const frames: ServerFrame[] = [];
  const l: NotificationListener = {
    sessionId: `s${++counter}`,
    device: "browser",
    speaks: () => o.speaks ?? false,
    deliver: (f) => frames.push(f),
  };
  return { l, frames };
}

const RAISE = { source: "test", key: "k1", title: "Başlık", body: "Gövde" } as const;

test("suppress: deletes on every socket, persists across a restart and blocks raise until resolve", async () => {
  const dataDir = newDataDir();
  const a = core(dataDir);
  const s1 = socket();
  const s2 = socket();
  a.center.attach(s1.l);
  a.center.attach(s2.l);
  const r = await a.center.raise(RAISE);
  assert.ok(r.ok);
  const id = r.item.id;

  assert.deepEqual(await a.center.act("browser", id, "suppress"), { ok: true });
  for (const s of [s1, s2]) assert.deepEqual(s.frames.at(-1), { type: "notification_removed", notificationId: id });
  assert.deepEqual((await a.center.list()).items, []);
  // Only source + key + time on disk: no title or body.
  const onDisk = JSON.parse(readFileSync(join(a.dir, SUPPRESSIONS_FILE), "utf8"));
  assert.equal(onDisk.version, 1);
  assert.deepEqual(onDisk.items.map((i: Record<string, unknown>) => Object.keys(i).sort()), [["at", "key", "source"]]);
  assert.equal(JSON.stringify(onDisk).includes("Başlık"), false);
  // An unknown id stays unknown.
  assert.equal((await a.center.act("browser", id, "suppress")).ok, false);

  // Restart: new instances on the same dir.
  const b = core(dataDir);
  const s3 = socket();
  b.center.attach(s3.l);
  assert.deepEqual(await b.center.raise({ ...RAISE, renotify: true }), { ok: false, reason: "suppressed" });
  assert.deepEqual(s3.frames, []);
  assert.deepEqual((await b.center.list()).items, []);
  assert.deepEqual(await b.center.suppressed("test"), [{ source: "test", key: "k1" }]);
  assert.deepEqual(await b.center.suppressed("other"), []);
  // Another key of the same source is not affected.
  assert.ok((await b.center.raise({ ...RAISE, key: "k2" })).ok);

  // The condition ends: the record goes, the next occurrence is shown.
  assert.equal(await b.center.resolve("test", "k1"), false);
  assert.deepEqual(await b.center.suppressed(), []);
  const again = await b.center.raise(RAISE);
  assert.ok(again.ok && again.created);
  const c = core(dataDir);
  assert.deepEqual(await c.center.suppressed(), []);
});

test("delete (Gördüm) records nothing: the key is raised again after a restart", async () => {
  const dataDir = newDataDir();
  const a = core(dataDir);
  const r = await a.center.raise(RAISE);
  assert.ok(r.ok);
  assert.deepEqual(await a.center.act("browser", r.item.id, "delete"), { ok: true });
  assert.equal(existsSync(join(a.dir, SUPPRESSIONS_FILE)), false);
  const b = core(dataDir);
  const again = await b.center.raise(RAISE);
  assert.ok(again.ok && again.created);
});

test("suppress of a keyless item only deletes it", async () => {
  const a = core(newDataDir());
  const r = await a.center.raise({ source: "test", title: "Tek seferlik" });
  assert.ok(r.ok);
  assert.deepEqual(await a.center.act("browser", r.item.id, "suppress"), { ok: true });
  assert.deepEqual((await a.center.list()).items, []);
  assert.deepEqual(await a.center.suppressed(), []);
});

test("suppressed urgent: not spoken, not pending; suppressing a pending item cancels its speech", async () => {
  const a = core(newDataDir());
  // Pending (no speaker), then suppressed: a later speech-on speaks nothing.
  const r = await a.center.raise({ ...RAISE, urgency: "urgent" });
  assert.ok(r.ok);
  await a.center.act("browser", r.item.id, "suppress");
  const speaker = socket({ speaks: true });
  a.center.attach(speaker.l);
  await a.center.speechOn(speaker.l);
  assert.deepEqual(speaker.frames.filter((f) => f.type === "notification"), []);
  // A suppressed urgent raise with a speaker present: nothing delivered at all.
  assert.deepEqual(await a.center.raise({ ...RAISE, urgency: "urgent", renotify: true }), { ok: false, reason: "suppressed" });
  assert.deepEqual(speaker.frames.filter((f) => f.type === "notification"), []);
  // ... and with no speaker it is not pending either.
  const late = socket({ speaks: true });
  const b = core(newDataDir());
  const r2 = await b.center.raise({ ...RAISE, urgency: "urgent" });
  assert.ok(r2.ok);
  await b.center.act("browser", r2.item.id, "suppress");
  assert.deepEqual(await b.center.raise({ ...RAISE, urgency: "urgent", renotify: true }), { ok: false, reason: "suppressed" });
  b.center.attach(late.l);
  await b.center.speechOn(late.l);
  assert.deepEqual(late.frames, []);
});

test("an unreadable inbox: suppress answers unavailable and records nothing", async () => {
  const dataDir = newDataDir();
  const a = core(dataDir);
  const r = await a.center.raise(RAISE);
  assert.ok(r.ok);
  // A second Core on a file that is a directory now: the store cannot read it.
  const b = core(dataDir);
  rmSync(join(b.dir, "notifications.json"));
  mkdirSync(join(b.dir, "notifications.json"));
  await assert.rejects(b.center.act("browser", r.item.id, "suppress"));
  assert.deepEqual(await b.center.suppressed(), []);
  b.center.close();
});

test("pending speech: a socket that goes away during the suppression check uses nothing up", async () => {
  const dataDir = newDataDir();
  const dir = join(dataDir, NOTIFICATIONS_DIR);
  const store = new NotificationStore({ dir, log: () => {}, coalesceMs: 0 });
  let release: (() => void) | undefined;
  let slow = false;
  const center = new NotificationCenter({
    store,
    logger: { info: () => {}, warn: () => {} },
    suppressions: {
      has: () => (slow ? new Promise<boolean>((r) => (release = () => r(false))) : Promise.resolve(false)),
      add: async () => true,
      remove: async () => false,
      list: async () => [],
      flush: async () => {},
    },
  });
  assert.ok((await center.raise({ ...RAISE, urgency: "urgent" })).ok); // no speaker: pending
  let speaking = true;
  const first = socket();
  const l1: NotificationListener = { ...first.l, speaks: () => speaking };
  center.attach(l1);
  slow = true;
  const done = center.speechOn(l1);
  while (!release) await new Promise((r) => setImmediate(r));
  speaking = false; // turned off while the check was pending
  release();
  await done;
  assert.deepEqual(first.frames, []);
  slow = false;
  const second = socket({ speaks: true });
  center.attach(second.l);
  await center.speechOn(second.l);
  assert.equal(second.frames.filter((f) => f.type === "notification" && f.speak === true).length, 1);
});

// ------------------------------------------------------------ suppression file

test("suppression file: corrupt → moved aside and empty; invalid pairs refused", async () => {
  const dir = join(newDataDir(), NOTIFICATIONS_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SUPPRESSIONS_FILE), "{ not json");
  const logs: string[] = [];
  const s = new SuppressionStore({ dir, log: (m) => logs.push(m) });
  assert.deepEqual(await s.list(), []);
  assert.ok(readdirSync(dir).some((n) => n.startsWith(`${SUPPRESSIONS_FILE}.corrupt-`)));
  assert.equal(logs.length, 1);
  assert.equal(await s.add("Bad Source", "k"), false);
  assert.equal(await s.add("test", ""), false);
  assert.equal(await s.add("test", "x".repeat(129)), false);
  assert.equal(await s.add("test", "k"), true);
  assert.equal(await s.add("test", "k"), true); // idempotent
  assert.equal((await s.list()).length, 1);
});

test("suppression file: unreadable → empty, never overwritten, changes applied once readable", async () => {
  const dir = join(newDataDir(), NOTIFICATIONS_DIR);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, SUPPRESSIONS_FILE);
  const at = "2026-11-10T00:00:00.000Z";
  writeFileSync(file, JSON.stringify({ version: 1, items: [{ source: "test", key: "old", at }, { source: "test", key: "gone", at }] }));
  let locked = true;
  let writes = 0;
  const fs: AtomicFs = {
    mkdir: (p, o) => nodeFs.mkdir(p, o),
    open: (p, f, m) => {
      writes++;
      return nodeFs.open(p, f, m);
    },
    rename: (a, b) => nodeFs.rename(a, b),
    unlink: (p) => nodeFs.unlink(p),
    readFile: (p, e) => (locked ? Promise.reject(Object.assign(new Error("locked"), { code: "EBUSY" })) : nodeFs.readFile(p, e)),
    readdir: (p) => nodeFs.readdir(p),
  };
  const logs: string[] = [];
  const s = new SuppressionStore({ dir, fs, retryDelaysMs: [], log: (m) => logs.push(m) });
  assert.equal(await s.has("test", "old"), false); // behaves as empty
  assert.equal(await s.add("test", "new"), true);
  assert.equal(await s.has("test", "new"), true);
  assert.equal(await s.remove("test", "gone"), false); // not known yet, but the removal is kept
  await assert.rejects(s.list(), (e: Error) => e.name === "SuppressionsUnavailableError");
  assert.equal(writes, 0);
  assert.equal(logs.filter((m) => m.includes("could not be read")).length, 1);
  locked = false;
  // Readable again: the file's records plus the changes made meanwhile (an add, a removal), written.
  assert.deepEqual((await s.list()).map((r) => r.key).sort(), ["new", "old"]);
  assert.ok(writes > 0);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).items.map((r: { key: string }) => r.key).sort(), ["new", "old"]);
});

// ------------------------------------------------------------ producers (startup adoption)

const T0 = Date.parse("2026-11-10T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

class ManualTimers implements ProducerTimers {
  set(): unknown {
    return 1;
  }
  clear(): void {}
}

function serviceProducer(c: ReturnType<typeof core>, clock: () => number, logs: string[] = []) {
  let current: ServiceHealth[] | undefined;
  const listeners = new Set<(items: ServiceHealth[]) => void>();
  const producer = new ServiceProducer({
    monitor: {
      snapshot: () => current,
      subscribe: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
    notifications: {
      raise: (input) => c.center.raise(input),
      resolve: (source, key) => c.center.resolve(source, key),
      list: () => c.store.list(),
      suppressed: () => c.center.suppressed(),
    },
    logger: { info: () => {}, warn: (m) => logs.push(m) },
    now: clock,
    timers: new ManualTimers(),
  });
  /** One monitor round: Home Assistant at `status`, plus `others` (name → status); the rest missing. */
  const round = (status: ServiceHealth["status"], others: Record<string, ServiceHealth["status"]> = {}) => {
    current = [
      { name: "home-assistant", status, checkedAt: clock() },
      ...Object.entries(others).map(([name, s]) => ({ name, status: s, checkedAt: clock() })),
    ];
    for (const l of [...listeners]) l(current);
  };
  return { producer, round };
}

test("service producer: a suppressed outage is not shown, and its recovery after a restart clears the record", async () => {
  const dataDir = newDataDir();
  let now = T0;
  const clock = () => now;
  // Run 1: HA down 90 s → item; the user suppresses it.
  const a = core(dataDir);
  const p1 = serviceProducer(a, clock);
  p1.producer.start();
  p1.round("down");
  await p1.producer.idle();
  now += 90_000;
  await p1.producer.checkNow();
  const items = await a.store.list();
  assert.equal(items.length, 1);
  await a.center.act("browser", items[0]!.id, "suppress");
  // Still down past 30 min: the urgent escalation is suppressed too.
  now += 30 * 60_000;
  await p1.producer.checkNow();
  assert.deepEqual(await a.store.list(), []);
  await p1.producer.close();

  // Run 2 (Core restarted, HA still down): adopted as open, nothing shown.
  const b = core(dataDir);
  const p2 = serviceProducer(b, clock);
  p2.producer.start();
  p2.round("down");
  await p2.producer.idle();
  now += 120_000;
  await p2.producer.checkNow();
  assert.deepEqual(await b.store.list(), []);
  assert.deepEqual(await b.center.suppressed(SERVICE_SOURCE), [{ source: SERVICE_SOURCE, key: "service:home-assistant" }]);
  await p2.producer.close();

  // Run 3 (HA came back while the Core was down): the adopted key resolves after 60 s ok.
  const c = core(dataDir);
  const p3 = serviceProducer(c, clock);
  p3.producer.start();
  p3.round("ok");
  await p3.producer.idle();
  now += 60_000;
  await p3.producer.checkNow();
  assert.deepEqual(await c.center.suppressed(), []);
  // A new outage is shown again.
  p3.round("down");
  await p3.producer.idle();
  now += 90_000;
  await p3.producer.checkNow();
  assert.equal((await c.store.list()).length, 1);
  await p3.producer.close();
});

test("service producer: an unreadable suppression file at startup delays adoption instead of losing the record", async () => {
  const dataDir = newDataDir();
  let now = T0;
  const clock = () => now;
  const a = core(dataDir);
  assert.ok((await a.center.raise({ source: SERVICE_SOURCE, key: "service:home-assistant", title: "Kesinti" })).ok);
  const [item] = await a.store.list();
  await a.center.act("browser", item!.id, "suppress");

  // Restart with the suppression file locked; HA is ok meanwhile.
  const locked = { on: true };
  const b = core(dataDir, { fs: lockableFs(locked) });
  const p = serviceProducer(b, clock);
  p.producer.start();
  p.round("ok");
  await p.producer.idle();
  now += 60_000;
  await p.producer.checkNow();
  locked.on = false;
  now += 60_000;
  await p.producer.checkNow(); // adoption retried: the suppressed key is open and ok long enough
  now += 60_000;
  await p.producer.checkNow();
  assert.deepEqual(await b.center.suppressed(), []);
  await p.producer.close();
});

test("service producer: a suppression file that stays unreadable does not stop raising; its keys are adopted once readable", async () => {
  const dataDir = newDataDir();
  let now = T0;
  const clock = () => now;
  const a = core(dataDir);
  assert.ok((await a.center.raise({ source: SERVICE_SOURCE, key: "service:whisper-svc", title: "Kesinti" })).ok);
  const [item] = await a.store.list();
  await a.center.act("browser", item!.id, "suppress");

  // Restart with the suppression file locked: HA goes down, whisper (suppressed) is ok.
  const locked = { on: true };
  const b = core(dataDir, { fs: lockableFs(locked) });
  const logs: string[] = [];
  const p = serviceProducer(b, clock, logs);
  p.producer.start();
  p.round("down", { "whisper-svc": "ok" });
  await p.producer.idle();
  now += 90_000;
  await p.producer.checkNow();
  // The inbox is readable, so the producer runs: the HA outage is raised.
  assert.deepEqual((await b.store.list()).map((i) => i.key), ["service:home-assistant"]);
  now += 120_000;
  await p.producer.checkNow(); // still locked: re-read, still running, logged once
  const suppressionLogs = logs.filter((m) => m.includes("suppression list (suppressed.json) unreadable"));
  assert.equal(suppressionLogs.length, 1);
  assert.equal(logs.some((m) => m.includes("notifications unreadable")), false);

  // Readable again: the suppressed whisper key is adopted as open and, ok long enough, resolved.
  locked.on = false;
  now += 60_000;
  await p.producer.checkNow();
  assert.deepEqual(await b.center.suppressed(), []);
  assert.deepEqual((await b.store.list()).map((i) => i.key), ["service:home-assistant"]);
  await p.producer.close();
});

test("backup producer: a suppression file that stays unreadable does not stop raising; its keys are adopted once readable", async () => {
  const dataDir = newDataDir();
  mkdirSync(join(dataDir, "backup"), { recursive: true });
  const file = backupStatusPath(dataDir);
  const a = core(dataDir);
  assert.ok((await a.center.raise({ source: BACKUP_SOURCE, key: BACKUP_KEY_FAILED, title: "Yedekleme başarısız" })).ok);
  const [item] = await a.store.list();
  await a.center.act("browser", item!.id, "suppress");

  // The last run succeeded 27 h ago: the failure is over, the backup is stale.
  const last = T0 - 27 * 3_600_000;
  writeFileSync(file, JSON.stringify({ version: 1, runId: "r2", startedAt: iso(last - 60_000), finishedAt: iso(last), result: "ok", lastSuccessAt: iso(last) }));
  const locked = { on: true };
  const b = core(dataDir, { fs: lockableFs(locked) });
  const logs: string[] = [];
  const producer = new BackupProducer({
    statusFile: file,
    notifications: {
      raise: (input) => b.center.raise(input),
      resolve: (source, key) => b.center.resolve(source, key),
      list: () => b.store.list(),
      suppressed: () => b.center.suppressed(),
    },
    logger: { info: () => {}, warn: (m) => logs.push(m) },
    now: () => T0,
  });
  await producer.checkNow();
  // The inbox is readable, so the round runs: the stale item is raised.
  assert.deepEqual((await b.store.list()).map((i) => i.key), [BACKUP_KEY_STALE]);
  await producer.checkNow(); // still locked: logged once
  assert.equal(logs.filter((m) => m.includes("suppression list (suppressed.json) unreadable")).length, 1);
  assert.equal(logs.some((m) => m.includes("notifications unreadable")), false);

  // Readable again: the suppressed failed key is adopted as open and resolved (the failure is over).
  locked.on = false;
  await producer.checkNow();
  assert.deepEqual(await b.center.suppressed(), []);
  assert.deepEqual((await b.store.list()).map((i) => i.key), [BACKUP_KEY_STALE]);
  await producer.close();
});

test("backup producer: a suppressed failure ending while the Core was down clears the record", async () => {
  const dataDir = newDataDir();
  mkdirSync(join(dataDir, "backup"), { recursive: true });
  const file = backupStatusPath(dataDir);
  let mtime = 1_000_000;
  const write = (status: Record<string, unknown>) => {
    writeFileSync(file, JSON.stringify({ version: 1, ...status }));
    mtime += 10;
    utimesSync(file, mtime, mtime);
  };
  const producer = (c: ReturnType<typeof core>) =>
    new BackupProducer({
      statusFile: file,
      notifications: {
        raise: (input) => c.center.raise(input),
        resolve: (source, key) => c.center.resolve(source, key),
        list: () => c.store.list(),
        suppressed: () => c.center.suppressed(),
      },
      logger: { info: () => {}, warn: () => {} },
      now: () => T0,
    });
  write({ runId: "r1", startedAt: iso(T0 - 120_000), finishedAt: iso(T0 - 60_000), result: "failed", stage: "upload", lastSuccessAt: iso(T0 - 3_600_000) });
  const a = core(dataDir);
  await producer(a).checkNow();
  const [item] = await a.store.list();
  assert.ok(item);
  await a.center.act("browser", item.id, "suppress");
  // Still failing on the next round: not shown again, no warning loop.
  const a2 = producer(a);
  await a2.checkNow();
  assert.deepEqual(await a.store.list(), []);

  // Restart after a successful run: the adopted suppressed key is resolved.
  write({ runId: "r2", startedAt: iso(T0 - 30_000), finishedAt: iso(T0 - 10_000), result: "ok", lastSuccessAt: iso(T0 - 10_000) });
  const b = core(dataDir);
  assert.deepEqual(await b.center.suppressed(BACKUP_SOURCE), [{ source: BACKUP_SOURCE, key: BACKUP_KEY_FAILED }]);
  await producer(b).checkNow();
  assert.deepEqual(await b.center.suppressed(), []);
});

// ------------------------------------------------------------ protocol

test("notification_action: `suppress` parses; unknown or malformed actions are rejected", () => {
  const ok = parseClientFrame(JSON.stringify({ type: "notification_action", id: "q1", notificationId: "n-0123456789abcdef", action: "suppress" }));
  assert.deepEqual(ok, { ok: true, frame: { type: "notification_action", id: "q1", notificationId: "n-0123456789abcdef", action: "suppress" } });
  // Old actions unchanged.
  for (const action of ["read", "unread", "delete"]) {
    assert.equal(parseClientFrame(JSON.stringify({ type: "notification_action", id: "q1", notificationId: "n-1", action })).ok, true);
  }
  for (const action of ["Suppress", "suppress ", "", 1, null, ["suppress"], { a: 1 }, "__proto__"]) {
    const r = parseClientFrame(JSON.stringify({ type: "notification_action", id: "q1", notificationId: "n-1", action }));
    assert.equal(r.ok, false, `action ${JSON.stringify(action)}`);
  }
  assert.equal(parseClientFrame(JSON.stringify({ type: "notification_action", id: "q1", action: "suppress" })).ok, false);
  assert.equal(parseClientFrame(JSON.stringify({ type: "notification_suppress", id: "q1", notificationId: "n-1" })).ok, false);
});
