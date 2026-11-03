/**
 * Claude Agent SDK presentation of the Core MCP gateway (T7.y).
 *
 * The SDK gets only in-process MCP servers backed by `McpGateway`: one per
 * gateway service, named after the service, so the model's tool names stay
 * `mcp__<service>__<tool>` (prompts, router rules, logs and resumed sessions
 * are unchanged). No server here has a URL or token.
 *
 * The permission decision is not taken in the SDK: the server's `tools/call`
 * handler runs the Core gate (`McpGateway.call`). The SDK's `canUseTool` is
 * only a guard: a gateway tool is let through to that handler, anything else
 * (a built-in tool that slipped past `tools: []` / `disallowedTools`) is
 * denied.
 *
 * Built per query: an in-process server instance cannot be shared between queries.
 */
import { randomUUID } from "node:crypto";
import type { CanUseTool, McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { GatewayGate, McpGateway } from "./mcp-gateway.js";

export const BUILTIN_DENY_MESSAGE = "Built-in tools are disabled for this assistant.";
/** Same per-tool meta `createSdkMcpServer({ alwaysLoad: true })` sets: never deferred behind tool search. */
const ALWAYS_LOAD_META = { "anthropic/alwaysLoad": true } as const;

export interface GatewaySdkOptions {
  /**
   * Per-call wall-clock limit of the SDK for these servers (ms). Must cover a
   * confirmation (60 s by default) plus the service call, since both now run
   * inside the tool call.
   */
  timeoutMs?: number;
  /** Core log for failures that must not reach the model (e.g. a service that cannot be listed). */
  log?: (level: "info" | "warn", msg: string) => void;
}

/**
 * The SDK-side MCP servers for one query; `gate` is that query's Core gate (a
 * persistent session's dispatcher carries `bindTurn`, see `GatewayGate`).
 */
export function createGatewaySdkServers(
  gateway: McpGateway,
  gate: GatewayGate,
  o: GatewaySdkOptions = {},
): Record<string, McpSdkServerConfigWithInstance> {
  const out: Record<string, McpSdkServerConfigWithInstance> = {};
  for (const service of gateway.services) {
    const instructions = gateway.instructions(service);
    const mcp = new McpServer(
      { name: service, version: "1.0.0" },
      { capabilities: { tools: { listChanged: true } }, ...(instructions ? { instructions } : {}) },
    );
    mcp.server.setRequestHandler(ListToolsRequestSchema, async (_req, extra) => ({
      tools: (await safeList(gateway, service, extra.signal, o.log)).map((t) => ({
        name: t.name,
        ...(t.description !== undefined ? { description: t.description } : {}),
        inputSchema: t.inputSchema as { type: "object"; [k: string]: unknown },
        ...(t.annotations ? { annotations: t.annotations } : {}),
        _meta: ALWAYS_LOAD_META,
      })),
    }));
    mcp.server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
      const meta = req.params._meta as Record<string, unknown> | undefined;
      const toolUseID = typeof meta?.["claudecode/toolUseId"] === "string" ? (meta["claudecode/toolUseId"] as string) : `gw-${randomUUID()}`;
      const r = await gateway.call(service, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, gate, {
        signal: extra.signal,
        toolUseID,
        // The SDK's limit for this call: an approval too close to it is not forwarded (McpGateway.call).
        ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
      });
      return { content: r.content, isError: r.isError };
    });
    // A changed remote list reaches a live session without a restart. Subscribed
    // only once the client initialized, so an instance that is never connected
    // (filtered out, query failed early) leaves no listener behind.
    let unsubscribe: (() => void) | undefined;
    mcp.server.oninitialized = () => {
      unsubscribe ??= gateway.onToolsChanged((changed) => {
        if (changed === service && mcp.isConnected()) mcp.sendToolListChanged();
      });
    };
    mcp.server.onclose = () => {
      unsubscribe?.();
      unsubscribe = undefined;
    };
    out[service] = {
      type: "sdk",
      name: service,
      instance: mcp,
      ...(o.timeoutMs !== undefined ? { timeout: o.timeoutMs } : {}),
    };
  }
  return out;
}

/**
 * A service that has never been listed and is down makes `listTools` throw;
 * its message may name the host, so it goes to the Core log and the session
 * gets an empty list instead of a JSON-RPC error. An empty list keeps the
 * server connected in the CLI (an error could mark it failed for the whole
 * query); the first successful list then sends `tools/list_changed`
 * (`McpGateway` notifies on the first list too) and the CLI lists again.
 */
async function safeList(gateway: McpGateway, service: string, signal: AbortSignal, log: GatewaySdkOptions["log"]) {
  try {
    return await gateway.listTools(service, signal);
  } catch (err) {
    if (!signal.aborted) {
      log?.("warn", `[shadow-core] gateway: ${service} tool list unavailable for a session: ${(err as Error)?.message ?? String(err)}`);
    }
    return [];
  }
}

/**
 * The SDK `canUseTool` for a query that only has gateway servers: gateway
 * tools pass (the Core gate runs inside the call), everything else is denied.
 */
export function gatewayToolGuard(serverNames: readonly string[]): CanUseTool {
  const prefixes = serverNames.map((n) => `mcp__${n}__`);
  return async (toolName, input) =>
    prefixes.some((p) => toolName.startsWith(p))
      ? { behavior: "allow", updatedInput: input }
      : { behavior: "deny", message: BUILTIN_DENY_MESSAGE };
}
