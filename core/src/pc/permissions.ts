/**
 * The PC permission list (docs/11-pc-control.md D3, vault plan T17.2): one row
 * per action + target, each with a switch the user alone flips. Nothing here
 * runs an action; the coordinator that does (T17.4) only gets the narrow
 * `PcPermissionView`.
 *
 * - **Row identity:** (action, target kind, canonical target id), never the
 *   spoken text. `rowId` = `p-` + the first 16 hex digits of
 *   `sha256(action|kind|id)`, so a repeated refusal finds its row.
 * - **Store:** `<SHADOW_DATA_DIR>/pc/permissions.json`, read once at startup
 *   (`load()`), kept in memory, written through (`writeFileAtomic`). Every
 *   read-modify-write runs on one in-process chain; memory changes only after
 *   the write succeeded.
 * - **Fail closed:** a corrupt file is quarantined (`.corrupt-<ts>`) and an
 *   unreadable one left in place; either way the store is **unavailable** until
 *   the Core restarts: nothing is written (an auto-added row must not replace
 *   the grants still in the quarantined copy), `lookup()` answers
 *   `unavailable`, the page shows `available: false`. It stays unavailable
 *   after a restart while the file is missing and a `.corrupt-<ts>` copy is
 *   next to it: recovery is restoring the file by hand (or deleting the copies
 *   to start empty on purpose), then a restart.
 * - **Who may switch:** `setEnabled()` is the only code that changes `enabled`
 *   and it checks the device itself (CORE_PC_PERMISSION_DEVICES; empty =
 *   nobody). Its only caller is the WebSocket handler of `pc_permission_set`
 *   (session.ts); `pcPermissionView()` hands out `lookup` + `recordRefusal`
 *   only, and `recordRefusal()` only ever creates a row **off**.
 * - At most MAX_PC_PERMISSION_ROWS rows; at the limit no row is added.
 *
 * The file holds action, target kind / id / label, the spoken aliases that
 * resolved to the target, the switch and counters. No device token, no
 * sentence; the device name of the last switch (`changedBy`) is a config name.
 */
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { domainToASCII } from "node:url";
import { readJsonOrQuarantine, writeFileAtomic, type AtomicFs } from "../atomic-file.js";
import type { PcPermissionInfo } from "../protocol.js";

export const PC_DIR = "pc";
export const PC_PERMISSIONS_FILE = "permissions.json";
/** Hard limit on rows (docs/11 D3 "Store"). */
export const MAX_PC_PERMISSION_ROWS = 300;
/** Spoken aliases kept per row, newest last. */
export const MAX_PC_ALIASES = 10;
const MAX_ALIAS_CHARS = 128;
const MAX_LABEL_CHARS = 200;
const MAX_TARGET_ID_CHARS = 512;
/** DNS limit for a host name. */
const MAX_HOST_CHARS = 253;

/** The actions of the v1 catalogue (docs/11 D2), one tool each. */
export const PC_ACTIONS = [
  "open_app",
  "close_app",
  "force_close_app",
  "open_site",
  "web_search",
  "media_search",
  "volume",
  "media",
  "lock",
  "sleep",
  "shutdown",
  "restart",
  "play_game",
] as const;
export type PcAction = (typeof PC_ACTIONS)[number];

export const PC_TARGET_KINDS = ["app", "steam", "epic", "battlenet", "site", "search", "system"] as const;
export type PcTargetKind = (typeof PC_TARGET_KINDS)[number];

/** Actions that ask every time, even with the switch on (decision 5, Q1). */
export const RISKY_PC_ACTIONS: ReadonlySet<PcAction> = new Set<PcAction>(["force_close_app", "sleep", "shutdown", "restart"]);

/** Which target kinds (and, for fixed targets, which ids) each action may have. */
const ACTION_TARGETS: Record<PcAction, { kinds: readonly PcTargetKind[]; ids?: readonly string[] }> = {
  open_app: { kinds: ["app"] },
  close_app: { kinds: ["app"] },
  force_close_app: { kinds: ["app"] },
  open_site: { kinds: ["site"] },
  web_search: { kinds: ["search"], ids: ["web"] },
  media_search: { kinds: ["search"], ids: ["youtube", "youtube-music", "prime-video", "hbo-max"] },
  volume: { kinds: ["system"], ids: ["volume"] },
  media: { kinds: ["system"], ids: ["media"] },
  lock: { kinds: ["system"], ids: ["lock"] },
  sleep: { kinds: ["system"], ids: ["sleep"] },
  shutdown: { kinds: ["system"], ids: ["shutdown"] },
  restart: { kinds: ["system"], ids: ["restart"] },
  play_game: { kinds: ["steam", "epic", "battlenet"] },
};

const isAction = (v: unknown): v is PcAction => typeof v === "string" && (PC_ACTIONS as readonly string[]).includes(v);
const isKind = (v: unknown): v is PcTargetKind => typeof v === "string" && (PC_TARGET_KINDS as readonly string[]).includes(v);

/**
 * A site host as a row key (D3 "Row identity", D5 "Sites"): trimmed, lower
 * case, IDNA ASCII form, one leading `www.` removed. Undefined for anything
 * that is not a plain host name (scheme, port, path, spaces, empty). Exact host:
 * `music.youtube.com` and `youtube.com` stay separate rows (Q13). Whether the
 * host may be opened at all (IP literals, `localhost`, private names, DNS) is
 * decided before a row is recorded (T17.6), not here.
 */
export function canonicalHost(raw: string): string | undefined {
  // Must be idempotent: a stored id is checked again on load (validateRow), and a
  // mismatch would quarantine the whole list. A value that would still change on
  // a second pass is refused instead of being stored.
  const once = hostOnce(raw);
  return once !== undefined && hostOnce(once) === once ? once : undefined;
}

function hostOnce(raw: string): string | undefined {
  const t = raw.trim().toLowerCase().replace(/\.$/, "");
  if (t === "" || !/^[^\s/:?#@\\]+$/.test(t)) return undefined;
  const ascii = domainToASCII(t);
  if (ascii === "") return undefined;
  let host = ascii;
  while (host.startsWith("www.")) host = host.slice(4);
  if (
    host === "" ||
    host.length > MAX_HOST_CHARS ||
    !/^[a-z0-9.-]+$/.test(host) ||
    host.startsWith(".") ||
    host.endsWith(".") ||
    host.includes("..")
  ) {
    return undefined;
  }
  return host;
}

/**
 * The canonical target id for `kind`, or undefined when `id` cannot be one:
 * `app` lower-cased (AppsFolder parsing names compare case-insensitively),
 * `site` through canonicalHost(), the launcher kinds trimmed as given (store ids
 * are case-sensitive), `search` / `system` only their fixed ids.
 */
export function canonicalTargetId(action: PcAction, kind: PcTargetKind, id: string): string | undefined {
  const allowed = ACTION_TARGETS[action];
  if (!allowed.kinds.includes(kind)) return undefined;
  let out: string | undefined;
  switch (kind) {
    case "app":
      out = id.trim().toLowerCase();
      break;
    case "site":
      out = canonicalHost(id);
      break;
    case "steam":
    case "epic":
    case "battlenet":
      out = id.trim();
      break;
    case "search":
    case "system":
      out = id;
      break;
  }
  if (out === undefined || out === "" || out.length > MAX_TARGET_ID_CHARS) return undefined;
  if (allowed.ids && !allowed.ids.includes(out)) return undefined;
  return out;
}

/** `p-` + 16 hex digits of sha256(action|kind|id): deterministic. `id` must already be canonical. */
export function pcRowId(action: PcAction, kind: PcTargetKind, id: string): string {
  return `p-${createHash("sha256").update(`${action}|${kind}|${id}`, "utf8").digest("hex").slice(0, 16)}`;
}

export const PC_ROW_ID_RE = /^p-[0-9a-f]{16}$/;

/** What the coordinator knows about a resolved request (T17.4+). */
export interface PcTargetRef {
  action: PcAction;
  kind: PcTargetKind;
  /** Target id before canonicalization (an AppsFolder id, a host, a launcher id, a fixed id). */
  id: string;
  /** Display name of the target ("Steam", "youtube.com", "Ses düzeyi"). */
  label: string;
  /** The spoken name that resolved to it, normalized (kept as an alias, at most MAX_PC_ALIASES). */
  alias?: string;
}

/** One stored row (the file's shape). */
interface PcPermissionRow {
  id: string;
  action: PcAction;
  target: { kind: PcTargetKind; id: string; label: string };
  aliases: string[];
  enabled: boolean;
  /** False while added by a refused request and not yet seen on the page (the badge counts these). */
  seen: boolean;
  createdAt: string;
  lastRequestedAt: string;
  requests: number;
  changedAt: string | null;
  changedBy: string | null;
}

interface PcPermissionFile {
  version: 1;
  rows: PcPermissionRow[];
}

export type PcLookup = { state: "unavailable" } | { state: "invalid" } | { state: "missing"; rowId: string } | { state: "on" | "off"; rowId: string };

export type PcRefusalResult =
  | { ok: true; rowId: string; created: boolean }
  | { ok: false; reason: "unavailable" | "invalid" | "full" | "write_failed" };

export type PcSetResult =
  | { ok: true; changed: boolean }
  | { ok: false; code: "not_allowed" | "unknown_item" | "pc_permissions_unavailable" | "internal" };

export type PcSeenResult = { ok: true; changed: boolean } | { ok: false; code: "pc_permissions_unavailable" | "internal" };

export interface PcPermissionListing {
  available: boolean;
  /** Most recently requested first. Empty while unavailable. */
  rows: PcPermissionInfo[];
  unseen: number;
}

/**
 * What the PC coordinator (model tools, tier 0; T17.4+) may do with the list:
 * read a row and record a refusal. It has no way to switch a row
 * (docs/11 D3 "Structural separation").
 */
export interface PcPermissionView {
  lookup(ref: Omit<PcTargetRef, "label" | "alias">): PcLookup;
  recordRefusal(ref: PcTargetRef): Promise<PcRefusalResult>;
}

export interface PcPermissionStoreOptions {
  /** `<SHADOW_DATA_DIR>/pc`. */
  dir: string;
  /** CORE_PC_PERMISSION_DEVICES (lower-case device names); empty = nobody may switch. */
  managers: readonly string[];
  now?: () => number;
  log?: (msg: string) => void;
  fs?: AtomicFs;
  retryDelaysMs?: readonly number[];
  /** Default MAX_PC_PERMISSION_ROWS. */
  maxRows?: number;
}

export class PcPermissionStore {
  readonly file: string;
  private readonly managers: ReadonlySet<string>;
  private readonly now: () => number;
  private readonly maxRows: number;
  /** Undefined before load() and while unavailable. */
  private rows: PcPermissionRow[] | undefined;
  private state: "not_loaded" | "available" | "unavailable" = "not_loaded";
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(unseen: number) => void>();
  private lastUnseen = 0;

  constructor(private readonly o: PcPermissionStoreOptions) {
    this.file = join(o.dir, PC_PERMISSIONS_FILE);
    this.managers = new Set(o.managers);
    this.now = o.now ?? Date.now;
    this.maxRows = o.maxRows ?? MAX_PC_PERMISSION_ROWS;
  }

  /**
   * Reads the file once (startup). Missing → empty list. Corrupt → quarantined,
   * unavailable. Unreadable (locked, permissions) or a corrupt file that could
   * not be moved aside → unavailable. Never rejects; logs one line.
   */
  load(): Promise<void> {
    return this.serial(async () => {
      if (this.state !== "not_loaded") return;
      let leftInPlace = false;
      let quarantined = false;
      let data: PcPermissionFile | undefined;
      try {
        data = await readJsonOrQuarantine(this.file, validateFile, {
          fs: this.o.fs,
          retryDelaysMs: this.o.retryDelaysMs,
          now: this.now,
          onQuarantine: (info) => {
            quarantined = true;
            if (!info.movedTo) leftInPlace = true;
          },
        });
      } catch (err) {
        this.unavailable(`could not be read (${errName(err)})`);
        return;
      }
      if (quarantined) {
        this.unavailable(leftInPlace ? "is invalid and could not be moved aside" : "was invalid and was moved aside (.corrupt-<ts>)");
        return;
      }
      // No file but a quarantined copy next to it: an earlier start found the list corrupt and
      // nobody restored it. Still unavailable (a fresh empty file would hide the grants in the copy).
      if (data === undefined && (await this.hasQuarantinedCopy())) {
        this.unavailable(`is missing but a quarantined copy (${PC_PERMISSIONS_FILE}.corrupt-<ts>) exists`);
        return;
      }
      this.rows = data?.rows ?? [];
      this.state = "available";
      this.publish();
    });
  }

  /** False before load() and after a failed load. */
  get available(): boolean {
    return this.state === "available";
  }

  /** Rows not yet seen on the page (the badge, /health `inbox.pc`); 0 while unavailable. */
  get unseen(): number {
    return this.rows ? countUnseen(this.rows) : 0;
  }

  /** Whether `device` (from its token) may switch rows: CORE_PC_PERMISSION_DEVICES; empty = nobody. */
  canManage(device: string): boolean {
    return this.managers.has(device);
  }

  /** Called with the new unseen count whenever it changes. Returns the unsubscribe function. */
  subscribe(listener: (unseen: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Drops the listeners (shutdown). */
  close(): void {
    this.listeners.clear();
  }

  /** Waits for the changes in flight (shutdown). Writes are immediate, so nothing is pending after them. */
  flush(): Promise<void> {
    return this.serial(async () => {});
  }

  /** The page's view: display fields only (no target id, aliases or device names). */
  list(): Promise<PcPermissionListing> {
    return this.serial(async () => {
      if (!this.rows) return { available: false, rows: [], unseen: 0 };
      const rows = [...this.rows]
        .sort((a, b) => Date.parse(b.lastRequestedAt) - Date.parse(a.lastRequestedAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(rowInfo);
      return { available: true, rows, unseen: countUnseen(this.rows) };
    });
  }

  /**
   * Switches one row, by `device` (from the token). The ONLY code that sets
   * `enabled`; the only caller is the `pc_permission_set` handler (session.ts).
   * Order: device (not_allowed, also while unavailable, so nothing leaks to an
   * unlisted device) → store unavailable → unknown row → write. Idempotent:
   * the same value again answers ok without a write. A switched row counts as seen.
   */
  setEnabled(device: string, rowId: string, enabled: boolean): Promise<PcSetResult> {
    return this.serial(async (): Promise<PcSetResult> => {
      if (!this.canManage(device)) return { ok: false, code: "not_allowed" };
      if (!this.rows) return { ok: false, code: "pc_permissions_unavailable" };
      const index = this.rows.findIndex((r) => r.id === rowId);
      const cur = this.rows[index];
      if (!cur) return { ok: false, code: "unknown_item" };
      if (cur.enabled === enabled) return { ok: true, changed: false };
      const next = [...this.rows];
      next[index] = { ...cur, enabled, seen: true, changedAt: new Date(this.now()).toISOString(), changedBy: device };
      if (!(await this.commit(next))) return { ok: false, code: "internal" };
      this.o.log?.(`[shadow-core] pc permission ${rowId} switched ${enabled ? "on" : "off"} by device ${device}`);
      return { ok: true, changed: true };
    });
  }

  /** Marks every row seen (the page was opened); the badge goes to 0. Any device. */
  markAllSeen(): Promise<PcSeenResult> {
    return this.serial(async (): Promise<PcSeenResult> => {
      if (!this.rows) return { ok: false, code: "pc_permissions_unavailable" };
      if (this.rows.every((r) => r.seen)) return { ok: true, changed: false };
      if (!(await this.commit(this.rows.map((r) => (r.seen ? r : { ...r, seen: true }))))) return { ok: false, code: "internal" };
      return { ok: true, changed: true };
    });
  }

  /**
   * The row of a resolved request, synchronously (the in-memory list): `on`,
   * `off`, `missing` (no row yet), `invalid` (the target cannot be a row) or
   * `unavailable` (the store failed to load: treat as not allowed).
   */
  lookup(ref: Omit<PcTargetRef, "label" | "alias">): PcLookup {
    if (!this.rows) return { state: "unavailable" };
    const key = rowKey(ref);
    if (!key) return { state: "invalid" };
    const row = this.rows.find((r) => r.id === key.rowId);
    if (!row) return { state: "missing", rowId: key.rowId };
    return { state: row.enabled ? "on" : "off", rowId: row.id };
  }

  /**
   * A request was refused (row missing or off): creates the row **off** and
   * unseen, or bumps its counter and alias list. Never changes `enabled` or
   * `seen` of an existing row. At the row limit nothing is added (`full`).
   */
  recordRefusal(ref: PcTargetRef): Promise<PcRefusalResult> {
    return this.serial(async (): Promise<PcRefusalResult> => {
      if (!this.rows) return { ok: false, reason: "unavailable" };
      const key = rowKey(ref);
      const label = ref.label.trim();
      if (!key || label === "" || label.length > MAX_LABEL_CHARS) return { ok: false, reason: "invalid" };
      const alias = ref.alias?.trim();
      const usableAlias = alias && alias.length <= MAX_ALIAS_CHARS ? alias : undefined;
      const at = new Date(this.now()).toISOString();
      const index = this.rows.findIndex((r) => r.id === key.rowId);
      const cur = this.rows[index];
      let next: PcPermissionRow[];
      if (cur) {
        next = [...this.rows];
        next[index] = { ...cur, lastRequestedAt: at, requests: cur.requests + 1, aliases: withAlias(cur.aliases, usableAlias) };
      } else {
        if (this.rows.length >= this.maxRows) {
          this.o.log?.(`[shadow-core] pc permission list is full (${this.maxRows} rows); a refused request added no row`);
          return { ok: false, reason: "full" };
        }
        next = [
          ...this.rows,
          {
            id: key.rowId,
            action: ref.action,
            target: { kind: ref.kind, id: key.id, label },
            aliases: withAlias([], usableAlias),
            enabled: false,
            seen: false,
            createdAt: at,
            lastRequestedAt: at,
            requests: 1,
            changedAt: null,
            changedBy: null,
          },
        ];
      }
      if (!(await this.commit(next))) return { ok: false, reason: "write_failed" };
      return { ok: true, rowId: key.rowId, created: !cur };
    });
  }

  /** Writes `next`; only after success it becomes the in-memory list. */
  private async commit(next: PcPermissionRow[]): Promise<boolean> {
    const file: PcPermissionFile = { version: 1, rows: next };
    try {
      await writeFileAtomic(this.file, `${JSON.stringify(file, null, 2)}\n`, { fs: this.o.fs, retryDelaysMs: this.o.retryDelaysMs });
    } catch (err) {
      this.o.log?.(`[shadow-core] pc permission list could not be written (${errName(err)}); nothing changed`);
      return false;
    }
    this.rows = next;
    this.publish();
    return true;
  }

  /** Whether `<file>.corrupt-<ts>` exists. A folder that cannot be listed counts as yes (fail closed), a missing one as no. */
  private async hasQuarantinedCopy(): Promise<boolean> {
    const prefix = `${PC_PERMISSIONS_FILE}.corrupt-`;
    try {
      const names = this.o.fs ? await this.o.fs.readdir(this.o.dir) : await readdir(this.o.dir);
      return names.some((n) => n.startsWith(prefix));
    } catch (err) {
      return (err as { code?: unknown })?.code !== "ENOENT";
    }
  }

  private unavailable(why: string): void {
    this.state = "unavailable";
    this.rows = undefined;
    this.o.log?.(
      `[shadow-core] pc permission list ${why}: PC commands are refused and nothing is written until the Core restarts (restore the file by hand)`,
    );
  }

  private publish(): void {
    const n = this.unseen;
    if (n === this.lastUnseen) return;
    this.lastUnseen = n;
    for (const l of [...this.listeners]) {
      try {
        l(n);
      } catch {
        // a listener must not break the store
      }
    }
  }

  /** Runs `fn` after every earlier call (the one mutex of the store). */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }
}

/**
 * The coordinator's handle (T17.4+): lookup and recordRefusal only. A plain
 * object, not the store, so no cast reaches setEnabled().
 */
export function pcPermissionView(store: PcPermissionStore): PcPermissionView {
  return Object.freeze({
    lookup: (ref: Omit<PcTargetRef, "label" | "alias">) => store.lookup(ref),
    recordRefusal: (ref: PcTargetRef) => store.recordRefusal(ref),
  });
}

function rowKey(ref: Omit<PcTargetRef, "label" | "alias">): { rowId: string; id: string } | undefined {
  if (!isAction(ref.action) || !isKind(ref.kind) || typeof ref.id !== "string") return undefined;
  const id = canonicalTargetId(ref.action, ref.kind, ref.id);
  return id === undefined ? undefined : { rowId: pcRowId(ref.action, ref.kind, id), id };
}

function withAlias(aliases: readonly string[], alias: string | undefined): string[] {
  if (!alias) return [...aliases];
  return [...aliases.filter((a) => a !== alias), alias].slice(-MAX_PC_ALIASES);
}

const countUnseen = (rows: readonly PcPermissionRow[]) => rows.filter((r) => !r.seen).length;

function rowInfo(r: PcPermissionRow): PcPermissionInfo {
  return {
    rowId: r.id,
    action: r.action,
    kind: r.target.kind,
    label: r.target.label,
    enabled: r.enabled,
    seen: r.seen,
    requests: r.requests,
    createdAt: r.createdAt,
    lastRequestedAt: r.lastRequestedAt,
    ...(r.changedAt !== null ? { changedAt: r.changedAt } : {}),
  };
}

function errName(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === "string") return code;
  return err instanceof Error ? err.name : "error";
}

// ---------------------------------------------------------------- validation

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIso = (v: unknown): v is string => typeof v === "string" && v.length <= 64 && !Number.isNaN(Date.parse(v));
const isNullableIso = (v: unknown) => v === null || isIso(v);
const isDeviceName = (v: unknown) => v === null || (typeof v === "string" && v.length > 0 && v.length <= 128);

/**
 * Strict: any malformed row makes the whole file invalid (quarantine →
 * unavailable), instead of dropping it, so a later write can never silently
 * lose a row. A row whose id does not match its action + target is invalid
 * too (a hand edit cannot point an id at another target).
 */
function validateFile(v: unknown): PcPermissionFile | undefined {
  if (!isObj(v) || v.version !== 1 || !Array.isArray(v.rows) || v.rows.length > MAX_PC_PERMISSION_ROWS) return undefined;
  const rows: PcPermissionRow[] = [];
  const ids = new Set<string>();
  for (const raw of v.rows) {
    const row = validateRow(raw);
    if (!row || ids.has(row.id)) return undefined;
    ids.add(row.id);
    rows.push(row);
  }
  return { version: 1, rows };
}

function validateRow(v: unknown): PcPermissionRow | undefined {
  if (!isObj(v) || typeof v.id !== "string" || !PC_ROW_ID_RE.test(v.id) || !isAction(v.action)) return undefined;
  const t = v.target;
  if (!isObj(t) || !isKind(t.kind) || typeof t.id !== "string" || typeof t.label !== "string") return undefined;
  if (t.label.trim() === "" || t.label.length > MAX_LABEL_CHARS) return undefined;
  if (canonicalTargetId(v.action, t.kind, t.id) !== t.id || pcRowId(v.action, t.kind, t.id) !== v.id) return undefined;
  if (!Array.isArray(v.aliases) || v.aliases.length > MAX_PC_ALIASES) return undefined;
  if (!v.aliases.every((a) => typeof a === "string" && a.length > 0 && a.length <= MAX_ALIAS_CHARS)) return undefined;
  if (typeof v.enabled !== "boolean" || typeof v.seen !== "boolean") return undefined;
  if (!isIso(v.createdAt) || !isIso(v.lastRequestedAt) || !isNullableIso(v.changedAt) || !isDeviceName(v.changedBy)) return undefined;
  if (typeof v.requests !== "number" || !Number.isInteger(v.requests) || v.requests < 1) return undefined;
  return {
    id: v.id,
    action: v.action,
    target: { kind: t.kind, id: t.id, label: t.label },
    aliases: [...(v.aliases as string[])],
    enabled: v.enabled,
    seen: v.seen,
    createdAt: v.createdAt,
    lastRequestedAt: v.lastRequestedAt,
    requests: v.requests,
    changedAt: (v.changedAt as string | null) ?? null,
    changedBy: (v.changedBy as string | null) ?? null,
  };
}
