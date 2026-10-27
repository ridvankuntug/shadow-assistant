/**
 * HTTP + WebSocket server: `GET /health` and the `/ws` endpoint.
 *
 * Authentication: the first frame must be `hello` with a valid device token
 * within HELLO_TIMEOUT_MS; otherwise `{"type":"error","code":"unauthorized"}`
 * is sent and the socket is closed with 4401. With no device tokens configured
 * every connection is refused.
 */
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { authenticate, type DeviceTokens } from "./auth.js";
import {
  CLOSE_PROTOCOL_ERROR,
  CLOSE_UNAUTHORIZED,
  MAX_FRAME_BYTES,
  PROTOCOL_VERSION,
  parseClientFrame,
  type ServerFrame,
} from "./protocol.js";
import type { Logger, Session, SessionInfo } from "./session.js";

export const HELLO_TIMEOUT_MS = 5_000;
export const CORE_VERSION = "0.1.0";

export interface CoreServerOptions {
  tokens: DeviceTokens;
  createSession: (info: SessionInfo, send: (frame: ServerFrame) => void) => Session;
  logger: Logger;
  helloTimeoutMs?: number;
  /** Extra fields for GET /health (e.g. which services are enabled). */
  health?: () => Record<string, unknown>;
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

export function createCoreServer(opts: CoreServerOptions): CoreServer {
  const http = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "core", version: CORE_VERSION, ...(opts.health?.() ?? {}) }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  /** Open sessions; close() waits for their records to be flushed. */
  const sessions = new Set<Session>();
  /** Set by close(): no new upgrades or sessions are accepted from then on. */
  let shuttingDown = false;

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
        send({ type: "welcome", protocol: PROTOCOL_VERSION, sessionId, device });
        send({ type: "state", state: "idle" });
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
      for (const client of wss.clients) client.close(1001, "server shutting down");
      await Promise.all([...sessions].map((s) => s.close("server_shutdown").catch(() => {})));
      // Peers that never answered the close handshake would keep http.close() waiting.
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
