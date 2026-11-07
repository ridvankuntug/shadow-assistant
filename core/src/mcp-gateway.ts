/**
 * Core MCP gateway (T7.y): the one place model tool calls go through, whatever
 * the model provider. Provider-neutral: nothing here imports a model SDK. A
 * provider adapter only presents the catalog and forwards calls
 * (`gateway-sdk.ts` for the Claude Agent SDK today; a stdio MCP bridge later).
 *
 * - Mirror: a remote MCP service's tool list (Home Assistant over SSE) is
 *   fetched over the Core's own shared connection (`mcp-direct.ts`, the same
 *   one tier 0 uses) and offered with the same names, descriptions and JSON
 *   schemas. The model never sees the service URL or token.
 * - Local tools (vault, memory) are Core code with zod schemas; their
 *   arguments are validated before the gate, as the CLI used to do.
 * - Every call: known tool? → the Core's permission gate (`Session.gate()`
 *   via a provider-neutral `PermissionCallback`: levels, confirm by button or
 *   voice, cancel, read-only, tier services) → forward. A denial, an
 *   unavailable service or a cancel never throws: it is a normal tool result
 *   with `isError: true`, so the turn goes on.
 * - Each fresh remote list is classified by the permission policy and handed
 *   to dev-notes ("new tool: classify", added/removed tools, stale rules).
 * - A call naming a tool the gateway does not offer is a turn dev-note
 *   (`missing_capability`, reason `unknown_tool`; T7.w.3), recorded before the
 *   gate. The gateway serves no particular turn, so the note has no turn id.
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CatalogEntry, DevNotes, TurnNotes } from "./dev-notes.js";
import { DirectUnavailableError, untilAborted, type RemoteMcpClient } from "./mcp-direct.js";
import type { PermissionCallback } from "./model-provider.js";

/** One tool as the gateway offers it. */
export interface GatewayTool {
  name: string;
  description?: string;
  /** JSON Schema (object) of the arguments. */
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface GatewayToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}

/** A Core-side tool (vault, memory): zod-validated arguments, text result. */
export interface LocalTool {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  annotations?: Record<string, unknown>;
  handler(args: Record<string, unknown>): Promise<{ text: string; isError: boolean }>;
}

export type GatewaySource =
  | {
      kind: "remote";
      service: string;
      client: RemoteMcpClient;
      timeoutMs?: number;
      /** The service's configured address and token, masked in error texts for the model (`serviceSecrets`). */
      secrets?: ServiceSecrets;
    }
  | { kind: "local"; service: string; tools: readonly LocalTool[] };

/** What the gateway needs from the permission policy to classify a fresh list. */
export interface ToolClassifier {
  classifyTool(service: string, tool: string): { classified: boolean; level: string };
  exactToolRules(service: string): string[];
}

/** A gate bound to one turn: `gate` asks that turn's Core gate; `isCurrent()` says whether that turn still runs. */
export interface BoundGate {
  gate: PermissionCallback;
  isCurrent(): boolean;
}

/**
 * The gate a provider adapter hands to `call()`. A gate that serves several
 * turns (a persistent session's dispatcher) also has `bindTurn`: the gateway
 * calls it at the very start of a tool call, before any wait, so the call
 * belongs to the turn that was running when it arrived (undefined = no turn:
 * refused). Without `bindTurn` the gate is a per-turn gate and always current.
 */
export type GatewayGate = PermissionCallback & { bindTurn?: () => BoundGate | undefined };

export interface McpGatewayOptions {
  sources: readonly GatewaySource[];
  classifier?: ToolClassifier;
  devNotes?: Pick<DevNotes, "recordCatalog">;
  /** Turn dev-notes: unknown tool names (`missing_capability` / `unknown_tool`). */
  turnNotes?: Pick<TurnNotes, "record">;
  /** A cached remote list younger than this is served without asking the service. Default 60 s. */
  listTtlMs?: number;
  /** Retry interval of `warm()` while a remote service has never been listed. Default 30 s. */
  warmRetryMs?: number;
  /**
   * Period of the background catalog refresh started by `warm()` (same shared
   * connection), so tools added/removed during a long session are seen and
   * noted without a `tools/list` from the model. Default 5 min; 0 = off.
   */
  refreshIntervalMs?: number;
  log?: (level: "info" | "warn", msg: string) => void;
  now?: () => number;
}

/** Messages the model gets; no URL, token or transport detail. */
export const GATEWAY_MESSAGES = {
  unknownService: (s: string) => `Unknown tool service '${s}'.`,
  unknownTool: (t: string) => `Unknown tool '${t}'.`,
  unavailable: (s: string) => `The service '${s}' is not reachable right now. Tell the user; do not retry immediately.`,
  cancelled: "Turn was cancelled.",
  noTurn: "The turn this call belonged to is over; the action was not run.",
  tooLate: "The approval came too late to run the action within this tool call's time limit; it was not run. Ask the user again if needed.",
  gateFailed: "The permission check failed; the action was not run.",
  invalidArgs: (t: string, detail: string) => `Invalid arguments for '${t}': ${detail}`,
  failed: (t: string) => `The tool '${t}' failed.`,
  rejected: (t: string) => `The service did not accept the call to '${t}' (unknown tool or invalid arguments).`,
} as const;

export const DEFAULT_LIST_TTL_MS = 60_000;
export const DEFAULT_WARM_RETRY_MS = 30_000;
export const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60_000;
const DEFAULT_REMOTE_TIMEOUT_MS = 15_000;

/** The Core's canonical tool name, the one the permission policy parses (`mcp__<service>__<tool>`). */
export function qualifiedToolName(service: string, tool: string): string {
  return `mcp__${service}__${tool}`;
}

interface RemoteCache {
  tools: GatewayTool[];
  names: Set<string>;
  instructions?: string;
  fetchedAt: number;
  /** JSON of `tools`, to tell a real change from a refresh. */
  fingerprint: string;
}

/**
 * Values that name one remote service, masked literally in its error texts
 * (`redactEndpoints`). Held in memory only; never logged.
 */
export interface ServiceSecrets {
  /** Host names / host:port forms of the service URL. */
  addresses: readonly string[];
  /** The service's credentials (bearer token). */
  credentials: readonly string[];
}

/**
 * The literal values to mask for a service configured at `url` with `token`:
 * the URL's host with and without port (an IPv6 host bracketed and bare) and
 * the token. Values too short to be specific are left to the patterns.
 */
export function serviceSecrets(url: string | undefined, token: string | undefined): ServiceSecrets {
  const addresses = new Set<string>();
  if (url) {
    try {
      const u = new URL(url);
      if (u.host) addresses.add(u.host);
      if (u.hostname) {
        addresses.add(u.hostname);
        if (u.hostname.startsWith("[")) addresses.add(u.hostname.slice(1, -1));
      }
    } catch {
      // an invalid URL is refused by services.yaml parsing; nothing to add
    }
  }
  return {
    addresses: [...addresses].filter((a) => a.length >= 2),
    credentials: token && token.length >= 8 ? [token] : [],
  };
}

const escapeRe = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A bare IPv6 candidate is masked only if it is one: it has `::` or all 8 groups (so `10:30:15` stays). */
function bareIpv6(m: string): string {
  return m.includes("::") || (m.match(/:/g)?.length ?? 0) >= 7 ? "[address]" : m;
}

/**
 * Strips what could name the service's address or credentials from a remote
 * error text before the model sees it. First the configured values of the
 * service (`secrets`: its host, host:port and token), then patterns: URLs
 * (bracketed IPv6 hosts included), `Bearer` and `token=`/`password:`-style
 * credentials, JWT-like strings, IPv6 (bracketed or bare), IPv4, `host:port`
 * (single-label hosts too), names with two or more dots ending in a letter
 * TLD and `.local` names. Entity ids such as `light.kitchen` or `sensor.x_y`
 * (one dot, no port) and times such as `10:30` are kept.
 */
export function redactEndpoints(t: string, secrets?: ServiceSecrets): string {
  let out = t;
  if (secrets) {
    for (const c of [...secrets.credentials].sort((a, b) => b.length - a.length)) out = out.split(c).join("[credentials]");
    for (const a of [...secrets.addresses].sort((x, y) => y.length - x.length)) {
      out = out.replace(new RegExp(`(?<![\\w.-])${escapeRe(a)}(?![\\w-])`, "gi"), "[address]");
    }
  }
  return out
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/(?:\[[^\]\s]*\]|[^\s'"<>()[\]])+/gi, "[address]")
    .replace(/\bbearer(?:\s*=\s*|\s+)[^\s'",;]+/gi, "[credentials]")
    .replace(
      /(?<![\w-])(access_token|refresh_token|api_key|apikey|token|key|password|passwd|secret|authorization)(\s*[=:]\s*)(?!\[credentials\])[^\s'",;&]+/gi,
      "$1$2[credentials]",
    )
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[credentials]")
    .replace(/\[[0-9a-f]*:[0-9a-f:.]*(?:%[\w.]+)?\](?::\d{1,5})?/gi, "[address]")
    .replace(/(?<![\w:.])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,8}(?:%[\w.]+)?(?![\w:])/gi, bareIpv6)
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, "[address]")
    .replace(/(?<![\w.-])(?=[\w.-]*[a-z])[a-z0-9-]+(?:\.[a-z0-9-]+)*:\d{2,5}\b/gi, "[address]")
    .replace(/(?<![\w.-])(?:[a-z0-9-]+\.){2,}[a-z]{2,}\b(?![\w-])/gi, "[address]")
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.local\b/gi, "[address]");
}

function text(t: string, isError: boolean): GatewayToolResult {
  return { content: [{ type: "text", text: t }], isError };
}

function localToolDef(t: LocalTool): GatewayTool {
  const schema = z.toJSONSchema(z.object(t.shape)) as Record<string, unknown>;
  delete schema.$schema;
  return { name: t.name, description: t.description, inputSchema: schema, ...(t.annotations ? { annotations: t.annotations } : {}) };
}

export class McpGateway {
  private readonly sources = new Map<string, GatewaySource>();
  private readonly cache = new Map<string, RemoteCache>();
  private readonly inflight = new Map<string, Promise<RemoteCache>>();
  private readonly listeners = new Set<(service: string) => void>();
  private readonly now: () => number;
  private warmTimer: NodeJS.Timeout | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private readonly unsubscribers: Array<() => void> = [];
  private closed = false;

  constructor(private readonly o: McpGatewayOptions) {
    for (const s of o.sources) this.sources.set(s.service, s);
    this.now = o.now ?? Date.now;
    // A service that announces a changed list (`notifications/tools/list_changed`) is listed again at once.
    const clients = new Set<RemoteMcpClient>();
    for (const s of o.sources) if (s.kind === "remote") clients.add(s.client);
    for (const c of clients) {
      const off = c.onToolListChanged?.((service) => {
        const src = this.sources.get(service);
        if (src?.kind === "remote" && src.client === c && !this.closed) this.backgroundRefresh(src);
      });
      if (off) this.unsubscribers.push(off);
    }
  }

  /** Service names in source order (one presented server per service). */
  get services(): string[] {
    return [...this.sources.keys()];
  }

  /** The cached `initialize` instructions of a remote service, if it has been listed. */
  instructions(service: string): string | undefined {
    return this.cache.get(service)?.instructions;
  }

  /** Called with the service name whenever a remote tool list really changed. Returns the unsubscribe function. */
  onToolsChanged(listener: (service: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * The tools of one service. Remote: the cached list is served at once (a
   * session start never waits on the service once it has been listed); a
   * list older than the TTL is refreshed in the background, and a real change
   * reaches live sessions through `onToolsChanged`. Only a service that was
   * never listed is fetched in line; that throws if the service is down.
   */
  async listTools(service: string, signal?: AbortSignal): Promise<GatewayTool[]> {
    const src = this.sources.get(service);
    if (!src) return [];
    if (src.kind === "local") return src.tools.map(localToolDef);
    const cached = this.cache.get(service);
    if (!cached) return (await this.refresh(src, signal)).tools;
    if (this.now() - cached.fetchedAt >= (this.o.listTtlMs ?? DEFAULT_LIST_TTL_MS)) this.backgroundRefresh(src);
    return cached.tools;
  }

  /**
   * Waits (at most `timeoutMs`) until every remote service has been listed, so
   * a model session about to start gets the services' instructions. Never
   * throws; resolves false when a service is still unlisted at the deadline or
   * its listing failed. Services already listed cost no wait.
   */
  async whenListed(timeoutMs: number): Promise<boolean> {
    const pending = [...this.sources.values()].filter(
      (s): s is Extract<GatewaySource, { kind: "remote" }> => s.kind === "remote" && !this.cache.has(s.service),
    );
    if (pending.length === 0) return true;
    if (timeoutMs <= 0 || this.closed) return false;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    const listed = Promise.all(pending.map((s) => this.refresh(s).then(() => true, () => false))).then((r) => r.every(Boolean));
    try {
      return await Promise.race([listed, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Lists every remote service once (at Core start), so the first model
   * session already gets the instructions and the catalog. A service that
   * cannot be listed is retried every `warmRetryMs` until it answers once.
   * Also starts the periodic catalog refresh (`refreshIntervalMs`).
   */
  async warm(): Promise<void> {
    this.startPeriodicRefresh();
    const pending: string[] = [];
    await Promise.all(
      [...this.sources.values()].map(async (src) => {
        if (src.kind !== "remote" || this.cache.has(src.service)) return;
        try {
          await this.refresh(src);
        } catch (err) {
          pending.push(src.service);
          this.o.log?.("warn", `[shadow-core] gateway: ${src.service} tool list failed: ${(err as Error)?.message ?? String(err)}`);
        }
      }),
    );
    if (pending.length > 0 && !this.closed) {
      clearTimeout(this.warmTimer);
      this.warmTimer = setTimeout(() => void this.warm(), this.o.warmRetryMs ?? DEFAULT_WARM_RETRY_MS);
      this.warmTimer.unref?.();
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.warmTimer);
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
    for (const off of this.unsubscribers.splice(0)) off();
    this.listeners.clear();
  }

  private startPeriodicRefresh(): void {
    const every = this.o.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
    if (this.refreshTimer || this.closed || every <= 0) return;
    if (![...this.sources.values()].some((s) => s.kind === "remote")) return;
    this.refreshTimer = setInterval(() => {
      for (const src of this.sources.values()) if (src.kind === "remote") this.backgroundRefresh(src);
    }, every);
    this.refreshTimer.unref?.();
  }

  /** A refresh nobody waits for; a failure keeps the last good list and is only logged. */
  private backgroundRefresh(src: Extract<GatewaySource, { kind: "remote" }>): void {
    this.refresh(src).catch((err: unknown) =>
      this.o.log?.("warn", `[shadow-core] gateway: ${src.service} tool list refresh failed: ${(err as Error)?.message ?? String(err)}`),
    );
  }

  private refresh(src: Extract<GatewaySource, { kind: "remote" }>, signal?: AbortSignal): Promise<RemoteCache> {
    let p = this.inflight.get(src.service);
    if (!p) {
      // One shared fetch per service, bounded by the service timeout; a caller's
      // own signal only stops that caller from waiting.
      p = this.fetchRemote(src).finally(() => this.inflight.delete(src.service));
      this.inflight.set(src.service, p);
    }
    return signal ? untilAborted(p, signal) : p;
  }

  private async fetchRemote(src: Extract<GatewaySource, { kind: "remote" }>): Promise<RemoteCache> {
    const list = await src.client.listTools(src.service, AbortSignal.timeout(src.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS));
    const tools: GatewayTool[] = list.tools.map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object" },
      ...(t.annotations ? { annotations: t.annotations } : {}),
    }));
    const entry: RemoteCache = {
      tools,
      names: new Set(tools.map((t) => t.name)),
      ...(list.instructions ? { instructions: list.instructions } : {}),
      fetchedAt: this.now(),
      fingerprint: JSON.stringify([tools, list.instructions ?? null]),
    };
    const previous = this.cache.get(src.service);
    this.cache.set(src.service, entry);
    this.recordCatalog(src.service, tools);
    // The first list also notifies: a session that started while the service
    // was down got an empty list and must ask again.
    if (!previous || previous.fingerprint !== entry.fingerprint) {
      if (previous) this.o.log?.("info", `[shadow-core] gateway: ${src.service} tool list changed (${tools.length} tools)`);
      for (const l of [...this.listeners]) {
        try {
          l(src.service);
        } catch {
          // a listener must not break the refresh
        }
      }
    }
    return entry;
  }

  private recordCatalog(service: string, tools: readonly GatewayTool[]): void {
    const c = this.o.classifier;
    if (!c || !this.o.devNotes) return;
    const entries: CatalogEntry[] = tools.map((t) => {
      const k = c.classifyTool(service, t.name);
      return { name: t.name, classified: k.classified, level: k.level };
    });
    const unclassified = entries.filter((e) => !e.classified).length;
    if (unclassified > 0) this.o.log?.("info", `[shadow-core] gateway: ${service} has ${unclassified} unclassified tool(s) (confirm until classified)`);
    void this.o.devNotes.recordCatalog(service, entries, c.exactToolRules(service));
  }

  /**
   * One model tool call: known tool → gate → forward. Never throws; every
   * failure is a tool result with `isError: true`.
   */
  async call(
    service: string,
    tool: string,
    args: Record<string, unknown>,
    turnGate: GatewayGate,
    ctx: { signal: AbortSignal; toolUseID?: string; timeoutMs?: number },
  ): Promise<GatewayToolResult> {
    // The caller's (SDK's) time limit for this call, counted from now. A call
    // that cannot finish forwarding before it is not forwarded (see step 2).
    const deadline = ctx.timeoutMs !== undefined ? this.now() + ctx.timeoutMs : undefined;
    // 0) Bind the call to the turn running now, before any wait: a list refresh
    //    below must not let a late call of an ended turn run under the next
    //    turn's gate, nor a call made between turns attach to the next one.
    const bound: BoundGate | undefined = turnGate.bindTurn ? turnGate.bindTurn() : { gate: turnGate, isCurrent: () => true };
    if (!bound) return text(GATEWAY_MESSAGES.noTurn, true);
    const { gate } = bound;
    const src = this.sources.get(service);
    if (!src) return text(GATEWAY_MESSAGES.unknownService(service), true);
    const signal = ctx.signal;

    // 1) The tool must be one the gateway offers; local arguments are validated first.
    let local: LocalTool | undefined;
    let input = args ?? {};
    if (src.kind === "local") {
      local = src.tools.find((t) => t.name === tool);
      if (!local) return this.unknownTool(service, tool);
      const parsed = z.object(local.shape).safeParse(input);
      if (!parsed.success) return text(GATEWAY_MESSAGES.invalidArgs(tool, zodSummary(parsed.error)), true);
    } else {
      let known = this.cache.get(service)?.names.has(tool) ?? false;
      if (!known) {
        // A tool the cached list does not have: list once more (it may be new or the cache empty).
        try {
          known = (await this.refresh(src, signal)).names.has(tool);
        } catch {
          if (signal.aborted) return text(GATEWAY_MESSAGES.cancelled, true);
          return text(GATEWAY_MESSAGES.unavailable(service), true);
        }
      }
      if (!known) return this.unknownTool(service, tool);
      if (!bound.isCurrent()) return text(GATEWAY_MESSAGES.noTurn, true);
    }

    // 2) The Core's permission gate (confirm, cancel, read-only, tier services…).
    let decision;
    try {
      decision = await gate(qualifiedToolName(service, tool), input, { signal, toolUseID: ctx.toolUseID ?? `gw-${randomUUID()}` });
    } catch (err) {
      this.o.log?.("warn", `[shadow-core] gateway: gate failed for ${service}/${tool}: ${(err as Error)?.message ?? String(err)}`);
      return text(GATEWAY_MESSAGES.gateFailed, true);
    }
    if (decision.behavior !== "allow") return text(decision.message, true);
    if (signal.aborted) return text(GATEWAY_MESSAGES.cancelled, true);
    // The turn may have ended while the gate (a confirmation) was open.
    if (!bound.isCurrent()) return text(GATEWAY_MESSAGES.noTurn, true);
    // An approval given near the end of the caller's limit: the caller would
    // time the call out (the model sees a failure) while the service may still
    // run it, inviting a second attempt. A remote call may need a reconnect plus
    // the call itself (two service timeouts), so less time left than that is
    // refused here, before anything reaches the service.
    if (deadline !== undefined) {
      const need = local ? 0 : 2 * ((src as Extract<GatewaySource, { kind: "remote" }>).timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS);
      if (deadline - this.now() <= need) {
        this.o.log?.("warn", `[shadow-core] gateway: ${service}/${tool} approved too late for its time limit; not forwarded`);
        return text(GATEWAY_MESSAGES.tooLate, true);
      }
    }
    if (decision.updatedInput) input = decision.updatedInput;

    // 3) Forward.
    if (local) {
      const parsed = z.object(local.shape).safeParse(input);
      if (!parsed.success) return text(GATEWAY_MESSAGES.invalidArgs(tool, zodSummary(parsed.error)), true);
      try {
        const r = await local.handler(parsed.data as Record<string, unknown>);
        return text(r.text, r.isError);
      } catch {
        return text(GATEWAY_MESSAGES.failed(tool), true);
      }
    }
    const remote = src as Extract<GatewaySource, { kind: "remote" }>;
    try {
      const r = await remote.client.callTool(service, tool, input, signal);
      if (r.protocolError) {
        // A JSON-RPC error of the service: its text is protocol detail, not for the model.
        this.o.log?.("warn", `[shadow-core] gateway: ${service}/${tool} refused: ${r.text}`);
        return text(GATEWAY_MESSAGES.rejected(tool), true);
      }
      // A tool-level error (HA: "Error calling tool: …", e.g. an unknown entity) helps the
      // model correct itself, so it is kept, minus anything that could name the service.
      return text(r.isError ? redactEndpoints(r.text, remote.secrets) : r.text, r.isError);
    } catch (err) {
      if (signal.aborted) return text(GATEWAY_MESSAGES.cancelled, true);
      // Details (which may name the host) go to the Core log only.
      const detail = err instanceof DirectUnavailableError ? err.message : ((err as Error)?.message ?? String(err));
      this.o.log?.("warn", `[shadow-core] gateway: ${service}/${tool} failed: ${detail}`);
      return text(GATEWAY_MESSAGES.unavailable(service), true);
    }
  }

  /**
   * A tool the service does not offer: refused before the gate and noted. The
   * name is the model's own; TurnNotes stores it only if it looks like an
   * identifier. Never throws.
   */
  private unknownTool(service: string, tool: string): GatewayToolResult {
    try {
      void this.o.turnNotes?.record({ kind: "missing_capability", reason: "unknown_tool", service, tool }).catch(() => {});
    } catch {
      // a broken recorder must never affect the call
    }
    return text(GATEWAY_MESSAGES.unknownTool(tool), true);
  }
}

function zodSummary(err: z.ZodError): string {
  return err.issues
    .slice(0, 3)
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}
