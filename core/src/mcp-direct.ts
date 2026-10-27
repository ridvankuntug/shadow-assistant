/**
 * Direct MCP client for tier 0: calls a service's MCP tools without a model.
 *
 * Uses the official MCP TypeScript SDK against the same endpoint the Agent SDK
 * uses (services.yaml `url`, e.g. `${HA_URL}/mcp_server/sse`, bearer token from
 * `token_env`). HA's `/api/mcp` streamable-HTTP endpoint is not used. One
 * connection per service is opened lazily and reused; any transport failure
 * drops it so the next call reconnects. Tokens are only placed in request
 * headers, never logged.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ServiceDef } from "./services.js";

export const DEFAULT_DIRECT_TIMEOUT_MS = 15_000;

export interface DirectToolResult {
  /** Text content of the tool result (text parts joined by newlines). */
  text: string;
  isError: boolean;
}

/** What the session needs for tier 0; mocked in tests. */
export interface DirectToolClient {
  /** Throws DirectUnavailableError when the service cannot be reached. */
  callTool(service: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<DirectToolResult>;
  close?(): Promise<void>;
}

export class DirectUnavailableError extends Error {
  constructor(
    readonly service: string,
    message: string,
  ) {
    super(message);
    this.name = "DirectUnavailableError";
  }
}

interface Endpoint {
  url: string;
  transport: "sse" | "http";
  token?: string;
  timeoutMs: number;
}

export class McpDirectClient implements DirectToolClient {
  private readonly endpoints = new Map<string, Endpoint>();
  private readonly clients = new Map<string, Promise<Client>>();

  constructor(services: readonly ServiceDef[], env: NodeJS.ProcessEnv) {
    for (const s of services) {
      if (s.kind !== "mcp" || !s.enabled || !s.url) continue;
      this.endpoints.set(s.name, {
        url: s.url,
        transport: s.transport ?? "sse",
        token: s.tokenEnv ? env[s.tokenEnv] : undefined,
        timeoutMs: s.timeoutMs ?? DEFAULT_DIRECT_TIMEOUT_MS,
      });
    }
  }

  /**
   * Shared connection per service (not tied to one turn). The whole handshake —
   * SSE GET, `endpoint` event and `initialize` — is bounded by the service
   * timeout; on failure the transport is closed so no EventSource keeps
   * reconnecting in the background.
   */
  private connect(service: string, ep: Endpoint): Promise<Client> {
    const existing = this.clients.get(service);
    if (existing) return existing;
    const p: Promise<Client> = (async () => {
      // The SDK sends requestInit headers on the SSE GET and on every POST.
      const requestInit: RequestInit = { headers: ep.token ?{ Authorization: `Bearer ${ep.token}` } : {} };
      const url = new URL(ep.url);
      const transport =
        ep.transport === "http" ? new StreamableHTTPClientTransport(url, { requestInit }) : new SSEClientTransport(url, { requestInit });
      const client = new Client({ name: "shadow-assistant-core", version: "0.1" });
      client.onclose = () => {
        if (this.clients.get(service) === p) this.clients.delete(service);
      };
      try {
        await untilAborted(client.connect(transport, { timeout: ep.timeoutMs }), AbortSignal.timeout(ep.timeoutMs));
      } catch (err) {
        await transport.close().catch(() => {});
        throw err;
      }
      return client;
    })();
    this.clients.set(service, p);
    p.catch(() => this.drop(service, p));
    return p;
  }

  /** Forgets (and closes) a connection, but only if it is still the current one. */
  private drop(service: string, p: Promise<Client>): void {
    if (this.clients.get(service) !== p) return;
    this.clients.delete(service);
    void p.then((c) => c.close()).catch(() => {});
  }

  async callTool(service: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<DirectToolResult> {
    const ep = this.endpoints.get(service);
    if (!ep) throw new DirectUnavailableError(service, `service '${service}' is not an enabled MCP service`);
    const p = this.connect(service, ep);
    let client: Client;
    try {
      // The caller may give up waiting (cancel) without tearing down the shared handshake.
      client = await untilAborted(p, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      throw new DirectUnavailableError(service, `connect failed: ${(err as Error).message}`);
    }
    try {
      const res = await client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: ep.timeoutMs });
      const content = Array.isArray(res.content) ? (res.content as Array<{ type?: string; text?: unknown }>) : [];
      const text = content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("\n");
      return { text, isError: res.isError === true };
    } catch (err) {
      // A cancelled call is not a connection problem: the SDK already told the server; keep the connection.
      if (signal.aborted) throw err;
      // A JSON-RPC error from a reachable server (unknown tool, bad arguments) is a tool error.
      if (err instanceof McpError && err.code !== ErrorCode.RequestTimeout && err.code !== ErrorCode.ConnectionClosed) {
        return { text: err.message, isError: true };
      }
      // Transport/timeout problems: drop this connection so the next call reconnects.
      this.drop(service, p);
      throw new DirectUnavailableError(service, `call failed: ${(err as Error).message}`);
    }
  }

  async close(): Promise<void> {
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(all.map((p) => p.then((c) => c.close()).catch(() => {})));
  }
}

/** Rejects with the signal's reason as soon as it aborts; otherwise settles like `promise`. */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
