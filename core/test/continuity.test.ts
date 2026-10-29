import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import type { AtomicFs } from "../src/atomic-file.js";
import {
  CONTINUITY_FILE_VERSION,
  ContinuityStore,
  continuityFilePath,
  parseContinuityFile,
  V1_PROVIDER,
  type ContinuityLookup,
  type ContinuityStoreOptions,
} from "../src/continuity.js";

const root = mkdtempSync(join(tmpdir(), "shadow-continuity-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function freshFile(): string {
  const dataDir = join(root, `d${n++}`);
  return continuityFilePath(dataDir);
}

const MIN = 60_000;
const SID = "7c0e2f4a-1b2c-4d5e-8f90-123456789abc";
const SID2 = "11111111-2222-3333-4444-555555555555";
const P = "claude-sdk";
/** The resumed pointer (without lastTurnAt), or the non-resume result unchanged. */
const ptr = (r: ContinuityLookup) => (r.resume ? { provider: r.provider, sessionId: r.sessionId } : r);

function clock(start = 1_767_340_800_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function make(file: string, extra: Partial<ContinuityStoreOptions> = {}) {
  const logs: { level: string; message: string }[] = [];
  const c = clock();
  const store = new ContinuityStore({
    file,
    now: c.now,
    log: (level, message) => logs.push({ level, message }),
    retryDelaysMs: [0, 0, 0],
    ...extra,
  });
  return { store, logs, clock: c };
}

function readStored(file: string) {
  return JSON.parse(readFileSync(file, "utf8")) as { version: number; devices: Record<string, unknown> };
}

function writeStored(file: string, body: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
}

test("path is <dataDir>/sessions/devices.json", () => {
  assert.equal(continuityFilePath(join("x", "data")), join("x", "data", "sessions", "devices.json"));
});

test("no file: lookup → new conversation (none), nothing written", async () => {
  const file = freshFile();
  const { store } = make(file);
  assert.deepEqual(await store.lookup("browser"), { resume: false, reason: "none" });
  await store.flush();
  assert.equal(existsSync(file), false);
});

test("record then lookup within the window resumes; the file has only ids and times", async () => {
  const file = freshFile();
  const { store, clock: c } = make(file);
  await store.record("browser", { provider: P, sessionId: SID }, c.now());
  c.advance(29 * MIN);
  assert.deepEqual(ptr(await store.lookup("browser")), { provider: P, sessionId: SID });
  const stored = readStored(file);
  assert.equal(stored.version, CONTINUITY_FILE_VERSION);
  assert.deepEqual(Object.keys(stored.devices), ["browser"]);
  assert.deepEqual(Object.keys(stored.devices.browser as object).sort(), ["lastTurnAt", "provider", "sessionId", "updatedAt"]);
});

test("survives a restart: a new store reads the file", async () => {
  const file = freshFile();
  const a = make(file);
  await a.store.record("phone", { provider: P, sessionId: SID }, a.clock.now());
  const b = make(file, { now: () => a.clock.now() + 10 * MIN });
  assert.deepEqual(ptr(await b.store.lookup("phone")), { provider: P, sessionId: SID });
});

test("expiry: older than the window → new conversation and the entry is removed from the file", async () => {
  const file = freshFile();
  const { store, clock: c } = make(file);
  await store.record("browser", { provider: P, sessionId: SID }, c.now());
  await store.record("phone", { provider: P, sessionId: SID2 }, c.now() + 20 * MIN);
  c.advance(30 * MIN + 1);
  assert.deepEqual(await store.lookup("browser"), { resume: false, reason: "expired" });
  await store.flush();
  assert.deepEqual(Object.keys(readStored(file).devices), ["phone"]);
});

test("exactly at the window edge still resumes", async () => {
  const file = freshFile();
  const { store, clock: c } = make(file);
  await store.record("browser", { provider: P, sessionId: SID }, c.now());
  c.advance(30 * MIN);
  assert.equal((await store.lookup("browser")).resume, true);
});

test("window is a parameter (CORE_CONTINUITY_MIN); invalid values fall back to 30", async () => {
  const file = freshFile();
  const { store, clock: c } = make(file, { windowMin: 5 });
  await store.record("browser", { provider: P, sessionId: SID }, c.now());
  c.advance(5 * MIN + 1);
  assert.equal((await store.lookup("browser")).resume, false);

  const file2 = freshFile();
  const bad = make(file2, { windowMin: -1 });
  await bad.store.record("browser", { provider: P, sessionId: SID }, bad.clock.now());
  bad.clock.advance(29 * MIN);
  assert.equal((await bad.store.lookup("browser")).resume, true);
});

test("expired entries are pruned on load and on every write", async () => {
  const file = freshFile();
  const c = clock();
  writeStored(file, {
    version: 1,
    devices: {
      old: { sdkSessionId: SID, lastTurnAt: c.now() - 31 * MIN, updatedAt: c.now() - 31 * MIN },
      fresh: { sdkSessionId: SID2, lastTurnAt: c.now() - MIN, updatedAt: c.now() - MIN },
    },
  });
  const { store } = make(file, { now: c.now });
  assert.equal(await store.get("old"), undefined);
  await store.record("other", { provider: P, sessionId: SID }, c.now());
  assert.deepEqual(Object.keys(readStored(file).devices).sort(), ["fresh", "other"]);
});

test("a lastTurnAt far in the future counts as expired", async () => {
  const file = freshFile();
  const c = clock();
  writeStored(file, {
    version: 1,
    devices: { browser: { sdkSessionId: SID, lastTurnAt: c.now() + 365 * 24 * 60 * MIN, updatedAt: c.now() } },
  });
  const { store } = make(file, { now: c.now });
  assert.equal((await store.lookup("browser")).resume, false);
});

test("writes only when the session id or lastTurnAt changed", async () => {
  const file = freshFile();
  let writes = 0;
  const fs: AtomicFs = {
    mkdir: (p, o) => nodeFs.mkdir(p, o),
    open: (p, f, m) => nodeFs.open(p, f, m),
    rename: async (a, b) => {
      writes++;
      await nodeFs.rename(a, b);
    },
    unlink: (p) => nodeFs.unlink(p),
    readFile: (p, e) => nodeFs.readFile(p, e),
    readdir: (p) => nodeFs.readdir(p),
  };
  const { store, clock: c } = make(file, { fs });
  const t = c.now();
  await store.record("browser", { provider: P, sessionId: SID }, t);
  await store.record("browser", { provider: P, sessionId: SID }, t);
  assert.equal(writes, 1);
  await store.record("browser", { provider: P, sessionId: SID }, t + 1);
  assert.equal(writes, 2);
  await store.record("browser", { provider: P, sessionId: SID2 }, t + 1);
  assert.equal(writes, 3);
  assert.equal((await store.get("browser"))?.sessionId, SID2);
});

test("corrupt JSON: quarantined, one warning, store starts empty and keeps working", async () => {
  const file = freshFile();
  writeStored(file, "{not json");
  const { store, logs, clock: c } = make(file);
  assert.deepEqual(await store.lookup("browser"), { resume: false, reason: "none" });
  const warns = logs.filter((l) => l.level === "warn");
  assert.equal(warns.length, 1);
  assert.match(warns[0]!.message, /invalid_json/);
  assert.ok(readdirSync(dirname(file)).some((f) => f.startsWith("devices.json.corrupt-")));
  await store.record("browser", { provider: P, sessionId: SID }, c.now());
  assert.equal(readStored(file).version, 2);
});

test("unknown version and wrong shapes are treated as corrupt", async () => {
  const c = clock();
  const good = { sdkSessionId: SID, lastTurnAt: c.now(), updatedAt: c.now() };
  const cases: unknown[] = [
    { version: 2, devices: { browser: good } },
    { devices: { browser: good } },
    { version: 1 },
    { version: 1, devices: [] },
    { version: 1, devices: { browser: { ...good, sdkSessionId: "has spaces and text" } } },
    { version: 1, devices: { browser: { ...good, lastTurnAt: "yesterday" } } },
    { version: 1, devices: { "bad/name": good } },
    [1, 2],
    null,
  ];
  for (const body of cases) {
    const file = freshFile();
    writeStored(file, body);
    const { store, logs } = make(file, { now: c.now });
    assert.equal((await store.lookup("browser")).resume, false, JSON.stringify(body));
    assert.equal(logs.filter((l) => l.level === "warn").length, 1, JSON.stringify(body));
    assert.equal(existsSync(file), false, "moved away");
  }
});

test("parseContinuityFile keeps only the known entry fields", () => {
  const m = parseContinuityFile({
    version: 1,
    devices: { browser: { sdkSessionId: SID, lastTurnAt: 1, updatedAt: 2, text: "should not survive" } },
  });
  assert.deepEqual(m?.get("browser"), { provider: V1_PROVIDER, sessionId: SID, lastTurnAt: 1, updatedAt: 2 });
  const v2 = parseContinuityFile({
    version: 2,
    devices: { browser: { provider: "other", sessionId: SID, lastTurnAt: 1, updatedAt: 2, sdkSessionId: SID2 } },
  });
  assert.deepEqual(v2?.get("browser"), { provider: "other", sessionId: SID, lastTurnAt: 1, updatedAt: 2 });
});

test("version 1 file (no provider) is read as claude-sdk; the next write is version 2 with a provider", async () => {
  const file = freshFile();
  const c = clock();
  writeStored(file, { version: 1, devices: { browser: { sdkSessionId: SID, lastTurnAt: c.now() - MIN, updatedAt: c.now() - MIN } } });
  const checked: Array<[string, string]> = [];
  const { store } = make(file, {
    now: c.now,
    getSessionInfo: async (id, provider) => {
      checked.push([id, provider]);
      return { ok: true };
    },
  });
  assert.equal(V1_PROVIDER, "claude-sdk");
  assert.deepEqual(ptr(await store.lookup("browser")), { provider: "claude-sdk", sessionId: SID });
  assert.deepEqual(checked, [[SID, "claude-sdk"]], "the transcript check gets the provider");
  await store.record("phone", { provider: "other-llm", sessionId: SID2 }, c.now());
  const stored = readStored(file);
  assert.equal(stored.version, 2);
  assert.deepEqual(stored.devices.browser, { provider: "claude-sdk", sessionId: SID, lastTurnAt: c.now() - MIN, updatedAt: c.now() - MIN });
  assert.equal((stored.devices.phone as { provider: string }).provider, "other-llm");
  assert.deepEqual(ptr(await make(file, { now: c.now }).store.lookup("phone")), { provider: "other-llm", sessionId: SID2 });
});

test("version 2 entries without a valid provider are corrupt; an invalid provider is refused on record", async () => {
  const c = clock();
  const good = { provider: P, sessionId: SID, lastTurnAt: c.now(), updatedAt: c.now() };
  assert.ok(parseContinuityFile({ version: 2, devices: { browser: good } }));
  assert.equal(parseContinuityFile({ version: 2, devices: { browser: { ...good, provider: undefined } } }), undefined);
  assert.equal(parseContinuityFile({ version: 2, devices: { browser: { ...good, provider: "has spaces" } } }), undefined);
  const file = freshFile();
  const { store, logs } = make(file);
  await store.record("browser", { provider: "Bad Provider", sessionId: SID }, c.now());
  await store.flush();
  assert.equal(existsSync(file), false);
  assert.equal(logs.filter((l) => l.level === "warn").length, 1);
});

test("unreadable file (EACCES): warning, empty store, no throw", async () => {
  const file = freshFile();
  const fs: AtomicFs = {
    mkdir: (p, o) => nodeFs.mkdir(p, o),
    open: (p, f, m) => nodeFs.open(p, f, m),
    rename: (a, b) => nodeFs.rename(a, b),
    unlink: (p) => nodeFs.unlink(p),
    readFile: async () => {
      const e = new Error("denied") as NodeJS.ErrnoException;
      e.code = "EACCES";
      throw e;
    },
    readdir: (p) => nodeFs.readdir(p),
  };
  const { store, logs } = make(file, { fs });
  assert.deepEqual(await store.lookup("browser"), { resume: false, reason: "none" });
  assert.match(logs[0]!.message, /EACCES/);
});

test("write failure never throws; the next write carries the change", async () => {
  const file = freshFile();
  let fail = true;
  const fs: AtomicFs = {
    mkdir: (p, o) => nodeFs.mkdir(p, o),
    open: (p, f, m) => nodeFs.open(p, f, m),
    rename: async (a, b) => {
      if (fail) {
        const e = new Error("locked") as NodeJS.ErrnoException;
        e.code = "EPERM";
        throw e;
      }
      await nodeFs.rename(a, b);
    },
    unlink: (p) => nodeFs.unlink(p),
    readFile: (p, e) => nodeFs.readFile(p, e),
    readdir: (p) => nodeFs.readdir(p),
  };
  const { store, logs, clock: c } = make(file, { fs });
  await store.record("browser", { provider: P, sessionId: SID }, c.now());
  assert.equal(existsSync(file), false);
  assert.ok(logs.some((l) => l.level === "warn" && /EPERM/.test(l.message)));
  // In memory the entry is still there, so the turn's continuity works within this process.
  assert.equal((await store.lookup("browser")).resume, true);
  fail = false;
  await store.record("phone", { provider: P, sessionId: SID2 }, c.now());
  assert.deepEqual(Object.keys(readStored(file).devices).sort(), ["browser", "phone"]);
  assert.deepEqual(
    readdirSync(dirname(file)).filter((f) => f.includes(".tmp-")),
    [],
  );
});

test("serialized writes: concurrent records never overlap and the file ends with every change", async () => {
  const file = freshFile();
  let active = 0;
  let maxActive = 0;
  let renames = 0;
  const fs: AtomicFs = {
    mkdir: (p, o) => nodeFs.mkdir(p, o),
    open: (p, f, m) => nodeFs.open(p, f, m),
    rename: async (a, b) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      await nodeFs.rename(a, b);
      renames++;
      active--;
    },
    unlink: (p) => nodeFs.unlink(p),
    readFile: (p, e) => nodeFs.readFile(p, e),
    readdir: (p) => nodeFs.readdir(p),
  };
  const { store, clock: c } = make(file, { fs });
  const devices = Array.from({ length: 10 }, (_, i) => `dev${i}`);
  await Promise.all(devices.map((d, i) => store.record(d, { provider: P, sessionId: SID }, c.now() + i)));
  assert.equal(maxActive, 1, "one write at a time");
  assert.ok(renames < devices.length, `queued writes were coalesced (${renames} writes)`);
  assert.deepEqual(Object.keys(readStored(file).devices).sort(), [...devices].sort());
});

test("flush waits for a pending write", async () => {
  const file = freshFile();
  const { store, clock: c } = make(file);
  const p = store.record("browser", { provider: P, sessionId: SID }, c.now());
  await store.flush();
  assert.ok(existsSync(file));
  await p;
});

test("missing transcript (injected getSessionInfo): new conversation, entry removed, logged as missing", async () => {
  const file = freshFile();
  const asked: string[] = [];
  const { store, logs, clock: c } = make(file, {
    getSessionInfo: async (id) => {
      asked.push(id);
      return id === SID2 ? { sessionId: id } : undefined;
    },
  });
  await store.record("browser", { provider: P, sessionId: SID }, c.now());
  await store.record("phone", { provider: P, sessionId: SID2 }, c.now());
  assert.deepEqual(await store.lookup("browser"), { resume: false, reason: "missing" });
  assert.deepEqual(ptr(await store.lookup("phone")), { provider: P, sessionId: SID2 });
  assert.deepEqual(asked, [SID, SID2]);
  assert.ok(logs.some((l) => l.message === "continuity: missing (device browser)"));
  await store.flush();
  assert.deepEqual(Object.keys(readStored(file).devices), ["phone"]);
});

test("getSessionInfo throwing: no resume, entry kept for a later try", async () => {
  const file = freshFile();
  let broken = true;
  const { store, clock: c } = make(file, {
    getSessionInfo: async () => {
      if (broken) throw new Error("cli failed");
      return { ok: true };
    },
  });
  await store.record("browser", { provider: P, sessionId: SID }, c.now());
  assert.deepEqual(await store.lookup("browser"), { resume: false, reason: "check_failed" });
  broken = false;
  assert.deepEqual(ptr(await store.lookup("browser")), { provider: P, sessionId: SID });
});

test("invalid device names and non-id session ids are refused (no text can be stored)", async () => {
  const file = freshFile();
  const { store, logs, clock: c } = make(file);
  await store.record("browser", { provider: P, sessionId: "Kullanıcı şifresi 1234" }, c.now());
  await store.record("../evil", { provider: P, sessionId: SID }, c.now());
  await store.record("browser", { provider: P, sessionId: SID }, Number.NaN);
  await store.flush();
  assert.equal(existsSync(file), false);
  assert.equal(logs.filter((l) => l.level === "warn").length, 3);
  assert.ok(!logs.some((l) => l.message.includes("1234")), "the refused value is not logged");
});

test("forget removes an entry", async () => {
  const file = freshFile();
  const { store, clock: c } = make(file);
  await store.record("browser", { provider: P, sessionId: SID }, c.now());
  await store.forget("browser");
  assert.deepEqual(readStored(file).devices, {});
  await store.forget("nobody"); // no-op
});

test("a device named __proto__ is an ordinary key", async () => {
  const file = freshFile();
  const { store, clock: c } = make(file);
  await store.record("__proto__", { provider: P, sessionId: SID }, c.now());
  const raw = readFileSync(file, "utf8");
  assert.match(raw, /"__proto__"/);
  const again = make(file, { now: c.now });
  assert.deepEqual(ptr(await again.store.lookup("__proto__")), { provider: P, sessionId: SID });
});

// ---------------------------------------------------------------------------
// Review round 1 regressions

/** getSessionInfo whose answers the test releases one by one. */
function pendingChecks() {
  const calls: { id: string; answer: (v: unknown) => void }[] = [];
  let waiter: (() => void) | undefined;
  return {
    calls,
    getSessionInfo: (id: string) =>
      new Promise<unknown>((resolve) => {
        calls.push({ id, answer: resolve });
        waiter?.();
      }),
    /** Resolves once `n` checks have been asked. */
    asked: (n: number) =>
      new Promise<void>((resolve) => {
        const poll = () => (calls.length >= n ? resolve() : (waiter = poll));
        poll();
      }),
  };
}

test("lookup: forget() while the transcript check is pending → no resume, entry stays gone", async () => {
  const file = freshFile();
  const checks = pendingChecks();
  const { store, clock: c } = make(file, { getSessionInfo: checks.getSessionInfo });
  await store.record("browser", { provider: P, sessionId: SID }, c.now());
  const pending = store.lookup("browser");
  await checks.asked(1);
  await store.forget("browser");
  checks.calls[0]!.answer({ sessionId: SID });
  assert.deepEqual(await pending, { resume: false, reason: "none" });
  await store.flush();
  assert.deepEqual(readStored(file).devices, {});
});

test("lookup: record() of a new session while the old one is checked → decides on the new one", async () => {
  const file = freshFile();
  const checks = pendingChecks();
  const { store, clock: c } = make(file, { getSessionInfo: checks.getSessionInfo });
  await store.record("browser", { provider: P, sessionId: SID }, c.now());
  const pending = store.lookup("browser");
  await checks.asked(1);
  await store.record("browser", { provider: P, sessionId: SID2 }, c.now());
  checks.calls[0]!.answer(undefined); // the old transcript is gone…
  await checks.asked(2);
  assert.equal(checks.calls[1]!.id, SID2, "…so the current session is checked");
  checks.calls[1]!.answer({ sessionId: SID2 });
  assert.deepEqual(ptr(await pending), { provider: P, sessionId: SID2 });
  await store.flush();
  assert.deepEqual(Object.keys(readStored(file).devices), ["browser"], "the new entry was not removed");
});

test("lookup: the entry expires while the check is pending → expired, removed", async () => {
  const file = freshFile();
  const checks = pendingChecks();
  const { store, clock: c } = make(file, { getSessionInfo: checks.getSessionInfo });
  await store.record("browser", { provider: P, sessionId: SID }, c.now());
  const pending = store.lookup("browser");
  await checks.asked(1);
  c.advance(31 * MIN);
  checks.calls[0]!.answer({ sessionId: SID });
  assert.deepEqual(await pending, { resume: false, reason: "expired" });
});

test("a failed forget write is retried on flush; a restart does not bring the entry back", async () => {
  const file = freshFile();
  let fail = false;
  const fs: AtomicFs = {
    mkdir: (p, o) => nodeFs.mkdir(p, o),
    open: (p, f, m) => nodeFs.open(p, f, m),
    rename: async (a, b) => {
      if (fail) {
        const e = new Error("locked") as NodeJS.ErrnoException;
        e.code = "EPERM";
        throw e;
      }
      await nodeFs.rename(a, b);
    },
    unlink: (p) => nodeFs.unlink(p),
    readFile: (p, e) => nodeFs.readFile(p, e),
    readdir: (p) => nodeFs.readdir(p),
  };
  const { store, clock: c } = make(file, { fs });
  await store.record("browser", { provider: P, sessionId: SID }, c.now());
  fail = true;
  await store.forget("browser");
  assert.deepEqual(Object.keys(readStored(file).devices), ["browser"], "the delete did not reach the disk");
  fail = false; // the lock clears
  await store.flush();
  assert.deepEqual(readStored(file).devices, {});
  const again = make(file, { now: c.now });
  assert.deepEqual(await again.store.lookup("browser"), { resume: false, reason: "none" });
});

test("a failed write is retried by an unchanged record()", async () => {
  const file = freshFile();
  let fail = true;
  const fs: AtomicFs = {
    mkdir: (p, o) => nodeFs.mkdir(p, o),
    open: (p, f, m) => nodeFs.open(p, f, m),
    rename: async (a, b) => (fail ? Promise.reject(Object.assign(new Error("x"), { code: "EBUSY" })) : nodeFs.rename(a, b)),
    unlink: (p) => nodeFs.unlink(p),
    readFile: (p, e) => nodeFs.readFile(p, e),
    readdir: (p) => nodeFs.readdir(p),
  };
  const { store, clock: c } = make(file, { fs });
  const t = c.now();
  await store.record("browser", { provider: P, sessionId: SID }, t);
  assert.equal(existsSync(file), false);
  fail = false;
  await store.record("browser", { provider: P, sessionId: SID }, t);
  assert.deepEqual(Object.keys(readStored(file).devices), ["browser"]);
});
