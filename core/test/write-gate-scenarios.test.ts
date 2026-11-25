/**
 * T4.5: end-to-end scenarios of the write gate, confirmed names and the
 * repeated-error stop (docs/14 "Implementation tasks" T4.5), at the Session
 * level with the shipped `router.yaml` and `services.yaml`. Home Assistant
 * and the model are fakes: the fake model only says which calls it wants
 * (through the real gate); the fake HA only records what was sent and
 * answers from a scripted live context. Nothing real is switched. Generic
 * names only.
 *
 * Items covered elsewhere one-to-one are referenced next to the item below
 * instead of being copied.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { AgentRunner, TurnCallbacks, TurnRequest, TurnResult } from "../src/agent.js";
import { ConfirmedNameStore, MISSING_TO_PASSIVE_MS } from "../src/confirmed-names.js";
import { ConversationLog } from "../src/conversation-log.js";
import { learnPolicy, learnTargetFilter } from "../src/learn/extract.js";
import type { DirectToolClient, DirectToolResult } from "../src/mcp-direct.js";
import { GATE_SUMMARY_SUFFIX, PermissionPolicy } from "../src/permissions.js";
import type { ServerFrame } from "../src/protocol.js";
import { compileLearnedRule, loadRouterFile } from "../src/router-config.js";
import { TieredRouter } from "../src/router.js";
import { parseServices } from "../src/services.js";
import { Session } from "../src/session.js";

const base = mkdtempSync(join(tmpdir(), "shadow-write-gate-scenarios-"));
const open: Session[] = [];
after(async () => {
  await Promise.all(open.map((s) => s.close("test_end")));
  rmSync(base, { recursive: true, force: true });
});

// ------------------------------------------------------------------ shipped configuration

const ROUTER = loadRouterFile(fileURLToPath(new URL("../../router.yaml", import.meta.url)));
const SERVICES = parseServices(readFileSync(fileURLToPath(new URL("../../services.yaml", import.meta.url)), "utf8"), {
  HA_URL: "http://127.0.0.1:1",
  HA_CORE_TOKEN: "test-token",
}).services;
const POLICY = learnPolicy(ROUTER, SERVICES);
const MODELS = { 1: "m-haiku", 2: "m-sonnet", 3: "m-opus" } as const;

const SERVICE = "home-assistant";
const HA = `mcp__${SERVICE}__`;
const LIVE_TOOL = "homeassistant__GetLiveContext";
const OFF = "intent__HassTurnOff";
/** The 2026-11-17 failure: GetLiveContext does not take a `name`. */
const NAME_ERROR = "MCP error -32602: Invalid arguments for tool GetLiveContext: extra keys not allowed @ data['name']";
const REPEATED = "This tool failed twice in this form in this turn; do not try it again in the same form. Tell the user what happened.";

// ------------------------------------------------------------------ fake home (generic names)

const ENTITIES = {
  /** The only light in Salon; "Salon Lambası" is an HA alias. */
  lamp: ["- names: Tavan Işık, Salon Lambası", "  domain: light", "  state: 'on'", "  areas: Salon"],
  kitchen1: ["- names: Mutfak Işık 1", "  domain: light", "  state: 'on'", "  areas: Mutfak"],
  kitchen2: ["- names: Mutfak Işık 2", "  domain: light", "  state: 'on'", "  areas: Mutfak"],
  pump: ["- names: Bahçe Pompası", "  domain: switch", "  state: 'on'", "  areas: Bahçe", "  attributes:", "    device_class: outlet"],
  sonoff: ["- names: Sonoff Priz", "  domain: switch", "  state: 'off'", "  attributes:", "    device_class: outlet"],
  lock: ["- names: Ön Kapı", "  domain: lock", "  state: locked"],
  relay: ["- names: Röle Anahtarı", "  domain: switch", "  state: 'off'"],
  doorPlug: ["- names: Kapı Rölesi", "  domain: switch", "  state: 'off'", "  attributes:", "    device_class: outlet"],
} as const;
type EntityKey = keyof typeof ENTITIES;

function liveContext(without: readonly EntityKey[] = []): string {
  const lines = (Object.keys(ENTITIES) as EntityKey[]).filter((k) => !without.includes(k)).flatMap((k) => ENTITIES[k]);
  return JSON.stringify({ result: ["Live Context: An overview of the areas and the devices in this smart home:", ...lines].join("\n") });
}
const BROKEN: DirectToolResult = { text: "boom", isError: true };
const EMPTY: DirectToolResult = { text: JSON.stringify({ result: "Live Context:\n- foo: 1" }), isError: false };

/** Fake HA MCP: records every call it receives; the live context is scripted, a call with a `name` filter fails. */
class FakeHa implements DirectToolClient {
  calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  live: DirectToolResult = { text: liveContext(), isError: false };
  run(tool: string, args: Record<string, unknown>): DirectToolResult {
    this.calls.push({ tool, args });
    if (tool === LIVE_TOOL) return "name" in args ? { text: NAME_ERROR, isError: true } : this.live;
    return { text: "ok", isError: false };
  }
  async callTool(_service: string, tool: string, args: Record<string, unknown>): Promise<DirectToolResult> {
    return this.run(tool, args);
  }
  get reads() {
    return this.calls.filter((c) => c.tool === LIVE_TOOL);
  }
  get writes() {
    return this.calls.filter((c) => c.tool !== LIVE_TOOL);
  }
  /**
   * Live-context reads before the first write. After a model turn with a write the
   * learner (docs/08) makes its own read off the turn path; that one is not the gate's.
   */
  get readsBeforeWrite() {
    const first = this.calls.findIndex((c) => c.tool !== LIVE_TOOL);
    return this.calls.slice(0, first < 0 ? undefined : first).filter((c) => c.tool === LIVE_TOOL).length;
  }
}

interface ToolUse {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Fake model (legacy runner): each model call takes the next plan and asks the
 * real gate for every tool use, in order. An allowed use is sent to the fake HA
 * and its result (with the error text) reported like the SDK does. The plan
 * never decides the outcome: what reaches HA is what the gate allowed.
 */
class FakeModel implements AgentRunner {
  calls: TurnRequest[] = [];
  queue: ToolUse[][] = [];
  decisions: Array<{ tool: string; behavior: string; message?: string }> = [];
  private seq = 0;
  constructor(private readonly ha: FakeHa) {}
  async runTurn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult> {
    this.calls.push(req);
    for (const u of this.queue.shift() ?? []) {
      const id = `tu-${++this.seq}`;
      const d = await req.canUseTool(`${HA}${u.tool}`, u.args, { signal: req.signal ?? new AbortController().signal, toolUseID: id });
      this.decisions.push({ tool: u.tool, behavior: d.behavior, ...("message" in d ? { message: d.message } : {}) });
      if (d.behavior !== "allow") continue;
      const r = this.ha.run(u.tool, u.args);
      cb.onToolResult?.(id, `${HA}${u.tool}`, r.isError, r.isError ? r.text : undefined);
    }
    cb.onDelta("Tamam.");
    return { text: "", inputTokens: 1, outputTokens: 1, durationMs: 5, sessionId: `sdk-${this.calls.length}`, tools: [] };
  }
}

type ConfirmRequestFrame = Extract<ServerFrame, { type: "confirm_request" }>;

interface LogLine {
  kind: string;
  tool?: string;
  level?: string;
  reason?: string;
  decision?: string;
  rule?: string;
  tier?: number;
  fallback?: string;
}

/** A learned tier-0 rule as the learner would store it (docs/08): "<ad> lambasını uyut" → turn the light off. */
const LEARNED = compileLearnedRule(
  { id: "lr-00000001", tokens: ["<ad>", "lambasını", "uyut"], service: SERVICE, tool: OFF, domains: ["light"], keywords: ["lamba"] },
  ROUTER.direct.maxNameWords,
);

let counter = 0;
/** Wired like `index.ts`: shipped configs, learned rules, learning policy, the gate's router words, a confirmed-name store with a clock. */
async function harness(o: { confirmTimeoutMs?: number; transcript?: string; clock?: { now: () => number } } = {}) {
  const dir = join(base, `d${++counter}`);
  const store = new ConfirmedNameStore({ dir: join(dir, "device-names"), ...(o.clock ? { now: o.clock.now } : {}), log: () => {} });
  await store.load();
  const frames: ServerFrame[] = [];
  const waiters: Array<() => void> = [];
  const ha = new FakeHa();
  const model = new FakeModel(ha);
  const router = new TieredRouter({ config: ROUTER, models: MODELS, learned: { rules: () => [LEARNED], targetFilter: learnTargetFilter(POLICY) } });
  const session = new Session(
    {
      agent: model,
      policy: new PermissionPolicy(SERVICES),
      router,
      stt: { transcribe: async () => ({ text: o.transcript ?? "" }) },
      tts: { synthesize: async () => ({ mime: "audio/wav", data: Buffer.from("RIFF") }), voices: async () => ({ default: "v", voices: ["v"] }) },
      log: new ConversationLog(dir),
      logger: { info: () => {}, warn: () => {} },
      confirmTimeoutMs: o.confirmTimeoutMs ?? 5_000,
      direct: ha,
      learning: { store: { observe: async () => undefined, recordOutcome: async () => ({ suspended: false }) } as never, policy: POLICY },
      names: store,
      gateWords: { domainWords: ROUTER.learning.keywords, denyNameWords: ROUTER.learning.denyNameWords },
    },
    { sessionId: `s${counter}`, device: "browser" },
    (f) => {
      frames.push(f);
      waiters.splice(0).forEach((w) => w());
    },
  );
  open.push(session);
  let turn = 0;
  const confirms = () => frames.filter((f) => f.type === "confirm_request") as ConfirmRequestFrame[];
  const waitFor = (pred: (f: ServerFrame) => boolean, ms = 2000) =>
    new Promise<ServerFrame>((res, rej) => {
      const check = () => {
        const f = frames.find(pred);
        if (f) res(f);
        else waiters.push(check);
      };
      setTimeout(() => rej(new Error("timeout waiting for frame")), ms).unref();
      check();
    });
  const respond = (req: ConfirmRequestFrame, approved: boolean, remember?: true) =>
    session.handle({ type: "confirm_response", requestId: req.requestId, approved, ...(remember ? { remember } : {}) });
  return {
    session,
    store,
    ha,
    model,
    frames,
    confirms,
    respond,
    say: async (text: string) => {
      await session.handle({ type: "user_text", id: `t${++turn}`, text });
      await store.flush();
    },
    /** Says `text`, waits for the first new card and lets `answer` respond; resolves once the turn is over. */
    sayAndAnswer: async (text: string, answer: (req: ConfirmRequestFrame) => Promise<void>) => {
      const before = confirms().length;
      const done = session.handle({ type: "user_text", id: `t${++turn}`, text });
      const req = (await waitFor((f) => f.type === "confirm_request" && confirms().indexOf(f as ConfirmRequestFrame) >= before)) as ConfirmRequestFrame;
      await answer(req);
      await done;
      await store.flush();
      return req;
    },
    entry: async () => {
      const list = await store.list();
      assert.ok(list.length <= 1, "one entry at most in these scenarios");
      return list[0];
    },
    lines: async (): Promise<LogLine[]> => {
      await session.close("read_log");
      const root = join(dir, "conversations");
      const day = readdirSync(root)[0] as string;
      const file = readdirSync(join(root, day))[0] as string;
      return readFileSync(join(root, day, file), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as LogLine);
    },
  };
}

const turnOff = (name: string): ToolUse => ({ tool: OFF, args: { name } });
const liveRead = (args: Record<string, unknown> = {}): ToolUse => ({ tool: LIVE_TOOL, args });

function clock(start = "2026-11-20T09:00:00.000Z") {
  let now = Date.parse(start);
  return { now: () => now, tick: (ms: number) => void (now += ms) };
}
const DAY = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------------ 2026-11-17 incident

/** The incident turn: two failing GetLiveContext{name} reads, a third one, then a guessed write on the pump. */
const INCIDENT_PLAN: ToolUse[] = [liveRead({ name: "Sonoff" }), liveRead({ name: "sonoff" }), liveRead({ name: "Sonoff Priz" }), turnOff("Bahçe Pompası")];

test("2026-11-17: 'Sonoff hangi cihazlar var' - third failing read not sent (repeated_error); guessed write -> one question card, no remember; declined -> no HA write", async () => {
  const h = await harness();
  h.model.queue.push(INCIDENT_PLAN);
  const req = await h.sayAndAnswer("Sonoff hangi cihazlar var", (r) => h.respond(r, false));

  assert.equal(h.model.calls.length, 1, "a question: no tier-0 rule, the model got the turn");
  assert.deepEqual(
    h.model.decisions.map((d) => `${d.tool}:${d.behavior}`),
    [`${LIVE_TOOL}:allow`, `${LIVE_TOOL}:allow`, `${LIVE_TOOL}:deny`, `${OFF}:deny`],
  );
  assert.equal(h.model.decisions[2]?.message, REPEATED);
  // Only the two failing reads reached HA: no third read, no gate read (the question lock needs none), no write.
  assert.deepEqual(h.ha.calls.map((c) => c.args), [{ name: "Sonoff" }, { name: "sonoff" }]);
  assert.equal(h.ha.writes.length, 0);

  assert.equal(h.confirms().length, 1, "exactly one confirm_request");
  assert.equal(req.tool, OFF);
  assert.equal(req.remember, undefined, "no 'Evet, hep bu' offer in a question turn");
  assert.ok(req.summary.endsWith(GATE_SUMMARY_SUFFIX.question_turn), req.summary);
  assert.deepEqual(await h.store.list(), []);

  const lines = await h.lines();
  assert.equal(lines.filter((l) => l.kind === "tool_call" && l.reason === "repeated_error").length, 1);
  const write = lines.find((l) => l.kind === "tool_call" && l.tool === `${HA}${OFF}`);
  assert.equal(write?.level, "confirm");
  assert.match(write?.reason ?? "", /\+gate:question_turn$/);
});

test("2026-11-17: the same turn with the card timing out -> no HA write", async () => {
  const h = await harness({ confirmTimeoutMs: 50 });
  h.model.queue.push(INCIDENT_PLAN);
  // The confirm timer is unref'd: keep the event loop alive until the turn is over.
  const keepAlive = setInterval(() => {}, 10);
  try {
    await h.say("Sonoff hangi cihazlar var");
  } finally {
    clearInterval(keepAlive);
  }
  assert.equal(h.confirms().length, 1);
  assert.equal(h.confirms()[0]?.remember, undefined);
  assert.equal(h.model.decisions[3]?.behavior, "deny");
  assert.match(h.model.decisions[3]?.message ?? "", /did not confirm in time/);
  assert.equal(h.ha.writes.length, 0);
  assert.equal(h.ha.reads.length, 2);
});

// ------------------------------------------------------------------ question lock

test("mixed 'hangi ışıklar açık, hepsini kapat': one card, no remember; approved -> the write runs", async () => {
  const h = await harness();
  h.model.queue.push([{ tool: OFF, args: { domain: ["light"] } }]);
  const req = await h.sayAndAnswer("hangi ışıklar açık, hepsini kapat", (r) => h.respond(r, true));
  assert.equal(h.confirms().length, 1);
  assert.equal(req.remember, undefined);
  assert.ok(req.summary.endsWith(GATE_SUMMARY_SUFFIX.question_turn), req.summary);
  assert.deepEqual(h.ha.writes, [{ tool: OFF, args: { domain: ["light"] } }]);
});

test("tier-0 rule in a typed question 'salon ışığını kapat?': card, no remember, no model fallback; declined -> no write", async () => {
  const h = await harness();
  const req = await h.sayAndAnswer("salon ışığını kapat?", (r) => h.respond(r, false));
  assert.equal(h.confirms().length, 1);
  assert.equal(req.remember, undefined);
  assert.ok(req.summary.endsWith(GATE_SUMMARY_SUFFIX.question_turn), req.summary);
  assert.equal(h.ha.writes.length, 0);
  assert.equal(h.ha.reads.length, 1, "tier 0's own read only");
  assert.equal(h.model.calls.length, 0);
});

test("polite request 'salon lambasını kapatır mısın': not locked - the write runs with no card", async () => {
  const h = await harness();
  await h.say("salon lambasını kapatır mısın");
  assert.equal(h.confirms().length, 0);
  assert.deepEqual(h.ha.writes.map((c) => c.args.name), ["Tavan Işık"]);
});

// ------------------------------------------------------------------ target provenance

test("model guesses on a non-question 'şunu kapat': one card with two options (no remember); declined -> no write", async () => {
  const h = await harness();
  h.model.queue.push([turnOff("Bahçe Pompası")]);
  const req = await h.sayAndAnswer("şunu kapat", (r) => h.respond(r, false));
  assert.equal(h.model.calls.length, 1, "'şunu' is a stop name: no tier-0 match");
  assert.equal(h.confirms().length, 1);
  assert.equal(req.remember, undefined, "Evet / Hayır only");
  assert.ok(req.summary.endsWith(GATE_SUMMARY_SUFFIX.unknown_target), req.summary);
  assert.deepEqual(h.model.decisions.map((d) => d.behavior), ["deny"]);
  assert.equal(h.ha.writes.length, 0);
});

test("tier-0 'salon ışığını yüzde 40 yap': exactly two HA calls, no card, no extra GetLiveContext, no model", async () => {
  const h = await harness();
  await h.say("salon ışığını yüzde 40 yap");
  assert.equal(h.confirms().length, 0);
  assert.equal(h.model.calls.length, 0);
  assert.equal(h.ha.calls.length, 2);
  assert.deepEqual(h.ha.calls[0], { tool: LIVE_TOOL, args: {} });
  assert.equal(h.ha.calls[1]?.tool, "light__HassLightSet");
  assert.equal(h.ha.calls[1]?.args.name, "Tavan Işık");
  assert.equal(h.ha.calls[1]?.args.brightness, 40);
});

test("tier-0 on / off and a learned rule: no card, two HA calls each, no model", async () => {
  const h = await harness();
  for (const [text, tool] of [
    ["salon ışığını aç", "intent__HassTurnOn"],
    ["salon ışığını kapat", OFF],
    ["salon lambasını uyut", OFF], // matches only the learned rule
  ] as const) {
    const before = h.ha.calls.length;
    await h.say(text);
    const sent = h.ha.calls.slice(before);
    assert.deepEqual(sent.map((c) => c.tool), [LIVE_TOOL, tool], text);
    assert.equal(sent[1]?.args.name, "Tavan Işık", text);
  }
  assert.equal(h.confirms().length, 0);
  assert.equal(h.model.calls.length, 0);
  const routes = (await h.lines()).filter((l) => l.kind === "route");
  assert.deepEqual(routes.map((l) => l.rule), ["light-on", "light-off", "learned:lr-00000001"]);
});

test("model calls the canonical name of an HA alias the user said: no card, one extra read (rule 4); without the alias -> card", async () => {
  const lightSet = { tool: "light__HassLightSet", args: { name: "Tavan Işık", brightness: 30 } };
  const h = await harness();
  h.model.queue.push([lightSet]);
  await h.say("salon lambası çok parlak, biraz kıs");
  assert.equal(h.model.calls.length, 1);
  assert.equal(h.confirms().length, 0);
  assert.deepEqual(h.model.decisions.map((d) => d.behavior), ["allow"]);
  assert.equal(h.ha.readsBeforeWrite, 1, "the gate's one read");
  assert.deepEqual(h.ha.writes, [lightSet]);

  // Control: the same call when the user did not name the lamp.
  const c = await harness();
  c.model.queue.push([lightSet]);
  const req = await c.sayAndAnswer("burası çok parlak, biraz kıs", (r) => c.respond(r, false));
  assert.ok(req.summary.endsWith(GATE_SUMMARY_SUFFIX.unknown_target), req.summary);
  assert.equal(c.ha.writes.length, 0);
});

test("window: 'salon ışığı açık mı' -> 'kapat' is allowed; with two utterances in between -> card", async () => {
  const h = await harness();
  h.model.queue.push([], [turnOff("Tavan Işık")]);
  await h.say("salon ışığı açık mı");
  await h.say("kapat");
  assert.equal(h.confirms().length, 0);
  assert.deepEqual(h.ha.writes.map((c) => c.args.name), ["Tavan Işık"]);

  const w = await harness();
  w.model.queue.push([], [], [], [turnOff("Tavan Işık")]);
  await w.say("salon ışığı açık mı");
  await w.say("teşekkürler");
  await w.say("hava nasıl");
  // "salon ışığı açık mı" is now the 4th utterance back: it left the window.
  const req = await w.sayAndAnswer("kapat", (r) => w.respond(r, false));
  assert.ok(req.summary.endsWith(GATE_SUMMARY_SUFFIX.unknown_target), req.summary);
  assert.equal(w.ha.writes.length, 0);
});

test("several candidates: tier 0 is ambiguous, the model turn makes no call (its choice question is free text); the user's next utterance names one -> the write runs with no card", async () => {
  const h = await harness();
  h.model.queue.push([], [turnOff("Mutfak Işık 2")]);
  await h.say("mutfak ışığını kapat");
  assert.equal(h.model.calls.length, 1, "tier 0: two kitchen lights, ambiguous -> the model's turn");
  assert.equal(h.ha.writes.length, 0);
  await h.say("mutfak ışık 2");
  assert.equal(h.confirms().length, 0);
  assert.deepEqual(h.ha.writes.map((c) => c.args.name), ["Mutfak Işık 2"]);
  // The name was in the user's words (rule 3, the whole utterance: no T4.9 read); the call carries `name` only,
  // so the gate reads the live context once for its kind (T4.8).
  assert.equal(h.ha.readsBeforeWrite, 2, "tier 0's read in turn 1, the gate's name-only read in turn 2");
});

// ------------------------------------------------------------------ confirmed names

/** "bahçe pompasnı kapat" -> tier-0 miss -> the model's write -> card with remember -> "Evet, hep bu". */
async function confirmPumpName(h: Awaited<ReturnType<typeof harness>>) {
  h.model.queue.push([turnOff("Bahçe Pompası")]);
  const req = await h.sayAndAnswer("bahçe pompasnı kapat", (r) => h.respond(r, true, true));
  assert.deepEqual(req.remember, { spoken: "bahçe pompasnı", target: "Bahçe Pompası" });
  assert.ok(req.summary.endsWith(GATE_SUMMARY_SUFFIX.unknown_target), req.summary);
  return req;
}

test("'bahçe pompasnı kapat': tier-0 miss -> model -> card with remember -> 'Evet, hep bu' -> next time tier 0, no card", async () => {
  // Same flow with a test-local router: session-names.test.ts, first test.
  const h = await harness();
  await confirmPumpName(h);
  assert.equal(h.model.calls.length, 1);
  assert.equal(h.ha.writes.length, 1);
  assert.equal((await h.entry())?.status, "active");

  await h.say("bahçe pompasnı kapat");
  assert.equal(h.confirms().length, 1, "no second card");
  assert.equal(h.model.calls.length, 1, "no model call");
  assert.deepEqual(h.ha.writes.map((c) => c.args.name), ["Bahçe Pompası", "Bahçe Pompası"]);
  assert.equal((await h.entry())?.uses, 1);
});

test("device missing -> not used, missingSince set, the model call asks; back within 30 days -> cleared, tier 0 uses it; 30 days missing -> passive, not used after it returns; a new 'Evet, hep bu' makes it active", async () => {
  const c = clock();
  const h = await harness({ clock: c });
  await confirmPumpName(h);

  // Missing: tier 0 does not use the entry, the clock starts, the model's write asks again.
  h.ha.live = { text: liveContext(["pump"]), isError: false };
  c.tick(DAY);
  const missingAt = new Date(c.now()).toISOString();
  h.model.queue.push([turnOff("Bahçe Pompası")]);
  const again = await h.sayAndAnswer("bahçe pompasnı kapat", (r) => h.respond(r, false));
  assert.equal(h.model.calls.length, 2, "tier 0 fell back to the model");
  assert.equal(again.remember, undefined, "the call reaches no device: no offer");
  assert.equal((await h.entry())?.missingSince, missingAt);
  assert.equal(h.ha.writes.length, 1, "only the first (approved) write");

  // Back after 10 days: the clock clears and tier 0 uses the name again.
  h.ha.live = { text: liveContext(), isError: false };
  c.tick(10 * DAY);
  await h.say("bahçe pompasnı kapat");
  assert.equal(h.model.calls.length, 2);
  assert.equal(h.confirms().length, 2);
  assert.equal(h.ha.writes.length, 2);
  assert.equal((await h.entry())?.missingSince, null);
  assert.equal((await h.entry())?.status, "active");

  // Missing again for 30 days without a break -> passive (30 days written out, not the store's constant).
  assert.equal(MISSING_TO_PASSIVE_MS, 30 * DAY);
  h.ha.live = { text: liveContext(["pump"]), isError: false };
  h.model.queue.push([], [], []);
  await h.say("bahçe pompasnı kapat");
  assert.notEqual((await h.entry())?.missingSince, null);
  c.tick(30 * DAY - 1);
  await h.say("bahçe pompasnı kapat");
  assert.equal((await h.entry())?.status, "active", "one millisecond short of 30 days");
  c.tick(1);
  await h.say("bahçe pompasnı kapat");
  assert.equal((await h.entry())?.status, "passive");
  assert.equal(h.ha.writes.length, 2);

  // The device returns: a passive entry stays passive and is not used; the model's write asks, with the offer.
  h.ha.live = { text: liveContext(), isError: false };
  const calls = h.model.calls.length;
  h.model.queue.push([turnOff("Bahçe Pompası")]);
  const renew = await h.sayAndAnswer("bahçe pompasnı kapat", (r) => h.respond(r, true, true));
  assert.equal(h.model.calls.length, calls + 1, "not used on tier 0");
  assert.ok(renew.remember, "offered again");
  const fresh = await h.entry();
  assert.equal(fresh?.status, "active");
  assert.equal(fresh?.missingSince, null);

  // Active again: tier 0, no card, one new write.
  const cards = h.confirms().length;
  const before = h.ha.writes.length;
  await h.say("bahçe pompasnı kapat");
  assert.equal(h.confirms().length, cards);
  assert.equal(h.model.calls.length, calls + 1);
  assert.deepEqual(h.ha.writes.slice(before).map((c) => c.args.name), ["Bahçe Pompası"]);
});

for (const [target, why] of [
  ["Ön Kapı", "a lock"],
  ["Röle Anahtarı", "a switch that is not an outlet"],
  ["Kapı Rölesi", "a deny-name target"],
] as const) {
  test(`confirmed name pointing at ${why}: refused on tier 0, the model gets the turn`, async () => {
    // Session level of router-tier0.test.ts "a confirmed name pointing at ...": the entry is created
    // the only way there is ("Evet, hep bu" on a model-path card), then the same words go to tier 0.
    const h = await harness();
    h.model.queue.push([turnOff(target)]);
    const first = await h.sayAndAnswer("fıskiyeyi kapat", (r) => h.respond(r, true, true));
    assert.ok(first.remember);
    assert.equal((await h.entry())?.target.name, target);
    const writes = h.ha.writes.length;

    h.model.queue.push([]);
    await h.say("fıskiyeyi kapat");
    assert.equal(h.model.calls.length, 2, "tier 0 did not act, the model got the turn");
    assert.equal(h.ha.writes.length, writes, "nothing switched on tier 0");
    assert.equal((await h.entry())?.uses, 0);
    const tier0 = (await h.lines()).filter((l) => l.kind === "route" && l.tier === 0);
    assert.deepEqual(tier0.map((l) => l.fallback), ["name_not_found", "target_refused"]);
  });
}

test("confirmed name pointing at a lock: the model's lock call (domain lock) asks through confirm_inputs", async () => {
  const h = await harness();
  h.model.queue.push([turnOff("Ön Kapı")]);
  await h.sayAndAnswer("fıskiyeyi kapat", (r) => h.respond(r, true, true));
  assert.equal((await h.entry())?.target.domain, "lock");
  const writes = h.ha.writes.length;
  h.model.queue.push([{ tool: OFF, args: { name: "Ön Kapı", domain: ["lock"] } }]);
  const req = await h.sayAndAnswer("fıskiyeyi kapat", (r) => h.respond(r, false));
  assert.equal(req.tool, OFF);
  assert.equal(req.remember, undefined);
  assert.equal(h.ha.writes.length, writes);
});

// docs/14 decision 9 (T4.8): the open T4.5 item. A name-only model call is known through the
// confirmed name (rule 5), yet its target is sensitive: the gate finds it in the live context and asks.
for (const [target, why] of [
  ["Ön Kapı", "a lock (confirm_inputs domain)"],
  ["Röle Anahtarı", "a switch that is not an outlet"],
  ["Kapı Rölesi", "a deny-name target"],
] as const) {
  test(`confirmed name pointing at ${why}: the model's name-only call opens a card (no remember); declined -> no write`, async () => {
    const h = await harness();
    h.model.queue.push([turnOff(target)]);
    await h.sayAndAnswer("fıskiyeyi kapat", (r) => h.respond(r, true, true));
    assert.equal((await h.entry())?.target.name, target);
    const writes = h.ha.writes.length;

    h.model.queue.push([turnOff(target)]);
    const req = await h.sayAndAnswer("fıskiyeyi kapat", (r) => h.respond(r, false));
    assert.equal(h.model.calls.length, 2, "tier 0 refused, the model got the turn");
    assert.equal(req.tool, OFF);
    assert.equal(req.remember, undefined, "the target is known (rule 5): no offer");
    assert.ok(req.summary.endsWith(GATE_SUMMARY_SUFFIX.sensitive_target), req.summary);
    assert.equal(h.model.decisions.at(-1)?.behavior, "deny");
    assert.equal(h.ha.writes.length, writes, "nothing switched");
    const write = (await h.lines()).filter((l) => l.kind === "tool_call" && l.tool === `${HA}${OFF}`).at(-1);
    assert.match(write?.reason ?? "", /\+gate:sensitive_target$/);
  });
}

test("a lock the user named: the model's name-only call opens a card; declined -> no write, approved -> the write runs", async () => {
  const h = await harness();
  h.model.queue.push([turnOff("Ön Kapı")]);
  const req = await h.sayAndAnswer("ön kapıyı kapat", (r) => h.respond(r, false));
  assert.equal(h.model.calls.length, 1, "tier 0 does not switch a lock");
  assert.equal(req.remember, undefined);
  assert.ok(req.summary.endsWith(GATE_SUMMARY_SUFFIX.sensitive_target), req.summary);
  assert.equal(h.ha.writes.length, 0);

  h.model.queue.push([turnOff("Ön Kapı")]);
  await h.sayAndAnswer("ön kapıyı kapat", (r) => h.respond(r, true));
  assert.deepEqual(h.ha.writes.map((c) => c.args), [{ name: "Ön Kapı" }]);
});

test("a name-only call on a light or a plug the user named: no card (T4.8 raises sensitive kinds only)", async () => {
  const h = await harness();
  h.model.queue.push([turnOff("Sonoff Priz"), turnOff("Mutfak Işık 1")]);
  await h.say("sonoff priz ve mutfak ışık 1 kapansın");
  assert.equal(h.model.calls.length, 1);
  assert.equal(h.confirms().length, 0);
  assert.deepEqual(h.ha.writes.map((c) => c.args.name), ["Sonoff Priz", "Mutfak Işık 1"]);
  assert.equal(h.ha.readsBeforeWrite, 1, "no tier-0 rule: the gate's one read, cached for both calls");
});

test("broken or empty live context neither starts nor clears missingSince (tier-0 read and gate read)", async () => {
  const c = clock();
  const h = await harness({ clock: c });
  await confirmPumpName(h);

  // Start: tier 0 and the gate read a broken / empty context; the clock does not start.
  for (const live of [BROKEN, EMPTY]) {
    h.ha.live = live;
    c.tick(DAY);
    h.model.queue.push([turnOff("Bahçe Pompası")]);
    await h.sayAndAnswer("bahçe pompasnı kapat", (r) => h.respond(r, false));
    assert.equal((await h.entry())?.missingSince, null);
  }

  // A valid read without the device starts it.
  h.ha.live = { text: liveContext(["pump"]), isError: false };
  c.tick(DAY);
  const started = new Date(c.now()).toISOString();
  h.model.queue.push([]);
  await h.say("bahçe pompasnı kapat");
  assert.equal((await h.entry())?.missingSince, started);

  // Clear / restart: broken and empty reads leave it as it was.
  for (const live of [BROKEN, EMPTY]) {
    h.ha.live = live;
    c.tick(DAY);
    h.model.queue.push([turnOff("Bahçe Pompası")]);
    await h.sayAndAnswer("bahçe pompasnı kapat", (r) => h.respond(r, false));
    assert.equal((await h.entry())?.missingSince, started);
  }
  assert.equal((await h.entry())?.status, "active");
  assert.equal(h.ha.writes.length, 1, "only the first (approved) write");
});
