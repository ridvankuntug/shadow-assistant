/**
 * T7.w.11.5 / T7.w.11.6: HA alerts (docs/09 (c)): the read-only HA WebSocket client
 * and the persistent-notification + repairs producer, against a local fake HA WebSocket server on
 * 127.0.0.1 (never a real HA). Backoff timers and the producer's retry timer are
 * fake; the sockets are real.
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import {
  HA_BACKOFF_MAX_MS,
  HaClient,
  haBackoffMs,
  haWebSocketUrl,
  READ_ONLY_COMMANDS,
  type HaConnection,
  type HaTimers,
} from "../src/ha-client.js";
import {
  HA_ACCESS_KEY,
  HA_REPAIRS_POLL_MS,
  HA_RESOLVE_GRACE_MS,
  HA_SOURCE,
  HaAlertsProducer,
  clipText,
  createHaAlerts,
  haAlertType,
  haAlertsSettings,
  pnKey,
  repairKey,
  repairOf,
  type HaNotificationPort,
  type HaUrgencyPort,
} from "../src/ha-producer.js";
import { AUTH_HOLD_START_MS, AuthGate } from "../src/auth-gate.js";
import { MAX_BODY_CHARS, MAX_KEY_CHARS, MAX_TITLE_CHARS, type NotificationItem, type RaiseInput, type RaiseResult } from "../src/notifications.js";

const TOKEN = "test-token-not-real";

type Notif = { notification_id: string; title: string | null; message: string; created_at: string };
const notif = (id: string, title: string | null, message = `${id} body`): Notif => ({
  notification_id: id,
  title,
  message,
  created_at: "2026-11-13T10:00:00+00:00",
});

type Issue = Record<string, unknown>;
/** A `repairs/list_issues` entry as HA sends it. */
const issue = (domain: string, issueId: string, o: Issue = {}): Issue => ({
  breaks_in_ha_version: null,
  created: "2026-11-13T10:00:00+00:00",
  dismissed_version: null,
  domain,
  ignored: false,
  is_fixable: false,
  issue_domain: null,
  issue_id: issueId,
  learn_more_url: null,
  severity: "warning",
  translation_key: issueId,
  translation_placeholders: null,
  ...o,
});

/** A fake HA WebSocket API: auth + persistent_notification/subscribe + repairs/list_issues, events pushed by the test. */
class FakeHa {
  readonly wss: WebSocketServer;
  readonly notifications = new Map<string, Notif>();
  /** Every message the clients sent, in order. */
  readonly received: Array<Record<string, unknown>> = [];
  acceptToken = true;
  /** Answer the subscription with success: false. */
  refuseSubscribe = false;
  /** repairs/list_issues answers `{issues}`, or this error code, or `repairsResult` as the raw result. */
  issues: Issue[] = [];
  repairsError: string | undefined;
  repairsResult: unknown;
  /** Never answer repairs/list_issues (the request stays pending until the socket dies). */
  holdRepairs = false;
  connections = 0;
  private readonly subs = new Map<WebSocket, number>();

  constructor() {
    this.wss = new WebSocketServer({ host: "127.0.0.1", port: 0, path: "/api/websocket" });
    this.wss.on("connection", (ws) => {
      this.connections++;
      ws.send(JSON.stringify({ type: "auth_required", ha_version: "2026.11.0" }));
      ws.on("message", (data) => {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        this.received.push(msg);
        if (msg.type === "auth") {
          if (msg.access_token === TOKEN && this.acceptToken) ws.send(JSON.stringify({ type: "auth_ok", ha_version: "2026.11.0" }));
          else {
            ws.send(JSON.stringify({ type: "auth_invalid", message: "Invalid access token or password" }));
            ws.close();
          }
        } else if (msg.type === "persistent_notification/subscribe") {
          const id = msg.id as number;
          if (this.refuseSubscribe) {
            ws.send(JSON.stringify({ id, type: "result", success: false, error: { code: "unknown_command", message: "Unknown command." } }));
            return;
          }
          this.subs.set(ws, id);
          ws.send(JSON.stringify({ id, type: "result", success: true, result: null }));
          this.event(ws, "current", [...this.notifications.values()]);
        } else if (msg.type === "repairs/list_issues") {
          const id = msg.id as number;
          if (this.holdRepairs) return;
          if (this.repairsError) {
            ws.send(JSON.stringify({ id, type: "result", success: false, error: { code: this.repairsError, message: "Unauthorized" } }));
            return;
          }
          const result = this.repairsResult !== undefined ? this.repairsResult : { issues: this.issues };
          ws.send(JSON.stringify({ id, type: "result", success: true, result }));
        }
      });
      ws.on("close", () => this.subs.delete(ws));
    });
  }

  async ready(): Promise<string> {
    if (!this.wss.address()) await new Promise((r) => this.wss.once("listening", r));
    return `http://127.0.0.1:${(this.wss.address() as AddressInfo).port}`;
  }

  event(ws: WebSocket, type: string, list: Notif[] | Record<string, unknown>): void {
    const notifications = Array.isArray(list) ? Object.fromEntries(list.map((n) => [n.notification_id, n])) : list;
    ws.send(JSON.stringify({ id: this.subs.get(ws), type: "event", event: { type, notifications } }));
  }

  /** Pushes an event to every subscriber (and updates the server's set). */
  push(type: "added" | "updated" | "removed", n: Notif): void {
    if (type === "removed") this.notifications.delete(n.notification_id);
    else this.notifications.set(n.notification_id, n);
    for (const ws of this.subs.keys()) this.event(ws, type, [n]);
  }

  /** Raw event to every subscriber. */
  raw(event: unknown): void {
    for (const [ws, id] of this.subs) ws.send(JSON.stringify({ id, type: "event", event }));
  }

  get subscribers(): number {
    return this.subs.size;
  }

  dropAll(): void {
    for (const ws of this.wss.clients) ws.terminate();
  }

  async close(): Promise<void> {
    for (const ws of this.wss.clients) ws.terminate();
    await new Promise((r) => this.wss.close(r));
  }

  commandTypes(): string[] {
    return this.received.map((m) => String(m.type));
  }

  get repairsLists(): number {
    return this.received.filter((m) => m.type === "repairs/list_issues").length;
  }
}

type Stored = Pick<NotificationItem, "source" | "key" | "urgency" | "title" | "body">;

class FakeCenter implements HaNotificationPort {
  readonly raises: RaiseInput[] = [];
  readonly resolves: string[] = [];
  readonly items = new Map<string, Stored>();
  suppressedKeys: Array<{ source: string; key: string }> = [];
  unavailable = false;
  /** Sync markers (`pn:sync-*`, see `sync()`): seen, not recorded as items. */
  readonly syncs = new Set<string>();
  async raise(input: RaiseInput): Promise<RaiseResult> {
    if (this.unavailable) return { ok: false, reason: "unavailable" };
    if (input.key?.startsWith("pn:sync-")) {
      this.syncs.add(input.key);
      return { ok: true, item: { id: "n-0" } as NotificationItem, created: true };
    }
    this.raises.push(input);
    if (this.suppressedKeys.some((s) => s.source === input.source && s.key === input.key)) return { ok: false, reason: "suppressed" };
    const prev = this.items.get(input.key ?? "");
    const item = { source: input.source, key: input.key, urgency: input.urgency ?? "normal", title: input.title, body: input.body ?? "" };
    this.items.set(input.key ?? "", item);
    return { ok: true, item: { ...item, id: "n-0", createdAt: "", updatedAt: "", readAt: null, raised: 1 } as NotificationItem, created: !prev };
  }
  async resolve(source: string, key: string): Promise<boolean> {
    if (this.unavailable) throw new Error("unavailable");
    if (key.startsWith("pn:sync-")) return true;
    this.resolves.push(key);
    this.suppressedKeys = this.suppressedKeys.filter((s) => !(s.source === source && s.key === key));
    return this.items.delete(key);
  }
  async list(): Promise<Stored[]> {
    if (this.unavailable) throw new Error("unavailable");
    return [...this.items.values()];
  }
  async suppressed(): Promise<Array<{ source: string; key: string }>> {
    return [...this.suppressedKeys];
  }
}

/** Fake timers: nothing fires by itself. */
class FakeTimers implements HaTimers {
  private seq = 0;
  readonly pending = new Map<number, { ms: number; fn: () => void }>();
  /** Every delay ever set, in order. */
  readonly delays: number[] = [];
  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.pending.set(id, { ms, fn });
    this.delays.push(ms);
    return id;
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  /** Fires the pending timers whose delay is at most `maxMs`. */
  fire(maxMs = HA_BACKOFF_MAX_MS * 2): number {
    let n = 0;
    for (const [id, t] of [...this.pending]) {
      if (t.ms > maxMs) continue;
      this.pending.delete(id);
      t.fn();
      n++;
    }
    return n;
  }
}

async function waitFor(cond: () => boolean, what: string, ms = 3_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Lets in-flight socket messages and producer rounds finish. */
async function settle(producer?: HaAlertsProducer): Promise<void> {
  for (let k = 0; k < 5; k++) {
    await new Promise((r) => setTimeout(r, 10));
    await producer?.idle();
  }
}

const AUTH_TIMEOUT = 9_999_999;

async function setup(o: { center?: FakeCenter; ha?: FakeHa; token?: string; urgency?: HaUrgencyPort; authGate?: AuthGate } = {}) {
  const ha = o.ha ?? new FakeHa();
  const base = await ha.ready();
  const center = o.center ?? new FakeCenter();
  const logs: string[] = [];
  const logger = { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) };
  const producerTimers = new FakeTimers();
  const clientTimers = new FakeTimers();
  const clock = { now: Date.parse("2026-11-13T12:00:00.000Z") };
  const producer = new HaAlertsProducer({ notifications: center, logger, timers: producerTimers, now: () => clock.now, urgency: o.urgency });
  const client = new HaClient({
    url: haWebSocketUrl(base)!,
    token: o.token ?? TOKEN,
    logger,
    handlers: producer,
    timers: clientTimers,
    random: () => 0.5,
    heartbeatMs: 0,
    authTimeoutMs: AUTH_TIMEOUT,
    authGate: o.authGate,
  });
  producer.start();
  client.start();
  const close = async () => {
    await client.close();
    await producer.close();
    await ha.close();
  };
  /** Fires the client's reconnect timer (not the auth timeout). */
  const reconnect = () => clientTimers.fire(HA_BACKOFF_MAX_MS * 2);
  let syncs = 0;
  /** Waits until every event HA sent before now has been reconciled (a marker notification goes through after them). */
  const sync = async () => {
    const id = `sync-${++syncs}`;
    ha.push("added", notif(id, "sync"));
    await waitFor(() => center.syncs.has(`pn:${id}`), id);
    await producer.idle();
  };
  /** Ends the resolve grace of the last `current`. */
  const passGrace = async () => {
    await sync();
    clock.now += HA_RESOLVE_GRACE_MS;
    producerTimers.fire(HA_RESOLVE_GRACE_MS);
    await settle(producer);
  };
  const pollArmed = () => [...producerTimers.pending.values()].some((p) => p.ms === HA_REPAIRS_POLL_MS);
  /** Waits until a repairs list was answered and reconciled (the next poll is armed after each answer). */
  const repairsDone = async () => {
    await waitFor(pollArmed, "repairs list answered");
    await producer.idle();
    await settle(producer);
  };
  /** 10 minutes pass: the repairs poll fires; waits for its answer. */
  const poll = async () => {
    await repairsDone();
    const before = ha.repairsLists;
    clock.now += HA_REPAIRS_POLL_MS;
    for (const [id, p] of [...producerTimers.pending]) {
      if (p.ms !== HA_REPAIRS_POLL_MS) continue;
      producerTimers.pending.delete(id);
      p.fn();
    }
    await waitFor(() => ha.repairsLists === before + 1, "repairs polled");
    await repairsDone();
  };
  return { ha, center, logs, producer, client, producerTimers, clientTimers, clock, close, reconnect, sync, passGrace, pollArmed, repairsDone, poll };
}

test("haWebSocketUrl: ws/wss from HA_URL, path prefix kept, query dropped; bad URLs refused", () => {
  assert.equal(haWebSocketUrl("http://ha.example:8123"), "ws://ha.example:8123/api/websocket");
  assert.equal(haWebSocketUrl("https://ha.example/"), "wss://ha.example/api/websocket");
  assert.equal(haWebSocketUrl(" https://ha.example/prefix/?x=1#y "), "wss://ha.example/prefix/api/websocket");
  assert.equal(haWebSocketUrl("ws://ha.example"), "ws://ha.example/api/websocket");
  assert.equal(haWebSocketUrl("ftp://ha.example"), undefined);
  assert.equal(haWebSocketUrl("not a url"), undefined);
  assert.equal(haWebSocketUrl(""), undefined);
});

test("haAlertsSettings / createHaAlerts: off without HA_URL or HA_CORE_TOKEN (one info line, nothing raised)", async () => {
  assert.deepEqual(haAlertsSettings({}), { off: "HA_URL or HA_CORE_TOKEN not set" });
  assert.deepEqual(haAlertsSettings({ HA_URL: "http://ha.example", HA_CORE_TOKEN: "  " }), { off: "HA_URL or HA_CORE_TOKEN not set" });
  assert.deepEqual(haAlertsSettings({ HA_URL: "", HA_CORE_TOKEN: "x" }), { off: "HA_URL or HA_CORE_TOKEN not set" });
  assert.deepEqual(haAlertsSettings({ HA_URL: "nope", HA_CORE_TOKEN: "x" }), { off: "HA_URL is not an http(s) URL" });
  assert.deepEqual(haAlertsSettings({ HA_URL: "http://ha.example", HA_CORE_TOKEN: " x " }), { url: "ws://ha.example/api/websocket", token: "x" });
  const center = new FakeCenter();
  const logs: string[] = [];
  const alerts = createHaAlerts({ env: { HA_URL: "http://ha.example" }, notifications: center, logger: { info: (m) => logs.push(m), warn: (m) => logs.push(`W ${m}`) } });
  assert.equal(alerts, undefined);
  assert.deepEqual(logs, ["[shadow-core] ha alerts: off (HA_URL or HA_CORE_TOKEN not set)"]);
  assert.equal(center.raises.length, 0);
});

test("pnKey: pn:<id> up to the store's key limit, sha256 beyond; clipText cuts like the store", () => {
  assert.equal(pnKey("config_entry_discovery"), "pn:config_entry_discovery");
  const fits = "a".repeat(MAX_KEY_CHARS - 3);
  assert.equal(pnKey(fits), `pn:${fits}`);
  const long = "b".repeat(MAX_KEY_CHARS - 2);
  const k = pnKey(long);
  assert.match(k, /^pn:sha256:[0-9a-f]{64}$/);
  assert.ok(k.length <= MAX_KEY_CHARS);
  assert.equal(pnKey(long), k, "stable");
  assert.notEqual(pnKey(`${long}c`), k);
  assert.equal(clipText("  x  ", 10), "x");
  assert.equal(clipText(`${"a".repeat(4)}\u{1F600}`, 5), "aaaa", "no half surrogate pair");
  assert.equal(haAlertType({ kind: "pn", id: "http-login" }), "pn:http-login");
  assert.deepEqual([...READ_ONLY_COMMANDS], ["persistent_notification/subscribe", "repairs/list_issues"]);
});

test("haBackoffMs: 1 → 2 → 4 … → 60 s, ± 20 % jitter", () => {
  const mid = Array.from({ length: 9 }, (_, n) => haBackoffMs(n, () => 0.5));
  assert.deepEqual(mid, [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  assert.equal(haBackoffMs(0, () => 0), 800);
  assert.equal(haBackoffMs(0, () => 1), 1_200);
  assert.equal(haBackoffMs(10, () => 1), 72_000);
  assert.equal(haBackoffMs(1_000, () => 0.5), 60_000, "no overflow");
  assert.equal(haBackoffMs(0, () => Number.NaN), 1_000);
});

test("auth ok + current set: items raised (normal, pn: keys); only auth and the read-only subscribe are sent", async () => {
  const ha = new FakeHa();
  ha.notifications.set("a", notif("a", "Yeni cihaz bulundu"));
  ha.notifications.set("b", notif("b", null, "  gövde  "));
  const t = await setup({ ha });
  try {
    await waitFor(() => t.center.raises.length === 2, "two raises");
    await settle(t.producer);
    const byKey = new Map(t.center.raises.map((r) => [r.key, r]));
    assert.deepEqual(byKey.get("pn:a"), { source: HA_SOURCE, key: "pn:a", urgency: "normal", title: "Yeni cihaz bulundu", body: "a body", renotify: true });
    assert.deepEqual(byKey.get("pn:b"), { source: HA_SOURCE, key: "pn:b", urgency: "normal", title: "Home Assistant bildirimi", body: "gövde", renotify: true });
    await t.repairsDone();
    assert.deepEqual(t.ha.commandTypes(), ["auth", "persistent_notification/subscribe", "repairs/list_issues"]);
    assert.equal(t.ha.received[0]!.access_token, TOKEN);
    for (const line of t.logs) {
      assert.ok(!line.includes(TOKEN), "token never logged");
      assert.ok(!line.includes("Yeni cihaz") && !line.includes("gövde") && !line.includes("127.0.0.1"), `no text/host in logs: ${line}`);
    }
  } finally {
    await t.close();
  }
});

test("added / updated / removed: new item, update without renotify, unchanged writes nothing, removed resolves", async () => {
  const ha = new FakeHa();
  ha.notifications.set("a", notif("a", "A"));
  const t = await setup({ ha });
  try {
    await waitFor(() => t.center.raises.length === 1 && t.ha.subscribers === 1, "first raise");
    t.ha.push("added", notif("c", "C"));
    await waitFor(() => t.center.raises.length === 2, "added");
    assert.deepEqual(t.center.raises[1], { source: HA_SOURCE, key: "pn:c", urgency: "normal", title: "C", body: "c body", renotify: true });
    t.ha.push("updated", notif("c", "C2", "new body"));
    await waitFor(() => t.center.raises.length === 3, "updated");
    assert.deepEqual(t.center.raises[2], { source: HA_SOURCE, key: "pn:c", urgency: "normal", title: "C2", body: "new body", renotify: false });
    t.ha.push("updated", notif("c", "C2", "new body"));
    await t.sync();
    assert.equal(t.center.raises.length, 3, "an unchanged update writes nothing");
    t.ha.push("removed", notif("a", "A"));
    await waitFor(() => t.center.resolves.length === 1, "removed");
    assert.deepEqual(t.center.resolves, ["pn:a"]);
    assert.deepEqual([...t.center.items.keys()], ["pn:c"]);
  } finally {
    await t.close();
  }
});

test("disconnect resolves nothing; a reconnect with a smaller set resolves the missing id only", async () => {
  const ha = new FakeHa();
  ha.notifications.set("a", notif("a", "A"));
  ha.notifications.set("b", notif("b", "B"));
  const t = await setup({ ha });
  try {
    await waitFor(() => t.center.raises.length === 2, "initial");
    t.ha.dropAll();
    await waitFor(() => t.clientTimers.pending.size === 1, "reconnect scheduled");
    await settle(t.producer);
    assert.deepEqual(t.center.resolves, [], "a lost connection is never an empty list");
    assert.equal(t.center.items.size, 2);
    // HA lost `b` meanwhile (no event reached us).
    t.ha.notifications.delete("b");
    assert.equal(t.reconnect(), 1);
    await t.sync();
    assert.deepEqual(t.center.resolves, [], "not before the resolve grace");
    t.clock.now += HA_RESOLVE_GRACE_MS - 1;
    t.producerTimers.fire(HA_RESOLVE_GRACE_MS);
    await settle(t.producer);
    assert.deepEqual(t.center.resolves, [], "59.999 s: still waiting");
    t.clock.now += 1;
    t.producerTimers.fire(HA_RESOLVE_GRACE_MS);
    await waitFor(() => t.center.resolves.length === 1, "resolve after the complete listing");
    await settle(t.producer);
    assert.deepEqual(t.center.resolves, ["pn:b"]);
    assert.equal(t.center.raises.length, 2, "unchanged `a` not raised again");
    assert.equal(t.ha.connections, 2);
  } finally {
    await t.close();
  }
});

test("auth_invalid → one normal ha:access item; resolved on the next good connect", async () => {
  const ha = new FakeHa();
  ha.acceptToken = false;
  ha.notifications.set("a", notif("a", "A"));
  const t = await setup({ ha });
  try {
    await waitFor(() => t.center.raises.length === 1, "ha:access");
    assert.deepEqual(t.center.raises[0], {
      source: HA_SOURCE,
      key: HA_ACCESS_KEY,
      urgency: "normal",
      title: "HA uyarıları okunamıyor",
      body: t.center.raises[0]!.body,
      renotify: true,
    });
    // A second rejection does not raise again.
    await waitFor(() => t.clientTimers.pending.size === 1, "reconnect scheduled");
    t.reconnect();
    await waitFor(() => t.ha.connections === 2 && t.clientTimers.pending.size === 1, "second attempt");
    await settle(t.producer);
    assert.equal(t.center.raises.length, 1);
    assert.equal(t.logs.filter((l) => l.includes("auth_invalid")).length, 1, "logged once per streak");
    t.ha.acceptToken = true;
    t.reconnect();
    await waitFor(() => t.center.resolves.includes(HA_ACCESS_KEY) && t.center.items.has("pn:a"), "resolved + listed");
    assert.deepEqual(t.center.resolves, [HA_ACCESS_KEY]);
    assert.ok(t.ha.commandTypes().every((c) => READ_ONLY_COMMANDS.has(c) || c === "auth"));
  } finally {
    await t.close();
  }
});

test("auth_invalid with a shared gate (T20.1): reconnect waits the hold, one probe per hold, an acceptance elsewhere reconnects at once", async () => {
  const ha = new FakeHa();
  ha.acceptToken = false;
  ha.notifications.set("a", notif("a", "A"));
  const gclock = { now: 0 };
  const gate = new AuthGate(() => gclock.now);
  const t = await setup({ ha, authGate: gate });
  const all = Number.MAX_SAFE_INTEGER;
  const lastDelay = () => t.clientTimers.delays.filter((d) => d !== AUTH_TIMEOUT).at(-1);
  try {
    await waitFor(() => t.center.raises.length === 1 && t.clientTimers.pending.size === 1, "ha:access + reconnect scheduled");
    assert.equal(t.center.raises[0]!.key, HA_ACCESS_KEY);
    assert.equal(gate.rejected, true);
    assert.equal(lastDelay(), AUTH_HOLD_START_MS, "the next attempt waits the hold, not the 1 s backoff");
    // The timer fires early (the hold is not over by the gate's clock): no connection, the wait starts again.
    t.clientTimers.fire(all);
    await settle(t.producer);
    assert.equal(t.ha.connections, 1);
    assert.equal(t.clientTimers.pending.size, 1);
    assert.equal(lastDelay(), AUTH_HOLD_START_MS);
    // Hold over: one probe, rejected again → twice the hold.
    gclock.now += AUTH_HOLD_START_MS;
    t.clientTimers.fire(all);
    await waitFor(() => t.ha.connections === 2 && lastDelay() === 2 * AUTH_HOLD_START_MS, "probe rejected, next hold doubled");
    assert.equal(t.ha.received.filter((m) => m.type === "auth").length, 2, "two tokens sent in all");
    await settle(t.producer);
    assert.equal(t.center.raises.length, 1, "ha:access not raised again");
    // The health check saw the token accepted (HA side fixed): the client reconnects with the normal backoff.
    t.ha.acceptToken = true;
    gate.accepted();
    assert.equal(t.clientTimers.pending.size, 1);
    assert.ok((lastDelay() ?? all) <= 60_000 * 1.2, "back to the backoff");
    t.reconnect();
    await waitFor(() => t.center.resolves.includes(HA_ACCESS_KEY) && t.center.items.has("pn:a"), "resolved + listed");
    assert.equal(gate.rejected, false);
  } finally {
    await t.close();
  }
});

test("shared gate (T20.1): a WebSocket attempt that fails before auth_required leaves the probe to the health check", async () => {
  const probe = new FakeHa();
  const dead = await probe.ready();
  await probe.close();
  const gclock = { now: 0 };
  const gate = new AuthGate(() => gclock.now);
  gate.rejectedNow();
  const timers = new FakeTimers();
  const client = new HaClient({
    url: haWebSocketUrl(dead)!,
    token: TOKEN,
    logger: { info: () => {}, warn: () => {} },
    handlers: { onConnected: () => {}, onDisconnected: () => {}, onAuthInvalid: () => {} },
    timers,
    random: () => 0.5,
    heartbeatMs: 0,
    authTimeoutMs: AUTH_TIMEOUT,
    authGate: gate,
  });
  try {
    client.start();
    await waitFor(() => timers.pending.size === 1, "held off");
    gclock.now += AUTH_HOLD_START_MS;
    timers.fire(Number.MAX_SAFE_INTEGER);
    await waitFor(() => timers.delays.filter((d) => d !== AUTH_TIMEOUT).length === 2, "refused, retry scheduled");
    assert.equal(gate.waitMs(), 0, "the probe was not claimed");
    assert.equal(gate.tryAttempt(), true, "the health check can still probe");
  } finally {
    await client.close();
  }
});

test("shared gate (T20.1): the gate closes while a WebSocket attempt fails before auth_required → onAuthInvalid at once, only once", async () => {
  const probe = new FakeHa();
  const dead = await probe.ready();
  await probe.close();
  const gclock = { now: 0 };
  const gate = new AuthGate(() => gclock.now);
  const timers = new FakeTimers();
  let authInvalid = 0;
  const warns: string[] = [];
  const client = new HaClient({
    url: haWebSocketUrl(dead)!,
    token: TOKEN,
    logger: { info: () => {}, warn: (m: string) => warns.push(m) },
    handlers: { onConnected: () => {}, onDisconnected: () => {}, onAuthInvalid: () => authInvalid++ },
    timers,
    random: () => 0.5,
    heartbeatMs: 0,
    authTimeoutMs: AUTH_TIMEOUT,
    authGate: gate,
  });
  try {
    client.start();
    // The socket is already opening (the gate was open); the health check sees the rejection meanwhile.
    gate.rejectedNow();
    await waitFor(() => timers.pending.size === 1, "refused, reconnect scheduled");
    assert.equal(timers.delays.filter((d) => d !== AUTH_TIMEOUT).at(-1), AUTH_HOLD_START_MS, "the reconnect waits the hold");
    assert.equal(authInvalid, 1, "handlers told at once, not a hold later");
    assert.equal(warns.filter((l) => l.includes("held off")).length, 1);
    // The timer fires before the hold is over: held off again, nothing repeated.
    timers.fire(Number.MAX_SAFE_INTEGER);
    await waitFor(() => timers.pending.size === 1, "held off again");
    assert.equal(authInvalid, 1, "not told twice");
    assert.equal(warns.filter((l) => l.includes("held off")).length, 1, "logged once");
  } finally {
    await client.close();
  }
});

test("token rejected by the health check first (shared gate): the client does not connect and reports auth_invalid once", async () => {
  const ha = new FakeHa();
  ha.notifications.set("a", notif("a", "A"));
  const gclock = { now: 0 };
  const gate = new AuthGate(() => gclock.now);
  gate.rejectedNow();
  const t = await setup({ ha, authGate: gate });
  try {
    await waitFor(() => t.center.raises.length === 1, "ha:access");
    assert.equal(t.center.raises[0]!.key, HA_ACCESS_KEY);
    assert.equal(t.ha.connections, 0, "no connection, no token sent");
    t.clientTimers.fire(Number.MAX_SAFE_INTEGER);
    await settle(t.producer);
    assert.equal(t.ha.connections, 0);
    assert.equal(t.center.raises.length, 1);
    assert.equal(t.logs.filter((l) => l.includes("held off")).length, 1, "logged once");
    assert.ok(t.logs.every((l) => !l.includes(TOKEN) && !l.includes("127.0.0.1")));
    // Accepted by the health check: the client connects and the item resolves.
    gate.accepted();
    t.reconnect();
    await waitFor(() => t.center.resolves.includes(HA_ACCESS_KEY) && t.center.items.has("pn:a"), "resolved + listed");
    assert.equal(t.ha.connections, 1);
  } finally {
    await t.close();
  }
});

test("client backoff: refused connections wait 1, 2, 4 s; a successful command result starts it over", async () => {
  // A port with nothing listening.
  const probe = new FakeHa();
  const dead = await probe.ready();
  await probe.close();
  const timers = new FakeTimers();
  const logs: string[] = [];
  let connected = 0;
  const client = new HaClient({
    url: haWebSocketUrl(dead)!,
    token: TOKEN,
    logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
    handlers: { onConnected: () => connected++, onDisconnected: () => {}, onAuthInvalid: () => {} },
    timers,
    random: () => 0.5,
    heartbeatMs: 0,
    authTimeoutMs: AUTH_TIMEOUT,
  });
  try {
    client.start();
    const backoff = () => timers.delays.filter((d) => d !== AUTH_TIMEOUT);
    await waitFor(() => backoff().length === 1, "first retry");
    timers.fire();
    await waitFor(() => backoff().length === 2, "second retry");
    timers.fire();
    await waitFor(() => backoff().length === 3, "third retry");
    assert.deepEqual(backoff(), [1_000, 2_000, 4_000]);
    assert.equal(logs.filter((l) => l.includes("connection error")).length, 1, "one warning per outage");
    assert.ok(logs.every((l) => !l.includes("127.0.0.1")), "no host in logs");
    assert.equal(connected, 0);
  } finally {
    await client.close();
  }
  assert.equal(timers.pending.size, 0, "close stops reconnecting");

  // Healthy connection: after the subscribe result the next drop waits 1 s again.
  const ha = new FakeHa();
  const t = await setup({ ha });
  try {
    await waitFor(() => t.ha.subscribers === 1, "subscribed");
    t.ha.dropAll();
    await waitFor(() => t.clientTimers.pending.size === 1, "retry 1");
    t.ha.refuseSubscribe = true; // auth ok, but no successful command: the backoff keeps growing
    t.reconnect();
    await waitFor(() => t.clientTimers.delays.filter((d) => d !== AUTH_TIMEOUT).length === 2, "retry 2");
    t.ha.refuseSubscribe = false;
    t.reconnect();
    await waitFor(() => t.ha.subscribers === 1, "subscribed again");
    t.ha.dropAll();
    await waitFor(() => t.clientTimers.delays.filter((d) => d !== AUTH_TIMEOUT).length === 3, "retry 3");
    assert.deepEqual(t.clientTimers.delays.filter((d) => d !== AUTH_TIMEOUT), [1_000, 2_000, 1_000]);
    assert.ok(t.logs.some((l) => l.includes("subscription refused (unknown_command)")));
  } finally {
    await t.close();
  }
});

test("long notification ids are hashed; title/body cut to the store limits", async () => {
  const ha = new FakeHa();
  const longId = `x${"y".repeat(300)}`;
  ha.notifications.set(longId, notif(longId, "T".repeat(500), "B".repeat(5_000)));
  const t = await setup({ ha });
  try {
    await waitFor(() => t.center.raises.length === 1, "raise");
    const r = t.center.raises[0]!;
    assert.equal(r.key, pnKey(longId));
    assert.match(r.key!, /^pn:sha256:[0-9a-f]{64}$/);
    assert.equal(r.title.length, MAX_TITLE_CHARS);
    assert.equal(r.body!.length, MAX_BODY_CHARS);
    t.ha.push("removed", notif(longId, null));
    await waitFor(() => t.center.resolves.length === 1, "resolve");
    assert.deepEqual(t.center.resolves, [pnKey(longId)]);
  } finally {
    await t.close();
  }
});

test("startup adoption: open ha items count as open; unchanged ones are not re-raised, ended ones resolved", async () => {
  const center = new FakeCenter();
  center.items.set("pn:a", { source: HA_SOURCE, key: "pn:a", urgency: "normal", title: "A", body: "a body" });
  center.items.set("pn:old", { source: HA_SOURCE, key: "pn:old", urgency: "normal", title: "Old", body: "" });
  center.items.set(HA_ACCESS_KEY, { source: HA_SOURCE, key: HA_ACCESS_KEY, urgency: "normal", title: "HA uyarıları okunamıyor", body: "" });
  center.items.set("service:home-assistant", { source: "service", key: "service:home-assistant", urgency: "normal", title: "x", body: "" });
  const ha = new FakeHa();
  ha.notifications.set("a", notif("a", "A"));
  const t = await setup({ ha, center });
  try {
    await waitFor(() => t.center.resolves.length === 1, "ha:access resolved at once");
    await t.passGrace();
    assert.deepEqual(t.center.resolves, [HA_ACCESS_KEY, "pn:old"]);
    assert.equal(t.center.raises.length, 0, "an adopted unchanged item is not raised again");
    assert.ok(t.center.items.has("service:home-assistant"), "other sources untouched");
  } finally {
    await t.close();
  }
});

test("suppressed keys are adopted: an ended one is resolved (record cleared), an ongoing one is not raised", async () => {
  const center = new FakeCenter();
  center.suppressedKeys = [
    { source: HA_SOURCE, key: "pn:gone" },
    { source: HA_SOURCE, key: "pn:still" },
    { source: "service", key: "pn:gone" },
  ];
  const ha = new FakeHa();
  ha.notifications.set("still", notif("still", "S"));
  const t = await setup({ ha, center });
  try {
    await t.passGrace();
    assert.deepEqual(t.center.resolves, ["pn:gone"]);
    assert.equal(t.center.raises.length, 0);
    assert.deepEqual(t.center.suppressedKeys.map((s) => `${s.source}/${s.key}`), ["ha/pn:still", "service/pn:gone"]);
    // A raise answered `suppressed` counts as open: its removal resolves it.
    t.ha.push("added", notif("new", "N"));
    await waitFor(() => t.center.raises.length === 1, "raise new");
    t.center.suppressedKeys.push({ source: HA_SOURCE, key: "pn:new" });
    t.ha.push("updated", notif("new", "N2"));
    await waitFor(() => t.center.raises.length === 2, "update answered suppressed");
    t.ha.push("updated", notif("new", "N3"));
    await t.sync();
    assert.equal(t.center.raises.length, 2, "a suppressed key is not updated");
    t.ha.push("removed", notif("new", null));
    await waitFor(() => t.center.resolves.includes("pn:new"), "resolve new");
  } finally {
    await t.close();
  }
});

test("unreadable inbox: nothing raised until the startup adoption succeeds (retried)", async () => {
  const center = new FakeCenter();
  center.unavailable = true;
  const ha = new FakeHa();
  ha.notifications.set("a", notif("a", "A"));
  const t = await setup({ ha, center });
  try {
    await waitFor(() => t.ha.subscribers === 1, "subscribed");
    await settle(t.producer);
    assert.equal(t.center.raises.length, 0);
    assert.ok(t.logs.some((l) => l.includes("startup reconcile retried later")));
    await t.repairsDone();
    assert.deepEqual([...t.producerTimers.pending.values()].map((p) => p.ms).filter((ms) => ms !== HA_REPAIRS_POLL_MS), [60_000]);
    center.unavailable = false;
    t.clock.now += 59_999;
    t.producerTimers.fire();
    await settle(t.producer);
    assert.equal(t.center.raises.length, 0, "not before 60 s");
    t.clock.now += 1;
    t.producerTimers.fire();
    await waitFor(() => t.center.raises.length === 1, "raised after retry");
  } finally {
    await t.close();
  }
});

test("unknown event shapes and bad frames are ignored (logged once); the set is kept", async () => {
  const ha = new FakeHa();
  ha.notifications.set("a", notif("a", "A"));
  const t = await setup({ ha });
  try {
    await waitFor(() => t.center.raises.length === 1, "raise");
    t.ha.raw({ type: "current", notifications: [] });
    t.ha.raw({ type: "weird", notifications: {} });
    t.ha.raw("nope");
    for (const ws of t.ha.wss.clients) ws.send("{not json");
    await t.passGrace();
    assert.deepEqual(t.center.resolves, [], "a malformed `current` is not a complete listing");
    assert.equal(t.logs.filter((l) => l.includes("unexpected notification event shape")).length, 1);
    // A malformed entry in a real listing still counts as present (fallback title).
    t.ha.raw({ type: "current", notifications: { a: notif("a", "A"), b: 42 } });
    await waitFor(() => t.center.raises.length === 2, "b raised");
    assert.deepEqual(t.center.raises[1], { source: HA_SOURCE, key: "pn:b", urgency: "normal", title: "Home Assistant bildirimi", body: "", renotify: true });
    assert.deepEqual(t.center.resolves, []);
  } finally {
    await t.close();
  }
});

test("read-only: a command outside READ_ONLY_COMMANDS is refused and never sent", async () => {
  const ha = new FakeHa();
  const base = await ha.ready();
  let conn: HaConnection | undefined;
  const client = new HaClient({
    url: haWebSocketUrl(base)!,
    token: TOKEN,
    logger: { info: () => {}, warn: () => {} },
    handlers: { onConnected: (c) => (conn = c), onDisconnected: () => {}, onAuthInvalid: () => {} },
    timers: new FakeTimers(),
    heartbeatMs: 0,
  });
  try {
    client.start();
    await waitFor(() => conn !== undefined, "connected");
    await assert.rejects(conn!.command("persistent_notification/dismiss", { notification_id: "a" }), /not allowed/);
    await assert.rejects(conn!.command("call_service", { domain: "x" }), /not allowed/);
    await settle();
    assert.deepEqual(ha.commandTypes(), ["auth"]);
  } finally {
    await client.close();
    await ha.close();
  }
});

test("close: the socket is closed, pending commands rejected, no reconnect", async () => {
  const ha = new FakeHa();
  ha.notifications.set("a", notif("a", "A"));
  const t = await setup({ ha });
  await waitFor(() => t.ha.subscribers === 1, "subscribed");
  await t.client.close();
  await waitFor(() => t.ha.subscribers === 0, "server saw the close");
  await settle(t.producer);
  assert.equal(t.clientTimers.pending.size, 0);
  assert.deepEqual(t.center.resolves, [], "closing resolves nothing");
  await t.close();
});

test("heartbeat: no pong before the next ping drops the socket and reconnects", async () => {
  const ha = new FakeHa();
  const base = await ha.ready();
  const timers = new FakeTimers();
  let connects = 0;
  let disconnects = 0;
  const client = new HaClient({
    url: haWebSocketUrl(base)!,
    token: TOKEN,
    logger: { info: () => {}, warn: () => {} },
    handlers: { onConnected: () => connects++, onDisconnected: () => disconnects++, onAuthInvalid: () => {} },
    timers,
    random: () => 0.5,
    heartbeatMs: 30_000,
    authTimeoutMs: AUTH_TIMEOUT,
  });
  try {
    client.start();
    await waitFor(() => connects === 1, "connected");
    // First tick: ping sent; the server's ws answers with a pong.
    timers.fire(30_000);
    await settle();
    timers.fire(30_000);
    await settle();
    assert.equal(disconnects, 0, "answered pings keep the connection");
    // Stop the server from answering pings: pause the server-side socket.
    for (const ws of ha.wss.clients) (ws as unknown as { _socket: { pause(): void } })._socket.pause();
    timers.fire(30_000);
    timers.fire(30_000);
    await waitFor(() => disconnects === 1, "dropped");
  } finally {
    await client.close();
    await ha.close();
  }
});

test("HA restart: a listing missing ids resolves nothing during the grace; ids back by then are neither resolved nor re-raised", async () => {
  const ha = new FakeHa();
  ha.notifications.set("a", notif("a", "A"));
  ha.notifications.set("b", notif("b", "B"));
  const center = new FakeCenter();
  center.suppressedKeys = [{ source: HA_SOURCE, key: "pn:b" }];
  const t = await setup({ ha, center });
  try {
    await waitFor(() => t.center.raises.length === 1, "a raised");
    await t.passGrace();
    // HA restarts: its WebSocket API is up before the integrations recreate their notifications.
    t.ha.notifications.clear();
    t.ha.dropAll();
    await waitFor(() => t.clientTimers.pending.size === 1, "reconnect scheduled");
    t.reconnect();
    await waitFor(() => t.ha.subscribers === 1, "subscribed after the restart");
    await t.sync();
    assert.deepEqual(t.center.resolves, []);
    t.ha.push("added", notif("a", "A"));
    t.ha.push("added", notif("b", "B"));
    // A `removed` event still resolves at once.
    t.ha.push("added", notif("c", "C"));
    await waitFor(() => t.center.items.has("pn:c"), "c raised");
    t.ha.push("removed", notif("c", "C"));
    await waitFor(() => t.center.resolves.includes("pn:c"), "removed resolves at once");
    await t.passGrace();
    assert.deepEqual(t.center.resolves, ["pn:c"]);
    assert.deepEqual(t.center.raises.map((r) => r.key), ["pn:a", "pn:c"], "a and the suppressed b not raised again");
    assert.deepEqual(t.center.suppressedKeys, [{ source: HA_SOURCE, key: "pn:b" }], "suppression kept");
  } finally {
    await t.close();
  }
});

// --- T7.w.11.6: repairs ---

test("repairKey / repairOf: key limit and hashing, ignored entries, Turkish text without placeholder values", () => {
  assert.equal(repairKey("hacs", "restart_required"), "repair:hacs:restart_required");
  const fits = "a".repeat(MAX_KEY_CHARS - "repair:demo:".length);
  assert.equal(repairKey("demo", fits), `repair:demo:${fits}`);
  const k = repairKey("demo", `${fits}b`);
  assert.match(k, /^repair:sha256:[0-9a-f]{64}$/);
  assert.equal(repairKey("demo", `${fits}b`), k, "stable");
  assert.notEqual(repairKey("demo2", `${fits}b`), k);

  const r = repairOf(
    issue("homeassistant", "deprecated_yaml_x", {
      issue_domain: "sensor",
      severity: "critical",
      is_fixable: true,
      breaks_in_ha_version: "2027.1.0",
      translation_key: "deprecated_yaml",
      translation_placeholders: { name: "Gizli Mutfak", url: "http://10.0.0.9" },
      learn_more_url: "https://docs.example/x",
    }),
  );
  assert.ok(r && r !== "ignored");
  assert.equal(r.key, "repair:homeassistant:deprecated_yaml_x");
  assert.deepEqual(r.want, {
    type: "repair:homeassistant:deprecated_yaml",
    title: "Home Assistant onarımı: sensor",
    body:
      "Sorun: deprecated_yaml\nÖnem: kritik\nHome Assistant 2027.1.0 sürümünde çalışmayı bırakacak.\nHome Assistant'ta onarma adımı var.\nAyrıntılar: Home Assistant > Ayarlar > Onarımlar.",
  });
  const plain = repairOf(issue("demo", "x1", { translation_key: null, severity: "bogus" }));
  assert.ok(plain && plain !== "ignored");
  assert.deepEqual(plain.want, { type: "repair:demo:x1", title: "Home Assistant onarımı: demo", body: "Sorun: x1\nAyrıntılar: Home Assistant > Ayarlar > Onarımlar." });
  assert.equal(repairOf(issue("demo", "x", { ignored: true })), "ignored");
  assert.equal(repairOf(issue("demo", "x", { ignored: undefined, dismissed_version: "2026.10.0" })), "ignored", "no `ignored`: dismissed_version decides");
  assert.notEqual(repairOf(issue("demo", "x", { ignored: false, dismissed_version: "2026.10.0" })), "ignored", "`ignored` wins when present");
  assert.equal(repairOf({ issue_id: "x" }), undefined);
  assert.equal(repairOf(issue("", "x")), undefined);
  assert.equal(repairOf(42), undefined);
  assert.equal(haAlertType({ kind: "repair", domain: "demo", issueId: "x", severity: "critical" }), "repair:demo:x", "no translation key: issue_id");
  assert.equal(haAlertType({ kind: "repair", domain: "demo", issueId: "x_1", translationKey: "t" }), "repair:demo:t");
});

test("repairs: listed after the subscription and every 10 min; ignored ones skipped; only read-only commands", async () => {
  const ha = new FakeHa();
  ha.issues = [
    issue("demo", "a", { translation_placeholders: { name: "Gizli Mutfak" } }),
    issue("demo", "ign", { ignored: true, dismissed_version: "2026.10.0" }),
    issue("demo", "old_ign", { ignored: undefined, dismissed_version: "2026.9.0" }),
  ];
  const t = await setup({ ha });
  try {
    await t.repairsDone();
    assert.equal(t.ha.repairsLists, 1);
    assert.deepEqual(t.ha.commandTypes(), ["auth", "persistent_notification/subscribe", "repairs/list_issues"]);
    assert.deepEqual(t.center.raises, [
      {
        source: HA_SOURCE,
        key: "repair:demo:a",
        urgency: "normal",
        title: "Home Assistant onarımı: demo",
        body: "Sorun: a\nÖnem: uyarı\nAyrıntılar: Home Assistant > Ayarlar > Onarımlar.",
        renotify: true,
      },
    ]);
    // 10 minutes later: listed again; a new issue is raised, the unchanged one writes nothing.
    t.ha.issues.push(issue("demo", "b", { severity: "error" }));
    await t.poll();
    assert.equal(t.ha.repairsLists, 2);
    assert.deepEqual(t.center.raises.map((r) => r.key), ["repair:demo:a", "repair:demo:b"]);
    // A changed issue (severity) replaces the item without renotify.
    t.ha.issues[3] = issue("demo", "b", { severity: "critical" });
    await t.poll();
    assert.equal(t.center.raises.length, 3);
    assert.equal(t.center.raises[2]!.key, "repair:demo:b");
    assert.equal(t.center.raises[2]!.renotify, false);
    assert.match(t.center.raises[2]!.body ?? "", /Önem: kritik/);
    // An issue the user ignores in HA leaves the list: resolved.
    t.ha.issues[0] = issue("demo", "a", { ignored: true, dismissed_version: "2026.11.0" });
    await t.poll();
    assert.deepEqual(t.center.resolves, ["repair:demo:a"]);
    assert.equal(t.ha.repairsLists, 4);
    assert.ok(t.ha.commandTypes().every((c) => c === "auth" || READ_ONLY_COMMANDS.has(c)), "nothing but read-only commands");
    for (const r of t.center.raises) assert.ok(!r.title.includes("Gizli") && !(r.body ?? "").includes("Gizli"), "placeholder values not copied");
    for (const line of t.logs) assert.ok(!line.includes("demo") && !line.includes("Gizli"), `no ids/text in logs: ${line}`);
  } finally {
    await t.close();
  }
});

test("repairs resolve: a smaller successful list after the grace resolves; a failed list, a malformed one, a disconnect and the list at connect do not", async () => {
  const ha = new FakeHa();
  ha.issues = [issue("demo", "x"), issue("demo", "y")];
  const t = await setup({ ha });
  try {
    await t.repairsDone();
    assert.equal(t.center.raises.length, 2);
    // A failed list resolves nothing.
    t.ha.issues = [issue("demo", "x")];
    t.ha.repairsError = "home_assistant_error";
    await t.poll();
    assert.deepEqual(t.center.resolves, []);
    assert.equal(t.logs.filter((l) => l.includes("repairs list failed (home_assistant_error)")).length, 1);
    assert.ok(!t.center.items.has(HA_ACCESS_KEY), "another error is not a permission problem");
    // A malformed answer or entry is not a complete listing.
    t.ha.repairsError = undefined;
    t.ha.repairsResult = { issues: "nope" };
    await t.poll();
    t.ha.repairsResult = { issues: [issue("demo", "x"), { issue_id: "no-domain" }] };
    await t.poll();
    assert.deepEqual(t.center.resolves, []);
    assert.equal(t.logs.filter((l) => l.includes("unexpected repairs list shape")).length, 1, "logged once");
    t.ha.repairsResult = undefined;
    // A lost connection resolves nothing and stops the poll.
    t.ha.dropAll();
    await waitFor(() => t.clientTimers.pending.size === 1, "reconnect scheduled");
    await settle(t.producer);
    assert.deepEqual(t.center.resolves, []);
    assert.ok(!t.pollArmed(), "no poll while disconnected");
    // The list right after a (re)connect is within the grace: it raises but does not resolve.
    t.reconnect();
    await t.repairsDone();
    assert.equal(t.ha.repairsLists, 5);
    assert.deepEqual(t.center.resolves, []);
    // The next list (10 min later) resolves the missing one only.
    await t.poll();
    assert.deepEqual(t.center.resolves, ["repair:demo:y"]);
    assert.deepEqual([...t.center.items.keys()], ["repair:demo:x"]);
    assert.equal(t.center.raises.length, 2, "x not raised again");
  } finally {
    await t.close();
  }
});

test("repairs unauthorized → ha:access; a token rejection and the repairs refusal do not clear each other; a good list resolves it", async () => {
  const ha = new FakeHa();
  ha.repairsError = "unauthorized";
  ha.notifications.set("a", notif("a", "A"));
  const t = await setup({ ha });
  try {
    await t.repairsDone();
    const access = () => t.center.raises.filter((r) => r.key === HA_ACCESS_KEY);
    assert.equal(access().length, 1);
    assert.equal(access()[0]!.title, "HA uyarıları okunamıyor");
    assert.match(access()[0]!.body ?? "", /onarım/);
    assert.equal(access()[0]!.renotify, true);
    assert.ok(t.center.items.has("pn:a"), "notifications still work");
    assert.equal(t.logs.filter((l) => l.includes("repairs list refused (unauthorized")).length, 1);
    // Still refused 10 min later: nothing new.
    await t.poll();
    assert.equal(access().length, 1);
    assert.equal(t.logs.filter((l) => l.includes("repairs list refused")).length, 1, "logged once per streak");
    // The token is rejected now: the item stays, its text says so (no renotify).
    t.ha.acceptToken = false;
    t.ha.dropAll();
    await waitFor(() => t.clientTimers.pending.size === 1, "reconnect scheduled");
    t.reconnect();
    await waitFor(() => access().length === 2, "token text");
    assert.match(access()[1]!.body ?? "", /reddetti/);
    assert.equal(access()[1]!.renotify, false);
    // The token is accepted again but repairs are still refused: the good connect does not resolve it.
    t.ha.acceptToken = true;
    await waitFor(() => t.clientTimers.pending.size === 1, "reconnect scheduled");
    t.reconnect();
    await t.repairsDone();
    assert.deepEqual(t.center.resolves, []);
    assert.equal(access().length, 3);
    assert.match(access()[2]!.body ?? "", /onarım/);
    // Repairs allowed now: resolved by the next good list.
    t.ha.repairsError = undefined;
    await t.poll();
    assert.deepEqual(t.center.resolves, [HA_ACCESS_KEY]);
    assert.equal(access().length, 3);
  } finally {
    await t.close();
  }
});

test("adopted ha:access is not resolved by a good connect while repairs are refused (no flap at startup)", async () => {
  const center = new FakeCenter();
  center.items.set(HA_ACCESS_KEY, { source: HA_SOURCE, key: HA_ACCESS_KEY, urgency: "normal", title: "HA uyarıları okunamıyor", body: "old text" });
  const ha = new FakeHa();
  ha.repairsError = "unauthorized";
  const t = await setup({ ha, center });
  try {
    await t.repairsDone();
    await t.sync();
    assert.deepEqual(t.center.resolves, []);
    assert.deepEqual(
      t.center.raises.map((r) => [r.key, r.renotify]),
      [[HA_ACCESS_KEY, false]],
      "text updated without renotify",
    );
  } finally {
    await t.close();
  }
});

test("repairs adoption: open repair items and suppressed repair keys count as open; long ids hashed; ended ones resolved after the grace", async () => {
  const center = new FakeCenter();
  const a = repairOf(issue("demo", "a"));
  assert.ok(a && a !== "ignored");
  center.items.set(a.key, { source: HA_SOURCE, key: a.key, ...a.want });
  center.items.set("repair:demo:old", { source: HA_SOURCE, key: "repair:demo:old", urgency: "normal", title: "Old", body: "" });
  center.suppressedKeys = [
    { source: HA_SOURCE, key: "repair:demo:gone" },
    { source: HA_SOURCE, key: "repair:demo:sup" },
  ];
  const longId = `l${"o".repeat(200)}`;
  const ha = new FakeHa();
  ha.issues = [issue("demo", "a"), issue("demo", "sup"), issue("demo", longId)];
  const t = await setup({ ha, center });
  try {
    await t.repairsDone();
    assert.deepEqual(t.center.raises.map((r) => r.key), [repairKey("demo", longId)], "unchanged adopted and suppressed ones not raised");
    assert.match(t.center.raises[0]!.key!, /^repair:sha256:[0-9a-f]{64}$/);
    assert.deepEqual(t.center.resolves, [], "not by the list at connect");
    await t.poll();
    assert.deepEqual([...t.center.resolves].sort(), ["repair:demo:gone", "repair:demo:old"]);
    assert.deepEqual(t.center.suppressedKeys, [{ source: HA_SOURCE, key: "repair:demo:sup" }], "ongoing suppression kept");
    // The long one leaves the list: resolved under its hashed key.
    t.ha.issues = [issue("demo", "a"), issue("demo", "sup")];
    await t.poll();
    assert.ok(t.center.resolves.includes(repairKey("demo", longId)));
  } finally {
    await t.close();
  }
});

test("repairs: a list still pending on a dropped connection is ignored (generation guard); the new connection's list counts", async () => {
  const ha = new FakeHa();
  ha.issues = [issue("demo", "x")];
  ha.repairsError = "unauthorized";
  ha.holdRepairs = true;
  const t = await setup({ ha });
  try {
    await waitFor(() => t.ha.repairsLists === 1, "first list sent");
    t.ha.dropAll();
    await waitFor(() => t.clientTimers.pending.size === 1, "reconnect scheduled");
    await settle(t.producer);
    // The old request never produced an answer or an error: no ha:access, nothing raised or resolved.
    assert.ok(!t.center.items.has(HA_ACCESS_KEY));
    assert.equal(t.center.raises.length, 0);
    assert.deepEqual(t.center.resolves, []);
    t.ha.holdRepairs = false;
    t.ha.repairsError = undefined;
    t.reconnect();
    await t.repairsDone();
    assert.equal(t.ha.repairsLists, 2);
    assert.ok(!t.center.items.has(HA_ACCESS_KEY));
    assert.deepEqual([...t.center.items.keys()], ["repair:demo:x"]);
  } finally {
    await t.close();
  }
});

// ------------------------------------------------------------ learned urgency (T7.w.11.10)

/** A fake learned-urgency store: levels by type, every `noteItem` recorded. */
class FakeUrgency implements HaUrgencyPort {
  readonly levels = new Map<string, "normal" | "urgent">([
    ["pn:http-login", "urgent"],
    ["pn:ip-ban", "urgent"],
  ]);
  readonly noted = new Map<string, string>();
  reads = 0;
  failing = false;
  async level(type: string): Promise<"normal" | "urgent"> {
    this.reads++;
    if (this.failing) throw new Error("boom");
    return this.levels.get(type) ?? "normal";
  }
  noteItem(itemKey: string, type: string): void {
    this.noted.set(itemKey, type);
  }
}

test("learned urgency: failed-login notifications start urgent, others normal; item keys mapped to type keys", async () => {
  const ha = new FakeHa();
  ha.notifications.set("http-login", notif("http-login", "Login attempt failed"));
  ha.notifications.set("ip-ban", notif("ip-ban", "IP banned"));
  ha.notifications.set("config_entry_discovery", notif("config_entry_discovery", "Yeni cihaz"));
  ha.notifications.set("backup_failed_12", notif("backup_failed_12", "Yedek"));
  ha.issues = [issue("demo", "a_1", { translation_key: "deprecated" })];
  const urgency = new FakeUrgency();
  const t = await setup({ ha, urgency });
  try {
    await waitFor(() => t.center.raises.length >= 4, "four raises");
    await t.repairsDone();
    const byKey = new Map(t.center.raises.map((r) => [r.key, r.urgency]));
    assert.equal(byKey.get("pn:http-login"), "urgent");
    assert.equal(byKey.get("pn:ip-ban"), "urgent");
    assert.equal(byKey.get("pn:config_entry_discovery"), "normal");
    assert.equal(byKey.get("pn:backup_failed_12"), "normal");
    assert.equal(byKey.get("repair:demo:a_1"), "normal");
    assert.equal(urgency.noted.get("pn:backup_failed_12"), "pn:backup_failed", "variable suffix stripped");
    assert.equal(urgency.noted.get("repair:demo:a_1"), "repair:demo:deprecated", "translation key, not issue_id");
  } finally {
    await t.close();
  }
});

test("learned urgency: read at raise time; an open item keeps its urgency until it is raised again", async () => {
  const ha = new FakeHa();
  ha.notifications.set("x_1", notif("x_1", "X"));
  const urgency = new FakeUrgency();
  const t = await setup({ ha, urgency });
  try {
    await waitFor(() => t.center.raises.length === 1, "first raise");
    assert.equal(t.center.raises[0]!.urgency, "normal");
    // "Kabul": the type is urgent from now on.
    urgency.levels.set("pn:x", "urgent");
    // The same set again (no text change): nothing is raised, the open item stays normal.
    t.ha.push("updated", notif("x_1", "X"));
    await t.sync();
    assert.equal(t.center.raises.length, 1);
    assert.equal(t.center.items.get("pn:x_1")!.urgency, "normal");
    // A text change raises it again: now urgent (without renotify, like any update).
    t.ha.push("updated", notif("x_1", "X2"));
    await waitFor(() => t.center.raises.length === 2, "re-raised");
    assert.equal(t.center.raises[1]!.urgency, "urgent");
    assert.equal(t.center.raises[1]!.renotify, false);
    // A new occurrence of the same type (new id) is urgent at once.
    t.ha.push("added", notif("x_2", "X yine"));
    await waitFor(() => t.center.raises.length === 3, "new occurrence");
    assert.equal(t.center.raises[2]!.urgency, "urgent");
    assert.equal(t.center.raises[2]!.renotify, true);
  } finally {
    await t.close();
  }
});

test("learned urgency: a failing store never blocks the producer (normal); ha:access stays normal", async () => {
  const ha = new FakeHa();
  ha.notifications.set("http-login", notif("http-login", "Login"));
  const urgency = new FakeUrgency();
  urgency.failing = true;
  const t = await setup({ ha, urgency });
  try {
    await waitFor(() => t.center.raises.length === 1, "raised");
    assert.equal(t.center.raises[0]!.urgency, "normal");
  } finally {
    await t.close();
  }
  const bad = new FakeHa();
  bad.acceptToken = false;
  const u2 = new FakeUrgency();
  const t2 = await setup({ ha: bad, urgency: u2 });
  try {
    await waitFor(() => t2.center.raises.some((r) => r.key === HA_ACCESS_KEY), "ha:access");
    assert.equal(t2.center.raises.find((r) => r.key === HA_ACCESS_KEY)!.urgency, "normal");
    assert.equal(u2.reads, 0, "ha:access has no learned type");
  } finally {
    await t2.close();
  }
});
