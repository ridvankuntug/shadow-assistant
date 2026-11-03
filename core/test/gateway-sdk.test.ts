/**
 * Claude Agent SDK presentation of the gateway (T7.y), over the real MCP
 * protocol (in-memory transport, no CLI, no model): what the model is given,
 * what it sees, and that built-in tools stay closed.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { DENIED_BUILTIN_TOOLS, SdkAgentRunner } from "../src/agent.js";
import { BUILTIN_DENY_MESSAGE, createGatewaySdkServers, gatewayToolGuard } from "../src/gateway-sdk.js";
import { DirectUnavailableError, type RemoteMcpClient, type RemoteToolDef } from "../src/mcp-direct.js";
import { McpGateway } from "../src/mcp-gateway.js";
import type { PermissionCallback } from "../src/model-provider.js";

const base = mkdtempSync(join(tmpdir(), "shadow-gwsdk-test-"));
after(() => rmSync(base, { recursive: true, force: true }));

const HA = "home-assistant";
const tools: RemoteToolDef[] = [
  { name: "intent__HassTurnOn", description: "Turn on", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
];

function fakeHa(): RemoteMcpClient & { list: RemoteToolDef[]; calls: string[] } {
  const self = {
    list: tools.map((t) => ({ ...t })),
    calls: [] as string[],
    listTools: async () => ({ tools: self.list.map((t) => ({ ...t })), instructions: "HA prompt" }),
    callTool: async (_s: string, tool: string) => {
      self.calls.push(tool);
      return { text: `ok:${tool}`, isError: false };
    },
  };
  return self;
}

/** The SDK types `canUseTool` as possibly returning null; the guard never does. */
async function ask(guard: CanUseTool, tool: string, input: Record<string, unknown> = {}): Promise<PermissionResult> {
  const r = await guard(tool, input, { signal: new AbortController().signal, toolUseID: "t" } as Parameters<CanUseTool>[2]);
  assert.ok(r);
  return r;
}

async function connect(server: ReturnType<typeof createGatewaySdkServers>[string]) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(b);
  return client;
}

test("one in-process server per gateway service, named after it; no URL/token in the config", async () => {
  const ha = fakeHa();
  const gw = new McpGateway({ sources: [{ kind: "remote", service: HA, client: ha }] });
  await gw.warm();
  const servers = createGatewaySdkServers(gw, async (_n, i) => ({ behavior: "allow", updatedInput: i }), { timeoutMs: 85_000 });
  assert.deepEqual(Object.keys(servers), [HA]);
  const s = servers[HA];
  assert.ok(s);
  assert.equal(s.type, "sdk");
  assert.equal(s.timeout, 85_000);
  assert.equal("url" in s || "headers" in s, false);

  const client = await connect(s);
  assert.equal(client.getInstructions(), "HA prompt", "HA's instructions are passed through");
  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map((t) => [t.name, t.description, t.inputSchema, t._meta?.["anthropic/alwaysLoad"]]),
    [["intent__HassTurnOn", "Turn on", tools[0]?.inputSchema, true]],
  );
  const r = await client.callTool({ name: "intent__HassTurnOn", arguments: { name: "Salon" } });
  assert.deepEqual(r.content, [{ type: "text", text: "ok:intent__HassTurnOn" }]);
  assert.equal(r.isError, false);
  await client.close();
  gw.close();
});

test("the gate runs inside the tool call; a denial is an isError result, not a protocol error", async () => {
  const ha = fakeHa();
  const gw = new McpGateway({ sources: [{ kind: "remote", service: HA, client: ha }] });
  const asked: string[] = [];
  const gate: PermissionCallback = async (name, _i, ctx) => {
    asked.push(`${name}|${ctx.toolUseID}`);
    return { behavior: "deny", message: "The user declined this action; do not retry." };
  };
  const client = await connect(createGatewaySdkServers(gw, gate)[HA] as ReturnType<typeof createGatewaySdkServers>[string]);
  const r = await client.callTool({ name: "intent__HassTurnOn", arguments: {}, _meta: { "claudecode/toolUseId": "toolu_1" } });
  assert.equal(r.isError, true);
  assert.deepEqual(r.content, [{ type: "text", text: "The user declined this action; do not retry." }]);
  assert.deepEqual(asked, ["mcp__home-assistant__intent__HassTurnOn|toolu_1"]);
  assert.equal(ha.calls.length, 0);
  await client.close();
});

test("a changed remote list notifies the live session (tools/list_changed); closed sessions unsubscribe", async () => {
  let now = 0;
  const ha = fakeHa();
  const gw = new McpGateway({ sources: [{ kind: "remote", service: HA, client: ha }], now: () => now, listTtlMs: 10 });
  await gw.warm();
  const client = await connect(createGatewaySdkServers(gw, async (_n, i) => ({ behavior: "allow", updatedInput: i }))[HA] as ReturnType<
    typeof createGatewaySdkServers
  >[string]);
  let notified = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    notified++;
  });
  ha.list.push({ name: "intent__HassNew", inputSchema: { type: "object" } });
  now += 100;
  await gw.listTools(HA);
  for (let i = 0; i < 20 && notified === 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(notified, 1);
  await client.close();
  ha.list.pop();
  now += 100;
  await gw.listTools(HA);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(notified, 1, "no notification after close");
});

test("a service never listed and down: the session gets an empty list (no host in a JSON-RPC error), then list_changed once it answers", async () => {
  const ha = fakeHa();
  let down = true;
  const realList = ha.listTools;
  ha.listTools = async (s, signal) => {
    if (down) throw new DirectUnavailableError(HA, "connect failed: fetch http://ha.secret.example:8123/mcp_server/sse refused");
    return realList(s, signal);
  };
  const gw = new McpGateway({ sources: [{ kind: "remote", service: HA, client: ha }] });
  const logs: string[] = [];
  const server = createGatewaySdkServers(gw, async (_n, i) => ({ behavior: "allow", updatedInput: i }), {
    log: (_l, m) => logs.push(m),
  })[HA] as ReturnType<typeof createGatewaySdkServers>[string];
  const client = await connect(server);
  let notified = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    notified++;
  });
  const empty = await client.listTools();
  assert.deepEqual(empty.tools, []);
  assert.ok(!JSON.stringify(empty).includes("secret"));
  assert.ok(logs.some((l) => l.includes("ha.secret.example")), "the detail is in the Core log only");

  down = false;
  assert.equal(await gw.whenListed(1_000), true);
  for (let i = 0; i < 20 && notified === 0; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(notified, 1, "the first successful list tells the live session to ask again");
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name), ["intent__HassTurnOn"]);
  await client.close();
  gw.close();
});

test("a session built after whenListed() carries HA's instructions; one built before the list has none until the next session", async () => {
  const ha = fakeHa();
  const gw = new McpGateway({ sources: [{ kind: "remote", service: HA, client: ha }] });
  const allowGate: PermissionCallback = async (_n, i) => ({ behavior: "allow", updatedInput: i });
  const early = await connect(createGatewaySdkServers(gw, allowGate)[HA] as ReturnType<typeof createGatewaySdkServers>[string]);
  assert.equal(early.getInstructions(), undefined);
  await early.close();
  assert.equal(await gw.whenListed(1_000), true);
  const next = await connect(createGatewaySdkServers(gw, allowGate)[HA] as ReturnType<typeof createGatewaySdkServers>[string]);
  assert.equal(next.getInstructions(), "HA prompt");
  await next.close();
  gw.close();
});

test("guard: gateway tools pass to the Core gate; built-in and foreign tools are denied", async () => {
  const guard = gatewayToolGuard([HA, "shadow-vault"]);
  assert.equal((await ask(guard, "mcp__home-assistant__intent__HassTurnOn", { a: 1 })).behavior, "allow");
  assert.equal((await ask(guard, "mcp__shadow-vault__read_note")).behavior, "allow");
  for (const t of [...DENIED_BUILTIN_TOOLS, "mcp__other__x", "mcp__home-assistant", "home-assistant__intent__HassTurnOn"]) {
    const r = await ask(guard, t);
    assert.equal(r.behavior, "deny", t);
    assert.equal(r.behavior === "deny" ? r.message : "", BUILTIN_DENY_MESSAGE);
  }
});

test("built-in Claude Code tools are closed in every model query (legacy and persistent)", async () => {
  const received: PermissionCallback[] = [];
  const runner = new SdkAgentRunner({
    systemPrompt: "sys",
    // Stand-ins for the gateway's in-process servers.
    mcpServers: (gate) => {
      received.push(gate);
      return { [HA]: { type: "sse", url: "http://localhost:1/a" }, "shadow-vault": { type: "sse", url: "http://localhost:1/b" } };
    },
    cwd: join(base, "cwd"),
  });
  const turnGate: PermissionCallback = async () => ({ behavior: "deny", message: "" });
  const legacy = runner.buildOptions({ prompt: "x", model: "haiku", signal: new AbortController().signal, canUseTool: turnGate }, new AbortController());
  const persistent = runner.buildPersistentOptions({ model: "haiku", gate: turnGate, abortController: new AbortController() });
  assert.deepEqual(received, [turnGate, turnGate], "the Core gate goes to the gateway servers");
  for (const o of [legacy, persistent]) {
    assert.deepEqual(o.tools, [], "no built-in tool in the model's context");
    assert.equal(o.allowedTools, undefined, "nothing is pre-approved");
    assert.deepEqual(o.settingSources, [], "no ~/.claude settings, CLAUDE.md, plugins or MCP servers");
    assert.equal(o.strictMcpConfig, true);
    assert.equal(o.permissionMode, "default");
    for (const t of ["Bash", "BashOutput", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "WebFetch", "WebSearch", "Task", "Agent"]) {
      assert.ok(o.disallowedTools?.includes(t), `disallowed: ${t}`);
    }
    assert.deepEqual(Object.keys(o.mcpServers ?? {}), [HA, "shadow-vault"], "only gateway servers");
    const guard = o.canUseTool as CanUseTool;
    for (const t of DENIED_BUILTIN_TOOLS) assert.equal((await ask(guard, t)).behavior, "deny", t);
    assert.equal((await ask(guard, "mcp__home-assistant__intent__HassTurnOn")).behavior, "allow");
  }
});
