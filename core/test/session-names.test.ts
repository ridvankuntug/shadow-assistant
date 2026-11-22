/**
 * T4.4b: confirmed device names (docs/14 Decisions 6-8) wired into the
 * session. Home Assistant and the model are mocked; nothing real is switched.
 * Generic names only.
 *
 * - "Evet, hep bu": offered only on an unknown-target raise with one `name`
 *   target and exactly one unresolved tier-0 slot in the window, never in a
 *   question turn; honoured only for the request that carried the offer;
 *   stored only when the call succeeds (button or voice);
 * - the stored name is used by tier 0 next time (no card) and by gate rule 5;
 * - the gate's live-context read sweeps the missing clock; an unusable read does not;
 * - `names_list` / `names_delete`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AgentRunner, TurnCallbacks, TurnRequest, TurnResult } from "../src/agent.js";
import { ConfirmedNameStore, fingerprintOf } from "../src/confirmed-names.js";
import { ConversationLog } from "../src/conversation-log.js";
import { nameKeys, parseLiveContext } from "../src/live-context.js";
import type { DirectToolClient, DirectToolResult } from "../src/mcp-direct.js";
import { PermissionPolicy } from "../src/permissions.js";
import type { ServerFrame } from "../src/protocol.js";
import { parseRouterConfig } from "../src/router-config.js";
import { TieredRouter } from "../src/router.js";
import { parseServices } from "../src/services.js";
import { Session } from "../src/session.js";

const base = mkdtempSync(join(tmpdir(), "shadow-session-names-test-"));
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
    "  attributes:",
    "    device_class: outlet",
  ].join("\n"),
});
const POMP = fingerprintOf(parseLiveContext(LIVE)[1] as ReturnType<typeof parseLiveContext>[number]);

const ROUTER_YAML = `
version: 1
rules:
  - id: device-off
    tier: 0
    patterns: ["<ad> kapat"]
    service: home-assistant
    tool: intent__HassTurnOff
    domains: [light, switch]
    reply: "Tamam, {ad} kapatıldı."
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
    "    target_check: true",
    "    tools:",
    `      "${LIVE_TOOL}": read`,
    '      "intent__HassTurnOn": write',
    '      "intent__HassTurnOff": write',
  ].join("\n"),
  {},
).services;

class MockHa implements DirectToolClient {
  calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  live: DirectToolResult = { text: LIVE, isError: false };
  async callTool(_service: string, tool: string, args: Record<string, unknown>): Promise<DirectToolResult> {
    this.calls.push({ tool, args });
    if (tool === LIVE_TOOL) return this.live;
    return { text: "ok", isError: false };
  }
  get writes() {
    return this.calls.filter((c) => c.tool !== LIVE_TOOL);
  }
}

/** Legacy runner: each turn makes the next plan's tool calls through the gate; `fail` = the allowed call's result is an error. */
class MockAgent implements AgentRunner {
  calls: TurnRequest[] = [];
  queue: Array<Array<{ tool: string; args: Record<string, unknown> }>> = [];
  fail = false;
  /** The plan's calls are made at once (several cards pending together), not one after another. */
  parallel = false;
  /** Runs after an allowed call and before its result is reported (e.g. a cancel meanwhile). */
  beforeResult?: () => Promise<void>;
  /** Names of the model calls the gate allowed (the model's calls never reach MockHa). */
  allowed: unknown[] = [];
  private seq = 0;
  async runTurn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult> {
    this.calls.push(req);
    const one = async (u: { tool: string; args: Record<string, unknown> }) => {
      const id = `tu-${++this.seq}`;
      const d = await req.canUseTool(`${HA}${u.tool}`, u.args, { signal: req.signal ?? new AbortController().signal, toolUseID: id });
      if (d.behavior !== "allow") return;
      this.allowed.push(u.args.name);
      await this.beforeResult?.();
      cb.onToolResult?.(id, `${HA}${u.tool}`, this.fail, this.fail ? "boom" : undefined);
    };
    const plan = this.queue.shift() ?? [];
    if (this.parallel) await Promise.all(plan.map(one));
    else for (const u of plan) await one(u);
    cb.onDelta("Tamam.");
    return { text: "", inputTokens: 1, outputTokens: 1, durationMs: 5, sessionId: `sdk-${this.calls.length}`, tools: [] };
  }
}

type ConfirmRequestFrame = Extract<ServerFrame, { type: "confirm_request" }>;

let counter = 0;
async function harness(o: { transcript?: string; store?: ConfirmedNameStore | null } = {}) {
  const dir = join(base, `d${++counter}`);
  const store = o.store === null ? undefined : (o.store ?? new ConfirmedNameStore({ dir: join(dir, "device-names") }));
  await store?.load();
  const frames: ServerFrame[] = [];
  const waiters: Array<() => void> = [];
  const ha = new MockHa();
  const agent = new MockAgent();
  const session = new Session(
    {
      agent,
      policy: new PermissionPolicy(SERVICES),
      router: new TieredRouter({ config: parseRouterConfig(ROUTER_YAML), models: MODELS }),
      stt: { transcribe: async () => ({ text: o.transcript ?? "" }) },
      tts: { synthesize: async () => ({ mime: "audio/wav", data: Buffer.from("RIFF") }), voices: async () => ({ default: "v", voices: ["v"] }) },
      log: new ConversationLog(dir),
      logger: { info: () => {}, warn: () => {} },
      confirmTimeoutMs: 5_000,
      direct: ha,
      ...(store ? { names: store } : {}),
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
  const confirms = () => frames.filter((f) => f.type === "confirm_request") as ConfirmRequestFrame[];
  /** Says `text`, waits for the (first new) card and lets `answer` respond to it; resolves once the turn is over. */
  const sayAndAnswer = async (text: string, answer: (req: ConfirmRequestFrame) => Promise<void>) => {
    const before = confirms().length;
    const done = session.handle({ type: "user_text", id: `t${++turn}`, text });
    const req = (await waitFor((f) => f.type === "confirm_request" && confirms().indexOf(f as ConfirmRequestFrame) >= before)) as ConfirmRequestFrame;
    await answer(req);
    await done;
    await store?.flush(); // the name is stored off the turn path
    return req;
  };
  const respond = (req: ConfirmRequestFrame, approved: boolean, remember?: true) =>
    session.handle({ type: "confirm_response", requestId: req.requestId, approved, ...(remember ? { remember } : {}) });
  return {
    session,
    store,
    ha,
    agent,
    frames,
    confirms,
    sayAndAnswer,
    respond,
    say: async (text: string) => {
      await session.handle({ type: "user_text", id: `t${++turn}`, text });
      await store?.flush();
    },
    names: async () => (store ? store.list() : []),
  };
}

const turnOff = (name: string) => ({ tool: "intent__HassTurnOff", args: { name } });

// ------------------------------------------------------------------ "Evet, hep bu"

test("unresolved tier-0 name -> model call -> card with remember -> 'Evet, hep bu' stores it; next time tier 0, no card", async () => {
  const h = await harness();
  h.agent.queue.push([turnOff("Bahçe Pompası")]);
  const req = await h.sayAndAnswer("bahçe pompasnı kapat", (r) => h.respond(r, true, true));
  assert.deepEqual(req.remember, { spoken: "bahçe pompasnı", target: "Bahçe Pompası" });
  assert.deepEqual(h.agent.allowed, ["Bahçe Pompası"]);
  const [entry, ...rest] = await h.names();
  assert.equal(rest.length, 0);
  assert.equal(entry?.spoken, "bahçe pompasnı");
  assert.deepEqual(entry?.keys, nameKeys("bahçe pompasnı"));
  assert.deepEqual(entry?.target, POMP);
  assert.equal(entry?.status, "active");

  // Same words again: tier 0 through the confirmed name, no card, no model.
  const agentCalls = h.agent.calls.length;
  await h.say("bahçe pompasnı kapat");
  assert.equal(h.confirms().length, 1);
  assert.equal(h.agent.calls.length, agentCalls);
  assert.deepEqual(h.ha.writes.map((c) => c.args.name), ["Bahçe Pompası"]);
  assert.equal((await h.names())[0]?.uses, 1);
});

test("a plain 'Evet' approves once: the write runs, nothing is stored", async () => {
  const h = await harness();
  h.agent.queue.push([turnOff("Bahçe Pompası")]);
  const req = await h.sayAndAnswer("bahçe pompasnı kapat", (r) => h.respond(r, true));
  assert.ok(req.remember);
  assert.equal(h.agent.allowed.length, 1);
  assert.deepEqual(await h.names(), []);
});

test("remember with approved:false is a no: nothing written, nothing stored", async () => {
  const h = await harness();
  h.agent.queue.push([turnOff("Bahçe Pompası")]);
  await h.sayAndAnswer("bahçe pompasnı kapat", (r) => h.respond(r, false, true));
  assert.equal(h.agent.allowed.length, 0);
  assert.deepEqual(await h.names(), []);
});

test("no unresolved tier-0 slot: no offer, and a forged remember (this card or another request id) is ignored", async () => {
  const h = await harness();
  h.agent.queue.push([turnOff("Bahçe Pompası")]);
  const req = await h.sayAndAnswer("pompayı durdur", async (r) => {
    await h.session.handle({ type: "confirm_response", requestId: "c-forged", approved: true, remember: true });
    await h.respond(r, true, true);
  });
  assert.equal(req.remember, undefined);
  assert.equal(h.agent.allowed.length, 1, "the approval itself still counts");
  assert.deepEqual(await h.names(), []);
});

test("remember:true counts only for the request that carried the offer: another (offer-less) card's remember does not store", async () => {
  // Two cards pending together: "Bahçe Pompası" (offer) and "Olmayan Cihaz" (reaches no device: no offer).
  const run = async (rememberOnOffered: boolean) => {
    const h = await harness();
    h.agent.parallel = true;
    h.agent.queue.push([turnOff("Bahçe Pompası"), turnOff("Olmayan Cihaz")]);
    const done = h.session.handle({ type: "user_text", id: "t1", text: "bahçe pompasnı kapat" });
    await new Promise<void>((res, rej) => {
      const t = setInterval(() => {
        if (h.confirms().length === 2) {
          clearInterval(t);
          res();
        }
      }, 5);
      setTimeout(() => (clearInterval(t), rej(new Error("two cards expected"))), 2000).unref();
    });
    const offered = h.confirms().find((c) => c.remember !== undefined);
    const plain = h.confirms().find((c) => c.remember === undefined);
    assert.ok(offered && plain, "one card with the offer, one without");
    await h.respond(plain, true, true);
    await h.respond(offered, true, rememberOnOffered ? true : undefined);
    await done;
    await h.store?.flush();
    assert.equal(h.agent.allowed.length, 2, "both approvals count");
    return h.names();
  };
  assert.deepEqual(await run(false), [], "remember on the offer-less card is not carried over");
  const stored = await run(true);
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.spoken, "bahçe pompasnı");
  assert.deepEqual(stored[0]?.target, POMP);
});

test("turn cancelled after the approval (before the result): nothing is stored", async () => {
  const h = await harness();
  h.agent.queue.push([turnOff("Bahçe Pompası")]);
  h.agent.beforeResult = () => h.session.handle({ type: "cancel", id: "t1" });
  const req = await h.sayAndAnswer("bahçe pompasnı kapat", (r) => h.respond(r, true, true));
  assert.ok(req.remember);
  assert.equal(h.agent.allowed.length, 1, "the call was allowed");
  assert.deepEqual(await h.names(), []);
});

test("no offer when the reached device's fingerprint is not unique in the snapshot", async () => {
  // "Bahçe Pompası" is an alias of an entity whose canonical name "Su Motoru" (switch, Bahçe) another entity shares.
  const entity = (names: string) => [`- names: ${names}`, "  domain: switch", "  state: 'on'", "  areas: Bahçe"];
  const live = (twin: boolean) =>
    JSON.stringify({ result: ["Live Context: overview", ...entity("Su Motoru, Bahçe Pompası"), ...(twin ? entity("Su Motoru") : [])].join("\n") });
  for (const twin of [true, false]) {
    const h = await harness();
    h.ha.live = { text: live(twin), isError: false };
    h.agent.queue.push([turnOff("Bahçe Pompası")]);
    const req = await h.sayAndAnswer("bahçe pompasnı kapat", (r) => h.respond(r, true, true));
    if (twin) {
      assert.equal(req.remember, undefined, "an ambiguous fingerprint is never offered");
      assert.deepEqual(await h.names(), []);
    } else {
      assert.deepEqual(req.remember, { spoken: "bahçe pompasnı", target: "Su Motoru" }, "control: unique fingerprint, offered");
    }
  }
});

test("question turn: card without remember, even with an unresolved slot; 'Evet, hep bu' stores nothing", async () => {
  const h = await harness();
  h.agent.queue.push([turnOff("Bahçe Pompası")]);
  const req = await h.sayAndAnswer("bahçe pompasnı kapat?", (r) => h.respond(r, true, true));
  assert.equal(req.remember, undefined);
  assert.deepEqual(await h.names(), []);
});

test("two different unresolved names in the window: no offer", async () => {
  const h = await harness();
  h.agent.queue.push([]); // the first turn's model does nothing
  await h.say("fıskiyeyi kapat");
  h.agent.queue.push([turnOff("Bahçe Pompası")]);
  const req = await h.sayAndAnswer("bahçe pompasnı kapat", (r) => h.respond(r, true, true));
  assert.equal(req.remember, undefined);
  assert.deepEqual(await h.names(), []);
});

test("a call that reaches no single device gets no offer", async () => {
  const h = await harness();
  h.agent.queue.push([turnOff("Olmayan Cihaz")]);
  const req = await h.sayAndAnswer("bahçe pompasnı kapat", (r) => h.respond(r, true, true));
  assert.equal(req.remember, undefined);
  assert.deepEqual(await h.names(), []);
});

test("the call fails (isError): nothing is stored", async () => {
  const h = await harness();
  h.agent.fail = true;
  h.agent.queue.push([turnOff("Bahçe Pompası")]);
  const req = await h.sayAndAnswer("bahçe pompasnı kapat", (r) => h.respond(r, true, true));
  assert.ok(req.remember);
  assert.deepEqual(await h.names(), []);
});

test("voice 'evet hep bu' stores the name; voice 'evet' approves once", async () => {
  const yes = await harness({ transcript: "Evet, hep bu." });
  yes.agent.queue.push([turnOff("Bahçe Pompası")]);
  await yes.sayAndAnswer("bahçe pompasnı kapat", () => yes.session.handle({ type: "audio", id: "a1", mime: "audio/webm", data: "AAAA" }));
  assert.equal(yes.agent.allowed.length, 1);
  assert.equal((await yes.names())[0]?.spoken, "bahçe pompasnı");

  const once = await harness({ transcript: "evet" });
  once.agent.queue.push([turnOff("Bahçe Pompası")]);
  await once.sayAndAnswer("bahçe pompasnı kapat", () => once.session.handle({ type: "audio", id: "a1", mime: "audio/webm", data: "AAAA" }));
  assert.equal(once.agent.allowed.length, 1);
  assert.deepEqual(await once.names(), []);
});

test("without a store: no offer, nothing breaks", async () => {
  const h = await harness({ store: null });
  h.agent.queue.push([turnOff("Bahçe Pompası")]);
  const req = await h.sayAndAnswer("bahçe pompasnı kapat", (r) => h.respond(r, true, true));
  assert.equal(req.remember, undefined);
  assert.equal(h.agent.allowed.length, 1);
});

// ------------------------------------------------------------------ gate rule 5 and the sweep

async function storeWith(spoken: string, target = POMP) {
  const store = new ConfirmedNameStore({ dir: join(base, `pre${++counter}`) });
  await store.load();
  const r = await store.add({ spoken, keys: nameKeys(spoken), target });
  assert.ok(r.ok);
  return store;
}

test("gate rule 5: a confirmed name in the user's words makes the model's canonical name known (no card)", async () => {
  const h = await harness({ store: await storeWith("fıskiyeyi") });
  h.agent.queue.push([turnOff("Bahçe Pompası")]);
  await h.say("fıskiyeyi durdur");
  assert.equal(h.confirms().length, 0);
  assert.deepEqual(h.agent.allowed, ["Bahçe Pompası"]);

  // Control: without the entry the same call asks.
  const c = await harness();
  c.agent.queue.push([turnOff("Bahçe Pompası")]);
  await c.sayAndAnswer("fıskiyeyi durdur", (r) => c.respond(r, false));
  assert.equal(c.confirms().length, 1);
  assert.equal(c.agent.allowed.length, 0);
});

test("gate rule 5: an entry whose fingerprint is missing from the snapshot (a look-alike device instead) does not make the call known", async () => {
  // Stored for "Bahçe-Pompası"; the live context has "Bahçe Pompası" (same after folding, not the same fingerprint).
  const h = await harness({ store: await storeWith("fıskiyeyi", { ...POMP, name: "Bahçe-Pompası" }) });
  h.agent.queue.push([turnOff("Bahçe Pompası")]);
  await h.sayAndAnswer("fıskiyeyi durdur", (r) => h.respond(r, false));
  assert.equal(h.confirms().length, 1);
  assert.equal(h.agent.allowed.length, 0);
});

test("gate rule 5: HA names win - an entry whose key is now the name of a device (any domain) does not vouch for its old target", async () => {
  // "fıskiye" was confirmed for the pump; later a cover named "Fıskiye" appeared.
  const h = await harness({ store: await storeWith("fıskiyeyi") });
  const withCover = JSON.parse(LIVE) as { result: string };
  withCover.result += ["", "- names: Fıskiye", "  domain: cover", "  state: open", "  areas: Bahçe"].join("\n");
  h.ha.live = { text: JSON.stringify(withCover), isError: false };
  h.agent.queue.push([turnOff("Bahçe Pompası")]);
  await h.sayAndAnswer("fıskiyeyi kapat", (r) => h.respond(r, false));
  assert.equal(h.confirms().length, 1, "rule 5 does not make the call known: the gate asks");
  assert.equal(h.agent.allowed.length, 0);
  assert.equal(h.ha.writes.length, 0, "tier 0 did not switch the pump either");
});

test("the gate's live-context read sweeps the missing clock; an empty or failed read does not", async () => {
  const gone = { name: "Eski Priz", domain: "switch", areas: ["Kiler"] };
  const h = await harness({ store: await storeWith("eski prizi", gone) });
  h.agent.queue.push([turnOff("Bahçe Pompası")]);
  await h.sayAndAnswer("pompayı durdur", (r) => h.respond(r, false));
  assert.notEqual((await h.names())[0]?.missingSince, null, "a valid read started the clock");

  for (const live of [
    { text: JSON.stringify({ result: "Live Context:\n- foo: 1" }), isError: false },
    { text: "boom", isError: true },
  ]) {
    const e = await harness({ store: await storeWith("eski prizi", gone) });
    e.ha.live = live;
    e.agent.queue.push([turnOff("Bahçe Pompası")]);
    await e.sayAndAnswer("pompayı durdur", (r) => e.respond(r, false));
    assert.equal(e.ha.calls.filter((c) => c.tool === LIVE_TOOL).length, 1, "the gate did read");
    assert.equal((await e.names())[0]?.missingSince, null, "an unusable read changes nothing");
  }
});

// ------------------------------------------------------------------ names_list / names_delete

test("names_list / names_delete: fresh list to the requesting socket only; unknown ids ignored", async () => {
  const store = await storeWith("fıskiyeyi");
  const other = await storeWith("bahçe pompasnı");
  const second = (await other.list())[0];
  assert.ok(second);
  const added = await store.add({ spoken: second.spoken, keys: second.keys, target: second.target });
  assert.ok(added.ok);
  const a = await harness({ store });
  const b = await harness({ store });

  await a.session.handle({ type: "names_list", id: "n1" });
  const list = a.frames.find((f) => f.type === "names") as Extract<ServerFrame, { type: "names" }>;
  assert.equal(list.id, "n1");
  assert.equal(list.items.length, 2);
  const first = list.items.find((i) => i.spoken === "fıskiyeyi");
  assert.deepEqual(first && Object.keys(first).sort(), ["id", "lastUsedAt", "missingSince", "spoken", "status", "target", "uses"]);
  assert.deepEqual(first?.target, POMP);
  assert.equal(first?.status, "active");
  assert.equal(first?.missingSince, null);

  await a.session.handle({ type: "names_delete", id: "n2", ids: [first?.id ?? "", "n-000000"] });
  const fresh = a.frames.filter((f) => f.type === "names").at(-1) as Extract<ServerFrame, { type: "names" }>;
  assert.equal(fresh.id, "n2");
  assert.deepEqual(fresh.items.map((i) => i.spoken), ["bahçe pompasnı"]);
  assert.equal(b.frames.filter((f) => f.type === "names").length, 0, "the other socket got nothing");
  assert.equal(a.frames.filter((f) => f.type === "error").length, 0);
});

test("names_list without a store: bad_request with the request id", async () => {
  const h = await harness({ store: null });
  await h.session.handle({ type: "names_list", id: "n1" });
  const err = h.frames.find((f) => f.type === "error") as Extract<ServerFrame, { type: "error" }>;
  assert.equal(err.code, "bad_request");
  assert.equal(err.id, "n1");
});
