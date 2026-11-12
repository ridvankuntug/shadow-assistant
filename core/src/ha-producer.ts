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
 * - Repairs (T7.w.11.6): `repairs/list_issues` on every authenticated connection
 *   (once the notification subscription is accepted) and HA_REPAIRS_POLL_MS (10 min) after each answer while connected.
 *   Answer `{issues: [{domain, issue_id, severity, is_fixable, ignored,
 *   dismissed_version, translation_key, translation_placeholders,
 *   breaks_in_ha_version, learn_more_url, issue_domain, created}]}` (active
 *   issues only). Key `repair:<domain>:<issue_id>` (hashed like `pn:` when too
 *   long). Ignored issues (`ignored: true`; without that field, a set
 *   `dismissed_version`, which is what HA derives `ignored` from) are skipped, so
 *   ignoring one in HA resolves its item. The answer has no human text: the
 *   title/body are built in Turkish from domain, translation_key (issue_id when
 *   none), severity, is_fixable and breaks_in_ha_version; placeholder values and
 *   learn_more_url are never copied (they can hold names / addresses).
 * - Repairs resolve: a key missing from a **successful, complete** list is
 *   resolved, but only by a list started HA_RESOLVE_GRACE_MS or more after the
 *   connection's auth (HA restores non-persistent issues as inactive at start
 *   until their integration recreates them; the list at connect raises, the
 *   10-min lists resolve). A failed call or a malformed answer (or entry) never
 *   resolves, and a lost connection is never taken as an empty list (only keys
 *   missing from the last successful complete list are resolved).
 * - `ha:access` (one normal item, "HA uyarıları okunamıyor") has two causes:
 *   `auth_invalid` (token rejected) and an `unauthorized` answer to
 *   `repairs/list_issues` (not an admin token). It is open while either holds and
 *   resolved only when both are known good: an authenticated connection **and**
 *   a list_issues answer on it that is not `unauthorized` (HA checks admin before
 *   anything else, so any other answer means the permission is there).
 * - Urgency: `haAlertUrgency` (one function; normal for now, learned urgency is
 *   T7.w.11.10).
 *
 * Startup reconcile (docs/09 common rules): existing `ha` items with a `pn:` or
 * `repair:` key and `ha:access` are adopted as open, and keys the user suppressed ("Tekrar
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
import { HaClient, HaClosedError, HaCommandError, haWebSocketUrl, type HaClientHandlers, type HaConnection, type HaTimers } from "./ha-client.js";
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
export const REPAIR_KEY_PREFIX = "repair:";
const PN_SUBSCRIBE = "persistent_notification/subscribe";
const REPAIRS_LIST = "repairs/list_issues";
/** Repairs are polled this long after each list answer while connected. */
export const HA_REPAIRS_POLL_MS = 10 * 60_000;
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
const ACCESS_REPAIRS_BODY =
  "Home Assistant onarım listesini okuma izni vermedi (yönetici kullanıcı gerekiyor); HA onarım uyarıları gelmiyor. HA_CORE_TOKEN'ın kullanıcısını kontrol edin.";
/** Title of an HA notification that has none. */
const DEFAULT_TITLE = "Home Assistant bildirimi";
/** HA repair severities in Turkish (an unknown one is left out of the body). */
const REPAIR_SEVERITY = new Map([
  ["critical", "kritik"],
  ["error", "hata"],
  ["warning", "uyarı"],
]);

/** An HA alert as the urgency rule sees it. */
export type HaAlertRef =
  | {
      kind: "pn";
      /** HA's notification_id. */
      id: string;
    }
  | {
      kind: "repair";
      domain: string;
      issueId: string;
      translationKey?: string;
      /** HA's severity as sent (critical / error / warning). */
      severity?: string;
    };

/**
 * The one place an HA alert's urgency is decided. Every HA alert is normal
 * until learned urgency (T7.w.11.10) replaces this.
 */
export function haAlertUrgency(alert: HaAlertRef): NotificationUrgency {
  switch (alert.kind) {
    case "pn":
    case "repair":
      return "normal";
  }
}

/** `pn:<id>`, or `pn:sha256:<hex of id>` when that would exceed the store's key limit. */
export function pnKey(id: string): string {
  const key = PN_KEY_PREFIX + id;
  if (key.length <= MAX_KEY_CHARS) return key;
  return `${PN_KEY_PREFIX}sha256:${createHash("sha256").update(id, "utf8").digest("hex")}`;
}

/**
 * `repair:<domain>:<issue_id>`, or `repair:sha256:<hex of "<domain>:<issue_id>">`
 * when that would exceed the store's key limit (HA domains never hold `:`).
 */
export function repairKey(domain: string, issueId: string): string {
  const id = `${domain}:${issueId}`;
  const key = REPAIR_KEY_PREFIX + id;
  if (key.length <= MAX_KEY_CHARS) return key;
  return `${REPAIR_KEY_PREFIX}sha256:${createHash("sha256").update(id, "utf8").digest("hex")}`;
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

/** Same urgency, title and body (an unchanged item writes nothing). */
const sameWant = (a: Want, b: Want): boolean => a.urgency === b.urgency && a.title === b.title && a.body === b.body;

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

const nonEmpty = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

/**
 * The item for one `repairs/list_issues` entry; "ignored" for an issue the user
 * ignored in HA; undefined for a malformed entry (no domain / issue_id). The text
 * is built only from HA's codes: placeholder values and learn_more_url are not copied.
 */
export function repairOf(entry: unknown): { key: string; want: Want } | "ignored" | undefined {
  if (!isRecord(entry)) return undefined;
  const domain = nonEmpty(entry.domain);
  const issueId = nonEmpty(entry.issue_id);
  if (domain === undefined || issueId === undefined) return undefined;
  // HA sends `ignored = dismissed_version is not None`; the field is used when present.
  const ignored = typeof entry.ignored === "boolean" ? entry.ignored : entry.dismissed_version !== undefined && entry.dismissed_version !== null;
  if (ignored) return "ignored";
  const translationKey = nonEmpty(entry.translation_key);
  const severity = typeof entry.severity === "string" ? entry.severity : undefined;
  const severityTr = severity === undefined ? undefined : REPAIR_SEVERITY.get(severity);
  const breaks = nonEmpty(entry.breaks_in_ha_version);
  const lines = [`Sorun: ${clipText(translationKey ?? issueId, 200)}`];
  if (severityTr) lines.push(`Önem: ${severityTr}`);
  if (breaks && /^[0-9][0-9A-Za-z.]{0,19}$/.test(breaks)) lines.push(`Home Assistant ${breaks} sürümünde çalışmayı bırakacak.`);
  if (entry.is_fixable === true) lines.push("Home Assistant'ta onarma adımı var.");
  lines.push("Ayrıntılar: Home Assistant > Ayarlar > Onarımlar.");
  return {
    key: repairKey(domain, issueId),
    want: {
      urgency: haAlertUrgency({ kind: "repair", domain, issueId, translationKey, severity }),
      title: clipText(`Home Assistant onarımı: ${nonEmpty(entry.issue_domain) ?? domain}`, MAX_TITLE_CHARS),
      body: clipText(lines.join("\n"), MAX_BODY_CHARS),
    },
  };
}

export class HaAlertsProducer implements HaClientHandlers {
  private readonly now: () => number;
  private readonly timers: HaTimers;
  /** HA's current notifications by key; undefined until the first complete listing. */
  private alerts: Map<string, Want> | undefined;
  /** Open `pn:` items as the producer believes them (adopted, raised or suppressed). */
  private readonly shown = new Map<string, Shown>();
  /** HA's active, not ignored repair issues by key, from the last good list; undefined until one. */
  private repairs: Map<string, Want> | undefined;
  /** Open `repair:` items as the producer believes them (adopted, raised or suppressed). */
  private readonly shownRepairs = new Map<string, Shown>();
  /** The last list may resolve missing keys (successful, complete, started after the connection's grace). */
  private repairsMayResolve = false;
  /** Repairs permission on this connection: "denied" = `unauthorized`, "ok" = any other answer; undefined = no answer yet. */
  private repairsAccess: "ok" | "denied" | undefined;
  /** When the current connection authenticated. */
  private connectedAt = 0;
  private repairsTimer: unknown;
  private loggedRepairsDenied = false;
  private loggedRepairsFailed = false;
  private loggedRepairsShape = false;
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
    this.connectedAt = this.now();
    // Until list_issues answers on this connection the repairs permission is unknown (ha:access stays as it is).
    this.repairsAccess = undefined;
    this.repairsMayResolve = false;
    void this.reconcile();
    conn.subscribe(PN_SUBSCRIBE, (event) => {
      if (gen === this.generation) this.onEvent(event);
    }).then(
      // Repairs only after the subscription is in place: a refused subscription drops the
      // connection, and a successful list answer would reset the client's backoff meanwhile.
      () => {
        if (gen === this.generation && !this.closed) void this.listRepairs(conn, gen);
      },
      (err: unknown) => {
        if (err instanceof HaClosedError || this.closed) return;
        // Without the subscription nothing arrives: reconnect with backoff.
        if (!this.loggedSubscribeRefused) {
          this.loggedSubscribeRefused = true;
          this.o.logger.warn(`[shadow-core] ha producer: notification subscription refused (${(err as { code?: string })?.code ?? "error"})`);
        }
        conn.drop();
      },
    );
  }

  onDisconnected(): void {
    // A lost connection is never an empty list: the last known set stays until the next `current` / list.
    this.generation++;
    this.stopRepairsTimer();
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
    this.stopRepairsTimer();
    await this.running;
  }

  /** One `repairs/list_issues` call on connection `gen`; the next one HA_REPAIRS_POLL_MS after its answer. */
  private async listRepairs(conn: HaConnection, gen: number): Promise<void> {
    const startedAt = this.now();
    let result: unknown;
    try {
      result = await conn.command(REPAIRS_LIST);
    } catch (err) {
      // A lost connection says nothing: the next connection lists again.
      if (err instanceof HaClosedError || this.closed || gen !== this.generation) return;
      const code = err instanceof HaCommandError ? err.code : "error";
      this.repairsMayResolve = false;
      if (code === "unauthorized") {
        this.repairsAccess = "denied";
        if (!this.loggedRepairsDenied) {
          this.loggedRepairsDenied = true;
          this.o.logger.warn("[shadow-core] ha producer: repairs list refused (unauthorized; the token's user is not an admin)");
        }
      } else {
        // HA checks admin before anything else: any other error is not a permission problem.
        this.repairsAccess = "ok";
        if (!this.loggedRepairsFailed) {
          this.loggedRepairsFailed = true;
          this.o.logger.warn(`[shadow-core] ha producer: repairs list failed (${code}); retried in 10 min`);
        }
      }
      this.scheduleRepairs(conn, gen);
      void this.reconcile();
      return;
    }
    if (this.closed || gen !== this.generation) return;
    this.repairsAccess = "ok";
    this.loggedRepairsDenied = false;
    this.loggedRepairsFailed = false;
    const issues = isRecord(result) ? result.issues : undefined;
    if (!Array.isArray(issues)) {
      // Not a complete listing: the last known set stays, nothing is resolved.
      this.repairsMayResolve = false;
      this.badRepairsShape();
    } else {
      const next = new Map<string, Want>();
      let complete = true;
      for (const entry of issues) {
        const r = repairOf(entry);
        if (r === undefined) complete = false;
        else if (r !== "ignored") next.set(r.key, r.want);
      }
      if (!complete) this.badRepairsShape();
      this.repairs = next;
      this.repairsMayResolve = complete && startedAt >= this.connectedAt + HA_RESOLVE_GRACE_MS;
    }
    this.scheduleRepairs(conn, gen);
    void this.reconcile();
  }

  private scheduleRepairs(conn: HaConnection, gen: number): void {
    if (this.closed || gen !== this.generation) return;
    this.stopRepairsTimer();
    this.repairsTimer = this.timers.set(() => {
      this.repairsTimer = undefined;
      void this.listRepairs(conn, gen);
    }, HA_REPAIRS_POLL_MS);
  }

  private stopRepairsTimer(): void {
    if (this.repairsTimer !== undefined) this.timers.clear(this.repairsTimer);
    this.repairsTimer = undefined;
  }

  private badRepairsShape(): void {
    if (this.loggedRepairsShape) return;
    this.loggedRepairsShape = true;
    this.o.logger.warn("[shadow-core] ha producer: unexpected repairs list shape; not used to resolve");
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
    // ha:access: open while the token is rejected or repairs are refused; resolved only when both are known good.
    const accessWant = this.accessWant();
    const accessCur = this.accessShown;
    if (accessWant) {
      if (!accessCur || (!accessCur.suppressed && !sameWant(accessCur, accessWant))) {
        const r = await this.raise(HA_ACCESS_KEY, accessWant, !accessCur);
        if (r === "failed") failed = true;
        else {
          this.accessShown = r;
          counts[r.suppressed ? "suppressed" : accessCur ? "updated" : "raised"]++;
        }
      }
    } else if (this.access === "ok" && this.repairsAccess === "ok" && accessCur) {
      if (await this.resolveKey(HA_ACCESS_KEY)) {
        this.accessShown = undefined;
        counts.resolved++;
      } else failed = true;
    }

    if (this.alerts) {
      if (await this.raiseListing(() => this.alerts, this.shown, counts)) failed = true;
      if (this.closed) return;
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

    if (this.repairs) {
      if (await this.raiseListing(() => this.repairs, this.shownRepairs, counts)) failed = true;
      for (const key of [...this.shownRepairs.keys()]) {
        if (this.closed) return;
        // Checked per key: a newer list may have arrived while awaiting.
        if (!this.repairsMayResolve || this.repairs.has(key)) continue;
        if (await this.resolveKey(key)) {
          this.shownRepairs.delete(key);
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

  /**
   * Raises the new and changed entries of a listing (`listing()` is read again
   * after each await: the set may be replaced meanwhile, the latest one wins).
   * True when a raise failed (retried later).
   */
  private async raiseListing(
    listing: () => Map<string, Want> | undefined,
    shown: Map<string, Shown>,
    counts: { raised: number; updated: number; suppressed: number },
  ): Promise<boolean> {
    let failed = false;
    for (const [key, want] of [...(listing() ?? [])]) {
      if (this.closed) return failed;
      if (listing()?.get(key) !== want) continue;
      const cur = shown.get(key);
      if (cur && (cur.suppressed || sameWant(cur, want))) continue;
      const r = await this.raise(key, want, !cur);
      if (r === "failed") {
        failed = true;
        continue;
      }
      shown.set(key, r);
      counts[r.suppressed ? "suppressed" : cur ? "updated" : "raised"]++;
    }
    return failed;
  }

  /** What `ha:access` should show, or undefined when no cause holds. */
  private accessWant(): Want | undefined {
    if (this.access === "invalid") return { urgency: "normal", title: ACCESS_TITLE, body: ACCESS_BODY };
    if (this.repairsAccess === "denied") return { urgency: "normal", title: ACCESS_TITLE, body: ACCESS_REPAIRS_BODY };
    return undefined;
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

  /** Startup reconcile: the store's `pn:`, `repair:` and `ha:access` items count as open. False when unreadable. */
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
      else if (item.key.startsWith(REPAIR_KEY_PREFIX)) this.shownRepairs.set(item.key, shown);
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
      else if (s.key.startsWith(REPAIR_KEY_PREFIX) && !this.shownRepairs.has(s.key)) this.shownRepairs.set(s.key, { ...open });
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
  o.logger.info("[shadow-core] ha alerts: on (persistent notifications and repairs over the HA WebSocket API, read-only)");
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
