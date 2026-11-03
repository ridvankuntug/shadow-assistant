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
import { ErrorCode, McpError, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ServiceDef } from "./services.js";

export const DEFAULT_DIRECT_TIMEOUT_MS = 15_000;
const MAX_LIST_PAGES = 20;

export interface DirectToolResult {
  /** Text content of the tool result (text parts joined by newlines). */
  text: string;
  isError: boolean;
  /**
   * The service answered with a JSON-RPC error (unknown tool, invalid params…)
   * instead of a tool result; `text` is then the protocol error message, which
   * the gateway logs but does not pass to the model.
   */
  protocolError?: boolean;
}

/** What the session needs for tier 0; mocked in tests. */
export interface DirectToolClient {
  /** Throws DirectUnavailableError when the service cannot be reached. */
  callTool(service: string, tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<DirectToolResult>;
  close?(): Promise<void>;
}

/** One tool as the service lists it (MCP `tools/list`); the gateway mirrors it unchanged. */
export interface RemoteToolDef {
  name: string;
  description?: string;
  /** JSON Schema of the arguments, as the service sent it. */
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface RemoteToolList {
  tools: RemoteToolDef[];
  /** The server's `initialize` instructions (HA sends its Assist prompt here). */
  instructions?: string;
}

/** What the MCP gateway needs from a remote service: list + call over one shared connection. */
export interface RemoteMcpClient extends DirectToolClient {
  /** Throws DirectUnavailableError when the service cannot be reached or refuses the listing. */
  listTools(service: string, signal: AbortSignal): Promise<RemoteToolList>;
  /** Called with the service name when it sends `notifications/tools/list_changed`. Returns the unsubscribe function. */
  onToolListChanged?(listener: (service: string) => void): () => void;
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

export class McpDirectClient implements RemoteMcpClient {
  private readonly endpoints = new Map<string, Endpoint>();
  private readonly clients = new Map<string, Promise<Client>>();
  private readonly listChangedListeners = new Set<(service: string) => void>();

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
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        for (const l of [...this.listChangedListeners]) {
          try {
            l(service);
          } catch {
            // a listener must not break the connection
          }
        }
      });
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
        return { text: err.message, isError: true, protocolError: true };
      }
      // Transport/timeout problems: drop this connection so the next call reconnects.
      this.drop(service, p);
      throw new DirectUnavailableError(service, `call failed: ${(err as Error).message}`);
    }
  }

  /**
   * The service's tool list (all pages) over the same shared connection tier 0
   * uses, so the gateway opens no second SSE stream. Every failure is reported
   * as DirectUnavailableError; a transport failure also drops the connection.
   */
  async listTools(service: string, signal: AbortSignal): Promise<RemoteToolList> {
    const ep = this.endpoints.get(service);
    if (!ep) throw new DirectUnavailableError(service, `service '${service}' is not an enabled MCP service`);
    const p = this.connect(service, ep);
    let client: Client;
    try {
      client = await untilAborted(p, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      throw new DirectUnavailableError(service, `connect failed: ${(err as Error).message}`);
    }
    try {
      const tools: RemoteToolDef[] = [];
      let cursor: string | undefined;
      // Bounded paging: a server that keeps returning cursors cannot loop forever.
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const res = await client.listTools(cursor ? { cursor } : undefined, { signal, timeout: ep.timeoutMs });
        for (const t of res.tools) {
          tools.push({
            name: t.name,
            ...(t.description !== undefined ? { description: t.description } : {}),
            inputSchema: t.inputSchema as Record<string, unknown>,
            ...(t.annotations ? { annotations: t.annotations as Record<string, unknown> } : {}),
          });
        }
        cursor = res.nextCursor;
        if (!cursor) break;
      }
      const instructions = client.getInstructions();
      return { tools, ...(instructions ? { instructions } : {}) };
    } catch (err) {
      if (signal.aborted) throw err;
      const serverError = err instanceof McpError && err.code !== ErrorCode.RequestTimeout && err.code !== ErrorCode.ConnectionClosed;
      if (!serverError) this.drop(service, p);
      throw new DirectUnavailableError(service, `list failed: ${(err as Error).message}`);
    }
  }

  onToolListChanged(listener: (service: string) => void): () => void {
    this.listChangedListeners.add(listener);
    return () => this.listChangedListeners.delete(listener);
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
