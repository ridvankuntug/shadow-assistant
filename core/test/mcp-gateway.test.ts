/**
 * Core MCP gateway tests (T7.y): mirror, gate, forward, denial as a tool
 * result, dev-notes. Home Assistant is a fake `RemoteMcpClient`; the session
 * integration drives the real `Session` gate through `McpGateway.call`.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { z } from "zod";
import type { AgentRunner, TurnCallbacks, TurnRequest, TurnResult } from "../src/agent.js";
import { ConversationLog } from "../src/conversation-log.js";
import { classifyToolError, DevNotes, TurnNotes } from "../src/dev-notes.js";
import { DirectUnavailableError, type RemoteMcpClient, type RemoteToolDef, type RemoteToolList } from "../src/mcp-direct.js";
import {
  GATEWAY_MESSAGES,
  McpGateway,
  redactEndpoints,
  serviceSecrets,
  type GatewayGate,
  type GatewayToolResult,
  type LocalTool,
} from "../src/mcp-gateway.js";
import type { PermissionCallback } from "../src/model-provider.js";
import { PermissionPolicy } from "../src/permissions.js";
import type { ServerFrame } from "../src/protocol.js";
import { parseServices } from "../src/services.js";
import { Session } from "../src/session.js";

const base = mkdtempSync(join(tmpdir(), "shadow-gateway-test-"));
const sessions: Session[] = [];
after(async () => {
  await Promise.all(sessions.map((s) => s.close("test_end")));
  rmSync(base, { recursive: true, force: true });
});

const HA = "home-assistant";
const SECRET_HOST = "http://ha.secret.example:8123/mcp_server/sse";
const services = parseServices(
  [
    "services:",
    `  - name: ${HA}`,
    "    kind: mcp",
    "    url: http://localhost:1/sse",
    "    permission: confirm",
    "    tools:",
    '      "homeassistant__GetLiveContext": read',
    '      "intent__HassTurnOn": write',
    '      "intent__HassRenamedAway": write',
    '      "*Lock*": confirm',
    "  - name: shadow-memory",
    "    kind: memory",
    "    permission: confirm",
    "    tools:",
    "      echo: read",
  ].join("\n"),
  {},
).services;

const schema = (props: Record<string, unknown> = {}) => ({ type: "object", properties: props });
const HA_TOOLS: RemoteToolDef[] = [
  { name: "homeassistant__GetLiveContext", description: "Live context", inputSchema: schema() },
  { name: "intent__HassTurnOn", description: "Turn on", inputSchema: schema({ name: { type: "string" }, domain: { type: "array" } }) },
  { name: "intent__HassLockUnlock", description: "Unlock", inputSchema: schema({ name: { type: "string" } }) },
  { name: "media__HassMediaPause", description: "Pause (unclassified)", inputSchema: schema() },
];

class FakeHa implements RemoteMcpClient {
  tools: RemoteToolDef[] = HA_TOOLS.map((t) => ({ ...t }));
  instructions: string | undefined = "HA assist prompt";
  lists = 0;
  calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  failList = false;
  failCall: Error | undefined;
  /** When set, `listTools` waits for it (a slow service). */
  holdList: Promise<void> | undefined;
  /** When set, `callTool` returns it instead of `ok:<tool>`. */
  callResult: { text: string; isError: boolean; protocolError?: boolean } | undefined;
  changedListeners = new Set<(service: string) => void>();
  onToolListChanged(l: (service: string) => void): () => void {
    this.changedListeners.add(l);
    return () => this.changedListeners.delete(l);
  }
  async listTools(): Promise<RemoteToolList> {
    this.lists++;
    if (this.holdList) await this.holdList;
    if (this.failList) throw new DirectUnavailableError(HA, `connect failed: fetch ${SECRET_HOST} refused`);
    return { tools: this.tools.map((t) => ({ ...t })), ...(this.instructions ? { instructions: this.instructions } : {}) };
  }
  async callTool(_s: string, tool: string, args: Record<string, unknown>, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    this.calls.push({ tool, args });
    if (this.failCall) throw this.failCall;
    if (this.callResult) return { ...this.callResult };
    return { text: `ok:${tool}`, isError: false };
  }
}

const echoTool: LocalTool = {
  name: "echo",
  description: "Echo",
  shape: { say: z.string().max(5) },
  handler: async (args) => ({ text: `echo:${String(args.say)}`, isError: false }),
};

function makeGateway(o: { ha?: FakeHa; now?: () => number; devNotes?: DevNotes; listTtlMs?: number } = {}) {
  const ha = o.ha ?? new FakeHa();
  const policy = new PermissionPolicy(services);
  const logs: string[] = [];
  const gw = new McpGateway({
    sources: [
      { kind: "remote", service: HA, client: ha },
      { kind: "local", service: "shadow-memory", tools: [echoTool] },
    ],
    classifier: policy,
    ...(o.devNotes ? { devNotes: o.devNotes } : {}),
    ...(o.now ? { now: o.now } : {}),
    ...(o.listTtlMs !== undefined ? { listTtlMs: o.listTtlMs } : {}),
    log: (_l, m) => logs.push(m),
  });
  return { gw, ha, logs };
}

const allowAll: PermissionCallback = async (_n, input) => ({ behavior: "allow", updatedInput: input });
const ctx = () => ({ signal: new AbortController().signal, toolUseID: "tu-1" });
const textOf = (r: GatewayToolResult) => r.content.map((c) => c.text).join("\n");

test("mirror: same names, descriptions and schemas; instructions cached; no URL in the catalog", async () => {
  const { gw } = makeGateway();
  assert.deepEqual(gw.services, [HA, "shadow-memory"]);
  const tools = await gw.listTools(HA);
  assert.deepEqual(
    tools.map((t) => [t.name, t.description, t.inputSchema]),
    HA_TOOLS.map((t) => [t.name, t.description, t.inputSchema]),
  );
  assert.equal(gw.instructions(HA), "HA assist prompt");
  assert.ok(!JSON.stringify(tools).includes("localhost"), "the model-facing catalog carries no service address");
  const local = await gw.listTools("shadow-memory");
  assert.equal(local[0]?.name, "echo");
  assert.equal((local[0]?.inputSchema as { type?: string }).type, "object");
  assert.equal("$schema" in (local[0]?.inputSchema ?? {}), false);
});

test("call: the Core gate sees the qualified name, then the call is forwarded with the gate's input", async () => {
  const { gw, ha } = makeGateway();
  const seen: string[] = [];
  const gate: PermissionCallback = async (name, input, c) => {
    seen.push(`${name}|${c.toolUseID}`);
    return { behavior: "allow", updatedInput: { ...input, checked: true } };
  };
  const r = await gw.call(HA, "intent__HassTurnOn", { name: "Salon" }, gate, ctx());
  assert.deepEqual(r, { content: [{ type: "text", text: "ok:intent__HassTurnOn" }], isError: false });
  assert.deepEqual(seen, ["mcp__home-assistant__intent__HassTurnOn|tu-1"]);
  assert.deepEqual(ha.calls, [{ tool: "intent__HassTurnOn", args: { name: "Salon", checked: true } }]);
});

test("denied call: normal tool result with isError, nothing forwarded", async () => {
  const { gw, ha } = makeGateway();
  const deny: PermissionCallback = async () => ({ behavior: "deny", message: "The user declined this action; do not retry." });
  const r = await gw.call(HA, "intent__HassLockUnlock", { name: "Kapı" }, deny, ctx());
  assert.equal(r.isError, true);
  assert.equal(textOf(r), "The user declined this action; do not retry.");
  assert.equal(ha.calls.length, 0);
});

test("a throwing gate denies; a cancelled call is not forwarded", async () => {
  const { gw, ha } = makeGateway();
  const boom: PermissionCallback = async () => {
    throw new Error("gate exploded");
  };
  const r = await gw.call(HA, "intent__HassTurnOn", {}, boom, ctx());
  assert.deepEqual([r.isError, textOf(r)], [true, GATEWAY_MESSAGES.gateFailed]);
  const ac = new AbortController();
  const late: PermissionCallback = async (_n, input) => {
    ac.abort();
    return { behavior: "allow", updatedInput: input };
  };
  const c = await gw.call(HA, "intent__HassTurnOn", {}, late, { signal: ac.signal });
  assert.deepEqual([c.isError, textOf(c)], [true, GATEWAY_MESSAGES.cancelled]);
  assert.equal(ha.calls.length, 0);
});

test("unknown tool: listed once more, then refused without asking the gate", async () => {
  const { gw, ha } = makeGateway();
  await gw.listTools(HA);
  const before = ha.lists;
  let asked = 0;
  const gate: PermissionCallback = async (_n, input) => {
    asked++;
    return { behavior: "allow", updatedInput: input };
  };
  const r = await gw.call(HA, "intent__Nope", {}, gate, ctx());
  assert.deepEqual([r.isError, textOf(r)], [true, GATEWAY_MESSAGES.unknownTool("intent__Nope")]);
  assert.equal(ha.lists, before + 1);
  assert.equal(asked, 0);
  const s = await gw.call("no-such-service", "x", {}, gate, ctx());
  assert.equal(s.isError, true);
  assert.equal(asked, 0);
});

test("service failure: generic error to the model, details (host) only in the Core log", async () => {
  const { gw, ha, logs } = makeGateway();
  ha.failCall = new DirectUnavailableError(HA, `call failed: ${SECRET_HOST} timeout`);
  const r = await gw.call(HA, "intent__HassTurnOn", {}, allowAll, ctx());
  assert.deepEqual([r.isError, textOf(r)], [true, GATEWAY_MESSAGES.unavailable(HA)]);
  assert.ok(!textOf(r).includes("secret"));
  assert.ok(logs.some((l) => l.includes(SECRET_HOST)));
});

test("local tool: arguments validated before the gate; valid call runs the handler", async () => {
  const { gw } = makeGateway();
  const names: string[] = [];
  const gate: PermissionCallback = async (name, input) => {
    names.push(name);
    return { behavior: "allow", updatedInput: input };
  };
  const bad = await gw.call("shadow-memory", "echo", { say: 42 }, gate, ctx());
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /Invalid arguments for 'echo'/);
  assert.equal(names.length, 0, "an invalid call never reaches the gate (no confirm for nonsense)");
  const ok = await gw.call("shadow-memory", "echo", { say: "hi" }, gate, ctx());
  assert.deepEqual([ok.isError, textOf(ok)], [false, "echo:hi"]);
  assert.deepEqual(names, ["mcp__shadow-memory__echo"]);
  // The gate's updatedInput is validated again before the handler.
  const sneaky: PermissionCallback = async () => ({ behavior: "allow", updatedInput: { say: "far too long" } });
  assert.equal((await gw.call("shadow-memory", "echo", { say: "hi" }, sneaky, ctx())).isError, true);
});

test("list cache: served at once, stale → background refresh, last good list on failure; change → listeners", async () => {
  let now = 1_000;
  const ha = new FakeHa();
  const { gw, logs } = makeGateway({ ha, now: () => now, listTtlMs: 60_000 });
  const settle = () => new Promise((r) => setTimeout(r, 5));
  ha.failList = true;
  await assert.rejects(gw.listTools(HA), DirectUnavailableError, "never listed + service down → error");
  ha.failList = false;
  await gw.listTools(HA);
  const changed: string[] = [];
  gw.onToolsChanged((s) => changed.push(s));
  await gw.listTools(HA);
  assert.equal(ha.lists, 2, "served from the cache inside the TTL");

  // Stale + service down: the cached list comes back without waiting; the failed refresh is only logged.
  now += 61_000;
  ha.failList = true;
  assert.equal((await gw.listTools(HA)).length, HA_TOOLS.length);
  await settle();
  assert.equal(ha.lists, 3);
  assert.ok(logs.some((l) => l.includes("refresh failed") && !l.includes("undefined")));

  // Stale + changed list: the old list now, the new one after the background refresh, listeners told once.
  ha.failList = false;
  ha.tools.push({ name: "intent__HassNew", inputSchema: schema() });
  assert.equal((await gw.listTools(HA)).length, HA_TOOLS.length);
  await settle();
  assert.deepEqual(changed, [HA]);
  assert.equal((await gw.listTools(HA)).length, HA_TOOLS.length + 1);
});

/** A multi-turn gate like DeviceAgent's dispatcher: `turn` is the running turn (undefined = none). */
function turnGate(asked: string[]) {
  const state: { turn: string | undefined } = { turn: undefined };
  const gate: GatewayGate = Object.assign(async () => ({ behavior: "deny" as const, message: "unbound" }), {
    bindTurn: () => {
      const t = state.turn;
      if (t === undefined) return undefined;
      const bound: PermissionCallback = async (name, input) => {
        asked.push(`${t}:${name}`);
        return { behavior: "allow", updatedInput: input };
      };
      return { gate: bound, isCurrent: () => state.turn === t };
    },
  });
  return { gate, state };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

test("turn binding: a call that waits on a list refresh while its turn ends is refused, not run under the next turn", async () => {
  const { gw, ha } = makeGateway();
  const asked: string[] = [];
  const { gate, state } = turnGate(asked);
  state.turn = "A";
  const hold = deferred();
  ha.holdList = hold.promise;
  const pending = gw.call(HA, "intent__HassTurnOn", {}, gate, ctx()); // not cached yet → refresh
  await new Promise((r) => setTimeout(r, 5));
  state.turn = "B"; // turn A ended and turn B started during the refresh
  hold.resolve();
  const r = await pending;
  assert.deepEqual([r.isError, textOf(r)], [true, GATEWAY_MESSAGES.noTurn]);
  assert.deepEqual(asked, [], "neither turn's gate was asked");
  assert.equal(ha.calls.length, 0);
});

test("turn binding: a call made with no turn running stays refused even if a turn starts during the refresh", async () => {
  const { gw, ha } = makeGateway();
  const asked: string[] = [];
  const { gate, state } = turnGate(asked);
  const hold = deferred();
  ha.holdList = hold.promise;
  const pending = gw.call(HA, "intent__HassTurnOn", {}, gate, ctx());
  state.turn = "B";
  hold.resolve();
  const r = await pending;
  assert.deepEqual([r.isError, textOf(r)], [true, GATEWAY_MESSAGES.noTurn]);
  assert.deepEqual(asked, []);
  assert.equal(ha.lists, 0, "refused before any wait");
  assert.equal(ha.calls.length, 0);
});

test("turn binding: the turn ends while its gate is open → not forwarded; a current turn runs normally", async () => {
  const { gw, ha } = makeGateway();
  await gw.listTools(HA);
  const asked: string[] = [];
  const { gate, state } = turnGate(asked);
  state.turn = "A";
  const ok = await gw.call(HA, "intent__HassTurnOn", { name: "Salon" }, gate, ctx());
  assert.deepEqual([ok.isError, textOf(ok)], [false, "ok:intent__HassTurnOn"]);
  assert.deepEqual(asked, ["A:mcp__home-assistant__intent__HassTurnOn"]);
  // The gate (a confirmation) is answered after the turn moved on.
  const confirmThenTurnEnds: PermissionCallback = async (_n, input) => {
    state.turn = "B";
    return { behavior: "allow", updatedInput: input };
  };
  const slow: GatewayGate = Object.assign(async () => ({ behavior: "deny" as const, message: "unbound" }), {
    bindTurn: () => ({ gate: confirmThenTurnEnds, isCurrent: () => state.turn === "A" }),
  });
  const late = await gw.call(HA, "intent__HassTurnOn", {}, slow, ctx());
  assert.deepEqual([late.isError, textOf(late)], [true, GATEWAY_MESSAGES.noTurn]);
  assert.equal(ha.calls.length, 1);
});

test("returned errors: a protocol error is generic for the model (detail in the log); a tool error is kept without addresses", async () => {
  const { gw, ha, logs } = makeGateway();
  ha.callResult = { text: `MCP error -32602: Invalid params at ${SECRET_HOST}`, isError: true, protocolError: true };
  const p = await gw.call(HA, "intent__HassTurnOn", {}, allowAll, ctx());
  assert.deepEqual([p.isError, textOf(p)], [true, GATEWAY_MESSAGES.rejected("intent__HassTurnOn")]);
  assert.ok(logs.some((l) => l.includes("-32602") && l.includes(SECRET_HOST)));

  ha.callResult = {
    text: `Error calling tool: no entity named 'light.salon' (via ${SECRET_HOST}, homeassistant.local, 192.168.1.20:8123, Bearer abc.def)`,
    isError: true,
  };
  const t = await gw.call(HA, "intent__HassTurnOn", {}, allowAll, ctx());
  assert.equal(t.isError, true);
  assert.match(textOf(t), /^Error calling tool: no entity named 'light\.salon'/, "the useful part reaches the model");
  for (const leak of ["secret", "8123", "homeassistant.local", "192.168", "abc.def", "http"]) {
    assert.ok(!textOf(t).includes(leak), `no '${leak}' in the model text`);
  }
  // A successful result is passed through unchanged.
  ha.callResult = { text: "Turned on light.salon", isError: false };
  assert.equal(textOf(await gw.call(HA, "intent__HassTurnOn", {}, allowAll, ctx())), "Turned on light.salon");
});

test("redactEndpoints: URLs, tokens, IPs, host:port and .local names go; entity ids, times and plain text stay", () => {
  const out = redactEndpoints(
    "https://ha.example.com/api x ws://10.0.0.2:8123/ws eyJhbGciOi.eyJzdWIi.sig Bearer s3cr3t ha.lan:8123 nas.local light.kitchen at 10:30",
  );
  assert.equal(out, "[address] x [address] [credentials] [credentials] [address] [address] light.kitchen at 10:30");
});

test("redactEndpoints: IPv6, single-label host:port, portless FQDN and key=value credentials go; false positives stay", () => {
  const cases: Array<[string, string]> = [
    ["at [fe80::1]:8123 x", "at [address] x"],
    ["at fe80::1:8123 x", "at [address] x"],
    ["at [fd00::1] x", "at [address] x"],
    ["at homeassistant:8123 x", "at [address] x"],
    ["at ha.example.com x", "at [address] x"],
    ["Bearer=abc x", "[credentials] x"],
    ["token=llat_abc.def x", "token=[credentials] x"],
    [`access_token: ${"0123456789abcdef".repeat(2)} x`,"access_token: [credentials] x"],
    ["api_key=k1, password: p@ss; key=v", "api_key=[credentials], password: [credentials]; key=[credentials]"],
    ["Authorization: Bearer xyz", "Authorization: [credentials]"],
    ["http://[fd00::1]:8123/api?token=x end", "[address] end"],
    // kept: entity ids, times (with seconds too), plain words and C++-like '::'
    ["light.kitchen sensor.x_y at 10:30 and 10:30:15; std::vector", "light.kitchen sensor.x_y at 10:30 and 10:30:15; std::vector"],
  ];
  for (const [input, want] of cases) assert.equal(redactEndpoints(input), want, input);
});

test("redactEndpoints: the configured host (with and without port) and token are masked literally", () => {
  const secrets = serviceSecrets("http://myha:8123/mcp_server/sse", "llat_supersecret_token");
  assert.equal(
    redactEndpoints("myha refused (myha:8123) with llat_supersecret_token; myhab and light.myha stay", secrets),
    "[address] refused ([address]) with [credentials]; myhab and light.myha stay",
  );
  const v6 = serviceSecrets("http://[fd00::1]:8123/sse", undefined);
  assert.equal(redactEndpoints("host fd00::1 down", v6), "host [address] down");
  assert.deepEqual(serviceSecrets("http://ha:8123/sse", "short").credentials, [], "a too-short token is left to the patterns");
});

test("gateway: a tool error is masked with the service's configured address and token", async () => {
  const ha = new FakeHa();
  ha.callResult = { text: "Error calling tool: myha said no to llat_supersecret_token", isError: true };
  const gw = new McpGateway({
    sources: [{ kind: "remote", service: HA, client: ha, secrets: serviceSecrets("http://myha:8123/sse", "llat_supersecret_token") }],
  });
  const r = await gw.call(HA, "intent__HassTurnOn", {}, allowAll, ctx());
  assert.equal(textOf(r), "Error calling tool: [address] said no to [credentials]");
});

test("time limit: an aborted call or an approval too close to the caller's limit is not forwarded", async () => {
  let t = 0;
  const { gw, ha } = makeGateway({ now: () => t });
  await gw.listTools(HA);
  // Aborted (the SDK cancelled the call) while the gate was open.
  const ac = new AbortController();
  const abortThenAllow: PermissionCallback = async (_n, input) => {
    ac.abort();
    return { behavior: "allow", updatedInput: input };
  };
  const a = await gw.call(HA, "intent__HassTurnOn", {}, abortThenAllow, { signal: ac.signal, timeoutMs: 100_000 });
  assert.deepEqual([a.isError, textOf(a)], [true, GATEWAY_MESSAGES.cancelled]);
  // Approved with only two service timeouts (2 × 15 s) left: refused.
  const lateAllow =
    (at: number): PermissionCallback =>
    async (_n, input) => {
      t = at;
      return { behavior: "allow", updatedInput: input };
    };
  t = 0;
  const late = await gw.call(HA, "intent__HassTurnOn", {}, lateAllow(70_000), { ...ctx(), timeoutMs: 100_000 });
  assert.deepEqual([late.isError, textOf(late)], [true, GATEWAY_MESSAGES.tooLate]);
  assert.equal(ha.calls.length, 0, "nothing reached the service");
  // Enough time left: forwarded.
  t = 0;
  const ok = await gw.call(HA, "intent__HassTurnOn", {}, lateAllow(60_000), { ...ctx(), timeoutMs: 100_000 });
  assert.deepEqual([ok.isError, textOf(ok)], [false, "ok:intent__HassTurnOn"]);
  // A local tool only needs the limit not to be over.
  t = 0;
  const loc = await gw.call("shadow-memory", "echo", { say: "hi" }, lateAllow(99_000), { ...ctx(), timeoutMs: 100_000 });
  assert.deepEqual([loc.isError, textOf(loc)], [false, "echo:hi"]);
});

test("periodic refresh: a long session sees added/removed tools without a tools/list from the model; close() stops it", async () => {
  const ha = new FakeHa();
  const changed: string[] = [];
  const notes = new DevNotes({ dir: join(base, "dev-notes-periodic") });
  const gw = new McpGateway({
    sources: [{ kind: "remote", service: HA, client: ha }],
    classifier: new PermissionPolicy(services),
    devNotes: notes,
    refreshIntervalMs: 10,
  });
  await gw.warm();
  gw.onToolsChanged((s) => changed.push(s));
  ha.tools = ha.tools.filter((t) => t.name !== "intent__HassLockUnlock");
  ha.tools.push({ name: "intent__HassBrandNew", inputSchema: schema() });
  for (let i = 0; i < 100 && changed.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(changed, [HA], "the change was found by the timer alone");
  let file = await notes.read();
  for (let i = 0; i < 50 && !file.notes.some((n) => n.kind === "tool_removed"); i++) {
    await new Promise((r) => setTimeout(r, 5));
    file = await notes.read();
  }
  assert.deepEqual(
    file.notes.filter((n) => n.kind === "tool_added" || n.kind === "tool_removed").map((n) => [n.kind, n.tool]).sort(),
    [
      ["tool_added", "intent__HassBrandNew"],
      ["tool_removed", "intent__HassLockUnlock"],
    ],
  );
  gw.close();
  const lists = ha.lists;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(ha.lists, lists, "no refresh after close()");
});

test("list_changed from the service: the gateway lists again at once; close() unsubscribes", async () => {
  const ha = new FakeHa();
  const gw = new McpGateway({ sources: [{ kind: "remote", service: HA, client: ha }], refreshIntervalMs: 0 });
  await gw.listTools(HA);
  const changed: string[] = [];
  gw.onToolsChanged((s) => changed.push(s));
  ha.tools.push({ name: "intent__HassBrandNew", inputSchema: schema() });
  for (const l of ha.changedListeners) l(HA);
  for (let i = 0; i < 50 && changed.length === 0; i++) await new Promise((r) => setTimeout(r, 2));
  assert.deepEqual(changed, [HA]);
  assert.equal((await gw.listTools(HA)).length, HA_TOOLS.length + 1);
  gw.close();
  assert.equal(ha.changedListeners.size, 0);
});

test("whenListed(): no wait once listed; bounded wait while the service hangs; false at once when it is down", async () => {
  const ha = new FakeHa();
  const hold = deferred();
  ha.holdList = hold.promise;
  const gw = new McpGateway({ sources: [{ kind: "remote", service: HA, client: ha }] });
  const t0 = Date.now();
  assert.equal(await gw.whenListed(30), false);
  assert.ok(Date.now() - t0 < 1_000, "bounded by the timeout");
  hold.resolve();
  assert.equal(await gw.whenListed(1_000), true);
  assert.equal(gw.instructions(HA), "HA assist prompt");
  assert.equal(await gw.whenListed(0), true, "already listed: no wait needed");

  const down = new FakeHa();
  down.failList = true;
  const gw2 = new McpGateway({ sources: [{ kind: "remote", service: HA, client: down }] });
  const t1 = Date.now();
  assert.equal(await gw2.whenListed(5_000), false);
  assert.ok(Date.now() - t1 < 1_000, "a refused listing resolves at once, not at the deadline");
  // Local-only gateways never wait.
  assert.equal(await new McpGateway({ sources: [{ kind: "local", service: "m", tools: [echoTool] }] }).whenListed(1_000), true);
});

test("warm(): lists remote services at start and retries until one list succeeded", async () => {
  const ha = new FakeHa();
  ha.failList = true;
  const gw = new McpGateway({ sources: [{ kind: "remote", service: HA, client: ha }], warmRetryMs: 5 });
  await gw.warm();
  assert.equal(gw.instructions(HA), undefined);
  ha.failList = false;
  for (let i = 0; i < 50 && gw.instructions(HA) === undefined; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(gw.instructions(HA), "HA assist prompt");
  const lists = ha.lists;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ha.lists, lists, "no more retries once listed");
  gw.close();
});

test("dev-notes: unclassified tools are noted as 'new tool: classify' and run at confirm", async () => {
  const dir = join(base, "dev-notes-gw");
  const notes = new DevNotes({ dir });
  const { gw } = makeGateway({ devNotes: notes });
  await gw.listTools(HA);
  const file = await notes.read();
  const fresh = file.notes.filter((n) => n.kind === "new_tool").map((n) => [n.tool, n.level, n.message]);
  assert.deepEqual(fresh, [["media__HassMediaPause", "confirm", "yeni araç: sınıflandır"]]);
  assert.deepEqual(
    file.notes.filter((n) => n.kind === "rule_unmatched").map((n) => n.tool),
    ["intent__HassRenamedAway"],
  );
  assert.deepEqual(file.catalog[HA], HA_TOOLS.map((t) => t.name).sort());
});

// ------------------------------------------------------------ session integration

class GatewayAgent implements AgentRunner {
  results: GatewayToolResult[] = [];
  constructor(
    private readonly gw: McpGateway,
    private readonly calls: Array<{ tool: string; args: Record<string, unknown> }>,
  ) {}
  async runTurn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult> {
    // What the SDK adapter does inside a tool call: the gateway with this turn's Core gate.
    for (const c of this.calls) {
      cb.onToolUse?.(`tu-${c.tool}`, `mcp__${HA}__${c.tool}`);
      const r = await this.gw.call(HA, c.tool, c.args, req.canUseTool, { signal: req.signal, toolUseID: `tu-${c.tool}` });
      this.results.push(r);
      cb.onToolResult?.(`tu-${c.tool}`, `mcp__${HA}__${c.tool}`, r.isError);
    }
    cb.onDelta("tamam");
    return { text: "tamam", inputTokens: 1, outputTokens: 1, durationMs: 1 };
  }
}

function sessionWith(agent: AgentRunner, readOnly = false) {
  const frames: ServerFrame[] = [];
  const waiters: Array<() => void> = [];
  const session = new Session(
    {
      agent,
      policy: new PermissionPolicy(services, { readOnly }),
      router: { route: () => ({ model: "test-model" }) },
      stt: { transcribe: async () => ({ text: "" }) },
      tts: {
        synthesize: async () => ({ mime: "audio/wav", data: Buffer.from("RIFF") }),
        voices: async () => ({ default: "v", voices: ["v"] }),
      },
      log: new ConversationLog(join(base, `data-${sessions.length}`)),
      logger: { info: () => {}, warn: () => {} },
      confirmTimeoutMs: 5_000,
    },
    { sessionId: `gw${sessions.length}`, device: "browser" },
    (f) => {
      frames.push(f);
      waiters.splice(0).forEach((w) => w());
    },
  );
  sessions.push(session);
  const waitFor = (pred: (f: ServerFrame) => boolean) =>
    new Promise<ServerFrame>((res, rej) => {
      const check = () => {
        const f = frames.find(pred);
        if (f) res(f);
        else waiters.push(check);
      };
      setTimeout(() => rej(new Error("timeout waiting for frame")), 2_000).unref();
      check();
    });
  return { session, frames, waitFor };
}

test("session: write tool runs; confirm (button) runs after approval; declined → isError and the turn still ends", async () => {
  const { gw, ha } = makeGateway();
  const agent = new GatewayAgent(gw, [
    { tool: "intent__HassTurnOn", args: { name: "Salon" } },
    { tool: "intent__HassLockUnlock", args: { name: "Kapı" } },
    { tool: "media__HassMediaPause", args: {} },
  ]);
  const s = sessionWith(agent);
  const turn = s.session.handle({ type: "user_text", id: "t1", text: "x" });
  const c1 = (await s.waitFor((f) => f.type === "confirm_request")) as Extract<ServerFrame, { type: "confirm_request" }>;
  assert.equal(c1.tool, "intent__HassLockUnlock");
  await s.session.handle({ type: "confirm_response", requestId: c1.requestId, approved: true });
  // The unclassified tool asks too (confirm until classified).
  const c2 = (await s.waitFor((f) => f.type === "confirm_request" && f.requestId !== c1.requestId)) as Extract<
    ServerFrame,
    { type: "confirm_request" }
  >;
  assert.equal(c2.tool, "media__HassMediaPause");
  await s.session.handle({ type: "confirm_response", requestId: c2.requestId, approved: false });
  await turn;
  assert.deepEqual(
    ha.calls.map((c) => c.tool),
    ["intent__HassTurnOn", "intent__HassLockUnlock"],
  );
  assert.deepEqual(
    agent.results.map((r) => r.isError),
    [false, false, true],
  );
  assert.match(textOf(agent.results[2] as GatewayToolResult), /declined/);
  assert.ok(s.frames.some((f) => f.type === "assistant_done" && f.id === "t1"), "a denial does not kill the turn");
});

test("session: cancel while a confirm is pending → the call is denied as a tool result, nothing forwarded", async () => {
  const { gw, ha } = makeGateway();
  const agent = new GatewayAgent(gw, [{ tool: "intent__HassLockUnlock", args: { name: "Kapı" } }]);
  const s = sessionWith(agent);
  const turn = s.session.handle({ type: "user_text", id: "t1", text: "x" });
  await s.waitFor((f) => f.type === "confirm_request");
  await s.session.handle({ type: "cancel", id: "t1" });
  await turn;
  assert.equal(ha.calls.length, 0);
  assert.equal(agent.results[0]?.isError, true);
});

test("session: read-only mode denies non-read gateway calls without asking", async () => {
  const { gw, ha } = makeGateway();
  const agent = new GatewayAgent(gw, [
    { tool: "homeassistant__GetLiveContext", args: {} },
    { tool: "intent__HassTurnOn", args: { name: "Salon" } },
  ]);
  const s = sessionWith(agent, true);
  await s.session.handle({ type: "user_text", id: "t1", text: "x" });
  assert.deepEqual(
    ha.calls.map((c) => c.tool),
    ["homeassistant__GetLiveContext"],
  );
  assert.equal(s.frames.filter((f) => f.type === "confirm_request").length, 0);
  const r = agent.results[1] as GatewayToolResult;
  assert.equal(r.isError, true);
  assert.match(textOf(r), /Read-only/);
});


test("unknown_tool notes carry the turn id of the gate the call came through (bound or per-turn; T7.w.10j)", async () => {
  const notes = new TurnNotes({ dir: join(base, "gw-turn-id"), coalesceMs: 0 });
  const gw = new McpGateway({ sources: [{ kind: "remote", service: HA, client: new FakeHa() }], turnNotes: notes, refreshIntervalMs: 0 });
  const allowGate: PermissionCallback = async (_n, input) => ({ behavior: "allow", updatedInput: input });
  const signal = new AbortController().signal;
  // A persistent session's dispatcher: the binding names the turn.
  const dispatcher: GatewayGate = Object.assign(allowGate, {
    bindTurn: () => ({ gate: allowGate, isCurrent: () => true, turnId: "turn-a" }),
  });
  await gw.call(HA, "intent__HassMadeUpA", {}, dispatcher, { signal });
  // A per-turn gate (legacy runner) carries its own turn id.
  const perTurn: GatewayGate = Object.assign(async (_n: string, input: Record<string, unknown>) => ({ behavior: "allow" as const, updatedInput: input }), { turnId: "turn-b" });
  await gw.call(HA, "intent__HassMadeUpB", {}, perTurn, { signal });
  // Without one, the note has none (as before).
  await gw.call(HA, "intent__HassMadeUpC", {}, async (_n, input) => ({ behavior: "allow", updatedInput: input }), { signal });
  assert.deepEqual(
    (await notes.read()).notes.map((n) => [n.tool, n.lastTurnId]),
    [
      ["intent__HassMadeUpA", "turn-a"],
      ["intent__HassMadeUpB", "turn-b"],
      ["intent__HassMadeUpC", undefined],
    ],
  );
  gw.close();
});

test("the gateway's own failure texts map to the tool_error classes (pins GATEWAY_MESSAGES to classifyToolError)", () => {
  assert.equal(classifyToolError(GATEWAY_MESSAGES.cancelled), "cancelled");
  assert.equal(classifyToolError(GATEWAY_MESSAGES.noTurn), "cancelled");
  assert.equal(classifyToolError(GATEWAY_MESSAGES.tooLate), "timeout");
  assert.equal(classifyToolError(GATEWAY_MESSAGES.unavailable(HA)), "unreachable");
  assert.equal(classifyToolError(GATEWAY_MESSAGES.invalidArgs("echo", "say: Too big")), "invalid_value");
  assert.equal(classifyToolError(GATEWAY_MESSAGES.rejected("intent__HassTurnOn")), "invalid_value");
  assert.equal(classifyToolError(GATEWAY_MESSAGES.failed("echo")), "error");
});
