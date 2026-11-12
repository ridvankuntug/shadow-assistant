/**
 * Service notification producer (docs/09 (b), T7.w.11.3).
 *
 * Watches the *shown* status of `HealthMonitor` (after its 2-check hysteresis)
 * through `subscribe()` and `snapshot()`; it adds no checks of its own. Each
 * covered services.yaml entry (`COVERED_SERVICES`) has one keyed item of
 * source `service`:
 *
 * - `down` continuously for 90 s → raise (normal), a per-service Turkish title
 *   and the detail code as Turkish text. A detail change during an outage
 *   updates the text but does not restart the 90 s.
 * - `loading` for more than 180 s → the same key, "yüklenemedi".
 * - `ok` continuously for 60 s → resolve. Flap guard: when the key was opened
 *   ≥ 2 times in the last 60 min (counted at the start of the `ok` period),
 *   the back window is 15 min. While the item is open (back window included),
 *   a new outage only updates the item: no new item, no renotify, no speech.
 * - `disabled`, or the service missing from the snapshot → resolve at once.
 * - Home Assistant only: down for 30 min without a break (counted from the
 *   shown `down`; any other shown status restarts it) → the open item is
 *   re-raised **urgent** with `renotify` (spoken once by NotificationCenter),
 *   once per item; a resolved item starts over as normal.
 *
 * Timing: statuses are timestamped when the producer sees them (the monitor's
 * `subscribe()` fires right after a round). After every evaluation one timer
 * is armed for the earliest deadline; when it fires, `snapshot()` is read
 * again before deciding. A failed store call is retried after RETRY_MS (per
 * key: earlier rounds skip that key's store calls until then).
 *
 * Startup reconcile: before the first evaluation the existing `service` items
 * of the covered keys are read from the store and adopted as open (an urgent
 * one counts as already escalated; its `createdAt` counts as an opening for
 * the flap guard), so a service that recovered while the Core was down is
 * resolved by the normal back rule and an unchanged outage is not raised again.
 *
 * Producer state is in memory (docs/09 common rules). Texts are Turkish and
 * never hold hosts, URLs or error messages: only the monitor's fixed detail
 * codes are mapped.
 */
import type { NotificationItem, NotificationUrgency, RaiseInput, RaiseResult } from "./notifications.js";
import type { ServiceHealth, ServiceHealthStatus } from "./protocol.js";
import type { Logger } from "./session.js";

export const SERVICE_SOURCE = "service";

const MINUTE = 60_000;
/** Shown `down` continuously this long → raise. */
export const SERVICE_DOWN_MS = 90_000;
/** Shown `loading` longer than this → raise "yüklenemedi". */
export const SERVICE_LOADING_MS = 180_000;
/** Shown `ok` continuously this long → resolve. */
export const SERVICE_BACK_MS = 60_000;
/** Back window when the key flaps. */
export const SERVICE_FLAP_BACK_MS = 15 * MINUTE;
/** Flap guard: openings counted over this window ... */
export const SERVICE_FLAP_WINDOW_MS = 60 * MINUTE;
/** ... at least this many → the longer back window. */
export const SERVICE_FLAP_OPENINGS = 2;
/** Home Assistant down this long without a break → urgent. */
export const SERVICE_URGENT_MS = 30 * MINUTE;
/** Retry delay after a failed store call or an unreadable inbox at startup. */
const RETRY_MS = 60_000;

export interface CoveredService {
  /** Notification key. */
  key: string;
  /** Subject of the "yüklenemedi" title. */
  noun: string;
  /** Title while down. */
  downTitle: string;
  /** Down for SERVICE_URGENT_MS → urgent (Home Assistant only, decided). */
  escalates: boolean;
}

/**
 * Covered services by services.yaml name. Vault and memory keep the short keys
 * `service:vault` / `service:memory` (decided); unknown names are ignored.
 */
export const COVERED_SERVICES: ReadonlyMap<string, CoveredService> = new Map([
  ["home-assistant", { key: "service:home-assistant", noun: "Home Assistant", downTitle: "Home Assistant'a ulaşılamıyor", escalates: true }],
  ["whisper-svc", { key: "service:whisper-svc", noun: "Konuşma tanıma servisi", downTitle: "Konuşma tanıma servisi yanıt vermiyor", escalates: false }],
  ["tts-svc", { key: "service:tts-svc", noun: "Ses servisi", downTitle: "Ses servisi yanıt vermiyor", escalates: false }],
  ["shadow-vault", { key: "service:vault", noun: "Not kasası (vault)", downTitle: "Not kasasına (vault) ulaşılamıyor", escalates: false }],
  ["shadow-memory", { key: "service:memory", noun: "Hafıza deposu", downTitle: "Hafıza deposu kullanılamıyor", escalates: false }],
]);

const DETAIL_TR: Record<string, string> = {
  timeout: "Sağlık kontrolü zaman aşımına uğradı.",
  unreachable: "Servise bağlanılamadı.",
  unauthorized: "Erişim reddedildi; erişim anahtarı geçersiz olabilir.",
  error: "Servis hata bildirdi.",
  bad_response: "Servis beklenmeyen bir yanıt verdi.",
  not_found: "Klasör bulunamadı.",
};
const DETAIL_HTTP = /^http_([1-5][0-9]{2})$/;

/** The monitor's detail code as Turkish text (never the code's source). */
export function detailText(detail: string | undefined): string {
  if (detail !== undefined) {
    if (Object.hasOwn(DETAIL_TR, detail)) return DETAIL_TR[detail]!;
    const m = DETAIL_HTTP.exec(detail);
    if (m) return `Servis HTTP ${m[1]} yanıtı verdi.`;
  }
  return "Servis yanıt vermiyor.";
}

const URGENT_NOTE = "30 dakikadan uzun süredir ulaşılamıyor.";
const LOADING_BODY = "Servis 3 dakikadan uzun süredir yükleniyor; model yüklenememiş olabilir.";

/** What the producer needs from NotificationCenter (raise / resolve) and the store (startup adoption). */
export interface ServiceNotificationPort {
  raise(input: RaiseInput): Promise<RaiseResult>;
  /** Rejects when the inbox cannot be read; retried later. */
  resolve(source: string, key: string): Promise<boolean>;
  /** Every item (any source); rejects when the inbox cannot be read. */
  list(): Promise<ReadonlyArray<Pick<NotificationItem, "source" | "key" | "urgency" | "title" | "body" | "createdAt">>>;
}

/** The part of HealthMonitor the producer reads (shown statuses). */
export interface ServiceHealthSource {
  snapshot(): ServiceHealth[] | undefined;
  subscribe(listener: (items: ServiceHealth[]) => void): () => void;
}

export interface ProducerTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface ServiceProducerOptions {
  monitor: ServiceHealthSource;
  notifications: ServiceNotificationPort;
  logger: Logger;
  now?: () => number;
  /** Test hook; default setTimeout (unref'd) / clearTimeout. */
  timers?: ProducerTimers;
  /** Test hook; default COVERED_SERVICES. */
  covered?: ReadonlyMap<string, CoveredService>;
}

interface Open {
  urgency: NotificationUrgency;
  title: string;
  body: string;
  /** Re-raised urgent (HA, 30 min); once per item. */
  escalated: boolean;
}

interface Track {
  readonly name: string;
  readonly def: CoveredService;
  /** Shown status; `missing` = not in the snapshot (removed from services.yaml); undefined before the first round. */
  status: ServiceHealthStatus | "missing" | undefined;
  detail: string | undefined;
  /** When the shown status last changed (a detail change does not count). */
  since: number;
  open: Open | undefined;
  /** When the key was opened (new item), for the flap guard. */
  openings: number[];
  /** No store call for this key before this (after a failed one). */
  retryAt: number | undefined;
  /** Set by a failed store call during the current step. */
  failed: boolean;
  /** The open item was deleted by the user: no text updates until it resolves (escalation still re-raises it). */
  deleted: boolean;
}

interface Want {
  urgency: NotificationUrgency;
  title: string;
  body: string;
  escalated: boolean;
}

const defaultTimers: ProducerTimers = {
  set(fn, ms) {
    const t = setTimeout(fn, ms);
    // The HTTP server keeps the process alive; the producer alone must not.
    t.unref?.();
    return t;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export class ServiceProducer {
  private readonly now: () => number;
  private readonly timers: ProducerTimers;
  private readonly tracks = new Map<string, Track>();
  private unsubscribe: (() => void) | undefined;
  private timer: unknown;
  private adopted = false;
  private loggedAdoptFailure = false;
  /** No startup reconcile attempt before this (after a failed one). */
  private adoptRetryAt: number | undefined;
  private running: Promise<void> | null = null;
  private again = false;
  private started = false;
  private closed = false;

  constructor(private readonly o: ServiceProducerOptions) {
    this.now = o.now ?? Date.now;
    this.timers = o.timers ?? defaultTimers;
    for (const [name, def] of o.covered ?? COVERED_SERVICES) {
      this.tracks.set(name, { name, def, status: undefined, detail: undefined, since: 0, open: undefined, openings: [], retryAt: undefined, failed: false, deleted: false });
    }
  }

  /** Subscribes to the monitor and evaluates once (startup adoption first). */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.unsubscribe = this.o.monitor.subscribe((items) => {
      this.observe(items);
      void this.checkNow();
    });
    void this.checkNow();
  }

  /** Evaluates now; while one runs, it runs once more afterwards. Never rejects. */
  checkNow(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        try {
          await this.round();
        } catch (err) {
          this.o.logger.warn(`[shadow-core] service producer: round failed (${(err as Error)?.name ?? "error"})`);
          this.arm(this.now() + RETRY_MS);
        }
      } while (this.again && !this.closed);
      // Same synchronous step as the last `again` check: a request after it starts a new run.
      this.running = null;
    })();
    return this.running;
  }

  /** Resolves when no evaluation is running (test hook; starts nothing). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  /** Unsubscribes, stops the timer and waits for the running evaluation. */
  async close(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.disarm();
    await this.running;
  }

  /** Records shown statuses with the time they were first seen. */
  private observe(items: readonly ServiceHealth[]): void {
    const now = this.now();
    const byName = new Map(items.map((i) => [i.name, i]));
    for (const t of this.tracks.values()) {
      const h = byName.get(t.name);
      const status = h ? h.status : "missing";
      if (status !== t.status) {
        t.status = status;
        t.since = now;
      }
      t.detail = h?.detail;
    }
  }

  private async round(): Promise<void> {
    if (!this.adopted) {
      if (this.adoptRetryAt !== undefined && this.now() < this.adoptRetryAt) return this.arm(this.adoptRetryAt);
      if (!(await this.adopt())) {
        this.adoptRetryAt = this.now() + RETRY_MS;
        return this.arm(this.adoptRetryAt);
      }
    }
    const snap = this.o.monitor.snapshot();
    if (snap) this.observe(snap);
    let next: number | undefined;
    for (const t of this.tracks.values()) {
      if (this.closed) return;
      const due = await this.stepOrWait(t, this.now());
      if (due !== undefined) next = next === undefined ? due : Math.min(next, due);
    }
    this.arm(next);
  }

  /** Startup reconcile: the store's covered `service` items count as open. False when the inbox could not be read. */
  private async adopt(): Promise<boolean> {
    let items: Awaited<ReturnType<ServiceNotificationPort["list"]>>;
    try {
      items = await this.o.notifications.list();
    } catch {
      if (!this.loggedAdoptFailure) {
        this.loggedAdoptFailure = true;
        this.o.logger.warn("[shadow-core] service producer: notifications unreadable; startup reconcile retried later");
      }
      return false;
    }
    const byKey = new Map([...this.tracks.values()].map((t) => [t.def.key, t]));
    for (const item of items) {
      if (item.source !== SERVICE_SOURCE || item.key === undefined) continue;
      const t = byKey.get(item.key);
      if (!t) continue;
      t.open = { urgency: item.urgency, title: item.title, body: item.body, escalated: item.urgency === "urgent" };
      const createdAt = Date.parse(item.createdAt);
      if (Number.isFinite(createdAt)) t.openings.push(createdAt);
    }
    this.adopted = true;
    return true;
  }

  /** `step`, but no store call for a key before its retry time (after a failed one). */
  private async stepOrWait(t: Track, now: number): Promise<number | undefined> {
    if (t.retryAt !== undefined && now < t.retryAt) return t.retryAt;
    t.retryAt = undefined;
    const due = await this.step(t, now);
    t.retryAt = t.failed ? due : undefined;
    t.failed = false;
    return due;
  }

  /** The rules of docs/09 (b) for one service at `now`; returns its next deadline. */
  private async step(t: Track, now: number): Promise<number | undefined> {
    const s = t.status;
    if (s === undefined) return undefined; // no round yet: adopted items wait
    if (s === "disabled" || s === "missing") return this.resolve(t, now);
    const dur = now - t.since;
    if (s === "ok") {
      if (!t.open) return undefined;
      const back = this.flapping(t) ? SERVICE_FLAP_BACK_MS : SERVICE_BACK_MS;
      return dur >= back ? this.resolve(t, now) : t.since + back;
    }
    if (s === "loading") {
      // "More than 180 s": the deadline is the first ms past it.
      if (dur <= SERVICE_LOADING_MS) return t.since + SERVICE_LOADING_MS + 1;
      const escalated = t.open?.escalated ?? false;
      return this.show(t, now, {
        urgency: escalated ? "urgent" : "normal",
        title: `${t.def.noun} yüklenemedi`,
        body: LOADING_BODY,
        escalated,
      });
    }
    // down
    if (!t.open && dur < SERVICE_DOWN_MS) return t.since + SERVICE_DOWN_MS;
    const escalated = t.def.escalates && ((t.open?.escalated ?? false) || dur >= SERVICE_URGENT_MS);
    const retry = await this.show(t, now, {
      urgency: escalated ? "urgent" : "normal",
      title: t.def.downTitle,
      body: escalated ? `${detailText(t.detail)} ${URGENT_NOTE}` : detailText(t.detail),
      escalated,
    });
    if (retry !== undefined) return retry;
    return t.def.escalates && !escalated ? t.since + SERVICE_URGENT_MS : undefined;
  }

  /** Flap guard: opened ≥ SERVICE_FLAP_OPENINGS times in the hour before the `ok` period started. */
  private flapping(t: Track): boolean {
    t.openings = t.openings.filter((at) => at > t.since - SERVICE_FLAP_WINDOW_MS);
    return t.openings.filter((at) => at <= t.since).length >= SERVICE_FLAP_OPENINGS;
  }

  /**
   * Raises or updates the item. New item: renotify (it opens the key);
   * escalation to urgent: renotify (spoken once); otherwise only a changed
   * text is written, without renotify, and only while the item still exists:
   * an item the user deleted is not recreated (a raise would create it, and
   * an urgent new item would be spoken). Returns a retry deadline on failure.
   */
  private async show(t: Track, now: number, want: Want): Promise<number | undefined> {
    const cur = t.open;
    const opening = !cur;
    const escalating = !!cur && want.urgency === "urgent" && cur.urgency !== "urgent";
    if (cur && !escalating && cur.urgency === want.urgency && cur.title === want.title && cur.body === want.body) {
      cur.escalated = want.escalated;
      return undefined;
    }
    const renotify = opening || escalating;
    if (cur && !renotify) {
      if (t.deleted) return undefined;
      let exists: boolean;
      try {
        exists = (await this.o.notifications.list()).some((i) => i.source === SERVICE_SOURCE && i.key === t.def.key);
      } catch {
        t.failed = true;
        return now + RETRY_MS;
      }
      if (!exists) {
        t.deleted = true;
        this.o.logger.info(`[shadow-core] service producer: ${t.def.key} deleted by the user; not updated until it resolves`);
        return undefined;
      }
    }
    let r: RaiseResult;
    try {
      r = await this.o.notifications.raise({
        source: SERVICE_SOURCE,
        key: t.def.key,
        urgency: want.urgency,
        title: want.title,
        body: want.body,
        renotify,
      });
    } catch {
      t.failed = true;
      return now + RETRY_MS;
    }
    if (!r.ok) {
      if (r.reason !== "unavailable") this.o.logger.warn(`[shadow-core] service producer: ${t.def.key} raise refused (${r.reason})`);
      t.failed = true;
      return now + RETRY_MS;
    }
    t.deleted = false;
    t.open = { urgency: want.urgency, title: want.title, body: want.body, escalated: want.escalated };
    if (opening) t.openings.push(now);
    this.o.logger.info(
      `[shadow-core] service producer: ${t.def.key} ${opening ? "raised" : "updated"} (${want.urgency}${renotify ? ", renotify" : ""})`,
    );
    return undefined;
  }

  private async resolve(t: Track, now: number): Promise<number | undefined> {
    if (!t.open) return undefined;
    try {
      await this.o.notifications.resolve(SERVICE_SOURCE, t.def.key);
    } catch {
      t.failed = true;
      return now + RETRY_MS; // inbox unreadable: still open
    }
    t.open = undefined;
    t.deleted = false;
    this.o.logger.info(`[shadow-core] service producer: ${t.def.key} resolved`);
    return undefined;
  }

  /** One timer for the earliest deadline; none when nothing is pending. */
  private arm(at: number | undefined): void {
    this.disarm();
    if (at === undefined || this.closed) return;
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      void this.checkNow();
    }, Math.max(0, at - this.now()));
  }

  private disarm(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }
}
