/**
 * Session tests in persistent mode (docs/07 S6/S10): the model runs as
 * attempts on a device's ProviderSession from a mocked registry. No SDK, no
 * subprocess; Home Assistant and tts-svc are mocked.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AgentRunner, TurnCallbacks, TurnRequest, TurnResult } from "../src/agent.js";
import { ConversationLog } from "../src/conversation-log.js";
import type { DirectToolClient, DirectToolResult } from "../src/mcp-direct.js";
import {
  SessionBusyError,
  SessionClosedError,
  type AttemptHandle,
  type AttemptOutcome,
  type AttemptRequest,
  type AttemptStatus,
  type ProviderCapabilities,
  type ProviderSession,
} from "../src/model-provider.js";
import { PermissionPolicy } from "../src/permissions.js";
import { compileLexicon } from "../src/pronunciation.js";
import type { ClientFrame, ServerFrame } from "../src/protocol.js";
import { parseRouterConfig } from "../src/router-config.js";
import { ESCALATION_MARKER, TieredRouter, type Router, type UsageRecord } from "../src/router.js";
import { parseServices } from "../src/services.js";
import { Session, type SessionRegistry } from "../src/session.js";
import { ESCALATION_CONTINUE } from "../src/turn-envelope.js";
import type { TtsClient } from "../src/speech.js";

const base = mkdtempSync(join(tmpdir(), "shadow-session-persistent-test-"));
const open: Session[] = [];
after(async () => {
  await Promise.all(open.map((s) => s.close("test_end")));
  rmSync(base, { recursive: true, force: true });
});

const HA = "mcp__home-assistant__";
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
  ].join("\n"),
  {},
).services;

const MODELS = { 1: "m-haiku", 2: "m-sonnet", 3: "m-opus" } as const;

const ROUTER_YAML = `
version: 1
rules:
  - id: temp
    tier: 0
    patterns: ["evde sıcaklık kaç"]
    service: home-assistant
    tool: homeassistant__GetLiveContext
    sensor: temperature
    default_name: ev
    reply: "{ad} sıcaklığı {deger}."
    reply_many: "Sıcaklıklar: {liste}."
`;

const LIVE = JSON.stringify({
  result: [
    "Live Context: An overview of the areas and the devices in this smart home:",
    "- names: Ev Sıcaklık",
    "  domain: sensor",
    "  state: '22.04'",
    "  attributes:",
    "    unit_of_measurement: °C",
    "    device_class: temperature",
  ].join("\n"),
});

class MockHa implements DirectToolClient {
  async callTool(): Promise<DirectToolResult> {
    return { text: LIVE, isError: false };
  }
}

/** What one scripted attempt does. */
interface Step {
  deltas?: string[];
  status?: AttemptStatus;
  retryAt?: number;
  error?: string;
  /** Called before the visible end (e.g. to use a tool through the gate). */
  run?: (req: AttemptRequest) => Promise<void>;
  /** Hold `settled` until released. */
  holdSettle?: boolean;
}

class FakeLive implements ProviderSession {
  readonly provider = "fake";
  sessionId: string | undefined = "sess-1";
  model: string = MODELS[1];
  busy = false;
  isClosed = false;
  attempts: AttemptRequest[] = [];
  notes: string[] = [];
  throwOnAttempt: Error | undefined;
  private readonly releases: Array<() => void> = [];
  constructor(private readonly script: (req: AttemptRequest, n: number) => Step) {}
  ready(): Promise<void> {
    return Promise.resolve();
  }
  runAttempt(req: AttemptRequest): AttemptHandle {
    if (this.throwOnAttempt) throw this.throwOnAttempt;
    this.attempts.push(req);
    const step = this.script(req, this.attempts.length);
    const outcome = (async (): Promise<AttemptOutcome> => {
      await Promise.resolve();
      if (step.run) await step.run(req);
      if (!req.signal?.aborted) for (const d of step.deltas ?? []) req.callbacks.onDelta(d);
      const status: AttemptStatus = req.signal?.aborted ? "cancelled" : (step.status ?? "ok");
      return {
        text: (step.deltas ?? []).join(""),
        inputTokens: 11,
        outputTokens: 4,
        durationMs: 900,
        costUsd: 0.001,
        status,
        model: req.model,
        ...(step.retryAt !== undefined ? { retryAt: step.retryAt } : {}),
        ...(step.error ? { error: step.error } : {}),
        warm: true,
        queryAgeMs: 5_000,
        doneMs: 10,
      };
    })();
    const settled = step.holdSettle
      ? outcome.then((o) => new Promise<AttemptOutcome>((res) => this.releases.push(() => res(o))))
      : outcome;
    return { done: outcome, settled };
  }
  releaseSettled(): void {
    for (const r of this.releases.splice(0)) r();
  }
  acceptNotes = true;
  async appendNote(text: string): Promise<boolean> {
    if (!this.acceptNotes) return false;
    this.notes.push(text);
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
  prewarmed: string[] = [];
  ended: Array<{ device: string; sessionId?: string }> = [];
  /** undefined = fallback to the legacy runner. */
  constructor(public session: FakeLive | undefined) {}
  get providerId(): string {
    return "fake";
  }
  async acquire(): Promise<ProviderSession | undefined> {
    return this.session;
  }
  live(): ProviderSession | undefined {
    return this.session;
  }
  prewarm(device: string): void {
    this.prewarmed.push(device);
  }
  private readonly locked = new Set<string>();
  beginTurn(device: string): boolean {
    if (this.locked.has(device)) return false;
    this.locked.add(device);
    return true;
  }
  endTurn(device: string): void {
    this.locked.delete(device);
  }
  async fallbackResume(): Promise<string | undefined> {
    return "resume-from-registry";
  }
  async turnEnded(device: string, sessionId?: string): Promise<void> {
    this.ended.push({ device, ...(sessionId ? { sessionId } : {}) });
  }
}

class MockAgent implements AgentRunner {
  calls: TurnRequest[] = [];
  /** Holds every legacy turn until it settles. */
  hold: Promise<void> | undefined;
  async runTurn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult> {
    this.calls.push(req);
    if (this.hold) await this.hold;
    cb.onDelta("Eski yol.");
    return { text: "Eski yol.", inputTokens: 1, outputTokens: 1, durationMs: 5, sessionId: "legacy-7" };
  }
}

const tier1Router: Router = {
  route: () => ({ model: MODELS[1], tier: 1, escalateTo: { tier: 2, model: MODELS[2] }, rule: "default" }),
};

let counter = 0;
function harness(o: {
  live?: FakeLive;
  registry?: FakeRegistry;
  router?: Router;
  tts?: TtsClient;
  tierServices?: Partial<Record<1 | 2 | 3, readonly string[]>>;
  lexicon?: ReturnType<typeof compileLexicon>["lexicon"];
}) {
  const frames: ServerFrame[] = [];
  const waiters: Array<() => void> = [];
  const usage: UsageRecord[] = [];
  const dataDir = join(base, `data-${++counter}`);
  const log = new ConversationLog(dataDir);
  const registry = o.registry ?? new FakeRegistry(o.live);
  const agent = new MockAgent();
  const routerBase = o.router ?? tier1Router;
  const session = new Session(
    {
      agent,
      registry,
      policy: new PermissionPolicy(services, {}),
      router: { route: (i) => routerBase.route(i), onUsage: (u) => usage.push(u) },
      stt: { transcribe: async () => ({ text: "" }) },
      tts: o.tts ?? {
        synthesize: async (text: string) => ({ mime: "audio/wav", data: Buffer.from(`W:${text}`) }),
        voices: async () => ({ default: "v", voices: ["v"] }),
      },
      log,
      logger: { info: () => {}, warn: () => {} },
      confirmTimeoutMs: 5_000,
      direct: new MockHa(),
      tierServices: o.tierServices,
      pronunciations: o.lexicon,
    },
    { sessionId: `p${counter}`, device: "browser" },
    (f) => {
      frames.push(f);
      waiters.splice(0).forEach((w) => w());
    },
  );
  open.push(session);
  return {
    session,
    frames,
    usage,
    registry,
    agent,
    log,
    send: (f: ClientFrame) => session.handle(f),
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
    lines: () => {
      const root = join(dataDir, "conversations");
      const day = readdirSync(root)[0] as string;
      const file = readdirSync(join(root, day))[0] as string;
      return readFileSync(join(root, day, file), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
  };
}

const settle = () => new Promise((r) => setImmediate(r));

test("hello prewarms the device; a tier-1 turn is one attempt with the marked envelope, buffered once", async () => {
  const live = new FakeLive(() => ({ deltas: ["Mer", "haba!"] }));
  const h = harness({ live });
  assert.deepEqual(h.registry.prewarmed, ["browser"]);
  await h.say("Merhaba, bugün nasılsın?");
  assert.equal(live.attempts.length, 1);
  assert.equal(live.attempts[0]?.text, "[mod:hizli]\nMerhaba, bugün nasılsın?");
  assert.equal(live.attempts[0]?.model, MODELS[1]);
  assert.deepEqual(h.of("assistant_delta").map((f) => f.text), ["Merhaba!"]);
  assert.equal(h.of("assistant_done")[0]?.text, "Merhaba!");
  assert.equal(h.agent.calls.length, 0, "legacy runner unused");
  await settle();
  assert.deepEqual(h.usage.map((u) => [u.tier, u.model, u.outcome, u.inputTokens]), [[1, MODELS[1], "done", 11]]);
  assert.deepEqual(h.registry.ended, [{ device: "browser" }]);
  await h.session.close("t");
  const timing = h.lines().find((l) => l.kind === "timing");
  assert.ok(timing, "timing entry written");
  assert.equal(timing.warm, true);
  assert.equal(timing.queryAgeMs, 5_000);
  assert.equal(timing.sdkDurationMs, 900);
  assert.equal(typeof timing.doneMs, "number");
  assert.equal(typeof timing.firstDeltaMs, "number");
});

test("usage is recorded at settled, not at the visible end", async () => {
  const live = new FakeLive(() => ({ deltas: ["Tamam."], holdSettle: true }));
  const h = harness({ live, router: { route: () => ({ model: MODELS[2], tier: 2 }) } });
  await h.say("anlat");
  assert.equal(h.of("assistant_done")[0]?.text, "Tamam.");
  await settle();
  assert.equal(h.usage.length, 0);
  assert.equal(h.registry.ended.length, 0);
  live.releaseSettled();
  await settle();
  await settle();
  assert.equal(h.usage[0]?.outcome, "done");
  assert.equal(h.registry.ended.length, 1);
});

test("escalation continues in the same session: second attempt is ESCALATION_CONTINUE on tier 2, marker never shown", async () => {
  const live = new FakeLive((req) =>
    req.model === MODELS[1] ? { deltas: [ESCALATION_MARKER] } : { deltas: ["Ayrıntılı ", "cevap."] },
  );
  const h = harness({ live });
  await h.say("bana iki şeyi karşılaştır");
  assert.deepEqual(
    live.attempts.map((a) => [a.model, a.text]),
    [
      [MODELS[1], "[mod:hizli]\nbana iki şeyi karşılaştır"],
      [MODELS[2], ESCALATION_CONTINUE],
    ],
  );
  assert.ok(!h.frames.some((f) => "text" in f && String(f.text).includes(ESCALATION_MARKER)));
  assert.equal(h.of("assistant_done")[0]?.text, "Ayrıntılı cevap.");
  await settle();
  assert.deepEqual(
    h.usage.map((u) => [u.tier, u.model, u.outcome]),
    [
      [1, MODELS[1], "escalated"],
      [2, MODELS[2], "done"],
    ],
  );
  await h.session.close("t");
  assert.ok(h.lines().some((l) => l.kind === "route" && l.escalated === true));
});

test("usage limit: error usage_limit with retryAt; the text is never an answer; no escalation", async () => {
  const live = new FakeLive(() => ({ deltas: [], status: "usage_limit", retryAt: 1_767_340_800_000, error: "usage limit reached" }));
  const h = harness({ live });
  await h.say("selam");
  assert.equal(live.attempts.length, 1);
  const err = h.of("error")[0];
  assert.equal(err?.code, "usage_limit");
  assert.equal(err?.id, "t1");
  assert.equal(err?.retryAt, 1_767_340_800_000);
  assert.equal(h.of("assistant_done").length, 0);
  assert.equal(h.of("assistant_delta").length, 0);
  await settle();
  assert.equal(h.usage[0]?.outcome, "error");
  await h.session.close("t");
  const lines = h.lines();
  assert.ok(!lines.some((l) => l.kind === "assistant"));
  assert.ok(lines.some((l) => l.kind === "error" && l.code === "usage_limit"));
});

test("model error keeps partial text and sends model_error", async () => {
  const live = new FakeLive(() => ({ deltas: ["Yarım"], status: "dead", error: "agent process ended" }));
  const h = harness({ live, router: { route: () => ({ model: MODELS[2], tier: 2 }) } });
  await h.say("anlat");
  assert.equal(h.of("error")[0]?.code, "model_error");
  assert.equal(h.of("assistant_done")[0]?.text, "Yarım");
});

test("another socket of the same device is running an attempt → error busy", async () => {
  const live = new FakeLive(() => ({}));
  live.throwOnAttempt = new SessionBusyError();
  const h = harness({ live });
  await h.say("selam");
  assert.equal(h.of("error")[0]?.code, "busy");
  assert.equal(h.of("state").at(-1)?.state, "idle");
});

test("no session (start failed / backoff) or a closed one → this turn runs on the legacy runner with the registry's resume id", async () => {
  const h = harness({ registry: new FakeRegistry(undefined) });
  await h.say("selam");
  assert.equal(h.agent.calls.length, 1);
  assert.equal(h.agent.calls[0]?.resume, "resume-from-registry");
  assert.equal(h.of("assistant_done")[0]?.text, "Eski yol.");
  await settle();
  assert.deepEqual(h.registry.ended, [{ device: "browser", sessionId: "legacy-7" }]);

  const closed = new FakeLive(() => ({}));
  closed.throwOnAttempt = new SessionClosedError("closed");
  const h2 = harness({ live: closed });
  await h2.say("selam");
  assert.equal(h2.agent.calls.length, 1);
});

test("cancel aborts the attempt; assistant_done empty, logged as cancelled", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const live = new FakeLive(() => ({ run: () => gate, deltas: ["geç"] }));
  const h = harness({ live, router: { route: () => ({ model: MODELS[2], tier: 2 }) } });
  const turn = h.say("uzun anlat");
  await h.waitFor((f) => f.type === "state" && f.state === "thinking");
  await settle();
  await h.send({ type: "cancel", id: "t1" });
  assert.equal(live.attempts[0]?.signal?.aborted, true);
  release();
  await turn;
  assert.equal(h.of("assistant_done")[0]?.text, "");
  await settle();
  assert.equal(h.usage[0]?.outcome, "cancelled");
});

test("tier-0 exchange goes to the live session as a delimited note (no model call); without a live session it prefixes the next envelope", async () => {
  const live = new FakeLive(() => ({ deltas: ["Rica ederim."] }));
  const router = new TieredRouter({ config: parseRouterConfig(ROUTER_YAML), models: MODELS });
  const h = harness({ live, router });
  await h.say("evde sıcaklık kaç");
  await settle();
  assert.equal(live.attempts.length, 0);
  assert.deepEqual(live.notes, ["<bilgi>\nKullanıcı: evde sıcaklık kaç\nShadow: Ev sıcaklığı 22 derece.\n</bilgi>"]);
  await h.say("teşekkürler", "t2");
  assert.equal(live.attempts[0]?.text, "[mod:hizli]\nteşekkürler");

  // No live session: the note is kept for the next turn's envelope.
  const reg = new FakeRegistry(undefined);
  const h2 = harness({ registry: reg, router });
  await h2.say("evde sıcaklık kaç");
  const live2 = new FakeLive(() => ({ deltas: ["Tamam."] }));
  reg.session = live2;
  await h2.say("teşekkürler", "t2");
  assert.equal(live2.attempts[0]?.text, "[mod:hizli]\n<bilgi>\nKullanıcı: evde sıcaklık kaç\nShadow: Ev sıcaklığı 22 derece.\n</bilgi>\nteşekkürler");
});

test("tierN.services in persistent mode: tools of other services are denied by the gate", async () => {
  let decision: unknown;
  const live = new FakeLive(() => ({
    run: async (req) => {
      const ac = new AbortController();
      decision = await req.canUseTool(`${HA}homeassistant__GetLiveContext`, {}, { signal: ac.signal, toolUseID: "tu1" });
    },
    deltas: ["Bilmiyorum."],
  }));
  const h = harness({ live, tierServices: { 1: ["vault"] } });
  await h.say("ışık açık mı");
  assert.deepEqual(decision, { behavior: "deny", message: "This tool is not available in this mode.", toolUseID: "tu1" });
  assert.deepEqual(h.of("tool").map((f) => f.status), ["denied"]);

  let allowed: unknown;
  const live2 = new FakeLive(() => ({
    run: async (req) => {
      allowed = await req.canUseTool(`${HA}homeassistant__GetLiveContext`, {}, { signal: new AbortController().signal, toolUseID: "tu2" });
    },
  }));
  const h2 = harness({ live: live2, tierServices: { 1: ["home-assistant"] } });
  await h2.say("ışık açık mı");
  assert.equal((allowed as { behavior: string }).behavior, "allow");
});

// ------------------------------------------------------------------ S10: speech stream

test("speech_prefs audio: chunks in seq order with final, lexicon applied to the spoken text only", async () => {
  const live = new FakeLive(() => ({ deltas: ["Merhaba Shadow burada. ", "İkinci cümle biraz daha uzun bir cümle."] }));
  const { lexicon } = compileLexicon([{ from: "Shadow", to: "Şadov" }]);
  const spoken: string[] = [];
  const h = harness({
    live,
    router: { route: () => ({ model: MODELS[2], tier: 2 }) },
    lexicon,
    tts: {
      synthesize: async (text: string, _s?: AbortSignal, voice?: string) => {
        spoken.push(`${voice}|${text}`);
        return { mime: "audio/wav", data: Buffer.from(text) };
      },
      voices: async () => ({ default: "v", voices: ["v"] }),
    },
  });
  await h.send({ type: "speech_prefs", enabled: true, mode: "audio", voice: "tr_TR-x" });
  await h.say("anlat");
  await h.waitFor((f) => f.type === "speech_chunk" && f.final === true);
  const chunks = h.of("speech_chunk");
  assert.deepEqual(chunks.map((c) => c.seq), chunks.map((_c, i) => i));
  assert.equal(chunks.at(-1)?.final, true);
  assert.ok(chunks.every((c) => c.id === "t1"));
  assert.ok(spoken.every((s) => s.startsWith("tr_TR-x|")));
  assert.ok(spoken.join(" ").includes("Şadov"));
  assert.ok(!spoken.join(" ").includes("Shadow"));
  assert.match(h.of("assistant_done")[0]?.text ?? "", /Shadow/);
  assert.equal(Buffer.from(chunks[0]?.data ?? "", "base64").toString().startsWith("Merhaba Şadov"), true);
  await h.session.close("t");
  const timing = h.lines().find((l) => l.kind === "timing");
  assert.equal(typeof timing?.firstSpeechMs, "number");
});

test("no speech_prefs (old client) or enabled:false → no speech_chunk frames", async () => {
  const live = new FakeLive(() => ({ deltas: ["Bir cümle burada. İki cümle de burada."] }));
  const h = harness({ live, router: { route: () => ({ model: MODELS[2], tier: 2 }) } });
  await h.say("anlat");
  await settle();
  assert.equal(h.of("speech_chunk").length, 0);
  await h.send({ type: "speech_prefs", enabled: true, mode: "text" });
  await h.send({ type: "speech_prefs", enabled: false, mode: "text" });
  await h.say("anlat", "t2");
  await settle();
  assert.equal(h.of("speech_chunk").length, 0);
});

test("speech_prefs text mode: sentence texts for native TTS; tier-0 answers are spoken too", async () => {
  const live = new FakeLive(() => ({ deltas: ["Rica ederim."] }));
  const router = new TieredRouter({ config: parseRouterConfig(ROUTER_YAML), models: MODELS });
  const h = harness({ live, router });
  await h.send({ type: "speech_prefs", enabled: true, mode: "text" });
  await h.say("evde sıcaklık kaç");
  await h.waitFor((f) => f.type === "speech_chunk" && f.final === true);
  const chunks = h.of("speech_chunk");
  assert.equal(chunks[0]?.text, "Ev sıcaklığı 22 derece.");
  assert.equal(chunks[0]?.data, undefined);
});

test("tier-1 buffered answer: the escalation marker is never spoken", async () => {
  const live = new FakeLive((req) => (req.model === MODELS[1] ? { deltas: [ESCALATION_MARKER] } : { deltas: ["Uzun cevap burada."] }));
  const h = harness({ live });
  await h.send({ type: "speech_prefs", enabled: true, mode: "text" });
  await h.say("planla");
  await h.waitFor((f) => f.type === "speech_chunk" && f.final === true);
  assert.ok(h.of("speech_chunk").every((c) => !String(c.text ?? "").includes(ESCALATION_MARKER)));
  assert.equal(h.of("speech_chunk")[0]?.text, "Uzun cevap burada.");
});

test("cancel stops the turn's speech: no chunks after the cancel", async () => {
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const live = new FakeLive(() => ({ deltas: ["Birinci cümle burada. İkinci cümle burada."] }));
  const h = harness({
    live,
    router: { route: () => ({ model: MODELS[2], tier: 2 }) },
    tts: {
      synthesize: async (text: string, signal?: AbortSignal) => {
        await Promise.race([slow, new Promise((_r, rej) => signal?.addEventListener("abort", () => rej(new Error("aborted"))))]);
        return { mime: "audio/wav", data: Buffer.from(text) };
      },
      voices: async () => ({ default: "v", voices: ["v"] }),
    },
  });
  await h.send({ type: "speech_prefs", enabled: true, mode: "audio" });
  await h.say("anlat");
  assert.equal(h.of("assistant_done")[0]?.text, "Birinci cümle burada. İkinci cümle burada.");
  await h.send({ type: "cancel", id: "t1" });
  release();
  await settle();
  await settle();
  assert.equal(h.of("speech_chunk").length, 0);
  assert.equal(h.of("error").length, 0);
});

// ------------------------------------------------------------------ review round 1 regressions

test("legacy fallback holds the device's turn lock: a second socket gets busy, no concurrent legacy turn", async () => {
  const registry = new FakeRegistry(undefined);
  const a = harness({ registry, router: { route: () => ({ model: MODELS[2], tier: 2 }) } });
  const b = harness({ registry, router: { route: () => ({ model: MODELS[2], tier: 2 }) } });
  let release!: () => void;
  a.agent.hold = new Promise<void>((r) => (release = r));
  const first = a.say("uzun anlat");
  await a.waitFor((f) => f.type === "state" && f.state === "thinking");
  await settle();
  assert.equal(a.agent.calls.length, 1);
  await b.say("selam", "b1");
  assert.equal(b.of("error")[0]?.code, "busy");
  assert.equal(b.agent.calls.length, 0, "no second legacy turn on the same conversation");
  release();
  await first;
  await b.say("selam", "b2");
  assert.equal(b.agent.calls.length, 1, "the lock is released at the end of the turn");
});

test("escalation that cannot start: usage of the first attempt is recorded once, under its own tier, as error", async () => {
  const live = new FakeLive((req) => (req.model === MODELS[1] ? { deltas: [ESCALATION_MARKER] } : {}));
  const original = live.runAttempt.bind(live);
  live.runAttempt = (req) => {
    if (req.model === MODELS[2]) throw new SessionClosedError("closed");
    return original(req);
  };
  const h = harness({ live });
  await h.say("karşılaştır");
  assert.equal(h.of("error")[0]?.code, "model_error");
  await settle();
  await settle();
  assert.deepEqual(h.usage.map((u) => [u.tier, u.model, u.outcome]), [[1, MODELS[1], "error"]]);
});

test("an attempt cancelled by the session (no user cancel) does not speak its buffered partial text", async () => {
  const live = new FakeLive(() => ({ deltas: ["Yarım kalan cevap"], status: "cancelled" }));
  const h = harness({ live, router: { route: () => ({ model: MODELS[2], tier: 2 }) } });
  await h.send({ type: "speech_prefs", enabled: true, mode: "text" });
  await h.say("anlat");
  await settle();
  await settle();
  assert.equal(h.of("speech_chunk").filter((c) => c.text).length, 0);
});

test("tier-0 notes stay in order: buffered older notes go with the new one in a single note", async () => {
  const live = new FakeLive(() => ({ deltas: ["Tamam."] }));
  live.acceptNotes = false;
  const router = new TieredRouter({ config: parseRouterConfig(ROUTER_YAML), models: MODELS });
  const h = harness({ live, router });
  await h.say("evde sıcaklık kaç");
  await settle();
  assert.deepEqual(live.notes, [], "refused: kept for later");
  live.acceptNotes = true;
  await h.say("evde sıcaklık kaç", "t2");
  await settle();
  const one = "Kullanıcı: evde sıcaklık kaç\nShadow: Ev sıcaklığı 22 derece.";
  assert.deepEqual(live.notes, [`<bilgi>\n${one}\n${one}\n</bilgi>`]);
  await h.say("teşekkürler", "t3");
  assert.equal(live.attempts[0]?.text, "[mod:hizli]\nteşekkürler", "nothing left buffered");
});

test("tier-1 attempt cancelled by the session (no user cancel): its buffered complete sentences are not spoken", async () => {
  const live = new FakeLive(() => ({ deltas: ["Birinci cümle burada. İkinci cümle"], status: "cancelled" }));
  const h = harness({ live });
  await h.send({ type: "speech_prefs", enabled: true, mode: "text" });
  await h.say("anlat");
  await h.waitFor((f) => f.type === "assistant_done");
  await settle();
  await settle();
  assert.equal(h.of("speech_chunk").filter((c) => c.text).length, 0);
  assert.equal(h.of("assistant_done")[0]?.text, "");
});

test("concurrent refused tier-0 note batches go back in creation order (A before B)", async () => {
  class HeldNotes extends FakeLive {
    held: Array<(ok: boolean) => void> = [];
    override async appendNote(): Promise<boolean> {
      return new Promise<boolean>((res) => this.held.push(res));
    }
  }
  const live = new HeldNotes(() => ({ deltas: ["Tamam."] }));
  const router = new TieredRouter({ config: parseRouterConfig(ROUTER_YAML), models: MODELS });
  const h = harness({ live, router });
  await h.say("evde sıcaklık kaç"); // A
  await settle();
  await h.say("Evde sıcaklık kaç?", "t2"); // B
  await settle();
  assert.equal(live.held.length, 2, "both batches pending");
  // The agent dies: A is refused first, then B.
  live.held[0]?.(false);
  await settle();
  live.held[1]?.(false);
  await settle();
  await h.say("teşekkürler", "t3");
  const a = "Kullanıcı: evde sıcaklık kaç\nShadow: Ev sıcaklığı 22 derece.";
  const b = "Kullanıcı: Evde sıcaklık kaç?\nShadow: Ev sıcaklığı 22 derece.";
  assert.equal(live.attempts[0]?.text, `[mod:hizli]\n<bilgi>\n${a}\n${b}\n</bilgi>\nteşekkürler`);
});
