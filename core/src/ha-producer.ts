/**
 * Home Assistant alerts producer (docs/09 (c), T7.w.11.5): HA's persistent
 * notifications as keyed items of source `ha`, read through the read-only
 * WebSocket client (ha-client.ts).
 *
 * - On every authenticated connection: `persistent_notification/subscribe`.
 *   HA answers with the complete current set (event `current`), then
 *   `added` / `updated` / `removed` events, each `{type, notifications:
 *   {<id>: {notification_id, title, message, created_at}}}`.
 * - Key `pn:<notification_id>`; an id too long for the store's key limit is
 *   hashed (`pn:sha256:<hex>`). Title and message are copied, trimmed and cut
 *   to the store limits; never logged (logs hold counts only, no ids).
 * - Resolve: a key missing from a **complete** listing (the `current` event of a
 *   subscription, kept complete by the events after it) is resolved once
 *   HA_RESOLVE_GRACE_MS has passed since that `current`; a key named in a
 *   `removed` event is resolved at once. A lost connection says nothing about
 *   HA's data: nothing is resolved until the next `current`.
 * - An update of the same id replaces the item without renotify; an unchanged
 *   one (e.g. the same set again after a reconnect) writes nothing.
 * - `auth_invalid` → one normal item `ha:access` ("HA uyarıları okunamıyor"),
 *   resolved on the next authenticated connection.
 * - Urgency: `haAlertUrgency` (one function; normal for now, learned urgency is
 *   T7.w.11.10).
 *
 * Startup reconcile (docs/09 common rules): existing `ha` items with a `pn:` key
 * and `ha:access` are adopted as open, and keys the user suppressed ("Tekrar
 * gösterme", T7.w.11.7) are adopted as open and suppressed, so the first complete
 * listing resolves (and un-suppresses) what ended while the Core was down. Store
 * calls wait for the adoption; an unreadable inbox is retried after RETRY_MS, an
 * unreadable suppression list is logged once and re-read after RETRY_MS while the
 * producer goes on. A failed store call is retried after RETRY_MS.
 *
 * Nothing is ever sent to HA except the read-only commands of ha-client.ts:
 * deleting or suppressing a Shadow item never touches HA.
 */
import { createHash } from "node:crypto";
import { HaClient, HaClosedError, haWebSocketUrl, type HaClientHandlers, type HaConnection, type HaTimers } from "./ha-client.js";
import {
  MAX_BODY_CHARS,
  MAX_KEY_CHARS,
  MAX_TITLE_CHARS,
  type NotificationItem,
  type NotificationUrgency,
  type RaiseInput,
  type RaiseResult,
} from "./notifications.js";
import type { Logger } from "./session.js";

export const HA_SOURCE = "ha";
export const HA_ACCESS_KEY = "ha:access";
export const PN_KEY_PREFIX = "pn:";
const PN_SUBSCRIBE = "persistent_notification/subscribe";
/** Retry delay after a failed store call or an unreadable inbox / suppression list. */
const RETRY_MS = 60_000;
/**
 * After a `current` listing, ids missing from it are resolved only this much later
 * (if still missing; `removed` events resolve at once). HA serves its WebSocket API
 * early while starting and keeps persistent notifications in memory only, so the
 * first listing after an HA restart can lack notifications its integrations are
 * about to recreate; resolving them at once would clear "Tekrar gösterme" records
 * and bring them back unread seconds later.
 */
export const HA_RESOLVE_GRACE_MS = 60_000;

const ACCESS_TITLE = "HA uyarıları okunamıyor";
const ACCESS_BODY = "Home Assistant erişim anahtarını reddetti; HA uyarıları gelmiyor. HA_CORE_TOKEN'ı kontrol edin.";
/** Title of an HA notification that has none. */
const DEFAULT_TITLE = "Home Assistant bildirimi";

/** An HA alert as the urgency rule sees it (T7.w.11.6 adds repairs). */
export interface HaAlertRef {
  kind: "pn";
  /** HA's notification_id. */
  id: string;
}

/**
 * The one place an HA alert's urgency is decided. Every HA alert is normal
 * until learned urgency (T7.w.11.10) replaces this.
 */
export function haAlertUrgency(alert: HaAlertRef): NotificationUrgency {
  switch (alert.kind) {
    case "pn":
      return "normal";
  }
}

/** `pn:<id>`, or `pn:sha256:<hex of id>` when that would exceed the store's key limit. */
export function pnKey(id: string): string {
  const key = PN_KEY_PREFIX + id;
  if (key.length <= MAX_KEY_CHARS) return key;
  return `${PN_KEY_PREFIX}sha256:${createHash("sha256").update(id, "utf8").digest("hex")}`;
}

/** Trimmed and cut to `max` UTF-16 units like the store, without leaving half a surrogate pair. */
export function clipText(s: string, max: number): string {
  let t = s.trim().slice(0, max);
  const last = t.charCodeAt(t.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) t = t.slice(0, -1);
  return t.trim();
}

/** What the producer needs from NotificationCenter (raise / resolve / suppressed) and the store (adoption). */
export interface HaNotificationPort {
  raise(input: RaiseInput): Promise<RaiseResult>;
  /** Rejects when the inbox cannot be read; retried later. */
  resolve(source: string, key: string): Promise<boolean>;
  /** Every item (any source); rejects when the inbox cannot be read. */
  list(): Promise<ReadonlyArray<Pick<NotificationItem, "source" | "key" | "urgency" | "title" | "body">>>;
  /** Suppressed keys (NotificationCenter.suppressed); absent = none. Rejects when unreadable. */
  suppressed?(): Promise<ReadonlyArray<{ source: string; key: string }>>;
}

export interface HaProducerOptions {
  notifications: HaNotificationPort;
  logger: Logger;
  /** Test hooks. */
  now?: () => number;
  timers?: HaTimers;
}

interface Want {
  urgency: NotificationUrgency;
  title: string;
  body: string;
}

/** What the producer believes the inbox holds for a key. */
interface Shown extends Want {
  /** "Tekrar gösterme": open, but not shown or updated until it resolves. */
  suppressed: boolean;
}

const defaultTimers: HaTimers = {
  set(fn, ms) {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The item for one HA notification entry (`mapId` = its key in the event's map). */
function alertOf(mapId: string, entry: unknown): { key: string; want: Want } {
  const e = isRecord(entry) ? entry : {};
  const id = typeof e.notification_id === "string" && e.notification_id !== "" ? e.notification_id : mapId;
  const title = typeof e.title === "string" ? clipText(e.title, MAX_TITLE_CHARS) : "";
  const body = typeof e.message === "string" ? clipText(e.message, MAX_BODY_CHARS) : "";
  return {
    key: pnKey(id),
    want: { urgency: haAlertUrgency({ kind: "pn", id }), title: title || DEFAULT_TITLE, body },
  };
}

export class HaAlertsProducer implements HaClientHandlers {
  private readonly now: () => number;
  private readonly timers: HaTimers;
  /** HA's current notifications by key; undefined until the first complete listing. */
  private alerts: Map<string, Want> | undefined;
  /** Open `pn:` items as the producer believes them (adopted, raised or suppressed). */
  private readonly shown = new Map<string, Shown>();
  /** Token state from the last connection attempt that got an answer. */
  private access: "ok" | "invalid" | undefined;
  /** `ha:access` is open (adopted, raised or suppressed). */
  private accessShown: Shown | undefined;
  private adopted = false;
  private adoptRetryAt: number | undefined;
  private loggedAdoptFailure = false;
  private suppressedAdopted = false;
  private suppressedRetryAt: number | undefined;
  private loggedSuppressedFailure = false;
  private loggedShape = false;
  private loggedInvalid = false;
  private loggedSubscribeRefused = false;
  /** Keys missing from the listing are resolved from this time on (HA_RESOLVE_GRACE_MS after a `current`). */
  private resolveAfter = 0;
  /** Keys named in `removed` events since the last `current`: resolved without the grace. */
  private readonly removed = new Set<string>();
  /** Bumped per connection: events of an older subscription are ignored. */
  private generation = 0;
  private running: Promise<void> | null = null;
  private again = false;
  private timer: unknown;
  private started = false;
  private closed = false;

  constructor(private readonly o: HaProducerOptions) {
    this.now = o.now ?? Date.now;
    this.timers = o.timers ?? defaultTimers;
  }

  /** Startup adoption (store calls wait for it). */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    void this.reconcile();
  }

  // --- HaClientHandlers ---

  onConnected(conn: HaConnection): void {
    if (this.closed) return;
    const gen = ++this.generation;
    this.access = "ok";
    void this.reconcile();
    conn.subscribe(PN_SUBSCRIBE, (event) => {
      if (gen === this.generation) this.onEvent(event);
    }).catch((err: unknown) => {
      if (err instanceof HaClosedError || this.closed) return;
      // Without the subscription nothing arrives: reconnect with backoff.
      if (!this.loggedSubscribeRefused) {
        this.loggedSubscribeRefused = true;
        this.o.logger.warn(`[shadow-core] ha producer: notification subscription refused (${(err as { code?: string })?.code ?? "error"})`);
      }
      conn.drop();
    });
  }

  onDisconnected(): void {
    // A lost connection is never an empty list: the last known set stays until the next `current`.
    this.generation++;
  }

  onAuthInvalid(): void {
    if (this.closed) return;
    this.access = "invalid";
    void this.reconcile();
  }

  /** Reconciles now; while one runs, it runs once more afterwards. Never rejects. */
  reconcile(): Promise<void> {
    if (this.closed || !this.started) return Promise.resolve();
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
          this.o.logger.warn(`[shadow-core] ha producer: round failed (${(err as Error)?.name ?? "error"})`);
          this.arm(this.now() + RETRY_MS);
        }
      } while (this.again && !this.closed);
      this.running = null;
    })();
    return this.running;
  }

  /** Resolves when no reconcile is running (test hook). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.disarm();
    await this.running;
  }

  /** One subscription event (unchecked shape). */
  private onEvent(event: unknown): void {
    if (!isRecord(event) || !isRecord(event.notifications)) return this.badShape();
    const entries = Object.entries(event.notifications);
    switch (event.type) {
      case "current": {
        const next = new Map<string, Want>();
        for (const [id, entry] of entries) {
          const a = alertOf(id, entry);
          next.set(a.key, a.want);
        }
        this.alerts = next;
        this.loggedSubscribeRefused = false;
        this.resolveAfter = this.now() + HA_RESOLVE_GRACE_MS;
        this.removed.clear();
        break;
      }
      case "added":
      case "updated":
        // Before a complete listing a partial one is not used (HA always sends `current` first).
        if (!this.alerts) return;
        for (const [id, entry] of entries) {
          const a = alertOf(id, entry);
          this.alerts.set(a.key, a.want);
        }
        break;
      case "removed":
        if (!this.alerts) return;
        for (const [id, entry] of entries) {
          for (const key of [alertOf(id, entry).key, pnKey(id)]) {
            this.alerts.delete(key);
            this.removed.add(key);
          }
        }
        break;
      default:
        return this.badShape();
    }
    void this.reconcile();
  }

  private badShape(): void {
    if (this.loggedShape) return;
    this.loggedShape = true;
    this.o.logger.warn("[shadow-core] ha producer: unexpected notification event shape; ignored");
  }

  private async round(): Promise<void> {
    if (!this.adopted) {
      if (this.adoptRetryAt !== undefined && this.now() < this.adoptRetryAt) return this.arm(this.adoptRetryAt);
      if (!(await this.adopt())) {
        this.adoptRetryAt = this.now() + RETRY_MS;
        return this.arm(this.adoptRetryAt);
      }
    }
    let next: number | undefined;
    if (!this.suppressedAdopted) {
      if (this.suppressedRetryAt === undefined || this.now() >= this.suppressedRetryAt) {
        this.suppressedRetryAt = (await this.adoptSuppressed()) ? undefined : this.now() + RETRY_MS;
      }
      next = this.suppressedRetryAt;
    }
    const counts = { raised: 0, updated: 0, resolved: 0, suppressed: 0 };
    let failed = false;
    /** A missing key waits for the end of the resolve grace. */
    let waiting = false;

    if (this.closed) return;
    // ha:access: open while the token is rejected, resolved by an authenticated connection.
    if (this.access === "invalid" && !this.accessShown) {
      const r = await this.raise(HA_ACCESS_KEY, { urgency: "normal", title: ACCESS_TITLE, body: ACCESS_BODY }, true);
      if (r === "failed") failed = true;
      else {
        this.accessShown = r;
        counts[r.suppressed ? "suppressed" : "raised"]++;
      }
    } else if (this.access === "ok" && this.accessShown) {
      if (await this.resolveKey(HA_ACCESS_KEY)) {
        this.accessShown = undefined;
        counts.resolved++;
      } else failed = true;
    }

    if (this.alerts) {
      for (const [key, want] of [...this.alerts]) {
        if (this.closed) return;
        // The set may have changed while awaiting: always act on the latest.
        if (this.alerts.get(key) !== want) continue;
        const cur = this.shown.get(key);
        if (cur && (cur.suppressed || (cur.urgency === want.urgency && cur.title === want.title && cur.body === want.body))) continue;
        const r = await this.raise(key, want, !cur);
        if (r === "failed") {
          failed = true;
          continue;
        }
        this.shown.set(key, r);
        counts[r.suppressed ? "suppressed" : cur ? "updated" : "raised"]++;
      }
      const graceOver = this.now() >= this.resolveAfter;
      for (const key of [...this.shown.keys()]) {
        if (this.closed) return;
        if (this.alerts.has(key)) continue;
        if (!graceOver && !this.removed.has(key)) {
          waiting = true;
          continue;
        }
        if (await this.resolveKey(key)) {
          this.shown.delete(key);
          counts.resolved++;
        } else failed = true;
      }
    }

    if (counts.raised + counts.updated + counts.resolved + counts.suppressed > 0) {
      this.o.logger.info(
        `[shadow-core] ha producer: ${counts.raised} raised, ${counts.updated} updated, ${counts.resolved} resolved, ${counts.suppressed} suppressed`,
      );
    }
    if (waiting) next = next === undefined ? this.resolveAfter : Math.min(next, this.resolveAfter);
    if (failed) next = next === undefined ? this.now() + RETRY_MS : Math.min(next, this.now() + RETRY_MS);
    this.arm(next);
  }

  /** Raises one item; the believed state, or "failed" (retried later). */
  private async raise(key: string, want: Want, opening: boolean): Promise<Shown | "failed"> {
    let r: RaiseResult;
    try {
      r = await this.o.notifications.raise({ source: HA_SOURCE, key, ...want, renotify: opening });
    } catch {
      return "failed";
    }
    if (r.ok) return { ...want, suppressed: false };
    if (r.reason === "suppressed") return { ...want, suppressed: true };
    if (r.reason === "invalid") {
      // A producer bug, not a passing condition: not retried until the text changes.
      if (!this.loggedInvalid) {
        this.loggedInvalid = true;
        this.o.logger.warn("[shadow-core] ha producer: raise refused (invalid)");
      }
      return { ...want, suppressed: false };
    }
    return "failed";
  }

  private async resolveKey(key: string): Promise<boolean> {
    try {
      await this.o.notifications.resolve(HA_SOURCE, key);
      return true;
    } catch {
      return false;
    }
  }

  /** Startup reconcile: the store's `pn:` and `ha:access` items count as open. False when unreadable. */
  private async adopt(): Promise<boolean> {
    let items: Awaited<ReturnType<HaNotificationPort["list"]>>;
    try {
      items = await this.o.notifications.list();
    } catch {
      if (!this.loggedAdoptFailure) {
        this.loggedAdoptFailure = true;
        this.o.logger.warn("[shadow-core] ha producer: notifications unreadable; startup reconcile retried later");
      }
      return false;
    }
    for (const item of items) {
      if (item.source !== HA_SOURCE || item.key === undefined) continue;
      const shown: Shown = { urgency: item.urgency, title: item.title, body: item.body, suppressed: false };
      if (item.key === HA_ACCESS_KEY) this.accessShown = shown;
      else if (item.key.startsWith(PN_KEY_PREFIX)) this.shown.set(item.key, shown);
    }
    this.adopted = true;
    return true;
  }

  /** Suppressed keys: open and suppressed (so a complete listing without them resolves them). */
  private async adoptSuppressed(): Promise<boolean> {
    let suppressed: Awaited<ReturnType<NonNullable<HaNotificationPort["suppressed"]>>>;
    try {
      suppressed = (await this.o.notifications.suppressed?.()) ?? [];
    } catch {
      if (!this.loggedSuppressedFailure) {
        this.loggedSuppressedFailure = true;
        this.o.logger.warn("[shadow-core] ha producer: suppression list (suppressed.json) unreadable; re-read later");
      }
      return false;
    }
    const open: Shown = { urgency: "normal", title: "", body: "", suppressed: true };
    for (const s of suppressed) {
      if (s.source !== HA_SOURCE) continue;
      if (s.key === HA_ACCESS_KEY) this.accessShown ??= open;
      else if (s.key.startsWith(PN_KEY_PREFIX) && !this.shown.has(s.key)) this.shown.set(s.key, { ...open });
    }
    this.suppressedAdopted = true;
    return true;
  }

  private arm(at: number | undefined): void {
    this.disarm();
    if (at === undefined || this.closed) return;
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      void this.reconcile();
    }, Math.max(0, at - this.now()));
  }

  private disarm(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }
}

/** HA alerts settings from the environment: the WebSocket URL and token, or why it is off. */
export function haAlertsSettings(env: NodeJS.ProcessEnv): { url: string; token: string } | { off: string } {
  const base = env.HA_URL?.trim() ?? "";
  const token = env.HA_CORE_TOKEN?.trim() ?? "";
  if (base === "" || token === "") return { off: "HA_URL or HA_CORE_TOKEN not set" };
  const url = haWebSocketUrl(base);
  if (!url) return { off: "HA_URL is not an http(s) URL" };
  return { url, token };
}

/** Producer + client, started and closed together. */
export interface HaAlerts {
  start(): void;
  close(): Promise<void>;
}

/** HA alerts for the Core (index.ts), or undefined when off (one info line, no item). */
export function createHaAlerts(o: {
  env: NodeJS.ProcessEnv;
  notifications: HaNotificationPort;
  logger: Logger;
}): HaAlerts | undefined {
  const settings = haAlertsSettings(o.env);
  if ("off" in settings) {
    o.logger.info(`[shadow-core] ha alerts: off (${settings.off})`);
    return undefined;
  }
  const producer = new HaAlertsProducer({ notifications: o.notifications, logger: o.logger });
  const client = new HaClient({ url: settings.url, token: settings.token, logger: o.logger, handlers: producer });
  o.logger.info("[shadow-core] ha alerts: on (persistent notifications over the HA WebSocket API, read-only)");
  return {
    start() {
      producer.start();
      client.start();
    },
    async close() {
      await client.close();
      await producer.close();
    },
  };
}
