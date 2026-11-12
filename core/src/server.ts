/**
 * HTTP + WebSocket server: `GET /health`, `POST /device/state` (T11, see
 * `handleDeviceState`) and the `/ws` endpoint.
 *
 * `GET /health` has no auth; its `inbox` counts (T7.w.4, for the tray) are
 * added only for requests from a loopback address.
 *
 * Authentication: the first frame must be `hello` with a valid device token
 * within HELLO_TIMEOUT_MS; otherwise `{"type":"error","code":"unauthorized"}`
 * is sent and the socket is closed with 4401. With no device tokens configured
 * every connection is refused.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { authenticate, type DeviceTokens } from "./auth.js";
import {
  MAX_DEVICE_STATE_BYTES,
  parseDeviceStateBody,
  type CaseBatteryReading,
} from "./device-state.js";
import {
  CLOSE_PROTOCOL_ERROR,
  CLOSE_UNAUTHORIZED,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  parseClientFrame,
  type ProtocolFeature,
  type ServerFrame,
  type ServiceHealth,
} from "./protocol.js";
import type { Logger, Session, SessionInfo } from "./session.js";

export const HELLO_TIMEOUT_MS = 5_000;
export const CORE_VERSION = "0.1.0";

export interface CoreServerOptions {
  tokens: DeviceTokens;
  createSession: (info: SessionInfo, send: (frame: ServerFrame) => void) => Session;
  logger: Logger;
  helloTimeoutMs?: number;
  /** Optional capabilities advertised in `welcome.features`; absent = the field is left out. */
  features?: readonly ProtocolFeature[];
  /** Extra fields for GET /health (e.g. which services are enabled). */
  health?: () => Record<string, unknown>;
  /**
   * Counts for GET /health `inbox` (e.g. `{ dev: 3, notifications: 1, notificationsUnavailable: false }`),
   * sent **only** to loopback requests (the tray on the same machine): numbers and flags, no titles.
   * Remote callers get the body without `inbox`.
   */
  inbox?: () => Record<string, number | boolean>;
  /** Development badge count (T7.w.4): every change goes to every authenticated socket as `dev_count`. */
  devCount?: DevCountSource;
  /**
   * Service health source (HealthMonitor). Authenticated clients get the
   * current list right after `welcome` + `state` and every change as a
   * `services` frame.
   */
  serviceHealth?: ServiceHealthSource;
  /** Store of `POST /device/state` readings; absent = the route answers 404 like any unknown path. */
  deviceState?: DeviceStateSink;
  /** Body timeout of `POST /device/state`; default DEVICE_STATE_BODY_TIMEOUT_MS. */
  deviceStateBodyTimeoutMs?: number;
  /** Clock for the reading time checks of `POST /device/state`. */
  now?: () => number;
}

export interface DeviceStateSink {
  recordCaseBattery(device: string, reading: CaseBatteryReading): Promise<{ stored: boolean }>;
}

export const DEVICE_STATE_PATH = "/device/state";

export interface DevCountSource {
  subscribe(listener: (open: number) => void): () => void;
}

/**
 * Whether a socket's peer address is the local machine: `127.0.0.1`, `::1`
 * or the IPv4-mapped `::ffff:127.0.0.1` (a server bound to `::`). Nothing
 * else counts (no `X-Forwarded-For`, no other 127.x address).
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export interface ServiceHealthSource {
  snapshot(): ServiceHealth[] | undefined;
  subscribe(listener: (items: ServiceHealth[]) => void): () => void;
}

export interface CoreServer {
  http: Server;
  wss: WebSocketServer;
  listen(port: number, host: string): Promise<{ port: number }>;
  close(): Promise<void>;
}

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Error answer sent before the request body was (fully) read: the connection
 * is closed after the response instead of draining an unread, possibly large
 * body to keep it alive.
 */
function refuse(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendJson(res, status, body, { Connection: "close", ...headers });
}

/** The bearer token of the `Authorization` header, or undefined. The query string is never looked at. */
export function bearerToken(header: string | undefined): string | undefined {
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header ?? "");
  return m ? m[1] : undefined;
}

/** `application/json`, with or without parameters (`; charset=utf-8`). */
function isJsonContentType(header: string | undefined): boolean {
  return ((header ?? "").split(";")[0] ?? "").trim().toLowerCase() === "application/json";
}

/** Longest time the body of a `POST /device/state` may take to arrive. */
export const DEVICE_STATE_BODY_TIMEOUT_MS = 10_000;

type BodyRead = { ok: true; body: Buffer } | { ok: false; reason: "too_large" | "aborted" };

/**
 * Reads at most `limit` bytes of the body. Stops reading as soon as the body
 * turns out to be larger (`too_large`); a stream error, a connection closed
 * before the end or a body slower than `timeoutMs` is `aborted`.
 */
function readBodyLimited(req: IncomingMessage, limit: number, timeoutMs: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const timer = setTimeout(() => finish({ ok: false, reason: "aborted" }), timeoutMs);
    const finish = (v: BodyRead) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onAbort);
      req.off("close", onAbort);
      if (!v.ok) req.pause();
      resolve(v);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) finish({ ok: false, reason: "too_large" });
      else chunks.push(chunk);
    };
    const onEnd = () => finish({ ok: true, body: Buffer.concat(chunks) });
    const onAbort = () => finish({ ok: false, reason: "aborted" });
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onAbort);
    req.on("close", onAbort);
  });
}

export function createCoreServer(opts: CoreServerOptions): CoreServer {
  const now = opts.now ?? Date.now;

  /** The device of a valid `Authorization: Bearer` header, or null. */
  const deviceOf = (req: IncomingMessage): string | null => {
    const token = bearerToken(req.headers.authorization);
    return token !== undefined && opts.tokens.digests.size > 0 ? authenticate(opts.tokens, token) : null;
  };

  /**
   * `POST /device/state` (docs/02-core-protocol.md, "Device state"). Order:
   * method (405) → bearer token from the header, before any body byte is
   * read (401) → content type (415) → size, declared or counted (413) → JSON
   * and fields (400) → store → 204. The device name comes from the token,
   * never from the body; the token is never logged.
   */
  async function handleDeviceState(req: IncomingMessage, res: ServerResponse, sink: DeviceStateSink): Promise<void> {
    if (req.method !== "POST") {
      refuse(res, 405, { error: "method_not_allowed" }, { Allow: "POST" });
      return;
    }
    const device = deviceOf(req);
    if (!device) {
      opts.logger.warn("[shadow-core] rejected device state: invalid device token");
      refuse(res, 401, { error: "unauthorized" });
      return;
    }
    if (!isJsonContentType(req.headers["content-type"])) {
      refuse(res, 415, { error: "unsupported_media_type" });
      return;
    }
    const declared = req.headers["content-length"];
    if (declared !== undefined && Number(declared) > MAX_DEVICE_STATE_BYTES) {
      refuse(res, 413, { error: "payload_too_large" });
      return;
    }
    const read = await readBodyLimited(req, MAX_DEVICE_STATE_BYTES, opts.deviceStateBodyTimeoutMs ?? DEVICE_STATE_BODY_TIMEOUT_MS);
    if (!read.ok) {
      if (read.reason === "too_large") refuse(res, 413, { error: "payload_too_large" });
      // Client gone, broken or too slow: no answer, drop the connection.
      else req.socket.destroy();
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(read.body.toString("utf8"));
    } catch {
      sendJson(res, 400, { error: "bad_request", message: "body is not valid JSON" });
      return;
    }
    const parsed = parseDeviceStateBody(body, now());
    if (!parsed.ok) {
      sendJson(res, 400, { error: "bad_request", message: parsed.message });
      return;
    }
    try {
      const r = await sink.recordCaseBattery(device, parsed.caseBattery);
      opts.logger.info(
        `[shadow-core] device '${device}' case battery ${r.stored ? "stored" : "ignored (older than the stored reading)"}`,
      );
    } catch (err) {
      opts.logger.warn(`[shadow-core] device '${device}' state not stored: ${(err as Error)?.name ?? "error"}`);
      sendJson(res, 500, { error: "internal" });
      return;
    }
    res.writeHead(204);
    res.end();
  }

  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];
    if (path === DEVICE_STATE_PATH && opts.deviceState) {
      const sink = opts.deviceState;
      handleDeviceState(req, res, sink).catch(() => {
        if (!res.headersSent) refuse(res, 500, { error: "internal" });
        else res.destroy();
      });
      return;
    }
    if (req.method === "GET" && path === "/health") {
      const inbox = opts.inbox && isLoopbackAddress(req.socket.remoteAddress) ? { inbox: opts.inbox() } : {};
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "core", version: CORE_VERSION, ...(opts.health?.() ?? {}), ...inbox }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  };
  const http = createServer(onRequest);
  // `Expect: 100-continue`: Node would ask for the body at once; for the
  // device-state path the token is checked first, so an unauthenticated
  // client is answered 401 without being invited to send its body.
  http.on("checkContinue", (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0];
    const refuseFirst = path === DEVICE_STATE_PATH && opts.deviceState !== undefined && (req.method !== "POST" || !deviceOf(req));
    if (!refuseFirst) res.writeContinue();
    onRequest(req, res);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  /** Open sessions; close() waits for their records to be flushed. */
  const sessions = new Set<Session>();
  /** Set by close(): no new upgrades or sessions are accepted from then on. */
  let shuttingDown = false;
  /** Senders of authenticated sockets (service health broadcasts). */
  const authed = new Set<(frame: ServerFrame) => void>();
  const unsubscribeHealth = opts.serviceHealth?.subscribe((items) => {
    for (const send of authed) send({ type: "services", items });
  });
  // Clients that do not know `dev_count` ignore it (docs/02 §Development).
  const unsubscribeDev = opts.devCount?.subscribe((open) => {
    for (const send of authed) send({ type: "dev_count", open });
  });

  http.on("upgrade", (req: IncomingMessage, socket, head) => {
    const path = (req.url ?? "/").split("?")[0];
    if (shuttingDown) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (path !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    const send = (frame: ServerFrame) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    };
    const reject = (code: number, frame: ServerFrame) => {
      send(frame);
      ws.close(code, frame.type === "error" ? frame.code : "closing");
    };

    let session: Session | null = null;
    const helloTimer = setTimeout(
      () => reject(CLOSE_UNAUTHORIZED, { type: "error", code: "unauthorized", message: "hello timeout" }),
      opts.helloTimeoutMs ?? HELLO_TIMEOUT_MS,
    );

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        if (!session) {
          clearTimeout(helloTimer);
          reject(CLOSE_UNAUTHORIZED, { type: "error", code: "unauthorized", message: "hello required" });
        } else send({ type: "error", code: "bad_request", message: "binary frames are not supported" });
        return;
      }
      const parsed = parseClientFrame(rawToString(data));

      if (!session) {
        clearTimeout(helloTimer);
        if (!parsed.ok || parsed.frame.type !== "hello") {
          reject(CLOSE_UNAUTHORIZED, { type: "error", code: "unauthorized", message: "hello required" });
          return;
        }
        if (shuttingDown) {
          // Upgraded before close() began; refuse instead of opening a session close() won't wait for.
          reject(1001, { type: "error", code: "internal", message: "server shutting down" });
          return;
        }
        const hello = parsed.frame;
        const device = opts.tokens.digests.size > 0 ? authenticate(opts.tokens, hello.token) : null;
        if (!device) {
          opts.logger.warn("[shadow-core] rejected connection: invalid device token");
          reject(CLOSE_UNAUTHORIZED, { type: "error", code: "unauthorized", message: "invalid token" });
          return;
        }
        if (hello.protocol !== PROTOCOL_VERSION) {
          reject(CLOSE_PROTOCOL_ERROR, {
            type: "error",
            code: "bad_request",
            message: `unsupported protocol ${hello.protocol}; server speaks ${PROTOCOL_VERSION}`,
          });
          return;
        }
        const sessionId = randomUUID();
        session = opts.createSession(
          { sessionId, device, client: hello.client, clientVersion: hello.clientVersion },
          send,
        );
        sessions.add(session);
        opts.logger.info(`[shadow-core] device '${device}' connected (session ${sessionId})`);
        send({
          type: "welcome",
          protocol: PROTOCOL_VERSION,
          sessionId,
          device,
          ...(opts.features && opts.features.length > 0 ? { features: [...opts.features] } : {}),
        });
        send({ type: "state", state: "idle" });
        const items = opts.serviceHealth?.snapshot();
        if (items) send({ type: "services", items });
        authed.add(send);
        return;
      }

      if (!parsed.ok) {
        send(
          parsed.id === undefined
            ? { type: "error", code: "bad_request", message: parsed.message }
            : { type: "error", id: parsed.id, code: "bad_request", message: parsed.message },
        );
        return;
      }
      // Not awaited: a confirm_response must be handled while a turn is running.
      const current = session;
      current.handle(parsed.frame).catch((err: Error) => {
        opts.logger.warn(`[shadow-core] frame handling failed: ${err.message}`);
        send({ type: "error", code: "internal", message: "internal error" });
      });
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      authed.delete(send);
      if (session) {
        const s = session;
        opts.logger.info(`[shadow-core] device '${s.info.device}' disconnected`);
        void s.close("socket_closed").finally(() => sessions.delete(s));
      }
    });
    ws.on("error", (err) => opts.logger.warn(`[shadow-core] socket error: ${err.message}`));
  });

  return {
    http,
    wss,
    listen(port, host) {
      return new Promise((resolve, reject) => {
        http.once("error", reject);
        http.listen(port, host, () => {
          http.off("error", reject);
          const addr = http.address();
          resolve({ port: typeof addr === "object" && addr ? addr.port : port });
        });
      });
    },
    async close() {
      shuttingDown = true;
      unsubscribeHealth?.();
      unsubscribeDev?.();
      authed.clear();
      for (const client of wss.clients) client.close(1001, "server shutting down");
      await Promise.all([...sessions].map((s) => s.close("server_shutdown").catch(() => {})));
      // Peers that never answered the close handshake would keep http.close() waiting.
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
