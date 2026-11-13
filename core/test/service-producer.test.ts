/**
 * T7.w.11.3: the service notification producer (docs/09 (b)). A fake monitor
 * (subscribe + snapshot of the shown status), a fake clock with fake timers
 * and a fake notification port that records raise / resolve and keeps the
 * items (for startup adoption).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { NotificationItem, RaiseInput, RaiseResult } from "../src/notifications.js";
import type { ServiceHealth, ServiceHealthStatus } from "../src/protocol.js";
import {
  SERVICE_SOURCE,
  ServiceProducer,
  detailText,
  type ProducerTimers,
  type ServiceHealthSource,
  type ServiceNotificationPort,
} from "../src/service-producer.js";

const S = 1_000;
const M = 60_000;
const T0 = Date.parse("2026-11-10T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const NAMES = ["home-assistant", "shadow-vault", "shadow-memory", "whisper-svc", "tts-svc"];

type Stored = Pick<NotificationItem, "source" | "key" | "urgency" | "title" | "body" | "createdAt">;

class FakeCenter implements ServiceNotificationPort {
  readonly raises: RaiseInput[] = [];
  /** `onlyIfExists` raises that found no item (T20.2): nothing created. */
  readonly missed: RaiseInput[] = [];
  readonly resolves: string[] = [];
  lists = 0;
  attempts = 0;
  readonly items = new Map<string, Stored>();
  unavailable = false;
  constructor(private readonly clock: () => number) {}
  async raise(input: RaiseInput): Promise<RaiseResult> {
    this.attempts++;
    if (this.unavailable) return { ok: false, reason: "unavailable" };
    const prev = this.items.get(input.key ?? "");
    if (input.onlyIfExists && !prev) {
      this.missed.push(input);
      return { ok: false, reason: "missing" };
    }
    this.raises.push(input);
    const item = {
      source: input.source,
      key: input.key,
      urgency: input.urgency ?? "normal",
      title: input.title,
      body: input.body ?? "",
      createdAt: prev?.createdAt ?? iso(this.clock()),
    };
    this.items.set(input.key ?? "", item);
    return { ok: true, item: { ...item, id: "n-0", updatedAt: iso(this.clock()), readAt: null, raised: 1 } as NotificationItem, created: !prev };
  }
  async resolve(_source: string, key: string): Promise<boolean> {
    if (this.unavailable) throw new Error("unavailable");
    this.resolves.push(key);
    return this.items.delete(key);
  }
  async list(): Promise<Stored[]> {
    this.lists++;
    if (this.unavailable) throw new Error("unavailable");
    return [...this.items.values()];
  }
}

/** Shown statuses; `set` fires subscribers only on a change, like HealthMonitor. */
class FakeMonitor implements ServiceHealthSource {
  current: ServiceHealth[] | undefined;
  private readonly listeners = new Set<(items: ServiceHealth[]) => void>();
  constructor(private readonly clock: () => number) {}
  snapshot(): ServiceHealth[] | undefined {
    return this.current?.map((i) => ({ ...i }));
  }
  subscribe(l: (items: ServiceHealth[]) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  /** Initial round: every covered service in `status`. */
  round(statuses: Record<string, ServiceHealthStatus | [ServiceHealthStatus, string]>): void {
    const items = NAMES.filter((n) => n in statuses).map((name) => {
      const v = statuses[name]!;
      const [status, detail] = Array.isArray(v) ? v : [v, undefined];
      return { name, status, checkedAt: this.clock(), ...(detail ? { detail } : {}) };
    });
    const prev = this.current;
    this.current = items;
    const changed = !prev || items.length !== prev.length || items.some((i, k) => prev[k]?.status !== i.status || prev[k]?.detail !== i.detail);
    if (changed) for (const l of [...this.listeners]) l(this.snapshot()!);
  }
}

class FakeTimers implements ProducerTimers {
  private seq = 0;
  readonly pending = new Map<number, { due: number; fn: () => void }>();
  constructor(private readonly clock: () => number) {}
  set(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.pending.set(id, { due: this.clock() + ms, fn });
    return id;
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }
}

const ALL_OK = { "home-assistant": "ok", "shadow-vault": "ok", "shadow-memory": "ok", "whisper-svc": "ok", "tts-svc": "ok" } as const;

async function setup(o: { items?: Stored[]; start?: boolean; first?: Record<string, ServiceHealthStatus | [ServiceHealthStatus, string]> } = {}) {
  let now = T0;
  const clock = () => now;
  const center = new FakeCenter(clock);
  for (const i of o.items ?? []) center.items.set(i.key ?? "", i);
  const monitor = new FakeMonitor(clock);
  const timers = new FakeTimers(clock);
  const logs: string[] = [];
  const producer = new ServiceProducer({
    monitor,
    notifications: center,
    logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
    now: clock,
    timers,
  });
  /** Waits for the producer's async work only; it never starts a round itself. */
  const settle = async () => {
    for (let k = 0; k < 3; k++) {
      await new Promise((r) => setImmediate(r));
      await producer.idle();
    }
  };
  /** Moves the clock to T0 + `at`, firing due timers in order. */
  const to = async (at: number) => {
    const target = T0 + at;
    for (;;) {
      let first: [number, { due: number; fn: () => void }] | undefined;
      for (const e of timers.pending) if (!first || e[1].due < first[1].due) first = e;
      if (!first || first[1].due > target) break;
      timers.pending.delete(first[0]);
      now = Math.max(now, first[1].due);
      first[1].fn();
      await settle();
    }
    now = target;
    await settle();
  };
  /** At T0 + `at`: a monitor round with these statuses (others keep theirs). */
  const shown = async (at: number, statuses: Record<string, ServiceHealthStatus | [ServiceHealthStatus, string]>) => {
    await to(at);
    const cur = Object.fromEntries((monitor.current ?? []).map((i) => [i.name, i.detail ? [i.status, i.detail] : i.status])) as Record<
      string,
      ServiceHealthStatus | [ServiceHealthStatus, string]
    >;
    monitor.round({ ...cur, ...statuses });
    await settle();
  };
  if (o.start !== false) {
    producer.start();
    monitor.round(o.first ?? ALL_OK);
    await settle();
  }
  return { center, monitor, producer, timers, logs, to, shown, settle, open: (key: string) => center.items.get(key) };
}

const HA = "service:home-assistant";

test("down for 89 s raises nothing; at 90 s one normal item with the Turkish title and detail text", async () => {
  const h = await setup();
  await h.shown(0, { "whisper-svc": ["down", "timeout"] });
  await h.to(89 * S);
  assert.equal(h.center.raises.length, 0);
  await h.to(90 * S);
  assert.equal(h.center.raises.length, 1);
  const r = h.center.raises[0]!;
  assert.equal(r.source, SERVICE_SOURCE);
  assert.equal(r.key, "service:whisper-svc");
  assert.equal(r.urgency, "normal");
  assert.equal(r.title, "Konuşma tanıma servisi yanıt vermiyor");
  assert.equal(r.body, "Sağlık kontrolü zaman aşımına uğradı.");
  assert.equal(r.renotify, true);
  await h.producer.close();
});

test("a detail change during the outage does not restart the 90 s, and updates the open item without renotify", async () => {
  const h = await setup();
  await h.shown(0, { "tts-svc": ["down", "timeout"] });
  await h.shown(60 * S, { "tts-svc": ["down", "unreachable"] });
  await h.to(90 * S);
  assert.equal(h.center.raises.length, 1);
  assert.equal(h.center.raises[0]!.title, "Ses servisi yanıt vermiyor");
  assert.equal(h.center.raises[0]!.body, "Servise bağlanılamadı.");
  await h.shown(120 * S, { "tts-svc": ["down", "http_502"] });
  assert.equal(h.center.raises.length, 2);
  assert.equal(h.center.raises[1]!.renotify, false);
  assert.equal(h.center.raises[1]!.body, "Servis HTTP 502 yanıtı verdi.");
  await h.producer.close();
});

test("a short outage (down < 90 s, then ok) raises nothing", async () => {
  const h = await setup();
  await h.shown(0, { "whisper-svc": "down" });
  await h.shown(60 * S, { "whisper-svc": "ok" });
  await h.to(10 * M);
  assert.equal(h.center.raises.length, 0);
  assert.equal(h.timers.pending.size, 0);
  await h.producer.close();
});

test("ok for 59 s keeps the item; at 60 s it is resolved", async () => {
  const h = await setup();
  await h.shown(0, { "tts-svc": "down" });
  await h.to(90 * S);
  await h.shown(100 * S, { "tts-svc": "ok" });
  await h.to(159 * S);
  assert.deepEqual(h.center.resolves, []);
  await h.to(160 * S);
  assert.deepEqual(h.center.resolves, ["service:tts-svc"]);
  assert.equal(h.open("service:tts-svc"), undefined);
  await h.producer.close();
});

test("a new outage inside the back window only updates the open item; the window restarts", async () => {
  const h = await setup();
  await h.shown(0, { "tts-svc": "down" });
  await h.to(90 * S);
  await h.shown(100 * S, { "tts-svc": "ok" });
  await h.shown(130 * S, { "tts-svc": ["down", "timeout"] }); // 30 s into the back window
  assert.equal(h.center.raises.length, 2);
  assert.equal(h.center.raises[1]!.renotify, false);
  await h.shown(140 * S, { "tts-svc": "ok" });
  await h.to(199 * S);
  assert.deepEqual(h.center.resolves, []);
  await h.to(200 * S);
  assert.deepEqual(h.center.resolves, ["service:tts-svc"]);
  await h.producer.close();
});

test("flap: 3 outages in 60 min → at most one open item, the third only updates, 15 min back window", async () => {
  const h = await setup();
  // Outage 1: opened at 90 s, resolved after 60 s ok.
  await h.shown(0, { "whisper-svc": "down" });
  await h.to(90 * S);
  await h.shown(2 * M, { "whisper-svc": "ok" });
  await h.to(3 * M);
  assert.deepEqual(h.center.resolves, ["service:whisper-svc"]);
  // Outage 2: opened again → 2 openings in the hour → the back window is 15 min.
  await h.shown(10 * M, { "whisper-svc": "down" });
  await h.to(10 * M + 90 * S);
  assert.equal(h.center.raises.filter((r) => r.renotify).length, 2);
  await h.shown(12 * M, { "whisper-svc": "ok" });
  await h.to(13 * M); // 60 s: still open
  assert.equal(h.center.resolves.length, 1);
  // Outage 3 inside the 15 min window: same item, no renotify, nothing new.
  await h.shown(20 * M, { "whisper-svc": ["down", "unreachable"] });
  await h.to(22 * M);
  assert.equal(h.center.raises.filter((r) => r.renotify).length, 2);
  const third = h.center.raises.at(-1)!;
  assert.equal(third.renotify, false);
  assert.equal(third.body, "Servise bağlanılamadı.");
  assert.equal(h.center.items.size, 1);
  // Back again: 15 min from the new ok.
  await h.shown(25 * M, { "whisper-svc": "ok" });
  await h.to(25 * M + 15 * M - 1 * S);
  assert.equal(h.center.resolves.length, 1);
  await h.to(40 * M);
  assert.deepEqual(h.center.resolves, ["service:whisper-svc", "service:whisper-svc"]);
  assert.equal(h.center.items.size, 0);
  await h.producer.close();
});

test("flap guard ends: openings older than 60 min no longer count", async () => {
  const h = await setup();
  await h.shown(0, { "tts-svc": "down" });
  await h.to(90 * S);
  await h.shown(2 * M, { "tts-svc": "ok" });
  await h.to(3 * M);
  await h.shown(70 * M, { "tts-svc": "down" });
  await h.to(70 * M + 90 * S);
  await h.shown(72 * M, { "tts-svc": "ok" });
  await h.to(73 * M);
  assert.equal(h.center.resolves.length, 2); // 60 s window again
  await h.producer.close();
});

test("loading for 180 s raises nothing; past 180 s the same key reads 'yüklenemedi'", async () => {
  const h = await setup();
  await h.shown(0, { "whisper-svc": "loading" });
  await h.to(180 * S);
  assert.equal(h.center.raises.length, 0);
  await h.to(181 * S);
  assert.equal(h.center.raises.length, 1);
  const r = h.center.raises[0]!;
  assert.equal(r.key, "service:whisper-svc");
  assert.equal(r.urgency, "normal");
  assert.equal(r.title, "Konuşma tanıma servisi yüklenemedi");
  // loading is not down: no 90 s raise, and ok resolves it.
  await h.shown(200 * S, { "whisper-svc": "ok" });
  await h.to(260 * S);
  assert.deepEqual(h.center.resolves, ["service:whisper-svc"]);
  await h.producer.close();
});

test("loading resets the down timer", async () => {
  const h = await setup();
  await h.shown(0, { "whisper-svc": "down" });
  await h.shown(80 * S, { "whisper-svc": "loading" });
  await h.shown(100 * S, { "whisper-svc": "down" });
  await h.to(189 * S);
  assert.equal(h.center.raises.length, 0);
  await h.to(190 * S);
  assert.equal(h.center.raises.length, 1);
  await h.producer.close();
});

test("disabled resolves the open item at once; a disabled service never raises", async () => {
  const h = await setup();
  await h.shown(0, { "tts-svc": "down" });
  await h.to(90 * S);
  await h.shown(100 * S, { "tts-svc": ["disabled", "off"] });
  assert.deepEqual(h.center.resolves, ["service:tts-svc"]);
  await h.to(60 * M);
  assert.equal(h.center.raises.length, 1);
  await h.producer.close();
});

test("HA: normal at 90 s, still normal at 29:59, urgent with renotify at 30:00 (once)", async () => {
  const h = await setup();
  await h.shown(0, { "home-assistant": ["down", "unauthorized"] });
  await h.to(90 * S);
  assert.equal(h.center.raises.length, 1);
  assert.equal(h.center.raises[0]!.urgency, "normal");
  assert.equal(h.center.raises[0]!.title, "Home Assistant'a ulaşılamıyor");
  assert.equal(h.center.raises[0]!.body, "Erişim reddedildi; erişim anahtarı geçersiz olabilir.");
  await h.to(30 * M - 1 * S);
  assert.equal(h.center.raises.length, 1);
  await h.to(30 * M);
  assert.equal(h.center.raises.length, 2);
  const u = h.center.raises[1]!;
  assert.equal(u.key, HA);
  assert.equal(u.urgency, "urgent");
  assert.equal(u.renotify, true);
  await h.to(120 * M);
  assert.equal(h.center.raises.length, 2);
  // A detail change keeps it urgent, without renotify.
  await h.shown(121 * M, { "home-assistant": ["down", "timeout"] });
  assert.equal(h.center.raises.length, 3);
  assert.equal(h.center.raises[2]!.urgency, "urgent");
  assert.equal(h.center.raises[2]!.renotify, false);
  await h.producer.close();
});

test("HA: the 30 min count restarts after a recovery", async () => {
  const h = await setup();
  await h.shown(0, { "home-assistant": "down" });
  await h.to(90 * S);
  await h.shown(20 * M, { "home-assistant": "ok" }); // one good check: a break
  await h.shown(20 * M + 30 * S, { "home-assistant": "down" }); // item still open
  await h.to(20 * M + 30 * S + 30 * M - 1 * S);
  assert.ok(h.center.raises.every((r) => r.urgency === "normal"));
  await h.to(20 * M + 30 * S + 30 * M);
  assert.equal(h.center.raises.at(-1)!.urgency, "urgent");
  assert.equal(h.center.raises.at(-1)!.renotify, true);
  // Resolved, then a new outage: normal at 90 s again, urgent 30 min later.
  await h.shown(60 * M, { "home-assistant": "ok" });
  await h.to(61 * M);
  assert.deepEqual(h.center.resolves, [HA]);
  await h.shown(70 * M, { "home-assistant": "down" });
  await h.to(70 * M + 90 * S);
  assert.equal(h.center.raises.at(-1)!.urgency, "normal");
  assert.equal(h.center.raises.at(-1)!.renotify, true);
  await h.to(100 * M);
  assert.equal(h.center.raises.at(-1)!.urgency, "urgent");
  await h.producer.close();
});

test("whisper / tts / vault / memory never become urgent", async () => {
  const h = await setup();
  await h.shown(0, { "whisper-svc": "down", "tts-svc": "down", "shadow-vault": "down", "shadow-memory": "down" });
  await h.to(5 * 60 * M);
  assert.equal(h.center.raises.length, 4);
  assert.ok(h.center.raises.every((r) => r.urgency === "normal"));
  await h.producer.close();
});

test("vault and memory use service:vault / service:memory with Turkish texts", async () => {
  const h = await setup();
  await h.shown(0, { "shadow-vault": ["down", "not_found"], "shadow-memory": ["down", "error"] });
  await h.to(90 * S);
  const vault = h.open("service:vault");
  const memory = h.open("service:memory");
  assert.equal(vault?.title, "Not kasasına (vault) ulaşılamıyor");
  assert.equal(vault?.body, "Klasör bulunamadı.");
  assert.equal(memory?.title, "Hafıza deposu kullanılamıyor");
  assert.equal(memory?.body, "Servis hata bildirdi.");
  await h.shown(2 * M, { "shadow-vault": "ok", "shadow-memory": "ok" });
  await h.to(3 * M);
  assert.deepEqual(h.center.resolves.sort(), ["service:memory", "service:vault"]);
  await h.producer.close();
});

test("startup adoption: an outage that ended while the Core was down is resolved after 60 s ok", async () => {
  const h = await setup({
    items: [{ source: SERVICE_SOURCE, key: "service:tts-svc", urgency: "normal", title: "Ses servisi yanıt vermiyor", body: "x", createdAt: iso(T0 - 5 * 60 * M) }],
  });
  await h.to(59 * S);
  assert.deepEqual(h.center.resolves, []);
  await h.to(60 * S);
  assert.deepEqual(h.center.resolves, ["service:tts-svc"]);
  assert.equal(h.center.raises.length, 0);
  await h.producer.close();
});

test("startup adoption: an unchanged outage is not raised again; an adopted urgent HA item is not re-escalated", async () => {
  const h = await setup({
    items: [
      { source: SERVICE_SOURCE, key: "service:whisper-svc", urgency: "normal", title: "Konuşma tanıma servisi yanıt vermiyor", body: "Sağlık kontrolü zaman aşımına uğradı.", createdAt: iso(T0 - M) },
      {
        source: SERVICE_SOURCE,
        key: HA,
        urgency: "urgent",
        title: "Home Assistant'a ulaşılamıyor",
        body: "Servise bağlanılamadı. 30 dakikadan uzun süredir ulaşılamıyor.",
        createdAt: iso(T0 - 60 * M),
      },
      { source: "backup", key: "backup:failed", urgency: "normal", title: "b", body: "b", createdAt: iso(T0) },
    ],
    first: { ...ALL_OK, "whisper-svc": ["down", "timeout"], "home-assistant": ["down", "unreachable"] },
  });
  await h.to(60 * M);
  assert.equal(h.center.raises.length, 0);
  assert.deepEqual(h.center.resolves, []);
  assert.equal(h.center.items.size, 3);
  await h.producer.close();
});

test("startup adoption: an adopted item of a service missing from the snapshot is resolved", async () => {
  const first = { ...ALL_OK } as Record<string, ServiceHealthStatus>;
  delete first["tts-svc"];
  const h = await setup({
    items: [{ source: SERVICE_SOURCE, key: "service:tts-svc", urgency: "normal", title: "t", body: "b", createdAt: iso(T0) }],
    first,
  });
  assert.deepEqual(h.center.resolves, ["service:tts-svc"]);
  await h.producer.close();
});

test("an unreadable inbox delays adoption and is retried; no raise before it", async () => {
  const h = await setup({ start: false });
  h.center.unavailable = true;
  h.producer.start();
  h.monitor.round({ ...ALL_OK, "tts-svc": "down" });
  await h.settle();
  await h.to(90 * S);
  assert.equal(h.center.raises.length, 0);
  h.center.unavailable = false;
  await h.to(3 * M); // retry timer
  assert.equal(h.center.raises.length, 1);
  assert.ok(h.logs.some((l) => l.includes("startup reconcile retried")));
  await h.producer.close();
});

test("a failed raise is retried later", async () => {
  const h = await setup();
  await h.shown(0, { "tts-svc": "down" });
  h.center.unavailable = true;
  await h.to(90 * S);
  assert.equal(h.center.raises.length, 0);
  h.center.unavailable = false;
  await h.to(90 * S + 60 * S);
  assert.equal(h.center.raises.length, 1);
  assert.equal(h.center.raises[0]!.renotify, true);
  await h.producer.close();
});

test("close unsubscribes and clears the timer", async () => {
  const h = await setup();
  await h.shown(0, { "tts-svc": "down" });
  assert.equal(h.timers.pending.size, 1);
  await h.producer.close();
  assert.equal(h.timers.pending.size, 0);
  h.monitor.round({ ...ALL_OK, "tts-svc": "ok" });
  await h.to(10 * M);
  assert.equal(h.center.raises.length, 0);
});

test("an item the user deleted is not recreated by a detail change (no new urgent item, no speech)", async () => {
  const h = await setup();
  await h.shown(0, { "home-assistant": ["down", "timeout"] });
  await h.to(30 * M);
  assert.equal(h.center.raises.at(-1)!.urgency, "urgent");
  const before = h.center.raises.length;
  h.center.items.delete(HA); // "Gördüm"
  await h.shown(31 * M, { "home-assistant": ["down", "unreachable"] });
  await h.shown(32 * M, { "home-assistant": ["down", "timeout"] });
  assert.equal(h.center.raises.length, before);
  assert.equal(h.center.items.size, 0);
  // T20.2: one update was tried with onlyIfExists (the store answered `missing`); no further tries.
  assert.equal(h.center.missed.length, 1);
  assert.equal(h.center.missed[0]!.onlyIfExists, true);
  assert.equal(h.center.missed[0]!.renotify, false);
  // Recovery resolves (nothing to delete), a new outage raises a new item again.
  await h.shown(33 * M, { "home-assistant": "ok" });
  await h.to(34 * M);
  await h.shown(40 * M, { "home-assistant": "down" });
  await h.to(40 * M + 90 * S);
  assert.equal(h.center.raises.length, before + 1);
  assert.equal(h.center.raises.at(-1)!.renotify, true);
  assert.equal(h.center.raises.at(-1)!.urgency, "normal");
  await h.producer.close();
});

test("T20.2: only a text update is raised with onlyIfExists; a new item and the urgent re-raise create as before", async () => {
  const h = await setup();
  await h.shown(0, { "home-assistant": ["down", "timeout"] });
  await h.to(90 * S);
  await h.shown(2 * M, { "home-assistant": ["down", "unreachable"] });
  await h.to(30 * M);
  const [opening, update, escalation] = h.center.raises;
  assert.equal(h.center.raises.length, 3);
  assert.equal(opening!.renotify, true);
  assert.equal(opening!.onlyIfExists, undefined);
  assert.equal(update!.renotify, false);
  assert.equal(update!.onlyIfExists, true);
  assert.equal(escalation!.urgency, "urgent");
  assert.equal(escalation!.renotify, true);
  assert.equal(escalation!.onlyIfExists, undefined);
  // The update path no longer reads the whole inbox first (the store checks in the same step).
  assert.equal(h.center.lists, 1); // startup adoption only
  await h.producer.close();
});

test("T20.2: an item deleted between the producer's last look and the update is not recreated", async () => {
  const h = await setup();
  await h.shown(0, { "tts-svc": ["down", "timeout"] });
  await h.to(90 * S);
  assert.equal(h.center.items.size, 1);
  // The user deletes the item right before the update reaches the store.
  const orig = h.center.raise.bind(h.center);
  h.center.raise = async (input) => {
    h.center.items.delete("service:tts-svc");
    return orig(input);
  };
  await h.shown(2 * M, { "tts-svc": ["down", "unreachable"] });
  assert.equal(h.center.items.size, 0);
  assert.equal(h.center.raises.length, 1);
  assert.equal(h.center.missed.length, 1);
  assert.ok(h.logs.some((l) => l.includes("service:tts-svc deleted by the user")));
  h.center.raise = orig;
  // Still open: recovery resolves it; the next outage is a new item again.
  await h.shown(3 * M, { "tts-svc": "ok" });
  await h.to(4 * M);
  assert.deepEqual(h.center.resolves, ["service:tts-svc"]);
  await h.shown(10 * M, { "tts-svc": "down" });
  await h.to(10 * M + 90 * S);
  assert.equal(h.center.items.size, 1);
  assert.equal(h.center.raises.at(-1)!.renotify, true);
  assert.equal(h.center.raises.at(-1)!.onlyIfExists, undefined);
  await h.producer.close();
});

test("a failed key is not retried before 60 s, even when other changes arrive", async () => {
  const h = await setup();
  await h.shown(0, { "tts-svc": "down" });
  h.center.unavailable = true;
  await h.to(90 * S);
  assert.equal(h.center.attempts, 1);
  await h.shown(100 * S, { "whisper-svc": "down" });
  await h.shown(120 * S, { "whisper-svc": ["down", "timeout"] });
  await h.to(149 * S);
  assert.equal(h.center.attempts, 1);
  h.center.unavailable = false;
  await h.to(150 * S);
  assert.equal(h.center.attempts, 2);
  assert.equal(h.open("service:tts-svc")?.title, "Ses servisi yanıt vermiyor");
  await h.producer.close();
});

test("a monitor change during a running evaluation is evaluated afterwards", async () => {
  const h = await setup();
  await h.shown(0, { "tts-svc": "down" });
  await h.to(89 * S);
  // The raise at 90 s triggers a change of another service while the round is in flight.
  const orig = h.center.raise.bind(h.center);
  let once = true;
  h.center.raise = async (input) => {
    if (once) {
      once = false;
      h.monitor.round({ ...ALL_OK, "tts-svc": "down", "whisper-svc": "down" });
    }
    return orig(input);
  };
  await h.to(90 * S);
  await h.to(180 * S - 1);
  assert.equal(h.open("service:whisper-svc"), undefined);
  await h.to(180 * S);
  assert.equal(h.open("service:whisper-svc")?.title, "Konuşma tanıma servisi yanıt vermiyor");
  await h.producer.close();
});

test("detailText maps codes to Turkish and never echoes unknown text", () => {
  assert.equal(detailText("http_503"), "Servis HTTP 503 yanıtı verdi.");
  assert.equal(detailText(undefined), "Servis yanıt vermiyor.");
  assert.equal(detailText("https://example.invalid/secret"), "Servis yanıt vermiyor.");
  assert.equal(detailText("constructor"), "Servis yanıt vermiyor.");
});

test("a live service removed from the snapshot resolves like disabled", async () => {
  const h = await setup();
  await h.shown(0, { "whisper-svc": "down" });
  await h.to(90 * S);
  assert.equal(h.center.items.size, 1);
  await h.to(5 * M);
  h.monitor.round({ "home-assistant": "ok", "shadow-vault": "ok", "shadow-memory": "ok", "tts-svc": "ok" }); // whisper-svc gone
  await h.settle();
  assert.deepEqual(h.center.resolves, ["service:whisper-svc"]);
  assert.equal(h.center.items.size, 0);
  await h.producer.close();
});

test("HA: an item the user deleted is recreated by the 30 min urgent re-raise (spoken once)", async () => {
  const h = await setup();
  await h.shown(0, { "home-assistant": "down" });
  await h.to(90 * S);
  h.center.items.delete(HA);
  await h.to(30 * M - 1 * S);
  assert.equal(h.center.raises.length, 1);
  await h.to(30 * M);
  assert.equal(h.center.raises.length, 2);
  assert.equal(h.center.raises[1]!.urgency, "urgent");
  assert.equal(h.center.raises[1]!.renotify, true);
  assert.equal(h.center.items.size, 1);
  await h.to(90 * M);
  assert.equal(h.center.raises.length, 2);
  await h.producer.close();
});

test("HA: the urgent re-raise also happens on an item kept open by the flap guard", async () => {
  const h = await setup();
  await h.shown(0, { "home-assistant": "down" });
  await h.to(90 * S);
  await h.shown(2 * M, { "home-assistant": "ok" });
  await h.to(3 * M);
  await h.shown(10 * M, { "home-assistant": "down" });
  await h.to(10 * M + 90 * S); // second opening in the hour
  await h.shown(12 * M, { "home-assistant": "ok" }); // 15 min back window
  await h.shown(13 * M, { "home-assistant": "down" }); // inside the window: update only
  assert.equal(h.center.items.size, 1);
  await h.to(13 * M + 30 * M - 1 * S);
  assert.ok(h.center.raises.every((r) => r.urgency === "normal"));
  await h.to(13 * M + 30 * M);
  assert.equal(h.center.raises.at(-1)!.urgency, "urgent");
  assert.equal(h.center.raises.at(-1)!.renotify, true);
  assert.equal(h.center.items.size, 1);
  await h.producer.close();
});
