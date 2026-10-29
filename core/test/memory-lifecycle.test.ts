/**
 * memory/lifecycle.ts (docs/06 M6/M7): extraction triggers and context
 * compaction with fake registry, extractor and provider. No SDK, no model.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ConversationLog } from "../src/conversation-log.js";
import type { ExtractReason, ExtractResult } from "../src/memory/extractor.js";
import {
  BRIEF_HEADING,
  COMPACT_INSTRUCTIONS,
  conversationForSummary,
  DeviceMaintenance,
  formatBrief,
  RETRY_AFTER_TURNS,
  SUMMARY_MAX_CHARS,
  type ExtractionPort,
  type MaintenanceRegistry,
} from "../src/memory/lifecycle.js";
import type { OneShotRequest, OneShotResult, ProviderCapabilities, ProviderSession } from "../src/model-provider.js";

const base = mkdtempSync(join(tmpdir(), "shadow-lifecycle-test-"));
after(() => rmSync(base, { recursive: true, force: true }));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeExtractor implements ExtractionPort {
  runs: Array<[string, ExtractReason]> = [];
  limits: number[] = [];
  turns = 0;
  every = 3;
  hook: (() => Promise<void>) | undefined;
  async maybeRun(device: string, reason: ExtractReason): Promise<ExtractResult> {
    this.runs.push([device, reason]);
    await this.hook?.();
    return { status: "skipped", reason: "too_few_turns" };
  }
  noteModelTurn(): boolean {
    this.turns++;
    return this.turns % this.every === 0;
  }
  async noteUsageLimit(until: number): Promise<void> {
    this.limits.push(until);
  }
}

class FakeSession implements Partial<ProviderSession> {
  busy = false;
  isClosed = false;
  compactCalls: string[] = [];
  compactResult = true;
  close(): void {
    this.isClosed = true;
  }
}

class FakeRegistry implements MaintenanceRegistry {
  capabilities: ProviderCapabilities = { setModel: true, compact: false, notes: true, resume: true };
  session: (FakeSession & { compact?: (i: string) => Promise<boolean> }) | undefined = new FakeSession();
  turnBusy = false;
  reseeds: string[] = [];
  reseedOk = true;
  sentCleared = 0;
  holds = 0;
  live(): ProviderSession | undefined {
    return this.session as unknown as ProviderSession | undefined;
  }
  isTurnBusy(): boolean {
    return this.turnBusy;
  }
  async hold<T>(_device: string, fn: () => Promise<T>): Promise<T> {
    this.holds++;
    return fn();
  }
  async reseed(_device: string, note: string): Promise<boolean> {
    this.reseeds.push(note);
    return this.reseedOk;
  }
  sentEntries(): { clear(): void } {
    return { clear: () => this.sentCleared++ };
  }
}

function provider(answer: Partial<OneShotResult> = {}) {
  const calls: OneShotRequest[] = [];
  return {
    calls,
    async oneShot(req: OneShotRequest): Promise<OneShotResult> {
      calls.push(req);
      return { status: "ok", text: "Kullanıcı mutfak ışığını yüzde 40 yaptırdı.", inputTokens: 100, outputTokens: 20, model: "haiku", ...answer };
    },
  };
}

function setup(o: { compactAtTokens?: number; answer?: Partial<OneShotResult>; conversation?: string; extractor?: FakeExtractor | null } = {}) {
  const registry = new FakeRegistry();
  const extractor = o.extractor === null ? undefined : (o.extractor ?? new FakeExtractor());
  const prov = provider(o.answer);
  const usage: unknown[] = [];
  const m = new DeviceMaintenance({
    registry,
    ...(extractor ? { extractor } : {}),
    provider: prov,
    summaryModel: "haiku",
    compactAtTokens: o.compactAtTokens ?? 50_000,
    idleExtractMs: 0,
    compactIdleMs: 15,
    compactTimeoutMs: 50,
    conversation: async () => o.conversation ?? "Kullanıcı: mutfak ışığını yüzde 40 yap\nShadow: Tamam.",
    usage: { append: (r) => usage.push(r) },
  });
  return { m, registry, extractor, prov, usage };
}

test("formatBrief: heading + lines, empty brief → empty string", () => {
  assert.equal(formatBrief("- Ad: Rıdvan\n"), `${BRIEF_HEADING}\n- Ad: Rıdvan`);
  assert.equal(formatBrief("  \n"), "");
});

test("extraction: every N model turns, after idle time, never after a new turn started; usage limit passed on", async () => {
  const extractor = new FakeExtractor();
  const m = new DeviceMaintenance({ extractor, provider: provider(), summaryModel: "h", compactAtTokens: 0, idleExtractMs: 20 });
  for (let i = 0; i < 3; i++) m.modelTurnEnded("browser");
  await wait(0);
  assert.deepEqual(extractor.runs, [["browser", "turns"]]);

  m.turnEnded("browser");
  await wait(40);
  assert.deepEqual(extractor.runs.at(-1), ["browser", "idle"]);

  extractor.runs = [];
  m.turnEnded("browser");
  m.turnStarted("browser"); // a new turn cancels the idle pass
  await wait(40);
  assert.deepEqual(extractor.runs, []);

  m.modelTurnEnded("browser", { usageLimited: true, retryAt: 1234 });
  await wait(0);
  assert.deepEqual(extractor.limits, [1234]);
  m.close();
});

test("startup pass runs for every device after the delay, one after another", async () => {
  const extractor = new FakeExtractor();
  const m = new DeviceMaintenance({ extractor, provider: provider(), summaryModel: "h", compactAtTokens: 0, idleExtractMs: 0 });
  m.startup(["browser", "phone"], 10);
  await wait(40);
  assert.deepEqual(extractor.runs, [
    ["browser", "startup"],
    ["phone", "startup"],
  ]);
  m.close();
});

test("compaction below the threshold or with compaction off: nothing", async () => {
  const s = setup();
  s.m.modelTurnEnded("browser", { contextTokens: 49_999 });
  await wait(40);
  assert.equal(s.registry.holds, 0);
  const off = setup({ compactAtTokens: 0 });
  off.m.modelTurnEnded("browser", { contextTokens: 900_000 });
  await wait(40);
  assert.equal(off.registry.holds, 0);
  s.m.close();
  off.m.close();
});

test("Core-side summary path: idle → extraction first → summary one-shot → reseed with the note", async () => {
  const s = setup();
  s.m.modelTurnEnded("browser", { contextTokens: 50_000 });
  await wait(60);
  assert.deepEqual(s.extractor?.runs, [["browser", "compact"]], "extraction before compaction");
  assert.equal(s.prov.calls.length, 1);
  assert.equal(s.prov.calls[0]?.model, "haiku");
  assert.match(s.prov.calls[0]?.prompt ?? "", /mutfak ışığını/);
  assert.deepEqual(s.registry.reseeds, ["(Önceki konuşmanın özeti: Kullanıcı mutfak ışığını yüzde 40 yaptırdı.)"]);
  assert.equal(s.registry.holds, 1);
  assert.deepEqual((s.usage[0] as { turnId: string }).turnId, "compact-summary");
  // Done: no second compaction until the threshold is reached again.
  const again = await s.m.compact("browser");
  assert.deepEqual(again, { status: "skipped", reason: "not_pending" });
  s.m.close();
});

test("compact capability: ProviderSession.compact with instructions, sent set cleared, no reseed", async () => {
  const s = setup();
  s.registry.capabilities = { ...s.registry.capabilities, compact: true };
  const sess = s.registry.session as FakeSession & { compact?: (i: string) => Promise<boolean> };
  sess.compact = async (i: string) => {
    sess.compactCalls.push(i);
    return true;
  };
  s.m.modelTurnEnded("browser", { contextTokens: 60_000 });
  s.m.turnEnded("browser");
  await wait(60);
  assert.deepEqual(sess.compactCalls, [COMPACT_INSTRUCTIONS]);
  assert.equal(s.registry.sentCleared, 1);
  assert.equal(s.registry.reseeds.length, 0);
  assert.equal(s.prov.calls.length, 0, "no summary call");
  s.m.close();
});

test("never during a turn: a running turn defers it; a new turn cancels the idle timer; the turn's end re-arms it", async () => {
  const s = setup();
  s.registry.turnBusy = true;
  s.m.modelTurnEnded("browser", { contextTokens: 70_000 });
  await wait(40);
  assert.equal(s.registry.holds, 0, "not armed while the turn lock is held");
  assert.deepEqual(await s.m.compact("browser"), { status: "skipped", reason: "busy" });
  s.registry.turnBusy = false;
  s.m.turnEnded("browser");
  s.m.turnStarted("browser");
  await wait(40);
  assert.equal(s.registry.holds, 0, "cancelled by the new turn");
  s.m.turnEnded("browser");
  await wait(60);
  assert.equal(s.registry.reseeds.length, 1);

  // A busy session (attempt running) also defers it.
  const b = setup();
  (b.registry.session as FakeSession).busy = true;
  b.m.modelTurnEnded("browser", { contextTokens: 70_000 });
  assert.deepEqual(await b.m.compact("browser"), { status: "skipped", reason: "busy" });
  s.m.close();
  b.m.close();
});

test("a turn that starts while the summary is made cancels the reseed (it is tried again after that turn)", async () => {
  const extractor = new FakeExtractor();
  const s = setup({ extractor });
  extractor.hook = async () => {
    s.m.turnStarted("browser");
  };
  s.m.modelTurnEnded("browser", { contextTokens: 70_000 });
  const r = await s.m.compact("browser");
  assert.deepEqual(r, { status: "skipped", reason: "turn_started" });
  assert.equal(s.registry.reseeds.length, 0);
  extractor.hook = undefined;
  s.m.turnEnded("browser");
  await wait(60);
  assert.equal(s.registry.reseeds.length, 1);
  s.m.close();
});

test("the idle timer firing during a run is armed again when that run ends (turn_started)", async () => {
  const extractor = new FakeExtractor();
  const s = setup({ extractor });
  let first = true;
  extractor.hook = async () => {
    if (!first) return;
    first = false;
    s.m.turnStarted("browser");
    s.m.turnEnded("browser"); // arms the idle timer (15 ms)
    await wait(40); // it fires while this run is still going: "running"
  };
  s.m.modelTurnEnded("browser", { contextTokens: 70_000 });
  assert.deepEqual(await s.m.compact("browser"), { status: "skipped", reason: "turn_started" });
  assert.equal(s.registry.reseeds.length, 0);
  await wait(60);
  assert.equal(s.registry.reseeds.length, 1, "re-armed without another user turn");
  s.m.close();
});

test("close() during extraction: no summary call; close() aborts a running summary call", async () => {
  const extractor = new FakeExtractor();
  const s = setup({ extractor });
  extractor.hook = async () => {
    s.m.close();
  };
  s.m.modelTurnEnded("browser", { contextTokens: 70_000 });
  assert.deepEqual(await s.m.compact("browser"), { status: "skipped", reason: "closed" });
  assert.equal(s.prov.calls.length, 0);

  const t = setup({ extractor: null });
  let seen: AbortSignal | undefined;
  let entered!: () => void;
  const inCall = new Promise<void>((r) => (entered = r));
  t.prov.oneShot = (req: OneShotRequest) =>
    new Promise<OneShotResult>((res) => {
      seen = req.signal;
      req.signal?.addEventListener("abort", () => res({ status: "cancelled", text: "", inputTokens: 0, outputTokens: 0, model: "haiku" }), {
        once: true,
      });
      entered();
    });
  t.m.modelTurnEnded("browser", { contextTokens: 70_000 });
  const run = t.m.compact("browser");
  await inCall;
  assert.equal(seen?.aborted, false);
  t.m.close();
  assert.equal(seen?.aborted, true);
  assert.deepEqual(await run, { status: "skipped", reason: "closed" });
  assert.equal(t.registry.reseeds.length, 0);
});

test("no live session: compaction is dropped (the next session reports its size again)", async () => {
  const s = setup();
  s.registry.session = undefined;
  s.m.modelTurnEnded("browser", { contextTokens: 70_000 });
  assert.deepEqual(await s.m.compact("browser"), { status: "skipped", reason: "no_session" });
  s.m.close();
});

test("failures (summary error, usage limit, reseed, compact timeout) retry only after 10 more model turns", async () => {
  const s = setup({ answer: { status: "error", text: "" } });
  s.m.modelTurnEnded("browser", { contextTokens: 70_000 });
  const r = await s.m.compact("browser");
  assert.equal(r.status, "failed");
  for (let i = 0; i < RETRY_AFTER_TURNS; i++) s.m.modelTurnEnded("browser", { contextTokens: 70_000 });
  assert.deepEqual(await s.m.compact("browser"), { status: "skipped", reason: "not_pending" });
  s.m.modelTurnEnded("browser", { contextTokens: 70_000 });
  assert.equal((await s.m.compact("browser")).status, "failed", "pending again after 10 turns");
  s.m.close();

  const lim = setup({ answer: { status: "usage_limit", text: "", retryAt: 777 } });
  lim.m.modelTurnEnded("browser", { contextTokens: 70_000 });
  assert.deepEqual(await lim.m.compact("browser"), { status: "failed", reason: "usage_limit" });
  assert.deepEqual(lim.extractor?.limits, [777]);
  lim.m.close();

  const rs = setup();
  rs.registry.reseedOk = false;
  rs.m.modelTurnEnded("browser", { contextTokens: 70_000 });
  assert.deepEqual(await rs.m.compact("browser"), { status: "failed", reason: "reseed_failed" });
  rs.m.close();

  const slow = setup();
  slow.registry.capabilities = { ...slow.registry.capabilities, compact: true };
  const sess = slow.registry.session as FakeSession & { compact?: (i: string) => Promise<boolean> };
  sess.compact = () => new Promise<boolean>(() => {});
  slow.m.modelTurnEnded("browser", { contextTokens: 70_000 });
  assert.deepEqual(await slow.m.compact("browser"), { status: "failed", reason: "compact_failed" });
  assert.equal(sess.isClosed, true, "a timed-out compaction's session is closed before the hold ends");
  assert.equal(slow.registry.sentCleared, 1);
  slow.m.close();

  // compact() answering false (no timeout) keeps the session.
  const no = setup();
  no.registry.capabilities = { ...no.registry.capabilities, compact: true };
  const nsess = no.registry.session as FakeSession & { compact?: (i: string) => Promise<boolean> };
  nsess.compact = async () => false;
  no.m.modelTurnEnded("browser", { contextTokens: 70_000 });
  assert.deepEqual(await no.m.compact("browser"), { status: "failed", reason: "compact_failed" });
  assert.equal(nsess.isClosed, false);
  no.m.close();

  const empty = setup({ conversation: "  " });
  empty.m.modelTurnEnded("browser", { contextTokens: 70_000 });
  assert.deepEqual(await empty.m.compact("browser"), { status: "failed", reason: "nothing_to_summarize" });
  empty.m.close();
});

test("the summary is cut to 1500 chars", async () => {
  const s = setup({ answer: { text: "a".repeat(5000) } });
  s.m.modelTurnEnded("browser", { contextTokens: 70_000 });
  await s.m.compact("browser");
  const note = s.registry.reseeds[0] ?? "";
  const body = note.replace(/^\(Önceki konuşmanın özeti: /, "").replace(/\)$/, "");
  assert.equal(body.length, SUMMARY_MAX_CHARS);
  s.m.close();
});

test("conversationForSummary: the device's turns from the Core log, redacted, newest within the budget", async () => {
  const dataDir = join(base, "log");
  const log = new ConversationLog(dataDir);
  await log.ensureDir();
  const s = log.session("sock-1");
  await s.append({ kind: "session_start", device: "browser" });
  await s.append({ kind: "user", id: "t1", text: "eski soru", source: "text" });
  await s.append({ kind: "assistant", id: "t1", text: "eski cevap" });
  await s.append({ kind: "user", id: "t2", text: "şifre: hunter2hunter2 olan wifi", source: "text" });
  await s.append({ kind: "assistant", id: "t2", text: "Tamam." });
  await s.flush();
  const other = log.session("sock-2");
  await other.append({ kind: "session_start", device: "phone" });
  await other.append({ kind: "user", id: "t1", text: "telefon sorusu", source: "text" });
  await other.flush();

  const text = await conversationForSummary(dataDir, "browser", Date.now());
  assert.match(text, /^Kullanıcı: eski soru\nShadow: eski cevap\nKullanıcı: /);
  assert.doesNotMatch(text, /hunter2|telefon/);
  const cut = await conversationForSummary(dataDir, "browser", Date.now(), 40);
  assert.doesNotMatch(cut, /eski soru/, "oldest turns dropped first");
});
