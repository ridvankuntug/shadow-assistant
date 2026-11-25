/**
 * T4.3b: the write gate (docs/14) wired into the session. Home Assistant and
 * the model are mocked; nothing real is switched. Generic names only.
 *
 * - tier 0: clear commands get no card and no extra HA call; a tier-0 rule in
 *   a question turn opens the same confirm card (no fallback);
 * - model path: question turns and targets the user did not name ask first;
 *   a name in the last three user utterances does not;
 * - read tools, read-only mode and services without `target_check` are unchanged.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AgentRunner, TurnCallbacks, TurnRequest, TurnResult } from "../src/agent.js";
import { ConversationLog } from "../src/conversation-log.js";
import { learnPolicy } from "../src/learn/extract.js";
import type { DirectToolClient, DirectToolResult } from "../src/mcp-direct.js";
import { GATE_SUMMARY_SUFFIX, PermissionPolicy } from "../src/permissions.js";
import type { ServerFrame } from "../src/protocol.js";
import { parseRouterConfig } from "../src/router-config.js";
import { TieredRouter } from "../src/router.js";
import { parseServices } from "../src/services.js";
import { Session, type SessionLearning } from "../src/session.js";

const base = mkdtempSync(join(tmpdir(), "shadow-session-gate-test-"));
const open: Session[] = [];
after(async () => {
  await Promise.all(open.map((s) => s.close("test_end")));
  rmSync(base, { recursive: true, force: true });
});

const HA = "mcp__home-assistant__";
const LIVE_TOOL = "homeassistant__GetLiveContext";
const MODELS = { 1: "m-haiku", 2: "m-sonnet", 3: "m-opus" } as const;

const LIVE = JSON.stringify({
  result: [
    "Live Context: An overview of the areas and the devices in this smart home:",
    "- names: Salon Lamba",
    "  domain: light",
    "  state: 'off'",
    "  areas: Salon",
    "- names: Bahçe Pompası",
    "  domain: switch",
    "  state: 'on'",
    "  areas: Bahçe",
    // A plug: a name-only call on a switch without it always asks (docs/14 decision 9, T4.8).
    "  attributes:",
    "    device_class: outlet",
  ].join("\n"),
});

const ROUTER_YAML = `
version: 1
rules:
  - id: light-off
    tier: 0
    patterns: ["<ad> ışığını kapat"]
    service: home-assistant
    tool: intent__HassTurnOff
    domains: [light]
    keywords: [lamba]
    reply: "Tamam, {ad} ışığı kapatıldı."
  - id: light-level
    tier: 0
    patterns: ["<ad> ışığını yüzde <sayi> yap"]
    service: home-assistant
    tool: light__HassLightSet
    domains: [light]
    keywords: [lamba]
    reply: "Tamam."
learning:
  keywords:
    light: [ışık, ışıkları, lamba]
`;

function servicesYaml(targetCheck = true) {
  return parseServices(
    [
      "services:",
      "  - name: home-assistant",
      "    kind: mcp",
      "    url: http://localhost:1/sse",
      "    permission: confirm",
      ...(targetCheck ? ["    target_check: true"] : []),
      "    tools:",
      `      "${LIVE_TOOL}": read`,
      '      "intent__HassTurnOn": write',
      '      "intent__HassTurnOff": write',
      '      "intent__HassCancelAllTimers": write',
      '      "light__HassLightSet": write',
      '      "*Lock*": confirm',
    ].join("\n"),
    {},
  ).services;
}

class MockHa implements DirectToolClient {
  calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  live: DirectToolResult = { text: LIVE, isError: false };
  async callTool(_service: string, tool: string, args: Record<string, unknown>): Promise<DirectToolResult> {
    this.calls.push({ tool, args });
    if (tool === LIVE_TOOL) return this.live;
    return { text: "ok", isError: false };
  }
  get reads() {
    return this.calls.filter((c) => c.tool === LIVE_TOOL).length;
  }
  get writes() {
    return this.calls.filter((c) => c.tool !== LIVE_TOOL);
  }
}

interface ToolUse {
  tool: string;
  args: Record<string, unknown>;
}

/** Legacy runner: each turn makes the next plan's tool calls through the gate and records the decisions. */
class MockAgent implements AgentRunner {
  calls: TurnRequest[] = [];
  queue: ToolUse[][] = [];
  decisions: Array<{ tool: string; behavior: string; message?: string }> = [];
  private seq = 0;
  async runTurn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult> {
    this.calls.push(req);
    for (const u of this.queue.shift() ?? []) {
      const id = `tu-${++this.seq}`;
      const d = await req.canUseTool(`${HA}${u.tool}`, u.args, { signal: req.signal ?? new AbortController().signal, toolUseID: id });
      this.decisions.push({ tool: u.tool, behavior: d.behavior, ...("message" in d ? { message: d.message } : {}) });
      if (d.behavior === "allow") cb.onToolResult?.(id, `${HA}${u.tool}`, false);
    }
    cb.onDelta("Tamam.");
    return { text: "", inputTokens: 1, outputTokens: 1, durationMs: 5, sessionId: `sdk-${this.calls.length}`, tools: [] };
  }
}

interface LogLine {
  kind: string;
  tool?: string;
  level?: string;
  reason?: string;
  decision?: string;
}

let counter = 0;
function harness(
  o: { targetCheck?: boolean; readOnly?: boolean; learning?: boolean; gateWords?: boolean; confirmTimeoutMs?: number; transcript?: string } = {},
) {
  const dir = join(base, `d${++counter}`);
  const config = parseRouterConfig(ROUTER_YAML);
  const services = servicesYaml(o.targetCheck ?? true);
  const router = new TieredRouter({ config, models: MODELS });
  const frames: ServerFrame[] = [];
  const waiters: Array<() => void> = [];
  const ha = new MockHa();
  const agent = new MockAgent();
  const log = new ConversationLog(dir);
  const learning: SessionLearning | undefined = o.learning
    ? { store: { observe: async () => undefined, recordOutcome: async () => ({ suspended: false }) } as never, policy: learnPolicy(config, services) }
    : undefined;
  const session = new Session(
    {
      agent,
      policy: new PermissionPolicy(services, { readOnly: o.readOnly }),
      router,
      stt: { transcribe: async () => ({ text: o.transcript ?? "" }) },
      tts: { synthesize: async () => ({ mime: "audio/wav", data: Buffer.from("RIFF") }), voices: async () => ({ default: "v", voices: ["v"] }) },
      log,
      logger: { info: () => {}, warn: () => {} },
      confirmTimeoutMs: o.confirmTimeoutMs ?? 5_000,
      direct: ha,
      ...(learning ? { learning } : {}),
      // Like index.ts: the router words reach the gate whether or not learning is on (T4.11).
      ...(o.gateWords ? { gateWords: { domainWords: config.learning.keywords, denyNameWords: config.learning.denyNameWords } } : {}),
    },
    { sessionId: `s${counter}`, device: "browser" },
    (f) => {
      frames.push(f);
      waiters.splice(0).forEach((w) => w());
    },
  );
  open.push(session);
  let turn = 0;
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
  return {
    session,
    ha,
    agent,
    frames,
    say: (text: string) => session.handle({ type: "user_text", id: `t${++turn}`, text }),
    /** Says `text` and answers the (first new) confirm card with `approved`. */
    sayAndAnswer: async (text: string, approved: boolean) => {
      const before = frames.filter((f) => f.type === "confirm_request").length;
      const done = session.handle({ type: "user_text", id: `t${++turn}`, text });
      const req = (await waitFor((f) => f.type === "confirm_request" && frames.filter((x) => x.type === "confirm_request").indexOf(f) >= before)) as Extract<
        ServerFrame,
        { type: "confirm_request" }
      >;
      await session.handle({ type: "confirm_response", requestId: req.requestId, approved });
      await done;
      return req;
    },
    confirms: () => frames.filter((f) => f.type === "confirm_request") as Array<Extract<ServerFrame, { type: "confirm_request" }>>,
    lastDone: () => (frames.filter((f) => f.type === "assistant_done").at(-1) as Extract<ServerFrame, { type: "assistant_done" }> | undefined)?.text,
    /** Conversation log lines (after a close flush). */
    lines: async (): Promise<LogLine[]> => {
      await session.close("read_log");
      const { readdirSync, readFileSync } = await import("node:fs");
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

const turnOff = (name: string): ToolUse => ({ tool: "intent__HassTurnOff", args: { name } });

// ------------------------------------------------------------------ tier 0

test("tier 0 clear command: no card, no extra live-context read, two HA calls", async () => {
  const h = harness();
  await h.say("salon ışığını kapat");
  assert.equal(h.confirms().length, 0);
  assert.equal(h.ha.reads, 1);
  assert.equal(h.ha.calls.length, 2);
  assert.deepEqual(h.ha.writes.map((c) => c.args.name), ["Salon Lamba"]);
  assert.equal(h.agent.calls.length, 0);
  const call = (await h.lines()).find((l) => l.kind === "tool_call" && l.tool === `${HA}intent__HassTurnOff`);
  assert.equal(call?.level, "write");
  assert.doesNotMatch(call?.reason ?? "", /gate/);
});

test("tier 0 rule in a question turn: the same confirm card, no fallback; declined -> no write", async () => {
  const h = harness();
  const req = await h.sayAndAnswer("salon ışığını kapat?", false);
  assert.ok(req.summary.endsWith(GATE_SUMMARY_SUFFIX.question_turn), req.summary);
  assert.equal(h.confirms().length, 1);
  assert.equal(h.ha.writes.length, 0);
  assert.equal(h.ha.reads, 1); // tier 0's own read only
  assert.equal(h.agent.calls.length, 0); // no fallback to the model
  const call = (await h.lines()).find((l) => l.kind === "tool_call" && l.tool === `${HA}intent__HassTurnOff`);
  assert.equal(call?.level, "confirm");
  assert.match(call?.reason ?? "", /\+gate:question_turn$/);
});

test("tier 0 rule in a question turn: approved -> the write runs", async () => {
  const h = harness();
  await h.sayAndAnswer("salon ışığını kapat?", true);
  assert.deepEqual(h.ha.writes.map((c) => c.args.name), ["Salon Lamba"]);
  assert.equal(h.agent.calls.length, 0);
});

// ------------------------------------------------------------------ model path: question lock

test("model write in a question turn: exactly one confirm card; declined -> denied, nothing written", async () => {
  const h = harness();
  h.agent.queue.push([turnOff("Bahçe Pompası")]);
  const req = await h.sayAndAnswer("bahçe pompası açık mı", false);
  assert.equal(h.confirms().length, 1);
  assert.equal(req.tool, "intent__HassTurnOff");
  assert.ok(req.summary.endsWith(GATE_SUMMARY_SUFFIX.question_turn), req.summary);
  assert.deepEqual(h.agent.decisions.map((d) => d.behavior), ["deny"]);
  assert.equal(h.ha.calls.length, 0); // the question lock needs no live-context read
  const lines = await h.lines();
  assert.match(lines.find((l) => l.kind === "tool_call")?.reason ?? "", /\+gate:question_turn$/);
  assert.equal(lines.find((l) => l.kind === "permission")?.decision, "deny");
});

test("model write in a question turn: timeout -> denied", async () => {
  const h = harness({ confirmTimeoutMs: 50 });
  h.agent.queue.push([turnOff("Bahçe Pompası")]);
  await h.say("hangi cihazlar açık");
  assert.equal(h.confirms().length, 1);
  assert.equal(h.agent.decisions[0]?.behavior, "deny");
  assert.match(h.agent.decisions[0]?.message ?? "", /did not confirm in time/);
});

test("mixed question + command: one card per write; approved -> allowed", async () => {
  const h = harness();
  h.agent.queue.push([turnOff("Salon Lamba")]);
  await h.sayAndAnswer("hangi ışıklar açık, salon lambasını kapat", true);
  assert.equal(h.confirms().length, 1);
  assert.deepEqual(h.agent.decisions.map((d) => d.behavior), ["allow"]);
});

test("confirm-level tool in a question turn: one card with the question note", async () => {
  const h = harness();
  h.agent.queue.push([{ tool: "lock__HassLock", args: { name: "Bahçe Kapısı" } }]);
  const req = await h.sayAndAnswer("kapı kilitli mi", false);
  assert.equal(h.confirms().length, 1);
  assert.ok(req.summary.endsWith(GATE_SUMMARY_SUFFIX.question_turn), req.summary);
});

test("read tools are not touched by the question lock", async () => {
  const h = harness();
  h.agent.queue.push([{ tool: LIVE_TOOL, args: {} }]);
  await h.say("hangi ışıklar açık");
  assert.equal(h.confirms().length, 0);
  assert.deepEqual(h.agent.decisions.map((d) => d.behavior), ["allow"]);
});

test("polite request is not a question: user-named target runs without a card", async () => {
  const h = harness();
  h.agent.queue.push([turnOff("Bahçe Pompası")]);
  await h.say("bahçe pompasını kapatır mısın");
  assert.equal(h.confirms().length, 0);
  assert.deepEqual(h.agent.decisions.map((d) => d.behavior), ["allow"]);
});

// ------------------------------------------------------------------ model path: provenance

test("user named the target: no card; a name-only call reads the live context once (T4.8)", async () => {
  const h = harness();
  h.agent.queue.push([turnOff("Bahçe Pompası")]);
  await h.say("bahçe pompasını kapat");
  assert.equal(h.confirms().length, 0);
  assert.equal(h.ha.reads, 1);
  assert.equal(h.ha.writes.length, 0); // the mock agent never sends the write itself
  assert.deepEqual(h.agent.decisions.map((d) => d.behavior), ["allow"]);
});

test("unknown target: one card with the unknown-target note; one live-context read per turn", async () => {
  const h = harness();
  h.agent.queue.push([turnOff("Bahçe Pompası"), turnOff("Salon Lamba")]);
  const done = h.say("şunu kapat");
  const first = (await new Promise<ServerFrame>((res) => {
    const iv = setInterval(() => {
      const f = h.confirms()[0];
      if (f) {
        clearInterval(iv);
        res(f);
      }
    }, 2);
  })) as Extract<ServerFrame, { type: "confirm_request" }>;
  assert.ok(first.summary.endsWith(GATE_SUMMARY_SUFFIX.unknown_target), first.summary);
  await h.session.handle({ type: "confirm_response", requestId: first.requestId, approved: true });
  await new Promise<void>((res) => {
    const iv = setInterval(() => {
      const f = h.confirms()[1];
      if (f) {
        clearInterval(iv);
        void h.session.handle({ type: "confirm_response", requestId: f.requestId, approved: false }).then(res);
      }
    }, 2);
  });
  await done;
  assert.equal(h.confirms().length, 2);
  assert.equal(h.ha.reads, 1); // cached for the turn
  assert.deepEqual(h.agent.decisions.map((d) => d.behavior), ["allow", "deny"]);
  const reasons = (await h.lines()).filter((l) => l.kind === "tool_call").map((l) => l.reason);
  assert.ok(reasons.every((r) => r?.endsWith("+gate:unknown_target")), String(reasons));
});

test("unknown target and the live-context read fails: still a card", async () => {
  const h = harness();
  h.ha.live = { text: "boom", isError: true };
  h.agent.queue.push([turnOff("Bahçe Pompası")]);
  const req = await h.sayAndAnswer("şunu kapat", false);
  assert.ok(req.summary.endsWith(GATE_SUMMARY_SUFFIX.unknown_target));
  assert.equal(h.ha.reads, 1);
  assert.equal(h.agent.decisions[0]?.behavior, "deny");
});

test("unknown target on a confirm-level tool: the usual card, no gate read, no gate note", async () => {
  const h = harness();
  h.agent.queue.push([{ tool: "lock__HassLock", args: { name: "Bahçe Kapısı" } }]);
  const req = await h.sayAndAnswer("şunu kilitle", false);
  assert.equal(h.confirms().length, 1);
  assert.equal(h.ha.calls.length, 0);
  assert.ok(!req.summary.includes(GATE_SUMMARY_SUFFIX.unknown_target));
});

test("no-target write (cancel all timers): only the question lock applies", async () => {
  const h = harness();
  h.agent.queue.push([{ tool: "intent__HassCancelAllTimers", args: {} }]);
  await h.say("zamanlayıcıları iptal et");
  assert.equal(h.confirms().length, 0);
  assert.equal(h.agent.decisions[0]?.behavior, "allow");
});

test("window: a name from the previous utterance counts; four utterances back does not", async () => {
  const h = harness();
  h.agent.queue.push([], [turnOff("Bahçe Pompası")]);
  await h.say("bahçe pompası açık mı");
  await h.say("kapat");
  assert.equal(h.confirms().length, 0);
  assert.deepEqual(h.agent.decisions.map((d) => d.behavior), ["allow"]);

  h.agent.queue.push([], [], [turnOff("Bahçe Pompası")]);
  await h.say("teşekkürler");
  await h.say("hava nasıl");
  // "bahçe pompası açık mı" is now the 4th utterance back (kapat, teşekkürler, hava nasıl, this one).
  const req = await h.sayAndAnswer("kapat", false);
  assert.ok(req.summary.endsWith(GATE_SUMMARY_SUFFIX.unknown_target), req.summary);
});

test("window: a spoken confirm answer is a user utterance and moves the window", async () => {
  const h = harness({ transcript: "hayır" });
  h.agent.queue.push([turnOff("Bahçe Pompası")], [], [turnOff("Bahçe Pompası")]);
  const first = h.say("bahçe pompası açık mı");
  await new Promise<void>((res) => {
    const iv = setInterval(() => {
      if (h.confirms().length === 1) {
        clearInterval(iv);
        res();
      }
    }, 2);
  });
  await h.session.handle({ type: "audio", id: "v1", mime: "audio/webm", data: Buffer.from("fake").toString("base64") });
  await first;
  assert.equal(h.agent.decisions[0]?.behavior, "deny");
  await h.say("teşekkürler");
  // Window: "hayır", "teşekkürler", "kapat": the naming utterance is 4th back.
  const req = await h.sayAndAnswer("kapat", false);
  assert.ok(req.summary.endsWith(GATE_SUMMARY_SUFFIX.unknown_target), req.summary);
});

test("the call is aborted while the gate reads the live context: denied, no card", async () => {
  const h = harness();
  let release!: () => void;
  const gateRead = new Promise<void>((r) => (release = r));
  const callAbort = new AbortController();
  const orig = h.ha.callTool.bind(h.ha);
  h.ha.callTool = async (service, tool, args) => {
    if (tool === LIVE_TOOL) {
      callAbort.abort();
      await gateRead;
    }
    return orig(service, tool, args);
  };
  let decision: { behavior: string; message?: string } | undefined;
  h.agent.runTurn = async (req, cb) => {
    const d = await req.canUseTool(`${HA}intent__HassTurnOff`, { name: "Bahçe Pompası" }, { signal: callAbort.signal, toolUseID: "tu-x" });
    decision = { behavior: d.behavior, ...("message" in d ? { message: d.message } : {}) };
    cb.onDelta("Tamam.");
    return { text: "", inputTokens: 1, outputTokens: 1, durationMs: 5, sessionId: "sdk-x", tools: [] };
  };
  const done = h.say("şunu kapat");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(decision?.behavior, "deny"); // denied without waiting for the read
  release();
  await done;
  assert.equal(h.confirms().length, 0);
  assert.match(decision?.message ?? "", /cancelled/i);
});

test("window: assistant text never counts", async () => {
  const h = harness();
  // The model's own reply ("Tamam.") and a guess it might voice are not the user's words.
  h.agent.queue.push([], [turnOff("Bahçe Pompası")]);
  await h.say("merhaba");
  await h.sayAndAnswer("evet onu kapat", false);
  assert.equal(h.confirms().length, 1);
});

test("window: a tier-0 turn's text counts as the user's words", async () => {
  // Learning on: its router keywords let "salon ışığını" (area + device word) name "Salon Lamba" (rule 4).
  const h = harness({ learning: true });
  await h.say("salon ışığını kapat"); // tier 0
  h.agent.queue.push([{ tool: "intent__HassTurnOn", args: { name: "Salon Lamba" } }]);
  await h.say("geri aç");
  assert.equal(h.confirms().length, 0);
  assert.deepEqual(h.agent.decisions.map((d) => d.behavior), ["allow"]);
});

test("broad call with a whole-set word and a device word: known (router keywords)", async () => {
  const h = harness({ learning: true });
  h.agent.queue.push([{ tool: "intent__HassTurnOff", args: { domain: ["light"] } }]);
  await h.say("bütün ışıkları söndür");
  assert.equal(h.agent.calls.length, 1); // the model path, not tier 0
  assert.equal(h.confirms().length, 0);
  assert.equal(h.agent.decisions[0]?.behavior, "allow");
  // No whole-set word in the window: unknown.
  const other = harness({ learning: true });
  other.agent.queue.push([{ tool: "intent__HassTurnOff", args: { domain: ["light"] } }]);
  const req = await other.sayAndAnswer("biraz karanlık olsun", false);
  assert.ok(req.summary.endsWith(GATE_SUMMARY_SUFFIX.unknown_target), req.summary);
});

// ------------------------------------------------------------------ unchanged ceilings

test("service without target_check: question turn and unknown target are not raised", async () => {
  const h = harness({ targetCheck: false });
  h.agent.queue.push([turnOff("Bahçe Pompası")], [turnOff("Bahçe Pompası")]);
  await h.say("hangi cihazlar açık");
  await h.say("şunu kapat");
  assert.equal(h.confirms().length, 0);
  assert.equal(h.ha.calls.length, 0);
  assert.deepEqual(h.agent.decisions.map((d) => d.behavior), ["allow", "allow"]);
});

test("read-only mode: a question-turn write is denied read_only, no card, no gate read", async () => {
  const h = harness({ readOnly: true });
  h.agent.queue.push([turnOff("Bahçe Pompası")], [turnOff("Bahçe Pompası")]);
  await h.say("bahçe pompası açık mı");
  await h.say("şunu kapat");
  assert.equal(h.confirms().length, 0);
  assert.equal(h.ha.calls.length, 0);
  assert.ok(h.agent.decisions.every((d) => d.behavior === "deny" && /Read-only/.test(d.message ?? "")));
});

test("escalation tier 1 -> tier 2 keeps the question lock: the tier-2 write still asks", async () => {
  const h = harness();
  const real = h.agent.runTurn.bind(h.agent);
  let n = 0;
  h.agent.runTurn = async (req, cb) => {
    if (++n === 1) {
      // Tier-1 attempt hands off: marker only, no tool call.
      h.agent.calls.push(req);
      cb.onDelta("[[ESCALATE]]");
      return { text: "", inputTokens: 1, outputTokens: 1, durationMs: 5, sessionId: "sdk-esc", tools: [] };
    }
    return real(req, cb);
  };
  h.agent.queue.push([turnOff("Bahçe Pompası")]);
  const req = await h.sayAndAnswer("bahçe pompası açık mı", false);
  assert.ok(n >= 2, "turn escalated to a second model call");
  assert.equal(h.confirms().length, 1);
  assert.ok(req.summary.endsWith(GATE_SUMMARY_SUFFIX.question_turn), req.summary);
  assert.deepEqual(h.agent.decisions.map((d) => d.behavior), ["deny"]);
  assert.equal(h.ha.writes.length, 0);
});

// ------------------------------------------------------------------ T4.8 / T4.9 / T4.11 (docs/14 decisions 9, 10, 12)

/** A live context of the given entities (`names`, `domain`, `areas`, optional device class). */
function live(...entities: Array<{ names: string; domain: string; areas?: string; deviceClass?: string }>): DirectToolResult {
  const lines = entities.flatMap((e) => [
    `- names: ${e.names}`,
    `  domain: ${e.domain}`,
    "  state: 'on'",
    ...(e.areas ? [`  areas: ${e.areas}`] : []),
    ...(e.deviceClass ? ["  attributes:", `    device_class: ${e.deviceClass}`] : []),
  ]);
  return { text: JSON.stringify({ result: ["Live Context: An overview of the areas and the devices in this smart home:", ...lines].join("\n") }), isError: false };
}
const LAMP = { names: "Salon Lambası", domain: "light", areas: "Salon" };
const LAMP2 = { names: "Salon Lambası 2", domain: "light", areas: "Salon" };
const lampOff = (args: Record<string, unknown> = {}): ToolUse => ({ tool: "intent__HassTurnOff", args: { name: "Salon Lambası", ...args } });

test("T4.9: 'salon lambası 2 kapat' and the model calls 'Salon Lambası' -> card (unknown target); declined -> denied", async () => {
  for (const call of [lampOff({ domain: ["light"] }), lampOff()]) {
    const h = harness();
    h.ha.live = live(LAMP, LAMP2);
    h.agent.queue.push([call]);
    const req = await h.sayAndAnswer("salon lambası 2 kapat", false);
    assert.equal(h.agent.calls.length, 1, "no tier-0 rule: the model path");
    assert.ok(req.summary.endsWith(GATE_SUMMARY_SUFFIX.unknown_target), req.summary);
    assert.deepEqual(h.agent.decisions.map((d) => d.behavior), ["deny"]);
    assert.equal(h.ha.reads, 1, "one gate read");
  }
});

test("T4.9: the name the user said, fitting the whole phrase -> no card (with a similar lamp, and alone)", async () => {
  for (const home of [live(LAMP, LAMP2), live(LAMP)]) {
    const h = harness();
    h.ha.live = home;
    h.agent.queue.push([lampOff({ domain: ["light"] })]);
    await h.say("salon lambasını kapat");
    assert.equal(h.confirms().length, 0);
    assert.deepEqual(h.agent.decisions.map((d) => d.behavior), ["allow"]);
    assert.equal(h.ha.reads, 1, "the fit check reads the live context once");
  }
  // Two devices in one command: the other phrase is next to the name, not part of it.
  const two = harness();
  two.ha.live = live(LAMP, LAMP2);
  two.agent.queue.push([lampOff({ domain: ["light"] }), { tool: "intent__HassTurnOff", args: { name: "Salon Lambası 2", domain: ["light"] } }]);
  await two.say("salon lambasını ve salon lambası 2 yi kapat");
  assert.equal(two.confirms().length, 0);
  assert.deepEqual(two.agent.decisions.map((d) => d.behavior), ["allow", "allow"]);
});

test("T4.9: an utterance that is only the name needs no read; a failed read keeps a text match (with a domain)", async () => {
  const h = harness();
  h.ha.live = live(LAMP, LAMP2);
  h.agent.queue.push([lampOff({ domain: ["light"] })]);
  await h.say("salon lambası");
  assert.equal(h.confirms().length, 0);
  assert.equal(h.ha.reads, 0);

  const broken = harness();
  broken.ha.live = { text: "boom", isError: true };
  broken.agent.queue.push([lampOff({ domain: ["light"] })]);
  await broken.say("salon lambasını kapat");
  assert.equal(broken.confirms().length, 0);
  assert.equal(broken.ha.reads, 1);
});

test("T4.8: a name-only call when the live context is not usable, or the name reaches no device -> card (unverified)", async () => {
  const h = harness();
  h.ha.live = { text: "boom", isError: true };
  h.agent.queue.push([turnOff("Bahçe Pompası")]);
  const req = await h.sayAndAnswer("bahçe pompasını kapat", false);
  assert.ok(req.summary.endsWith(GATE_SUMMARY_SUFFIX.unverified_target), req.summary);
  assert.equal(req.remember, undefined);
  assert.deepEqual(h.agent.decisions.map((d) => d.behavior), ["deny"]);

  const none = harness();
  none.agent.queue.push([turnOff("Depo Lambası")]);
  const r2 = await none.sayAndAnswer("depo lambasını kapat", false);
  assert.ok(r2.summary.endsWith(GATE_SUMMARY_SUFFIX.unverified_target), r2.summary);
  const call = (await none.lines()).find((l) => l.kind === "tool_call" && l.tool === `${HA}intent__HassTurnOff`);
  assert.match(call?.reason ?? "", /\+gate:unverified_target$/);
});

test("T4.8: a name-only call on a switch without a device class the user named -> card (sensitive); with a domain -> no T4.8 check", async () => {
  const h = harness();
  h.ha.live = live({ names: "Bahçe Pompası", domain: "switch", areas: "Bahçe" });
  h.agent.queue.push([turnOff("Bahçe Pompası")]);
  const req = await h.sayAndAnswer("bahçe pompasını kapat", false);
  assert.ok(req.summary.endsWith(GATE_SUMMARY_SUFFIX.sensitive_target), req.summary);
  assert.equal(req.remember, undefined);

  const d = harness();
  d.ha.live = live({ names: "Bahçe Pompası", domain: "switch", areas: "Bahçe" });
  d.agent.queue.push([{ tool: "intent__HassTurnOff", args: { name: "Bahçe Pompası", domain: ["switch"] } }]);
  await d.say("bahçe pompasını kapat");
  assert.equal(d.confirms().length, 0);
});

test("T4.8: tier 0 does no name-only read (its hint skips the gate's target checks)", async () => {
  const h = harness();
  await h.say("salon ışığını kapat");
  assert.equal(h.confirms().length, 0);
  assert.equal(h.ha.reads, 1, "tier 0's own read only");
  assert.equal(h.ha.calls.length, 2);
});

test("T4.9: tier 0 brightness 'salon ışığını yüzde 40 yap': two HA calls, no card, no extra live-context read", async () => {
  const h = harness({ gateWords: true });
  await h.say("salon ışığını yüzde 40 yap");
  assert.equal(h.agent.calls.length, 0, "tier 0, not the model");
  assert.equal(h.confirms().length, 0);
  assert.equal(h.ha.reads, 1, "tier 0's own read only");
  assert.equal(h.ha.calls.length, 2);
  assert.deepEqual(h.ha.writes.map((c) => [c.tool, c.args.name, c.args.brightness]), [["light__HassLightSet", "Salon Lamba", 40]]);
});

test("T4.11: learning off, 'tüm ışıkları kapat' broad call -> no card (router words reach the gate); without them -> card", async () => {
  const h = harness({ gateWords: true });
  h.agent.queue.push([{ tool: "intent__HassTurnOff", args: { domain: ["light"] } }]);
  await h.say("tüm ışıkları kapat");
  assert.equal(h.agent.calls.length, 1, "the model path, not tier 0");
  assert.equal(h.confirms().length, 0);
  assert.deepEqual(h.agent.decisions.map((d) => d.behavior), ["allow"]);
  assert.equal(h.ha.reads, 0, "a broad call needs no read");

  const without = harness();
  without.agent.queue.push([{ tool: "intent__HassTurnOff", args: { domain: ["light"] } }]);
  const req = await without.sayAndAnswer("tüm ışıkları kapat", false);
  assert.ok(req.summary.endsWith(GATE_SUMMARY_SUFFIX.unknown_target), req.summary);
});
