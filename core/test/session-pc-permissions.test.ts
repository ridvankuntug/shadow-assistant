/**
 * The PC permission list over the protocol (T17.2, docs/02 §PC permissions,
 * docs/11 D3): frame parsing, the session handlers (list / set / seen, the
 * device check from the token, the unavailable store) and the server
 * (`pc_permissions_count` broadcast, `/health` `inbox.pc` loopback only,
 * feature flag).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import type { AgentRunner, TurnResult } from "../src/agent.js";
import { loadDeviceTokens } from "../src/auth.js";
import { ConversationLog } from "../src/conversation-log.js";
import { PC_PERMISSIONS_FILE, PcPermissionStore, type PcTargetRef } from "../src/pc/permissions.js";
import { PermissionPolicy } from "../src/permissions.js";
import { parseClientFrame, type ServerFrame } from "../src/protocol.js";
import { createCoreServer } from "../src/server.js";
import { parseServices } from "../src/services.js";
import { Session } from "../src/session.js";

const base = mkdtempSync(join(tmpdir(), "shadow-session-pc-test-"));
const open: Session[] = [];
after(async () => {
  await Promise.all(open.map((s) => s.close("test_end")));
  rmSync(base, { recursive: true, force: true });
});

const quiet = { info: () => {}, warn: () => {} };
const TOKEN = "browser-token-0123456789abcdef";
const ROW = "p-0123456789abcdef";

const STEAM: PcTargetRef = { action: "open_app", kind: "app", id: "steam_app_id", label: "Steam", alias: "steam" };
const SHUTDOWN: PcTargetRef = { action: "shutdown", kind: "system", id: "shutdown", label: "Bilgisayar" };

// ------------------------------------------------------------------ parsing

const ok = (raw: unknown) => {
  const r = parseClientFrame(JSON.stringify(raw));
  assert.ok(r.ok, `expected ok for ${JSON.stringify(raw)}: ${r.ok ? "" : r.message}`);
  return r.frame;
};
const bad = (raw: unknown) => {
  const r = parseClientFrame(JSON.stringify(raw));
  assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(raw)}`);
  return r as { ok: false; message: string; id?: string };
};

test("pc_permissions_list / pc_permission_set / pc_permissions_seen parse; malformed ones are bad_request with the id", () => {
  assert.deepEqual(ok({ type: "pc_permissions_list", id: "p1", extra: 1 }), { type: "pc_permissions_list", id: "p1" });
  assert.deepEqual(ok({ type: "pc_permissions_seen", id: "p3", rowId: ROW }), { type: "pc_permissions_seen", id: "p3" });
  for (const enabled of [true, false]) {
    assert.deepEqual(ok({ type: "pc_permission_set", id: "p2", rowId: ROW, enabled, toggle: true }), {
      type: "pc_permission_set",
      id: "p2",
      rowId: ROW,
      enabled,
    });
  }
  bad({ type: "pc_permissions_list" });
  bad({ type: "pc_permissions_seen", id: "" });
  assert.equal(bad({ type: "pc_permission_set", id: "p2", rowId: ROW }).id, "p2", "no toggle: enabled is required");
  for (const enabled of ["true", 1, null, "toggle"]) bad({ type: "pc_permission_set", id: "p2", rowId: ROW, enabled });
  for (const rowId of ["", "p-123", "p-0123456789ABCDEF", "r-0123456789abcdef", `${ROW}0`, 7, "x".repeat(129)]) {
    bad({ type: "pc_permission_set", id: "p2", rowId, enabled: true });
  }
  // Core frames are not client frames.
  bad({ type: "pc_permissions", id: "p1", rows: [], unseen: 0, canManage: true, available: true });
  bad({ type: "pc_permissions_count", unseen: 1 });
  // Existing frames are unchanged.
  assert.deepEqual(ok({ type: "dev_list", id: "d1" }), { type: "dev_list", id: "d1" });
});

// ------------------------------------------------------------------ session

class NoModel implements AgentRunner {
  calls = 0;
  async runTurn(): Promise<TurnResult> {
    this.calls++;
    return { text: "", inputTokens: 1, outputTokens: 1, durationMs: 1, sessionId: "sdk", tools: [] };
  }
}

const SERVICES = parseServices(["services:", "  - name: home-assistant", "    kind: mcp", "    url: http://localhost:1/sse", "    permission: confirm"].join("\n"), {}).services;

let counter = 0;
async function harness(o: { managers?: string[]; device?: string; client?: string; store?: PcPermissionStore | null; dir?: string } = {}) {
  const dir = o.dir ?? join(base, `d${++counter}`);
  const logs: string[] = [];
  const store =
    o.store === null ? undefined : (o.store ?? new PcPermissionStore({ dir: join(dir, "pc"), managers: o.managers ?? ["browser", "android"], log: (m) => logs.push(m) }));
  if (store && !o.store) await store.load();
  const frames: ServerFrame[] = [];
  const session = new Session(
    {
      agent: new NoModel(),
      policy: new PermissionPolicy(SERVICES),
      router: { route: () => ({ model: "m" }) },
      stt: { transcribe: async () => ({ text: "" }) },
      tts: { synthesize: async () => ({ mime: "audio/wav", data: Buffer.from("RIFF") }), voices: async () => ({ default: "v", voices: ["v"] }) },
      log: new ConversationLog(dir),
      logger: quiet,
      ...(store ? { pcPermissions: store } : {}),
    },
    { sessionId: `s${counter}`, device: o.device ?? "browser", ...(o.client ? { client: o.client } : {}) },
    (f) => frames.push(f),
  );
  open.push(session);
  let req = 0;
  type Reply = Extract<ServerFrame, { type: "pc_permissions" }> | Extract<ServerFrame, { type: "error" }>;
  const ask = async (frame: Record<string, unknown>): Promise<Reply> => {
    const id = `p${++req}`;
    const parsed = parseClientFrame(JSON.stringify({ ...frame, id }));
    assert.ok(parsed.ok, "the test sends valid frames");
    await session.handle(parsed.frame);
    const reply = frames.find((f) => (f.type === "pc_permissions" || f.type === "error") && "id" in f && f.id === id);
    assert.ok(reply, `no reply to ${id}`);
    return reply as Reply;
  };
  return { store, session, frames, logs, ask, dir };
}

const codeOf = (r: { type: string; code?: string }) => (r.type === "error" ? r.code : r.type);

test("pc_permissions_list: rows, unseen, canManage per device from the token, available; display fields only", async () => {
  const h = await harness();
  const steam = await h.store!.recordRefusal(STEAM);
  await h.store!.recordRefusal(SHUTDOWN);
  assert.ok(steam.ok);
  const r = await h.ask({ type: "pc_permissions_list" });
  assert.equal(r.type, "pc_permissions");
  if (r.type !== "pc_permissions") return;
  assert.equal(r.available, true);
  assert.equal(r.canManage, true);
  assert.equal(r.unseen, 2);
  assert.equal(r.rows.length, 2);
  const row = r.rows.find((x) => x.rowId === steam.rowId);
  assert.deepEqual(
    { action: row?.action, kind: row?.kind, label: row?.label, enabled: row?.enabled, seen: row?.seen, requests: row?.requests },
    { action: "open_app", kind: "app", label: "Steam", enabled: false, seen: false, requests: 1 },
  );
  const text = JSON.stringify(r);
  for (const secret of ["steam_app_id", '"steam"', "aliases", "browser"]) assert.equal(text.includes(secret), false, secret);
  // Another socket of a device not in the list sees the same rows, canManage false.
  const other = await harness({ dir: h.dir, store: h.store!, device: "tablet" });
  const r2 = await other.ask({ type: "pc_permissions_list" });
  assert.ok(r2.type === "pc_permissions" && r2.canManage === false && r2.rows.length === 2);
});

test("pc_permission_set from a listed device switches the row and answers the fresh list; repeat is harmless", async () => {
  const h = await harness();
  const steam = await h.store!.recordRefusal(STEAM);
  assert.ok(steam.ok);
  const r = await h.ask({ type: "pc_permission_set", rowId: steam.rowId, enabled: true });
  assert.ok(r.type === "pc_permissions");
  if (r.type !== "pc_permissions") return;
  assert.equal(r.rows[0]?.enabled, true);
  assert.equal(r.rows[0]?.seen, true);
  assert.equal(typeof r.rows[0]?.changedAt, "string");
  assert.equal(r.unseen, 0);
  assert.ok(h.logs.some((l) => l.includes(steam.rowId) && l.includes("browser")), "logged with the device");
  const again = await h.ask({ type: "pc_permission_set", rowId: steam.rowId, enabled: true });
  assert.ok(again.type === "pc_permissions" && again.rows[0]?.enabled === true);
  const off = await h.ask({ type: "pc_permission_set", rowId: steam.rowId, enabled: false });
  assert.ok(off.type === "pc_permissions" && off.rows[0]?.enabled === false);
  assert.deepEqual(h.store!.lookup(STEAM), { state: "off", rowId: steam.rowId });
});

test("pc_permission_set outside CORE_PC_PERMISSION_DEVICES, and with it unset, is not_allowed; the row stays off", async () => {
  for (const o of [{ managers: ["browser"], device: "android" }, { managers: [], device: "browser" }, { managers: [], device: "android" }]) {
    const h = await harness(o);
    const steam = await h.store!.recordRefusal(STEAM);
    assert.ok(steam.ok);
    const before = readFileSync(h.store!.file, "utf8");
    const r = await h.ask({ type: "pc_permission_set", rowId: steam.rowId, enabled: true });
    assert.equal(codeOf(r), "not_allowed", JSON.stringify(o));
    assert.equal(readFileSync(h.store!.file, "utf8"), before);
    assert.deepEqual(h.store!.lookup(STEAM), { state: "off", rowId: steam.rowId });
    const list = await h.ask({ type: "pc_permissions_list" });
    assert.ok(list.type === "pc_permissions" && list.canManage === false);
  }
});

test("the device is the token's: hello.client naming a listed device does not help", async () => {
  const h = await harness({ managers: ["browser"], device: "android", client: "browser" });
  const steam = await h.store!.recordRefusal(STEAM);
  assert.ok(steam.ok);
  assert.equal(codeOf(await h.ask({ type: "pc_permission_set", rowId: steam.rowId, enabled: true })), "not_allowed");
});

test("pc_permission_set: unknown row → unknown_item; pc_permissions_seen from any device marks everything seen", async () => {
  const h = await harness({ managers: [] });
  await h.store!.recordRefusal(STEAM);
  await h.store!.recordRefusal(SHUTDOWN);
  const h2 = await harness({ dir: h.dir, store: h.store!, device: "browser", managers: ["browser"] });
  const tmp = await harness({ managers: ["browser"] });
  assert.equal(codeOf(await tmp.ask({ type: "pc_permission_set", rowId: ROW, enabled: true })), "unknown_item");
  // Seen is open to an unlisted device (it does not change what the PC does).
  const seen = await h.ask({ type: "pc_permissions_seen" });
  assert.ok(seen.type === "pc_permissions");
  if (seen.type !== "pc_permissions") return;
  assert.equal(seen.unseen, 0);
  assert.ok(seen.rows.every((r) => r.seen && !r.enabled), "seen never switches anything");
  const list = await h2.ask({ type: "pc_permissions_list" });
  assert.ok(list.type === "pc_permissions" && list.unseen === 0);
});

test("unavailable store (corrupt file): list answers available:false; set and seen → pc_permissions_unavailable; nothing written", async () => {
  const dir = join(base, `d${++counter}`);
  mkdirSync(join(dir, "pc"), { recursive: true });
  writeFileSync(join(dir, "pc", PC_PERMISSIONS_FILE), "{corrupt");
  const h = await harness({ dir });
  assert.equal(h.store!.available, false);
  const names = readdirSync(join(dir, "pc")).sort();
  const list = await h.ask({ type: "pc_permissions_list" });
  assert.deepEqual(list, { type: "pc_permissions", id: list.id, rows: [], unseen: 0, canManage: true, available: false });
  assert.equal(codeOf(await h.ask({ type: "pc_permission_set", rowId: ROW, enabled: true })), "pc_permissions_unavailable");
  assert.equal(codeOf(await h.ask({ type: "pc_permissions_seen" })), "pc_permissions_unavailable");
  // An unlisted device is told not_allowed first (no hint about the store).
  const unlisted = await harness({ dir, store: h.store!, device: "tablet" });
  assert.equal(codeOf(await unlisted.ask({ type: "pc_permission_set", rowId: ROW, enabled: true })), "not_allowed");
  assert.deepEqual(readdirSync(join(dir, "pc")).sort(), names, "nothing written");
});

test("without the store (feature off) every pc frame is bad_request", async () => {
  const h = await harness({ store: null });
  for (const f of [{ type: "pc_permissions_list" }, { type: "pc_permissions_seen" }, { type: "pc_permission_set", rowId: ROW, enabled: true }]) {
    assert.equal(codeOf(await h.ask(f)), "bad_request");
  }
});

// ------------------------------------------------------------------ server

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

function getFrom(server: ReturnType<typeof createCoreServer>, path: string, remoteAddress: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const req = { method: "GET", url: path, headers: {}, socket: { remoteAddress } } as unknown as IncomingMessage;
    const res = {
      headersSent: false,
      writeHead() {
        return this;
      },
      end(chunk?: string) {
        resolve(JSON.parse(chunk ?? "{}") as Record<string, unknown>);
      },
    } as unknown as ServerResponse;
    server.http.emit("request", req, res);
  });
}

test("server: pc_permissions_count reaches every authenticated socket when the unseen count changes; feature in welcome; inbox.pc loopback only", async () => {
  const store = new PcPermissionStore({ dir: join(base, `d${++counter}`, "pc"), managers: ["browser"] });
  await store.load();
  const server = createCoreServer({
    tokens: loadDeviceTokens({ DEVICE_TOKEN_BROWSER: TOKEN, DEVICE_TOKEN_ANDROID: `${TOKEN}-2` }),
    logger: quiet,
    pcPermissionsCount: store,
    features: ["dev", "pc_permissions"],
    inbox: () => ({ dev: 0, pc: store.unseen }),
    createSession: (info) => ({ info, handle: async () => {}, close: async () => {} }) as unknown as Session,
  });
  const { port } = await server.listen(0, "127.0.0.1");
  try {
    const anon = await wsClient(port);
    const a = await wsClient(port);
    const b = await wsClient(port);
    a.ws.send(JSON.stringify({ type: "hello", protocol: 1, token: TOKEN, client: "web" }));
    b.ws.send(JSON.stringify({ type: "hello", protocol: 1, token: `${TOKEN}-2`, client: "android" }));
    const [welcome] = await a.wait(1, "welcome");
    assert.ok(welcome?.type === "welcome" && welcome.features?.includes("pc_permissions"));
    await b.wait(1, "state");
    await store.recordRefusal(STEAM);
    assert.deepEqual((await a.wait(1, "pc_permissions_count"))[0], { type: "pc_permissions_count", unseen: 1 });
    assert.deepEqual((await b.wait(1, "pc_permissions_count"))[0], { type: "pc_permissions_count", unseen: 1 });
    await store.recordRefusal(STEAM); // same row: no new count
    await store.markAllSeen();
    assert.deepEqual((await a.wait(2, "pc_permissions_count"))[1], { type: "pc_permissions_count", unseen: 0 });
    assert.equal(a.frames.filter((f) => f.type === "pc_permissions_count").length, 2);
    assert.equal(anon.frames.length, 0);
    // /health: `inbox.pc` for loopback only.
    await store.recordRefusal(SHUTDOWN);
    assert.deepEqual((await getFrom(server, "/health", "127.0.0.1")).inbox, { dev: 0, pc: 1 });
    assert.deepEqual((await getFrom(server, "/health", "::1")).inbox, { dev: 0, pc: 1 });
    for (const remote of ["192.0.2.10", "::ffff:192.0.2.10"]) assert.equal("inbox" in (await getFrom(server, "/health", remote)), false);
    anon.ws.close();
    a.ws.close();
    b.ws.close();
  } finally {
    await server.close();
  }
  // close() unsubscribed: a later change reaches nobody (and does not throw).
  await store.recordRefusal({ ...STEAM, id: "other_app" });
});
