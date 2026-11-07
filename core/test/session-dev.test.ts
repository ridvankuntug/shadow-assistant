/**
 * T7.w.4b: the Development tab in the Core (`dev_list`, `dev_action`, the
 * badge count). Real learned-rule store and dev-note files in a temp dir;
 * Home Assistant and the model are mocked. Generic names only.
 *
 * - "Kuralı ekle" only from a device in CORE_DEV_DEVICES (unset = nobody);
 *   the rule is re-validated, becomes active, and the next matching
 *   utterance runs at tier 0 without a model;
 * - "Kaldır" (`remove_rule`) and "Yeniden aç" (`add_rule` on a suspended
 *   rule) with the same device limit (T7.w.8);
 * - "Yok say" / "Düzeltildi" from every device; actions are idempotent;
 * - errors: unknown_item, not_allowed, bad_request (tab disabled);
 * - items carry no user text, arguments or names; the count is published on change.
 */
import assert from "node:assert/strict";
import { mkdtempSync, promises as nodeFs, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AgentRunner, TurnCallbacks, TurnRequest, TurnResult } from "../src/agent.js";
import { ConversationLog } from "../src/conversation-log.js";
import { DevNotes, TurnNotes } from "../src/dev-notes.js";
import { learnPolicy, learnTargetFilter, type Extracted } from "../src/learn/extract.js";
import { LearnedRuleStore } from "../src/learn/store.js";
import type { AtomicFs } from "../src/atomic-file.js";
import type { DirectToolClient, DirectToolResult } from "../src/mcp-direct.js";
import { PermissionPolicy } from "../src/permissions.js";
import type { DevItem, ServerFrame } from "../src/protocol.js";
import { parseRouterConfig } from "../src/router-config.js";
import { TieredRouter } from "../src/router.js";
import { parseServices } from "../src/services.js";
import { DevelopmentTab, Session } from "../src/session.js";

const base = mkdtempSync(join(tmpdir(), "shadow-session-dev-test-"));
const open: Session[] = [];
const tabs: DevelopmentTab[] = [];
after(async () => {
  await Promise.all(open.map((s) => s.close("test_end")));
  for (const t of tabs) t.close();
  rmSync(base, { recursive: true, force: true });
});

const MODELS = { 1: "m-haiku", 2: "m-sonnet", 3: "m-opus" } as const;

const LIVE = JSON.stringify({
  result: [
    "Live Context: An overview of the areas and the devices in this smart home:",
    "- names: Salon Lamba",
    "  domain: light",
    "  state: 'off'",
    "  areas: Salon",
    "- names: Mutfak Lamba",
    "  domain: light",
    "  state: 'off'",
  ].join("\n"),
});

const routerYaml = (tools = "[intent__HassTurnOn, intent__HassTurnOff, light__HassLightSet]", domains?: string) => `
version: 1
rules:
  - id: light-on
    tier: 0
    patterns: ["<ad> ışığını aç"]
    service: home-assistant
    tool: intent__HassTurnOn
    domains: [light]
    keywords: [lamba]
    reply: "Tamam, {ad} ışığı açıldı."
learning:
  tools: ${tools}
${domains ? `  domains: ${domains}
` : ""}  keywords:
    light: [ışık, lamba]
`;

const SERVICES = parseServices(
  [
    "services:",
    "  - name: home-assistant",
    "    kind: mcp",
    "    url: http://localhost:1/sse",
    "    permission: confirm",
    "    tools:",
    '      "homeassistant__GetLiveContext": read',
    '      "intent__HassTurnOn": write',
    '      "light__HassLightSet": write',
  ].join("\n"),
  {},
).services;

const PATTERN: Extracted = {
  tokens: ["<ad>", "lambası", "parlaklığı", "yüzde", "<sayi>", "olsun"],
  service: "home-assistant",
  tool: "light__HassLightSet",
  domains: ["light"],
  keywords: ["lamba"],
  binding: { name: "ad", brightness: "sayi" },
  signature: "home-assistant|light__HassLightSet|light|name=ad|brightness=sayi",
};
const OTHER: Extracted = { ...PATTERN, tokens: ["<ad>", "lambasını", "yüzde", "<sayi>", "yap"] };

class MockHa implements DirectToolClient {
  writes: Array<{ tool: string; args: Record<string, unknown> }> = [];
  async callTool(_service: string, tool: string, args: Record<string, unknown>): Promise<DirectToolResult> {
    if (tool === "homeassistant__GetLiveContext") return { text: LIVE, isError: false };
    this.writes.push({ tool, args });
    return { text: "ok", isError: false };
  }
}

class MockAgent implements AgentRunner {
  calls = 0;
  async runTurn(_req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult> {
    this.calls++;
    cb.onDelta("Model cevabı.");
    return { text: "", inputTokens: 1, outputTokens: 1, durationMs: 1, sessionId: `sdk-${this.calls}`, tools: [] };
  }
}

let counter = 0;
async function harness(o: { managers?: string[]; device?: string; withTab?: boolean; dir?: string; tools?: string; domains?: string; fs?: AtomicFs } = {}) {
  const dir = o.dir ?? join(base, `d${++counter}`);
  const config = parseRouterConfig(routerYaml(o.tools, o.domains));
  const store = new LearnedRuleStore({ dir: join(dir, "fast-path"), config, log: () => {}, ...(o.fs ? { fs: o.fs, retryDelaysMs: [] } : {}) });
  await store.load();
  const toolNotes = new DevNotes({ dir: join(dir, "dev-notes") });
  const turnNotes = new TurnNotes({ dir: join(dir, "dev-notes"), coalesceMs: 0 });
  const infos: string[] = [];
  const tab = new DevelopmentTab({
    rules: store,
    toolNotes,
    turnNotes,
    managers: o.managers ?? [],
    logger: { info: (m) => infos.push(m), warn: () => {} },
    recountMs: 5,
  });
  tabs.push(tab);
  const counts: number[] = [];
  tab.subscribe((n) => counts.push(n));
  const policy = learnPolicy(config, SERVICES);
  const router = new TieredRouter({ config, models: MODELS, learned: { rules: () => store.snapshot(), targetFilter: learnTargetFilter(policy) } });
  const frames: ServerFrame[] = [];
  const ha = new MockHa();
  const agent = new MockAgent();
  const session = new Session(
    {
      agent,
      policy: new PermissionPolicy(SERVICES),
      router,
      stt: { transcribe: async () => ({ text: "" }) },
      tts: { synthesize: async () => ({ mime: "audio/wav", data: Buffer.from("RIFF") }), voices: async () => ({ default: "v", voices: ["v"] }) },
      log: new ConversationLog(dir),
      logger: { info: () => {}, warn: () => {} },
      direct: ha,
      ...(o.withTab === false ? {} : { dev: tab }),
    },
    { sessionId: `s${counter}`, device: o.device ?? "browser" },
    (f) => frames.push(f),
  );
  open.push(session);
  let req = 0;
  /** Sends a frame, returns the reply (`dev` or `error`) with its id. */
  const ask = async (frame: { type: "dev_list" } | { type: "dev_action"; itemId: string; action: "add_rule" | "ignore" | "fixed" | "remove_rule" }) => {
    const id = `d${++req}`;
    await session.handle({ ...frame, id } as Parameters<Session["handle"]>[0]);
    const reply = frames.find((f) => (f.type === "dev" || f.type === "error") && "id" in f && f.id === id);
    assert.ok(reply, `no reply to ${id}`);
    return reply as Extract<ServerFrame, { type: "dev" }> | Extract<ServerFrame, { type: "error" }>;
  };
  const list = async () => {
    const r = await ask({ type: "dev_list" });
    assert.equal(r.type, "dev");
    return r as Extract<ServerFrame, { type: "dev" }>;
  };
  let turn = 0;
  return {
    dir,
    store,
    toolNotes,
    turnNotes,
    tab,
    counts,
    infos,
    session,
    frames,
    ha,
    agent,
    ask,
    list,
    say: (text: string) => session.handle({ type: "user_text", id: `t${++turn}`, text }),
  };
}

async function candidate(h: Awaited<ReturnType<typeof harness>>, x: Extracted = PATTERN): Promise<string> {
  for (let i = 0; i < 3; i++) await h.store.observe(x);
  const r = (await h.store.list()).find((e) => e.tokens.join(" ") === x.tokens.join(" "));
  assert.equal(r?.status, "candidate");
  return r.id;
}

const errorCode = (r: { type: string; code?: string }) => (r.type === "error" ? r.code : r.type);
const ruleOf = (items: DevItem[], id: string) => items.find((i) => i.itemId === `r-${id}`);

async function until(pred: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ------------------------------------------------------------------ listing

test("dev_list: rule candidates and both note files, the badge count, canManage; no names in the frame", async () => {
  const h = await harness();
  const id = await candidate(h);
  await h.store.observe(OTHER); // still observing: not listed
  await h.toolNotes.recordCatalog("home-assistant", [{ name: "media__HassMediaPause", classified: false, level: "confirm" }]);
  await h.turnNotes.record({ kind: "tool_error", service: "home-assistant", tool: "intent__HassTurnOn", errorClass: "error", turnId: "t9" });
  const v = await h.list();
  assert.equal(v.canManage, false);
  assert.equal(v.open, 3);
  assert.equal(v.items.length, 3);
  const rule = ruleOf(v.items, id);
  assert.deepEqual(rule, {
    itemId: `r-${id}`,
    type: "rule",
    kind: "learned_rule",
    status: "candidate",
    message: "öğrenilen kural adayı: onay bekliyor",
    count: 3,
    firstSeen: rule?.firstSeen,
    lastSeen: rule?.lastSeen,
    rule: { tokens: PATTERN.tokens, tool: "light__HassLightSet", domains: ["light"], observations: 3 },
  });
  const notes = v.items.filter((i) => i.type === "note");
  assert.deepEqual(notes.map((n) => [n.kind, n.status, n.count]).sort(), [
    ["new_tool", "open", 1],
    ["tool_error", "open", 1],
  ]);
  for (const n of notes) assert.match(n.itemId, /^[tn]-[0-9a-f]{16}$/);
  const text = JSON.stringify(v);
  for (const leaked of ["media__HassMediaPause", "intent__HassTurnOn", "t9", "home-assistant"]) {
    assert.equal(text.includes(leaked), false, `a dev frame must not carry ${leaked}`);
  }
});

test("dev_list with the tab disabled is bad_request; canManage follows CORE_DEV_DEVICES and the token's device", async () => {
  const off = await harness({ withTab: false });
  assert.equal(errorCode(await off.ask({ type: "dev_list" })), "bad_request");
  const manager = await harness({ managers: ["browser"], device: "browser" });
  assert.equal((await manager.list()).canManage, true);
  const other = await harness({ managers: ["phone"], device: "browser" });
  assert.equal((await other.list()).canManage, false);
});

// ------------------------------------------------------------------ add_rule

test("add_rule from a listed device activates the candidate; the next matching utterance runs at tier 0", async () => {
  const h = await harness({ managers: ["browser"] });
  const id = await candidate(h);
  // Before: the model answers.
  await h.say("salon lambası parlaklığı yüzde 40 olsun");
  assert.equal(h.agent.calls, 1);
  assert.equal(h.ha.writes.length, 0);

  const r = await h.ask({ type: "dev_action", itemId: `r-${id}`, action: "add_rule" });
  assert.equal(r.type, "dev");
  assert.equal(ruleOf((r as Extract<ServerFrame, { type: "dev" }>).items, id)?.status, "active");
  assert.equal((r as Extract<ServerFrame, { type: "dev" }>).open, 0);
  const stored = (await h.store.list()).find((e) => e.id === id);
  assert.equal(stored?.status, "active");
  assert.equal(stored?.activatedBy, "browser");
  assert.ok(h.infos.some((m) => m.includes(`learned rule ${id} activated by device browser`)));

  await h.say("mutfak lambası parlaklığı yüzde 55 olsun");
  assert.equal(h.agent.calls, 1, "no model call after activation");
  assert.deepEqual(h.ha.writes.at(-1), { tool: "light__HassLightSet", args: { name: "Mutfak Lamba", domain: ["light"], brightness: 55 } });

  // Idempotent: add_rule on the active rule answers with the fresh list.
  const again = await h.ask({ type: "dev_action", itemId: `r-${id}`, action: "add_rule" });
  assert.equal(again.type, "dev");
});

test("add_rule with CORE_DEV_DEVICES unset or from another device is not_allowed; the rule stays a candidate", async () => {
  for (const managers of [[], ["phone"]]) {
    const h = await harness({ managers, device: "browser" });
    const id = await candidate(h);
    const r = await h.ask({ type: "dev_action", itemId: `r-${id}`, action: "add_rule" });
    assert.equal(errorCode(r), "not_allowed");
    assert.equal((await h.store.list()).find((e) => e.id === id)?.status, "candidate");
    assert.equal(h.store.snapshot().length, 0);
    await h.say("salon lambası parlaklığı yüzde 40 olsun");
    assert.equal(h.agent.calls, 1, "still the model");
  }
});

test("add_rule re-validates: a candidate the current router.yaml no longer allows is not_allowed", async () => {
  const learned = await harness({ managers: ["browser"] });
  const id = await candidate(learned);
  // Same data dir, learning narrowed to on/off: the brightness candidate is outside the ceiling now.
  const narrowed = await harness({ managers: ["browser"], dir: learned.dir, tools: "[intent__HassTurnOn, intent__HassTurnOff]" });
  const r = await narrowed.ask({ type: "dev_action", itemId: `r-${id}`, action: "add_rule" });
  assert.equal(errorCode(r), "not_allowed");
  assert.equal((await narrowed.store.list()).find((e) => e.id === id)?.status, "candidate");
});

// ------------------------------------------------------------------ ignore / fixed

test("ignore: a candidate is rejected and leaves the list (repeat answers the list)", async () => {
  const h = await harness();
  const id = await candidate(h);
  const r = await h.ask({ type: "dev_action", itemId: `r-${id}`, action: "ignore" });
  assert.equal(r.type, "dev");
  assert.equal(ruleOf((r as Extract<ServerFrame, { type: "dev" }>).items, id), undefined);
  assert.equal((await h.store.list())[0]?.status, "rejected");
  assert.equal((await h.ask({ type: "dev_action", itemId: `r-${id}`, action: "ignore" })).type, "dev");
  // Anything else on a rejected rule: it is not listed.
  assert.equal(errorCode(await h.ask({ type: "dev_action", itemId: `r-${id}`, action: "fixed" })), "unknown_item");
});

test("a suspended rule is listed and counted; fixed and remove_rule on it are not_allowed", async () => {
  const h = await harness({ managers: ["browser"] });
  const id = await candidate(h);
  assert.ok((await h.store.activate(id, "browser")).ok);
  for (let i = 0; i < 3; i++) await h.store.recordOutcome(id, "failure", "name_not_found");
  const v = await h.list();
  assert.equal(ruleOf(v.items, id)?.status, "suspended");
  assert.equal(v.open, 1);
  for (const action of ["fixed", "remove_rule"] as const) {
    assert.equal(errorCode(await h.ask({ type: "dev_action", itemId: `r-${id}`, action })), "not_allowed", action);
  }
  assert.equal((await h.store.list())[0]?.status, "suspended");
});

test("ignore on a suspended rule rejects it: it leaves the list and the badge drops to 0 (repeat answers the list)", async () => {
  const h = await harness({ managers: ["browser"] });
  const id = await candidate(h);
  assert.ok((await h.store.activate(id, "browser")).ok);
  for (let i = 0; i < 3; i++) await h.store.recordOutcome(id, "failure", "name_not_found");
  assert.equal((await h.list()).open, 1);
  const r = await h.ask({ type: "dev_action", itemId: `r-${id}`, action: "ignore" });
  assert.equal(r.type, "dev");
  const frame = r as Extract<ServerFrame, { type: "dev" }>;
  assert.equal(ruleOf(frame.items, id), undefined);
  assert.equal(frame.open, 0);
  assert.equal((await h.store.list())[0]?.status, "rejected");
  assert.equal((await h.ask({ type: "dev_action", itemId: `r-${id}`, action: "ignore" })).type, "dev");
});

test("ignore on an active rule is not_allowed and the rule stays active (removal is remove_rule)", async () => {
  const h = await harness({ managers: ["browser"] });
  const id = await candidate(h);
  assert.ok((await h.store.activate(id, "browser")).ok);
  assert.equal(errorCode(await h.ask({ type: "dev_action", itemId: `r-${id}`, action: "ignore" })), "not_allowed");
  assert.equal((await h.store.list())[0]?.status, "active");
});

test("notes: ignore and fixed from any device (idempotent), status stored; add_rule on a note and fixed on a rule are not_allowed", async () => {
  const h = await harness({ managers: ["browser"], device: "browser" });
  const id = await candidate(h);
  await h.turnNotes.record({ kind: "wandering", trigger: "calls", tier: 1, routeSource: "default", routeRule: "default", tools: ["a"], turnId: "t1" });
  await h.toolNotes.recordCatalog("home-assistant", [{ name: "media__HassMediaPause", classified: false, level: "confirm" }]);
  const v = await h.list();
  assert.equal(v.open, 3);
  const turnNote = v.items.find((i) => i.kind === "wandering") as DevItem;
  const toolNote = v.items.find((i) => i.kind === "new_tool") as DevItem;

  const r1 = (await h.ask({ type: "dev_action", itemId: turnNote.itemId, action: "fixed" })) as Extract<ServerFrame, { type: "dev" }>;
  assert.equal(r1.items.find((i) => i.itemId === turnNote.itemId)?.status, "fixed");
  assert.equal(r1.open, 2);
  assert.equal((await h.ask({ type: "dev_action", itemId: turnNote.itemId, action: "fixed" })).type, "dev");
  const r2 = (await h.ask({ type: "dev_action", itemId: toolNote.itemId, action: "ignore" })) as Extract<ServerFrame, { type: "dev" }>;
  assert.equal(r2.items.find((i) => i.itemId === toolNote.itemId)?.status, "ignored");
  assert.equal(r2.open, 1);
  assert.equal((await h.turnNotes.read()).notes[0]?.status, "fixed");
  assert.equal((await h.toolNotes.read()).notes[0]?.status, "ignored");

  assert.equal(errorCode(await h.ask({ type: "dev_action", itemId: toolNote.itemId, action: "add_rule" })), "not_allowed");
  assert.equal(errorCode(await h.ask({ type: "dev_action", itemId: `r-${id}`, action: "fixed" })), "not_allowed");
  // A fixed note seen again is open again (badge).
  await h.turnNotes.record({ kind: "wandering", trigger: "calls", tier: 1, routeSource: "default", routeRule: "default", tools: ["a"], turnId: "t2" });
  assert.equal((await h.list()).open, 2);
});

test("ignore and fixed work for a device outside CORE_DEV_DEVICES", async () => {
  const h = await harness({ managers: [], device: "android" });
  const id = await candidate(h);
  await h.turnNotes.record({ kind: "tool_error", service: "home-assistant", tool: "intent__HassTurnOn", errorClass: "unavailable" });
  const note = (await h.list()).items.find((i) => i.type === "note") as DevItem;
  assert.equal((await h.ask({ type: "dev_action", itemId: note.itemId, action: "fixed" })).type, "dev");
  assert.equal((await h.ask({ type: "dev_action", itemId: `r-${id}`, action: "ignore" })).type, "dev");
});

test("unknown item ids are unknown_item (rules, notes, other prefixes)", async () => {
  const h = await harness({ managers: ["browser"] });
  await h.store.observe(PATTERN); // observing: exists but not listed
  const observing = (await h.store.list())[0]?.id as string;
  for (const itemId of ["r-lr-00000000", `r-${observing}`, "n-0000000000000000", "t-0000000000000000", "x-1", "lr-00000000"]) {
    assert.equal(errorCode(await h.ask({ type: "dev_action", itemId, action: "ignore" })), "unknown_item", itemId);
  }
});

// ------------------------------------------------------------------ remove_rule / re-open (T7.w.8)

async function activeRule(h: Awaited<ReturnType<typeof harness>>): Promise<string> {
  const id = await candidate(h);
  assert.ok((await h.store.activate(id, "browser")).ok);
  return id;
}

async function suspendedRule(h: Awaited<ReturnType<typeof harness>>): Promise<string> {
  const id = await activeRule(h);
  for (let i = 0; i < 3; i++) await h.store.recordOutcome(id, "failure", "name_not_found");
  assert.equal((await h.store.list()).find((e) => e.id === id)?.status, "suspended");
  return id;
}

test("an active rule is listed but not counted in open", async () => {
  const h = await harness({ managers: ["browser"] });
  const id = await activeRule(h);
  const v = await h.list();
  assert.equal(ruleOf(v.items, id)?.status, "active");
  assert.equal(ruleOf(v.items, id)?.message, "öğrenilen kural etkin");
  assert.equal(v.open, 0);
});

test("remove_rule from a listed device: active → rejected, leaves the list and the snapshot, the model answers again", async () => {
  const h = await harness({ managers: ["browser"] });
  const id = await activeRule(h);
  await h.say("salon lambası parlaklığı yüzde 40 olsun");
  assert.equal(h.agent.calls, 0, "tier 0 while active");
  assert.equal((await h.list()).open, 0);

  const r = await h.ask({ type: "dev_action", itemId: `r-${id}`, action: "remove_rule" });
  assert.equal(r.type, "dev");
  const frame = r as Extract<ServerFrame, { type: "dev" }>;
  assert.equal(ruleOf(frame.items, id), undefined);
  assert.equal(frame.open, 0, "an active rule was never an open item");
  const stored = (await h.store.list()).find((e) => e.id === id);
  assert.equal(stored?.status, "rejected");
  assert.equal(stored?.removedBy, "browser");
  assert.equal(h.store.snapshot().length, 0);
  assert.ok(h.infos.some((m) => m.includes(`learned rule ${id} removed by device browser`)));

  await h.say("mutfak lambası parlaklığı yüzde 55 olsun");
  assert.equal(h.agent.calls, 1, "the model again after removal");
  // Never suggested again: more observations of the phrasing keep it rejected.
  for (let i = 0; i < 3; i++) await h.store.observe(PATTERN);
  assert.equal((await h.store.list()).find((e) => e.id === id)?.status, "rejected");
  assert.equal(ruleOf((await h.list()).items, id), undefined);

  // Idempotent: removing again answers with the fresh list; add_rule cannot bring it back.
  assert.equal((await h.ask({ type: "dev_action", itemId: `r-${id}`, action: "remove_rule" })).type, "dev");
  assert.equal(errorCode(await h.ask({ type: "dev_action", itemId: `r-${id}`, action: "add_rule" })), "unknown_item");
});

test("remove_rule and re-open with CORE_DEV_DEVICES unset or from another device are not_allowed; nothing changes", async () => {
  for (const managers of [[], ["phone"]]) {
    const h = await harness({ managers, device: "browser" });
    const active = await activeRule(h);
    const r = await h.ask({ type: "dev_action", itemId: `r-${active}`, action: "remove_rule" });
    assert.equal(errorCode(r), "not_allowed");
    assert.match((r as { message: string }).message, /may not remove rules/);
    assert.equal((await h.store.list()).find((e) => e.id === active)?.status, "active");
    assert.equal(h.store.snapshot().length, 1);
    for (let i = 0; i < 3; i++) await h.store.recordOutcome(active, "failure", "name_not_found");
    const again = await h.ask({ type: "dev_action", itemId: `r-${active}`, action: "add_rule" });
    assert.equal(errorCode(again), "not_allowed");
    assert.equal((await h.store.list()).find((e) => e.id === active)?.status, "suspended");
  }
});

test("remove_rule on a candidate or a note is not_allowed; on a rule never listed it is unknown_item", async () => {
  const h = await harness({ managers: ["browser"] });
  const id = await candidate(h);
  await h.turnNotes.record({ kind: "tool_error", service: "home-assistant", tool: "intent__HassTurnOn", errorClass: "error" });
  const note = (await h.list()).items.find((i) => i.type === "note") as DevItem;
  assert.equal(errorCode(await h.ask({ type: "dev_action", itemId: `r-${id}`, action: "remove_rule" })), "not_allowed");
  assert.equal(errorCode(await h.ask({ type: "dev_action", itemId: note.itemId, action: "remove_rule" })), "not_allowed");
  assert.equal((await h.store.list())[0]?.status, "candidate");
  await h.store.observe(OTHER); // observing: exists but not listed
  const observing = (await h.store.list()).find((e) => e.status === "observing")?.id as string;
  assert.equal(errorCode(await h.ask({ type: "dev_action", itemId: `r-${observing}`, action: "remove_rule" })), "unknown_item");
  assert.equal(errorCode(await h.ask({ type: "dev_action", itemId: "r-lr-00000000", action: "remove_rule" })), "unknown_item");
});

test("add_rule on a suspended rule re-opens it: active, failures reset, the badge drops, the next utterance runs at tier 0", async () => {
  const h = await harness({ managers: ["browser"] });
  const id = await suspendedRule(h);
  assert.equal((await h.list()).open, 1);
  assert.equal(h.store.snapshot().length, 0);
  const r = await h.ask({ type: "dev_action", itemId: `r-${id}`, action: "add_rule" });
  assert.equal(r.type, "dev");
  const frame = r as Extract<ServerFrame, { type: "dev" }>;
  assert.equal(ruleOf(frame.items, id)?.status, "active");
  assert.equal(frame.open, 0);
  const stored = (await h.store.list()).find((e) => e.id === id);
  assert.deepEqual([stored?.status, stored?.consecutiveFailures, stored?.lastFailure, stored?.activatedBy], ["active", 0, null, "browser"]);
  assert.ok(h.infos.some((m) => m.includes(`learned rule ${id} re-opened by device browser`)));
  await h.say("mutfak lambası parlaklığı yüzde 55 olsun");
  assert.equal(h.agent.calls, 0, "no model call after re-opening");
  assert.deepEqual(h.ha.writes.at(-1), { tool: "light__HassLightSet", args: { name: "Mutfak Lamba", domain: ["light"], brightness: 55 } });
  // Idempotent: a second add_rule answers with the list.
  assert.equal((await h.ask({ type: "dev_action", itemId: `r-${id}`, action: "add_rule" })).type, "dev");
});

test("re-open is re-validated: a suspended rule the current router.yaml no longer allows is not_allowed", async () => {
  const learned = await harness({ managers: ["browser"] });
  const id = await suspendedRule(learned);
  const narrowed = await harness({ managers: ["browser"], dir: learned.dir, tools: "[intent__HassTurnOn, intent__HassTurnOff]" });
  const r = await narrowed.ask({ type: "dev_action", itemId: `r-${id}`, action: "add_rule" });
  assert.equal(errorCode(r), "not_allowed");
  assert.match((r as { message: string }).message, /no longer allowed/);
  assert.equal((await narrowed.store.list()).find((e) => e.id === id)?.status, "suspended");
  assert.equal(narrowed.store.snapshot().length, 0);
});

test("remove_rule when the rule file cannot be written: internal error, the rule stays active and listed", async () => {
  let failRename = false;
  const fs: AtomicFs = {
    mkdir: (p, o) => nodeFs.mkdir(p, o),
    open: (p, f, m) => nodeFs.open(p, f, m),
    rename: (a, b) => (failRename ? Promise.reject(Object.assign(new Error("simulated"), { code: "EIO" })) : nodeFs.rename(a, b)),
    unlink: (p) => nodeFs.unlink(p),
    readFile: (p, e) => nodeFs.readFile(p, e),
    readdir: (p) => nodeFs.readdir(p),
  };
  const h = await harness({ managers: ["browser"], fs });
  const id = await activeRule(h);
  const before = (await h.list()).items;
  failRename = true;
  const r = await h.ask({ type: "dev_action", itemId: `r-${id}`, action: "remove_rule" });
  assert.equal(errorCode(r), "internal");
  assert.equal((await h.store.list()).find((e) => e.id === id)?.status, "active");
  assert.equal(h.store.snapshot().length, 1);
  assert.deepEqual((await h.list()).items, before);
  await h.say("salon lambası parlaklığı yüzde 40 olsun");
  assert.equal(h.agent.calls, 0, "still tier 0");
});

test("re-open is re-validated against domains: router.yaml learning.domains no longer lists the rule's domain → not_allowed", async () => {
  const learned = await harness({ managers: ["browser"] });
  const id = await suspendedRule(learned);
  const narrowed = await harness({ managers: ["browser"], dir: learned.dir, domains: "[switch]" });
  const r = await narrowed.ask({ type: "dev_action", itemId: `r-${id}`, action: "add_rule" });
  assert.equal(errorCode(r), "not_allowed");
  assert.match((r as { message: string }).message, /no longer allowed/);
  assert.equal((await narrowed.store.list()).find((e) => e.id === id)?.status, "suspended");
  assert.equal(narrowed.store.snapshot().length, 0);
});

test("remove_rule from a listed device whose name the rule file cannot store is not_allowed with its own message", async () => {
  const h = await harness({ managers: ["gerät"], device: "gerät" });
  const id = await candidate(h);
  assert.ok((await h.store.activate(id, "browser")).ok);
  const r = await h.ask({ type: "dev_action", itemId: `r-${id}`, action: "remove_rule" });
  assert.equal(errorCode(r), "not_allowed");
  assert.match((r as { message: string }).message, /removing device/);
  assert.equal((await h.store.list())[0]?.status, "active");
});

// ------------------------------------------------------------------ badge count

test("the badge count is published when it changes: actions, and changed() after a new note (coalesced)", async () => {
  const h = await harness({ managers: ["browser"] });
  const id = await candidate(h);
  await h.list();
  assert.deepEqual(h.counts, [1]);
  await h.list();
  assert.deepEqual(h.counts, [1], "an unchanged count is not published again");
  await h.ask({ type: "dev_action", itemId: `r-${id}`, action: "add_rule" });
  assert.deepEqual(h.counts, [1, 0]);
  await h.turnNotes.record({ kind: "missing_capability", reason: "builtin", tool: "Bash" });
  await h.turnNotes.record({ kind: "missing_capability", reason: "builtin", tool: "Read" });
  h.tab.changed();
  h.tab.changed();
  await until(() => h.counts.length === 3);
  assert.deepEqual(h.counts, [1, 0, 2]);
  assert.equal(h.tab.open, 2);
});

test("add_rule from a listed device whose name the rule file cannot store is not_allowed with its own message", async () => {
  const h = await harness({ managers: ["gerät"], device: "gerät" });
  const id = await candidate(h);
  const r = await h.ask({ type: "dev_action", itemId: `r-${id}`, action: "add_rule" });
  assert.equal(errorCode(r), "not_allowed");
  assert.match((r as { message: string }).message, /device name/);
  assert.equal((await h.store.list())[0]?.status, "candidate");
});
