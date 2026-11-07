/**
 * T7.w.2d: pattern learning wired into the session. Home Assistant and the
 * model are mocked; nothing real is switched. Generic names only.
 *
 * - which model turns become observations (legacy runner and persistent attempts);
 * - learned rules run through the same gate (confirm_inputs, read-only) and
 *   fall back to the model silently; fallbacks in a row suspend the rule.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AgentRunner, TurnCallbacks, TurnRequest, TurnResult } from "../src/agent.js";
import { ConversationLog } from "../src/conversation-log.js";
import { learnPolicy, learnTargetFilter, type Extracted } from "../src/learn/extract.js";
import { LearnedRuleStore } from "../src/learn/store.js";
import type { DirectToolClient, DirectToolResult } from "../src/mcp-direct.js";
import type { AttemptHandle, AttemptOutcome, AttemptRequest, ProviderCapabilities, ProviderSession } from "../src/model-provider.js";
import { PermissionPolicy } from "../src/permissions.js";
import type { ServerFrame } from "../src/protocol.js";
import { parseRouterConfig } from "../src/router-config.js";
import { ESCALATION_MARKER, TieredRouter } from "../src/router.js";
import { parseServices } from "../src/services.js";
import { Session, type SessionRegistry } from "../src/session.js";

const base = mkdtempSync(join(tmpdir(), "shadow-session-learn-test-"));
const open: Session[] = [];
after(async () => {
  await Promise.all(open.map((s) => s.close("test_end")));
  rmSync(base, { recursive: true, force: true });
});

const HA = "mcp__home-assistant__";
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
    "- names: Mutfak Radyo",
    "  domain: media_player",
    "  state: 'off'",
  ].join("\n"),
});

const ROUTER_YAML = `
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
  keywords:
    light: [ışık, lamba]
`;

function servicesYaml(extra: string[] = []) {
  return parseServices(
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
      '      "intent__HassTurnOff": confirm',
      ...extra,
    ].join("\n"),
    {},
  ).services;
}

class MockHa implements DirectToolClient {
  calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  writeResult: DirectToolResult = { text: "ok", isError: false };
  live = LIVE;
  async callTool(_service: string, tool: string, args: Record<string, unknown>): Promise<DirectToolResult> {
    this.calls.push({ tool, args });
    if (tool === "homeassistant__GetLiveContext") return { text: this.live, isError: false };
    return this.writeResult;
  }
  get reads() {
    return this.calls.filter((c) => c.tool === "homeassistant__GetLiveContext").length;
  }
  get writes() {
    return this.calls.filter((c) => c.tool !== "homeassistant__GetLiveContext");
  }
}

/** One model tool call: through the gate, then its result. */
interface ToolUse {
  tool: string;
  args: Record<string, unknown>;
  isError?: boolean;
}

let useSeq = 0;
async function useTools(
  gate: TurnRequest["canUseTool"],
  onResult: ((id: string, name: string | undefined, isError: boolean) => void) | undefined,
  signal: AbortSignal | undefined,
  uses: ToolUse[],
): Promise<void> {
  for (const u of uses) {
    const id = `tu-${++useSeq}`;
    const d = await gate(`${HA}${u.tool}`, u.args, { signal: signal ?? new AbortController().signal, toolUseID: id });
    if (d.behavior === "allow") onResult?.(id, `${HA}${u.tool}`, u.isError === true);
  }
}

type Plan = { uses?: ToolUse[]; text?: string; error?: string; escalate?: boolean };

/** Legacy runner: each call follows the next plan in the queue (default: answer only). */
class MockAgent implements AgentRunner {
  calls: TurnRequest[] = [];
  queue: Plan[] = [];
  async runTurn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult> {
    this.calls.push(req);
    const plan = this.queue.shift() ?? {};
    await useTools(req.canUseTool, cb.onToolResult?.bind(cb), req.signal, plan.uses ?? []);
    cb.onDelta(plan.escalate ? ESCALATION_MARKER : (plan.text ?? "Tamam."));
    return { text: "", inputTokens: 1, outputTokens: 1, durationMs: 5, sessionId: `sdk-${this.calls.length}`, tools: [], ...(plan.error ? { error: plan.error } : {}) };
  }
}

/** Persistent mode: one live session whose attempts follow the plans; `settled` can be held. */
class FakeLive implements ProviderSession {
  readonly provider = "fake";
  sessionId: string | undefined = "sess-1";
  model: string = MODELS[1];
  busy = false;
  isClosed = false;
  queue: Plan[] = [];
  holdSettle = false;
  private readonly releases: Array<() => void> = [];
  ready(): Promise<void> {
    return Promise.resolve();
  }
  runAttempt(req: AttemptRequest): AttemptHandle {
    const plan = this.queue.shift() ?? {};
    const done = (async (): Promise<AttemptOutcome> => {
      await useTools(req.canUseTool, req.callbacks.onToolResult?.bind(req.callbacks), req.signal, plan.uses ?? []);
      req.callbacks.onDelta(plan.escalate ? ESCALATION_MARKER : (plan.text ?? "Tamam."));
      const status = req.signal?.aborted ? "cancelled" : "ok";
      return { text: "", inputTokens: 1, outputTokens: 1, durationMs: 5, status, model: req.model, warm: true, queryAgeMs: 0, doneMs: 1 };
    })();
    const settled = this.holdSettle ? done.then((o) => new Promise<AttemptOutcome>((res) => this.releases.push(() => res(o)))) : done;
    return { done, settled, sent: Promise.resolve(true) };
  }
  release(): void {
    for (const r of this.releases.splice(0)) r();
  }
  async appendNote(): Promise<boolean> {
    return true;
  }
  async setModel(m: string): Promise<void> {
    this.model = m;
  }
  async interrupt(): Promise<void> {}
  close(): void {
    this.isClosed = true;
  }
}

class FakeRegistry implements SessionRegistry {
  capabilities: ProviderCapabilities = { setModel: true, compact: false, notes: true, resume: true };
  constructor(private readonly live_: FakeLive) {}
  async acquire(): Promise<ProviderSession | undefined> {
    return this.live_;
  }
  live(): ProviderSession | undefined {
    return this.live_;
  }
  prewarm(): void {}
  private locked = false;
  beginTurn(): boolean {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }
  endTurn(): void {
    this.locked = false;
  }
  async fallbackResume(): Promise<string | undefined> {
    return undefined;
  }
  async turnEnded(): Promise<void> {}
}

let counter = 0;
function harness(o: { readOnly?: boolean; services?: ReturnType<typeof servicesYaml>; live?: FakeLive; yaml?: string } = {}) {
  const dir = join(base, `d${++counter}`);
  const config = parseRouterConfig(o.yaml ?? ROUTER_YAML);
  const services = o.services ?? servicesYaml();
  const store = new LearnedRuleStore({ dir: join(dir, "fast-path"), config, log: () => {} });
  const observed: Extracted[] = [];
  const outcomes: Array<[string, string, string | undefined]> = [];
  const spy = {
    observe: (x: Extracted) => {
      observed.push(x);
      return store.observe(x);
    },
    recordOutcome: (id: string, outcome: "success" | "failure" | "neutral", reason?: string) => {
      outcomes.push([id, outcome, reason]);
      return store.recordOutcome(id, outcome, reason);
    },
  };
  const policy = learnPolicy(config, services);
  const router = new TieredRouter({ config, models: MODELS, learned: { rules: () => store.snapshot(), targetFilter: learnTargetFilter(policy) } });
  const frames: ServerFrame[] = [];
  const waiters: Array<() => void> = [];
  const ha = new MockHa();
  const agent = new MockAgent();
  const session = new Session(
    {
      agent,
      ...(o.live ? { registry: new FakeRegistry(o.live) } : {}),
      policy: new PermissionPolicy(services, { readOnly: o.readOnly }),
      router,
      stt: { transcribe: async () => ({ text: "" }) },
      tts: { synthesize: async () => ({ mime: "audio/wav", data: Buffer.from("RIFF") }), voices: async () => ({ default: "v", voices: ["v"] }) },
      log: new ConversationLog(dir),
      logger: { info: () => {}, warn: () => {} },
      confirmTimeoutMs: 5_000,
      direct: ha,
      learning: { store: spy, policy, minObservations: config.learning.minObservations },
    },
    { sessionId: `s${counter}`, device: "browser" },
    (f) => {
      frames.push(f);
      waiters.splice(0).forEach((w) => w());
    },
  );
  open.push(session);
  let turn = 0;
  return {
    session,
    store,
    observed,
    outcomes,
    ha,
    agent,
    frames,
    say: (text: string) => session.handle({ type: "user_text", id: `t${++turn}`, text }),
    lastDone: () => (frames.filter((f) => f.type === "assistant_done").at(-1) as Extract<ServerFrame, { type: "assistant_done" }> | undefined)?.text,
    waitFor: (pred: (f: ServerFrame) => boolean, ms = 2000) =>
      new Promise<ServerFrame>((res, rej) => {
        const check = () => {
          const f = frames.find(pred);
          if (f) res(f);
          else waiters.push(check);
        };
        setTimeout(() => rej(new Error("timeout waiting for frame")), ms).unref();
        check();
      }),
  };
}

/** Waits until `pred` holds (observations run in turn tails, off the turn path). */
async function until(pred: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 5));
  }
}
/** Lets every pending tail finish (close() waits for tails). */
const drain = (h: ReturnType<typeof harness>) => h.session.close("drain");

const setLevel = (name: string, brightness: number, over: Partial<ToolUse> = {}): ToolUse => ({
  tool: "light__HassLightSet",
  args: { name, domain: ["light"], brightness },
  ...over,
});
const readCtx: ToolUse = { tool: "homeassistant__GetLiveContext", args: {} };

// ------------------------------------------------------------------ observations

test("three eligible turns of one phrasing make one candidate and no active rule", async () => {
  const h = harness();
  h.agent.queue.push(
    { uses: [readCtx, setLevel("Salon Lamba", 40)] },
    { uses: [setLevel("Mutfak Lamba", 70)] },
    { uses: [setLevel("Salon Lamba", 20)] },
  );
  await h.say("salon lambası parlaklığı yüzde 40 olsun");
  await until(() => h.observed.length === 1);
  await h.say("mutfak lambası parlaklığı yüzde yetmiş olsun");
  await until(() => h.observed.length === 2);
  await h.say("salon lambası parlaklığı yüzde 20 olsun");
  await until(() => h.observed.length === 3);
  const rules = await h.store.list();
  assert.equal(rules.length, 1);
  assert.equal(rules[0]?.status, "candidate");
  assert.deepEqual(rules[0]?.tokens, ["<ad>", "lambası", "parlaklığı", "yüzde", "<sayi>", "olsun"]);
  assert.equal(h.store.snapshot().length, 0);
  // Still the model: a candidate never runs.
  h.agent.queue.push({});
  await h.say("salon lambası parlaklığı yüzde 30 olsun");
  assert.equal(h.agent.calls.length, 4);
  assert.equal(h.ha.writes.length, 0);
});

test("observation is made after the turn, with the learner's own live-context read", async () => {
  const h = harness();
  h.agent.queue.push({ uses: [setLevel("Salon Lamba", 40)] });
  await h.say("salon lambası parlaklığı yüzde 40 olsun");
  assert.ok(h.frames.some((f) => f.type === "assistant_done"));
  await until(() => h.observed.length === 1);
  assert.equal(h.ha.reads, 1);
  assert.equal(h.ha.writes.length, 0); // the model's call went through the gateway, not the direct client
});

async function noObservation(h: ReturnType<typeof harness>, text: string): Promise<void> {
  await h.say(text);
  await drain(h);
  assert.equal(h.observed.length, 0);
  assert.equal(h.ha.reads, 0, "an ineligible turn costs no live-context read");
}

test("a confirm-level call is never learned", async () => {
  const h = harness();
  h.agent.queue.push({ uses: [{ tool: "intent__HassTurnOff", args: { name: "Salon Lamba", domain: ["light"] } }] });
  const turn = h.say("salon lambası kapansın");
  const req = (await h.waitFor((f) => f.type === "confirm_request")) as Extract<ServerFrame, { type: "confirm_request" }>;
  await h.session.handle({ type: "confirm_response", requestId: req.requestId, approved: true });
  await turn;
  await drain(h);
  assert.equal(h.observed.length, 0);
});

test("two action calls, an isError result, a denied call: no observation", async () => {
  const two = harness();
  two.agent.queue.push({ uses: [setLevel("Salon Lamba", 40), setLevel("Mutfak Lamba", 40)] });
  await noObservation(two, "salon lambası parlaklığı yüzde 40 olsun");

  const err = harness();
  err.agent.queue.push({ uses: [setLevel("Salon Lamba", 40, { isError: true })] });
  await noObservation(err, "salon lambası parlaklığı yüzde 40 olsun");

  const ro = harness({ readOnly: true });
  ro.agent.queue.push({ uses: [setLevel("Salon Lamba", 40)] });
  await noObservation(ro, "salon lambası parlaklığı yüzde 40 olsun");
});

test("a static tier-0 fallback turn is never learned from", async () => {
  const h = harness();
  h.agent.queue.push({ uses: [{ tool: "intent__HassTurnOn", args: { name: "Salon Lamba", domain: ["light"] } }] });
  await h.say("bilinmeyen ışığını aç"); // static rule, name not found → tier 1
  await drain(h);
  assert.equal(h.agent.calls.length, 1);
  assert.equal(h.observed.length, 0);
});

test("an escalated turn with an action in each attempt is not learned (legacy and persistent)", async () => {
  const legacy = harness();
  legacy.agent.queue.push({ uses: [setLevel("Salon Lamba", 40)], escalate: true }, { uses: [setLevel("Salon Lamba", 40)] });
  await noObservation(legacy, "salon lambası parlaklığı yüzde 40 olsun");
  assert.equal(legacy.agent.calls.length, 2);

  const live = new FakeLive();
  const p = harness({ live });
  live.queue.push({ uses: [setLevel("Salon Lamba", 40)], escalate: true }, { uses: [setLevel("Salon Lamba", 40)] });
  await noObservation(p, "salon lambası parlaklığı yüzde 40 olsun");
});

test("an escalated turn whose only action is in the second attempt is one observation", async () => {
  const live = new FakeLive();
  const h = harness({ live });
  live.queue.push({ escalate: true }, { uses: [setLevel("Salon Lamba", 40)] });
  await h.say("salon lambası parlaklığı yüzde 40 olsun");
  await until(() => h.observed.length === 1);
});

test("a cancelled turn and a model error make none", async () => {
  const h = harness();
  h.agent.queue.push({ uses: [setLevel("Salon Lamba", 40)], error: "boom" });
  await noObservation(h, "salon lambası parlaklığı yüzde 40 olsun");

  const live = new FakeLive();
  live.holdSettle = true;
  const c = harness({ live });
  live.queue.push({ uses: [setLevel("Salon Lamba", 40)] });
  const turn = c.say("salon lambası parlaklığı yüzde 40 olsun");
  await c.session.handle({ type: "cancel", id: "t1" });
  await turn;
  live.release();
  await drain(c);
  assert.equal(c.observed.length, 0);
});

test("persistent mode: the learner waits for `settled`", async () => {
  const live = new FakeLive();
  live.holdSettle = true;
  const h = harness({ live });
  live.queue.push({ uses: [setLevel("Salon Lamba", 40)] });
  await h.say("salon lambası parlaklığı yüzde 40 olsun");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(h.observed.length, 0);
  assert.equal(h.ha.reads, 0);
  live.release();
  await until(() => h.observed.length === 1);
});

// ------------------------------------------------------------------ learned rules at run time

async function withActiveRule(o: Parameters<typeof harness>[0] = {}) {
  const h = harness(o);
  for (const [name, n] of [["Salon Lamba", 40], ["Mutfak Lamba", 70], ["Salon Lamba", 20]] as const) {
    h.agent.queue.push({ uses: [setLevel(name, n)] });
    await h.say(`${name.split(" ")[0]?.toLocaleLowerCase("tr-TR")} lambası parlaklığı yüzde ${n} olsun`);
    await until(() => h.observed.length > 0 && h.agent.queue.length === 0);
  }
  await until(async () => (await h.store.list())[0]?.status === "candidate");
  const id = (await h.store.list())[0]?.id as string;
  const res = await h.store.activate(id, "browser");
  assert.ok(res.ok);
  h.agent.calls.length = 0;
  return { h, id };
}

test("an active learned rule runs without a model through the gate", async () => {
  const { h, id } = await withActiveRule();
  await h.say("mutfak lambası parlaklığı yüzde 55 olsun");
  assert.equal(h.agent.calls.length, 0);
  assert.deepEqual(h.ha.writes.at(-1), { tool: "light__HassLightSet", args: { name: "Mutfak Lamba", domain: ["light"], brightness: 55 } });
  assert.equal(h.lastDone(), "Tamam, mutfak yüzde 55 yapıldı.");
  await until(() => h.outcomes.length === 1);
  assert.deepEqual(h.outcomes[0], [id, "success", undefined]);
});

test("a learned rule asks when confirm_inputs hits (the gate is not skipped)", async () => {
  const services = servicesYaml(["    confirm_inputs:", "      domain: [light]"]);
  // Learn under the plain services, then run with confirm_inputs on light.
  const { h } = await withActiveRule();
  const strict = harness({ services });
  await strict.store.load();
  // Copy the active rule into the strict harness's store.
  const rule = (await h.store.list())[0];
  assert.ok(rule);
  for (let i = 0; i < 3; i++) {
    await strict.store.observe({
      tokens: rule.tokens,
      service: rule.service,
      tool: rule.tool as Extracted["tool"],
      domains: [rule.domains[0] as string],
      keywords: rule.keywords,
      binding: rule.binding,
      signature: "home-assistant|light__HassLightSet|light|name=ad|brightness=sayi",
    });
  }
  assert.ok((await strict.store.activate(rule.id, "browser")).ok);
  const turn = strict.say("salon lambası parlaklığı yüzde 10 olsun");
  const req = (await strict.waitFor((f) => f.type === "confirm_request")) as Extract<ServerFrame, { type: "confirm_request" }>;
  assert.equal(req.tool, "light__HassLightSet");
  await strict.session.handle({ type: "confirm_response", requestId: req.requestId, approved: false });
  await turn;
  assert.equal(strict.ha.writes.length, 0);
  assert.equal(strict.agent.calls.length, 0, "a declined confirmation never falls back");
  assert.equal(strict.lastDone(), "Tamam, yapmıyorum.");
});

test("read-only: a learned rule is denied with a reply and never falls back", async () => {
  const { h: learner } = await withActiveRule();
  const rule = (await learner.store.list())[0];
  assert.ok(rule);
  const ro = harness({ readOnly: true });
  for (let i = 0; i < 3; i++) {
    await ro.store.observe({ tokens: rule.tokens, service: rule.service, tool: rule.tool as Extracted["tool"], domains: [rule.domains[0] as string], keywords: rule.keywords, binding: rule.binding, signature: "home-assistant|light__HassLightSet|light|name=ad|brightness=sayi" });
  }
  assert.ok((await ro.store.activate(rule.id, "browser")).ok);
  await ro.say("salon lambası parlaklığı yüzde 10 olsun");
  assert.equal(ro.ha.writes.length, 0);
  assert.equal(ro.agent.calls.length, 0);
  assert.equal(ro.lastDone(), "Şu an salt okuma modundayım, bunu yapamam.");
  await drain(ro);
  assert.deepEqual(ro.outcomes, [], "a denial is neutral");
});

test("a learned-rule fallback reaches tier 1 silently and counts; three in a row suspend", async () => {
  const { h, id } = await withActiveRule();
  for (let i = 1; i <= 3; i++) {
    h.agent.queue.push({ text: "Model cevabı." });
    await h.say("bilinmeyen lambası parlaklığı yüzde 30 olsun"); // the name resolves to nothing
    assert.equal(h.lastDone(), "Model cevabı.");
    assert.equal(h.agent.calls.length, i);
    await until(() => h.outcomes.length === i);
  }
  assert.deepEqual(
    h.outcomes.map(([, o, r]) => [o, r]),
    [
      ["failure", "name_not_found"],
      ["failure", "name_not_found"],
      ["failure", "name_not_found"],
    ],
  );
  assert.equal(h.ha.writes.length, 0);
  assert.equal((await h.store.list()).find((r) => r.id === id)?.status, "suspended");
  assert.equal(h.store.snapshot().length, 0);
  // Suspended: the phrasing goes to the model again.
  h.agent.queue.push({});
  await h.say("salon lambası parlaklığı yüzde 30 olsun");
  assert.equal(h.agent.calls.length, 4);
});

test("a learned rule whose <ad> matches several entities falls back silently and counts (T7.w.9)", async () => {
  const { h, id } = await withActiveRule();
  // A second "Salon Lamba" in the same area: the name no longer picks one entity.
  h.ha.live = JSON.stringify({
    result: [
      "Live Context:",
      "- names: Salon Lamba",
      "  domain: light",
      "  state: 'off'",
      "  areas: Salon",
      "- names: Salon Lamba",
      "  domain: light",
      "  state: 'off'",
      "  areas: Salon",
    ].join("\n"),
  });
  for (let i = 1; i <= 3; i++) {
    h.agent.queue.push({ text: "Model cevabı." });
    await h.say("salon lambası parlaklığı yüzde 30 olsun");
    assert.equal(h.lastDone(), "Model cevabı.");
    assert.equal(h.agent.calls.length, i);
    await until(() => h.outcomes.length === i);
  }
  assert.deepEqual(
    h.outcomes.map(([, o, r]) => [o, r]),
    [
      ["failure", "name_ambiguous"],
      ["failure", "name_ambiguous"],
      ["failure", "name_ambiguous"],
    ],
  );
  assert.equal(h.ha.writes.length, 0, "an ambiguous name is never called");
  assert.equal((await h.store.list()).find((r) => r.id === id)?.status, "suspended");
});

test("a success between fallbacks resets the count: no suspension", async () => {
  const { h, id } = await withActiveRule();
  const say = async (text: string, model: boolean) => {
    if (model) h.agent.queue.push({ text: "Model cevabı." });
    const before = h.outcomes.length;
    await h.say(text);
    await until(() => h.outcomes.length === before + 1);
  };
  await say("bilinmeyen lambası parlaklığı yüzde 30 olsun", true); // 0 matches
  await say("bilinmeyen lambası parlaklığı yüzde 30 olsun", true);
  await say("salon lambası parlaklığı yüzde 30 olsun", false); // exactly one: runs
  await say("bilinmeyen lambası parlaklığı yüzde 30 olsun", true);
  await say("bilinmeyen lambası parlaklığı yüzde 30 olsun", true);
  assert.deepEqual(
    h.outcomes.map(([, o, r]) => [o, r]),
    [["failure", "name_not_found"], ["failure", "name_not_found"], ["success", undefined], ["failure", "name_not_found"], ["failure", "name_not_found"]],
  );
  assert.equal(h.ha.writes.length, 1, "only the one-match turn called HA");
  assert.equal((await h.store.list()).find((r) => r.id === id)?.status, "active");
});

test("an unreachable service after a learned match replies, no fallback, neutral", async () => {
  const { h } = await withActiveRule();
  h.ha.callTool = async () => {
    throw new Error("down");
  };
  await h.say("salon lambası parlaklığı yüzde 30 olsun");
  assert.equal(h.agent.calls.length, 0);
  assert.equal(h.lastDone(), "Ev sistemine şu an ulaşamıyorum.");
  await drain(h);
  assert.deepEqual(h.outcomes, []);
});

test("a static tier-0 command still runs without a model and is not observed", async () => {
  const h = harness();
  await h.say("salon ışığını aç");
  assert.equal(h.agent.calls.length, 0);
  assert.equal(h.lastDone(), "Tamam, salon ışığı açıldı.");
  await drain(h);
  assert.equal(h.observed.length, 0);
  assert.deepEqual(h.outcomes, []);
});
