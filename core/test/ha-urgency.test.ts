/**
 * T7.w.11.10: learned urgency of HA alerts (docs/09 *Learned urgency of HA alerts*).
 * Real HaUrgencyStore / NotificationStore in a temp dir, a NotificationCenter with
 * fake sockets and a DevelopmentTab over the urgency store. Never a real HA.
 *
 * - type keys: variable suffix stripped, anonymous ids, long ids hashed; repairs
 *   by translation key, issue_id as fallback;
 * - counter: same direction +1, opposite resets to 1, threshold 3 → suggestion
 *   (only when it differs from the current level); one signal per item;
 * - Kabul / Yok say; failed-login start level; persisted across a restart;
 *   corrupt and unreadable files;
 * - `urgent_yes` / `urgent_no` through NotificationCenter: only `ha` alert items.
 */
import assert from "node:assert/strict";
import * as nodeFs from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AtomicFs } from "../src/atomic-file.js";
import {
  HA_URGENCY_FILE,
  HA_URGENCY_THRESHOLD,
  HaUrgencyStore,
  INITIAL_URGENT_TYPES,
  haUrgencyFeedback,
  pnTypeKey,
  repairTypeKey,
  stripVariableSuffix,
} from "../src/ha-urgency.js";
import { MAX_KEY_CHARS, NOTIFICATIONS_DIR, NotificationStore } from "../src/notifications.js";
import type { ServerFrame } from "../src/protocol.js";
import { DevelopmentTab, NotificationCenter, type NotificationListener } from "../src/session.js";

const base = mkdtempSync(join(tmpdir(), "shadow-ha-urgency-test-"));
after(() => rmSync(base, { recursive: true, force: true }));
let counter = 0;
const newDir = () => join(base, `d${++counter}`, NOTIFICATIONS_DIR);

function store(dir: string, o: { fs?: AtomicFs; onChange?: () => void } = {}) {
  const logs: string[] = [];
  let t = Date.parse("2026-11-13T10:00:00.000Z");
  const s = new HaUrgencyStore({
    dir,
    log: (m) => logs.push(m),
    now: () => (t += 1000),
    ...(o.onChange ? { onChange: o.onChange } : {}),
    ...(o.fs ? { fs: o.fs, retryDelaysMs: [] } : {}),
  });
  return { s, logs };
}

/** File system whose reads of the urgency file fail while `locked.on` (EACCES). */
function lockableFs(locked: { on: boolean }): AtomicFs {
  return {
    mkdir: (p, o) => nodeFs.mkdir(p, o),
    open: (p, f, m) => nodeFs.open(p, f, m),
    rename: (a, b) => nodeFs.rename(a, b),
    unlink: (p) => nodeFs.unlink(p),
    readFile: (p, e) => (locked.on ? Promise.reject(Object.assign(new Error("locked"), { code: "EACCES" })) : nodeFs.readFile(p, e)),
    readdir: (p) => nodeFs.readdir(p),
  };
}

test("type key: variable suffix stripped (digits, UUID, hex ≥ 8), anonymous ids, long ids hashed; repairs fall back to issue_id", () => {
  assert.equal(stripVariableSuffix("http-login"), "http-login");
  assert.equal(stripVariableSuffix("http-login-3"), "http-login");
  assert.equal(stripVariableSuffix("backup_failed_12"), "backup_failed");
  assert.equal(stripVariableSuffix("discovery-550e8400-e29b-41d4-a716-446655440000"), "discovery");
  assert.equal(stripVariableSuffix("discovery_deadbeef01"), "discovery");
  assert.equal(stripVariableSuffix("update-abc"), "update-abc", "short hex tail kept");
  assert.equal(stripVariableSuffix("sensor_ab12cd3"), "sensor_ab12cd3", "7 hex chars kept");
  assert.equal(stripVariableSuffix("a-1-2"), "a-1", "stripped once");
  assert.equal(stripVariableSuffix("0123456789abcdef0123456789abcdef"), "*", "HA's random id: one anonymous type");
  assert.equal(stripVariableSuffix("12345"), "*");
  assert.equal(stripVariableSuffix("-12"), "*");
  assert.equal(pnTypeKey("http-login"), "pn:http-login");
  assert.equal(pnTypeKey("config_entry_discovery"), "pn:config_entry_discovery");
  assert.equal(pnTypeKey("x-42"), pnTypeKey("x-43"), "one type per occurrence");
  assert.notEqual(pnTypeKey("x-a"), pnTypeKey("y-a"));
  const long = pnTypeKey("z".repeat(MAX_KEY_CHARS));
  assert.match(long, /^pn:sha256:[0-9a-f]{64}$/);
  assert.equal(repairTypeKey("demo", "deprecated_yaml", "deprecated_yaml_sensor"), "repair:demo:deprecated_yaml");
  assert.equal(repairTypeKey("demo", undefined, "x1"), "repair:demo:x1");
  assert.notEqual(repairTypeKey("demo", "a", "i"), repairTypeKey("demo", "b", "i"), "two problems of one integration stay apart");
  assert.match(repairTypeKey("d", "t".repeat(MAX_KEY_CHARS), "i"), /^repair:sha256:[0-9a-f]{64}$/);
  assert.deepEqual([...INITIAL_URGENT_TYPES], ["pn:http-login", "pn:ip-ban"]);
  assert.equal(HA_URGENCY_THRESHOLD, 3);
});

test("start levels: failed-login types urgent, everything else normal", async () => {
  const { s } = store(newDir());
  assert.equal(await s.level("pn:http-login"), "urgent");
  assert.equal(await s.level("pn:ip-ban"), "urgent");
  assert.equal(await s.level("pn:config_entry_discovery"), "normal");
  assert.equal(await s.level("repair:demo:x"), "normal");
});

test("counter: same direction +1, opposite resets to 1, threshold 3 → suggestion; one signal per item", async () => {
  let changes = 0;
  const { s } = store(newDir(), { onChange: () => changes++ });
  const T = "pn:backup_failed";
  assert.deepEqual(await s.feedback(T, "urgent", "n-1"), { ok: true, counted: true, count: 1, suggestion: false });
  assert.deepEqual(await s.feedback(T, "urgent", "n-1"), { ok: true, counted: false, count: 1, suggestion: false }, "same item again: not counted");
  assert.deepEqual(await s.feedback(T, "urgent", "n-2"), { ok: true, counted: true, count: 2, suggestion: false });
  assert.deepEqual(await s.feedback(T, "normal", "n-3"), { ok: true, counted: true, count: 1, suggestion: false }, "opposite: reset to 1");
  assert.deepEqual(await s.feedback(T, "urgent", "n-4"), { ok: true, counted: true, count: 1, suggestion: false }, "opposite again: reset");
  assert.deepEqual(await s.feedback(T, "urgent", "n-5"), { ok: true, counted: true, count: 2, suggestion: false });
  assert.deepEqual(await s.suggestions(), []);
  assert.deepEqual(await s.feedback(T, "urgent", "n-6"), { ok: true, counted: true, count: 3, suggestion: true });
  const [sug, ...rest] = await s.suggestions();
  assert.equal(rest.length, 0);
  assert.equal(sug!.type, T);
  assert.equal(sug!.direction, "urgent");
  assert.equal(sug!.count, 3);
  assert.ok(Date.parse(sug!.firstAt) < Date.parse(sug!.lastAt));
  assert.equal(await s.level(T), "normal", "Shadow never changes a level by itself");
  assert.equal(changes, 6, "every counted signal (not the repeated tap)");
  // The same item may change its mind: counted in the new direction.
  assert.deepEqual(await s.feedback(T, "normal", "n-6"), { ok: true, counted: true, count: 1, suggestion: false });
  assert.deepEqual(await s.suggestions(), [], "the opposite signal removed the suggestion");
});

test("one signal per item and direction: A/B/A and a repeat after Kabul are not counted again", async () => {
  const { s } = store(newDir());
  const T = "pn:x";
  await s.feedback(T, "urgent", "A");
  await s.feedback(T, "normal", "B");
  assert.deepEqual(await s.feedback(T, "urgent", "A"), { ok: true, counted: false, count: 1, suggestion: false }, "A's repeat does not flip B's run");
  for (const id of ["C", "D"]) await s.feedback(T, "normal", id);
  assert.equal((await s.suggestions()).length, 0, "normal is already the level");
  for (const id of ["E", "F", "G"]) await s.feedback(T, "urgent", id);
  assert.equal(await s.accept(T, "urgent"), "ok");
  assert.deepEqual(await s.feedback(T, "urgent", "G"), { ok: true, counted: false, count: 0, suggestion: false }, "repeat after Kabul");
  assert.deepEqual(await s.feedback(T, "normal", "G"), { ok: true, counted: true, count: 1, suggestion: false }, "a change of mind counts");
});

test("no suggestion for signals that agree with the current level (failed-login 'acildi' ×3)", async () => {
  const { s } = store(newDir());
  for (const id of ["n-1", "n-2", "n-3", "n-4"]) await s.feedback("pn:http-login", "urgent", id);
  assert.deepEqual(await s.suggestions(), []);
  for (const id of ["n-5", "n-6", "n-7"]) await s.feedback("pn:http-login", "normal", id);
  const [sug] = await s.suggestions();
  assert.equal(sug!.direction, "normal", "acil saymayalım mı?");
});

test("Kabul sets the level and clears the counter; Yok say keeps it and clears the counter; stale suggestion = unknown", async () => {
  const dir = newDir();
  const { s } = store(dir);
  for (const id of ["a", "b", "c"]) await s.feedback("pn:http-login", "normal", id);
  for (const id of ["d", "e", "f"]) await s.feedback("repair:demo:t", "urgent", id);
  assert.equal(await s.accept("pn:http-login", "urgent"), "unknown", "the suggestion is 'normal', not 'urgent'");
  assert.equal(await s.accept("pn:http-login", "normal"), "ok");
  assert.equal(await s.level("pn:http-login"), "normal");
  assert.equal(await s.accept("pn:http-login", "normal"), "unknown", "already taken");
  assert.equal(await s.dismiss("repair:demo:t", "urgent"), "ok");
  assert.equal(await s.level("repair:demo:t"), "normal");
  assert.deepEqual(await s.suggestions(), []);
  // After "Yok say" three new signals suggest it again.
  for (const id of ["g", "h", "i"]) await s.feedback("repair:demo:t", "urgent", id);
  assert.equal((await s.suggestions()).length, 1);
  assert.equal(await s.accept("repair:demo:t", "urgent"), "ok");
  assert.equal(await s.level("repair:demo:t"), "urgent");
  // Lowering goes the same way.
  for (const id of ["j", "k", "l"]) await s.feedback("repair:demo:t", "normal", id);
  assert.equal(await s.accept("repair:demo:t", "normal"), "ok");
  assert.equal(await s.level("repair:demo:t"), "normal");
  // The file holds type keys, directions, counters and levels only.
  const file = JSON.parse(readFileSync(join(dir, HA_URGENCY_FILE), "utf8")) as { version: number; items: Array<Record<string, unknown>> };
  assert.equal(file.version, 1);
  for (const r of file.items) {
    for (const k of Object.keys(r)) assert.ok(["type", "direction", "count", "firstAt", "lastAt", "level"].includes(k), k);
  }
});

test("persisted: counters and approved levels survive a restart (new instance, same dir)", async () => {
  const dir = newDir();
  const a = store(dir).s;
  for (const id of ["a", "b"]) await a.feedback("pn:x", "urgent", id);
  for (const id of ["c", "d", "e"]) await a.feedback("pn:http-login", "normal", id);
  assert.equal(await a.accept("pn:http-login", "normal"), "ok");
  const b = store(dir).s;
  assert.equal(await b.level("pn:http-login"), "normal");
  assert.deepEqual(await b.feedback("pn:x", "urgent", "f"), { ok: true, counted: true, count: 3, suggestion: true });
});

test("corrupt file: quarantined, logged once, empty (start levels); the next change writes a fresh file", async () => {
  const dir = newDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, HA_URGENCY_FILE), "{ not json");
  const { s, logs } = store(dir);
  assert.equal(await s.level("pn:http-login"), "urgent");
  assert.ok(readdirSync(dir).some((n) => n.startsWith(`${HA_URGENCY_FILE}.corrupt-`)));
  assert.equal(logs.filter((l) => l.includes("moved aside")).length, 1);
  assert.equal((await s.feedback("pn:x", "urgent", "a")).ok, true);
  assert.ok(existsSync(join(dir, HA_URGENCY_FILE)));
  // A wrong shape is corrupt too.
  const dir2 = newDir();
  mkdirSync(dir2, { recursive: true });
  writeFileSync(join(dir2, HA_URGENCY_FILE), JSON.stringify({ version: 1, items: [{ type: "pn:x", count: 2 }] }));
  const s2 = store(dir2).s;
  assert.deepEqual(await s2.suggestions(), []);
  assert.ok(readdirSync(dir2).some((n) => n.startsWith(`${HA_URGENCY_FILE}.corrupt-`)));
});

test("unreadable file: start levels, feedback refused, never overwritten; read again once it can be", async () => {
  const dir = newDir();
  const first = store(dir).s;
  await first.feedback("pn:x", "urgent", "a");
  await first.feedback("pn:http-login", "normal", "b");
  const before = readFileSync(join(dir, HA_URGENCY_FILE), "utf8");
  const locked = { on: true };
  const { s, logs } = store(dir, { fs: lockableFs(locked) });
  assert.equal(await s.level("pn:http-login"), "urgent", "start level while unreadable");
  assert.deepEqual(await s.feedback("pn:x", "urgent", "c"), { ok: false, reason: "unavailable" });
  assert.equal(await s.accept("pn:x", "urgent"), "unavailable");
  assert.deepEqual(await s.suggestions(), []);
  assert.equal(logs.filter((l) => l.includes("could not be read")).length, 1, "logged once per spell");
  assert.equal(readFileSync(join(dir, HA_URGENCY_FILE), "utf8"), before, "never overwritten");
  locked.on = false;
  assert.deepEqual(await s.feedback("pn:x", "urgent", "c"), { ok: true, counted: true, count: 2, suggestion: false });
  assert.ok(logs.some((l) => l.includes("can be read again")));
});

test("type limit: a new type beyond it is not recorded (logged); invalid input refused", async () => {
  const s = new HaUrgencyStore({ dir: newDir(), maxTypes: 1, log: () => {} });
  assert.equal((await s.feedback("pn:a", "urgent", "1")).ok, true);
  assert.deepEqual(await s.feedback("pn:b", "urgent", "2"), { ok: false, reason: "full" });
  assert.deepEqual(await s.feedback("title text", "urgent", "3"), { ok: false, reason: "invalid" });
  assert.deepEqual(await s.feedback("pn:a", "loud" as "urgent", "4"), { ok: false, reason: "invalid" });
});

test("typeOfItem: as the producer saw it, else derived from an unhashed pn: key; repairs and ha:access need the producer", () => {
  const { s } = store(newDir());
  assert.equal(s.typeOfItem("pn:http-login"), "pn:http-login");
  assert.equal(s.typeOfItem("pn:backup_failed_3"), "pn:backup_failed");
  assert.equal(s.typeOfItem("repair:demo:x_1"), undefined, "the translation key is not in the item key");
  assert.equal(s.typeOfItem("pn:sha256:" + "a".repeat(64)), undefined);
  assert.equal(s.typeOfItem("ha:access"), undefined);
  s.noteItem("repair:demo:x_1", "repair:demo:deprecated");
  assert.equal(s.typeOfItem("repair:demo:x_1"), "repair:demo:deprecated");
});

// ------------------------------------------------------------ NotificationCenter + DevelopmentTab

function core(dir: string) {
  const logs: string[] = [];
  const logger = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) };
  const notifications = new NotificationStore({ dir, log: (m) => logs.push(m), coalesceMs: 0 });
  const ref: { tab?: DevelopmentTab } = {};
  const urgency = new HaUrgencyStore({ dir, log: (m) => logs.push(m), onChange: () => ref.tab?.changed() });
  const center = new NotificationCenter({ store: notifications, logger, urgencyFeedback: haUrgencyFeedback(urgency) });
  const tab = new DevelopmentTab({ haUrgency: urgency, managers: [], logger, recountMs: 5 });
  ref.tab = tab;
  const frames: ServerFrame[] = [];
  const l: NotificationListener = { sessionId: `s${++counter}`, device: "browser", speaks: () => false, deliver: (f) => frames.push(f) };
  center.attach(l);
  return { notifications, urgency, center, tab, frames, logs };
}

test("urgent_yes / urgent_no: only on ha alert items; no inbox change or broadcast; non-ha / ha:access = bad_request", async () => {
  const c = core(newDir());
  const ha = await c.center.raise({ source: "ha", key: "pn:backup_failed_1", title: "Yedek", body: "" });
  const access = await c.center.raise({ source: "ha", key: "ha:access", title: "HA uyarıları okunamıyor" });
  const other = await c.center.raise({ source: "service", key: "service:x", title: "Servis" });
  const repair = await c.center.raise({ source: "ha", key: "repair:demo:x_1", title: "Onarım" });
  assert.ok(ha.ok && access.ok && other.ok && repair.ok);
  const framesBefore = c.frames.length;
  const listBefore = await c.center.list();
  assert.deepEqual(await c.center.act("browser", ha.item.id, "urgent_yes"), { ok: true });
  assert.equal(c.frames.length, framesBefore, "nothing broadcast");
  assert.deepEqual(await c.center.list(), listBefore, "inbox unchanged");
  const r1 = await c.center.act("browser", other.item.id, "urgent_yes");
  assert.equal(r1.ok === false && r1.code, "bad_request");
  const r2 = await c.center.act("browser", access.item.id, "urgent_no");
  assert.equal(r2.ok === false && r2.code, "bad_request");
  const r3 = await c.center.act("browser", repair.item.id, "urgent_yes");
  assert.equal(r3.ok === false && r3.code, "not_allowed", "repair type unknown until the producer lists it");
  c.urgency.noteItem("repair:demo:x_1", "repair:demo:t");
  assert.deepEqual(await c.center.act("browser", repair.item.id, "urgent_yes"), { ok: true });
  const r4 = await c.center.act("browser", "n-0000000000000000", "urgent_yes");
  assert.equal(r4.ok === false && r4.code, "unknown_item");
  // Without a port (older wiring): bad_request.
  const plain = new NotificationCenter({ store: c.notifications, logger: { info: () => {}, warn: () => {} } });
  const r5 = await plain.act("browser", ha.item.id, "urgent_yes");
  assert.equal(r5.ok === false && r5.code, "bad_request");
  for (const line of c.logs) assert.ok(!line.includes("backup_failed") && !line.includes("Yedek"), `no type/text in logs: ${line}`);
});

test("Development tab: 3 signals → ha_urgency suggestion (open, counted); Kabul / Yok say; other actions not allowed", async () => {
  const c = core(newDir());
  const counts: number[] = [];
  c.tab.subscribe((n) => counts.push(n));
  for (let i = 0; i < 3; i++) {
    const r = await c.center.raise({ source: "ha", key: `pn:backup_failed_${i}`, title: "Yedek" });
    assert.ok(r.ok);
    assert.deepEqual(await c.center.act("browser", r.item.id, "urgent_yes"), { ok: true });
  }
  const v = await c.tab.view();
  assert.equal(v.open, 1);
  assert.equal(v.items.length, 1);
  const item = v.items[0]!;
  assert.equal(item.type, "note");
  assert.equal(item.kind, "ha_urgency");
  assert.equal(item.status, "open");
  assert.equal(item.count, 3);
  assert.match(item.itemId, /^h-[0-9a-f]{16}$/);
  assert.equal(item.message, "HA uyarı türü “pn:backup_failed” acil sayılsın mı?");
  assert.deepEqual(await c.tab.act("browser", item.itemId, "fixed"), { ok: false, code: "not_allowed", message: "this action is not valid for the item" });
  assert.deepEqual(await c.tab.act("browser", item.itemId, "add_rule"), {
    ok: false,
    code: "not_allowed",
    message: "this device may not add rules (CORE_DEV_DEVICES)",
  });
  assert.deepEqual(await c.tab.act("browser", item.itemId, "accept"), { ok: true });
  assert.equal(await c.urgency.level("pn:backup_failed"), "urgent");
  assert.deepEqual((await c.tab.view()).items, []);
  assert.deepEqual(await c.tab.act("browser", item.itemId, "accept"), { ok: false, code: "unknown_item", message: "unknown development item" });
  // The next raise of that type is urgent (read at raise time).
  const next = await c.center.raise({ source: "ha", key: "pn:backup_failed_9", title: "Yedek", urgency: await c.urgency.level("pn:backup_failed") });
  assert.ok(next.ok && next.item.urgency === "urgent");
  // "Acil değildi" ×3 → "acil saymayalım mı?" → Yok say keeps urgent.
  for (const id of ["n-a", "n-b", "n-c"]) await c.urgency.feedback("pn:backup_failed", "normal", id);
  const [down] = (await c.tab.view()).items;
  assert.equal(down!.message, "HA uyarı türü “pn:backup_failed” acil saymayalım mı?");
  assert.notEqual(down!.itemId, item.itemId, "the id differs per direction");
  assert.deepEqual(await c.tab.act("browser", down!.itemId, "ignore"), { ok: true });
  assert.equal(await c.urgency.level("pn:backup_failed"), "urgent");
  assert.deepEqual((await c.tab.view()).items, []);
  // accept on a non-suggestion item id.
  assert.deepEqual(await c.tab.act("browser", "t-0000000000000000", "accept"), { ok: false, code: "unknown_item", message: "unknown development item" });
  // The badge was recounted after the signals (onChange → changed()).
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(counts.includes(1) && counts.at(-1) === 0, `counts: ${counts.join(",")}`);
  c.tab.close();
});
