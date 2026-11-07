/**
 * T7.w.5b: notification frames in the Core (`notifications_list`,
 * `notification_action`, the `notification` / `notification_removed`
 * broadcasts and the urgent `speak` flag). Real NotificationStore in a temp
 * dir; the model is mocked. Generic names and texts only.
 *
 * - list, read / unread (idempotent), delete, unknown ids;
 * - every change reaches every attached socket; a closed socket gets nothing;
 * - an urgent item is spoken by exactly one socket (speech on, device with
 *   the latest turn) and never again: not on a reconnect, not by a list, not
 *   by a raise without renotify;
 * - the producer's dedupe key never leaves the Core.
 */
import assert from "node:assert/strict";
import * as nodeFs from "node:fs/promises";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AgentRunner, TurnResult } from "../src/agent.js";
import { ConversationLog } from "../src/conversation-log.js";
import type { AtomicFs } from "../src/atomic-file.js";
import { NOTIFICATIONS_FILE, NotificationStore, NotificationsUnavailableError } from "../src/notifications.js";
import { PermissionPolicy } from "../src/permissions.js";
import type { ClientFrame, ServerFrame } from "../src/protocol.js";
import { parseServices } from "../src/services.js";
import { NotificationCenter, Session } from "../src/session.js";

const base = mkdtempSync(join(tmpdir(), "shadow-session-notifications-test-"));
const open: Session[] = [];
after(async () => {
  await Promise.all(open.map((s) => s.close("test_end")));
  rmSync(base, { recursive: true, force: true });
});

const SERVICES = parseServices(["services:", "  - name: home-assistant", "    kind: mcp", "    url: http://localhost:1/sse", "    permission: read"].join("\n"), {}).services;

class MockAgent implements AgentRunner {
  async runTurn(): Promise<TurnResult> {
    return { text: "Tamam.", inputTokens: 1, outputTokens: 1, durationMs: 1, sessionId: "sdk-1", tools: [] };
  }
}

type Frame<T extends ServerFrame["type"]> = Extract<ServerFrame, { type: T }>;

let counter = 0;

/** One home: a store, a center, and sockets (sessions) attached to it. */
function home(o: { withCenter?: boolean; fs?: AtomicFs } = {}) {
  const dir = join(base, `h${++counter}`);
  const store = new NotificationStore({ dir: join(dir, "notifications"), log: () => {}, ...(o.fs ? { fs: o.fs, retryDelaysMs: [] } : {}) });
  const infos: string[] = [];
  const warns: string[] = [];
  const center = new NotificationCenter({ store, logger: { info: (m) => infos.push(m), warn: (m) => warns.push(m) } });
  let sessions = 0;
  let req = 0;

  function connect(device: string) {
    const frames: ServerFrame[] = [];
    const session = new Session(
      {
        agent: new MockAgent(),
        policy: new PermissionPolicy(SERVICES),
        router: { route: () => ({ model: "test-model" }), onUsage: () => {} },
        stt: { transcribe: async () => ({ text: "" }) },
        tts: { synthesize: async () => ({ mime: "audio/wav", data: Buffer.from("RIFF") }), voices: async () => ({ default: "v", voices: ["v"] }) },
        log: new ConversationLog(dir),
        logger: { info: () => {}, warn: () => {} },
        ...(o.withCenter === false ? {} : { notifications: center }),
      },
      { sessionId: `s${counter}-${++sessions}`, device },
      (f) => frames.push(f),
    );
    open.push(session);
    const send = (f: ClientFrame) => session.handle(f);
    /** Sends a request, returns its reply (`notifications` or `error`). */
    const ask = async (frame: { type: "notifications_list" } | { type: "notification_action"; notificationId: string; action: "read" | "unread" | "delete" }) => {
      const id = `q${++req}`;
      await send({ ...frame, id } as ClientFrame);
      const reply = frames.find((f) => (f.type === "notifications" || f.type === "error") && "id" in f && f.id === id);
      assert.ok(reply, `no reply to ${id}`);
      return reply as Frame<"notifications"> | Frame<"error">;
    };
    const list = async () => {
      const r = await ask({ type: "notifications_list" });
      assert.equal(r.type, "notifications");
      return r as Frame<"notifications">;
    };
    return {
      session,
      frames,
      ask,
      list,
      speechOn: () => send({ type: "speech_prefs", enabled: true, mode: "text" }),
      speechOff: () => send({ type: "speech_prefs", enabled: false, mode: "text" }),
      say: (text = "merhaba") => send({ type: "user_text", id: `t${++req}`, text }),
      of: <T extends ServerFrame["type"]>(type: T) => frames.filter((f) => f.type === type) as Frame<T>[],
      spoken: () => frames.filter((f) => f.type === "notification" && f.speak === true) as Frame<"notification">[],
    };
  }
  return { dir, store, center, infos, warns, connect };
}

const errorCode = (r: { type: string; code?: string }) => (r.type === "error" ? r.code : r.type);

test("list: empty, then the raised items with the unread count; the dedupe key is not sent", async () => {
  const h = home();
  const a = h.connect("phone");
  const empty = await a.list();
  assert.deepEqual(empty.items, []);
  assert.equal(empty.unread, 0);
  const first = await h.center.raise({ source: "test", key: "k-1", title: "Birinci", body: "Gövde" });
  assert.ok(first.ok);
  await h.center.raise({ source: "test", title: "İkinci" });
  const v = await a.list();
  assert.equal(v.unread, 2);
  assert.deepEqual(v.items.map((i) => i.title).sort(), ["Birinci", "İkinci"]);
  const item = v.items.find((i) => i.title === "Birinci");
  assert.ok(item);
  assert.deepEqual(Object.keys(item).sort(), ["body", "createdAt", "id", "raised", "readAt", "source", "title", "updatedAt", "urgency"]);
  assert.equal(item.readAt, null);
  assert.equal(item.urgency, "normal");
  assert.equal(h.center.unread, 2);
  // Broadcasts carry no key either.
  for (const f of a.of("notification")) assert.equal("key" in f.item, false);
});

test("a raise reaches two sockets (two devices); a normal item is not spoken", async () => {
  const h = home();
  const a = h.connect("phone");
  const b = h.connect("browser");
  await a.speechOn();
  await b.speechOn();
  const r = await h.center.raise({ source: "test", title: "Bilgi" });
  assert.ok(r.ok);
  for (const s of [a, b]) {
    const got = s.of("notification");
    assert.equal(got.length, 1);
    assert.equal(got[0]?.item.id, r.item.id);
    assert.equal(got[0]?.speak, undefined);
  }
});

test("read / unread: shared by every device, broadcast to both sockets, answered to the asker only; idempotent without a second broadcast", async () => {
  const h = home();
  const a = h.connect("phone");
  const b = h.connect("browser");
  const r = await h.center.raise({ source: "test", title: "Okunacak" });
  assert.ok(r.ok);
  const id = r.item.id;

  const read = await a.ask({ type: "notification_action", notificationId: id, action: "read" });
  assert.equal(read.type, "notifications");
  const readFrame = read as Frame<"notifications">;
  assert.equal(readFrame.unread, 0);
  assert.notEqual(readFrame.items[0]?.readAt, null);
  assert.equal(b.of("notifications").length, 0, "the reply goes to the asking socket only");
  for (const s of [a, b]) {
    const last = s.of("notification").at(-1);
    assert.equal(last?.item.id, id);
    assert.notEqual(last?.item.readAt, null);
  }
  assert.equal(h.center.unread, 0);
  // Another device sees it read.
  assert.notEqual((await b.list()).items[0]?.readAt, null);

  const before = b.of("notification").length;
  assert.equal((await b.ask({ type: "notification_action", notificationId: id, action: "read" })).type, "notifications");
  assert.equal(b.of("notification").length, before, "no broadcast when nothing changed");

  const unread = await b.ask({ type: "notification_action", notificationId: id, action: "unread" });
  assert.equal((unread as Frame<"notifications">).unread, 1);
  assert.equal(a.of("notification").at(-1)?.item.readAt, null);
  assert.equal(h.center.unread, 1);
});

test("delete: removed for every socket and from the store; a second delete and unknown ids are unknown_item", async () => {
  const h = home();
  const a = h.connect("phone");
  const b = h.connect("browser");
  const r = await h.center.raise({ source: "test", title: "Silinecek" });
  assert.ok(r.ok);
  const del = await a.ask({ type: "notification_action", notificationId: r.item.id, action: "delete" });
  assert.equal(del.type, "notifications");
  assert.deepEqual((del as Frame<"notifications">).items, []);
  for (const s of [a, b]) assert.deepEqual(s.of("notification_removed"), [{ type: "notification_removed", notificationId: r.item.id }]);
  assert.deepEqual(await h.store.list(), []);
  assert.ok(h.infos.some((m) => m.includes(r.item.id) && m.includes("phone")));

  assert.equal(errorCode(await a.ask({ type: "notification_action", notificationId: r.item.id, action: "delete" })), "unknown_item");
  for (const action of ["read", "unread", "delete"] as const) {
    assert.equal(errorCode(await a.ask({ type: "notification_action", notificationId: "n-0000000000000000", action })), "unknown_item", action);
  }
  assert.equal(b.of("notification_removed").length, 1);
});

test("resolve(): the producer's keyed item is removed for every socket; an unknown key changes nothing", async () => {
  const h = home();
  const a = h.connect("phone");
  const b = h.connect("browser");
  const r = await h.center.raise({ source: "test", key: "condition", title: "Durum" });
  assert.ok(r.ok);
  assert.equal(await h.center.resolve("test", "other"), false);
  assert.equal(await h.center.resolve("test", "condition"), true);
  for (const s of [a, b]) assert.deepEqual(s.of("notification_removed"), [{ type: "notification_removed", notificationId: r.item.id }]);
  assert.equal(await h.center.resolve("test", "condition"), false);
  assert.equal(h.center.unread, 0);
});

test("urgent: spoken by one socket only (speech on, device with the latest turn), never again after a reconnect", async () => {
  const h = home();
  const phone = h.connect("phone");
  const browser = h.connect("browser");
  const tablet = h.connect("tablet");
  await phone.speechOn();
  await browser.speechOn();
  // tablet: speech off (no speech_prefs) although it has the very latest turn.
  await browser.say();
  await phone.say();
  await tablet.say();

  const r = await h.center.raise({ source: "test", urgency: "urgent", title: "Acil", body: "Ayrıntı" });
  assert.ok(r.ok);
  for (const s of [phone, browser, tablet]) assert.equal(s.of("notification").length, 1, "every socket gets the item");
  assert.equal(phone.spoken().length, 1);
  assert.equal(browser.spoken().length, 0);
  assert.equal(tablet.spoken().length, 0);
  assert.equal(phone.spoken()[0]?.item.urgency, "urgent");

  // The phone reconnects: its list carries no speak, and nothing is spoken again.
  await phone.session.close("socket_closed");
  const again = h.connect("phone");
  await again.speechOn();
  const v = await again.list();
  assert.equal(v.items.length, 1);
  assert.equal("speak" in v, false);
  assert.equal(again.spoken().length, 0);
  assert.equal(again.of("notification").length, 0);
  // The closed socket got nothing after closing.
  await h.center.raise({ source: "test", title: "Normal" });
  assert.equal(phone.of("notification").length, 1);
  assert.equal(again.of("notification").length, 1);
});

test("urgent: the device with the latest turn wins over a newer socket; with speech off everywhere nothing is spoken", async () => {
  const h = home();
  const a = h.connect("phone");
  const b = h.connect("browser");
  await a.speechOn();
  await b.speechOn();
  await a.say();
  await h.center.raise({ source: "test", urgency: "urgent", title: "Bir" });
  assert.equal(a.spoken().length, 1);
  assert.equal(b.spoken().length, 0);

  // The phone switches speech off: the browser speaks next.
  await a.speechOff();
  await h.center.raise({ source: "test", urgency: "urgent", title: "İki" });
  assert.equal(a.spoken().length, 1);
  assert.equal(b.spoken().length, 1);

  await b.speechOff();
  await h.center.raise({ source: "test", urgency: "urgent", title: "Üç" });
  assert.equal(a.spoken().length + b.spoken().length, 2, "no socket with speech on: nothing spoken");
  assert.equal(a.of("notification").length, 3);
  assert.equal(b.of("notification").length, 3);
});

test("urgent ties: on one device the socket with its own latest turn speaks; without any turn the newest socket speaks", async () => {
  const h = home();
  const first = h.connect("phone");
  const second = h.connect("phone");
  await first.speechOn();
  await second.speechOn();
  // No turn anywhere: the newest socket.
  await h.center.raise({ source: "test", urgency: "urgent", title: "Bir" });
  assert.equal(first.spoken().length, 0);
  assert.equal(second.spoken().length, 1);
  // Same device, the older socket has the latest turn: it speaks.
  await first.say();
  await h.center.raise({ source: "test", urgency: "urgent", title: "İki" });
  assert.equal(first.spoken().length, 1);
  assert.equal(second.spoken().length, 1);
});

test("urgent and keyed: a raise again without renotify is not spoken; with renotify it is spoken once more", async () => {
  const h = home();
  const a = h.connect("phone");
  await a.speechOn();
  await h.center.raise({ source: "test", key: "k", urgency: "urgent", title: "Hatırlatma" });
  assert.equal(a.spoken().length, 1);
  await h.center.raise({ source: "test", key: "k", urgency: "urgent", title: "Hatırlatma (güncel)" });
  assert.equal(a.spoken().length, 1);
  assert.equal(a.of("notification").at(-1)?.item.title, "Hatırlatma (güncel)");
  await h.center.raise({ source: "test", key: "k", urgency: "urgent", title: "Hatırlatma", renotify: true });
  assert.equal(a.spoken().length, 2);
  assert.equal(a.of("notification").length, 3);
});

test("a refused raise broadcasts nothing", async () => {
  const h = home();
  const a = h.connect("phone");
  const r = await h.center.raise({ source: "Not Valid", title: "x" });
  assert.deepEqual(r, { ok: false, reason: "invalid" });
  assert.equal(a.of("notification").length, 0);
});

test("without the center the frames answer bad_request with the request id", async () => {
  const h = home({ withCenter: false });
  const a = h.connect("phone");
  const r = await a.ask({ type: "notifications_list" });
  assert.equal(errorCode(r), "bad_request");
  assert.equal(errorCode(await a.ask({ type: "notification_action", notificationId: "n-0000000000000000", action: "read" })), "bad_request");
});

test("refresh() reads the unread count of items already on disk (startup)", async () => {
  const h = home();
  await h.store.raise({ source: "test", title: "Önceden" });
  await h.store.raise({ source: "test", title: "Önceden 2" });
  await h.store.flush(); // coalesced writes: on disk now
  const fresh = new NotificationCenter({ store: new NotificationStore({ dir: join(h.dir, "notifications") }), logger: { info: () => {}, warn: () => {} } });
  assert.equal(fresh.unread, 0);
  assert.equal(await fresh.refresh(), 2);
  assert.equal(fresh.unread, 2);
});

test("urgent: a closed socket is detached and no longer the speaker (the next socket with speech speaks instead)", async () => {
  const h = home();
  const phone = h.connect("phone");
  const browser = h.connect("browser");
  await phone.speechOn();
  await browser.speechOn();
  await phone.say(); // the phone is the preferred speaker
  await phone.session.close("socket_closed");
  await h.center.raise({ source: "test", urgency: "urgent", title: "Acil" });
  assert.equal(phone.spoken().length, 0);
  assert.equal(browser.spoken().length, 1, "the urgent item must not be lost on a dead socket");
});

test("an unreadable notifications file: list and actions answer notifications_unavailable, the file is not overwritten, the Core recovers", async () => {
  const state = { failRead: false };
  const fs: AtomicFs = {
    mkdir: (p, o) => nodeFs.mkdir(p, o),
    open: (p, f, m) => nodeFs.open(p, f, m),
    rename: (a, b) => nodeFs.rename(a, b),
    unlink: (p) => nodeFs.unlink(p),
    readFile: (p, e) => (state.failRead ? Promise.reject(Object.assign(new Error("simulated"), { code: "EBUSY" })) : nodeFs.readFile(p, e)),
    readdir: (p) => nodeFs.readdir(p),
  };
  // Items already on disk from an earlier run.
  const h = home({ fs });
  const seeded = new NotificationStore({ dir: join(h.dir, "notifications"), coalesceMs: 0 });
  const kept = await seeded.raise({ source: "test", key: "k", title: "Korunan" });
  assert.ok(kept.ok);
  const file = join(h.dir, "notifications", NOTIFICATIONS_FILE);
  const content = readFileSync(file, "utf8");

  state.failRead = true;
  // Startup does not fail: the count stays 0.
  assert.equal(await h.center.refresh(), 0);
  const a = h.connect("phone");
  const b = h.connect("browser");
  const listed = await a.ask({ type: "notifications_list" });
  assert.equal(errorCode(listed), "notifications_unavailable");
  for (const action of ["read", "unread", "delete"] as const) {
    assert.equal(errorCode(await a.ask({ type: "notification_action", notificationId: kept.item.id, action })), "notifications_unavailable", action);
  }
  // Producers: raise answers unavailable, resolve rejects; nothing is broadcast.
  assert.deepEqual(await h.center.raise({ source: "test", title: "Yeni" }), { ok: false, reason: "unavailable" });
  await assert.rejects(h.center.resolve("test", "k"), NotificationsUnavailableError);
  assert.equal(b.of("notification").length + b.of("notification_removed").length, 0);
  // The center's chain keeps working and logs nothing of its own (the store logs the cause).
  assert.deepEqual(h.warns, []);
  await h.center.flush();
  assert.equal(readFileSync(file, "utf8"), content, "the file must not be replaced by an empty inbox");
  assert.deepEqual(readdirSync(join(h.dir, "notifications")), [NOTIFICATIONS_FILE]);

  state.failRead = false;
  const back = await a.list();
  assert.deepEqual(back.items.map((i) => i.title), ["Korunan"]);
  assert.equal(back.unread, 1);
  assert.equal(await h.center.refresh(), 1);
});
