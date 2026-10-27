import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { authenticate, loadDeviceTokens } from "../src/auth.js";
import { createCoreServer, type CoreServer } from "../src/server.js";
import type { Session } from "../src/session.js";
import type { ServerFrame } from "../src/protocol.js";

const TOKEN = "browser-token-0123456789abcdef";
const quiet = { info: () => {}, warn: () => {} };

test("loadDeviceTokens ignores empty and short values", () => {
  const t = loadDeviceTokens({
    DEVICE_TOKEN_BROWSER: TOKEN,
    DEVICE_TOKEN_ANDROID: "",
    DEVICE_TOKEN_SHORT: "abc",
    DEVICE_TOKEN_: "x".repeat(20),
    OTHER: "x".repeat(20),
  });
  assert.deepEqual([...t.digests.keys()], ["browser"]);
  assert.deepEqual(t.rejected, ["DEVICE_TOKEN_SHORT"]);
});

test("authenticate matches the right device and rejects others", () => {
  const t = loadDeviceTokens({ DEVICE_TOKEN_BROWSER: TOKEN, DEVICE_TOKEN_ANDROID: "android-token-0123456789" });
  assert.equal(authenticate(t, TOKEN), "browser");
  assert.equal(authenticate(t, "android-token-0123456789"), "android");
  assert.equal(authenticate(t, `${TOKEN}x`), null);
  assert.equal(authenticate(t, TOKEN.slice(0, -1)), null);
  assert.equal(authenticate(t, ""), null);
  assert.equal(authenticate(t, 42), null);
  assert.equal(authenticate(loadDeviceTokens({}), TOKEN), null);
});

interface Conn {
  frames: ServerFrame[];
  closed: Promise<number>;
  ws: WebSocket;
  next(type: string): Promise<ServerFrame>;
}

function connect(port: number, path = "/ws"): Promise<Conn> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    const frames: ServerFrame[] = [];
    const waiters: Array<() => void> = [];
    ws.on("message", (d) => {
      frames.push(JSON.parse(d.toString()) as ServerFrame);
      waiters.splice(0).forEach((w) => w());
    });
    const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
    const next = (type: string) =>
      new Promise<ServerFrame>((res, rej) => {
        const check = () => {
          const f = frames.find((x) => x.type === type);
          if (f) res(f);
          else waiters.push(check);
        };
        setTimeout(() => rej(new Error(`timeout waiting for ${type}`)), 2000).unref();
        check();
      });
    ws.on("open", () => resolve({ frames, closed, ws, next }));
    ws.on("error", reject);
  });
}

let server: CoreServer;
let port: number;
const created: string[] = [];

before(async () => {
  server = createCoreServer({
    tokens: loadDeviceTokens({ DEVICE_TOKEN_BROWSER: TOKEN }),
    logger: quiet,
    helloTimeoutMs: 150,
    createSession: (info, send) => {
      created.push(info.device);
      return {
        info,
        handle: async (f: { type: string }) => {
          if (f.type === "ping") send({ type: "pong" });
        },
        close: async () => {},
      } as unknown as Session;
    },
  });
  ({ port } = await server.listen(0, "127.0.0.1"));
});
after(() => server.close());

test("hello with valid token gets welcome + idle state", async () => {
  const c = await connect(port);
  c.ws.send(JSON.stringify({ type: "hello", protocol: 1, token: TOKEN, client: "web" }));
  const w = await c.next("welcome");
  assert.equal(w.type === "welcome" && w.device, "browser");
  assert.equal(w.type === "welcome" && w.protocol, 1);
  await c.next("state");
  c.ws.send(JSON.stringify({ type: "ping" }));
  await c.next("pong");
  c.ws.send("garbage");
  const e = await c.next("error");
  assert.equal(e.type === "error" && e.code, "bad_request");
  c.ws.close();
  assert.ok(created.includes("browser"));
});

test("wrong token → unauthorized + 4401", async () => {
  const c = await connect(port);
  c.ws.send(JSON.stringify({ type: "hello", protocol: 1, token: "wrong-token-wrong-token" }));
  const e = await c.next("error");
  assert.equal(e.type === "error" && e.code, "unauthorized");
  assert.equal(await c.closed, 4401);
});

test("first frame not hello → 4401", async () => {
  const c = await connect(port);
  c.ws.send(JSON.stringify({ type: "user_text", id: "t1", text: "hi" }));
  assert.equal(await c.closed, 4401);
});

test("no hello within the timeout → 4401", async () => {
  const c = await connect(port);
  assert.equal(await c.closed, 4401);
  assert.equal(c.frames[0]?.type, "error");
});

test("unsupported protocol version is refused", async () => {
  const c = await connect(port);
  c.ws.send(JSON.stringify({ type: "hello", protocol: 2, token: TOKEN }));
  assert.equal(await c.closed, 4400);
});

test("other paths do not upgrade", async () => {
  await assert.rejects(connect(port, "/other"));
});

test("GET /health", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; service: string };
  assert.equal(body.status, "ok");
  assert.equal(body.service, "core");
});

test("server without tokens rejects every connection", async () => {
  const s = createCoreServer({
    tokens: loadDeviceTokens({}),
    logger: quiet,
    createSession: () => {
      throw new Error("must not be called");
    },
  });
  const { port: p } = await s.listen(0, "127.0.0.1");
  try {
    const c = await connect(p);
    c.ws.send(JSON.stringify({ type: "hello", protocol: 1, token: "" }));
    assert.equal(await c.closed, 4401);
  } finally {
    await s.close();
  }
});

test("close(): refuses new hellos/upgrades, terminates stragglers, does not hang", async () => {
  const s = createCoreServer({
    tokens: loadDeviceTokens({ DEVICE_TOKEN_BROWSER: TOKEN }),
    logger: quiet,
    helloTimeoutMs: 60_000,
    createSession: () => {
      throw new Error("must not be called during shutdown");
    },
  });
  const { port: p } = await s.listen(0, "127.0.0.1");
  // Upgraded but not yet authenticated when shutdown begins.
  const pending = await connect(p);
  const closing = s.close();
  pending.ws.send(JSON.stringify({ type: "hello", protocol: 1, token: TOKEN }));
  // New upgrades are refused while shutting down (or the port is already closed).
  await assert.rejects(connect(p));
  const code = await pending.closed;
  assert.ok(code === 1001 || code === 1006, `unexpected close code ${code}`);
  assert.equal(pending.frames.some((f) => f.type === "welcome"), false);
  await Promise.race([
    closing,
    new Promise((_, rej) => setTimeout(() => rej(new Error("close() hung")), 3000).unref()),
  ]);
});
