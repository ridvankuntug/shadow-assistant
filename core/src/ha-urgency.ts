/**
 * Learned urgency of HA alerts (T7.w.11.10, docs/09 *Learned urgency of HA alerts*).
 *
 * - **Alert type key** (not the item key): a persistent notification is
 *   `pn:<notification_id>` with a variable suffix stripped (`stripVariableSuffix`);
 *   a repair is `repair:<domain>:<translation_key>`, `issue_id` when there is no
 *   translation key. Never title or body text. Too long → `pn:sha256:<hex>` /
 *   `repair:sha256:<hex>` like the item keys.
 * - **Start:** HA's failed-login notifications are urgent (INITIAL_URGENT_TYPES);
 *   every other type is normal.
 * - **Feedback** ("Bu acildi" / "Acil değildi", only the explicit buttons): per
 *   type a direction and a counter. Same direction +1; the opposite direction
 *   resets the counter to 1 in the new direction. One signal per inbox item (a
 *   second tap on the same item in the same direction is not counted again).
 * - **Suggestion:** at HA_URGENCY_THRESHOLD (3) signals in a direction that
 *   differs from the type's current level, the Development tab lists it.
 *   "Kabul" (`accept`) sets the approved level to that direction and clears the
 *   counter; "Yok say" (`dismiss`) keeps the level and clears the counter.
 *   Shadow never changes a level by itself.
 * - **Record:** `<SHADOW_DATA_DIR>/notifications/ha-urgency.json`
 *
 *     { "version": 1, "items": [ { type, direction?, count, firstAt?, lastAt?, level? } ] }
 *
 *   type key, counter direction and count (+ when the run started / was last
 *   counted, for the Development tab), approved level. No title, body, item id
 *   or secret. A record with no counter and no approved level is dropped.
 *
 * Failure policy (never blocks a producer):
 * - Missing file: empty (every type at its start level).
 * - Corrupt file: quarantined (`.corrupt-<ts>` copy kept, one warning) and empty.
 * - Unreadable file (locked, permissions) or a corrupt one that could not be
 *   moved aside: one warning per spell; `level()` answers the start level,
 *   `suggestions()` none, and feedback / accept / dismiss answer `unavailable`
 *   (nothing is written over that file). Every later call reads it again.
 * - Writes are atomic and immediate (the actions are rare); a failed write keeps
 *   the in-memory state and is retried by the next change or `flush()`.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readJsonOrQuarantine, writeFileAtomic, type AtomicFs } from "./atomic-file.js";
import { MAX_KEY_CHARS, type NotificationUrgency } from "./notifications.js";

export const HA_URGENCY_FILE = "ha-urgency.json";
/** Same-direction signals before the Development tab suggests a change (docs/08 `min_observations`). */
export const HA_URGENCY_THRESHOLD = 3;
/** Hard limit on records; at the limit a new type is not recorded (logged). */
export const MAX_HA_URGENCY_TYPES = 500;
/** The counter stops here (the suggestion is shown from HA_URGENCY_THRESHOLD on anyway). */
const MAX_COUNT = 999;
/** Item key → type key entries kept in memory (oldest dropped). */
const MAX_ITEM_TYPES = 2000;
/** Items that already gave a signal (one per item), in memory only (oldest dropped). */
const MAX_FED_BACK = 2000;

/**
 * HA's failed-login persistent notifications (homeassistant/components/http/ban.py:
 * NOTIFICATION_ID_LOGIN = "http-login", NOTIFICATION_ID_BAN = "ip-ban"). To be
 * confirmed against a real HA.
 */
export const INITIAL_URGENT_TYPES: readonly string[] = ["pn:http-login", "pn:ip-ban"];

export type UrgencyDirection = NotificationUrgency;

const PN = "pn:";
const REPAIR = "repair:";
/** A notification without its own id (HA generates a random hex id). */
const PN_ANONYMOUS = "*";

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * The variable tail of a notification id: `-<digits>`, `_<digits>`, or a UUID /
 * hex tail of 8 or more characters after `-` / `_`. Stripped once. A whole id
 * that is digits or hex (8+) only (HA's own random id when none is given) is
 * the anonymous type `*`.
 */
export function stripVariableSuffix(id: string): string {
  if (/^(?:[0-9]+|[0-9a-f]{8,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(id)) return PN_ANONYMOUS;
  const stripped = id.replace(/[-_](?:[0-9]+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8,})$/i, "");
  return stripped === "" ? PN_ANONYMOUS : stripped;
}

const capped = (prefix: string, rest: string) => {
  const key = prefix + rest;
  return key.length <= MAX_KEY_CHARS ? key : `${prefix}sha256:${sha256(rest)}`;
};

/** Type key of a persistent notification. */
export function pnTypeKey(notificationId: string): string {
  return capped(PN, stripVariableSuffix(notificationId));
}

/** Type key of a repair issue: `repair:<domain>:<translation_key>`, `issue_id` without one. */
export function repairTypeKey(domain: string, translationKey: string | undefined, issueId: string): string {
  return capped(REPAIR, `${domain}:${translationKey ?? issueId}`);
}

const isTypeKey = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_KEY_CHARS && (v.startsWith(PN) || v.startsWith(REPAIR)) && v.length > 3;

const isLevel = (v: unknown): v is NotificationUrgency => v === "urgent" || v === "normal";

interface UrgencyRecord {
  type: string;
  /** Direction of the current counter run; absent = no counter. */
  direction?: UrgencyDirection;
  count: number;
  /** ISO 8601: first and last signal of the current run. */
  firstAt?: string;
  lastAt?: string;
  /** Approved level ("Kabul"); absent = the start level. */
  level?: NotificationUrgency;
}

interface UrgencyFile {
  version: 1;
  items: UrgencyRecord[];
}

/** A type the Development tab suggests changing. */
export interface UrgencySuggestion {
  type: string;
  /** The level "Kabul" would set. */
  direction: UrgencyDirection;
  count: number;
  firstAt: string;
  lastAt: string;
}

export type FeedbackResult =
  | { ok: true; counted: boolean; count: number; suggestion: boolean }
  | { ok: false; reason: "invalid" | "full" | "unavailable" };

export interface HaUrgencyStoreOptions {
  /** `<SHADOW_DATA_DIR>/notifications`. */
  dir: string;
  now?: () => number;
  log?: (msg: string) => void;
  /** Default INITIAL_URGENT_TYPES. */
  initialUrgent?: readonly string[];
  /** Default HA_URGENCY_THRESHOLD. */
  threshold?: number;
  /** Default MAX_HA_URGENCY_TYPES. */
  maxTypes?: number;
  /** Called after a change that may change the suggestions (Development badge recount). */
  onChange?: () => void;
  fs?: AtomicFs;
  retryDelaysMs?: readonly number[];
}

export class HaUrgencyStore {
  readonly file: string;
  private readonly now: () => number;
  private readonly initialUrgent: ReadonlySet<string>;
  private readonly threshold: number;
  private readonly maxTypes: number;
  private loaded: Map<string, UrgencyRecord> | undefined;
  private pending = false;
  private unreadable = false;
  private chain: Promise<unknown> = Promise.resolve();
  /** Item key (`pn:<id>` / `repair:<domain>:<issue_id>`) → type key, as the producer last saw it. */
  private readonly itemTypes = new Map<string, string>();
  /** Inbox item id → the direction it already counted. */
  private readonly fedBack = new Map<string, UrgencyDirection>();

  constructor(private readonly o: HaUrgencyStoreOptions) {
    this.file = join(o.dir, HA_URGENCY_FILE);
    this.now = o.now ?? Date.now;
    this.initialUrgent = new Set(o.initialUrgent ?? INITIAL_URGENT_TYPES);
    this.threshold = Math.max(1, o.threshold ?? HA_URGENCY_THRESHOLD);
    this.maxTypes = o.maxTypes ?? MAX_HA_URGENCY_TYPES;
  }

  /** The producer saw item `itemKey` of type `type` (in memory only; feedback maps the item back to its type). */
  noteItem(itemKey: string, type: string): void {
    this.itemTypes.delete(itemKey);
    this.itemTypes.set(itemKey, type);
    if (this.itemTypes.size > MAX_ITEM_TYPES) this.itemTypes.delete(this.itemTypes.keys().next().value as string);
  }

  /**
   * The type of an `ha` item key: as the producer last saw it, else derived from
   * an unhashed `pn:<id>` key. Undefined for a repair the producer has not
   * listed since the Core started (its translation key is not in the item key),
   * a hashed key, or a key that is no alert (`ha:access`).
   */
  typeOfItem(itemKey: string): string | undefined {
    const seen = this.itemTypes.get(itemKey);
    if (seen !== undefined) return seen;
    if (itemKey.startsWith(PN) && !itemKey.startsWith(`${PN}sha256:`) && itemKey.length > PN.length) {
      return pnTypeKey(itemKey.slice(PN.length));
    }
    return undefined;
  }

  /** The level a raise of `type` gets now: the approved one, else the start level. Never rejects. */
  level(type: string): Promise<NotificationUrgency> {
    return this.change(this.startLevel(type), (map) => ({ result: this.levelIn(map, type) }));
  }

  /**
   * One explicit signal on inbox item `itemId` of type `type`. A second signal
   * of the same item in the same direction is not counted (`counted: false`).
   */
  feedback(type: string, direction: UrgencyDirection, itemId: string): Promise<FeedbackResult> {
    if (!isTypeKey(type) || !isLevel(direction)) return Promise.resolve({ ok: false, reason: "invalid" });
    const unavailable: FeedbackResult = { ok: false, reason: "unavailable" };
    return this.change<FeedbackResult>(unavailable, (map) => {
      const cur = map.get(type);
      // One signal per item and direction, whatever the counter did since (reset by another item, Kabul, Yok say).
      if (this.fedBack.get(itemId) === direction) {
        return { result: { ok: true, counted: false, count: cur?.count ?? 0, suggestion: cur ? this.suggests(map, cur) : false } };
      }
      if (!cur && map.size >= this.maxTypes) {
        this.o.log?.(`[shadow-core] ha urgency: limit of ${this.maxTypes} types reached; feedback not recorded`);
        return { result: { ok: false, reason: "full" } };
      }
      const stamp = new Date(this.now()).toISOString();
      const next: UrgencyRecord =
        cur?.direction === direction
          ? { ...cur, count: Math.min(MAX_COUNT, cur.count + 1), lastAt: stamp }
          : { type, direction, count: 1, firstAt: stamp, lastAt: stamp, ...(cur?.level ? { level: cur.level } : {}) };
      map.set(type, next);
      this.fedBack.delete(itemId);
      this.fedBack.set(itemId, direction);
      if (this.fedBack.size > MAX_FED_BACK) this.fedBack.delete(this.fedBack.keys().next().value as string);
      return { result: { ok: true, counted: true, count: next.count, suggestion: this.suggests(map, next) }, changed: true };
    });
  }

  /** The current suggestions, oldest run first. Unreadable file: none. Never rejects. */
  suggestions(): Promise<UrgencySuggestion[]> {
    return this.change<UrgencySuggestion[]>([], (map) => ({
      result: [...map.values()]
        .filter((r) => this.suggests(map, r))
        .map((r) => ({ type: r.type, direction: r.direction as UrgencyDirection, count: r.count, firstAt: r.firstAt ?? "", lastAt: r.lastAt ?? "" }))
        .sort((a, b) => Date.parse(a.firstAt) - Date.parse(b.firstAt) || (a.type < b.type ? -1 : 1)),
    }));
  }

  /**
   * "Kabul": `type` gets the suggested level `direction`; the counter is cleared.
   * "unknown" when no such suggestion is listed now (a newer signal changed it).
   */
  accept(type: string, direction: UrgencyDirection): Promise<"ok" | "unknown" | "unavailable"> {
    return this.decide(type, direction, true);
  }

  /** "Yok say": the level stays, the counter is cleared. */
  dismiss(type: string, direction: UrgencyDirection): Promise<"ok" | "unknown" | "unavailable"> {
    return this.decide(type, direction, false);
  }

  /** Writes a failed change again (shutdown). Never rejects. */
  flush(): Promise<void> {
    return this.change(undefined, () => ({ result: undefined }));
  }

  private decide(type: string, direction: UrgencyDirection, accept: boolean): Promise<"ok" | "unknown" | "unavailable"> {
    return this.change<"ok" | "unknown" | "unavailable">("unavailable", (map) => {
      const cur = map.get(type);
      if (!cur || cur.direction !== direction || !this.suggests(map, cur)) return { result: "unknown" };
      const level = accept ? direction : cur.level;
      if (level === undefined) map.delete(type);
      else map.set(type, { type, count: 0, level });
      this.o.log?.(`[shadow-core] ha urgency: a type was ${accept ? `set to ${direction}` : "kept (suggestion dismissed)"}`);
      return { result: "ok", changed: true };
    });
  }

  private startLevel(type: string): NotificationUrgency {
    return this.initialUrgent.has(type) ? "urgent" : "normal";
  }

  private levelIn(map: ReadonlyMap<string, UrgencyRecord>, type: string): NotificationUrgency {
    return map.get(type)?.level ?? this.startLevel(type);
  }

  private suggests(map: ReadonlyMap<string, UrgencyRecord>, r: UrgencyRecord): boolean {
    return r.direction !== undefined && r.count >= this.threshold && r.direction !== this.levelIn(map, r.type);
  }

  /**
   * Runs `fn` on the loaded records under the chain; a change is written at once.
   * While the file cannot be read, answers `fallback` without calling `fn`. Never rejects.
   */
  private change<T>(fallback: T, fn: (map: Map<string, UrgencyRecord>) => { result: T; changed?: boolean }): Promise<T> {
    const run = this.chain.then(async () => {
      const map = await this.load();
      if (!map) return fallback;
      const { result, changed } = fn(map);
      if (changed) this.pending = true;
      if (this.pending) await this.write(map);
      if (changed) safeCall(this.o.onChange);
      return result;
    });
    this.chain = run.catch(() => {});
    return run.catch((err: unknown) => {
      this.o.log?.(`[shadow-core] ha urgency failed: ${errName(err)}`);
      return fallback;
    });
  }

  private async load(): Promise<Map<string, UrgencyRecord> | undefined> {
    if (this.loaded) return this.loaded;
    let leftInPlace = false;
    let data: UrgencyFile | undefined;
    try {
      data = await readJsonOrQuarantine(this.file, validateFile, {
        fs: this.o.fs,
        retryDelaysMs: this.o.retryDelaysMs,
        now: this.now,
        onQuarantine: (info) => {
          if (info.movedTo) this.o.log?.("[shadow-core] ha urgency file was invalid and was moved aside; starting empty");
          else leftInPlace = true;
        },
      });
    } catch (err) {
      return this.cannotRead(errName(err));
    }
    if (leftInPlace) return this.cannotRead("invalid file could not be moved aside");
    if (this.unreadable) {
      this.unreadable = false;
      this.o.log?.("[shadow-core] ha urgency file can be read again");
    }
    const map = new Map<string, UrgencyRecord>();
    for (const r of data?.items ?? []) map.set(r.type, r);
    this.loaded = map;
    return map;
  }

  private cannotRead(why: string): undefined {
    if (!this.unreadable) {
      this.unreadable = true;
      this.o.log?.(`[shadow-core] ha urgency file could not be read (${why}); start levels used, feedback refused for now`);
    }
    return undefined;
  }

  private async write(map: Map<string, UrgencyRecord>): Promise<void> {
    const file: UrgencyFile = { version: 1, items: [...map.values()].filter((r) => r.count > 0 || r.level !== undefined) };
    try {
      await writeFileAtomic(this.file, `${JSON.stringify(file, null, 2)}\n`, { fs: this.o.fs, retryDelaysMs: this.o.retryDelaysMs });
      this.pending = false;
    } catch (err) {
      this.pending = true;
      this.o.log?.(`[shadow-core] ha urgency write failed: ${errName(err)}`);
    }
  }
}

function safeCall(fn: (() => void) | undefined): void {
  try {
    fn?.();
  } catch {
    // a listener must not break the store
  }
}

/** Error code or name only: an fs message holds the path. */
function errName(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
    if (err instanceof Error) return err.name;
  }
  return "error";
}

const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));

/** The whole file or nothing: one malformed record quarantines it. Duplicates: the first is kept. */
function validateFile(v: unknown): UrgencyFile | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (o.version !== 1 || !Array.isArray(o.items)) return undefined;
  const items: UrgencyRecord[] = [];
  const seen = new Set<string>();
  for (const raw of o.items as unknown[]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const r = raw as Record<string, unknown>;
    if (!isTypeKey(r.type)) return undefined;
    if (typeof r.count !== "number" || !Number.isInteger(r.count) || r.count < 0 || r.count > MAX_COUNT) return undefined;
    if (r.level !== undefined && !isLevel(r.level)) return undefined;
    const counting = r.count > 0;
    if (counting && (!isLevel(r.direction) || !isIso(r.firstAt) || !isIso(r.lastAt))) return undefined;
    if (seen.has(r.type)) continue;
    seen.add(r.type);
    items.push({
      type: r.type,
      count: r.count,
      ...(counting ? { direction: r.direction as UrgencyDirection, firstAt: r.firstAt as string, lastAt: r.lastAt as string } : {}),
      ...(r.level !== undefined ? { level: r.level as NotificationUrgency } : {}),
    });
  }
  return { version: 1, items };
}

/** What NotificationCenter needs for the `urgent_yes` / `urgent_no` actions. */
export interface UrgencyFeedbackPort {
  feedback(
    item: { id: string; source: string; key?: string },
    direction: UrgencyDirection,
  ): Promise<{ ok: true } | { ok: false; code: "bad_request" | "not_allowed" | "internal"; message: string }>;
}

/** The HA feedback port over the store: only `ha` alert items (`pn:` / `repair:` keys) are accepted. */
export function haUrgencyFeedback(store: Pick<HaUrgencyStore, "typeOfItem" | "feedback">, haSource = "ha"): UrgencyFeedbackPort {
  return {
    async feedback(item, direction) {
      if (item.source !== haSource || item.key === undefined || !(item.key.startsWith(PN) || item.key.startsWith(REPAIR))) {
        return { ok: false, code: "bad_request", message: "urgency feedback is only for Home Assistant alerts" };
      }
      const type = store.typeOfItem(item.key);
      if (type === undefined) {
        return { ok: false, code: "not_allowed", message: "the alert type is not known yet (Home Assistant not listed since the Core started)" };
      }
      const r = await store.feedback(type, direction, item.id);
      if (r.ok) return { ok: true };
      return { ok: false, code: "internal", message: r.reason === "full" ? "too many alert types recorded" : "urgency feedback could not be stored" };
    },
  };
}
