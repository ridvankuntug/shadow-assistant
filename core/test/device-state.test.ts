/**
 * T11.2 / T11.3: `POST /device/state` (auth, limits, validation, storage) and
 * the read-only `case_battery` gateway tool. All files go to a temp dir.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { loadDeviceTokens } from "../src/auth.js";
import {
  CASE_BATTERY_TOOL,
  DEVICE_SERVICE_NAME,
  DeviceStateStore,
  MAX_DEVICE_STATE_BYTES,
  NO_READING_TEXT,
  caseBatteryText,
  deviceStateService,
  formatAge,
  parseDeviceStateBody,
} from "../src/device-state.js";
import { McpGateway, type GatewayGate } from "../src/mcp-gateway.js";
import { PermissionPolicy } from "../src/permissions.js";
import { createCoreServer, DEVICE_STATE_PATH, type CoreServer } from "../src/server.js";
import { parseServices } from "../src/services.js";

const TOKEN = "phone-token-0123456789abcdef";
const OTHER = "other-token-0123456789abcdef";
const EDGE = "edge-token-0123456789abcdef";
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const quiet = { info: () => {}, warn: () => {} };

const base = mkdtempSync(join(tmpdir(), "shadow-device-state-test-"));
after(() => rmSync(base, { recursive: true, force: true }));

let server: CoreServer;
let port: number;
let dir: string;
const warnings: string[] = [];
const infos: string[] = [];

before(async () => {
  dir = join(base, "server", "device-state");
  server = createCoreServer({
    tokens: loadDeviceTokens({ DEVICE_TOKEN_PHONE: TOKEN, DEVICE_TOKEN_TABLET: OTHER, DEVICE_TOKEN_EDGE: EDGE }),
    logger: { info: (m) => infos.push(m), warn: (m) => warnings.push(m) },
    createSession: () => {
      throw new Error("no sessions in this test");
    },
    deviceState: new DeviceStateStore({ dir, now: () => NOW + 1 }),
    now: () => NOW,
    deviceStateBodyTimeoutMs: 300,
  });
  ({ port } = await server.listen(0, "127.0.0.1"));
});
after(() => server.close());

interface Res {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function send(
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer; chunked?: boolean } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.body !== undefined && !opts.chunked) headers["Content-Length"] = String(Buffer.byteLength(opts.body));
    const req = request(
      { host: "127.0.0.1", port, method: opts.method ?? "POST", path: opts.path ?? DEVICE_STATE_PATH, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }));
      },
    );
    // The server may close the connection while a large body is still being sent.
    req.on("error", (err) => (err as NodeJS.ErrnoException).code === "ECONNRESET" || (err as NodeJS.ErrnoException).code === "EPIPE" ? undefined : reject(err));
    if (opts.body !== undefined) {
      if (opts.chunked) {
        const b = Buffer.from(opts.body);
        for (let i = 0; i < b.length; i += 1000) req.write(b.subarray(i, i + 1000));
      } else req.write(opts.body);
    }
    req.end();
  });
}

const auth = (t = TOKEN) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
const reading = (over: Record<string, unknown> = {}) => JSON.stringify({ caseBattery: { percent: 57, atEpochMs: NOW - 60_000, ...over } });
const fileOf = (device: string) => JSON.parse(readFileSync(join(dir, `${device}.json`), "utf8")) as Record<string, unknown>;

// ---------------------------------------------------------------- endpoint

test("204 stores the reading atomically with receivedAtEpochMs; device comes from the token", async () => {
  const r = await send({ headers: auth(), body: JSON.stringify({ caseBattery: { percent: 57, atEpochMs: NOW - 60_000, source: "buds-case-widget" }, device: "evil", extra: 1 }) });
  assert.equal(r.status, 204);
  assert.equal(r.body, "");
  assert.deepEqual(fileOf("phone"), {
    device: "phone",
    caseBattery: { percent: 57, atEpochMs: NOW - 60_000, source: "buds-case-widget", receivedAtEpochMs: NOW + 1 },
  });
  const names = readdirSync(dir);
  assert.ok(!names.includes("evil.json"));
  assert.deepEqual(names.filter((n) => n.includes(".tmp-")), [], "no temp file left behind");
});

test("an older reading answers 204 but does not overwrite; equal or newer does", async () => {
  assert.equal((await send({ headers: auth(), body: reading({ percent: 40, atEpochMs: NOW - 30_000 }) })).status, 204);
  assert.equal((await send({ headers: auth(), body: reading({ percent: 90, atEpochMs: NOW - 120_000 }) })).status, 204);
  assert.deepEqual((fileOf("phone").caseBattery as Record<string, unknown>).percent, 40);
  assert.equal((await send({ headers: auth(), body: reading({ percent: 41, atEpochMs: NOW - 30_000 }) })).status, 204);
  assert.deepEqual((fileOf("phone").caseBattery as Record<string, unknown>).percent, 41, "equal atEpochMs replaces");
});

test("401: missing, wrong or non-Bearer token; a token in the query is ignored", async () => {
  const cases: Array<Record<string, string>> = [
    { "Content-Type": "application/json" },
    auth(`${TOKEN}x`),
    { Authorization: TOKEN, "Content-Type": "application/json" },
    { Authorization: `Basic ${TOKEN}`, "Content-Type": "application/json" },
  ];
  for (const headers of cases) {
    const r = await send({ headers, body: reading() });
    assert.equal(r.status, 401);
    assert.deepEqual(JSON.parse(r.body), { error: "unauthorized" });
  }
  const q = await send({ path: `${DEVICE_STATE_PATH}?token=${TOKEN}`, headers: { "Content-Type": "application/json" }, body: reading() });
  assert.equal(q.status, 401);
  assert.ok([...warnings, ...infos].every((w) => !w.includes(TOKEN)), "token never logged");
});

test("auth comes before size and format: a bad token with a huge non-JSON body is 401", async () => {
  const r = await send({ headers: { Authorization: "Bearer nope", "Content-Type": "text/plain" }, body: "x".repeat(10_000) });
  assert.equal(r.status, 401);
});

test("400 for invalid JSON and each invalid field", async () => {
  const bad: Array<[string, RegExp]> = [
    ["{not json", /JSON/],
    ["[1,2]", /object/],
    [JSON.stringify({}), /caseBattery is required/],
    [JSON.stringify({ caseBattery: 5 }), /caseBattery must be an object/],
    [reading({ percent: 101 }), /percent/],
    [reading({ percent: -1 }), /percent/],
    [reading({ percent: 50.5 }), /percent/],
    [reading({ percent: "50" }), /percent/],
    [reading({ percent: undefined }), /percent/],
    [reading({ atEpochMs: 1.5 }), /atEpochMs/],
    [reading({ atEpochMs: "1" }), /atEpochMs/],
    [reading({ atEpochMs: NOW + 5 * 60_000 + 1 }), /future/],
    [reading({ atEpochMs: NOW - 365 * 86_400_000 - 1 }), /past/],
    [reading({ source: "s".repeat(65) }), /source/],
    [reading({ source: 3 }), /source/],
  ];
  for (const [body, re] of bad) {
    const r = await send({ headers: auth(), body });
    assert.equal(r.status, 400, body);
    const j = JSON.parse(r.body) as { error: string; message: string };
    assert.equal(j.error, "bad_request");
    assert.match(j.message, re, body);
  }
  // Boundaries are accepted.
  for (const over of [{ percent: 0 }, { percent: 100 }, { atEpochMs: NOW + 5 * 60_000 }, { atEpochMs: NOW - 365 * 86_400_000 }, { source: "s".repeat(64) }, { source: null }]) {
    assert.equal((await send({ headers: auth(OTHER), body: reading(over) })).status, 204, JSON.stringify(over));
  }
});

test("413 for a body over 4096 bytes, declared or chunked", async () => {
  const big = JSON.stringify({ caseBattery: { percent: 1, atEpochMs: NOW }, pad: "x".repeat(MAX_DEVICE_STATE_BYTES) });
  const declared = await send({ headers: auth(), body: big });
  assert.equal(declared.status, 413);
  assert.deepEqual(JSON.parse(declared.body), { error: "payload_too_large" });
  const chunked = await send({ headers: auth(), body: big, chunked: true });
  assert.equal(chunked.status, 413);
  // Exactly the limit is fine.
  const exact = JSON.stringify({ caseBattery: { percent: 1, atEpochMs: NOW - 1000 }, pad: "" });
  const padded = exact.replace('"pad":""', `"pad":"${"y".repeat(MAX_DEVICE_STATE_BYTES - Buffer.byteLength(exact))}"`);
  assert.equal(Buffer.byteLength(padded), MAX_DEVICE_STATE_BYTES);
  assert.equal((await send({ headers: auth(EDGE), body: padded })).status, 204);
  assert.equal((fileOf("edge").caseBattery as Record<string, unknown>).percent, 1, "the 4096-byte body was stored");
});

test("415 for a non-JSON content type; charset parameter is accepted", async () => {
  const r = await send({ headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "text/plain" }, body: reading() });
  assert.equal(r.status, 415);
  const none = await send({ headers: { Authorization: `Bearer ${TOKEN}` }, body: reading() });
  assert.equal(none.status, 415);
  const cs = await send({ headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json; charset=utf-8" }, body: reading({ atEpochMs: NOW }) });
  assert.equal(cs.status, 204);
});

test("405 for other methods on the path; other paths unchanged", async () => {
  for (const method of ["GET", "PUT", "DELETE"]) {
    const r = await send({ method, headers: auth() });
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.allow, "POST");
  }
  assert.equal((await send({ method: "GET", path: "/health" })).status, 200);
  assert.equal((await send({ method: "POST", path: "/device/other", headers: auth(), body: reading() })).status, 404);
});

test("without a store the path is a plain 404", async () => {
  const s = createCoreServer({ tokens: loadDeviceTokens({ DEVICE_TOKEN_PHONE: TOKEN }), logger: quiet, createSession: () => { throw new Error("x"); } });
  const { port: p } = await s.listen(0, "127.0.0.1");
  try {
    const saved = port;
    port = p;
    try {
      assert.equal((await send({ headers: auth(), body: reading() })).status, 404);
    } finally {
      port = saved;
    }
  } finally {
    await s.close();
  }
});

test("parseDeviceStateBody ignores unknown caseBattery fields and drops source null", () => {
  const r = parseDeviceStateBody({ caseBattery: { percent: 5, atEpochMs: NOW, source: null, charging: true } }, NOW);
  assert.deepEqual(r, { ok: true, caseBattery: { percent: 5, atEpochMs: NOW } });
});

// ---------------------------------------------------------------- store + tool

test("store: concurrent writes of one device keep the newest reading", async () => {
  const store = new DeviceStateStore({ dir: join(base, "concurrent"), now: () => NOW });
  const order = [3, 1, 5, 2, 4];
  await Promise.all(order.map((i) => store.recordCaseBattery("phone", { percent: i * 10, atEpochMs: NOW - 10_000 + i })));
  const latest = await store.latestCaseBattery();
  assert.equal(latest?.caseBattery.percent, 50);
});

test("store: an invalid device name is refused, a corrupt file is quarantined", async () => {
  const d = join(base, "names");
  const store = new DeviceStateStore({ dir: d, now: () => NOW });
  await assert.rejects(store.recordCaseBattery("../x", { percent: 1, atEpochMs: NOW }), /device name/);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "phone.json"), "{oops");
  assert.equal(await store.latestCaseBattery(), undefined);
  assert.ok(readdirSync(d).some((n) => n.startsWith("phone.json.corrupt-")));
  assert.deepEqual(await store.recordCaseBattery("phone", { percent: 1, atEpochMs: NOW }), { stored: true });
});

function toolOf(store: DeviceStateStore, now = NOW) {
  const svc = deviceStateService([], store, () => now);
  assert.ok(svc);
  const src = svc.source;
  assert.equal(src.kind, "local");
  if (src.kind !== "local") throw new Error("local");
  const tool = src.tools[0];
  assert.ok(tool);
  return { svc, tool };
}

test("tool: no record → 'henüz okuma yok'", async () => {
  const { tool } = toolOf(new DeviceStateStore({ dir: join(base, "empty-missing") }));
  assert.equal(tool.name, CASE_BATTERY_TOOL);
  assert.deepEqual(await tool.handler({}), { text: NO_READING_TEXT, isError: false });
});

test("tool: one record → percent, ISO + local time, age, device; no charging claim", async () => {
  const store = new DeviceStateStore({ dir: join(base, "one"), now: () => NOW });
  const at = NOW - (2 * 60 + 5) * 60_000;
  await store.recordCaseBattery("phone", { percent: 57, atEpochMs: at, source: "buds-case-widget" });
  const { tool } = toolOf(store);
  const r = await tool.handler({});
  assert.equal(r.isError, false);
  assert.match(r.text, /Yüzde: 57/);
  assert.match(r.text, new RegExp(new Date(at).toISOString().replace(/\./g, "\\.")));
  assert.match(r.text, /\d{4}-\d{2}-\d{2} \d{2}:\d{2} \(yerel saat\)/);
  assert.match(r.text, /2 saat 5 dakika önce/);
  assert.match(r.text, /Cihaz: phone/);
  assert.match(r.text, /Kaynak: "buds-case-widget"/);
  assert.match(r.text, /son kılıf açılışındaki/);
  assert.doesNotMatch(r.text, /şarj oluyor|şarjda\b(?! olup)/);
  assert.match(tool.description, /SON AÇILDIĞI/);
  assert.match(tool.description, /şarj durumunu göstermez/);
});

test("tool: several devices → the newest atEpochMs wins", async () => {
  const store = new DeviceStateStore({ dir: join(base, "many"), now: () => NOW });
  await store.recordCaseBattery("phone", { percent: 30, atEpochMs: NOW - 3_600_000 });
  await store.recordCaseBattery("tablet", { percent: 80, atEpochMs: NOW - 60_000 });
  await store.recordCaseBattery("old", { percent: 99, atEpochMs: NOW - 86_400_000 });
  writeFileSync(join(base, "many", "notes.txt"), "ignored");
  const latest = await store.latestCaseBattery();
  assert.equal(latest?.device, "tablet");
  assert.match(caseBatteryText(latest, NOW), /Yüzde: 80[\s\S]*Cihaz: tablet/);
});

test("formatAge", () => {
  assert.match(formatAge(30_000), /az önce/);
  assert.match(formatAge(-60_000), /az önce/);
  assert.equal(formatAge(12 * 60_000), "12 dakika önce");
  assert.equal(formatAge(3 * 3_600_000), "3 saat önce");
  assert.equal(formatAge(47 * 3_600_000 + 60_000), "47 saat 1 dakika önce");
  assert.equal(formatAge(50 * 3_600_000), "2 gün 2 saat önce");
  assert.equal(formatAge(72 * 3_600_000), "3 gün önce");
});

test("permission: case_battery is read (also under CORE_READ_ONLY); the gateway runs it through the gate", async () => {
  const store = new DeviceStateStore({ dir: join(base, "gate"), now: () => NOW });
  await store.recordCaseBattery("phone", { percent: 12, atEpochMs: NOW - 60_000 });
  const { svc } = toolOf(store);
  const yaml = parseServices("services:\n  - name: shadow-memory\n    kind: memory\n    permission: confirm\n", {}).services;
  for (const readOnly of [false, true]) {
    const policy = new PermissionPolicy([...yaml, svc.def], { readOnly });
    const d = policy.levelFor(`mcp__${DEVICE_SERVICE_NAME}__${CASE_BATTERY_TOOL}`, {});
    assert.equal(d.level, "read");
    assert.equal(policy.classifyTool(DEVICE_SERVICE_NAME, CASE_BATTERY_TOOL).classified, true);
  }
  const seen: string[] = [];
  const policy = new PermissionPolicy([svc.def]);
  const gate: GatewayGate = async (name) => {
    seen.push(name);
    return policy.levelFor(name).level === "read" ? { behavior: "allow" } : { behavior: "deny", message: "no" };
  };
  const gw = new McpGateway({ sources: [svc.source] });
  assert.deepEqual(gw.services, [DEVICE_SERVICE_NAME]);
  const tools = await gw.listTools(DEVICE_SERVICE_NAME);
  assert.deepEqual(tools.map((t) => t.name), [CASE_BATTERY_TOOL]);
  assert.deepEqual(tools[0]?.annotations, { readOnlyHint: true });
  const r = await gw.call(DEVICE_SERVICE_NAME, CASE_BATTERY_TOOL, {}, gate, { signal: new AbortController().signal });
  assert.equal(r.isError, false);
  assert.match(r.content[0]?.text ?? "", /Yüzde: 12/);
  assert.deepEqual(seen, [`mcp__${DEVICE_SERVICE_NAME}__${CASE_BATTERY_TOOL}`]);
});

test("a services.yaml service named shadow-device disables the built-in one", () => {
  const yaml = parseServices(`services:\n  - name: ${DEVICE_SERVICE_NAME}\n    kind: vault\n    permission: confirm\n`, {}).services;
  assert.equal(deviceStateService(yaml, new DeviceStateStore({ dir: join(base, "x") })), undefined);
});

test("error answers before the body is read close the connection; 405 needs no token", async () => {
  const r401 = await send({ headers: { "Content-Type": "application/json" }, body: reading() });
  assert.equal(r401.headers.connection, "close");
  const r413 = await send({ headers: auth(), body: "x".repeat(MAX_DEVICE_STATE_BYTES + 1) });
  assert.equal(r413.status, 413);
  assert.equal(r413.headers.connection, "close");
  const r405 = await send({ method: "GET" });
  assert.equal(r405.status, 405);
  assert.equal(r405.headers.connection, "close");
});

test("Bearer is case-insensitive; an empty token is 401", async () => {
  assert.equal((await send({ headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" }, body: reading({ atEpochMs: NOW }) })).status, 204);
  assert.equal((await send({ headers: { Authorization: "Bearer ", "Content-Type": "application/json" }, body: reading() })).status, 401);
});

test("a body that stops arriving is dropped without an answer", async () => {
  const outcome = await new Promise<string>((resolve) => {
    const req = request({ host: "127.0.0.1", port, method: "POST", path: DEVICE_STATE_PATH, headers: { ...auth(), "Content-Length": "200" } }, (res) =>
      resolve(`status ${res.statusCode}`),
    );
    req.on("error", () => resolve("closed"));
    req.write('{"caseBattery":');
  });
  assert.equal(outcome, "closed");
});

test("Expect: 100-continue: a bad token gets 401 without being asked for the body; a good one is stored", async () => {
  const go = (token: string) =>
    new Promise<{ status: number; continued: boolean }>((resolve, reject) => {
      let continued = false;
      const body = reading({ percent: 66, atEpochMs: NOW });
      const req = request({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: DEVICE_STATE_PATH,
        headers: { ...auth(token), Expect: "100-continue", "Content-Length": String(Buffer.byteLength(body)) },
      });
      req.on("continue", () => {
        continued = true;
        req.end(body);
      });
      req.on("response", (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode ?? 0, continued }));
      });
      req.on("error", reject);
      req.flushHeaders();
    });
  assert.deepEqual(await go("wrong-token-0123456789"), { status: 401, continued: false });
  assert.deepEqual(await go(TOKEN), { status: 204, continued: true });
});

function serverWith(tokens: Record<string, string>, sink: Parameters<typeof createCoreServer>[0]["deviceState"]) {
  return createCoreServer({ tokens: loadDeviceTokens(tokens), logger: { info: (m) => infos.push(m), warn: (m) => warnings.push(m) }, createSession: () => { throw new Error("x"); }, deviceState: sink, now: () => NOW });
}

async function onServer(s: CoreServer, fn: () => Promise<void>): Promise<void> {
  const { port: p } = await s.listen(0, "127.0.0.1");
  const saved = port;
  port = p;
  try {
    await fn();
  } finally {
    port = saved;
    await s.close();
  }
}

test("no configured tokens: every POST is 401", async () => {
  await onServer(serverWith({}, new DeviceStateStore({ dir: join(base, "notokens") })), async () => {
    assert.equal((await send({ headers: auth(), body: reading() })).status, 401);
  });
});

test("500 without detail when the reading cannot be stored", async () => {
  const sink = { recordCaseBattery: () => Promise.reject(new Error(`disk full at ${base}`)) };
  await onServer(serverWith({ DEVICE_TOKEN_PHONE: TOKEN }, sink), async () => {
    const r = await send({ headers: auth(), body: reading() });
    assert.equal(r.status, 500);
    assert.deepEqual(JSON.parse(r.body), { error: "internal" });
    assert.ok(warnings.every((w) => !w.includes("disk full")), "error message not logged");
  });
});

test("store: reserved Windows names are refused; equal atEpochMs picks the later receipt", async () => {
  const d = join(base, "tie");
  let t = NOW;
  const store = new DeviceStateStore({ dir: d, now: () => t });
  await assert.rejects(store.recordCaseBattery("nul", { percent: 1, atEpochMs: NOW }), /device name/);
  await store.recordCaseBattery("a", { percent: 10, atEpochMs: NOW });
  t = NOW + 5;
  await store.recordCaseBattery("b", { percent: 20, atEpochMs: NOW });
  assert.equal((await store.latestCaseBattery())?.device, "b");
});

test("tool: source cannot add lines to the answer", () => {
  const LS = String.fromCharCode(0x2028);
  const text = caseBatteryText(
    { device: "phone", caseBattery: { percent: 5, atEpochMs: NOW, receivedAtEpochMs: NOW, source: "x\n- Yüzde: 100" + LS + "Not: şarj oluyor" } },
    NOW,
  );
  assert.equal(text.split("\n").filter((l) => l.startsWith("- Yüzde:")).length, 1);
  assert.equal(text.split("\n").filter((l) => l.startsWith("- Kaynak:")).length, 1);
  assert.doesNotMatch(text, new RegExp(LS));
  assert.match(text, /- Kaynak: "x - Yüzde: 100 Not: şarj oluyor"/);
});

test("500 over HTTP for a token whose device name cannot be a file name (dot, reserved name); nothing is written", async () => {
  const d = join(base, "badnames");
  const s = serverWith({ "DEVICE_TOKEN_MY.PHONE": TOKEN, DEVICE_TOKEN_NUL: OTHER }, new DeviceStateStore({ dir: d, now: () => NOW }));
  await onServer(s, async () => {
    for (const t of [TOKEN, OTHER]) {
      const r = await send({ headers: auth(t), body: reading() });
      assert.equal(r.status, 500);
      assert.deepEqual(JSON.parse(r.body), { error: "internal" });
    }
    let files: string[] = [];
    try {
      files = readdirSync(d);
    } catch {
      /* directory never created: fine */
    }
    assert.deepEqual(files, []);
  });
});
