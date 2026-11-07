/** Learned-rule store tests (T7.w.2c; docs/08 §Lifecycle, §Data file). Generic phrasings only. */
import assert from "node:assert/strict";
import * as nodeFs from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { AtomicFs } from "../src/atomic-file.js";
import { signatureOf, type Extracted } from "../src/learn/extract.js";
import { LEARNED_RULES_FILE, LearnedRuleStore, ruleId, type LearnedRuleRecord, type LearnedRulesFile } from "../src/learn/store.js";
import { parseRouterConfig, type CompiledRouterConfig } from "../src/router-config.js";

const base = mkdtempSync(join(tmpdir(), "shadow-learn-store-test-"));
after(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
const freshDir = () => join(base, `d${++n}`);
const config = parseRouterConfig("version: 1");

function clock(start = "2026-11-07T18:00:00.000Z") {
  let now = Date.parse(start);
  return { now: () => now, tick: (ms = 60_000) => (now += ms) };
}

function pattern(tokens: string[], tool: Extracted["tool"] = "light__HassLightSet", domain = "light"): Extracted {
  const binding: Extracted["binding"] = tool === "light__HassLightSet" ? { name: "ad", brightness: "sayi" } : { name: "ad" };
  const x = { tokens, service: "home-assistant", tool, domains: [domain] as [string], keywords: ["lamba"], binding };
  return { ...x, signature: signatureOf(x) };
}
const LEVEL = pattern(["<ad>", "parlaklığı", "yüzde", "<sayi>", "olsun"]);
const ON = pattern(["<ad>", "açılsın"], "intent__HassTurnOn");
const OFF_SAME_WORDS = pattern(["<ad>", "açılsın"], "intent__HassTurnOff");
const ON_SWITCH_SAME_WORDS = pattern(["<ad>", "açılsın"], "intent__HassTurnOn", "switch");

function store(dir: string, over: Partial<ConstructorParameters<typeof LearnedRuleStore>[0]> = {}) {
  const c = clock();
  const logs: string[] = [];
  const s = new LearnedRuleStore({ dir, config, now: c.now, log: (m) => logs.push(m), retryDelaysMs: [], ...over });
  return { s, c, logs };
}

const disk = (dir: string) => JSON.parse(readFileSync(join(dir, LEARNED_RULES_FILE), "utf8")) as LearnedRulesFile;
const byTokens = async (s: LearnedRuleStore, x: Extracted) => (await s.list()).find((r) => r.tokens.join(" ") === x.tokens.join(" "));

async function candidate(s: LearnedRuleStore, x: Extracted, times = 3): Promise<string> {
  let id = "";
  for (let i = 0; i < times; i++) id = (await s.observe(x))?.id ?? "";
  return id;
}

/** Real fs with a switch that fails the rename (a write interrupted before it lands). */
function flakyFs() {
  const state = { failRename: false };
  const fs: AtomicFs = {
    mkdir: (p, o) => nodeFs.mkdir(p, o),
    open: (p, f, m) => nodeFs.open(p, f, m),
    rename: (a, b) => (state.failRename ? Promise.reject(Object.assign(new Error("simulated"), { code: "EIO" })) : nodeFs.rename(a, b)),
    unlink: (p) => nodeFs.unlink(p),
    readFile: (p, e) => nodeFs.readFile(p, e),
    readdir: (p) => nodeFs.readdir(p),
  };
  return { fs, state };
}

describe("observations", () => {
  test("N same outcomes → candidate, never active", async () => {
    const { s } = store(freshDir());
    assert.equal((await s.observe(LEVEL))?.status, "observing");
    assert.equal((await s.observe(LEVEL))?.status, "observing");
    const third = await s.observe(LEVEL);
    assert.equal(third?.status, "candidate");
    assert.equal(third?.observations, 3);
    assert.equal(third?.id, ruleId(LEVEL.tokens, LEVEL.signature));
    assert.equal((await s.observe(LEVEL))?.status, "candidate");
    assert.equal(s.snapshot().length, 0);
  });

  test("min_observations comes from router.yaml", async () => {
    const { s } = store(freshDir(), { config: parseRouterConfig("version: 1\nlearning: { min_observations: 2 }") });
    await s.observe(ON);
    assert.equal((await s.observe(ON))?.status, "candidate");
  });

  test("a conflicting outcome restarts the count; a second conflict blocks the phrasing", async () => {
    const { s } = store(freshDir());
    await candidate(s, ON);
    const reset = await s.observe(OFF_SAME_WORDS);
    assert.equal(reset?.status, "observing");
    assert.equal(reset?.observations, 1);
    assert.equal(reset?.id, ruleId(OFF_SAME_WORDS.tokens, OFF_SAME_WORDS.signature));
    let r = await byTokens(s, ON);
    assert.equal(r?.conflicts, 1);
    assert.equal(r?.tool, "intent__HassTurnOff");
    assert.equal((await s.observe(ON_SWITCH_SAME_WORDS))?.status, "blocked");
    // Blocked: never suggested again, whatever comes.
    await candidate(s, ON_SWITCH_SAME_WORDS);
    r = await byTokens(s, ON);
    assert.equal(r?.status, "blocked");
    assert.equal(r?.observations, 1);
  });

  test("a rejected candidate keeps blocking the phrasing", async () => {
    const { s } = store(freshDir());
    const id = await candidate(s, LEVEL);
    assert.equal(await s.reject(id), true);
    await candidate(s, LEVEL, 5);
    const r = await byTokens(s, LEVEL);
    assert.equal(r?.status, "rejected");
    assert.equal(await s.reject(id), false);
    assert.deepEqual(await s.activate(id, "phone"), { ok: false, reason: "not_candidate" });
  });

  test("caps: least recently seen observing / discarded entries go first; candidates are kept", async () => {
    const { s, c } = store(freshDir(), { maxObserving: 2, maxDiscarded: 1 });
    const cand = await candidate(s, LEVEL);
    for (const w of ["bir", "iki", "üç"]) {
      c.tick();
      await s.observe(pattern(["<ad>", w], "intent__HassTurnOn"));
    }
    let words = (await s.list()).filter((r) => r.status === "observing").map((r) => r.tokens[1]);
    assert.deepEqual(words, ["iki", "üç"]);
    assert.ok((await s.list()).some((r) => r.id === cand && r.status === "candidate"));
    for (const w of ["dört", "beş"]) {
      c.tick();
      const id = await candidate(s, pattern(["<ad>", w], "intent__HassTurnOn"));
      await s.reject(id);
    }
    words = (await s.list()).filter((r) => r.status === "rejected").map((r) => r.tokens[1]);
    assert.deepEqual(words, ["beş"]);
  });
});

describe("activation", () => {
  test("candidate → active: re-validated, on disk, in the snapshot; survives a restart", async () => {
    const dir = freshDir();
    const { s } = store(dir);
    const id = await candidate(s, LEVEL);
    const res = await s.activate(id, "phone");
    assert.ok(res.ok);
    assert.equal(res.rule.activatedBy, "phone");
    assert.equal(s.snapshot().length, 1);
    assert.equal(s.snapshot()[0]?.def.id, id);
    assert.equal(disk(dir).rules[0]?.status, "active");
    const again = store(dir).s;
    await again.load();
    assert.equal(again.snapshot()[0]?.def.id, id);
    assert.deepEqual(await s.activate(id, "phone"), { ok: false, reason: "not_candidate" });
    assert.deepEqual(await s.activate("lr-00000000", "phone"), { ok: false, reason: "unknown" });
  });

  test("activation is applied only after the write; an interrupted write leaves the previous file intact", async () => {
    const dir = freshDir();
    const { fs, state } = flakyFs();
    const { s, logs } = store(dir, { fs });
    const id = await candidate(s, LEVEL);
    const before = readFileSync(join(dir, LEARNED_RULES_FILE), "utf8");
    state.failRename = true;
    assert.deepEqual(await s.activate(id, "phone"), { ok: false, reason: "write_failed" });
    assert.equal(s.snapshot().length, 0);
    assert.equal((await byTokens(s, LEVEL))?.status, "candidate");
    assert.equal(readFileSync(join(dir, LEARNED_RULES_FILE), "utf8"), before);
    assert.deepEqual(readdirSync(dir), [LEARNED_RULES_FILE]);
    assert.ok(logs.some((l) => /change not applied: EIO/.test(l)));
    state.failRename = false;
    assert.ok((await s.activate(id, "phone")).ok);
    assert.equal(s.snapshot().length, 1);
  });

  test("a failed observation write keeps the count in memory and is retried", async () => {
    const dir = freshDir();
    const { fs, state } = flakyFs();
    const { s } = store(dir, { fs });
    await s.observe(ON);
    state.failRename = true;
    await s.observe(ON);
    assert.equal(disk(dir).rules[0]?.observations, 1);
    state.failRename = false;
    await s.observe(ON);
    assert.equal(disk(dir).rules[0]?.observations, 3);
  });

  test("activation outside the current ceilings is refused", async () => {
    const dir = freshDir();
    const { s } = store(dir);
    const id = await candidate(s, ON_SWITCH_SAME_WORDS);
    const narrow = store(dir, { config: parseRouterConfig("version: 1\nlearning: { domains: [light] }") }).s;
    assert.deepEqual(await narrow.activate(id, "phone"), { ok: false, reason: "not_allowed" });
    assert.deepEqual(await s.activate(id, "bad device name!"), { ok: false, reason: "not_allowed" });
  });

  test("snapshot order: oldest activation first", async () => {
    const { s, c } = store(freshDir());
    const a = await candidate(s, ON);
    const b = await candidate(s, LEVEL);
    await s.activate(b, "phone");
    c.tick();
    await s.activate(a, "phone");
    assert.deepEqual(
      s.snapshot().map((r) => r.def.id),
      [b, a],
    );
  });
});

describe("outcomes and suspension", () => {
  async function activeRule(dir = freshDir(), over: Partial<ConstructorParameters<typeof LearnedRuleStore>[0]> = {}) {
    const h = store(dir, over);
    const id = await candidate(h.s, LEVEL);
    assert.ok((await h.s.activate(id, "phone")).ok);
    return { ...h, id, dir };
  }

  test("max_failures fallbacks in a row suspend; the snapshot drops the rule", async () => {
    const { s, id, dir, logs } = await activeRule();
    assert.deepEqual(await s.recordOutcome(id, "failure", "name_not_found"), { suspended: false });
    assert.deepEqual(await s.recordOutcome(id, "failure", "name_ambiguous"), { suspended: false });
    assert.deepEqual(await s.recordOutcome(id, "failure", "tool_error"), { suspended: true });
    assert.equal(s.snapshot().length, 0);
    const r = disk(dir).rules[0] as LearnedRuleRecord;
    assert.equal(r.status, "suspended");
    assert.equal(r.lastFailure, "tool_error");
    assert.ok(logs.some((l) => /suspended after 3 fallbacks/.test(l)));
    // No way back here (decision 4).
    assert.deepEqual(await s.activate(id, "phone"), { ok: false, reason: "not_candidate" });
    assert.deepEqual(await s.recordOutcome(id, "success"), { suspended: false });
    assert.equal((await s.list())[0]?.status, "suspended");
  });

  test("a success resets the count; neutral outcomes change nothing", async () => {
    const { s, id } = await activeRule();
    await s.recordOutcome(id, "failure", "name_not_found");
    await s.recordOutcome(id, "failure", "name_not_found");
    await s.recordOutcome(id, "success");
    await s.recordOutcome(id, "neutral");
    await s.recordOutcome(id, "failure", "name_not_found");
    await s.recordOutcome(id, "neutral");
    await s.recordOutcome(id, "failure", "name_not_found");
    const r = (await s.list())[0] as LearnedRuleRecord;
    assert.equal(r.status, "active");
    assert.equal(r.consecutiveFailures, 2);
    assert.equal(r.uses, 1);
  });

  test("max_failures comes from router.yaml", async () => {
    const { s, id } = await activeRule(freshDir(), { config: parseRouterConfig("version: 1\nlearning: { max_failures: 1 }") });
    assert.deepEqual(await s.recordOutcome(id, "failure", "tool_error"), { suspended: true });
  });

  test("reject(): a suspended rule becomes rejected; an active rule is never rejected", async () => {
    const { s } = store(freshDir());
    const id = await candidate(s, LEVEL);
    assert.ok((await s.activate(id, "phone")).ok);
    assert.equal(await s.reject(id), false);
    assert.equal((await s.list())[0]?.status, "active");
    for (let i = 0; i < 3; i++) await s.recordOutcome(id, "failure", "name_not_found");
    assert.equal((await s.list())[0]?.status, "suspended");
    assert.equal(await s.reject(id), true);
    assert.equal((await s.list())[0]?.status, "rejected");
    assert.equal(s.snapshot().length, 0);
    assert.equal(await s.reject(id), false);
    assert.deepEqual(await s.activate(id, "phone"), { ok: false, reason: "not_candidate" });
  });

  test("a rule router.yaml no longer allows is suspended (not_allowed) at load", async () => {
    const { dir, id } = await activeRule();
    const narrowed: CompiledRouterConfig = parseRouterConfig("version: 1\nlearning: { tools: [intent__HassTurnOn] }");
    const { s, logs } = store(dir, { config: narrowed });
    await s.load();
    assert.equal(s.snapshot().length, 0);
    const r = disk(dir).rules.find((x) => x.id === id);
    assert.equal(r?.status, "suspended");
    assert.equal(r?.lastFailure, "not_allowed");
    assert.ok(logs.some((l) => /no longer allowed/.test(l)));
  });
});

describe("file", () => {
  const record = (over: Partial<LearnedRuleRecord> = {}): LearnedRuleRecord => ({
    id: ruleId(ON.tokens, ON.signature),
    status: "observing",
    tokens: [...ON.tokens],
    normalizer: 1,
    service: "home-assistant",
    tool: "intent__HassTurnOn",
    domains: ["light"],
    keywords: ["lamba"],
    binding: { name: "ad" },
    observations: 2,
    conflicts: 1,
    firstSeen: "2026-11-07T18:00:00.000Z",
    lastSeen: "2026-11-07T18:00:00.000Z",
    activatedAt: null,
    activatedBy: null,
    uses: 0,
    consecutiveFailures: 0,
    lastFailure: null,
    ...over,
  });
  const write = (dir: string, body: unknown) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, LEARNED_RULES_FILE), typeof body === "string" ? body : JSON.stringify(body));
  };

  test("normalizer change: observing / candidate counts restart, active rules stay", async () => {
    const dir = freshDir();
    const lvl = record({ id: ruleId(LEVEL.tokens, LEVEL.signature), tokens: [...LEVEL.tokens], tool: "light__HassLightSet", binding: { name: "ad", brightness: "sayi" }, status: "candidate", observations: 3 });
    const act = record({ id: "lr-0000000a", tokens: ["<ad>", "yansın"], status: "active", activatedAt: "2026-11-07T18:00:00.000Z", activatedBy: "phone" });
    write(dir, { version: 1, rules: [record(), lvl, act] });
    const { s } = store(dir, { normalizer: 2 });
    await s.load();
    const rules = disk(dir).rules;
    assert.deepEqual(
      rules.map((r) => [r.status, r.observations, r.conflicts, r.normalizer]),
      [
        ["observing", 0, 0, 2],
        ["observing", 0, 0, 2],
        ["active", 2, 1, 1],
      ],
    );
    assert.equal(s.snapshot().length, 1);
    assert.equal((await s.observe(ON))?.observations, 1);
  });

  const bad: [string, unknown][] = [
    ["not JSON", "{ nope"],
    ["unknown version", { version: 2, rules: [] }],
    ["a pattern metacharacter in a token", { version: 1, rules: [record({ tokens: ["<ad>", "{aç|kapat}"] })] }],
    ["a <sayi> on a switch rule", { version: 1, rules: [record({ tokens: ["<ad>", "<sayi>", "yap"] })] }],
    ["an unknown status", { version: 1, rules: [record({ status: "approved" as never })] }],
    ["active without activatedBy", { version: 1, rules: [record({ status: "active", activatedAt: "2026-11-07T18:00:00.000Z" })] }],
    ["duplicate phrasing", { version: 1, rules: [record(), record({ id: "lr-0000000b" })] }],
    ["a bad binding", { version: 1, rules: [record({ binding: { name: "ad", floor: "x" } as never })] }],
  ];
  for (const [label, body] of bad) {
    test(`quarantined, starts empty with one warning: ${label}`, async () => {
      const dir = freshDir();
      write(dir, body);
      const { s, logs } = store(dir);
      await s.load();
      assert.equal(s.snapshot().length, 0);
      assert.deepEqual(await s.list(), []);
      assert.equal(logs.filter((l) => /moved aside/.test(l)).length, 1);
      assert.ok(readdirSync(dir).some((f) => f.startsWith(`${LEARNED_RULES_FILE}.corrupt-`)));
      assert.ok(!existsSync(join(dir, LEARNED_RULES_FILE)) || disk(dir).version === 1);
    });
  }

  test("every keyword router.yaml accepts survives a reload (no quarantine at the length limit)", async () => {
    const longest = "ı".repeat(64);
    const cfg = parseRouterConfig(`version: 1\nlearning:\n  keywords:\n    light: [${longest}, lamba]\n`);
    const keywords = [...(cfg.learning.keywords.light ?? [])];
    assert.deepEqual(keywords, [longest, "lamba"]);
    const dir = freshDir();
    const first = store(dir, { config: cfg });
    await first.s.observe({ ...LEVEL, keywords });
    const second = store(dir, { config: cfg });
    await second.s.load();
    assert.deepEqual((await second.s.list())[0]?.keywords, keywords);
    assert.equal(second.logs.filter((l) => /moved aside/.test(l)).length, 0);
  });

  test("the file holds tokens, tool, domain and counters only", async () => {
    const dir = freshDir();
    const { s } = store(dir);
    await candidate(s, LEVEL);
    const text = readFileSync(join(dir, LEARNED_RULES_FILE), "utf8");
    const keys = Object.keys(disk(dir).rules[0] as object).sort();
    assert.deepEqual(keys, [
      "activatedAt", "activatedBy", "binding", "conflicts", "consecutiveFailures", "domains", "firstSeen", "id", "keywords",
      "lastFailure", "lastSeen", "normalizer", "observations", "service", "status", "tokens", "tool", "uses",
    ]);
    assert.ok(!/salon|mutfak/i.test(text));
  });
});
