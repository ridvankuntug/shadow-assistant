/** Notification store tests (T7.w.5a; docs/08-learning-fast-path.md "T7.w.5 Notification store"). */
import assert from "node:assert/strict";
import * as nodeFs from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AtomicFs } from "../src/atomic-file.js";
import {
  MAX_BODY_CHARS,
  MAX_ITEMS,
  MAX_TITLE_CHARS,
  NOTIFICATIONS_FILE,
  NotificationStore,
  type NotificationsFile,
} from "../src/notifications.js";

const base = mkdtempSync(join(tmpdir(), "shadow-notifications-test-"));
after(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
const freshDir = () => join(base, `d${++n}`);
const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString();

/** A fake clock the test moves by hand. */
function clock(start: string) {
  let now = at(start);
  return {
    now: () => now,
    set: (s: string) => (now = at(s)),
  };
}

function disk(dir: string): NotificationsFile {
  return JSON.parse(readFileSync(join(dir, NOTIFICATIONS_FILE), "utf8")) as NotificationsFile;
}

test("T11-B sequence: keyed raise, renotify, read as acknowledgement, resolve (fake clock)", async () => {
  const dir = freshDir();
  const c = clock("2026-11-07T22:00:00Z");
  const store = new NotificationStore({ dir, now: c.now });
  const reminder = {
    source: "device-state",
    key: "case-battery-low",
    urgency: "normal" as const,
    title: "Kılıfın şarjı düşük",
    body: "Kılıfı şarja tak.",
    renotify: true,
  };

  // 22:00 first reminder: a new unread item.
  const first = await store.raise(reminder);
  assert.ok(first.ok);
  assert.equal(first.created, true);
  assert.equal(first.item.readAt, null);
  assert.equal(first.item.raised, 1);
  assert.match(first.item.id, /^n-[0-9a-f]{16}$/);
  assert.equal(await store.unreadCount(), 1);
  const id = first.item.id;

  // 22:10 the user reads it ("şarja taktım" = acknowledged).
  c.set("2026-11-07T22:10:00Z");
  assert.equal((await store.markRead(id))?.readAt, "2026-11-07T22:10:00.000Z");
  assert.equal(await store.unreadCount(), 0);
  // Reading again keeps the first readAt.
  c.set("2026-11-07T22:20:00Z");
  assert.equal((await store.markRead(id))?.readAt, "2026-11-07T22:10:00.000Z");

  // 23:00 a new low reading after the acknowledgement: the producer raises with renotify → unread again, same item.
  c.set("2026-11-07T23:00:00Z");
  const second = await store.raise({ ...reminder, body: "Hâlâ düşük." });
  assert.ok(second.ok);
  assert.equal(second.created, false);
  assert.equal(second.item.id, id);
  assert.equal(second.item.raised, 2);
  assert.equal(second.item.readAt, null);
  assert.equal(second.item.body, "Hâlâ düşük.");
  assert.equal(second.item.createdAt, "2026-11-07T22:00:00.000Z");
  assert.equal(second.item.updatedAt, "2026-11-07T23:00:00.000Z");

  // 23:05 read again; the producer's check "readAt later than the last low reading (23:00)" holds.
  c.set("2026-11-07T23:05:00Z");
  const read = await store.markRead(id);
  assert.ok(read?.readAt && at(read.readAt) > at("2026-11-07T23:00:00Z"));

  // A raise without renotify updates the text but stays read.
  c.set("2026-11-08T00:00:00Z");
  const quiet = await store.raise({ ...reminder, renotify: false, title: "Kılıf şarjı (güncel)" });
  assert.ok(quiet.ok);
  assert.equal(quiet.item.readAt, "2026-11-07T23:05:00.000Z");
  assert.equal(quiet.item.title, "Kılıf şarjı (güncel)");
  assert.equal(quiet.item.raised, 3);
  assert.equal((await store.list()).length, 1);

  // Survives a restart with every field.
  const again = new NotificationStore({ dir, now: c.now });
  assert.deepEqual(await again.list(), await store.list());

  // A reading above the threshold resolves it.
  assert.equal(await again.resolve("device-state", "case-battery-low"), true);
  assert.equal(await again.resolve("device-state", "case-battery-low"), false);
  assert.deepEqual(await again.list(), []);
  assert.deepEqual(disk(dir).items, []);
  assert.deepEqual(await new NotificationStore({ dir }).list(), []);
});

test("keys are per source; keyless raises are always new items; urgency default normal", async () => {
  const dir = freshDir();
  const c = clock("2026-11-07T10:00:00Z");
  const store = new NotificationStore({ dir, now: c.now });
  const a = await store.raise({ source: "service", key: "service-down:tts-svc", title: "Ses servisi yanıt vermiyor" });
  const b = await store.raise({ source: "backup", key: "service-down:tts-svc", title: "Başka kaynak", urgency: "urgent" });
  c.set("2026-11-07T10:01:00Z");
  const k1 = await store.raise({ source: "test", title: "bir" });
  const k2 = await store.raise({ source: "test", title: "bir" });
  assert.ok(a.ok && b.ok && k1.ok && k2.ok);
  assert.notEqual(a.item.id, b.item.id);
  assert.notEqual(k1.item.id, k2.item.id);
  assert.equal(a.item.urgency, "normal");
  assert.equal(b.item.urgency, "urgent");
  assert.equal(a.item.body, "");
  assert.equal("key" in k1.item, false);
  const list = await store.list();
  assert.equal(list.length, 4);
  // Most recently updated first.
  assert.ok(at(list[0]!.updatedAt) >= at(list[3]!.updatedAt));
  // resolve only touches the named source's key.
  assert.equal(await store.resolve("service", "service-down:tts-svc"), true);
  assert.deepEqual(
    (await store.list()).map((i) => i.source).sort(),
    ["backup", "test", "test"],
  );
});

test("markRead / markUnread / delete; unknown ids; readAt is shared (one inbox)", async () => {
  const dir = freshDir();
  const c = clock("2026-11-07T10:00:00Z");
  const store = new NotificationStore({ dir, now: c.now });
  const r = await store.raise({ source: "test", title: "x" });
  assert.ok(r.ok);
  c.set("2026-11-07T10:05:00Z");
  assert.equal((await store.markRead(r.item.id))?.readAt, iso(c.now()));
  // Another instance (a restart) sees the same read state.
  assert.equal((await new NotificationStore({ dir }).list())[0]?.readAt, iso(c.now()));
  assert.equal((await store.markUnread(r.item.id))?.readAt, null);
  assert.equal(await store.markRead("n-0000000000000000"), undefined);
  assert.equal(await store.markUnread("nope"), undefined);
  assert.equal(await store.delete("nope"), false);
  assert.equal(await store.delete(r.item.id), true);
  assert.equal(await store.delete(r.item.id), false);
  assert.deepEqual(disk(dir).items, []);
});

test("invalid raises are refused and logged; title/body are trimmed and cut", async () => {
  const logs: string[] = [];
  const dir = freshDir();
  const store = new NotificationStore({ dir, log: (m) => logs.push(m) });
  for (const bad of [
    { source: "", title: "x" },
    { source: "Service", title: "x" },
    { source: "a b", title: "x" },
    { source: "test", title: "   " },
    { source: "test", title: 5 },
    { source: "test", title: "x", key: "" },
    { source: "test", title: "x", key: "k".repeat(129) },
    { source: "test", title: "x", urgency: "loud" },
    { source: "test", title: "x", body: 7 },
    { source: "test", title: "x", renotify: "yes" },
  ]) {
    assert.deepEqual(await store.raise(bad as never), { ok: false, reason: "invalid" }, JSON.stringify(bad));
  }
  assert.ok(logs.some((l) => l.includes("invalid raise")));
  assert.equal(existsSync(join(dir, NOTIFICATIONS_FILE)), false);

  const long = await store.raise({ source: "test", title: `  ${"t".repeat(MAX_TITLE_CHARS + 50)}  `, body: "b".repeat(MAX_BODY_CHARS + 5) });
  assert.ok(long.ok);
  assert.equal(long.item.title.length, MAX_TITLE_CHARS);
  assert.equal(long.item.body.length, MAX_BODY_CHARS);
});

test("hard limit: only new keyless raises are refused (logged); keyed raises and updates still work; nothing pruned", async () => {
  assert.equal(MAX_ITEMS, 5000);
  const logs: string[] = [];
  const dir = freshDir();
  const store = new NotificationStore({ dir, maxItems: 3, log: (m) => logs.push(m) });
  for (let i = 0; i < 3; i++) assert.ok((await store.raise({ source: "test", title: `k${i}` })).ok);
  assert.deepEqual(await store.raise({ source: "test", title: "over" }), { ok: false, reason: "full" });
  assert.ok(logs.some((l) => l.includes("limit of 3") && l.includes('"test"')));
  // A keyed raise for a new key is a recurring condition: accepted above the limit.
  const keyed = await store.raise({ source: "service", key: "down:x", title: "x" });
  assert.ok(keyed.ok && keyed.created);
  // An update of the existing key too.
  assert.ok((await store.raise({ source: "service", key: "down:x", title: "x2" })).ok);
  const list = await store.list();
  assert.equal(list.length, 4);
  assert.deepEqual(list.map((i) => i.title).sort(), ["k0", "k1", "k2", "x2"]);
  // Deleting one frees room for a keyless raise again.
  assert.equal(await store.delete(list.find((i) => i.title === "k0")!.id), true);
  assert.equal(await store.delete(list.find((i) => i.title === "k1")!.id), true);
  assert.ok((await store.raise({ source: "test", title: "fits" })).ok);
  // Restart: the same three items, nothing pruned.
  assert.equal((await new NotificationStore({ dir, maxItems: 3 }).list()).length, 3);
});

test("corrupt file: not JSON, wrong version or one bad item → whole file quarantined, one warning, empty store", async () => {
  const valid = {
    id: "n-0123456789abcdef",
    source: "test",
    urgency: "normal",
    title: "x",
    body: "",
    createdAt: "2026-11-07T10:00:00.000Z",
    updatedAt: "2026-11-07T10:00:00.000Z",
    readAt: null,
    raised: 1,
  };
  const cases: Array<[string, string]> = [
    ["not json", "{ broken"],
    ["version 2", JSON.stringify({ version: 2, items: [] })],
    ["items not array", JSON.stringify({ version: 1, items: {} })],
    ["bad item", JSON.stringify({ version: 1, items: [valid, { ...valid, id: "n-1", readAt: "later" }] })],
    ["bad raised", JSON.stringify({ version: 1, items: [{ ...valid, raised: 0 }] })],
    ["duplicate id", JSON.stringify({ version: 1, items: [valid, valid] })],
    [
      "duplicate key",
      JSON.stringify({
        version: 1,
        items: [
          { ...valid, key: "k" },
          { ...valid, id: "n-fedcba9876543210", key: "k" },
        ],
      }),
    ],
  ];
  for (const [name, content] of cases) {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, NOTIFICATIONS_FILE), content);
    const logs: string[] = [];
    const store = new NotificationStore({ dir, log: (m) => logs.push(m) });
    assert.deepEqual(await store.list(), [], name);
    assert.equal(logs.filter((l) => l.includes("invalid and was moved aside")).length, 1, name);
    const copies = readdirSync(dir).filter((f) => f.startsWith(`${NOTIFICATIONS_FILE}.corrupt-`));
    assert.equal(copies.length, 1, name);
    // The quarantined copy holds the original content.
    assert.equal(readFileSync(join(dir, copies[0]!), "utf8"), content, name);
  }

  // A valid file with unknown fields loads (fields not kept), and a key with a different source is not a duplicate.
  const dir = freshDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, NOTIFICATIONS_FILE),
    JSON.stringify({
      version: 1,
      items: [
        { ...valid, key: "k", extra: 1 },
        { ...valid, id: "n-fedcba9876543210", source: "ha", key: "k" },
      ],
    }),
  );
  const list = await new NotificationStore({ dir }).list();
  assert.equal(list.length, 2);
  assert.equal("extra" in list[0]!, false);
});

/** Real fs with switches to fail writes (rename) or reads. */
function flakyFs() {
  const state = { failRename: false, failRead: false };
  const fs: AtomicFs = {
    mkdir: (p, o) => nodeFs.mkdir(p, o),
    open: (p, f, m) => nodeFs.open(p, f, m),
    rename: (a, b) => (state.failRename ? Promise.reject(Object.assign(new Error("simulated"), { code: "EIO" })) : nodeFs.rename(a, b)),
    unlink: (p) => nodeFs.unlink(p),
    readFile: (p, e) => (state.failRead ? Promise.reject(Object.assign(new Error("simulated"), { code: "EACCES" })) : nodeFs.readFile(p, e)),
    readdir: (p) => nodeFs.readdir(p),
  };
  return { fs, state };
}

test("a failed write keeps the change in memory, is logged and is retried by the next write; the old file stays intact", async () => {
  const dir = freshDir();
  const logs: string[] = [];
  const { fs, state } = flakyFs();
  const store = new NotificationStore({ dir, fs, retryDelaysMs: [], log: (m) => logs.push(m) });
  const first = await store.raise({ source: "test", title: "one" });
  assert.ok(first.ok);
  const before = readFileSync(join(dir, NOTIFICATIONS_FILE), "utf8");

  state.failRename = true;
  const second = await store.raise({ source: "test", title: "two" });
  assert.ok(second.ok);
  assert.ok(logs.some((l) => l === "[shadow-core] notifications write failed: EIO"));
  // Interrupted before the rename: the previous file is intact, no temp file left behind.
  assert.equal(readFileSync(join(dir, NOTIFICATIONS_FILE), "utf8"), before);
  assert.deepEqual(readdirSync(dir), [NOTIFICATIONS_FILE]);
  assert.equal((await store.list()).length, 2);

  state.failRename = false;
  // A read-only operation also retries the pending write.
  await store.flush();
  assert.equal(disk(dir).items.length, 2);
  assert.equal((await new NotificationStore({ dir }).list()).length, 2);
});

test("an unreadable file is never overwritten: operations report unavailable and recover later", async () => {
  const dir = freshDir();
  const seed = new NotificationStore({ dir });
  assert.ok((await seed.raise({ source: "test", title: "kept" })).ok);
  const content = readFileSync(join(dir, NOTIFICATIONS_FILE), "utf8");

  const logs: string[] = [];
  const { fs, state } = flakyFs();
  state.failRead = true;
  const store = new NotificationStore({ dir, fs, retryDelaysMs: [], log: (m) => logs.push(m) });
  assert.deepEqual(await store.raise({ source: "test", title: "new" }), { ok: false, reason: "unavailable" });
  assert.deepEqual(await store.list(), []);
  assert.equal(await store.delete("n-0123456789abcdef"), false);
  assert.ok(logs.some((l) => l.includes("could not be read: EACCES")));
  assert.equal(readFileSync(join(dir, NOTIFICATIONS_FILE), "utf8"), content);

  state.failRead = false;
  assert.ok((await store.raise({ source: "test", title: "new" })).ok);
  assert.deepEqual((await store.list()).map((i) => i.title).sort(), ["kept", "new"]);
});

test("an invalid file that cannot be moved aside is not replaced by an empty store", async () => {
  const dir = freshDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, NOTIFICATIONS_FILE), "{ broken");
  const { fs, state } = flakyFs();
  state.failRename = true;
  const logs: string[] = [];
  const store = new NotificationStore({ dir, fs, retryDelaysMs: [], log: (m) => logs.push(m) });
  assert.deepEqual(await store.raise({ source: "test", title: "x" }), { ok: false, reason: "unavailable" });
  assert.equal(readFileSync(join(dir, NOTIFICATIONS_FILE), "utf8"), "{ broken");
  assert.ok(logs.some((l) => l.includes("could not be read: QUARANTINE_FAILED")));

  // Once the rename works the file is quarantined and the store starts.
  state.failRename = false;
  assert.ok((await store.raise({ source: "test", title: "x" })).ok);
  assert.ok(readdirSync(dir).some((f) => f.startsWith(`${NOTIFICATIONS_FILE}.corrupt-`)));
});

test("concurrent operations are serialized: no lost update", async () => {
  const dir = freshDir();
  const store = new NotificationStore({ dir });
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => store.raise({ source: "test", title: `t${i}` })));
  assert.ok(results.every((r) => r.ok));
  assert.equal(disk(dir).items.length, 20);
  assert.equal((await new NotificationStore({ dir }).list()).length, 20);
});
