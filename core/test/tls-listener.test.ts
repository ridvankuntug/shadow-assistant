/**
 * The TLS listener (docs/13 §4.1, T11.6): UI files, /ws with the Origin rule,
 * /health; never /device/state or /agent; shared sessions and shutdown with
 * the plain listeners. The certificate is a throwaway one built at test time
 * (test-cert.ts). Clients do not verify it (rejectUnauthorized: false): TLS
 * inspection by a local antivirus can re-sign loopback connections, and what
 * is tested here is the routing, not the trust chain.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { connect as tlsConnect } from "node:tls";
import { WebSocket } from "ws";
import { loadDeviceTokens } from "../src/auth.js";
import { createCoreServer, type CoreServer } from "../src/server.js";
import type { Session } from "../src/session.js";
import type { ServerFrame } from "../src/protocol.js";
import { staticSegments, STATIC_SECURITY_HEADERS } from "../src/static-files.js";
import { makeTestCert } from "./test-cert.js";

const TOKEN = "browser-token-0123456789abcdef";
const INDEX = "<!doctype html><title>t</title>";
const warnings: string[] = [];
const logger = { info: () => {}, warn: (m: string) => void warnings.push(m) };

let server: CoreServer;
let tmp: string;
let uiDir: string;
let plainPort: number;
let secondPort: number;
let tlsPort: number;
let origin: string;
const closedSessions: string[] = [];
let symlinkOk = true;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "shadow-tls-"));
  uiDir = join(tmp, "dist");
  mkdirSync(join(uiDir, "assets"), { recursive: true });
  mkdirSync(join(uiDir, "empty"));
  writeFileSync(join(uiDir, "index.html"), INDEX);
  writeFileSync(join(uiDir, "assets", "app-1234.js"), "console.log(1)");
  writeFileSync(join(uiDir, "assets", "app-1234.css"), "body{}");
  writeFileSync(join(uiDir, "assets", "icon.SVG"), "<svg/>");
  writeFileSync(join(uiDir, "notes.xyz"), "unknown type");
  writeFileSync(join(uiDir, ".env"), "SECRET=1");
  writeFileSync(join(tmp, "outside.txt"), "outside");
  writeFileSync(join(tmp, "outside.js"), "outside");
  // A directory link (a junction on Windows, which needs no privilege; a symlink elsewhere).
  symlinkSync(tmp, join(uiDir, "up"), "junction");
  try {
    symlinkSync(join(tmp, "outside.js"), join(uiDir, "assets", "link.js"), "file");
  } catch {
    // Windows without the symlink privilege: that half of the test is skipped.
    symlinkOk = false;
  }

  const cert = makeTestCert();
  server = createCoreServer({
    tokens: loadDeviceTokens({ DEVICE_TOKEN_BROWSER: TOKEN }),
    logger,
    helloTimeoutMs: 2000,
    version: "9.9.9-test",
    inbox: () => ({ dev: 1 }),
    deviceState: { recordCaseBattery: async () => ({ stored: true }) },
    createSession: (info, send) =>
      ({
        info,
        handle: async (f: { type: string }) => {
          if (f.type === "ping") send({ type: "pong" });
        },
        close: async () => void closedSessions.push(info.sessionId),
      }) as unknown as Session,
  });
  ({ port: plainPort } = await server.listen(0, "127.0.0.1"));
  ({ port: secondPort } = await server.listenPlain(0, "127.0.0.1"));
  ({ port: tlsPort, origin } = await server.listenTls({
    host: "127.0.0.1",
    port: 0,
    cert: Buffer.from(cert.certPem),
    key: Buffer.from(cert.keyPem),
    uiDir,
  }));
});

after(async () => {
  await server.close();
  rmSync(tmp, { recursive: true, force: true });
});

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A raw HTTPS request: the path is sent exactly as given (no URL normalisation). */
function get(path: string, method = "GET", headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      { host: "127.0.0.1", port: tlsPort, path, method, headers, rejectUnauthorized: false, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Opens a WebSocket; resolves with the socket, or rejects with the HTTP status of a refused upgrade. */
function openWs(url: string, headers: Record<string, string> = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, rejectUnauthorized: false });
    ws.on("open", () => resolve(ws));
    ws.on("unexpected-response", (_req, res) => {
      reject(Object.assign(new Error(`status ${res.statusCode}`), { status: res.statusCode }));
      ws.terminate();
    });
    ws.on("error", reject);
  });
}

function nextFrame(ws: WebSocket, type: string): Promise<ServerFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 2000);
    const onMsg = (d: Buffer) => {
      const f = JSON.parse(d.toString()) as ServerFrame;
      if (f.type === type) {
        clearTimeout(timer);
        ws.off("message", onMsg);
        resolve(f);
      }
    };
    ws.on("message", onMsg);
  });
}

async function helloOk(ws: WebSocket): Promise<void> {
  ws.send(JSON.stringify({ type: "hello", protocol: 1, token: TOKEN, client: "web" }));
  const w = await nextFrame(ws, "welcome");
  assert.equal(w.type === "welcome" && w.device, "browser");
}

const refusedStatus = (p: Promise<unknown>) =>
  p.then(
    () => assert.fail("upgrade was accepted"),
    (err: { status?: number }) => err.status,
  );

test("origin of the TLS listener", () => {
  assert.equal(origin, `https://127.0.0.1:${tlsPort}`);
});

test("GET / serves index.html with the security headers, revalidated", async () => {
  const r = await get("/");
  assert.equal(r.status, 200);
  assert.equal(r.body, INDEX);
  assert.equal(r.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(r.headers["cache-control"], "no-cache");
  for (const [k, v] of Object.entries(STATIC_SECURITY_HEADERS)) assert.equal(r.headers[k.toLowerCase()], v, k);
  assert.equal((await get("/index.html?v=1")).body, INDEX);
});

test("assets: content types by extension, cached for an hour, HEAD without body", async () => {
  const js = await get("/assets/app-1234.js");
  assert.equal(js.status, 200);
  assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(js.headers["cache-control"], "public, max-age=3600");
  assert.equal(js.body, "console.log(1)");
  assert.equal((await get("/assets/app-1234.css")).headers["content-type"], "text/css; charset=utf-8");
  assert.equal((await get("/assets/icon.SVG")).headers["content-type"], "image/svg+xml");
  const head = await get("/assets/app-1234.js", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-length"], String("console.log(1)".length));
  assert.equal(head.body, "");
});

test("only GET/HEAD: other methods get 405 with Allow (also /device/state, not served here)", async () => {
  for (const m of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
    const r = await get("/", m);
    assert.equal(r.status, 405, m);
    assert.equal(r.headers.allow, "GET, HEAD");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
  }
  const ds = await get("/device/state", "POST", { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" });
  assert.equal(ds.status, 405);
});

test("no listing, no dot files, no unknown types, no SPA fallback", async () => {
  for (const p of ["/assets/", "/assets", "/empty/", "/.env", "/notes.xyz", "/missing.js", "/some/route", "/agent", "/device/state", "/ws"]) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    assert.equal(r.headers["x-content-type-options"], "nosniff", p);
    assert.ok(!r.body.includes("app-1234"), p);
  }
});

test("path traversal: plain, encoded, double-encoded, backslash, NUL, drive and absolute-form targets", async () => {
  const paths = [
    "/../outside.txt",
    "/assets/../../outside.txt",
    "/%2e%2e/outside.txt",
    "/%2E%2E%2Foutside.txt",
    "/assets/%2e%2e%2f%2e%2e%2foutside.txt",
    "/%252e%252e/outside.txt",
    "/..%5coutside.txt",
    "/assets%5c..%5c..%5coutside.txt",
    "/index.html%00.js",
    "/C:/Windows/win.ini",
    "/index.html::$DATA",
    "//outside.txt",
    "/./index.html",
  ];
  for (const p of paths) {
    const r = await get(p);
    assert.ok(r.status === 404 || r.status === 400, `${p}: ${r.status}`);
    assert.ok(!r.body.includes("outside"), p);
  }
  assert.equal((await get("/%E0%A4%A")).status, 400);
});

test("staticSegments: the path rules on their own", () => {
  assert.deepEqual(staticSegments("/"), ["index.html"]);
  assert.deepEqual(staticSegments("/a/b.js?x=1"), ["a", "b.js"]);
  assert.deepEqual(staticSegments("/a/"), ["a", "index.html"]);
  assert.equal(staticSegments("http://127.0.0.1/index.html"), 400);
  assert.equal(staticSegments("*"), 400);
  assert.equal(staticSegments("/%zz"), 400);
  for (const p of ["/..", "/a/../b", "/.git/config", "/a//b", "/a%2f..%2fb", "/a\\b", "/a%00", "/c:x"]) assert.equal(staticSegments(p), 404, p);
});

test("a link out of the UI folder is not followed", async (t) => {
  const up = await get("/up/outside.js");
  assert.equal(up.status, 404);
  assert.ok(!up.body.includes("outside"));
  if (!symlinkOk) {
    t.diagnostic("file symlink not available: only the directory link was checked");
    return;
  }
  assert.equal((await get("/assets/link.js")).status, 404);
});

test("GET /health works on the TLS listener", async () => {
  const r = await get("/health");
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body) as { status: string; version: string };
  assert.equal(body.status, "ok");
  assert.equal(body.version, "9.9.9-test");
});

test("/ws over TLS: no Origin (non-browser) and the own Origin are accepted; same auth", async () => {
  const a = await openWs(`wss://127.0.0.1:${tlsPort}/ws`);
  await helloOk(a);
  a.send(JSON.stringify({ type: "ping" }));
  await nextFrame(a, "pong");
  a.close();
  const b = await openWs(`wss://127.0.0.1:${tlsPort}/ws`, { Origin: origin });
  await helloOk(b);
  b.close();
  const c = await openWs(`wss://127.0.0.1:${tlsPort}/ws?x=1`, { Origin: origin.toUpperCase().replace("HTTPS", "https") });
  c.send(JSON.stringify({ type: "hello", protocol: 1, token: "wrong-token-wrong-token" }));
  const e = await nextFrame(c, "error");
  assert.equal(e.type === "error" && e.code, "unauthorized");
});

test("/ws over TLS: a foreign Origin is refused with 403 before the handshake", async () => {
  const before = warnings.length;
  const foreign = [
    "https://evil.example",
    `http://127.0.0.1:${tlsPort}`,
    `https://127.0.0.1:${plainPort}`,
    `https://localhost:${tlsPort}`,
    "null",
    `https://127.0.0.1:${tlsPort}/x`,
  ];
  for (const o of foreign) {
    assert.equal(await refusedStatus(openWs(`wss://127.0.0.1:${tlsPort}/ws`, { Origin: o })), 403, o);
  }
  assert.equal(warnings.length - before, foreign.length);
  assert.ok(warnings.slice(before).every((w) => !w.includes("evil")), "Origin value is not logged");
});

// Smoke test: the peer-reset race of refuseUpgrade/static downloads is timing-dependent and not
// reproduced reliably here; this only checks that abrupt clients leave the listener working.
test("clients that leave during a refused upgrade or a download leave the listener working", async () => {
  const wsKey = randomBytes(16).toString("base64");
  const bad = [
    `GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\nOrigin: https://evil.example\r\n\r\n`,
    `GET /agent HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    `GET /assets/app-1234.js HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`,
  ];
  for (let i = 0; i < 10; i++) {
    for (const text of bad) {
      await new Promise<void>((resolve) => {
        const s = tlsConnect({ host: "127.0.0.1", port: tlsPort, rejectUnauthorized: false }, () => {
          s.write(text);
          // Gone at once, before or while the answer is written.
          s.destroy();
          resolve();
        });
        s.on("error", () => resolve());
      });
    }
  }
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await get("/health")).status, 200);
});

test("/agent and other paths never upgrade on the TLS listener", async () => {
  for (const p of ["/agent", "/agent/", "/", "/ws/", "/device/state"]) {
    assert.equal(await refusedStatus(openWs(`wss://127.0.0.1:${tlsPort}${p}`)), 404, p);
  }
});

test("plain listeners are unchanged: any Origin accepted, /device/state routed, both addresses share the auth", async () => {
  for (const p of [plainPort, secondPort]) {
    const ws = await openWs(`ws://127.0.0.1:${p}/ws`, { Origin: "https://evil.example" });
    await helloOk(ws);
    ws.close();
    const r = await fetch(`http://127.0.0.1:${p}/device/state`, { method: "GET" });
    assert.equal(r.status, 405);
    assert.equal(r.headers.get("allow"), "POST");
  }
  const health = (await (await fetch(`http://127.0.0.1:${secondPort}/health`)).json()) as { inbox?: unknown };
  assert.deepEqual(health.inbox, { dev: 1 });
});

test("close() stops every listener and closes the TLS sessions", async () => {
  const cert = makeTestCert();
  const sessions: string[] = [];
  const s = createCoreServer({
    tokens: loadDeviceTokens({ DEVICE_TOKEN_BROWSER: TOKEN }),
    logger: { info: () => {}, warn: () => {} },
    createSession: (info) =>
      ({ info, handle: async () => {}, close: async () => void sessions.push(info.sessionId) }) as unknown as Session,
  });
  const { port: p1 } = await s.listen(0, "127.0.0.1");
  const { port: p2 } = await s.listenPlain(0, "127.0.0.1");
  const { port: p3 } = await s.listenTls({ host: "127.0.0.1", port: 0, cert: Buffer.from(cert.certPem), key: Buffer.from(cert.keyPem), uiDir });
  const ws = await openWs(`wss://127.0.0.1:${p3}/ws`);
  ws.send(JSON.stringify({ type: "hello", protocol: 1, token: TOKEN, client: "web" }));
  await nextFrame(ws, "welcome");
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  await s.close();
  assert.equal(await closed, 1001);
  // Closed by close() (and again by the socket's close event, as on the plain listener).
  assert.ok(sessions.length >= 1);
  await assert.rejects(fetch(`http://127.0.0.1:${p1}/health`));
  await assert.rejects(fetch(`http://127.0.0.1:${p2}/health`));
  assert.equal(s.http.listening, false);
});

test("listenTls on a taken port rejects", async () => {
  const cert = makeTestCert();
  const s = createCoreServer({
    tokens: loadDeviceTokens({}),
    logger: { info: () => {}, warn: () => {} },
    createSession: () => {
      throw new Error("unused");
    },
  });
  await assert.rejects(s.listenTls({ host: "127.0.0.1", port: tlsPort, cert: Buffer.from(cert.certPem), key: Buffer.from(cert.keyPem), uiDir }));
  await s.close();
});
