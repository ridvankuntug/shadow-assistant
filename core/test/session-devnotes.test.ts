/**
 * T7.w.3b: turn dev-notes recorded by the session and the gateway's call path
 * (`dev-notes/turns.json`). Home Assistant and the model are mocked; nothing
 * real is switched. Generic names only.
 *
 * - `missing_capability`: a built-in tool (gate), a tool outside the tier's
 *   services (gate), a tool name the gateway does not list (`McpGateway.call`);
 * - `wandering`: ≥ wander_calls tool calls, or the tool-call cap;
 * - `tool_error`: an `isError` result of an allowed call (model or tier 0), an
 *   unreachable service at tier 0; a user denial is not an error;
 * - `rule_suspended`: a learned rule suspended after fallbacks in a row;
 * - `lastTurnId` is the turn's id; no text, argument, result or error message
 *   reaches the file.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { z } from "zod";
import type { AgentRunner, TurnCallbacks, TurnRequest, TurnResult } from "../src/agent.js";
import { ConversationLog } from "../src/conversation-log.js";
import { TurnNotes, type TurnNote } from "../src/dev-notes.js";
import { learnPolicy, learnTargetFilter, type Extracted } from "../src/learn/extract.js";
import { LearnedRuleStore } from "../src/learn/store.js";
import type { DirectToolClient, DirectToolResult, RemoteMcpClient, RemoteToolList } from "../src/mcp-direct.js";
import { McpGateway, type GatewayGate } from "../src/mcp-gateway.js";
import type {
  AttemptHandle,
  AttemptOutcome,
  AttemptRequest,
  AttemptStatus,
  ProviderCapabilities,
  ProviderSession,
} from "../src/model-provider.js";
import { PermissionPolicy } from "../src/permissions.js";
import type { ServerFrame } from "../src/protocol.js";
import { parseRouterConfig } from "../src/router-config.js";
import { TieredRouter } from "../src/router.js";
import { parseServices } from "../src/services.js";
import { Session, type SessionRegistry } from "../src/session.js";

const base = mkdtempSync(join(tmpdir(), "shadow-session-devnotes-test-"));
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
    '      "intent__HassTurnOff": confirm',
  ].join("\n"),
  {},
).services;

class MockHa implements DirectToolClient {
  calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  writeResult: DirectToolResult = { text: "ok", isError: false };
  failWrites: Error | undefined;
  async callTool(_service: string, tool: string, args: Record<string, unknown>): Promise<DirectToolResult> {
    this.calls.push({ tool, args });
    if (tool === "homeassistant__GetLiveContext") return { text: LIVE, isError: false };
    if (this.failWrites) throw this.failWrites;
    return this.writeResult;
  }
}

/** One model tool call: `tool` is an HA tool, `full` any name as the SDK reports it. */
interface ToolUse {
  tool?: string;
  full?: string;
  args?: Record<string, unknown>;
  isError?: boolean;
}

let useSeq = 0;
/** Like the gateway: every call is gated; a denial comes back as an `isError` result. */
async function useTools(
  gate: TurnRequest["canUseTool"],
  onResult: ((id: string, name: string | undefined, isError: boolean) => void) | undefined,
  signal: AbortSignal | undefined,
  uses: ToolUse[],
): Promise<void> {
  for (const u of uses) {
    const id = `tu-${++useSeq}`;
    const name = u.full ?? `${HA}${u.tool ?? "homeassistant__GetLiveContext"}`;
    const d = await gate(name, u.args ?? {}, { signal: signal ?? new AbortController().signal, toolUseID: id });
    onResult?.(id, name, d.behavior !== "allow" || u.isError === true);
  }
}

type Plan = { uses?: ToolUse[]; text?: string; status?: AttemptStatus };

class MockAgent implements AgentRunner {
  calls: TurnRequest[] = [];
  queue: Plan[] = [];
  async runTurn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult> {
    this.calls.push(req);
    const plan = this.queue.shift() ?? {};
    await useTools(req.canUseTool, cb.onToolResult?.bind(cb), req.signal, plan.uses ?? []);
    cb.onDelta(plan.text ?? "Tamam.");
    return { text: "", inputTokens: 1, outputTokens: 1, durationMs: 5, sessionId: `sdk-${this.calls.length}`, tools: [] };
  }
}

class FakeLive implements ProviderSession {
  readonly provider = "fake";
  sessionId: string | undefined = "sess-1";
  model: string = MODELS[1];
  busy = false;
  isClosed = false;
  queue: Plan[] = [];
  ready(): Promise<void> {
    return Promise.resolve();
  }
  runAttempt(req: AttemptRequest): AttemptHandle {
    const plan = this.queue.shift() ?? {};
    const done = (async (): Promise<AttemptOutcome> => {
      await useTools(req.canUseTool, req.callbacks.onToolResult?.bind(req.callbacks), req.signal, plan.uses ?? []);
      req.callbacks.onDelta(plan.text ?? "Tamam.");
      const status: AttemptStatus = plan.status ?? (req.signal?.aborted ? "cancelled" : "ok");
      return { text: "", inputTokens: 1, outputTokens: 1, durationMs: 5, status, model: req.model, warm: true, queryAgeMs: 0, doneMs: 1 };
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

class FakeRegistry implements SessionRegistry {
  capabilities: ProviderCapabilities = { setModel: true, compact: false, notes: true, resume: true };
  private locked = false;
  constructor(private readonly live_: FakeLive) {}
  async acquire(): Promise<ProviderSession | undefined> {
    return this.live_;
  }
  live(): ProviderSession | undefined {
    return this.live_;
  }
  prewarm(): void {}
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
function harness(o: { live?: FakeLive; tierServices?: Record<number, string[]>; readOnly?: boolean } = {}) {
  const dir = join(base, `d${++counter}`);
  const config = parseRouterConfig(ROUTER_YAML);
  const store = new LearnedRuleStore({ dir: join(dir, "fast-path"), config, log: () => {} });
  const policy = learnPolicy(config, SERVICES);
  const router = new TieredRouter({ config, models: MODELS, learned: { rules: () => store.snapshot(), targetFilter: learnTargetFilter(policy) } });
  const notes = new TurnNotes({ dir: join(dir, "dev-notes"), coalesceMs: 60_000 });
  const frames: ServerFrame[] = [];
  const waiters: Array<() => void> = [];
  const ha = new MockHa();
  const agent = new MockAgent();
  const session = new Session(
    {
      agent,
      ...(o.live ? { registry: new FakeRegistry(o.live) } : {}),
      policy: new PermissionPolicy(SERVICES, { readOnly: o.readOnly }),
      router,
      stt: { transcribe: async () => ({ text: "" }) },
      tts: { synthesize: async () => ({ mime: "audio/wav", data: Buffer.from("RIFF") }), voices: async () => ({ default: "v", voices: ["v"] }) },
      log: new ConversationLog(dir),
      logger: { info: () => {}, warn: () => {} },
      confirmTimeoutMs: 5_000,
      direct: ha,
      learning: { store, policy, minObservations: config.learning.minObservations },
      turnNotes: notes,
      ...(o.tierServices ? { tierServices: o.tierServices } : {}),
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
    notes,
    ha,
    agent,
    frames,
    say: (text: string) => session.handle({ type: "user_text", id: `t${++turn}`, text }),
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
    /** All notes once turn tails are done (close() waits for them). */
    settledNotes: async (): Promise<TurnNote[]> => {
      await session.close("drain");
      return (await notes.read()).notes;
    },
  };
}

async function until(pred: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await pred())) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 5));
  }
}

const readCtx: ToolUse = { tool: "homeassistant__GetLiveContext" };

// ------------------------------------------------------------------ missing_capability

test("missing_capability: a built-in tool denied by the gate is noted with its name only and the turn id", async () => {
  const h = harness();
  h.agent.queue.push({ uses: [{ full: "Bash", args: { command: "cat geheim-datei-1234" } }] });
  await h.say("dosyayı oku");
  const notes = await h.settledNotes();
  assert.equal(notes.length, 1);
  const n = notes[0];
  assert.equal(n?.kind, "missing_capability");
  assert.equal(n?.reason, "builtin");
  assert.equal(n?.tool, "Bash");
  assert.equal(n?.service, undefined);
  assert.equal(n?.lastTurnId, "t1");
  assert.equal(n?.count, 1);
});

test("missing_capability: a tool outside the tier's services (persistent gate)", async () => {
  const live = new FakeLive();
  const h = harness({ live, tierServices: { 1: ["shadow-vault"] } });
  live.queue.push({ uses: [{ tool: "intent__HassTurnOn", args: { name: "Salon Lamba" } }] });
  await h.say("bir şey yap");
  const notes = await h.settledNotes();
  assert.equal(notes.length, 1);
  assert.deepEqual(
    { kind: notes[0]?.kind, reason: notes[0]?.reason, service: notes[0]?.service, tool: notes[0]?.tool, turn: notes[0]?.lastTurnId },
    { kind: "missing_capability", reason: "tier_service", service: "home-assistant", tool: "intent__HassTurnOn", turn: "t1" },
  );
  assert.equal(notes.some((x) => x.kind === "tool_error"), false, "a gate denial is not a tool error");
});

class ListOnlyHa implements RemoteMcpClient {
  async listTools(): Promise<RemoteToolList> {
    return { tools: [{ name: "homeassistant__GetLiveContext", inputSchema: { type: "object" } }] };
  }
  async callTool(): Promise<{ text: string; isError: boolean }> {
    return { text: "ok", isError: false };
  }
}

test("missing_capability: McpGateway.call() notes a tool name it does not list, before the gate (remote and local)", async () => {
  const notes = new TurnNotes({ dir: join(base, "gw"), coalesceMs: 0 });
  const gateway = new McpGateway({
    sources: [
      { kind: "remote", service: "home-assistant", client: new ListOnlyHa() },
      { kind: "local", service: "shadow-memory", tools: [{ name: "echo", description: "e", shape: { v: z.string().optional() }, handler: async () => ({ text: "", isError: false }) }] },
    ],
    turnNotes: notes,
  });
  let asked = 0;
  const gate: GatewayGate = async () => {
    asked++;
    return { behavior: "allow" };
  };
  const signal = new AbortController().signal;
  const r1 = await gateway.call("home-assistant", "intent__HassMadeUp", { name: "Gizli Oda" }, gate, { signal });
  const r2 = await gateway.call("shadow-memory", "forget_everything", {}, gate, { signal });
  const r3 = await gateway.call("shadow-memory", "bad name with spaces", {}, gate, { signal });
  assert.equal(r1.isError && r2.isError && r3.isError, true);
  assert.equal(asked, 0, "the gate is never asked for an unknown tool");
  const got = (await notes.read()).notes.map((n) => [n.kind, n.reason, n.service, n.tool, n.lastTurnId]);
  assert.deepEqual(got, [
    ["missing_capability", "unknown_tool", "home-assistant", "intent__HassMadeUp", undefined],
    ["missing_capability", "unknown_tool", "shadow-memory", "forget_everything", undefined],
    // A name that is not an identifier is not stored.
    ["missing_capability", "unknown_tool", "shadow-memory", "?", undefined],
  ]);
  // A known tool is not a note.
  await gateway.call("home-assistant", "homeassistant__GetLiveContext", {}, gate, { signal });
  assert.equal((await notes.read()).notes.length, 3);
  gateway.close();
});

// ------------------------------------------------------------------ wandering

test("wandering: five tool calls in one turn (legacy); four are not", async () => {
  const h = harness();
  h.agent.queue.push({ uses: [readCtx, readCtx, readCtx, readCtx] });
  await h.say("salonu kontrol et");
  h.agent.queue.push({ uses: [readCtx, readCtx, readCtx, { tool: "light__HassLightSet", args: { name: "Salon Lamba", brightness: 10 } }, readCtx] });
  await h.say("salonu ayarla");
  const notes = await h.settledNotes();
  const w = notes.filter((n) => n.kind === "wandering");
  assert.equal(w.length, 1);
  assert.deepEqual(
    { tier: w[0]?.tier, source: w[0]?.routeSource, rule: w[0]?.routeRule, tools: w[0]?.tools, trigger: w[0]?.trigger, turn: w[0]?.lastTurnId },
    { tier: 1, source: "default", rule: "default", tools: ["homeassistant__GetLiveContext", "light__HassLightSet"], trigger: "calls", turn: "t2" },
  );
});

test("wandering: an attempt stopped by the tool-call cap (persistent), even with few calls", async () => {
  const live = new FakeLive();
  const h = harness({ live });
  live.queue.push({ uses: [readCtx], status: "tool_cap" });
  await h.say("salonu kontrol et");
  const notes = await h.settledNotes();
  const w = notes.filter((n) => n.kind === "wandering");
  assert.equal(w.length, 1);
  assert.equal(w[0]?.trigger, "tool_cap");
  assert.equal(w[0]?.lastTurnId, "t1");
});

// ------------------------------------------------------------------ tool_error

test("tool_error: an isError result of an allowed model call (legacy and persistent)", async () => {
  const h = harness();
  h.agent.queue.push({ uses: [{ tool: "intent__HassTurnOn", args: { name: "Salon Lamba" }, isError: true }] });
  await h.say("salonu aç lütfen");
  const notes = await h.settledNotes();
  assert.deepEqual(
    notes.map((n) => [n.kind, n.service, n.tool, n.errorClass, n.lastTurnId]),
    [["tool_error", "home-assistant", "intent__HassTurnOn", "error", "t1"]],
  );

  const live = new FakeLive();
  const p = harness({ live });
  live.queue.push({ uses: [{ tool: "light__HassLightSet", args: { name: "Salon Lamba", brightness: 5 }, isError: true }] });
  await p.say("salonu kıs lütfen");
  const pn = await p.settledNotes();
  assert.deepEqual(pn.map((n) => [n.kind, n.tool, n.errorClass]), [["tool_error", "light__HassLightSet", "error"]]);
});

test("a user denial and a read-only denial are not tool errors", async () => {
  const h = harness();
  h.agent.queue.push({ uses: [{ tool: "intent__HassTurnOff", args: { name: "Salon Lamba" } }] });
  const turn = h.say("salonu kapat");
  const req = (await h.waitFor((f) => f.type === "confirm_request")) as Extract<ServerFrame, { type: "confirm_request" }>;
  await h.session.handle({ type: "confirm_response", requestId: req.requestId, approved: false });
  await turn;
  assert.deepEqual(await h.settledNotes(), []);

  const ro = harness({ readOnly: true });
  ro.agent.queue.push({ uses: [{ tool: "intent__HassTurnOn", args: { name: "Salon Lamba" } }] });
  await ro.say("salonu aç lütfen");
  assert.deepEqual(await ro.settledNotes(), []);
});

test("tool_error at tier 0: an isError result (class error) and an unreachable service (class unavailable)", async () => {
  const h = harness();
  h.ha.writeResult = { text: "Error calling tool: entity light.gizli_oda not found at http://10.0.0.9", isError: true };
  await h.say("salon ışığını aç");
  h.ha.failWrites = new Error("connect ECONNREFUSED 10.0.0.9:8123");
  await h.say("mutfak ışığını aç");
  const notes = await h.settledNotes();
  assert.deepEqual(
    notes.filter((n) => n.kind === "tool_error").map((n) => [n.service, n.tool, n.errorClass, n.lastTurnId]),
    [
      ["home-assistant", "intent__HassTurnOn", "error", "t1"],
      ["home-assistant", "intent__HassTurnOn", "unavailable", "t2"],
    ],
  );
});

// ------------------------------------------------------------------ rule_suspended

test("rule_suspended: a learned rule suspended after fallbacks in a row is noted with its id and reason", async () => {
  const h = harness();
  const x: Extracted = {
    tokens: ["<ad>", "lambası", "parlaklığı", "yüzde", "<sayi>", "olsun"],
    service: "home-assistant",
    tool: "light__HassLightSet",
    domains: ["light"],
    keywords: ["lamba"],
    binding: { name: "ad", brightness: "sayi" },
    signature: "home-assistant|light__HassLightSet|light|name=ad|brightness=sayi",
  };
  for (let i = 0; i < 3; i++) await h.store.observe(x);
  const id = (await h.store.list())[0]?.id as string;
  assert.ok((await h.store.activate(id, "browser")).ok);
  for (let i = 0; i < 3; i++) {
    h.agent.queue.push({ text: "Model cevabı." });
    await h.say("bilinmeyen lambası parlaklığı yüzde 30 olsun");
  }
  await until(async () => (await h.store.list())[0]?.status === "suspended");
  const notes = (await h.settledNotes()).filter((n) => n.kind === "rule_suspended");
  assert.deepEqual(
    notes.map((n) => [n.ruleId, n.reason, n.count, n.lastTurnId]),
    [[id, "name_not_found", 1, "t3"]],
  );
});

// ------------------------------------------------------------------ privacy

test("privacy: no user text, argument, result, entity name or error message reaches turns.json", async () => {
  const h = harness();
  const SECRET = "GIZLI-DEGER-0000";
  h.agent.queue.push({
    uses: [
      { full: "Bash", args: { command: `echo ${SECRET}` } },
      { tool: "intent__HassTurnOn", args: { name: "Gizlioda Lamba", note: SECRET }, isError: true },
      readCtx,
      readCtx,
      readCtx,
    ],
  });
  await h.say(`gizlioda lambasını aç ${SECRET}`);
  h.ha.writeResult = { text: `Error calling tool: ${SECRET} gizlioda`, isError: true };
  await h.say("salon ışığını aç");
  const notes = await h.settledNotes();
  assert.deepEqual([...new Set(notes.map((n) => n.kind))].sort(), ["missing_capability", "tool_error", "wandering"]);
  await h.notes.flush();
  const file = readFileSync(h.notes.file, "utf8");
  for (const leaked of [SECRET, "Gizlioda", "gizlioda", "echo", "Salon", "salon", "Error calling", "10.0.0"]) {
    assert.equal(file.includes(leaked), false, `turns.json must not contain ${leaked}`);
  }
});
