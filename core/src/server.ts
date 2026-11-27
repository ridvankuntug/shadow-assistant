/**
 * HTTP + WebSocket server: `GET /health`, `POST /device/state` (T11, see
 * `handleDeviceState`) and the `/ws` endpoint.
 *
 * Listeners (docs/13 §4.2, T11.6): `listen` binds the first plain listener
 * (`http`), `listenPlain` further plain addresses with the same routes, and
 * `listenTls` the optional TLS listener: `/ws`, `GET /health` and the UI's
 * static files only (no `/device/state`, never `/agent`), with the Origin
 * rule on `/ws` (`originAllowed`). Every listener shares the same sessions,
 * auth and shutdown.
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
import { createServer as createHttpsServer } from "node:https";
import type { Duplex } from "node:stream";
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
import { originAllowed, tlsOrigin, TLS_MIN_VERSION } from "./listeners.js";
import type { Logger, Session, SessionInfo } from "./session.js";
import { createStaticHandler } from "./static-files.js";
import { readCoreVersion } from "./version.js";

export const HELLO_TIMEOUT_MS = 5_000;

export interface CoreServerOptions {
  tokens: DeviceTokens;
  createSession: (info: SessionInfo, send: (frame: ServerFrame) => void) => Session;
  logger: Logger;
  helloTimeoutMs?: number;
  /** Optional capabilities advertised in `welcome.features`; absent = the field is left out. */
  features?: readonly ProtocolFeature[];
  /**
   * Version for GET /health. Default: `readCoreVersion` over `process.env` (env `CORE_VERSION`,
   * else the repo-root VERSION file, else a dev value), resolved when the server is created,
   * i.e. after `loadDotEnv()` in `main()`, so a `.env` override counts.
   */
  version?: string;
  /** Extra fields for GET /health (e.g. which services are enabled). */
  health?: () => Record<string, unknown>;
  /**
   * Counts for GET /health `inbox` (e.g. `{ dev: 3, notifications: 1, notificationsUnavailable: false, pc: 2 }`),
   * sent **only** to loopback requests (the tray on the same machine): numbers and flags, no titles.
   * Remote callers get the body without `inbox`.
   */
  inbox?: () => Record<string, number | boolean>;
  /** Development badge count (T7.w.4): every change goes to every authenticated socket as `dev_count`. */
  devCount?: DevCountSource;
  /** PC permission badge count (T17.2): every change goes to every authenticated socket as `pc_permissions_count`. */
  pcPermissionsCount?: DevCountSource;
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

export interface TlsListenOptions {
  host: string;
  port: number;
  /** PEM certificate (chain) and private key; the key is kept in memory only. */
  cert: Buffer;
  key: Buffer;
  /** Folder of the built UI served as static files. */
  uiDir: string;
}

export interface CoreServer {
  /** The first plain listener (`listen`). */
  http: Server;
  wss: WebSocketServer;
  /** Binds the first plain listener. */
  listen(port: number, host: string): Promise<{ port: number }>;
  /** Binds one more plain listener with the same routes (e.g. 127.0.0.1 next to the LAN address). */
  listenPlain(port: number, host: string): Promise<{ port: number }>;
  /** Binds the TLS listener (UI files, `/ws` with the Origin rule, `/health`). */
  listenTls(opts: TlsListenOptions): Promise<{ port: number; origin: string }>;
  close(): Promise<void>;
}

/** Upgrade paths per listener kind. `/agent` (T13) is added to PLAIN_UPGRADE_PATHS only (docs/13 §4.1: never on TLS). */
export const PLAIN_UPGRADE_PATHS: ReadonlySet<string> = new Set(["/ws"]);
export const TLS_UPGRADE_PATHS: ReadonlySet<string> = new Set(["/ws"]);

function listenOn(server: Server, port: number, host: string): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      const addr = server.address();
      resolve({ port: typeof addr === "object" && addr ? addr.port : port });
    });
  });
}

/**
 * Answers a refused upgrade and closes the socket once the answer is out (a
 * TLS socket destroyed right after write() would drop the pending record).
 */
function refuseUpgrade(socket: Duplex, status: string): void {
  // Upgrade sockets have no error listener of Node's or ws's here: a peer reset during the
  // answer must not become an unhandled 'error' (process crash).
  socket.on("error", () => socket.destroy());
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
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
  const version = opts.version ?? readCoreVersion({ env: process.env });

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

  /** `GET /health`; true when it answered. */
  const serveHealth = (req: IncomingMessage, res: ServerResponse, path: string | undefined): boolean => {
    if (req.method !== "GET" || path !== "/health") return false;
    const inbox = opts.inbox && isLoopbackAddress(req.socket.remoteAddress) ? { inbox: opts.inbox() } : {};
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "core", version, ...(opts.health?.() ?? {}), ...inbox }));
    return true;
  };

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
    if (serveHealth(req, res, path)) return;
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  };
  /** Every listener, for close(). */
  const servers: Server[] = [];
  const createPlain = (): Server => {
    const server = createServer(onRequest);
    // `Expect: 100-continue`: Node would ask for the body at once; for the
    // device-state path the token is checked first, so an unauthenticated
    // client is answered 401 without being invited to send its body.
    server.on("checkContinue", (req: IncomingMessage, res: ServerResponse) => {
      const path = (req.url ?? "/").split("?")[0];
      const refuseFirst = path === DEVICE_STATE_PATH && opts.deviceState !== undefined && (req.method !== "POST" || !deviceOf(req));
      if (!refuseFirst) res.writeContinue();
      onRequest(req, res);
    });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => onUpgrade(req, socket, head, PLAIN_UPGRADE_PATHS));
    servers.push(server);
    return server;
  };

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
  // Same for the PC permission badge (docs/02 §PC permissions); no sound, no notification.
  const unsubscribePc = opts.pcPermissionsCount?.subscribe((unseen) => {
    for (const send of authed) send({ type: "pc_permissions_count", unseen });
  });

  /**
   * WebSocket upgrade on any listener: only the listener's own paths; with
   * `origin` (the TLS listener) the Origin rule is checked before the
   * handshake (403), so a foreign page never reaches the hello frame.
   */
  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer, paths: ReadonlySet<string>, origin?: string) => {
    const path = (req.url ?? "/").split("?")[0] ?? "";
    if (shuttingDown) {
      refuseUpgrade(socket, "503 Service Unavailable");
      return;
    }
    if (!paths.has(path)) {
      refuseUpgrade(socket, "404 Not Found");
      return;
    }
    if (origin !== undefined && !originAllowed(req.headers.origin, origin)) {
      // The value itself is not logged: it is client-controlled.
      opts.logger.warn("[shadow-core] refused /ws on the TLS listener: Origin is not the listener's own");
      refuseUpgrade(socket, "403 Forbidden");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  };

  const http = createPlain();

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
      return listenOn(http, port, host);
    },
    listenPlain(port, host) {
      return listenOn(createPlain(), port, host);
    },
    async listenTls(t) {
      const files = createStaticHandler(t.uiDir);
      /** Set once bound (the port may be 0 in tests); no upgrade is accepted before. */
      const bound: { origin?: string } = {};
      const server = createHttpsServer({ cert: t.cert, key: t.key, minVersion: TLS_MIN_VERSION }, (req, res) => {
        const path = (req.url ?? "/").split("?")[0];
        if (serveHealth(req, res, path)) return;
        files(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500).end();
          else res.destroy();
        });
      });
      server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        if (bound.origin === undefined) refuseUpgrade(socket, "503 Service Unavailable");
        else onUpgrade(req, socket, head, TLS_UPGRADE_PATHS, bound.origin);
      });
      servers.push(server);
      const { port } = await listenOn(server, t.port, t.host);
      bound.origin = tlsOrigin(t.host, port);
      return { port, origin: bound.origin };
    },
    async close() {
      shuttingDown = true;
      unsubscribeHealth?.();
      unsubscribeDev?.();
      unsubscribePc?.();
      authed.clear();
      for (const client of wss.clients) client.close(1001, "server shutting down");
      await Promise.all([...sessions].map((s) => s.close("server_shutdown").catch(() => {})));
      // Peers that never answered the close handshake would keep http.close() waiting.
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      // A listener that never bound (listen failed or was not called) has nothing to close.
      await Promise.all(servers.map((s) => (s.listening ? new Promise<void>((resolve) => s.close(() => resolve())) : undefined)));
    },
  };
}
