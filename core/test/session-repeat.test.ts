/**
 * T4.7: the repeated-error stop (docs/14 Decision 10) wired into the session.
 * Home Assistant and the model are mocked; nothing real is switched. Generic
 * names only.
 *
 * - the same failure twice for one argument class -> the third call of that
 *   class is denied `repeated_error` and never sent; the model gets the message;
 * - different error texts or another argument class -> not blocked;
 * - tier 0 is not counted; the count holds across tier-1 -> tier-2
 *   escalation and starts again in the next turn;
 * - the persistent path (ProviderSession attempts) counts the same way; a
 *   blocked confirm tool opens no card; a parallel call whose class is blocked
 *   while it waits for its card is still not sent.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AgentRunner, TurnCallbacks, TurnRequest, TurnResult } from "../src/agent.js";
import { ConversationLog } from "../src/conversation-log.js";
import type { DirectToolClient, DirectToolResult } from "../src/mcp-direct.js";
import type { AttemptHandle, AttemptOutcome, AttemptRequest, ProviderSession } from "../src/model-provider.js";
import { PermissionPolicy } from "../src/permissions.js";
import type { ServerFrame } from "../src/protocol.js";
import { parseRouterConfig } from "../src/router-config.js";
import { ESCALATION_MARKER, TieredRouter } from "../src/router.js";
import { parseServices } from "../src/services.js";
import { Session, type SessionRegistry } from "../src/session.js";

const base = mkdtempSync(join(tmpdir(), "shadow-session-repeat-test-"));
const open: Session[] = [];
after(async () => {
  await Promise.all(open.map((s) => s.close("test_end")));
  rmSync(base, { recursive: true, force: true });
});

const HA = "mcp__home-assistant__";
const LIVE_TOOL = "homeassistant__GetLiveContext";
const MODELS = { 1: "m-haiku", 2: "m-sonnet", 3: "m-opus" } as const;
const REPEATED = "This tool failed twice in this form in this turn; do not try it again in the same form. Tell the user what happened.";
/** The 2026-11-17 failure: GetLiveContext does not take a `name`. */
const NAME_ERROR = "MCP error -32602: Invalid arguments for tool GetLiveContext: extra keys not allowed @ data['name']";

const LIVE = JSON.stringify({
  result: [
    "Live Context: An overview of the areas and the devices in this smart home:",
    "- names: Salon Lamba",
    "  domain: light",
    "  state: 'on'",
    "  areas: Salon",
  ].join("\n"),
});

const ROUTER_YAML = `
version: 1
direct:
  on_tool_error: fallback
rules:
  - id: light-off
    tier: 0
    patterns: ["<ad> ışığını kapat"]
    service: home-assistant
    tool: intent__HassTurnOff
    domains: [light]
    keywords: [lamba]
    reply: "Tamam, {ad} ışığı kapatıldı."
`;

const services = parseServices(
  [
    "services:",
    "  - name: home-assistant",
    "    kind: mcp",
    "    url: http://localhost:1/sse",
    "    permission: confirm",
    "    tools:",
    `      "${LIVE_TOOL}": read`,
    '      "intent__HassTurnOn": write',
    '      "intent__HassTurnOff": write',
    '      "intent__HassLock": confirm',
  ].join("\n"),
  {},
).services;

/** Fake HA: scripted results per tool (consumed in order; the last one repeats), every sent call recorded. */
class MockHa implements DirectToolClient {
  calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  results = new Map<string, DirectToolResult[]>();
  /** Result of a call; GetLiveContext with no input defaults to the live context. */
  run(tool: string, args: Record<string, unknown>): DirectToolResult {
    this.calls.push({ tool, args });
    const list = this.results.get(tool);
    if (list && list.length > 0) return (list.length > 1 ? list.shift() : list[0]) as DirectToolResult;
    if (tool === LIVE_TOOL) return { text: LIVE, isError: false };
    return { text: "ok", isError: false };
  }
  async callTool(_service: string, tool: string, args: Record<string, unknown>): Promise<DirectToolResult> {
    return this.run(tool, args);
  }
  sent(tool: string) {
    return this.calls.filter((c) => c.tool === tool);
  }
}

interface ToolUse {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Legacy runner standing in for the SDK: each model call takes the next plan,
 * asks the gate for every tool use, sends allowed ones to the fake HA and
 * reports their results (with the error text) like the SDK does.
 */
class MockAgent implements AgentRunner {
  calls: TurnRequest[] = [];
  queue: Array<{ uses: ToolUse[]; escalate?: boolean }> = [];
  decisions: Array<{ tool: string; behavior: string; message?: string }> = [];
  private seq = 0;
  constructor(private readonly ha: MockHa) {}
  async runTurn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult> {
    this.calls.push(req);
    const plan = this.queue.shift() ?? { uses: [] };
    for (const u of plan.uses) {
      const id = `tu-${++this.seq}`;
      const d = await req.canUseTool(`${HA}${u.tool}`, u.args, { signal: req.signal ?? new AbortController().signal, toolUseID: id });
      this.decisions.push({ tool: u.tool, behavior: d.behavior, ...("message" in d ? { message: d.message } : {}) });
      if (d.behavior !== "allow") continue;
      const r = this.ha.run(u.tool, u.args);
      cb.onToolResult?.(id, `${HA}${u.tool}`, r.isError, r.isError ? r.text : undefined);
    }
    cb.onDelta(plan.escalate ? ESCALATION_MARKER : "Tamam.");
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

/** Persistent path: one fake ProviderSession; each attempt runs the next script against the request. */
class FakeLive implements ProviderSession {
  readonly provider = "fake";
  sessionId: string | undefined = "sess-1";
  model: string = MODELS[1];
  busy = false;
  isClosed = false;
  attempts: AttemptRequest[] = [];
  scripts: Array<(req: AttemptRequest) => Promise<string>> = [];
  async ready(): Promise<void> {}
  runAttempt(req: AttemptRequest): AttemptHandle {
    this.attempts.push(req);
    const script = this.scripts.shift() ?? (async () => "Tamam.");
    const done = (async (): Promise<AttemptOutcome> => {
      await Promise.resolve();
      const text = await script(req);
      req.callbacks.onDelta(text);
      return { text, inputTokens: 1, outputTokens: 1, durationMs: 5, status: "ok", model: req.model, warm: true, queryAgeMs: 0, doneMs: 1 };
    })();
    return { done, settled: done, sent: Promise.resolve(true) };
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

function registryFor(live: FakeLive): SessionRegistry {
  const locked = new Set<string>();
  return {
    capabilities: { setModel: true, compact: false, notes: true, resume: true },
    acquire: async () => live,
    live: () => live,
    prewarm: () => {},
    beginTurn: (device: string) => (locked.has(device) ? false : (locked.add(device), true)),
    endTurn: (device: string) => void locked.delete(device),
    fallbackResume: async () => undefined,
    turnEnded: async () => {},
  } as unknown as SessionRegistry;
}

let counter = 0;
function harness(o: { live?: FakeLive; autoApprove?: boolean } = {}) {
  const dir = join(base, `d${++counter}`);
  const frames: ServerFrame[] = [];
  const ha = new MockHa();
  const agent = new MockAgent(ha);
  const infos: string[] = [];
  const session = new Session(
    {
      agent,
      policy: new PermissionPolicy(services, {}),
      router: new TieredRouter({ config: parseRouterConfig(ROUTER_YAML), models: MODELS }),
      stt: { transcribe: async () => ({ text: "" }) },
      tts: { synthesize: async () => ({ mime: "audio/wav", data: Buffer.from("RIFF") }), voices: async () => ({ default: "v", voices: ["v"] }) },
      log: new ConversationLog(dir),
      logger: { info: (m) => infos.push(m), warn: () => {} },
      confirmTimeoutMs: 5_000,
      direct: ha,
      ...(o.live ? { registry: registryFor(o.live) } : {}),
    },
    { sessionId: `s${counter}`, device: "browser" },
    (f) => {
      frames.push(f);
      if (o.autoApprove && f.type === "confirm_request") {
        setTimeout(() => void session.handle({ type: "confirm_response", requestId: f.requestId, approved: true }), 0);
      }
    },
  );
  open.push(session);
  let turn = 0;
  return {
    session,
    ha,
    agent,
    frames,
    infos,
    say: (text: string) => session.handle({ type: "user_text", id: `t${++turn}`, text }),
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

const err = (text: string): DirectToolResult => ({ text, isError: true });
const live = (args: Record<string, unknown> = {}): ToolUse => ({ tool: LIVE_TOOL, args });
const turnOn = (name: string): ToolUse => ({ tool: "intent__HassTurnOn", args: { name } });

test("same failure twice -> the third call of that class is not sent; the model gets repeated_error", async () => {
  const h = harness();
  h.ha.results.set("intent__HassTurnOn", [err("Entity not found")]);
  h.agent.queue.push({ uses: [turnOn("Mutfak Lamba"), turnOn("Mutfak Lamba"), turnOn("Mutfak Lamba")] });
  await h.say("mutfak lambasını yak");
  assert.equal(h.ha.sent("intent__HassTurnOn").length, 2);
  assert.deepEqual(
    h.agent.decisions.map((d) => d.behavior),
    ["allow", "allow", "deny"],
  );
  assert.equal(h.agent.decisions[2]?.message, REPEATED);
  assert.equal(h.frames.filter((f) => f.type === "confirm_request").length, 0);
  const tools = h.frames.filter((f) => f.type === "tool") as Array<Extract<ServerFrame, { type: "tool" }>>;
  assert.equal(tools.at(-1)?.status, "denied");
  assert.ok(h.infos.some((m) => m.includes("repeated_error")), h.infos.join("\n"));
  const lines = await h.lines();
  const denied = lines.filter((l) => l.kind === "tool_call" && l.reason === "repeated_error");
  assert.equal(denied.length, 1);
  assert.equal(denied[0]?.level, "deny");
  assert.equal(denied[0]?.tool, `${HA}intent__HassTurnOn`);
  assert.equal(lines.filter((l) => l.kind === "permission" && l.decision === "deny").length, 1);
});

test("numbers in the error text do not make the same failure look different", async () => {
  const h = harness();
  h.ha.results.set("intent__HassTurnOn", [err("Timeout after 1200 ms"), err("Timeout after 1350 ms")]);
  h.agent.queue.push({ uses: [turnOn("A"), turnOn("B"), turnOn("C")] });
  await h.say("lambayı yak");
  assert.deepEqual(h.agent.decisions.map((d) => d.behavior), ["allow", "allow", "deny"]);
  assert.equal(h.ha.sent("intent__HassTurnOn").length, 2);
});

test("different error texts -> not blocked", async () => {
  const h = harness();
  h.ha.results.set("intent__HassTurnOn", [err("Entity Mutfak not found"), err("Entity Banyo not found"), { text: "ok", isError: false }]);
  h.agent.queue.push({ uses: [turnOn("Mutfak"), turnOn("Banyo"), turnOn("Salon Lamba")] });
  await h.say("lambayı yak");
  assert.deepEqual(h.agent.decisions.map((d) => d.behavior), ["allow", "allow", "allow"]);
  assert.equal(h.ha.sent("intent__HassTurnOn").length, 3);
});

test("another argument class of the same tool -> not blocked", async () => {
  const h = harness();
  h.ha.results.set("intent__HassTurnOn", [err("bad"), err("bad"), { text: "ok", isError: false }]);
  h.agent.queue.push({
    uses: [turnOn("X"), turnOn("X"), { tool: "intent__HassTurnOn", args: { name: "Salon Lamba", area: "Salon" } }, turnOn("X")],
  });
  await h.say("lambayı yak");
  assert.deepEqual(h.agent.decisions.map((d) => d.behavior), ["allow", "allow", "allow", "deny"]);
  assert.equal(h.ha.sent("intent__HassTurnOn").length, 3);
});

test("2026-11-17: GetLiveContext {name} fails twice -> third not sent; GetLiveContext without input runs", async () => {
  const h = harness();
  // `name` calls fail with the same error; the no-input call returns the live context (MockHa default).
  const ha = h.ha;
  const run = ha.run.bind(ha);
  ha.run = (tool, args) => (tool === LIVE_TOOL && "name" in args ? (ha.calls.push({ tool, args }), err(NAME_ERROR)) : run(tool, args));
  h.agent.queue.push({ uses: [live({ name: "Sonoff" }), live({ name: "sonoff" }), live({ name: "Sonoff Priz" }), live()] });
  await h.say("sonoff hangi cihazlar var");
  assert.deepEqual(h.agent.decisions.map((d) => d.behavior), ["allow", "allow", "deny", "allow"]);
  assert.equal(h.agent.decisions[2]?.message, REPEATED);
  const sent = h.ha.sent(LIVE_TOOL);
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((c) => c.args), [{ name: "Sonoff" }, { name: "sonoff" }, {}]);
});

test("a success in between does not reset the count; a denial is not counted", async () => {
  const h = harness();
  h.ha.results.set("intent__HassTurnOn", [err("bad"), { text: "ok", isError: false }, err("bad")]);
  h.agent.queue.push({ uses: [turnOn("A"), turnOn("B"), turnOn("C"), turnOn("D"), turnOn("E")] });
  await h.say("lambayı yak");
  assert.deepEqual(h.agent.decisions.map((d) => d.behavior), ["allow", "allow", "allow", "deny", "deny"]);
  assert.equal(h.ha.sent("intent__HassTurnOn").length, 3);
});

test("the count starts again in the next turn", async () => {
  const h = harness();
  h.ha.results.set("intent__HassTurnOn", [err("bad")]);
  h.agent.queue.push({ uses: [turnOn("X"), turnOn("X")] });
  h.agent.queue.push({ uses: [turnOn("X")] });
  await h.say("lambayı yak");
  await h.say("tekrar dene");
  assert.deepEqual(h.agent.decisions.map((d) => d.behavior), ["allow", "allow", "allow"]);
  assert.equal(h.ha.sent("intent__HassTurnOn").length, 3);
});

test("the count holds across tier-1 -> tier-2 escalation of the same turn", async () => {
  const h = harness();
  h.ha.results.set("intent__HassTurnOn", [err("bad")]);
  h.agent.queue.push({ uses: [turnOn("X"), turnOn("X")], escalate: true });
  h.agent.queue.push({ uses: [turnOn("X"), turnOn("Y")] });
  await h.say("lambayı yak");
  assert.deepEqual(
    h.agent.calls.map((c) => c.model),
    [MODELS[1], MODELS[2]],
  );
  assert.deepEqual(h.agent.decisions.map((d) => d.behavior), ["allow", "allow", "deny", "deny"]);
  assert.equal(h.ha.sent("intent__HassTurnOn").length, 2);
});

test("tier 0 is not counted: a failed direct write plus one model failure does not block", async () => {
  const h = harness();
  h.ha.results.set("intent__HassTurnOff", [err("bad")]);
  h.agent.queue.push({ uses: [{ tool: "intent__HassTurnOff", args: { name: "Salon Lamba" } }, { tool: "intent__HassTurnOff", args: { name: "Salon Lamba" } }] });
  await h.say("salon ışığını kapat");
  // Tier 0 sent one write (failed, fell back); the model's two calls both reach HA.
  assert.equal(h.agent.calls.length, 1);
  assert.deepEqual(h.agent.decisions.map((d) => d.behavior), ["allow", "allow"]);
  assert.equal(h.ha.sent("intent__HassTurnOff").length, 3);
});

// ------------------------------------------------------------------ persistent path, confirm tools, parallel calls

/** Asks the gate for one tool use; when allowed, sends it to the fake HA and reports the result like the SDK. */
async function use(req: AttemptRequest, ha: MockHa, id: string, u: ToolUse): Promise<string> {
  const d = await req.canUseTool(`${HA}${u.tool}`, u.args, { signal: req.signal ?? new AbortController().signal, toolUseID: id });
  if (d.behavior !== "allow") return `deny:${"message" in d ? d.message : ""}`;
  const r = ha.run(u.tool, u.args);
  req.callbacks.onToolResult?.(id, `${HA}${u.tool}`, r.isError, r.isError ? r.text : undefined);
  return "allow";
}

test("persistent path: same failure twice -> third not sent; the count holds across escalation to tier 2", async () => {
  const live = new FakeLive();
  const h = harness({ live });
  h.ha.results.set("intent__HassTurnOn", [err("bad")]);
  const decisions: string[] = [];
  live.scripts.push(async (req) => {
    decisions.push(await use(req, h.ha, "p1", turnOn("X")));
    decisions.push(await use(req, h.ha, "p2", turnOn("X")));
    return ESCALATION_MARKER;
  });
  live.scripts.push(async (req) => {
    decisions.push(await use(req, h.ha, "p3", turnOn("X")));
    return "Olmadı.";
  });
  await h.say("lambayı yak");
  assert.deepEqual(live.attempts.map((a) => a.model), [MODELS[1], MODELS[2]]);
  assert.deepEqual(decisions, ["allow", "allow", `deny:${REPEATED}`]);
  assert.equal(h.ha.sent("intent__HassTurnOn").length, 2);
});

test("a blocked confirm tool opens no card", async () => {
  const h = harness({ autoApprove: true });
  h.ha.results.set("intent__HassLock", [err("lock jammed")]);
  const lock = { tool: "intent__HassLock", args: { name: "Ön Kapı" } };
  h.agent.queue.push({ uses: [lock, lock, lock] });
  await h.say("kapıyı kilitle");
  assert.deepEqual(h.agent.decisions.map((d) => d.behavior), ["allow", "allow", "deny"]);
  assert.equal(h.frames.filter((f) => f.type === "confirm_request").length, 2);
  assert.equal(h.ha.sent("intent__HassLock").length, 2);
});

test("parallel calls: a call whose class is blocked while it waits for its card is not sent", async () => {
  const live = new FakeLive();
  const h = harness({ live, autoApprove: true });
  h.ha.results.set("intent__HassLock", [err("lock jammed")]);
  const lock = { tool: "intent__HassLock", args: { name: "Ön Kapı" } };
  let third = "";
  live.scripts.push(async (req) => {
    const signal = req.signal ?? new AbortController().signal;
    // Three uses asked at once (like parallel tool_use blocks); the first two run and fail before the third's card is answered.
    const d1 = req.canUseTool(`${HA}${lock.tool}`, lock.args, { signal, toolUseID: "q1" });
    const d2 = req.canUseTool(`${HA}${lock.tool}`, lock.args, { signal, toolUseID: "q2" });
    const d3 = req.canUseTool(`${HA}${lock.tool}`, lock.args, { signal, toolUseID: "q3" });
    for (const [id, d] of [["q1", d1], ["q2", d2]] as const) {
      assert.equal((await d).behavior, "allow");
      const r = h.ha.run(lock.tool, lock.args);
      req.callbacks.onToolResult?.(id, `${HA}${lock.tool}`, r.isError, r.text);
    }
    const r3 = await d3;
    third = r3.behavior === "deny" ? r3.message : r3.behavior;
    return "Olmadı.";
  });
  await h.say("kapıyı kilitle");
  assert.equal(third, REPEATED);
  assert.equal(h.ha.sent("intent__HassLock").length, 2);
});

test("a cancelled turn does not count: results after the cancel never turn into repeated_error", async () => {
  const h = harness();
  const ha = h.ha;
  const run = ha.run.bind(ha);
  let n = 0;
  // The user cancels while the first call is in flight; its result and the next one come back after the cancel.
  ha.run = (tool, args) => {
    if (++n === 1) void h.session.handle({ type: "cancel", id: "t1" });
    return run(tool, args);
  };
  ha.results.set("intent__HassTurnOn", [err("bad")]);
  h.agent.queue.push({ uses: [turnOn("X"), turnOn("X"), turnOn("X")] });
  await h.say("lambayı yak");
  assert.ok(!h.agent.decisions.some((d) => d.message === REPEATED), JSON.stringify(h.agent.decisions));
  const lines = await h.lines();
  assert.equal(lines.filter((l) => l.reason === "repeated_error").length, 0);
});
