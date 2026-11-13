/**
 * The PC permission store (docs/11-pc-control.md D3, T17.2): row identity,
 * write-through with one mutex, fail-closed load, the badge count, the switch
 * and its device check. No PC action runs here.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AtomicFs } from "../src/atomic-file.js";
import {
  canonicalHost,
  canonicalTargetId,
  MAX_PC_ALIASES,
  PC_PERMISSIONS_FILE,
  pcPermissionView,
  pcRowId,
  PcPermissionStore,
  type PcTargetRef,
} from "../src/pc/permissions.js";

const base = mkdtempSync(join(tmpdir(), "shadow-pc-permissions-test-"));
after(() => rmSync(base, { recursive: true, force: true }));

let counter = 0;
const newDir = () => join(base, `d${++counter}`, "pc");

const STEAM: PcTargetRef = { action: "open_app", kind: "app", id: "Steam_App_Id", label: "Steam", alias: "steam" };
const VOLUME: PcTargetRef = { action: "volume", kind: "system", id: "volume", label: "Ses düzeyi" };
const SITE: PcTargetRef = { action: "open_site", kind: "site", id: "www.YouTube.com", label: "youtube.com" };

function store(o: { dir?: string; managers?: string[]; logs?: string[]; fs?: AtomicFs; maxRows?: number; now?: () => number } = {}) {
  const logs = o.logs ?? [];
  const s = new PcPermissionStore({
    dir: o.dir ?? newDir(),
    managers: o.managers ?? ["browser", "android"],
    log: (m) => logs.push(m),
    retryDelaysMs: [],
    ...(o.fs ? { fs: o.fs } : {}),
    ...(o.maxRows ? { maxRows: o.maxRows } : {}),
    ...(o.now ? { now: o.now } : {}),
  });
  return { s, logs };
}

async function loaded(o: Parameters<typeof store>[0] = {}) {
  const r = store(o);
  await r.s.load();
  return r;
}

const fileOf = (s: PcPermissionStore) => JSON.parse(readFileSync(s.file, "utf8")) as { version: number; rows: Array<Record<string, unknown>> };

// ------------------------------------------------------------------ row identity

test("row id: deterministic p- + 16 hex of sha256(action|kind|id); different action or target → different row", () => {
  const a = pcRowId("open_app", "app", "steam_app_id");
  assert.match(a, /^p-[0-9a-f]{16}$/);
  assert.equal(pcRowId("open_app", "app", "steam_app_id"), a);
  assert.notEqual(pcRowId("close_app", "app", "steam_app_id"), a, "open and close are separate rows");
  assert.notEqual(pcRowId("force_close_app", "app", "steam_app_id"), pcRowId("close_app", "app", "steam_app_id"));
  assert.notEqual(pcRowId("open_app", "app", "discord_app_id"), a);
});

test("canonical ids: app lower case, site host normalized (case, www., IDN), fixed ids only for search/system, kind must fit the action", () => {
  assert.equal(canonicalTargetId("open_app", "app", "  Steam_App_Id "), "steam_app_id");
  assert.equal(canonicalTargetId("open_site", "site", "WWW.YouTube.COM"), "youtube.com");
  assert.equal(canonicalTargetId("open_site", "site", "music.youtube.com"), "music.youtube.com", "exact host (Q13)");
  assert.notEqual(canonicalTargetId("open_site", "site", "music.youtube.com"), canonicalTargetId("open_site", "site", "youtube.com"));
  assert.equal(canonicalTargetId("open_site", "site", "bücher.example"), "xn--bcher-kva.example", "IDNA ASCII form");
  for (const bad of ["", "https://youtube.com", "youtube.com/watch", "youtube.com:443", "user@youtube.com", "you tube.com", "..com", ".", "www..com"]) {
    assert.equal(canonicalHost(bad), undefined, bad);
  }
  assert.equal(canonicalTargetId("volume", "system", "volume"), "volume");
  assert.equal(canonicalTargetId("volume", "system", "lock"), undefined, "volume has only system:volume");
  assert.equal(canonicalTargetId("media_search", "search", "youtube-music"), "youtube-music");
  assert.equal(canonicalTargetId("media_search", "search", "web"), undefined);
  assert.equal(canonicalTargetId("web_search", "search", "web"), "web");
  assert.equal(canonicalTargetId("open_app", "site", "youtube.com"), undefined, "open_app takes apps only");
  assert.equal(canonicalTargetId("play_game", "steam", " 570 "), "570");
  assert.equal(canonicalTargetId("play_game", "app", "x"), undefined);
});

test("synonyms land on one row: the same target with another spelling or case is the same row; www. and case for sites", async () => {
  const { s } = await loaded();
  const a = await s.recordRefusal(STEAM);
  const b = await s.recordRefusal({ ...STEAM, id: "STEAM_APP_ID", alias: "steami" });
  const c = await s.recordRefusal({ ...STEAM, id: " steam_app_id", alias: "steam'i" });
  assert.ok(a.ok && b.ok && c.ok);
  assert.equal(a.rowId, b.rowId);
  assert.equal(b.rowId, c.rowId);
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  const s1 = await s.recordRefusal(SITE);
  const s2 = await s.recordRefusal({ ...SITE, id: "youtube.com" });
  assert.ok(s1.ok && s2.ok && s1.rowId === s2.rowId);
  const v = await s.list();
  assert.equal(v.rows.length, 2);
  const steam = v.rows.find((r) => r.rowId === a.rowId);
  assert.equal(steam?.requests, 3);
  assert.deepEqual(fileOf(s).rows.find((r) => r.id === a.rowId)?.aliases, ["steam", "steami", "steam'i"]);
});

// ------------------------------------------------------------------ store

test("missing file: empty and available; a refusal adds the row OFF and unseen, written at once in the documented shape", async () => {
  const { s } = await loaded({ now: () => Date.parse("2026-11-14T18:00:00.000Z") });
  assert.equal(s.available, true);
  assert.deepEqual(await s.list(), { available: true, rows: [], unseen: 0 });
  assert.equal(existsSync(s.file), false, "nothing written by load()");
  const r = await s.recordRefusal(STEAM);
  assert.ok(r.ok);
  const f = fileOf(s);
  assert.equal(f.version, 1);
  assert.deepEqual(f.rows[0], {
    id: r.rowId,
    action: "open_app",
    target: { kind: "app", id: "steam_app_id", label: "Steam" },
    aliases: ["steam"],
    enabled: false,
    seen: false,
    createdAt: "2026-11-14T18:00:00.000Z",
    lastRequestedAt: "2026-11-14T18:00:00.000Z",
    requests: 1,
    changedAt: null,
    changedBy: null,
  });
  assert.equal(s.unseen, 1);
  assert.deepEqual(s.lookup(STEAM), { state: "off", rowId: r.rowId });
  assert.deepEqual(s.lookup(VOLUME), { state: "missing", rowId: pcRowId("volume", "system", "volume") });
  assert.deepEqual(s.lookup({ action: "volume", kind: "system", id: "lock" }), { state: "invalid" });
});

test("list: display fields only (no target id, aliases or device), newest request first; reload from disk keeps everything", async () => {
  let t = Date.parse("2026-11-14T18:00:00.000Z");
  const dir = newDir();
  const { s } = await loaded({ dir, now: () => (t += 1000) });
  const steam = await s.recordRefusal(STEAM);
  await s.recordRefusal(VOLUME);
  assert.ok(steam.ok);
  await s.setEnabled("browser", steam.rowId, true);
  const v = await s.list();
  assert.deepEqual(
    v.rows.map((r) => r.label),
    ["Ses düzeyi", "Steam"],
  );
  const row = v.rows[1];
  assert.deepEqual(Object.keys(row ?? {}).sort(), ["action", "changedAt", "createdAt", "enabled", "kind", "label", "lastRequestedAt", "requests", "rowId", "seen"]);
  assert.equal(JSON.stringify(v).includes("steam_app_id"), false, "no target id");
  assert.equal(JSON.stringify(v).includes("browser"), false, "no device name");
  assert.equal("changedAt" in (v.rows[0] ?? {}), false, "changedAt only after a switch");
  // A new store over the same file (Core restart) sees the same list.
  const again = await loaded({ dir });
  assert.deepEqual(await again.s.list(), v);
  assert.deepEqual(again.s.lookup(STEAM), { state: "on", rowId: steam.rowId });
});

test("recordRefusal never changes enabled or seen of an existing row; aliases capped, newest kept", async () => {
  const { s } = await loaded();
  const r = await s.recordRefusal(STEAM);
  assert.ok(r.ok);
  await s.setEnabled("browser", r.rowId, true);
  await s.recordRefusal(STEAM);
  assert.deepEqual(s.lookup(STEAM), { state: "on", rowId: r.rowId }, "a refusal of an on row (race) does not switch it off");
  await s.setEnabled("browser", r.rowId, false);
  for (let i = 0; i < MAX_PC_ALIASES + 3; i++) await s.recordRefusal({ ...STEAM, alias: `a${i}` });
  const row = fileOf(s).rows[0];
  assert.equal(row?.enabled, false);
  assert.equal(row?.seen, true, "switched rows count as seen; a later refusal does not make them new again");
  assert.equal((row?.aliases as string[]).length, MAX_PC_ALIASES);
  assert.equal((row?.aliases as string[]).at(-1), `a${MAX_PC_ALIASES + 2}`);
});

test("invalid refusals add nothing: unknown action / kind, empty or long label, target that cannot be a row", async () => {
  const { s } = await loaded();
  for (const bad of [
    { ...STEAM, action: "run_command" },
    { ...STEAM, kind: "shell" },
    { ...STEAM, label: "  " },
    { ...STEAM, label: "x".repeat(201) },
    { ...STEAM, id: "" },
    { ...SITE, id: "https://evil.example/path" },
    { ...VOLUME, id: "shutdown" },
  ] as PcTargetRef[]) {
    assert.deepEqual(await s.recordRefusal(bad), { ok: false, reason: "invalid" }, JSON.stringify(bad));
  }
  assert.equal(existsSync(s.file), false);
});

test("at most maxRows rows: at the limit a new target adds no row (logged), an existing row still counts", async () => {
  const { s, logs } = await loaded({ maxRows: 2 });
  await s.recordRefusal(STEAM);
  await s.recordRefusal(VOLUME);
  assert.deepEqual(await s.recordRefusal(SITE), { ok: false, reason: "full" });
  assert.ok(logs.some((l) => l.includes("full")));
  const again = await s.recordRefusal(STEAM);
  assert.ok(again.ok && !again.created);
  assert.equal((await s.list()).rows.length, 2);
});

test("one mutex: parallel refusals and switches all land in the file", async () => {
  const { s } = await loaded();
  const refs: PcTargetRef[] = [STEAM, VOLUME, SITE, { action: "lock", kind: "system", id: "lock", label: "Ekran kilidi" }];
  const results = await Promise.all(refs.map((r) => s.recordRefusal(r)));
  assert.ok(results.every((r) => r.ok));
  await Promise.all(results.map((r) => (r.ok ? s.setEnabled("android", r.rowId, true) : null)));
  const f = fileOf(s);
  assert.equal(f.rows.length, 4);
  assert.ok(f.rows.every((r) => r.enabled === true && r.changedBy === "android"));
});

// ------------------------------------------------------------------ the switch

test("setEnabled: listed device switches (logged with the device); repeat is a no-op; unknown row → unknown_item", async () => {
  const { s, logs } = await loaded();
  const r = await s.recordRefusal(STEAM);
  assert.ok(r.ok);
  assert.deepEqual(await s.setEnabled("browser", r.rowId, true), { ok: true, changed: true });
  assert.ok(logs.some((l) => l.includes(r.rowId) && l.includes("on") && l.includes("browser")));
  const before = readFileSync(s.file, "utf8");
  assert.deepEqual(await s.setEnabled("android", r.rowId, true), { ok: true, changed: false });
  assert.equal(readFileSync(s.file, "utf8"), before, "the same value again writes nothing");
  assert.deepEqual(await s.setEnabled("browser", "p-0000000000000000", true), { ok: false, code: "unknown_item" });
  const row = fileOf(s).rows[0];
  assert.equal(row?.changedBy, "browser");
  assert.equal(typeof row?.changedAt, "string");
});

test("setEnabled: a device outside the list, and anyone with the list empty → not_allowed, nothing changes", async () => {
  for (const managers of [["browser"], []]) {
    const { s } = await loaded({ managers });
    const r = await s.recordRefusal(STEAM);
    assert.ok(r.ok);
    const before = readFileSync(s.file, "utf8");
    assert.deepEqual(await s.setEnabled("android", r.rowId, true), { ok: false, code: "not_allowed" });
    if (managers.length === 0) assert.deepEqual(await s.setEnabled("browser", r.rowId, true), { ok: false, code: "not_allowed" });
    // not_allowed comes first: an unknown row does not tell an unlisted device anything either.
    assert.deepEqual(await s.setEnabled("android", "p-0000000000000000", true), { ok: false, code: "not_allowed" });
    assert.equal(readFileSync(s.file, "utf8"), before);
    assert.deepEqual(s.lookup(STEAM), { state: "off", rowId: r.rowId });
    assert.equal(s.canManage("android"), false);
  }
});

test("a failed write changes nothing in memory: internal, the row stays off; the next write works", async () => {
  let failRename = false;
  const fs: AtomicFs = {
    mkdir: (p, o) => nodeFs.mkdir(p, o),
    open: (p, f, m) => nodeFs.open(p, f, m),
    rename: async (a, b) => {
      if (failRename) throw Object.assign(new Error("denied"), { code: "EIO" });
      return nodeFs.rename(a, b);
    },
    unlink: (p) => nodeFs.unlink(p),
    readFile: (p, e) => nodeFs.readFile(p, e),
    readdir: (p) => nodeFs.readdir(p),
  };
  const { s, logs } = await loaded({ fs });
  const r = await s.recordRefusal(STEAM);
  assert.ok(r.ok);
  failRename = true;
  assert.deepEqual(await s.setEnabled("browser", r.rowId, true), { ok: false, code: "internal" });
  assert.deepEqual(s.lookup(STEAM), { state: "off", rowId: r.rowId });
  assert.deepEqual(await s.recordRefusal(VOLUME), { ok: false, reason: "write_failed" });
  assert.equal((await s.list()).rows.length, 1);
  assert.deepEqual(await s.markAllSeen(), { ok: false, code: "internal" });
  assert.equal(s.unseen, 1);
  assert.ok(logs.some((l) => l.includes("could not be written")));
  failRename = false;
  assert.deepEqual(await s.setEnabled("browser", r.rowId, true), { ok: true, changed: true });
  assert.equal(fileOf(s).rows[0]?.enabled, true);
});

// ------------------------------------------------------------------ seen and the badge

test("markAllSeen: every row seen, badge 0; the count goes to listeners only when it changes", async () => {
  const { s } = await loaded();
  const counts: number[] = [];
  const off = s.subscribe((n) => counts.push(n));
  await s.recordRefusal(STEAM);
  await s.recordRefusal(STEAM); // same row: count unchanged
  await s.recordRefusal(VOLUME);
  assert.equal(s.unseen, 2);
  assert.deepEqual(await s.markAllSeen(), { ok: true, changed: true });
  assert.equal(s.unseen, 0);
  assert.deepEqual(await s.markAllSeen(), { ok: true, changed: false });
  assert.deepEqual(counts, [1, 2, 0]);
  assert.ok(fileOf(s).rows.every((r) => r.seen === true));
  off();
  await s.recordRefusal(SITE);
  assert.deepEqual(counts, [1, 2, 0], "unsubscribed");
  s.close();
});

test("a store loaded with unseen rows publishes the count at load (for /health and the first broadcast)", async () => {
  const dir = newDir();
  const first = await loaded({ dir });
  await first.s.recordRefusal(STEAM);
  const { s } = store({ dir });
  const counts: number[] = [];
  s.subscribe((n) => counts.push(n));
  await s.load();
  assert.equal(s.unseen, 1);
  assert.deepEqual(counts, [1]);
});

// ------------------------------------------------------------------ fail closed

function writeRaw(dir: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, PC_PERMISSIONS_FILE);
  writeFileSync(file, content);
  return file;
}

test("corrupt file → quarantined, unavailable, and NOTHING is written (list, refusal, switch, seen)", async () => {
  for (const content of ["{not json", JSON.stringify({ version: 2, rows: [] }), JSON.stringify({ version: 1, rows: [{ id: "p-1" }] })]) {
    const dir = newDir();
    writeRaw(dir, content);
    const { s, logs } = await loaded({ dir });
    assert.equal(s.available, false);
    assert.ok(logs.some((l) => l.includes("unavailable") || l.includes("refused")), "one log line says why");
    const names = readdirSync(dir);
    assert.equal(names.includes(PC_PERMISSIONS_FILE), false, "moved aside");
    const corrupt = names.filter((n) => n.startsWith(`${PC_PERMISSIONS_FILE}.corrupt-`));
    assert.equal(corrupt.length, 1);
    assert.equal(readFileSync(join(dir, corrupt[0] as string), "utf8"), content, "the quarantined copy keeps the grants");

    assert.deepEqual(await s.list(), { available: false, rows: [], unseen: 0 });
    assert.deepEqual(await s.recordRefusal(STEAM), { ok: false, reason: "unavailable" });
    assert.deepEqual(await s.setEnabled("browser", pcRowId("open_app", "app", "steam_app_id"), true), { ok: false, code: "pc_permissions_unavailable" });
    assert.deepEqual(await s.markAllSeen(), { ok: false, code: "pc_permissions_unavailable" });
    assert.deepEqual(s.lookup(STEAM), { state: "unavailable" });
    assert.equal(s.unseen, 0);
    assert.deepEqual(readdirSync(dir).sort(), names.sort(), "no new file in the folder");
  }
});

test("corrupt rows: id that does not match its target, duplicate ids, non-canonical target id, unknown action → the whole file is invalid", async () => {
  const good = {
    id: pcRowId("open_app", "app", "steam_app_id"),
    action: "open_app",
    target: { kind: "app", id: "steam_app_id", label: "Steam" },
    aliases: [],
    enabled: true,
    seen: true,
    createdAt: "2026-11-14T18:00:00.000Z",
    lastRequestedAt: "2026-11-14T18:00:00.000Z",
    requests: 1,
    changedAt: "2026-11-14T18:01:00.000Z",
    changedBy: "browser",
  };
  // The good row alone loads.
  const okDir = newDir();
  writeRaw(okDir, JSON.stringify({ version: 1, rows: [good] }));
  const ok = await loaded({ dir: okDir });
  assert.equal(ok.s.available, true);
  assert.deepEqual(ok.s.lookup(STEAM), { state: "on", rowId: good.id });
  for (const rows of [
    [{ ...good, id: pcRowId("open_app", "app", "other") }],
    [good, good],
    [{ ...good, target: { ...good.target, id: "Steam_App_Id" }, id: pcRowId("open_app", "app", "Steam_App_Id") }],
    [{ ...good, action: "run" }],
    [{ ...good, requests: 0 }],
    [{ ...good, enabled: "yes" }],
    [{ ...good, changedAt: undefined }],
  ]) {
    const dir = newDir();
    writeRaw(dir, JSON.stringify({ version: 1, rows }));
    const { s } = await loaded({ dir });
    assert.equal(s.available, false, JSON.stringify(rows).slice(0, 120));
  }
});

test("unreadable file (a directory in its place) → unavailable, left in place, nothing written", async () => {
  const dir = newDir();
  mkdirSync(join(dir, PC_PERMISSIONS_FILE), { recursive: true });
  const { s } = await loaded({ dir });
  assert.equal(s.available, false);
  assert.deepEqual(await s.recordRefusal(STEAM), { ok: false, reason: "unavailable" });
  assert.deepEqual(readdirSync(dir), [PC_PERMISSIONS_FILE]);
});

test("a corrupt file that cannot be moved aside is unavailable too (no write over it)", async () => {
  const dir = newDir();
  const file = writeRaw(dir, "{broken");
  const fs: AtomicFs = {
    mkdir: (p, o) => nodeFs.mkdir(p, o),
    open: (p, f, m) => nodeFs.open(p, f, m),
    rename: async () => {
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    },
    unlink: (p) => nodeFs.unlink(p),
    readFile: (p, e) => nodeFs.readFile(p, e),
    readdir: (p) => nodeFs.readdir(p),
  };
  const { s } = await loaded({ dir, fs });
  assert.equal(s.available, false);
  assert.deepEqual(await s.recordRefusal(STEAM), { ok: false, reason: "unavailable" });
  assert.equal(readFileSync(file, "utf8"), "{broken");
});

test("before load() the store is unavailable (fail closed)", async () => {
  const { s } = store();
  assert.equal(s.available, false);
  assert.deepEqual(s.lookup(STEAM), { state: "unavailable" });
  assert.deepEqual(await s.recordRefusal(STEAM), { ok: false, reason: "unavailable" });
});

// ------------------------------------------------------------------ the coordinator's view (D3 structural separation)

test("pcPermissionView exposes lookup and recordRefusal only; nothing reachable from it switches a row", async () => {
  const { s } = await loaded();
  const view = pcPermissionView(s);
  assert.deepEqual(Object.keys(view).sort(), ["lookup", "recordRefusal"]);
  assert.equal(Object.isFrozen(view), true);
  assert.equal("setEnabled" in view, false);
  assert.equal("markAllSeen" in view, false);
  assert.equal(Object.getPrototypeOf(view), Object.prototype, "a plain object, not the store");
  const r = await view.recordRefusal(STEAM);
  assert.ok(r.ok && r.created);
  assert.deepEqual(view.lookup(STEAM), { state: "off", rowId: r.rowId }, "a refusal only ever creates a row off");
});

// ------------------------------------------------------------------ review round 1

test("restart after a quarantine: the file is missing but a .corrupt copy exists → still unavailable, nothing written", async () => {
  const dir = newDir();
  writeRaw(dir, "{corrupt");
  const first = await loaded({ dir });
  assert.equal(first.s.available, false);
  // Core restart without restoring anything.
  const { s, logs } = await loaded({ dir });
  assert.equal(s.available, false);
  assert.ok(logs.some((l) => l.includes("quarantined copy")));
  assert.deepEqual(await s.recordRefusal(STEAM), { ok: false, reason: "unavailable" });
  assert.equal(existsSync(s.file), false, "no fresh file over the lost grants");
  // Restoring the copy by hand (and restarting) brings the list back.
  const copy = readdirSync(dir).find((n) => n.startsWith(`${PC_PERMISSIONS_FILE}.corrupt-`)) as string;
  const good = await loaded();
  await good.s.recordRefusal(STEAM);
  writeFileSync(s.file, readFileSync(good.s.file, "utf8"));
  assert.ok(copy);
  const restored = await loaded({ dir });
  assert.equal(restored.s.available, true);
  assert.equal((await restored.s.list()).rows.length, 1);
});

test("site ids are idempotent: what is stored loads again (www.www., case, trailing dot, IDN); unstable inputs are refused", async () => {
  for (const [input, want] of [
    ["www.www.Example.com", "example.com"],
    ["WWW.example.com.", "example.com"],
    ["xn--bcher-kva.example", "xn--bcher-kva.example"],
    ["bücher.example", "xn--bcher-kva.example"],
  ] as const) {
    const c = canonicalHost(input);
    assert.equal(c, want, input);
    assert.equal(canonicalHost(c as string), c, `idempotent: ${input}`);
  }
  for (const unstable of ["example.com..", "a..b.com", ".example.com"]) assert.equal(canonicalHost(unstable), undefined, unstable);
  const dir = newDir();
  const first = await loaded({ dir });
  for (const id of ["www.www.example.com", "Example.ORG.", "bücher.example"]) {
    assert.ok((await first.s.recordRefusal({ ...SITE, id, label: id })).ok, id);
  }
  const again = await loaded({ dir });
  assert.equal(again.s.available, true, "the stored rows pass their own id check");
  assert.equal((await again.s.list()).rows.length, 3);
});

// ------------------------------------------------------------------ review round 2 (T17.2 acceptance gaps)

test("no main file and the folder cannot be listed (readdir EACCES) → unavailable, nothing written", async () => {
  const dir = newDir();
  mkdirSync(dir, { recursive: true });
  const fs: AtomicFs = {
    mkdir: (p, o) => nodeFs.mkdir(p, o),
    open: (p, f, m) => nodeFs.open(p, f, m),
    rename: (a, b) => nodeFs.rename(a, b),
    unlink: (p) => nodeFs.unlink(p),
    readFile: (p, e) => nodeFs.readFile(p, e),
    readdir: async () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    },
  };
  const { s } = await loaded({ dir, fs });
  assert.equal(s.available, false);
  assert.deepEqual(await s.recordRefusal(STEAM), { ok: false, reason: "unavailable" });
  assert.deepEqual(await s.setEnabled("browser", pcRowId("open_app", "app", "steam_app_id"), true), { ok: false, code: "pc_permissions_unavailable" });
  assert.equal(existsSync(s.file), false);
  assert.deepEqual(readdirSync(dir), [], "nothing written");
});

test("the .corrupt-* copies removed by hand, then a restart → empty and usable store", async () => {
  const dir = newDir();
  writeRaw(dir, "{corrupt");
  const first = await loaded({ dir });
  assert.equal(first.s.available, false);
  for (const n of readdirSync(dir)) if (n.startsWith(`${PC_PERMISSIONS_FILE}.corrupt-`)) rmSync(join(dir, n));
  const { s } = await loaded({ dir });
  assert.equal(s.available, true);
  assert.deepEqual(await s.list(), { available: true, rows: [], unseen: 0 });
  const r = await s.recordRefusal(STEAM);
  assert.ok(r.ok && r.created);
});
