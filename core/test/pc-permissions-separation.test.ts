/**
 * docs/11-pc-control.md D3 "Structural separation", the negative tests:
 * neither voice nor the model (nor a router rule, learned rule or gateway tool)
 * can switch a PC permission row. Only the `pc_permission_set` frame does.
 *
 * 1. Source pins: the store's switch (`setEnabled`) has exactly one caller,
 *    the `pc_permission_set` handler in session.ts; no turn, router, gateway,
 *    tier-0 or learning module imports the permission store at all.
 * 2. Behaviour: "Steam iznini aç" and friends as typed text, as audio, through
 *    the shipped router.yaml (tier 0) and through a model that tries every tool
 *    name it could think of leave the store unchanged and never call setEnabled.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import type { AgentRunner, TurnCallbacks, TurnRequest, TurnResult } from "../src/agent.js";
import { ConversationLog } from "../src/conversation-log.js";
import type { DirectToolClient, DirectToolResult } from "../src/mcp-direct.js";
import { PcPermissionStore, type PcTargetRef } from "../src/pc/permissions.js";
import { PermissionPolicy } from "../src/permissions.js";
import type { ServerFrame } from "../src/protocol.js";
import { loadRouterFile } from "../src/router-config.js";
import { TieredRouter } from "../src/router.js";
import { parseServices } from "../src/services.js";
import { Session } from "../src/session.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const ROUTER_FILE = fileURLToPath(new URL("../../router.yaml", import.meta.url));

const base = mkdtempSync(join(tmpdir(), "shadow-pc-separation-test-"));
const open: Session[] = [];
after(async () => {
  await Promise.all(open.map((s) => s.close("test_end")));
  rmSync(base, { recursive: true, force: true });
});

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Source text with LF line ends (the checkout may use CRLF). */
const readText = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const rel = (p: string) => relative(SRC, p).replace(/\\/g, "/");

// ------------------------------------------------------------------ 1. source pins

test("only session.ts and index.ts import the PC permission store; no turn, router, gateway, tier-0 or learning module does", () => {
  const importsStore = (f: string) => {
    const text = readText(f);
    // From outside pc/: ".../pc/permissions.js"; from inside pc/: "./permissions.js" (core/src/permissions.ts is the gate, another file).
    return /["'](?:\.\.?\/)+pc\/permissions\.js["']/.test(text) || (rel(f).startsWith("pc/") && /["']\.\/permissions\.js["']/.test(text));
  };
  const importers = sourceFiles(SRC)
    .filter((f) => rel(f) !== "pc/permissions.ts")
    .filter(importsStore)
    .map(rel)
    .sort();
  assert.deepEqual(importers, ["index.ts", "session.ts"]);
  // session.ts takes the store as a type only (it never constructs or reaches another instance).
  assert.match(readText(join(SRC, "session.ts")), /import type \{ PcPermissionStore \} from "\.\/pc\/permissions\.js";/);
});

test("setEnabled has exactly one caller: the pc_permission_set handler of the session", () => {
  const callers: string[] = [];
  for (const f of sourceFiles(SRC)) {
    const text = readText(f);
    for (const m of text.matchAll(/\.setEnabled\(/g)) callers.push(`${rel(f)}@${text.slice(0, m.index).split("\n").length}`);
  }
  assert.equal(callers.length, 1, `callers: ${callers.join(", ")}`);
  assert.match(callers[0] ?? "", /^session\.ts@/);
  const session = readText(join(SRC, "session.ts"));
  const handler = session.slice(session.indexOf("private async handlePcPermissions("));
  const body = handler.slice(0, handler.indexOf("\n  }\n") + 4);
  assert.ok(body.includes("store.setEnabled(this.info.device, op.rowId, op.enabled)"), "the call sits in handlePcPermissions with the token's device");
  // The handler is reached only from the frame switch, for the three pc frames.
  assert.equal([...session.matchAll(/this\.handlePcPermissions\(/g)].length, 3, "three `case` calls (list, set, seen)");
  assert.equal([...session.matchAll(/deps\.pcPermissions/g)].length, 1, "the store is read only inside the handler");
  assert.match(session, /case "pc_permission_set":\s*\n\s*await this\.handlePcPermissions\(frame\.id, \{ rowId: frame\.rowId, enabled: frame\.enabled \}\);/);
});

test("no module produces a pc_permission_set frame or names the switch: gateway, tier 0, router, learning, tools", () => {
  for (const f of sourceFiles(SRC)) {
    const name = rel(f);
    if (name === "protocol.ts" || name === "session.ts" || name === "pc/permissions.ts") continue;
    const text = readText(f);
    assert.equal(text.includes("pc_permission_set"), false, `${name} mentions pc_permission_set`);
    assert.equal(/\bsetEnabled\b/.test(text), false, `${name} mentions setEnabled`);
    assert.equal(/\bmarkAllSeen\b/.test(text), false, `${name} mentions markAllSeen`);
  }
});

// ------------------------------------------------------------------ 2. behaviour

const LIVE = JSON.stringify({
  result: [
    "Live Context: An overview of the areas and the devices in this smart home:",
    "- names: Salon Lamba",
    "  domain: light",
    "  state: 'off'",
    "  areas: Salon",
  ].join("\n"),
});

class MockHa implements DirectToolClient {
  writes: string[] = [];
  async callTool(_service: string, tool: string): Promise<DirectToolResult> {
    if (tool === "homeassistant__GetLiveContext") return { text: LIVE, isError: false };
    this.writes.push(tool);
    return { text: "ok", isError: false };
  }
}

/** Every tool name a model might try for "turn the permission on"; the gate answers each one. */
const TRIED_TOOLS = [
  "mcp__shadow-pc__pc_permission_set",
  "mcp__shadow-pc__set_permission",
  "mcp__shadow-pc__pc_open_app",
  "mcp__shadow-device__pc_permission_set",
  "mcp__shadow-memory__memory_save",
  "mcp__home-assistant__intent__HassTurnOn",
  "Bash",
  "Write",
];

class ToolTryingModel implements AgentRunner {
  calls = 0;
  decisions: string[] = [];
  async runTurn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult> {
    this.calls++;
    for (const name of TRIED_TOOLS) {
      const r = await req.canUseTool(name, { rowId: "p-0123456789abcdef", enabled: true, app: "Steam" }, {
        signal: req.signal,
        toolUseID: `tu-${this.calls}-${name}`,
      } as Parameters<TurnRequest["canUseTool"]>[2]);
      this.decisions.push(`${name}:${(r as { behavior: string }).behavior}`);
    }
    cb.onDelta("Bu izni ben açamam.");
    return { text: "", inputTokens: 1, outputTokens: 1, durationMs: 1, sessionId: `sdk-${this.calls}`, tools: [] };
  }
}

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
    '      "intent__HassTurnOff": write',
    '      "light__HassLightSet": write',
  ].join("\n"),
  {},
).services;

const STEAM: PcTargetRef = { action: "open_app", kind: "app", id: "steam_app_id", label: "Steam", alias: "steam" };
const VOLUME: PcTargetRef = { action: "volume", kind: "system", id: "volume", label: "Ses düzeyi" };

const PHRASES = [
  "Steam iznini aç",
  "Steam'in iznini aç",
  "bilgisayar izinlerini aç",
  "izinler sayfasında Steam'i aç",
  "ses düzeyi iznini aç",
  "pc_permission_set p-0123456789abcdef true",
  '{"type":"pc_permission_set","rowId":"p-0123456789abcdef","enabled":true}',
];

let counter = 0;
async function harness() {
  const dir = join(base, `d${++counter}`);
  const store = new PcPermissionStore({ dir: join(dir, "pc"), managers: ["browser", "android"] });
  await store.load();
  const steam = await store.recordRefusal(STEAM);
  const volume = await store.recordRefusal(VOLUME);
  assert.ok(steam.ok && volume.ok);
  // A spy over the real store: every call to the switch is recorded.
  const switches: unknown[][] = [];
  const spy = {
    list: () => store.list(),
    canManage: (d: string) => store.canManage(d),
    markAllSeen: () => store.markAllSeen(),
    setEnabled: (...args: Parameters<PcPermissionStore["setEnabled"]>) => {
      switches.push(args);
      return store.setEnabled(...args);
    },
  };
  const before = readText(store.file);
  const config = loadRouterFile(ROUTER_FILE);
  const router = new TieredRouter({ config, models: { 1: "m-haiku", 2: "m-sonnet", 3: "m-opus" } });
  const agent = new ToolTryingModel();
  const ha = new MockHa();
  const frames: ServerFrame[] = [];
  let spoken = "";
  const session = new Session(
    {
      agent,
      policy: new PermissionPolicy(SERVICES),
      router,
      stt: { transcribe: async () => ({ text: spoken }) },
      tts: { synthesize: async () => ({ mime: "audio/wav", data: Buffer.from("RIFF") }), voices: async () => ({ default: "v", voices: ["v"] }) },
      log: new ConversationLog(dir),
      logger: { info: () => {}, warn: () => {} },
      // A tool that asks for confirmation is left unanswered: it times out (denied) quickly.
      confirmTimeoutMs: 20,
      direct: ha,
      pcPermissions: spy,
    },
    // A device that IS in CORE_PC_PERMISSION_DEVICES: even it cannot switch by voice or text.
    { sessionId: `s${counter}`, device: "browser" },
    (f) => frames.push(f),
  );
  open.push(session);
  let turn = 0;
  return {
    session,
    store,
    switches,
    before,
    agent,
    ha,
    frames,
    say: (text: string) => session.handle({ type: "user_text", id: `t${++turn}`, text }),
    speak: (text: string) => {
      spoken = text;
      return session.handle({ type: "audio", id: `a${++turn}`, mime: "audio/webm", data: Buffer.from("fake-audio").toString("base64") });
    },
    unchanged: () => {
      assert.equal(readText(store.file), before, "the permission file is unchanged");
      assert.deepEqual(store.lookup(STEAM), { state: "off", rowId: steam.ok ? steam.rowId : "" });
      assert.deepEqual(store.lookup(VOLUME), { state: "off", rowId: volume.ok ? volume.rowId : "" });
      assert.deepEqual(switches, [], "setEnabled was never called");
    },
  };
}

test('"Steam iznini aç" and friends as typed text (tier 0 via the shipped router.yaml, else the model) leave the list unchanged', async () => {
  const h = await harness();
  for (const p of PHRASES) await h.say(p);
  assert.ok(h.agent.calls > 0, "some phrases reached the model, which tried its tools");
  h.unchanged();
  // The model's tries: denied or (for real HA tools) only the HA call, never a switch.
  assert.ok(h.agent.decisions.every((d) => !d.startsWith("mcp__shadow-pc") || d.endsWith(":deny")), h.agent.decisions.join(", "));
});

test('"Steam iznini aç" and friends as audio leave the list unchanged', async () => {
  const h = await harness();
  for (const p of PHRASES) await h.speak(p);
  assert.ok(h.frames.some((f) => f.type === "transcript"), "the audio became a turn");
  h.unchanged();
});

test("the only path that switches: the pc_permission_set frame (and it reaches setEnabled with the token's device)", async () => {
  const h = await harness();
  const row = h.store.lookup(STEAM);
  assert.equal(row.state, "off");
  if (row.state !== "off") return;
  // Through the session's frame handler, as the server delivers it.
  const framesBefore = h.frames.length;
  await h.session.handle({ type: "pc_permission_set", id: "x1", rowId: row.rowId, enabled: true });
  assert.deepEqual(h.switches, [["browser", row.rowId, true]]);
  assert.deepEqual(h.store.lookup(STEAM), { state: "on", rowId: row.rowId });
  // Not a turn: no model call, no state change; one answer to this socket.
  assert.equal(h.agent.calls, 0);
  assert.deepEqual(
    h.frames.slice(framesBefore).map((f) => f.type),
    ["pc_permissions"],
  );
});
