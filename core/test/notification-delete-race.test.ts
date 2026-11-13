/**
 * T20.2: the delete race of the notification producers (docs/09 *Common rules*).
 * Real NotificationStore + SuppressionStore in a temp dir, a NotificationCenter
 * with a fake socket that has speech on, and the real service / backup
 * producers wired like index.ts. Generic names and texts only.
 *
 * The race: the producer last saw the item, then the user deletes it, then the
 * producer's text update reaches the store. The port wrapper below runs the
 * user's action right before the update is handed to the center, i.e. after
 * every check the producer could make. Before T20.2 the update recreated the
 * item (and an urgent one was spoken); now the store answers `missing`.
 *
 * - a text update after the delete recreates nothing, broadcasts nothing,
 *   speaks nothing and leaves no pending speech;
 * - a new condition (new outage / new failed run / urgent escalation) still
 *   creates the item and an urgent one is still spoken;
 * - "Gördüm": the condition persisting across a Core restart brings the item
 *   back once (unchanged behavior);
 * - "Tekrar gösterme" in the same window: suppressed, nothing shown, and the
 *   recovery clears the record (unchanged behavior).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { BACKUP_KEY_FAILED, BACKUP_SOURCE, BACKUP_STUCK_MS, BackupProducer, backupStatusPath } from "../src/backup-producer.js";
import { SuppressionStore } from "../src/notification-suppressions.js";
import { NOTIFICATIONS_DIR, NotificationStore, type RaiseInput, type RaiseResult } from "../src/notifications.js";
import type { ServerFrame, ServiceHealth } from "../src/protocol.js";
import { SERVICE_SOURCE, SERVICE_URGENT_MS, ServiceProducer, type ProducerTimers } from "../src/service-producer.js";
import { NotificationCenter, type NotificationListener } from "../src/session.js";

const base = mkdtempSync(join(tmpdir(), "shadow-delete-race-test-"));
after(() => rmSync(base, { recursive: true, force: true }));
let counter = 0;
const newDataDir = () => join(base, `d${++counter}`);

const H = 3_600_000;
const T0 = Date.parse("2026-11-10T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const HA_KEY = "service:home-assistant";

/** One Core "run" on `dataDir`: store, suppressions and center as index.ts builds them, plus one socket with speech on. */
function core(dataDir: string) {
  const dir = join(dataDir, NOTIFICATIONS_DIR);
  const logs: string[] = [];
  const store = new NotificationStore({ dir, log: (m) => logs.push(m), coalesceMs: 0 });
  const suppressions = new SuppressionStore({ dir, log: (m) => logs.push(m) });
  const center = new NotificationCenter({ store, suppressions, logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } });
  const frames: ServerFrame[] = [];
  const socket: NotificationListener = { sessionId: `s${++counter}`, device: "phone", speaks: () => true, deliver: (f) => frames.push(f) };
  center.attach(socket);
  /** Runs once, right before the next raise reaches the center (the user acts after the producer's last look). */
  let beforeNextRaise: (() => Promise<unknown>) | undefined;
  const raises: Array<{ input: RaiseInput; result: RaiseResult }> = [];
  const port = {
    raise: async (input: RaiseInput) => {
      const act = beforeNextRaise;
      beforeNextRaise = undefined;
      await act?.();
      const result = await center.raise(input);
      raises.push({ input, result });
      return result;
    },
    resolve: (source: string, key: string) => center.resolve(source, key),
    list: () => store.list(),
    suppressed: () => center.suppressed(),
  };
  const notificationFrames = () => frames.filter((f) => f.type === "notification") as Array<Extract<ServerFrame, { type: "notification" }>>;
  return {
    store,
    center,
    logs,
    frames,
    raises,
    port,
    notificationFrames,
    spoken: () => notificationFrames().filter((f) => f.speak === true),
    /** The user's action on the only item of `key`, run right before the next raise. */
    userActsBeforeNextRaise: (key: string, action: "delete" | "suppress") => {
      beforeNextRaise = async () => {
        const item = (await store.list()).find((i) => i.key === key);
        assert.ok(item, `no item ${key} to ${action}`);
        assert.deepEqual(await center.act("phone", item.id, action), { ok: true });
      };
    },
  };
}

class ManualTimers implements ProducerTimers {
  set(): unknown {
    return 1;
  }
  clear(): void {}
}

function serviceProducer(c: ReturnType<typeof core>, clock: () => number) {
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
    notifications: c.port,
    logger: { info: (m) => c.logs.push(m), warn: (m) => c.logs.push(m) },
    now: clock,
    timers: new ManualTimers(),
  });
  /** One monitor round: Home Assistant at `status` (with `detail`). */
  const round = async (status: ServiceHealth["status"], detail?: string) => {
    current = [{ name: "home-assistant", status, checkedAt: clock(), ...(detail ? { detail } : {}) }];
    for (const l of [...listeners]) l(current);
    await producer.idle();
  };
  return { producer, round };
}

test("service: an urgent item deleted right before a text update is not recreated and not spoken", async () => {
  let now = T0;
  const clock = () => now;
  const c = core(newDataDir());
  const p = serviceProducer(c, clock);
  p.producer.start();
  await p.round("down", "timeout");
  now += SERVICE_URGENT_MS;
  await p.producer.checkNow(); // 90 s passed long ago: raised; 30 min down: urgent at once
  const [item] = await c.store.list();
  assert.equal(item?.urgency, "urgent");
  assert.equal(c.spoken().length, 1, "a new urgent item is spoken once");
  const framesBefore = c.notificationFrames().length;

  // The detail changes (a text update); the user deletes the item just before it reaches the store.
  c.userActsBeforeNextRaise(HA_KEY, "delete");
  now += 60_000;
  await p.round("down", "unreachable");
  assert.equal(c.raises.at(-1)!.input.onlyIfExists, true);
  assert.deepEqual(c.raises.at(-1)!.result, { ok: false, reason: "missing" });
  assert.deepEqual(await c.store.list(), []);
  assert.equal(c.notificationFrames().length, framesBefore, "nothing broadcast");
  assert.equal(c.spoken().length, 1, "nothing spoken");
  assert.equal(c.frames.at(-1)!.type, "notification_removed");
  // No pending speech either: a socket turning speech on speaks nothing.
  const late: ServerFrame[] = [];
  const lateSocket: NotificationListener = { sessionId: "late", device: "tablet", speaks: () => true, deliver: (f) => late.push(f) };
  const detach = c.center.attach(lateSocket);
  await c.center.speechOn(lateSocket);
  assert.deepEqual(late.filter((f) => f.type === "notification"), []);
  detach();

  // Further detail changes do not try again; recovery resolves; a new outage is a new item (spoken when urgent).
  const tries = c.raises.length;
  now += 60_000;
  await p.round("down", "timeout");
  assert.equal(c.raises.length, tries);
  await p.round("ok");
  now += 60_000;
  await p.producer.checkNow();
  await p.round("down");
  now += 90_000;
  await p.producer.checkNow();
  const fresh = await c.store.list();
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]!.urgency, "normal");
  const last = c.raises.at(-1)!.result;
  assert.ok(last.ok && last.created);
  // 30 min later the escalation (a new urgent condition) is spoken again.
  now += SERVICE_URGENT_MS;
  await p.producer.checkNow();
  assert.equal((await c.store.list())[0]!.urgency, "urgent");
  assert.equal(c.spoken().length, 2);
  await p.producer.close();
});

test("service: 'Tekrar gösterme' right before a text update: suppressed, nothing shown; recovery clears the record", async () => {
  let now = T0;
  const clock = () => now;
  const c = core(newDataDir());
  const p = serviceProducer(c, clock);
  p.producer.start();
  await p.round("down", "timeout");
  now += 90_000;
  await p.producer.checkNow();
  assert.equal((await c.store.list()).length, 1);

  c.userActsBeforeNextRaise(HA_KEY, "suppress");
  now += 60_000;
  await p.round("down", "unreachable");
  assert.deepEqual(c.raises.at(-1)!.result, { ok: false, reason: "suppressed" });
  assert.deepEqual(await c.store.list(), []);
  assert.deepEqual(await c.center.suppressed(SERVICE_SOURCE), [{ source: SERVICE_SOURCE, key: HA_KEY }]);
  // Escalation is suppressed too.
  now += SERVICE_URGENT_MS;
  await p.producer.checkNow();
  assert.deepEqual(await c.store.list(), []);
  assert.equal(c.spoken().length, 0);
  // Recovery resolves the key, which removes the record.
  await p.round("ok");
  now += 60_000;
  await p.producer.checkNow();
  assert.deepEqual(await c.center.suppressed(), []);
  await p.producer.close();
});

function backupSetup() {
  const dataDir = newDataDir();
  mkdirSync(join(dataDir, "backup"), { recursive: true });
  const file = backupStatusPath(dataDir);
  let mtime = 1_000_000;
  const write = (status: Record<string, unknown>) => {
    writeFileSync(file, JSON.stringify({ version: 1, ...status }));
    mtime += 10;
    utimesSync(file, mtime, mtime);
  };
  const producer = (c: ReturnType<typeof core>, clock: () => number) =>
    new BackupProducer({ statusFile: file, notifications: c.port, logger: { info: (m) => c.logs.push(m), warn: (m) => c.logs.push(m) }, now: clock });
  return { dataDir, write, producer };
}

test("backup: an urgent item deleted right before a text update is not recreated and not spoken; a new run is", async () => {
  const b = backupSetup();
  let now = T0;
  const clock = () => now;
  const c = core(b.dataDir);
  const producer = b.producer(c, clock);
  // A stuck run with no success for more than 72 h: urgent "takıldı", spoken once.
  const lastSuccess = T0 - 80 * H;
  b.write({ runId: "r1", startedAt: iso(T0), result: "running", lastSuccessAt: iso(lastSuccess) });
  now = T0 + BACKUP_STUCK_MS + 1;
  await producer.checkNow();
  const [item] = await c.store.list();
  assert.equal(item?.urgency, "urgent");
  assert.equal(c.spoken().length, 1);
  const framesBefore = c.notificationFrames().length;

  // The same run then fails (a text update); the user deletes the item just before it reaches the store.
  b.write({ runId: "r1", startedAt: iso(T0), finishedAt: iso(now + 60_000), result: "failed", stage: "upload", lastSuccessAt: iso(lastSuccess) });
  now += 120_000;
  c.userActsBeforeNextRaise(BACKUP_KEY_FAILED, "delete");
  await producer.checkNow();
  assert.equal(c.raises.at(-1)!.input.onlyIfExists, true);
  assert.deepEqual(c.raises.at(-1)!.result, { ok: false, reason: "missing" });
  assert.deepEqual(await c.store.list(), []);
  assert.equal(c.notificationFrames().length, framesBefore);
  assert.equal(c.spoken().length, 1);
  // Next round: same text, nothing tried.
  const tries = c.raises.length;
  now += 60_000;
  await producer.checkNow();
  assert.equal(c.raises.length, tries);

  // A new failed run is a new condition: created again and, still urgent, spoken.
  b.write({ runId: "r2", startedAt: iso(now), finishedAt: iso(now + 60_000), result: "failed", stage: "archive", lastSuccessAt: iso(lastSuccess) });
  now += 120_000;
  await producer.checkNow();
  const again = await c.store.list();
  assert.equal(again.length, 1);
  assert.equal(again[0]!.urgency, "urgent");
  assert.equal(c.spoken().length, 2);
  await producer.close();
});

test("backup: 'Gördüm' then a Core restart with the failure persisting brings the item back once (unchanged)", async () => {
  const b = backupSetup();
  let now = T0;
  const clock = () => now;
  b.write({ runId: "r1", startedAt: iso(T0 - 120_000), finishedAt: iso(T0 - 60_000), result: "failed", stage: "upload", lastSuccessAt: iso(T0 - 3 * H) });
  const a = core(b.dataDir);
  const p1 = b.producer(a, clock);
  await p1.checkNow();
  const [item] = await a.store.list();
  assert.ok(item);
  assert.deepEqual(await a.center.act("phone", item.id, "delete"), { ok: true });
  now += 60_000;
  await p1.checkNow(); // same run, same text: not raised again in this run
  assert.deepEqual(await a.store.list(), []);
  await p1.close();

  // Restart: nothing to adopt, so the persisting failure is raised once (a new item, unread) and then left alone.
  const c2 = core(b.dataDir);
  const p2 = b.producer(c2, clock);
  await p2.checkNow();
  const back = await c2.store.list();
  assert.equal(back.length, 1);
  assert.equal(back[0]!.key, BACKUP_KEY_FAILED);
  assert.equal(back[0]!.source, BACKUP_SOURCE);
  now += 60_000;
  await p2.checkNow();
  assert.equal((await c2.store.list())[0]!.raised, 1);
  await p2.close();
});
