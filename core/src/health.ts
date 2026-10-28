/**
 * Service health monitor: periodically checks every services.yaml entry and
 * tells subscribers (the WebSocket server) when a status changes.
 *
 * Checks per kind (all read-only, bounded by one timeout):
 *   http  - `GET <url><health>`; 200 → ok, 200 `{"status":"idle"}` → ok with
 *           detail `idle` (model unloaded, reloads on the next request),
 *           503 `{"status":"loading"}` → loading, anything else → down
 *           (the services' /health contract).
 *   mcp   - MCP endpoint handshake: `GET <url>` with the bearer token and
 *           `Accept: text/event-stream`. For SSE (Home Assistant) a 200 event
 *           stream means the endpoint, the token and HA's MCP Server
 *           integration all work; the stream is cancelled right after the
 *           headers, before any MCP message is exchanged — no tool is listed
 *           or called. Streamable-HTTP servers may refuse the GET (400/405);
 *           any non-auth answer below 500 counts as reachable there.
 *   vault - the vault folder still exists.
 *   memory - the memory folder exists (created if missing) and is writable.
 * Services that are disabled (in the file or by missing env) are reported as
 * `disabled` and never checked.
 *
 * Polling runs continuously (not only while a client is connected): it is a
 * handful of tiny requests per interval, keeps `GET /health` meaningful for
 * the deploy side and lets a new client get a fresh status right after
 * `welcome`. Rounds never overlap: the next one is scheduled only after the
 * previous one finished, and `checkNow()` during a round joins that round.
 *
 * `detail` is a short code from a fixed vocabulary; error messages (which can
 * contain URLs) are never copied into it.
 */
import { access, constants, mkdir, stat } from "node:fs/promises";
import type { ServiceHealth, ServiceHealthStatus } from "./protocol.js";
import type { ServiceDef } from "./services.js";

export const DEFAULT_HEALTH_INTERVAL_MS = 30_000;
export const DEFAULT_HEALTH_TIMEOUT_MS = 3_000;

export type CheckResult = { status: Exclude<ServiceHealthStatus, "disabled">; detail?: string };
/** One check; must honour `signal` (aborted on timeout or close). */
export type HealthCheck = (signal: AbortSignal) => Promise<CheckResult>;

export interface HealthTarget {
  name: string;
  /** Absent → the service is disabled and reported as such. */
  check?: HealthCheck;
  /** Detail for a disabled service (`not_configured` | `off`). */
  disabledDetail?: string;
}

export type FetchFn = typeof fetch;

/**
 * The fixed `detail` vocabulary. Checks only ever produce these, but `detail`
 * is typed as a string, so every value is passed through `safeDetail` before it
 * reaches a client or `GET /health`: anything outside the vocabulary (e.g. a
 * future check that copies an error message, which may contain a URL) becomes
 * `error` instead of leaking free text.
 */
const DETAIL_CODES = new Set([
  "timeout",
  "unreachable",
  "unauthorized",
  "error",
  "idle",
  "bad_response",
  "not_found",
  "not_configured",
  "off",
]);
const HTTP_DETAIL = /^http_[1-5][0-9]{2}$/;

export function safeDetail(detail: string | undefined): string | undefined {
  if (detail === undefined || detail === "") return undefined;
  return DETAIL_CODES.has(detail) || HTTP_DETAIL.test(detail) ? detail : "error";
}

/** Entry of `services` in `GET /health`: name, flag, status and the short detail code only. */
export interface PublicServiceHealth {
  name: string;
  enabled: boolean;
  status: ServiceHealthStatus | "unknown";
  detail?: string;
}

/**
 * `services` for `GET /health` (unauthenticated): services.yaml order, status
 * `unknown` before the first round. No URL, token or error message: `detail`
 * is re-checked against the vocabulary here as well.
 */
export function publicServiceHealth(
  services: readonly Pick<ServiceDef, "name" | "enabled">[],
  snapshot: readonly ServiceHealth[] | undefined,
): PublicServiceHealth[] {
  const byName = new Map((snapshot ?? []).map((h) => [h.name, h]));
  return services.map((s) => {
    const h = byName.get(s.name);
    const detail = safeDetail(h?.detail);
    return { name: s.name, enabled: s.enabled, status: h?.status ?? "unknown", ...(detail ? { detail } : {}) };
  });
}

interface MonitorLogger {
  info(message: string): void;
  warn(message: string): void;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function discardBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Already closed or aborted.
  }
}

/** `GET <baseUrl><path>` against the services' `/health` contract. */
export function httpHealthCheck(url: string, fetchFn: FetchFn = fetch): HealthCheck {
  return async (signal) => {
    const res = await fetchFn(url, { method: "GET", headers: { Accept: "application/json" }, signal });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const reported = isObj(body) && typeof body.status === "string" ? body.status : undefined;
    if (reported === "loading" && (res.ok || res.status === 503)) return { status: "loading" };
    if (res.ok) {
      if (reported === undefined || reported === "ok") return { status: "ok" };
      // Idle-unload contract (whisper-svc): the model is unloaded and reloads on the next request.
      if (reported === "idle") return { status: "ok", detail: "idle" };
      return { status: "down", detail: "error" };
    }
    if (res.status === 503 && reported === "error") return { status: "down", detail: "error" };
    return { status: "down", detail: `http_${res.status}` };
  };
}

/** MCP endpoint handshake (see the module comment); never sends an MCP message. */
export function mcpHealthCheck(
  url: string,
  transport: "sse" | "http",
  token: string | undefined,
  fetchFn: FetchFn = fetch,
): HealthCheck {
  return async (signal) => {
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetchFn(url, { method: "GET", headers, signal });
    const type = res.headers.get("content-type") ?? "";
    await discardBody(res);
    if (res.status === 401 || res.status === 403) return { status: "down", detail: "unauthorized" };
    if (transport === "sse") {
      if (res.status !== 200) return { status: "down", detail: `http_${res.status}` };
      return type.toLowerCase().includes("text/event-stream") ? { status: "ok" } : { status: "down", detail: "bad_response" };
    }
    if (res.status === 404 || res.status >= 500) return { status: "down", detail: `http_${res.status}` };
    return { status: "ok" };
  };
}

export function vaultHealthCheck(dir: string): HealthCheck {
  return async () => {
    try {
      return (await stat(dir)).isDirectory() ? { status: "ok" } : { status: "down", detail: "not_found" };
    } catch {
      return { status: "down", detail: "not_found" };
    }
  };
}

/**
 * Memory folder check: created if missing (the store would create it on the
 * first write anyway), then tested for write access. Never reads or writes a
 * memory file.
 */
export function memoryHealthCheck(dir: string): HealthCheck {
  return async () => {
    try {
      await mkdir(dir, { recursive: true });
      if (!(await stat(dir)).isDirectory()) return { status: "down", detail: "not_found" };
      await access(dir, constants.W_OK);
      return { status: "ok" };
    } catch {
      return { status: "down", detail: "error" };
    }
  };
}

/**
 * One target per service, in services.yaml order. `vaultDir` is the resolved
 * SHADOW_VAULT_DIR (index.ts disables the vault service without it);
 * `memoryDir` is `<SHADOW_DATA_DIR>/memory` when memory is enabled.
 */
export function buildHealthTargets(
  services: readonly ServiceDef[],
  env: NodeJS.ProcessEnv,
  opts: { vaultDir?: string; memoryDir?: string; fetchFn?: FetchFn } = {},
): HealthTarget[] {
  const fetchFn = opts.fetchFn ?? fetch;
  return services.map((s): HealthTarget => {
    if (!s.enabled) return { name: s.name, disabledDetail: s.disabledReason ? "not_configured" : "off" };
    if (s.kind === "http" && s.url) {
      // Without a health path there is nothing to poll; say so instead of claiming "ok".
      if (!s.health) return { name: s.name, disabledDetail: "not_configured" };
      return { name: s.name, check: httpHealthCheck(`${s.url}${s.health}`, fetchFn) };
    }
    if (s.kind === "mcp" && s.url) {
      const token = s.tokenEnv ? env[s.tokenEnv] : undefined;
      return { name: s.name, check: mcpHealthCheck(s.url, s.transport ?? "sse", token, fetchFn) };
    }
    if (s.kind === "vault" && opts.vaultDir) return { name: s.name, check: vaultHealthCheck(opts.vaultDir) };
    if (s.kind === "memory" && opts.memoryDir) return { name: s.name, check: memoryHealthCheck(opts.memoryDir) };
    return { name: s.name, disabledDetail: "not_configured" };
  });
}

export interface HealthMonitorOptions {
  intervalMs?: number;
  timeoutMs?: number;
  logger?: MonitorLogger;
  now?: () => number;
}

export type HealthListener = (items: ServiceHealth[]) => void;

export class HealthMonitor {
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly listeners = new Set<HealthListener>();
  /** Aborts in-flight checks on close(). */
  private readonly stopper = new AbortController();
  private current: ServiceHealth[] | undefined;
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private closed = false;

  constructor(
    private readonly targets: readonly HealthTarget[],
    private readonly opts: HealthMonitorOptions = {},
  ) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_HEALTH_INTERVAL_MS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  /** Latest statuses (services.yaml order), or undefined before the first round finished. */
  snapshot(): ServiceHealth[] | undefined {
    return this.current?.map((i) => ({ ...i }));
  }

  /** Called with the full list after the first round and whenever a status or detail changes. */
  subscribe(listener: HealthListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Runs the first round now and then one round per interval. */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    void this.checkNow();
  }

  /** Runs a round now; joins the running one instead of starting a second. */
  checkNow(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.running = this.round().finally(() => {
      this.running = null;
      this.schedule();
    });
    return this.running;
  }

  /** Stops the timer, aborts in-flight checks and waits for the round to settle. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stopper.abort();
    this.listeners.clear();
    await this.running?.catch(() => {});
  }

  private schedule(): void {
    if (this.closed || !this.started || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.checkNow();
    }, this.intervalMs);
    // The HTTP server keeps the process alive; the monitor alone must not.
    this.timer.unref?.();
  }

  private async runOne(t: HealthTarget): Promise<ServiceHealth> {
    const check = t.check;
    if (!check) {
      const detail = safeDetail(t.disabledDetail);
      return { name: t.name, status: "disabled", checkedAt: this.now(), ...(detail ? { detail } : {}) };
    }
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([timeout, this.stopper.signal]);
    let result: CheckResult;
    try {
      // The race guards against a check that ignores its signal.
      result = await new Promise<CheckResult>((resolve, reject) => {
        const onAbort = () => reject(signal.reason ?? new Error("aborted"));
        if (signal.aborted) return onAbort();
        signal.addEventListener("abort", onAbort, { once: true });
        check(signal).then(
          (r) => {
            signal.removeEventListener("abort", onAbort);
            resolve(r);
          },
          (err: unknown) => {
            signal.removeEventListener("abort", onAbort);
            reject(err);
          },
        );
      });
    } catch {
      result = { status: "down", detail: timeout.aborted ? "timeout" : "unreachable" };
    }
    const detail = safeDetail(result.detail);
    return { name: t.name, status: result.status, checkedAt: this.now(), ...(detail ? { detail } : {}) };
  }

  private async round(): Promise<void> {
    const items = await Promise.all(this.targets.map((t) => this.runOne(t)));
    if (this.closed) return;
    const prev = this.current;
    this.current = items;
    const changed =
      !prev ||
      items.some((i, idx) => {
        const p = prev[idx];
        return !p || p.status !== i.status || p.detail !== i.detail;
      });
    if (!changed) return;
    for (const i of items) {
      const p = prev?.find((x) => x.name === i.name);
      if (p && p.status === i.status && p.detail === i.detail) continue;
      if (!p && i.status === "ok") continue;
      const line = `[shadow-core] health: ${i.name} ${i.status}${i.detail ? ` (${i.detail})` : ""}`;
      if (i.status === "down") this.opts.logger?.warn(line);
      else this.opts.logger?.info(line);
    }
    for (const l of [...this.listeners]) {
      try {
        l(this.snapshot() ?? []);
      } catch (err) {
        this.opts.logger?.warn(`[shadow-core] health listener failed: ${(err as Error).message}`);
      }
    }
  }
}
