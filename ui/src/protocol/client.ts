/**
 * Core WebSocket client: connection, `hello` authentication, keepalive and
 * automatic reconnection. It knows nothing about React or the platform; the
 * socket factory and timers are injectable so it can be unit-tested.
 */
import {
  PROTOCOL_VERSION,
  parseServerMessage,
  type ClientKind,
  type ClientMessage,
  type ServerMessage,
} from "./types.ts";

export type ConnectionStatus =
  | "connecting" // socket opening
  | "authenticating" // hello sent, waiting for welcome
  | "connected" // welcome received
  | "reconnecting" // waiting before the next attempt
  | "unauthorized" // token rejected; no automatic retry
  | "incompatible" // Core does not speak this protocol version (close 4400); no automatic retry
  | "closed"; // stopped by the app

export type StatusEvent = {
  status: ConnectionStatus;
  /** Consecutive failed attempts since the last successful welcome. */
  attempt: number;
  /** Set while `reconnecting`: delay before the next attempt. */
  retryInMs?: number;
};

/** The subset of the browser WebSocket the client relies on. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
};

export type CoreClientOptions = {
  url: string;
  token: string;
  client: ClientKind;
  clientVersion: string;
  onMessage: (msg: ServerMessage) => void;
  onStatus: (ev: StatusEvent) => void;
  createSocket?: (url: string) => SocketLike;
  timers?: Timers;
  random?: () => number;
};

/** WebSocket.OPEN — not read from the global so tests need no DOM. */
const OPEN = 1;
/** Close code the Core uses for a missing/invalid hello (§5). */
export const CLOSE_UNAUTHORIZED = 4401;
/** Close code the Core uses for an unsupported `hello.protocol`. */
export const CLOSE_PROTOCOL = 4400;
/** Close code this client uses when the Core stops answering pings. */
const CLOSE_STALE = 4000;

export const WELCOME_TIMEOUT_MS = 10_000;
export const PING_INTERVAL_MS = 20_000;
export const PONG_TIMEOUT_MS = 10_000;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

/** Exponential backoff with jitter in [50 %, 100 %] of the step. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const step = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(step * (0.5 + random() * 0.5));
}

const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (h) => globalThis.clearInterval(h as ReturnType<typeof setInterval>),
};

export class CoreClient {
  private readonly opts: CoreClientOptions;
  private readonly timers: Timers;
  private readonly random: () => number;
  private socket: SocketLike | null = null;
  private status: ConnectionStatus = "closed";
  private attempt = 0;
  private stopped = true;
  private retryTimer: unknown = null;
  private welcomeTimer: unknown = null;
  private pingTimer: unknown = null;
  private pongTimer: unknown = null;

  constructor(opts: CoreClientOptions) {
    this.opts = opts;
    this.timers = opts.timers ?? defaultTimers;
    this.random = opts.random ?? Math.random;
  }

  get currentStatus(): ConnectionStatus {
    return this.status;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.open();
  }

  /** Stops for good (until `start`); no reconnection. */
  stop(): void {
    this.stopped = true;
    this.clearAllTimers();
    const s = this.socket;
    this.socket = null;
    if (s) {
      this.detach(s);
      s.close(1000, "client stop");
    }
    this.setStatus("closed");
  }

  /** Skips the remaining backoff delay (e.g. the app came back to the foreground). */
  reconnectNow(): void {
    if (this.stopped || this.status !== "reconnecting") return;
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.open();
  }

  /** Sends when authenticated. Returns false (and drops the message) otherwise. */
  send(msg: Exclude<ClientMessage, { type: "hello" }>): boolean {
    if (this.status !== "connected" || !this.socket || this.socket.readyState !== OPEN) return false;
    this.socket.send(JSON.stringify(msg));
    return true;
  }

  // -------------------------------------------------------------------------

  private open(): void {
    this.setStatus("connecting");
    let socket: SocketLike;
    try {
      socket = (this.opts.createSocket ?? defaultSocket)(this.opts.url);
    } catch {
      // Invalid URL or blocked scheme: treat like a failed attempt.
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (socket !== this.socket) return;
      socket.send(
        JSON.stringify({
          type: "hello",
          protocol: PROTOCOL_VERSION,
          token: this.opts.token,
          client: this.opts.client,
          clientVersion: this.opts.clientVersion,
        } satisfies ClientMessage),
      );
      this.setStatus("authenticating");
      this.welcomeTimer = this.timers.setTimeout(() => {
        if (socket === this.socket) socket.close(CLOSE_STALE, "no welcome");
      }, WELCOME_TIMEOUT_MS);
    };
    socket.onmessage = (ev) => {
      if (socket !== this.socket || typeof ev.data !== "string") return;
      const msg = parseServerMessage(ev.data);
      if (msg) this.handle(msg);
    };
    socket.onerror = () => {
      // A close event always follows; reconnection is handled there.
    };
    socket.onclose = (ev) => {
      if (socket !== this.socket) return;
      this.socket = null;
      this.clearAllTimers();
      if (this.stopped) {
        this.setStatus("closed");
      } else if (ev.code === CLOSE_UNAUTHORIZED || this.status === "unauthorized") {
        this.stopped = true;
        this.setStatus("unauthorized");
      } else if (ev.code === CLOSE_PROTOCOL) {
        // Retrying cannot help until one side is updated.
        this.stopped = true;
        this.setStatus("incompatible");
      } else {
        this.scheduleReconnect();
      }
    };
  }

  private handle(msg: ServerMessage): void {
    if (msg.type === "welcome") {
      this.timers.clearTimeout(this.welcomeTimer);
      this.welcomeTimer = null;
      this.attempt = 0;
      this.setStatus("connected");
      this.startKeepalive();
    } else if (msg.type === "error" && msg.code === "unauthorized") {
      // The Core closes with 4401 right after; remember why.
      this.setStatus("unauthorized");
    } else if (msg.type === "pong") {
      this.timers.clearTimeout(this.pongTimer);
      this.pongTimer = null;
      return;
    }
    this.opts.onMessage(msg);
  }

  private startKeepalive(): void {
    this.pingTimer = this.timers.setInterval(() => {
      const s = this.socket;
      if (!s || s.readyState !== OPEN) return;
      s.send(JSON.stringify({ type: "ping" } satisfies ClientMessage));
      if (this.pongTimer === null) {
        this.pongTimer = this.timers.setTimeout(() => {
          this.pongTimer = null;
          if (s === this.socket) s.close(CLOSE_STALE, "no pong");
        }, PONG_TIMEOUT_MS);
      }
    }, PING_INTERVAL_MS);
  }

  private scheduleReconnect(): void {
    this.attempt += 1;
    const delay = backoffDelay(this.attempt, this.random);
    this.setStatus("reconnecting", delay);
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.open();
    }, delay);
  }

  private clearAllTimers(): void {
    for (const t of [this.retryTimer, this.welcomeTimer, this.pongTimer]) {
      if (t !== null) this.timers.clearTimeout(t);
    }
    if (this.pingTimer !== null) this.timers.clearInterval(this.pingTimer);
    this.retryTimer = this.welcomeTimer = this.pingTimer = this.pongTimer = null;
  }

  private detach(s: SocketLike): void {
    s.onopen = s.onmessage = s.onerror = null;
    s.onclose = null;
  }

  private setStatus(status: ConnectionStatus, retryInMs?: number): void {
    this.status = status;
    this.opts.onStatus({ status, attempt: this.attempt, retryInMs });
  }
}

function defaultSocket(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

/**
 * Normalises what the user typed into a Core WebSocket URL, or returns null.
 * Accepts ws/wss and (for convenience) http/https, and appends `/ws` when no
 * path is given: "localhost:8700" -> "ws://localhost:8700/ws".
 */
export function normalizeCoreUrl(input: string): string | null {
  let text = input.trim();
  if (!text) return null;
  if (!/^[a-z]+:\/\//i.test(text)) text = `ws://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const scheme = url.protocol.toLowerCase();
  if (scheme === "http:") url.protocol = "ws:";
  else if (scheme === "https:") url.protocol = "wss:";
  else if (scheme !== "ws:" && scheme !== "wss:") return null;
  if (!url.hostname || url.username || url.password) return null;
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/ws";
  url.hash = "";
  return url.toString();
}
