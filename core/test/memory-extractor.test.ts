import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { dayStamp } from "../src/conversation-log.js";
import type { OneShotRequest, OneShotResult } from "../src/model-provider.js";
import type { UsageRecord } from "../src/router.js";
import { jaccard, MemoryExtractor, parseOps, type ExtractorOptions } from "../src/memory/extractor.js";
import { readDeviceTurns } from "../src/memory/log-source.js";
import { MemoryStore } from "../src/memory/store.js";

const T0 = new Date(2026, 9, 28, 12, 0, 0).getTime();
const MIN = 60_000;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Entry = Record<string, unknown> & { kind: string };

class FakeProvider {
  readonly requests: OneShotRequest[] = [];
  readonly results: (Partial<OneShotResult> | (() => Promise<Partial<OneShotResult>>))[] = [];
  async oneShot(req: OneShotRequest): Promise<OneShotResult> {
    this.requests.push(req);
    const next = this.results.shift() ?? { json: { ops: [] } };
    const r = typeof next === "function" ? await next() : next;
    return { status: "ok", text: "", inputTokens: 100, outputTokens: 20, model: req.model, ...r };
  }
}

function setup(over: Partial<ExtractorOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "shadow-extract-"));
  dirs.push(dir);
  const clock = { now: T0 };
  const logs: string[] = [];
  const logger = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) };
  const store = new MemoryStore({ dir: join(dir, "memory"), retryDelaysMs: [], now: () => clock.now, logger });
  const provider = new FakeProvider();
  const usage: UsageRecord[] = [];
  const ex = new MemoryExtractor({
    store,
    provider,
    dataDir: dir,
    model: "haiku",
    logger,
    usage: { append: (r) => usage.push(r) },
    now: () => clock.now,
    ...over,
  });
  /** Writes one session log for `device` (ts offsets in ms relative to T0). */
  const writeSession = (sessionId: string, device: string, entries: (Entry & { at: number })[], folder = dayStamp(new Date(T0))) => {
    const day = join(dir, "conversations", folder);
    mkdirSync(day, { recursive: true });
    const lines = [{ kind: "session_start", device, at: -60 * MIN }, ...entries].map(({ at, ...e }) =>
      JSON.stringify({ ts: T0 + at, sessionId, ...e }),
    );
    writeFileSync(join(day, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
    return join(day, `${sessionId}.jsonl`);
  };
  const turn = (id: string, at: number, user: string, assistant: string, extra: Entry[] = []): (Entry & { at: number })[] => [
    { kind: "user", id, text: user, source: "text", at },
    { kind: "route", id, tier: 1, model: "haiku", at: at + 1 },
    ...extra.map((e) => ({ ...e, id, at: at + 2 })),
    { kind: "assistant", id, text: assistant, at: at + 3 },
  ];
  return { dir, clock, logs, store, provider, usage, ex, writeSession, turn };
}

/** Two model turns 30 and 20 minutes before T0; the extractor runs at T0 with a cursor from before them. */
async function ready(over: Partial<ExtractorOptions> = {}) {
  const s = setup(over);
  s.writeSession("s1", "browser", [
    ...s.turn("t1", -30 * MIN, "Otomodos oturma odası demek, bunu hatırla.", "Tamam, not aldım."),
    ...s.turn("t2", -20 * MIN, "Akşamları ışığı yüzde 40 severim. Şifrem: hunter2xyz", "Anladım."),
  ]);
  await s.store.writeState({
    version: 1,
    devices: { browser: { cursorTs: T0 - 60 * MIN, lastRunAt: 0, modelTurnsSinceRun: 0 } },
    day: dayStamp(new Date(T0)),
    runsToday: 0,
    usageLimitUntil: 0,
  });
  return s;
}

test("a valid pass adds entries, moves the cursor, counts the run and records usage", async () => {
  const s = await ready();
  s.provider.results.push({
    json: {
      ops: [
        { op: "add", kind: "alias", text: "Otomodos = oturma odası", keywords: ["otomodos"] },
        { op: "add", kind: "preference", text: "Kullanıcı akşamları ışığı yüzde 40'ta kullanır.", keywords: ["isik"] },
      ],
    },
  });
  const r = await s.ex.maybeRun("browser", "idle");
  assert.deepEqual(r, { status: "done", added: 2, updated: 0, deleted: 0, rejected: 0 });

  const req = s.provider.requests[0];
  assert.ok(req);
  assert.equal(req.model, "haiku");
  assert.ok(req.schema && req.maxTokens <= 1000);
  assert.match(req.system ?? "", /kalıcı/);
  assert.match(req.prompt, /Otomodos oturma odası demek/);
  assert.doesNotMatch(req.prompt, /hunter2xyz/, "secrets are redacted before the call");
  assert.match(req.prompt, /\[gizli\]/);

  const entries = await s.store.entries();
  assert.deepEqual(entries.map((e) => [e.kind, e.source.by, e.source.turnId]), [
    ["alias", "extract", "t2"],
    ["preference", "extract", "t2"],
  ]);
  const st = await s.store.readState();
  assert.equal(st?.devices.browser?.cursorTs, T0 - 20 * MIN + 3);
  assert.equal(st?.devices.browser?.lastRunAt, T0);
  assert.equal(st?.runsToday, 1);
  assert.equal(s.usage.length, 1);
  assert.equal(s.usage[0]?.turnId, "memory-extract");
  assert.equal(s.usage[0]?.tier, undefined);
  for (const line of s.logs) {
    assert.doesNotMatch(line, /Otomodos|oturma|yüzde|hunter2/i, "log lines hold no text");
  }
  assert.ok(s.logs.some((l) => /add=2/.test(l) && /redacted\(secret=1\)/.test(l)));
});

test("skip rules: too few turns, tier-0 only, spacing, daily cap, busy", async () => {
  const one = setup();
  one.writeSession("s1", "browser", one.turn("t1", -5 * MIN, "Merhaba", "Selam"));
  await one.ex.init();
  // init with no state.json: new devices start now, so earlier turns are not read.
  assert.deepEqual(await one.ex.maybeRun("browser", "idle"), { status: "skipped", reason: "too_few_turns" });

  const direct = await ready();
  direct.writeSession("s1", "browser", [
    { kind: "user", id: "d1", text: "ışığı aç", source: "text", at: -10 * MIN },
    { kind: "route", id: "d1", tier: 0, rule: "light", at: -10 * MIN + 1 },
    { kind: "assistant", id: "d1", text: "Açtım.", at: -10 * MIN + 2 },
    { kind: "user", id: "d2", text: "ışığı kapat", source: "text", at: -9 * MIN },
    { kind: "route", id: "d2", tier: 0, rule: "light", at: -9 * MIN + 1 },
    { kind: "assistant", id: "d2", text: "Kapattım.", at: -9 * MIN + 2 },
  ]);
  assert.deepEqual(await direct.ex.maybeRun("browser", "idle"), { status: "skipped", reason: "nothing_to_learn" });
  assert.equal(direct.provider.requests.length, 0);
  assert.equal((await direct.store.readState())?.devices.browser?.cursorTs, T0 - 9 * MIN + 2);

  const s = await ready({ maxRunsPerDay: 2 });
  assert.equal((await s.ex.maybeRun("browser", "idle")).status, "done");
  s.writeSession("s2", "browser", [...s.turn("t3", 1 * MIN, "Ben Rıdvan", "Memnun oldum"), ...s.turn("t4", 2 * MIN, "Kedim var", "Güzel")]);
  s.clock.now = T0 + 5 * MIN;
  assert.deepEqual(await s.ex.maybeRun("browser", "idle"), { status: "skipped", reason: "too_soon" });
  // A compaction ignores the spacing, but not the daily cap.
  assert.equal((await s.ex.maybeRun("browser", "compact")).status, "done");
  s.clock.now = T0 + 60 * MIN;
  assert.deepEqual(await s.ex.maybeRun("browser", "idle"), { status: "skipped", reason: "daily_cap" });
  // A new day resets the counter (the next rule now applies: the turns are all processed).
  s.clock.now = T0 + 24 * 60 * MIN;
  assert.deepEqual(await s.ex.maybeRun("browser", "idle"), { status: "skipped", reason: "too_few_turns" });

  const b = await ready();
  let release!: () => void;
  let entered!: () => void;
  const inCall = new Promise<void>((r) => (entered = r));
  b.provider.results.push(
    () =>
      new Promise((res) => {
        release = () => res({ json: { ops: [] } });
        entered();
      }),
  );
  const first = b.ex.maybeRun("browser", "idle");
  // The first pass is inside its model call (release assigned): no timer race.
  await inCall;
  assert.deepEqual(await b.ex.maybeRun("browser", "idle"), { status: "skipped", reason: "busy" });
  release();
  assert.equal((await first).status, "done");
});

test("usage limit suspends passes until retryAt; the cursor stays", async () => {
  const s = await ready();
  s.provider.results.push({ status: "usage_limit", retryAt: T0 + 30 * MIN, inputTokens: 0, outputTokens: 0 });
  assert.deepEqual(await s.ex.maybeRun("browser", "idle"), { status: "failed", reason: "usage_limit" });
  const st = await s.store.readState();
  assert.equal(st?.usageLimitUntil, T0 + 30 * MIN);
  assert.equal(st?.devices.browser?.cursorTs, T0 - 60 * MIN);
  assert.equal(st?.runsToday, 0);
  s.clock.now = T0 + 20 * MIN;
  assert.deepEqual(await s.ex.maybeRun("browser", "compact"), { status: "skipped", reason: "usage_limit" });
  s.clock.now = T0 + 31 * MIN;
  assert.equal((await s.ex.maybeRun("browser", "idle")).status, "done");

  // Without retryAt: one hour. A limit hit by a live turn is noted too.
  const n = await ready();
  n.provider.results.push({ status: "usage_limit" });
  await n.ex.maybeRun("browser", "idle");
  assert.equal((await n.store.readState())?.usageLimitUntil, T0 + 60 * MIN);
  await n.ex.noteUsageLimit(T0 + 90 * MIN);
  assert.equal((await n.store.readState())?.usageLimitUntil, T0 + 90 * MIN);
});

test("errors and invalid output keep the cursor once, then move on", async () => {
  const s = await ready();
  s.provider.results.push({ status: "error", error: "boom" }, { json: { nope: true }, text: "not json" });
  assert.deepEqual(await s.ex.maybeRun("browser", "idle"), { status: "failed", reason: "error" });
  let st = await s.store.readState();
  assert.equal(st?.devices.browser?.cursorTs, T0 - 60 * MIN);
  assert.equal(st?.devices.browser?.failures, 1);
  assert.equal(st?.runsToday, 1);
  s.clock.now = T0 + 11 * MIN;
  assert.deepEqual(await s.ex.maybeRun("browser", "idle"), { status: "failed", reason: "invalid_output" });
  st = await s.store.readState();
  assert.equal(st?.devices.browser?.cursorTs, T0 - 20 * MIN + 3, "after two failures the turns are given up");
  assert.equal(st?.devices.browser?.failures, 0);
  // The answer text is parsed when the provider gave no structured json.
  const t = await ready();
  t.provider.results.push({ text: JSON.stringify({ ops: [{ op: "add", kind: "fact", text: "Kullanıcının bir kedisi var." }] }) });
  assert.equal((await t.ex.maybeRun("browser", "idle")).status, "done");
  assert.equal((await t.store.entries()).length, 1);
});

test("merge, dedupe, filters, tombstones and the delete cap", async () => {
  const s = await ready();
  const alias = await s.store.add({ kind: "alias", text: "Otomodos = oturma odası", keywords: ["otomodos"] });
  const pref = await s.store.add({ kind: "preference", text: "Kullanıcı akşamları caz dinlemeyi sever." });
  const d1 = await s.store.add({ kind: "fact", text: "Kullanıcının bir kedisi var." });
  const d2 = await s.store.add({ kind: "fact", text: "Kullanıcı Ankara'da yaşar." });
  const d3 = await s.store.add({ kind: "fact", text: "Kullanıcı bisiklet sürer." });
  await s.store.forget({ texts: ["Kullanıcı kahveyi sade içer."] });
  assert.ok(alias.ok && pref.ok && d1.ok && d2.ok && d3.ok);

  s.provider.results.push({
    json: {
      ops: [
        { op: "add", kind: "alias", text: "Otomodos = salon", keywords: ["otomodos"] }, // same left side → update
        { op: "add", kind: "preference", text: "Kullanıcı akşamları caz dinlemeyi sever" }, // duplicate
        { op: "add", kind: "fact", text: "Kullanıcı tansiyon ilacı kullanır." }, // health
        { op: "add", kind: "preference", text: "Kullanıcı kahveyi sade içer." }, // tombstone
        { op: "delete", id: d1.entry.id },
        { op: "delete", id: d2.entry.id }, // beyond MAX_OPS: dropped
      ],
    },
  });
  const r = await s.ex.maybeRun("browser", "idle");
  assert.deepEqual(r, { status: "done", added: 0, updated: 1, deleted: 1, rejected: 4 });
  const after = await s.store.entries();
  assert.equal(after.find((e) => e.id === alias.entry.id)?.text, "Otomodos = salon");
  assert.equal(after.length, 4);

  // The existing relevant entries (with ids) were given to the model.
  assert.match(s.provider.requests[0]?.prompt ?? "", new RegExp(`${alias.entry.id} \\[alias\\]`));

  s.clock.now = T0 + 11 * MIN;
  s.writeSession("s2", "browser", [...s.turn("t3", 1 * MIN, "Kedim yok artık", "Peki"), ...s.turn("t4", 2 * MIN, "Ankara'dan taşındım", "Tamam")]);
  s.provider.results.push({
    json: {
      ops: [
        { op: "delete", id: d2.entry.id },
        { op: "delete", id: d3.entry.id },
        { op: "delete", id: pref.entry.id }, // third delete: refused
        { op: "update", id: "m-000000", text: "Kullanıcı yürüyüşü sever." }, // unknown id
        { op: "add", kind: "preference", text: "Kullanıcı akşamları caz dinlemeyi çok sever." }, // Jaccard ≥ 0.8 → update
      ],
    },
  });
  assert.deepEqual(await s.ex.maybeRun("browser", "idle"), { status: "done", added: 0, updated: 1, deleted: 2, rejected: 2 });
  const left = await s.store.entries();
  assert.deepEqual(left.map((e) => e.id).sort(), [alias.entry.id, pref.entry.id].sort());
  assert.match(left.find((e) => e.id === pref.entry.id)?.text ?? "", /çok sever/);
});

test("log source: other devices, vault turns and Private lines stay out", async () => {
  const s = await ready();
  s.writeSession("other", "phone", s.turn("p1", -15 * MIN, "Telefon sırrı", "Tamam"));
  s.writeSession("s3", "browser", [
    ...s.turn("v1", -10 * MIN, "Notlarıma bak", "Notunda gizli plan yazıyor", [
      { kind: "tool_call", tool: "mcp__shadow-vault__read", level: "read", reason: "x", input: {} },
    ]),
    ...s.turn("v2", -9 * MIN, "Dosya Private/gunluk.md içinde\nKedimin adı Pamuk", "Pamuk güzel isim"),
  ]);
  const read = await readDeviceTurns(s.dir, "browser", T0 - 60 * MIN, new Date(T0));
  assert.deepEqual(read.turns.map((t) => t.id), ["t1", "t2", "v1", "v2"]);
  assert.deepEqual(read.turns[2]?.tools, ["mcp__shadow-vault__read"]);

  await s.ex.maybeRun("browser", "idle");
  const prompt = s.provider.requests[0]?.prompt ?? "";
  assert.doesNotMatch(prompt, /Telefon sırrı/);
  assert.match(prompt, /Notlarıma bak/);
  assert.doesNotMatch(prompt, /gizli plan/);
  assert.doesNotMatch(prompt, /Private/);
  assert.match(prompt, /Kedimin adı Pamuk/);
});

test("log source: the cursor stops before an unfinished turn, so its vault tool call is seen next time", async () => {
  const s = await ready();
  const vaultCall = { kind: "tool_call", tool: "mcp__shadow-vault__read", level: "read", reason: "x", input: {} };
  const file = s.writeSession("s1", "browser", [
    ...s.turn("t1", -30 * MIN, "Otomodos oturma odası demek, bunu hatırla.", "Tamam, not aldım."),
    ...s.turn("t2", -20 * MIN, "Akşamları ışığı yüzde 40 severim.", "Anladım."),
    { kind: "user", id: "v1", text: "Notlarıma bak", source: "text", at: -2 * MIN },
    { kind: "route", id: "v1", tier: 1, model: "haiku", at: -2 * MIN + 1 },
    { ...vaultCall, id: "v1", at: -2 * MIN + 2 },
  ]);
  const first = await readDeviceTurns(s.dir, "browser", T0 - 60 * MIN, new Date(T0));
  assert.deepEqual(first.turns.map((t) => t.id), ["t1", "t2"]);
  assert.equal(first.lastTs, T0 - 2 * MIN - 1, "cursor before the unfinished turn");
  assert.equal((await s.ex.maybeRun("browser", "idle")).status, "done");
  assert.equal((await s.store.readState())?.devices.browser?.cursorTs, T0 - 2 * MIN - 1);

  // The turn finishes with vault-derived text; a later turn follows.
  const more = [
    { kind: "assistant", id: "v1", text: "Notunda gizli plan yazıyor", at: 1 * MIN },
    ...s.turn("t3", 2 * MIN, "Kedimin adı Pamuk", "Güzel isim"),
  ].map(({ at, ...e }) => JSON.stringify({ ts: T0 + at, sessionId: "s1", ...e }));
  appendFileSync(file, `${more.join("\n")}\n`);
  s.clock.now = T0 + 15 * MIN;
  const second = await readDeviceTurns(s.dir, "browser", T0 - 2 * MIN - 1, new Date(s.clock.now));
  assert.deepEqual(second.turns.map((t) => [t.id, t.tools]), [["v1", ["mcp__shadow-vault__read"]], ["t3", []]]);
  assert.equal((await s.ex.maybeRun("browser", "idle")).status, "done");
  const prompt = s.provider.requests[1]?.prompt ?? "";
  assert.doesNotMatch(prompt, /gizli plan/);
  assert.match(prompt, /Kedimin adı Pamuk/);

  // A turn that never got an answer stops holding the cursor once it is stale.
  writeFileSync(file, readFileSync(file, "utf8").split("\n").filter((l) => !l.includes("gizli plan")).join("\n"));
  const stale = await readDeviceTurns(s.dir, "browser", T0 - 60 * MIN, new Date(T0 + 40 * MIN));
  assert.ok(stale.turns.some((t) => t.id === "v1"));
});

test("log source: files are found by mtime, not by the folder date; old folders are not scanned", async () => {
  const s = await ready();
  rmSync(join(s.dir, "conversations"), { recursive: true });
  const day3 = dayStamp(new Date(T0 - 3 * 24 * 60 * MIN));
  // A session that started three days ago and is still open.
  const open = s.writeSession("s1", "browser", [...s.turn("t1", -30 * MIN, "Merhaba", "Selam"), ...s.turn("t2", -20 * MIN, "Kedim var", "Güzel")], day3);
  s.writeSession("s0", "browser", s.turn("o1", -10 * MIN, "Çok eski", "Evet"), dayStamp(new Date(T0 - 20 * 24 * 60 * MIN)));
  const now = new Date(T0);
  utimesSync(open, now, now);
  assert.deepEqual((await readDeviceTurns(s.dir, "browser", T0 - 60 * MIN, now)).turns.map((t) => t.id), ["t1", "t2"]);
  // A file not modified since the cursor is not read.
  const before = new Date(T0 - 90 * MIN);
  utimesSync(open, before, before);
  assert.deepEqual((await readDeviceTurns(s.dir, "browser", T0 - 60 * MIN, now)).turns, []);
});

test("log source: a read error other than ENOENT fails the pass and keeps the cursor", async () => {
  const s = await ready();
  mkdirSync(join(s.dir, "conversations", dayStamp(new Date(T0)), "broken.jsonl"));
  await assert.rejects(readDeviceTurns(s.dir, "browser", T0 - 60 * MIN, new Date(T0)));
  assert.deepEqual(await s.ex.maybeRun("browser", "idle"), { status: "failed", reason: "error" });
  assert.equal(s.provider.requests.length, 0);
  assert.equal((await s.store.readState())?.devices.browser?.cursorTs, T0 - 60 * MIN);
  // A missing conversations folder is just empty.
  assert.deepEqual(await readDeviceTurns(join(s.dir, "nope"), "browser", 0, new Date(T0)), { turns: [], lastTs: 0 });
});

test("a missing state.json sets resetAt, which still applies after a restart", async () => {
  const s = setup();
  s.writeSession("s1", "browser", [...s.turn("t1", -5 * MIN, "Merhaba", "Selam"), ...s.turn("t2", -4 * MIN, "Kedim var", "Güzel")]);
  await s.ex.init();
  assert.equal((await s.store.readState())?.resetAt, T0);
  s.clock.now = T0 + 20 * MIN;
  const restarted = new MemoryExtractor({ store: s.store, provider: s.provider, dataDir: s.dir, model: "haiku", now: () => s.clock.now });
  await restarted.init();
  assert.deepEqual(await restarted.maybeRun("browser", "idle"), { status: "skipped", reason: "too_few_turns" });
  assert.equal(s.provider.requests.length, 0);
});

test("a failed state write fails the pass, blocks calls until saved, keeps limits; a re-run does not duplicate", async () => {
  const s = await ready();
  const realWrite = s.store.writeState.bind(s.store);
  let failWrites = true;
  s.store.writeState = async (st) => {
    if (failWrites) throw Object.assign(new Error("disk"), { code: "EIO" });
    return realWrite(st);
  };
  const ops = { json: { ops: [{ op: "add", kind: "fact", text: "Kullanıcının bir kedisi var." }] } };
  s.provider.results.push(ops);
  assert.deepEqual(await s.ex.maybeRun("browser", "idle"), { status: "failed", reason: "write_failed" });
  assert.equal((await s.store.entries()).length, 0, "the recovery record could not be written: nothing applied");
  assert.equal((await s.store.readState())?.devices.browser?.cursorTs, T0 - 60 * MIN, "disk state unchanged");

  // Still failing: no model call; a usage limit noted meanwhile holds in memory.
  s.clock.now = T0 + 11 * MIN;
  assert.deepEqual(await s.ex.maybeRun("browser", "compact"), { status: "failed", reason: "write_failed" });
  assert.equal(s.provider.requests.length, 1);
  await s.ex.noteUsageLimit(T0 + 30 * MIN);

  failWrites = false;
  assert.deepEqual(await s.ex.maybeRun("browser", "compact"), { status: "skipped", reason: "usage_limit" });
  const st = await s.store.readState();
  assert.equal(st?.devices.browser?.cursorTs, T0 - 60 * MIN, "the in-memory state was written; the cursor stays for the retry");
  assert.equal(st?.runsToday, 1);
  assert.equal(st?.pending, undefined);
  assert.equal(st?.usageLimitUntil, T0 + 30 * MIN);

  // A crash before the state write: a restart re-reads the same turns; the same op is a duplicate.
  const c = await ready();
  c.provider.results.push(ops);
  assert.equal((await c.ex.maybeRun("browser", "idle")).status, "done");
  await c.store.writeState({
    version: 1,
    devices: { browser: { cursorTs: T0 - 60 * MIN, lastRunAt: 0, modelTurnsSinceRun: 0 } },
    day: dayStamp(new Date(T0)),
    runsToday: 0,
    usageLimitUntil: 0,
  });
  const restarted = new MemoryExtractor({ store: c.store, provider: c.provider, dataDir: c.dir, model: "haiku", now: () => c.clock.now });
  c.provider.results.push(ops);
  assert.deepEqual(await restarted.maybeRun("browser", "idle"), { status: "done", added: 0, updated: 0, deleted: 0, rejected: 1 });
  assert.equal((await c.store.entries()).length, 1);
});

test("a state.json read error fails the pass and resets nothing", async () => {
  const s = await ready();
  const before = readFileSync(join(s.dir, "memory", "state.json"), "utf8");
  const realRead = s.store.readState.bind(s.store);
  let failReads = true;
  s.store.readState = async () => {
    if (failReads) throw Object.assign(new Error("io"), { code: "EIO" });
    return realRead();
  };
  await s.ex.init();
  assert.deepEqual(await s.ex.maybeRun("browser", "idle"), { status: "failed", reason: "error" });
  assert.equal(s.provider.requests.length, 0);
  assert.equal(readFileSync(join(s.dir, "memory", "state.json"), "utf8"), before, "state.json untouched");
  failReads = false;
  assert.equal((await s.ex.maybeRun("browser", "idle")).status, "done");
  assert.equal((await s.store.readState())?.resetAt, undefined);
});

test("a failed state write in the usage-limit branch is write_failed; the limit holds", async () => {
  const s = await ready();
  const realWrite = s.store.writeState.bind(s.store);
  let failWrites = true;
  s.store.writeState = async (st) => {
    if (failWrites) throw Object.assign(new Error("disk"), { code: "EIO" });
    return realWrite(st);
  };
  s.provider.results.push({ status: "usage_limit", retryAt: T0 + 45 * MIN });
  assert.deepEqual(await s.ex.maybeRun("browser", "idle"), { status: "failed", reason: "write_failed" });
  failWrites = false;
  assert.deepEqual(await s.ex.maybeRun("browser", "compact"), { status: "skipped", reason: "usage_limit" });
  assert.equal((await s.store.readState())?.usageLimitUntil, T0 + 45 * MIN);
  assert.equal(s.provider.requests.length, 1);
});

test("a crash after applying ops: the restart skips the range instead of calling again (no rephrased duplicate)", async () => {
  const s = await ready();
  const realWrite = s.store.writeState.bind(s.store);
  let crashed = false;
  s.store.writeState = async (st) => {
    if (crashed) throw Object.assign(new Error("crash"), { code: "EIO" });
    await realWrite(st);
    if (st.pending) crashed = true; // every write after the recovery record fails, like a dead process
  };
  s.provider.results.push({ json: { ops: [{ op: "add", kind: "fact", text: "Kullanıcının bir kedisi var." }] } });
  assert.deepEqual(await s.ex.maybeRun("browser", "idle"), { status: "failed", reason: "write_failed" });
  assert.equal((await s.store.entries()).length, 1);
  const onDisk = await s.store.readState();
  assert.deepEqual(onDisk?.pending, { device: "browser", fromTs: T0 - 60 * MIN, toTs: T0 - 20 * MIN + 3 });
  assert.equal(onDisk?.devices.browser?.cursorTs, T0 - 60 * MIN);

  // Restart: the model would rephrase the fact (Jaccard < 0.8), but it is not asked.
  s.store.writeState = realWrite;
  const restarted = new MemoryExtractor({ store: s.store, provider: s.provider, dataDir: s.dir, model: "haiku", now: () => s.clock.now });
  s.provider.results.push({ json: { ops: [{ op: "add", kind: "fact", text: "Evde kullanıcıya ait bir kedi yaşıyor." }] } });
  assert.deepEqual(await restarted.maybeRun("browser", "compact"), { status: "skipped", reason: "too_few_turns" });
  assert.equal(s.provider.requests.length, 1);
  assert.equal((await s.store.entries()).length, 1);
  const after = await s.store.readState();
  assert.equal(after?.pending, undefined);
  assert.equal(after?.devices.browser?.cursorTs, T0 - 20 * MIN + 3);
});

test("a failed recovery-record write applies nothing and the retry calls again", async () => {
  const s = await ready();
  const realWrite = s.store.writeState.bind(s.store);
  let failPending = true;
  s.store.writeState = async (st) => {
    if (failPending && st.pending) throw Object.assign(new Error("disk"), { code: "EIO" });
    return realWrite(st);
  };
  const ops = { json: { ops: [{ op: "add", kind: "fact", text: "Kullanıcının bir kedisi var." }] } };
  s.provider.results.push(ops);
  assert.deepEqual(await s.ex.maybeRun("browser", "idle"), { status: "failed", reason: "write_failed" });
  assert.equal((await s.store.entries()).length, 0);
  failPending = false;
  s.provider.results.push(ops);
  assert.equal((await s.ex.maybeRun("browser", "compact")).status, "done");
  assert.equal(s.provider.requests.length, 2);
  assert.equal((await s.store.entries()).length, 1);
  assert.equal((await s.store.readState())?.pending, undefined);
});

test("parseOps and jaccard", () => {
  assert.equal(parseOps({}), undefined);
  assert.equal(parseOps("x"), undefined);
  const p = parseOps({
    ops: [
      { op: "add", kind: "nope", text: "x" },
      { op: "update", id: "m-abcdef" },
      { op: "delete", id: "bad" },
      { op: "update", id: "m-abcdef", text: "Yeni" },
    ],
  });
  assert.deepEqual(p, { ops: [{ op: "update", id: "m-abcdef", text: "Yeni" }], invalid: 3 });
  assert.equal(jaccard("Kullanıcı caz sever", "kullanici caz sever."), 1);
  assert.ok(jaccard("a b c d", "a b c e") < 0.8);
});

test("the extraction prompt file exists and asks for durable facts only", () => {
  const text = readFileSync(new URL("../prompts/memory-extract.md", import.meta.url), "utf8");
  assert.match(text, /kalıcı/);
  assert.match(text, /bunu hatırla/);
});
