/**
 * Read-only Home Assistant WebSocket client (docs/09 (c), T7.w.11.5).
 *
 * Connects to `${HA_URL}/api/websocket` (ws/wss from http/https), authenticates
 * with the Core's long-lived token and hands the caller a connection that can
 * only send the commands in READ_ONLY_COMMANDS: Shadow never writes to,
 * dismisses or changes anything in HA. Message shapes (HA WebSocket API):
 *
 *   ← {type:"auth_required"}         → {type:"auth", access_token}
 *   ← {type:"auth_ok"} | {type:"auth_invalid"}
 *   → {id, type:<command>, ...}       ← {id, type:"result", success, result | error}
 *                                     ← {id, type:"event", event}   (subscriptions)
 *
 * A message may also arrive as a JSON array of such messages (HA's coalescing);
 * anything that is not an object with a known `type` is ignored.
 *
 * Reconnect: after any close (refused, lost, auth_invalid, timeout) the next
 * attempt waits 1 → 2 → 4 … → 60 s (± 20 % jitter, injectable timers / random).
 * The delay starts over after the first successful command result on a
 * connection (HA really answered, not only accepted the socket). A dead TCP
 * link is noticed by protocol-level pings (no HA command): no pong before the
 * next ping → the socket is dropped and reconnected.
 *
 * Logs never hold the URL, the token or HA's error messages: only fixed texts,
 * error codes and close codes.
 */
import WebSocket from "ws";
import type { Logger } from "./session.js";

/** The only commands this client sends (read-only). T7.w.11.6 adds `repairs/list_issues`. */
export const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set(["persistent_notification/subscribe"]);

export const HA_BACKOFF_START_MS = 1_000;
export const HA_BACKOFF_MAX_MS = 60_000;
/** ± this share of the delay. */
export const HA_BACKOFF_JITTER = 0.2;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const AUTH_TIMEOUT_MS = 10_000;
const HEARTBEAT_MS = 30_000;
/** HA's notification set is small; a larger frame is refused by `ws`. */
const MAX_PAYLOAD = 8 * 1024 * 1024;

export interface HaTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const defaultTimers: HaTimers = {
  set(fn, ms) {
    const t = setTimeout(fn, ms);
    // The HTTP server keeps the process alive; this client alone must not.
    t.unref?.();
    return t;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * `${HA_URL}/api/websocket` with ws/wss, or undefined when HA_URL is not an
 * http(s)/ws(s) URL. Query and fragment are dropped; a path prefix is kept.
 */
export function haWebSocketUrl(haUrl: string): string | undefined {
  let u: URL;
  try {
    u = new URL(haUrl.trim());
  } catch {
    return undefined;
  }
  const proto = ({ "http:": "ws:", "https:": "wss:", "ws:": "ws:", "wss:": "wss:" } as Record<string, string>)[u.protocol];
  if (!proto || !u.host) return undefined;
  u.protocol = proto;
  u.pathname = `${u.pathname.replace(/\/+$/, "")}/api/websocket`;
  u.search = "";
  u.hash = "";
  return u.toString();
}

/** Delay before reconnect attempt `n` (0-based): 1, 2, 4 … capped at 60 s, then ± jitter. */
export function haBackoffMs(n: number, random: () => number = Math.random): number {
  const base = Math.min(HA_BACKOFF_MAX_MS, HA_BACKOFF_START_MS * 2 ** Math.min(n, 16));
  const r = random();
  const k = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0.5;
  return Math.round(base * (1 + HA_BACKOFF_JITTER * (2 * k - 1)));
}

/** A failed command: HA's error code only (its message is not kept, it can hold names). */
export class HaCommandError extends Error {
  constructor(readonly code: string) {
    super(`HA command failed (${code})`);
    this.name = "HaCommandError";
  }
}

/** The connection closed before the command was answered. */
export class HaClosedError extends Error {
  constructor() {
    super("HA connection closed");
    this.name = "HaClosedError";
  }
}

/** What a connected caller can do; valid until `onDisconnected`. */
export interface HaConnection {
  /** One read-only command; resolves with `result`, rejects HaCommandError / HaClosedError. */
  command(type: string, extra?: Record<string, unknown>): Promise<unknown>;
  /** A read-only subscription: `onEvent` gets each `event` payload (unchecked). Resolves on the success result. */
  subscribe(type: string, onEvent: (event: unknown) => void, extra?: Record<string, unknown>): Promise<void>;
  /** Drops this connection (a reconnect follows with backoff). */
  drop(): void;
}

export interface HaClientHandlers {
  /** Authenticated (auth_ok). */
  onConnected(conn: HaConnection): void;
  /** An authenticated connection ended; its subscriptions are gone. Not a statement about HA's data. */
  onDisconnected(): void;
  /** HA answered `auth_invalid` (token rejected). */
  onAuthInvalid(): void;
}

export interface HaClientOptions {
  /** WebSocket URL (haWebSocketUrl). */
  url: string;
  token: string;
  logger: Logger;
  handlers: HaClientHandlers;
  /** Test hooks. */
  timers?: HaTimers;
  random?: () => number;
  /** 0 = no pings (tests). */
  heartbeatMs?: number;
  authTimeoutMs?: number;
}

interface Pending {
  resolve(result: unknown): void;
  reject(err: Error): void;
}

/** One socket's state; replaced on reconnect. */
interface Link {
  ws: WebSocket;
  authed: boolean;
  authSent: boolean;
  nextId: number;
  pending: Map<number, Pending>;
  events: Map<number, (event: unknown) => void>;
  authTimer: unknown;
  heartbeat: unknown;
  awaitingPong: boolean;
  ended: boolean;
}

export class HaClient {
  private readonly timers: HaTimers;
  private readonly random: () => number;
  private link: Link | undefined;
  private retryTimer: unknown;
  /** Reconnect attempts since the last healthy connection (backoff exponent). */
  private failures = 0;
  /** A connection problem was logged since the last healthy connection (log once per outage). */
  private loggedFailure = false;
  /** auth_invalid was logged since the last auth_ok. */
  private loggedAuthInvalid = false;
  private started = false;
  private closed = false;

  constructor(private readonly o: HaClientOptions) {
    this.timers = o.timers ?? defaultTimers;
    this.random = o.random ?? Math.random;
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.connect();
  }

  /** Stops reconnecting and closes the socket (close frame, terminated if it hangs). */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.retryTimer !== undefined) this.timers.clear(this.retryTimer);
    this.retryTimer = undefined;
    const link = this.link;
    if (!link) return;
    const ws = link.ws;
    if (ws.readyState === WebSocket.CLOSED) return this.end(link);
    await new Promise<void>((resolve) => {
      const guard = setTimeout(() => {
        ws.terminate();
        resolve();
      }, 2_000);
      guard.unref?.();
      ws.once("close", () => {
        clearTimeout(guard);
        resolve();
      });
      try {
        if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
        else ws.close(1000);
      } catch {
        ws.terminate();
      }
    });
    this.end(link);
  }

  private connect(): void {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.o.url, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
    } catch (err) {
      this.problem(`cannot open the connection (${errCode(err)})`);
      return this.scheduleReconnect();
    }
    const link: Link = {
      ws,
      authed: false,
      authSent: false,
      nextId: 1,
      pending: new Map(),
      events: new Map(),
      authTimer: undefined,
      heartbeat: undefined,
      awaitingPong: false,
      ended: false,
    };
    this.link = link;
    ws.on("open", () => {
      link.authTimer = this.timers.set(() => {
        link.authTimer = undefined;
        if (!link.authed) {
          this.problem("no authentication answer; reconnecting");
          ws.terminate();
        }
      }, this.o.authTimeoutMs ?? AUTH_TIMEOUT_MS);
      this.startHeartbeat(link);
    });
    ws.on("message", (data, isBinary) => {
      if (isBinary) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      for (const msg of Array.isArray(parsed) ? parsed : [parsed]) this.onMessage(link, msg);
    });
    ws.on("pong", () => {
      link.awaitingPong = false;
    });
    ws.on("error", (err) => {
      // The close event follows; the message is not logged (it can hold the host).
      if (this.closed) return;
      this.problem(`connection error (${errCode(err)})`);
    });
    ws.on("close", (code) => {
      const wasAuthed = link.authed;
      this.end(link);
      if (this.link === link) this.link = undefined;
      if (this.closed) return;
      if (wasAuthed) {
        this.o.logger.info(`[shadow-core] ha client: connection closed (${code}); reconnecting`);
        try {
          this.o.handlers.onDisconnected();
        } catch {
          // a handler bug must not stop reconnecting
        }
      }
      this.scheduleReconnect();
    });
  }

  private onMessage(link: Link, msg: unknown): void {
    if (link.ended || typeof msg !== "object" || msg === null) return;
    const m = msg as Record<string, unknown>;
    const ws = link.ws;
    if (!link.authed) {
      if (m.type === "auth_required" && !link.authSent) {
        link.authSent = true;
        this.send(link, { type: "auth", access_token: this.o.token });
      } else if (m.type === "auth_ok") {
        link.authed = true;
        this.clearAuthTimer(link);
        this.loggedAuthInvalid = false;
        this.o.logger.info("[shadow-core] ha client: connected");
        try {
          this.o.handlers.onConnected(this.connection(link));
        } catch {
          // a handler bug must not break the message loop
        }
      } else if (m.type === "auth_invalid") {
        this.clearAuthTimer(link);
        if (!this.loggedAuthInvalid) {
          this.loggedAuthInvalid = true;
          this.o.logger.warn("[shadow-core] ha client: token rejected (auth_invalid); retried with backoff");
        }
        try {
          this.o.handlers.onAuthInvalid();
        } catch {
          // a handler bug must not stop reconnecting
        }
        ws.close(1000);
      }
      return;
    }
    const id = m.id;
    if (typeof id !== "number") return;
    if (m.type === "result") {
      const p = link.pending.get(id);
      if (!p) return;
      link.pending.delete(id);
      if (m.success === true) {
        // HA answered a command: the connection is healthy, the backoff starts over.
        this.failures = 0;
        this.loggedFailure = false;
        p.resolve(m.result);
      } else {
        link.events.delete(id);
        const e = m.error as Record<string, unknown> | undefined;
        p.reject(new HaCommandError(safeCode(e?.code, "unknown_error")));
      }
    } else if (m.type === "event") {
      const handler = link.events.get(id);
      if (!handler) return;
      try {
        handler(m.event);
      } catch {
        // a handler bug must not drop the connection
      }
    }
  }

  private connection(link: Link): HaConnection {
    const command = (type: string, extra: Record<string, unknown> | undefined, onEvent?: (event: unknown) => void): Promise<unknown> => {
      if (!READ_ONLY_COMMANDS.has(type)) return Promise.reject(new Error(`HA command not allowed: ${type}`));
      if (link.ended || !link.authed) return Promise.reject(new HaClosedError());
      const id = link.nextId++;
      return new Promise((resolve, reject) => {
        link.pending.set(id, { resolve, reject });
        if (onEvent) link.events.set(id, onEvent);
        // id and type last: `extra` cannot replace them.
        if (!this.send(link, { ...extra, id, type })) {
          link.pending.delete(id);
          link.events.delete(id);
          reject(new HaClosedError());
        }
      });
    };
    return {
      command: (type, extra) => command(type, extra),
      subscribe: async (type, onEvent, extra) => {
        await command(type, extra, onEvent);
      },
      drop: () => {
        if (!link.ended) link.ws.terminate();
      },
    };
  }

  private send(link: Link, msg: Record<string, unknown>): boolean {
    if (link.ws.readyState !== WebSocket.OPEN) return false;
    try {
      link.ws.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  private startHeartbeat(link: Link): void {
    const ms = this.o.heartbeatMs ?? HEARTBEAT_MS;
    if (ms <= 0) return;
    const tick = () => {
      link.heartbeat = undefined;
      if (link.ended) return;
      if (link.awaitingPong) {
        this.problem("no answer to ping; reconnecting");
        link.ws.terminate();
        return;
      }
      link.awaitingPong = true;
      try {
        link.ws.ping();
      } catch {
        link.ws.terminate();
        return;
      }
      link.heartbeat = this.timers.set(tick, ms);
    };
    link.heartbeat = this.timers.set(tick, ms);
  }

  private clearAuthTimer(link: Link): void {
    if (link.authTimer !== undefined) this.timers.clear(link.authTimer);
    link.authTimer = undefined;
  }

  /** Ends a link: timers off, pending commands rejected. Idempotent. */
  private end(link: Link): void {
    if (link.ended) return;
    link.ended = true;
    this.clearAuthTimer(link);
    if (link.heartbeat !== undefined) this.timers.clear(link.heartbeat);
    link.heartbeat = undefined;
    const pending = [...link.pending.values()];
    link.pending.clear();
    link.events.clear();
    for (const p of pending) p.reject(new HaClosedError());
  }

  private scheduleReconnect(): void {
    if (this.closed || this.retryTimer !== undefined) return;
    const delay = haBackoffMs(this.failures, this.random);
    this.failures++;
    this.retryTimer = this.timers.set(() => {
      this.retryTimer = undefined;
      this.connect();
    }, delay);
  }

  /** One warning per outage (until the next healthy connection). */
  private problem(what: string): void {
    if (this.loggedFailure) return;
    this.loggedFailure = true;
    this.o.logger.warn(`[shadow-core] ha client: ${what}`);
  }
}

/** A short code safe to log (letters, digits, `_`), or `fallback`. */
function safeCode(code: unknown, fallback: string): string {
  return typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? code : fallback;
}

/** An error's code (e.g. ECONNREFUSED), never its message. */
function errCode(err: unknown): string {
  return safeCode((err as { code?: unknown } | null)?.code, "error");
}
