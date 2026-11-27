/**
 * T11.5: the rehearsal flag. CORE_REHEARSAL parsing (strict on/off, unset =
 * off, invalid = refuse to start), the producer start gate, and the
 * NotificationCenter's second guard (`urgentSpeech: false`: nothing spoken,
 * nothing pending, the inbox still lists and deletes). Behaviour with the flag
 * off is unchanged (the center's full behaviour is in session-notifications.test.ts).
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadConfig, parseRehearsal } from "../src/config.js";
import { NotificationStore } from "../src/notifications.js";
import type { ServerFrame } from "../src/protocol.js";
import { REHEARSAL_DISABLED, startNotificationProducers } from "../src/rehearsal.js";
import { NotificationCenter, type NotificationListener } from "../src/session.js";

const dir = mkdtempSync(join(tmpdir(), "shadow-rehearsal-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("parseRehearsal: unset / blank / off words = off, on words = on (any case, trimmed), anything else throws", () => {
  for (const off of [undefined, "", "  ", "0", "off", "OFF", "false", "no", " No "]) assert.equal(parseRehearsal(off), false, String(off));
  for (const on of ["1", "on", "ON", "true", "True", "yes", " yes "]) assert.equal(parseRehearsal(on), true, on);
  for (const bad of ["2", "enabled", "of", "y", "1x", "none"]) {
    assert.throws(() => parseRehearsal(bad), /CORE_REHEARSAL must be on or off/, bad);
  }
});

test("loadConfig: CORE_REHEARSAL reaches the config (default off, on, off); an invalid value refuses to start", () => {
  const services = join(dir, "services.yaml");
  writeFileSync(services, "services: []\n");
  const env = (v?: string): NodeJS.ProcessEnv => ({
    SHADOW_SERVICES_FILE: services,
    SHADOW_DATA_DIR: dir,
    CORE_ROUTER: "off",
    ...(v === undefined ? {} : { CORE_REHEARSAL: v }),
  });
  assert.equal(loadConfig(env()).rehearsal, false);
  assert.equal(loadConfig(env("1")).rehearsal, true);
  assert.equal(loadConfig(env("off")).rehearsal, false);
  assert.throws(() => loadConfig(env("maybe")), /CORE_REHEARSAL must be on or off/);
});

function fakeProducer() {
  const p = { started: 0, start: () => void p.started++ };
  return p;
}

test("startNotificationProducers: off starts every producer (an absent one is skipped) and logs nothing", () => {
  const a = fakeProducer();
  const b = fakeProducer();
  const warns: string[] = [];
  startNotificationProducers(false, [a, undefined, b], { warn: (m) => warns.push(m) });
  assert.deepEqual([a.started, b.started], [1, 1]);
  assert.deepEqual(warns, []);
});

test("startNotificationProducers: rehearsal starts none and logs one line naming what is off", () => {
  const a = fakeProducer();
  const b = fakeProducer();
  const warns: string[] = [];
  startNotificationProducers(true, [a, b], { warn: (m) => warns.push(m) });
  assert.deepEqual([a.started, b.started], [0, 0]);
  assert.equal(warns.length, 1);
  assert.match(warns[0] ?? "", /REHEARSAL/);
  assert.ok(warns[0]?.includes(REHEARSAL_DISABLED));
});

let homes = 0;

/** A center over a real store, with one attached socket that has speech on. */
function home(urgentSpeech?: boolean) {
  const store = new NotificationStore({ dir: join(dir, `h${++homes}`, "notifications"), log: () => {} });
  const center = new NotificationCenter({
    store,
    logger: { info: () => {}, warn: () => {} },
    ...(urgentSpeech === undefined ? {} : { urgentSpeech }),
  });
  const frames: ServerFrame[] = [];
  const listener: NotificationListener = { sessionId: `s${homes}`, device: "phone", speaks: () => true, deliver: (f) => frames.push(f) };
  return { center, frames, listener };
}

const spoken = (frames: ServerFrame[]) => frames.filter((f) => f.type === "notification" && f.speak === true).length;

test("urgentSpeech false: an urgent raise is broadcast without speak, renotify too; nothing is pending for a later speech-on", async () => {
  const { center, frames, listener } = home(false);
  center.attach(listener);
  center.turnStarted("phone", listener.sessionId);
  const r = await center.raise({ source: "test", key: "k", urgency: "urgent", title: "Acil" });
  assert.equal(r.ok, true);
  await center.raise({ source: "test", key: "k", urgency: "urgent", title: "Acil", renotify: true });
  assert.equal(frames.filter((f) => f.type === "notification").length, 2);
  assert.equal(spoken(frames), 0);

  // Raised while no socket was attached: a later speech-on still speaks nothing.
  const late = home(false);
  await late.center.raise({ source: "test", urgency: "urgent", title: "Acil 2" });
  late.center.attach(late.listener);
  await late.center.speechOn(late.listener);
  assert.equal(spoken(late.frames), 0);
});

test("urgentSpeech false: the inbox still lists and deletes", async () => {
  const { center } = home(false);
  const r = await center.raise({ source: "test", urgency: "urgent", title: "Acil" });
  assert.ok(r.ok);
  const listed = await center.list();
  assert.equal(listed.items.length, 1);
  assert.equal(listed.unread, 1);
  assert.deepEqual(await center.act("phone", r.item.id, "delete"), { ok: true });
  assert.equal((await center.list()).items.length, 0);
});

test("default (flag off): an urgent raise is spoken once, and a pending one by the next speech-on, as before", async () => {
  const { center, frames, listener } = home();
  center.attach(listener);
  await center.raise({ source: "test", urgency: "urgent", title: "Acil" });
  assert.equal(spoken(frames), 1);

  const late = home(true);
  await late.center.raise({ source: "test", urgency: "urgent", title: "Acil 2" });
  late.center.attach(late.listener);
  await late.center.speechOn(late.listener);
  assert.equal(spoken(late.frames), 1);
});
