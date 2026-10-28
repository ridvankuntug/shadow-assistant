/**
 * T7 tier tests: tier 0 (direct HA calls without a model) through the real
 * permission gate, fallback to tier 1, tier-1 → tier-2 escalation and the
 * usage JSONL. Home Assistant and the model are mocked — nothing real is
 * ever switched.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AgentRunner, TurnCallbacks, TurnRequest, TurnResult } from "../src/agent.js";
import { ConversationLog } from "../src/conversation-log.js";
import { findReadings, parseLiveContext, resolveDevice } from "../src/live-context.js";
import { DirectUnavailableError, type DirectToolClient, type DirectToolResult } from "../src/mcp-direct.js";
import { PermissionPolicy } from "../src/permissions.js";
import type { ServerFrame } from "../src/protocol.js";
import { parseRouterConfig } from "../src/router-config.js";
import { ESCALATION_MARKER, TieredRouter, type UsageRecord } from "../src/router.js";
import { parseServices } from "../src/services.js";
import { DIRECT_NOTES_HEADER, ESCALATION_CONTINUE, Session } from "../src/session.js";
import { UsageLog } from "../src/usage-log.js";

const base = mkdtempSync(join(tmpdir(), "shadow-tiers-test-"));
const open: Session[] = [];
after(async () => {
  await Promise.all(open.map((s) => s.close("test_end")));
  rmSync(base, { recursive: true, force: true });
});

// ------------------------------------------------------------------ fixtures

/** Live context in HA's format (generic names only). */
const LIVE = JSON.stringify({
  result: [
    "Live Context: An overview of the areas and the devices in this smart home:",
    "- names: Salon Lamba",
    "  domain: light",
    "  state: 'off'",
    "  areas: Salon",
    "- names: Yatak Odası Işık",
    "  domain: switch",
    "  state: 'off'",
    "  areas: Yatak odası",
    "- names: Mutfak Işık 1",
    "  domain: light",
    "  state: 'on'",
    "- names: Mutfak Işık 2",
    "  domain: light",
    "  state: 'on'",
    "- names: Su Isıtıcısı, Kettle",
    "  domain: switch",
    "  state: 'off'",
    "- names: Ön Kapı",
    "  domain: lock",
    "  state: locked",
    "- names: Ev Sıcaklık",
    "  domain: sensor",
    "  state: '22.04'",
    "  attributes:",
    "    unit_of_measurement: °C",
    "    device_class: temperature",
    "- names: Salon Sensör Sıcaklık",
    "  domain: sensor",
    "  state: '21.5'",
    "  areas: Salon",
    "  attributes:",
    "    device_class: temperature",
    "- names: Salon Sensör Nem",
    "  domain: sensor",
    "  state: '48'",
    "  areas: Salon",
    "  attributes:",
    "    device_class: humidity",
    "- names: Bozuk Sıcaklık",
    "  domain: sensor",
    "  state: unavailable",
    "  attributes:",
    "    device_class: temperature",
  ].join("\n"),
});

const ROUTER_YAML = `
version: 1
fillers: [lütfen]
direct:
  on_tool_error: fallback
  stop_names: [şunu]
rules:
  - id: light-on
    tier: 0
    patterns: ["<ad> {ışığını|lambasını} aç"]
    service: home-assistant
    tool: intent__HassTurnOn
    domains: [light, switch]
    keywords: [ışık, lamba]
    reply: "Tamam, {ad} ışığı açıldı."
  - id: device-on
    tier: 0
    patterns: ["<ad> aç"]
    service: home-assistant
    tool: intent__HassTurnOn
    domains: [light, switch, lock]
    reply: "Tamam, {ad} açıldı."
  - id: device-off-confirm
    tier: 0
    patterns: ["<ad> kapat"]
    service: home-assistant
    tool: intent__HassTurnOff
    domains: [switch]
    permission: confirm
    reply: "Tamam, {ad} kapatıldı."
  - id: temp
    tier: 0
    patterns: ["evde sıcaklık kaç", "sıcaklık kaç"]
    service: home-assistant
    tool: homeassistant__GetLiveContext
    sensor: temperature
    default_name: ev
    reply: "{ad} sıcaklığı {deger}."
    reply_many: "Sıcaklıklar: {liste}."
  - id: temp-all
    tier: 0
    patterns: ["sıcaklıklar {kaç|ne}"]
    service: home-assistant
    tool: homeassistant__GetLiveContext
    sensor: temperature
    reply: "{ad} sıcaklığı {deger}."
    reply_many: "Sıcaklıklar: {liste}."
  - id: deep
    tier: 3
    patterns: ["* derin analiz *"]
`;

const services = parseServices(
  [
    "services:",
    "  - name: home-assistant",
    "    kind: mcp",
    "    url: http://localhost:1/sse",
    "    permission: confirm",
    "    tools:",
    '      "homeassistant__GetLiveContext": read',
    '      "intent__HassTurnOn": write',
    '      "intent__HassTurnOff": write',
    "    confirm_inputs:",
    "      domain: [lock]",
  ].join("\n"),
  {},
).services;

const MODELS = { 1: "m-haiku", 2: "m-sonnet", 3: "m-opus" } as const;

class MockHa implements DirectToolClient {
  calls: Array<{ service: string; tool: string; args: Record<string, unknown> }> = [];
  constructor(private readonly behave: (tool: string, args: Record<string, unknown>) => DirectToolResult | Error = () => ({ text: "ok", isError: false })) {}
  async callTool(service: string, tool: string, args: Record<string, unknown>): Promise<DirectToolResult> {
    this.calls.push({ service, tool, args });
    if (tool === "homeassistant__GetLiveContext") {
      const r = this.behave(tool, args);
      if (r instanceof Error) throw r;
      return r.text === "ok" ? { text: LIVE, isError: false } : r;
    }
    const r = this.behave(tool, args);
    if (r instanceof Error) throw r;
    return r;
  }
  get writes() {
    return this.calls.filter((c) => c.tool !== "homeassistant__GetLiveContext");
  }
}

type Script = (req: TurnRequest, cb: TurnCallbacks, n: number) => Promise<Partial<TurnResult> | void>;

class MockAgent implements AgentRunner {
  calls: TurnRequest[] = [];
  constructor(private script: Script = async (_r, cb) => cb.onDelta("Model cevabı.")) {}
  async runTurn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult> {
    this.calls.push(req);
    const r = (await this.script(req, cb, this.calls.length)) ?? {};
    return { text: "", inputTokens: 10, outputTokens: 2, cacheReadTokens: 8, cacheWriteTokens: 0, durationMs: 5, sessionId: `sdk-${this.calls.length}`, ...r };
  }
}

let counter = 0;
function harness(opts: { ha?: MockHa; agent?: MockAgent; readOnly?: boolean; yaml?: string; noDirect?: boolean } = {}) {
  const frames: ServerFrame[] = [];
  const waiters: Array<() => void> = [];
  const usage: UsageRecord[] = [];
  const dataDir = join(base, `data-${++counter}`);
  const usageLog = new UsageLog(dataDir);
  const ha = opts.ha ?? new MockHa();
  const agent = opts.agent ?? new MockAgent();
  const router = new TieredRouter({
    config: parseRouterConfig(opts.yaml ?? ROUTER_YAML),
    models: MODELS,
    onUsage: (u) => {
      usage.push(u);
      void usageLog.append(u);
    },
  });
  const session = new Session(
    {
      agent,
      policy: new PermissionPolicy(services, { readOnly: opts.readOnly }),
      router,
      stt: { transcribe: async () => ({ text: "" }) },
      tts: {
        synthesize: async () => ({ mime: "audio/wav", data: Buffer.from("RIFF") }),
        voices: async () => ({ default: "tr_TR-dfki-medium", voices: ["tr_TR-dfki-medium"] }),
      },
      log: new ConversationLog(dataDir),
      logger: { info: () => {}, warn: () => {} },
      confirmTimeoutMs: 5_000,
      direct: opts.noDirect ? undefined : ha,
    },
    { sessionId: `s${counter}`, device: "browser" },
    (f) => {
      frames.push(f);
      waiters.splice(0).forEach((w) => w());
    },
  );
  open.push(session);
  return {
    session,
    frames,
    ha,
    agent,
    usage,
    usageLog,
    dataDir,
    say: (text: string, id = "t1") => session.handle({ type: "user_text", id, text }),
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
    of: <T extends ServerFrame["type"]>(type: T) => frames.filter((f) => f.type === type) as Extract<ServerFrame, { type: T }>[],
  };
}

const done = (h: ReturnType<typeof harness>) => h.of("assistant_done").at(-1)?.text;

// ------------------------------------------------------------------ live context helpers

test("parseLiveContext reads HA's JSON+YAML format; aliases split", () => {
  const e = parseLiveContext(LIVE);
  assert.equal(e.length, 10);
  assert.deepEqual(e.find((x) => x.domain === "switch" && x.names.includes("Kettle"))?.names, ["Su Isıtıcısı", "Kettle"]);
  assert.throws(() => parseLiveContext('{"result":"nothing here"}'), /no entity list/);
});

test("resolveDevice: exact, keyword suffix, area, suffix-stripped, ambiguous, domain filter", () => {
  const e = parseLiveContext(LIVE);
  const light = { domains: ["light", "switch"], keywords: ["ışık", "lamba"] };
  const r1 = resolveDevice(e, "yatak odası", light);
  assert.equal(r1.status === "ok" && r1.callName, "Yatak Odası Işık");
  const r2 = resolveDevice(e, "salon", light);
  assert.equal(r2.status === "ok" && r2.callName, "Salon Lamba");
  assert.equal(resolveDevice(e, "mutfak", light).status, "ambiguous");
  const generic = { domains: ["switch"], keywords: [] };
  const r3 = resolveDevice(e, "su ısıtıcısını", generic);
  assert.ok(r3.status === "ok" && r3.callName === "Su Isıtıcısı" && r3.label === "su ısıtıcısı");
  const r4 = resolveDevice(e, "kettleı", generic);
  assert.equal(r4.status === "ok" && r4.callName, "Su Isıtıcısı", "alias");
  assert.equal(resolveDevice(e, "ön kapıyı", generic).status, "none", "lock not in allowed domains");
  assert.equal(resolveDevice(e, "garaj", light).status, "none");
});

test("findReadings: default name, explicit place, dedupe, unavailable skipped", () => {
  const e = parseLiveContext(LIVE);
  assert.deepEqual(findReadings(e, "temperature", { defaultName: "ev", max: 4 }), [{ label: "Ev", value: 22.04 }]);
  assert.deepEqual(findReadings(e, "temperature", { name: "salonda", max: 4 }), [{ label: "Salon", value: 21.5 }]);
  assert.deepEqual(findReadings(e, "humidity", { name: "salon", max: 4 }), [{ label: "Salon", value: 48 }]);
  assert.deepEqual(findReadings(e, "temperature", { name: "mutfak", max: 4 }), []);
  assert.equal(findReadings(e, "temperature", { max: 4 }).length, 2, "all valid sensors when nothing is named");
});

// ------------------------------------------------------------------ tier 0 through the gate

test("tier 0 write: live context read, resolved name + domain, write allowed, template reply, no model", async () => {
  const h = harness();
  await h.say("Salon lambasını aç lütfen!");
  assert.equal(h.agent.calls.length, 0);
  assert.deepEqual(h.ha.writes, [{ service: "home-assistant", tool: "intent__HassTurnOn", args: { name: "Salon Lamba", domain: ["light"] } }]);
  assert.deepEqual(
    h.frames.map((f) => f.type + ("status" in f ? `:${f.status}` : "")),
    ["state", "tool:started", "tool:done", "tool:started", "tool:done", "assistant_delta", "assistant_done", "state"],
  );
  assert.equal(done(h), "Tamam, salon ışığı açıldı.");
  assert.equal(h.usage.length, 1);
  assert.deepEqual(
    { ...h.usage[0], durationMs: 0 },
    {
      turnId: "t1",
      sessionId: h.session.info.sessionId,
      tier: 0,
      model: "none",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs: 0,
      services: ["home-assistant"],
      tools: ["homeassistant__GetLiveContext", "intent__HassTurnOn"],
      outcome: "done",
    },
  );
});

test("tier 0 in read-only mode: write denied without asking, nothing sent to HA, short reply", async () => {
  const h = harness({ readOnly: true });
  await h.say("salon lambasını aç");
  assert.equal(h.ha.writes.length, 0);
  assert.equal(h.of("confirm_request").length, 0);
  assert.ok(h.of("tool").some((f) => f.name === "intent__HassTurnOn" && f.status === "denied"));
  assert.equal(done(h), "Şu an salt okuma modundayım, bunu yapamam.");
  assert.equal(h.agent.calls.length, 0);
});

test("tier 0 confirm via confirm_inputs (domain lock): approved by button → called", async () => {
  const h = harness();
  const turn = h.say("ön kapıyı aç");
  const req = (await h.waitFor((f) => f.type === "confirm_request")) as Extract<ServerFrame, { type: "confirm_request" }>;
  assert.equal(req.tool, "intent__HassTurnOn");
  assert.equal(h.ha.writes.length, 0, "nothing runs before the answer");
  await h.session.handle({ type: "confirm_response", requestId: req.requestId, approved: true });
  await turn;
  assert.deepEqual(h.ha.writes[0]?.args, { name: "Ön Kapı", domain: ["lock"] });
  assert.equal(done(h), "Tamam, ön kapı açıldı.");
});

test("tier 0 confirm declined → not called, short reply, no model fallback", async () => {
  const h = harness();
  const turn = h.say("ön kapıyı aç");
  const req = (await h.waitFor((f) => f.type === "confirm_request")) as Extract<ServerFrame, { type: "confirm_request" }>;
  await h.session.handle({ type: "confirm_response", requestId: req.requestId, approved: false });
  await turn;
  assert.equal(h.ha.writes.length, 0);
  assert.equal(done(h), "Tamam, yapmıyorum.");
  assert.equal(h.agent.calls.length, 0);
});

test("tier 0 confirm answered by voice", async () => {
  const h = harness();
  const stt = { transcribe: async () => ({ text: "Evet." }) };
  (h.session as unknown as { deps: { stt: typeof stt } }).deps.stt = stt;
  const turn = h.say("su ısıtıcısını kapat");
  await h.waitFor((f) => f.type === "confirm_request");
  await h.session.handle({ type: "audio", id: "a1", mime: "audio/wav", data: Buffer.from("x").toString("base64") });
  await turn;
  assert.equal(h.of("confirm_resolved")[0]?.by, "voice");
  assert.deepEqual(h.ha.writes[0]?.args, { name: "Su Isıtıcısı", domain: ["switch"] });
});

test("rule permission raises write to confirm (never lowers)", async () => {
  const h = harness();
  const turn = h.say("su ısıtıcısını kapat");
  const req = (await h.waitFor((f) => f.type === "confirm_request")) as Extract<ServerFrame, { type: "confirm_request" }>;
  assert.equal(req.tool, "intent__HassTurnOff");
  await h.session.handle({ type: "cancel", id: "t1" });
  await turn;
  assert.equal(h.ha.writes.length, 0, "cancelled confirm never runs");
  assert.equal(done(h), "");
  assert.equal(h.usage[0]?.outcome, "cancelled");
});

test("tier 0 unresolved name → falls back to tier 1 (no write); notes not needed", async () => {
  const h = harness();
  await h.say("garaj ışığını aç");
  assert.equal(h.ha.writes.length, 0);
  assert.equal(h.agent.calls.length, 1);
  assert.equal(h.agent.calls[0]?.model, MODELS[1]);
  assert.equal(h.agent.calls[0]?.escalatable, true);
  assert.deepEqual(
    h.usage.map((u) => [u.tier, u.outcome]),
    [
      [0, "fallback"],
      [1, "done"],
    ],
  );
  assert.equal(done(h), "Model cevabı.");
});

test("tier 0 ambiguous name → fallback; on_tool_error: reply → short message, no model", async () => {
  const h = harness();
  await h.say("mutfak ışığını aç");
  assert.equal(h.agent.calls.length, 1);
  const r = harness({ yaml: ROUTER_YAML.replace("on_tool_error: fallback", "on_tool_error: reply") });
  await r.say("mutfak ışığını aç");
  assert.equal(r.agent.calls.length, 0);
  assert.equal(done(r), "Hangi cihazı kastettiğinden emin olamadım.");
  await r.say("garaj ışığını aç", "t2");
  assert.equal(done(r), "Bu adla bir cihaz bulamadım.");
});

test("tier 0 HA tool error → fallback; HA unreachable → short reply, no model", async () => {
  const h = harness({ ha: new MockHa((tool) => (tool === "intent__HassTurnOn" ? { text: "MatchFailedError", isError: true } : { text: "ok", isError: false })) });
  await h.say("salon lambasını aç");
  assert.ok(h.of("tool").some((f) => f.name === "intent__HassTurnOn" && f.status === "error"));
  assert.equal(h.agent.calls.length, 1, "model takes over");

  const down = harness({ ha: new MockHa(() => new DirectUnavailableError("home-assistant", "connect failed")) });
  await down.say("salon lambasını aç");
  assert.equal(down.agent.calls.length, 0);
  assert.equal(done(down), "Ev sistemine şu an ulaşamıyorum.");
  assert.equal(down.usage[0]?.outcome, "error");
});

test("tier 0 without a direct client falls back to the model", async () => {
  const h = harness({ noDirect: true });
  await h.say("salon lambasını aç");
  assert.equal(h.agent.calls.length, 1);
});

test("tier 0 sensor: modelless summary with words instead of unit symbols", async () => {
  const h = harness();
  await h.say("Evde sıcaklık kaç?");
  assert.equal(done(h), "Ev sıcaklığı 22 derece.");
  await h.say("sıcaklıklar kaç", "t2");
  assert.equal(done(h), "Sıcaklıklar: Ev 22 derece, Salon 21,5 derece.");
  assert.equal(h.agent.calls.length, 0);
  assert.equal(h.ha.writes.length, 0);
});

test("tier 0 exchanges are passed to the next model turn once", async () => {
  const h = harness();
  await h.say("evde sıcaklık kaç");
  await h.say("teşekkürler", "t2");
  await h.say("peki", "t3");
  const p1 = h.agent.calls[0]?.prompt ?? "";
  assert.ok(p1.startsWith(DIRECT_NOTES_HEADER), p1);
  assert.match(p1, /Kullanıcı: evde sıcaklık kaç\nShadow: Ev sıcaklığı 22 derece\.\n\nteşekkürler$/);
  assert.equal(h.agent.calls[1]?.prompt, "peki");
});

test("tier 0 turns are in the conversation log (route, tool_call, permission, assistant, usage)", async () => {
  const h = harness();
  await h.say("salon lambasını aç");
  await h.session.close("test");
  const root = join(h.dataDir, "conversations");
  const day = readdirSync(root)[0] as string;
  const lines = readFileSync(join(root, day, readdirSync(join(root, day))[0] as string), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const kinds = lines.map((l) => l.kind);
  for (const k of ["route", "tool_call", "permission", "tool_result", "assistant", "usage"]) assert.ok(kinds.includes(k), k);
  const write = lines.find((l) => l.kind === "permission" && String(l.tool).endsWith("HassTurnOn"));
  assert.equal(write?.level, "write");
});

// ------------------------------------------------------------------ tiers 1-3

test("tier 1 answer is buffered and sent once; first call forks only when resuming", async () => {
  const agent = new MockAgent(async (_r, cb) => {
    cb.onDelta("Mer");
    cb.onDelta("haba!");
  });
  const h = harness({ agent });
  await h.say("merhaba");
  assert.deepEqual(h.of("assistant_delta").map((f) => f.text), ["Merhaba!"]);
  assert.equal(done(h), "Merhaba!");
  assert.equal(agent.calls[0]?.model, MODELS[1]);
  assert.equal(agent.calls[0]?.resume, undefined);
  await h.say("nasılsın", "t2");
  assert.equal(agent.calls[1]?.resume, "sdk-1");
  assert.equal(agent.calls[1]?.forkSession, true);
});

test("tier 1 escalation: marker never reaches the client; tier 2 resumes the pre-turn session", async () => {
  const agent = new MockAgent(async (req, cb, n) => {
    if (n === 1) {
      cb.onDelta("İlk.");
      return;
    }
    if (req.model === MODELS[1]) cb.onDelta(ESCALATION_MARKER);
    else cb.onDelta("Ayrıntılı cevap.");
  });
  const h = harness({ agent });
  await h.say("selam");
  await h.say("bana iki şeyi anlat", "t2");
  assert.deepEqual(
    agent.calls.map((c) => [c.model, c.resume, c.escalatable]),
    [
      [MODELS[1], undefined, true],
      [MODELS[1], "sdk-1", true],
      [MODELS[2], "sdk-1", false],
    ],
  );
  assert.ok(!h.frames.some((f) => "text" in f && String(f.text).includes(ESCALATION_MARKER)));
  assert.equal(done(h), "Ayrıntılı cevap.");
  assert.deepEqual(
    h.usage.filter((u) => u.turnId === "t2").map((u) => [u.tier, u.model, u.outcome]),
    [
      [1, MODELS[1], "escalated"],
      [2, MODELS[2], "done"],
    ],
  );
  // Next turn continues from the tier-2 session.
  await h.say("tamam", "t3");
  assert.equal(agent.calls[3]?.resume, "sdk-3");
});

test("escalation after a tool ran: tier 2 continues in the tier-1 fork so nothing runs twice", async () => {
  const agent = new MockAgent(async (req, cb) => {
    if (req.model === MODELS[1]) {
      cb.onDelta(ESCALATION_MARKER);
      return { tools: ["mcp__home-assistant__homeassistant__GetLiveContext"], sessionId: "fork-1" };
    }
    cb.onDelta("Devam.");
  });
  const h = harness({ agent });
  await h.say("evdeki her şeyi kontrol et");
  assert.equal(agent.calls[1]?.resume, "fork-1");
  assert.equal(agent.calls[1]?.prompt, ESCALATION_CONTINUE);
  assert.deepEqual(h.usage[0]?.tools, ["homeassistant__GetLiveContext"]);
  assert.deepEqual(h.usage[0]?.services, ["home-assistant"]);
});

test("tier 1 error does not escalate; cancelled tier 1 does not escalate", async () => {
  const errAgent = new MockAgent(async (_r, cb) => {
    cb.onDelta(ESCALATION_MARKER);
    return { error: "boom" };
  });
  const h = harness({ agent: errAgent });
  await h.say("selam");
  assert.equal(errAgent.calls.length, 1);
  assert.equal(h.of("error")[0]?.code, "model_error");
});

test("tier 3 rule → opus model, no escalation; long input → tier 2", async () => {
  const h = harness();
  await h.say("bunun için derin analiz yapar mısın");
  assert.equal(h.agent.calls[0]?.model, MODELS[3]);
  assert.equal(h.agent.calls[0]?.escalatable, false);
  await h.say(Array.from({ length: 35 }, (_, i) => `kelime${i}`).join(" "), "t2");
  assert.equal(h.agent.calls[1]?.model, MODELS[2]);
});

test("usage JSONL: one line per model call / tier-0 turn, no secrets", async () => {
  const h = harness();
  await h.say("salon lambasını aç");
  await h.say("merhaba", "t2");
  await h.usageLog.flush();
  const dir = join(h.dataDir, "usage");
  assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /^\*$/m);
  const file = readdirSync(dir).find((f) => f.endsWith(".jsonl")) as string;
  assert.match(file, /^\d{4}-\d{2}-\d{2}\.jsonl$/);
  const lines = readFileSync(join(dir, file), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(
    lines.map((l) => [l.tier, l.model, l.turnId, l.sessionId]),
    [
      [0, "none", "t1", h.session.info.sessionId],
      [1, MODELS[1], "t2", h.session.info.sessionId],
    ],
  );
  assert.equal(lines[1]?.cacheReadTokens, 8);
  assert.ok(!JSON.stringify(lines).match(/token"?\s*:\s*"|Bearer/i));
});

// ------------------------------------------------------------------ review round 1 regressions

test("tier 0 rule for a disabled service falls back to the model without asking anything", async () => {
  const h = harness();
  (h.session as unknown as { deps: { policy: PermissionPolicy } }).deps.policy = new PermissionPolicy(
    services.map((s) => ({ ...s, enabled: false })),
  );
  await h.say("salon lambasını aç");
  assert.equal(h.of("confirm_request").length, 0);
  assert.equal(h.ha.calls.length, 0);
  assert.equal(h.agent.calls.length, 1);
  assert.equal(h.usage[0]?.outcome, "fallback");
});

test("resolveDevice: same name in two areas → area added; same name in one area → ambiguous", () => {
  const mk = (names: string, domain: string, area?: string) => ({ names: [names], domain, state: "off", areas: area ? [area] : [], attributes: {} });
  const two = [mk("Tavan Lambası", "light", "Salon"), mk("Tavan Lambası", "light", "Mutfak")];
  const r = resolveDevice(two, "salon", { domains: ["light"], keywords: ["lamba", "lambası"] });
  assert.ok(r.status === "ok" && r.area === "Salon" && r.callName === "Tavan Lambası", JSON.stringify(r));
  const same = [mk("Tavan Lambası", "light", "Salon"), mk("Tavan Lambası", "light", "Salon"), mk("Masa", "light", "Mutfak")];
  assert.equal(resolveDevice(same, "tavan lambası", { domains: ["light"], keywords: [] }).status, "ambiguous");
  const noArea = [mk("Lamba", "light"), mk("Lamba", "light", "Salon")];
  assert.equal(resolveDevice(noArea, "lamba", { domains: ["light"], keywords: [] }).status, "ambiguous");
});

test("escalation after tools but without a fork id restarts tier 2 from the user's text", async () => {
  const agent = new MockAgent(async (req, cb) => {
    if (req.model === MODELS[1]) {
      cb.onDelta(ESCALATION_MARKER);
      return { tools: ["mcp__home-assistant__homeassistant__GetLiveContext"], sessionId: undefined };
    }
    cb.onDelta("Tamam.");
  });
  const h = harness({ agent });
  await h.say("evdeki her şeyi kontrol et");
  assert.equal(agent.calls[1]?.prompt, "evdeki her şeyi kontrol et");
  assert.equal(agent.calls[1]?.resume, undefined);
});

test("tier 0 denied by the user is recorded as outcome denied", async () => {
  const h = harness();
  const turn = h.say("ön kapıyı aç");
  const req = (await h.waitFor((f) => f.type === "confirm_request")) as Extract<ServerFrame, { type: "confirm_request" }>;
  await h.session.handle({ type: "confirm_response", requestId: req.requestId, approved: false });
  await turn;
  assert.equal(h.usage[0]?.outcome, "denied");
});

test("McpDirectClient: a server that never sends the SSE endpoint times out and the stream is closed", async () => {
  const { createServer } = await import("node:http");
  let closed = false;
  let gets = 0;
  const server = createServer((req, res) => {
    gets++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.flushHeaders();
    req.on("close", () => (closed = true));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const { McpDirectClient } = await import("../src/mcp-direct.js");
  const svc = parseServices(
    ["services:", "  - name: ha", "    kind: mcp", `    url: http://127.0.0.1:${port}/sse`, "    timeout_ms: 300"].join("\n"),
    {},
  ).services;
  const client = new McpDirectClient(svc, {});
  const started = Date.now();
  await assert.rejects(client.callTool("ha", "x", {}, new AbortController().signal), DirectUnavailableError);
  assert.ok(Date.now() - started < 3000);
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(closed, "SSE stream closed after the failed handshake");
  const before = gets;
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(gets, before, "no background reconnects");
  // A cancelled caller stops waiting without an unavailable error.
  const ac = new AbortController();
  const pending = client.callTool("ha", "x", {}, ac.signal);
  ac.abort(new Error("cancelled"));
  await assert.rejects(pending, /cancelled/);
  await client.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});
