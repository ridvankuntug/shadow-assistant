import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { loadDeviceTokens } from "../src/auth.js";
import {
  buildHealthTargets,
  HealthMonitor,
  httpHealthCheck,
  mcpHealthCheck,
  type CheckResult,
  type HealthTarget,
} from "../src/health.js";
import type { ServerFrame, ServiceHealth } from "../src/protocol.js";
import { createCoreServer } from "../src/server.js";
import { parseServices } from "../src/services.js";
import type { Session } from "../src/session.js";

const quiet = { info: () => {}, warn: () => {} };
const TOKEN = "browser-token-0123456789abcdef";
const HA_TOKEN = "ha-token-for-tests-only";

// ------------------------------------------------------------------ local fake services

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
let fake: Server;
let base: string;
const routes = new Map<string, Handler>();
const seenAuth: string[] = [];
/** Responses held open (SSE streams, slow handlers); ended in after(). */
const open = new Set<ServerResponse>();

before(async () => {
  fake = createServer((req, res) => {
    const h = routes.get((req.url ?? "/").split("?")[0] ?? "/");
    if (h) h(req, res);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  const addr = fake.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  const json = (status: number, body: unknown): Handler => (_req, res) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  routes.set("/ok/health", json(200, { status: "ok", model: "x" }));
  routes.set("/loading/health", json(503, { status: "loading" }));
  routes.set("/error/health", json(503, { status: "error" }));
  routes.set("/boom/health", json(500, { oops: true }));
  routes.set("/slow/health", (_req, res) => {
    open.add(res); // never answers
  });
  routes.set("/mcp_server/sse", (req, res) => {
    seenAuth.push(req.headers.authorization ?? "");
    if (req.headers.authorization !== `Bearer ${HA_TOKEN}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.write("event: endpoint\ndata: /mcp_server/messages/abc\n\n");
    open.add(res);
    req.on("close", () => open.delete(res));
  });
  routes.set("/html", (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html></html>");
  });
});

after(async () => {
  for (const r of open) r.destroy();
  fake.closeAllConnections();
  await new Promise<void>((r) => fake.close(() => r()));
});

const sig = () => AbortSignal.timeout(2000);

// ------------------------------------------------------------------ checks

test("http check: ok / loading / error / other status", async () => {
  assert.deepEqual(await httpHealthCheck(`${base}/ok/health`)(sig()), { status: "ok" });
  assert.deepEqual(await httpHealthCheck(`${base}/loading/health`)(sig()), { status: "loading" });
  assert.deepEqual(await httpHealthCheck(`${base}/error/health`)(sig()), { status: "down", detail: "error" });
  assert.deepEqual(await httpHealthCheck(`${base}/boom/health`)(sig()), { status: "down", detail: "http_500" });
  assert.deepEqual(await httpHealthCheck(`${base}/missing/health`)(sig()), { status: "down", detail: "http_404" });
});

test("mcp sse check: handshake with token ok, wrong token unauthorized, wrong content-type down", async () => {
  assert.deepEqual(await mcpHealthCheck(`${base}/mcp_server/sse`, "sse", HA_TOKEN)(sig()), { status: "ok" });
  assert.ok(seenAuth.includes(`Bearer ${HA_TOKEN}`));
  assert.deepEqual(await mcpHealthCheck(`${base}/mcp_server/sse`, "sse", "wrong")(sig()), {
    status: "down",
    detail: "unauthorized",
  });
  assert.deepEqual(await mcpHealthCheck(`${base}/html`, "sse", HA_TOKEN)(sig()), { status: "down", detail: "bad_response" });
  assert.deepEqual(await mcpHealthCheck(`${base}/nope`, "sse", HA_TOKEN)(sig()), { status: "down", detail: "http_404" });
  // Streamable HTTP: a refused GET still proves the server is there.
  assert.deepEqual(await mcpHealthCheck(`${base}/html`, "http", HA_TOKEN)(sig()), { status: "ok" });
  assert.deepEqual(await mcpHealthCheck(`${base}/boom/health`, "http", HA_TOKEN)(sig()), { status: "down", detail: "http_500" });
});

test("buildHealthTargets: disabled services, http/mcp/vault checks, no URL or token in results", async () => {
  const vault = mkdtempSync(join(tmpdir(), "shadow-health-"));
  try {
    const yaml = `
services:
  - name: home-assistant
    kind: mcp
    transport: sse
    url: \${HA_URL}/mcp_server/sse
    token_env: HA_CORE_TOKEN
  - name: missing-svc
    kind: http
    url: \${MISSING_URL}
    health: /health
  - name: off-svc
    kind: http
    url: http://127.0.0.1:1
    health: /health
    enabled: false
  - name: whisper-svc
    kind: http
    url: ${base}/ok
    health: /health
  - name: shadow-vault
    kind: vault
`;
    const cfg = parseServices(yaml, { HA_URL: base, HA_CORE_TOKEN: HA_TOKEN });
    const targets = buildHealthTargets(cfg.services, { HA_CORE_TOKEN: HA_TOKEN }, { vaultDir: vault });
    const m = new HealthMonitor(targets, { timeoutMs: 1000 });
    await m.checkNow();
    const items = m.snapshot() ?? [];
    await m.close();
    assert.deepEqual(
      items.map((i) => [i.name, i.status, i.detail]),
      [
        ["home-assistant", "ok", undefined],
        ["missing-svc", "disabled", "not_configured"],
        ["off-svc", "disabled", "off"],
        ["whisper-svc", "ok", undefined],
        ["shadow-vault", "ok", undefined],
      ],
    );
    assert.ok(items.every((i) => typeof i.checkedAt === "number" && i.checkedAt > 0));
    const text = JSON.stringify(items);
    assert.ok(!text.includes(HA_TOKEN) && !text.includes("127.0.0.1"), "no token or address in the snapshot");

    // Vault folder disappears → down.
    rmSync(vault, { recursive: true, force: true });
    const m2 = new HealthMonitor(buildHealthTargets(cfg.services, {}, { vaultDir: vault }), { timeoutMs: 1000 });
    await m2.checkNow();
    assert.deepEqual(m2.snapshot()?.find((i) => i.name === "shadow-vault")?.detail, "not_found");
    // Without the token the HA handshake is refused.
    assert.deepEqual(m2.snapshot()?.find((i) => i.name === "home-assistant")?.detail, "unauthorized");
    await m2.close();
  } finally {
    rmSync(vault, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ monitor

test("monitor: timeout and unreachable become down without leaking the error text", async () => {
  const targets: HealthTarget[] = [
    { name: "slow-svc", check: httpHealthCheck(`${base}/slow/health`) },
    { name: "dead-svc", check: httpHealthCheck("http://127.0.0.1:1/health") },
    { name: "deaf-svc", check: () => new Promise<CheckResult>(() => {}) }, // ignores its signal
    { name: "throws-svc", check: () => Promise.reject(new Error("secret http://host/?token=abc")) },
  ];
  const m = new HealthMonitor(targets, { timeoutMs: 100 });
  const t0 = Date.now();
  await m.checkNow();
  assert.ok(Date.now() - t0 < 1500, "round is bounded by the timeout");
  assert.deepEqual(
    m.snapshot()?.map((i) => [i.name, i.status, i.detail]),
    [
      ["slow-svc", "down", "timeout"],
      ["dead-svc", "down", "unreachable"],
      ["deaf-svc", "down", "timeout"],
      ["throws-svc", "down", "unreachable"],
    ],
  );
  await m.close();
});

test("monitor: broadcasts the first round and only changes afterwards", async () => {
  let result: CheckResult = { status: "loading" };
  const m = new HealthMonitor([{ name: "whisper-svc", check: async () => result }, { name: "x", disabledDetail: "off" }]);
  const seen: ServiceHealth[][] = [];
  m.subscribe((items) => seen.push(items));
  assert.equal(m.snapshot(), undefined, "nothing before the first round");
  await m.checkNow();
  await m.checkNow(); // same status → silent
  result = { status: "ok" };
  await m.checkNow();
  await m.checkNow();
  result = { status: "down", detail: "error" };
  await m.checkNow();
  result = { status: "down", detail: "timeout" }; // detail change counts
  await m.checkNow();
  assert.deepEqual(
    seen.map((items) => items.map((i) => `${i.status}${i.detail ? `:${i.detail}` : ""}`).join(",")),
    ["loading,disabled:off", "ok,disabled:off", "down:error,disabled:off", "down:timeout,disabled:off"],
  );
  await m.close();
});

test("monitor: rounds never overlap", async () => {
  let calls = 0;
  let release: () => void = () => {};
  const m = new HealthMonitor([
    {
      name: "a",
      check: () => {
        calls++;
        if (calls > 1) return Promise.resolve<CheckResult>({ status: "ok" });
        return new Promise<CheckResult>((r) => (release = () => r({ status: "ok" })));
      },
    },
  ]);
  const p1 = m.checkNow();
  const p2 = m.checkNow();
  assert.equal(p1, p2, "second call joins the running round");
  assert.equal(calls, 1);
  release();
  await p1;
  await m.checkNow();
  assert.equal(calls, 2);
  await m.close();
});

test("monitor: polls on the interval after start() and stops on close()", async () => {
  let calls = 0;
  const m = new HealthMonitor([{ name: "a", check: async () => (calls++, { status: "ok" }) }], { intervalMs: 20 });
  m.start();
  m.start(); // idempotent
  await new Promise((r) => setTimeout(r, 130));
  assert.ok(calls >= 3, `expected several rounds, got ${calls}`);
  await m.close();
  const atClose = calls;
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(calls, atClose, "no round after close()");
  assert.equal(await m.checkNow(), undefined);
});

test("monitor: close() aborts an in-flight round and drops its result", async () => {
  let aborted = false;
  const m = new HealthMonitor(
    [
      {
        name: "a",
        check: (signal) =>
          new Promise<CheckResult>((_r, rej) =>
            signal.addEventListener("abort", () => {
              aborted = true;
              rej(new Error("aborted"));
            }),
          ),
      },
    ],
    { timeoutMs: 10_000, intervalMs: 10 },
  );
  const seen: unknown[] = [];
  m.subscribe((i) => seen.push(i));
  m.start();
  const t0 = Date.now();
  await m.close();
  assert.ok(Date.now() - t0 < 1000, "close() does not wait for the check timeout");
  assert.equal(aborted, true);
  assert.deepEqual(seen, []);
  assert.equal(m.snapshot(), undefined);
});

// ------------------------------------------------------------------ WebSocket integration

function wsClient(port: number): Promise<{ ws: WebSocket; frames: ServerFrame[]; wait(n: number, type: string): Promise<ServerFrame[]> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames: ServerFrame[] = [];
    const waiters: Array<() => void> = [];
    ws.on("message", (d) => {
      frames.push(JSON.parse(d.toString()) as ServerFrame);
      waiters.splice(0).forEach((w) => w());
    });
    const wait = (n: number, type: string) =>
      new Promise<ServerFrame[]>((res, rej) => {
        const check = () => {
          const got = frames.filter((f) => f.type === type);
          if (got.length >= n) res(got);
          else waiters.push(check);
        };
        setTimeout(() => rej(new Error(`timeout waiting for ${n}× ${type}`)), 2000).unref();
        check();
      });
    ws.on("open", () => resolve({ ws, frames, wait }));
    ws.on("error", reject);
  });
}

test("server: new client gets services after welcome + state; changes are broadcast; close() unsubscribes", async () => {
  let whisper: CheckResult = { status: "ok" };
  const monitor = new HealthMonitor([
    { name: "whisper-svc", check: async () => whisper },
    { name: "home-assistant", check: async () => ({ status: "ok" }) },
  ]);
  await monitor.checkNow();
  const server = createCoreServer({
    tokens: loadDeviceTokens({ DEVICE_TOKEN_BROWSER: TOKEN }),
    logger: quiet,
    serviceHealth: monitor,
    createSession: (info) => ({ info, handle: async () => {}, close: async () => {} }) as unknown as Session,
  });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    // Unauthenticated sockets get no broadcast.
    const anon = await wsClient(port);
    const c = await wsClient(port);
    c.ws.send(JSON.stringify({ type: "hello", protocol: 1, token: TOKEN, client: "web" }));
    const [first] = await c.wait(1, "services");
    assert.deepEqual(
      c.frames.slice(0, 3).map((f) => f.type),
      ["welcome", "state", "services"],
    );
    assert.deepEqual(
      first?.type === "services" && first.items.map((i) => [i.name, i.status]),
      [
        ["whisper-svc", "ok"],
        ["home-assistant", "ok"],
      ],
    );

    whisper = { status: "down", detail: "timeout" };
    await monitor.checkNow();
    const all = await c.wait(2, "services");
    const second = all[1];
    assert.deepEqual(second?.type === "services" && second.items[0], {
      name: "whisper-svc",
      status: "down",
      checkedAt: (second as { items: ServiceHealth[] }).items[0]?.checkedAt,
      detail: "timeout",
    });
    assert.equal(anon.frames.length, 0);
    anon.ws.close();
    c.ws.close();
  } finally {
    await server.close();
  }
  // After close() the server no longer listens to the monitor.
  whisper = { status: "ok" };
  await monitor.checkNow();
  await monitor.close();
});

test("server: before the first round no services frame is sent on connect", async () => {
  const monitor = new HealthMonitor([{ name: "a", check: async () => ({ status: "ok" }) }]);
  const server = createCoreServer({
    tokens: loadDeviceTokens({ DEVICE_TOKEN_BROWSER: TOKEN }),
    logger: quiet,
    serviceHealth: monitor,
    createSession: (info) => ({ info, handle: async () => {}, close: async () => {} }) as unknown as Session,
  });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    const c = await wsClient(port);
    c.ws.send(JSON.stringify({ type: "hello", protocol: 1, token: TOKEN }));
    await c.wait(1, "state");
    assert.equal(c.frames.some((f) => f.type === "services"), false);
    await monitor.checkNow(); // first round → broadcast
    await c.wait(1, "services");
    c.ws.close();
  } finally {
    await server.close();
    await monitor.close();
  }
});
