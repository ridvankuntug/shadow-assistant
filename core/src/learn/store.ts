/**
 * Learned-rule store (T7.w.2c; docs/08 §Lifecycle, §Data file):
 * `<SHADOW_DATA_DIR>/fast-path/rules.json`.
 *
 *   observing ──(min_observations same outcomes)──▶ candidate ──activate()──▶ active ──remove()──▶ rejected
 *       │                                              │                       │  ▲
 *       └─(2 conflicts)─▶ blocked                      └─reject()─▶ rejected   │  │ activate() (re-validated)
 *                                                                              ▼  │ max_failures fallbacks in a row,
 *                                                                          suspended   or not allowed at load (reject() → rejected)
 *
 * - A phrasing (token array) has one entry; its signature (service + tool +
 *   domain + binding) is fixed until a conflicting observation restarts the
 *   count. `id` = hash of tokens + signature.
 * - Nothing becomes `active` except through `activate()` (the user's "Kuralı
 *   ekle" on a candidate, T7.w.4b, or "Yeniden aç" on a suspended rule,
 *   T7.w.8), which re-validates the rule against the current ceilings and
 *   applies only after the new file is on disk. `remove()` ("Kaldır", T7.w.8:
 *   active → rejected) is all or nothing the same way, so a removed rule leaves
 *   the snapshot only once the file says so. Suspension, by contrast, takes
 *   effect in memory at once even if its write fails.
 * - There is no way back from `rejected` / `blocked`; a suspended rule can be
 *   re-opened (`activate()`) or rejected ("Yok say").
 * - Load re-validates: an active rule whose tool, service or domain the
 *   current `learning` block (or the code ceiling) no longer allows becomes
 *   `suspended` (`not_allowed`); observing / candidate counts made under
 *   another TEXT_NORMALIZER_VERSION restart.
 * - Caps: MAX_OBSERVING `observing` and MAX_DISCARDED `rejected` + `blocked`
 *   entries, least recently seen dropped first; candidate / active /
 *   suspended entries are never dropped.
 * - Writes are atomic and serialized on one chain. A corrupt file, a version
 *   other than 1 or any malformed entry quarantines the whole file (one
 *   warning; the Core starts with no learned rules; static tier 0 is not
 *   affected). An invalid file that could not be moved aside is never
 *   overwritten. A failed write keeps the in-memory state and is retried by
 *   the next change.
 *
 * The file holds the literal words of the user's phrasings (never room or
 * device names: those are the `<ad>` slot), tool and domain names, counters
 * and times; `activatedBy` / `removedBy` are device names. It is never logged.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readJsonOrQuarantine, writeFileAtomic, type AtomicFs } from "../atomic-file.js";
import {
  compileLearnedRule,
  compileLearnedTokens,
  LEARNABLE_SERVICE,
  learnableDomainsFor,
  LEARNED_KEYWORD,
  TEXT_NORMALIZER_VERSION,
  type CompiledLearnedRule,
  type CompiledRouterConfig,
  type LearnableTool,
} from "../router-config.js";
import { signatureOf, type Binding, type Extracted } from "./extract.js";

export type LearnedStatus = "observing" | "candidate" | "active" | "suspended" | "rejected" | "blocked";

export interface LearnedRuleRecord {
  /** `lr-` + 8 hex chars. */
  id: string;
  status: LearnedStatus;
  tokens: string[];
  /** TEXT_NORMALIZER_VERSION the entry was counted under. */
  normalizer: number;
  service: string;
  tool: string;
  domains: string[];
  keywords: string[];
  binding: Binding;
  observations: number;
  conflicts: number;
  /** ISO 8601. */
  firstSeen: string;
  lastSeen: string;
  activatedAt: string | null;
  /** Device name from the token (never the token). */
  activatedBy: string | null;
  uses: number;
  consecutiveFailures: number;
  /** Last fallback reason, or `not_allowed` for a load-time suspension. */
  lastFailure: string | null;
  /**
   * Device name that removed the active rule ("Kaldır", T7.w.8). Absent on
   * every other entry (files written before T7.w.8 have no such field).
   */
  removedBy?: string;
}

export interface LearnedRulesFile {
  version: 1;
  rules: LearnedRuleRecord[];
}

export const LEARNED_RULES_DIR = "fast-path";
export const LEARNED_RULES_FILE = "rules.json";
export const MAX_OBSERVING = 200;
export const MAX_DISCARDED = 200;
/** Conflicting outcomes after which a phrasing is never suggested. */
export const BLOCK_AFTER_CONFLICTS = 2;

const STATUSES: ReadonlySet<string> = new Set<LearnedStatus>(["observing", "candidate", "active", "suspended", "rejected", "blocked"]);
const ID_RE = /^lr-[0-9a-f]{8}$/;
const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const REASON_RE = /^[a-z_]{1,64}$/;

export type ObserveResult = { id: string; status: LearnedStatus; observations: number } | undefined;

export type ActivateResult =
  | { ok: true; rule: LearnedRuleRecord }
  /**
   * `unknown`: no such id; `not_candidate`: neither a candidate nor a
   * suspended rule (already active, rejected, …); `not_allowed`: outside the
   * current ceilings, or a candidate counted under another normalizer;
   * `unavailable`: the file cannot be read; `write_failed`: not on disk, so not applied.
   */
  | { ok: false; reason: "unknown" | "not_candidate" | "not_allowed" | "unavailable" | "write_failed" };

export type RemoveResult =
  | { ok: true; rule: LearnedRuleRecord }
  /**
   * `unknown`: no such id; `not_active`: not an active rule (already removed,
   * a candidate, …); `not_allowed`: the device name cannot be stored;
   * `unavailable`: the file cannot be read; `write_failed`: not on disk, so not applied.
   */
  | { ok: false; reason: "unknown" | "not_active" | "not_allowed" | "unavailable" | "write_failed" };

export type RuleOutcome = "success" | "failure" | "neutral";

export interface LearnedRuleStoreOptions {
  /** `<SHADOW_DATA_DIR>/fast-path`. */
  dir: string;
  /** router.yaml: ceilings, `min_observations`, `max_failures`, `max_name_words`. */
  config: CompiledRouterConfig;
  /** Default TEXT_NORMALIZER_VERSION (tests change it). */
  normalizer?: number;
  now?: () => number;
  log?: (msg: string) => void;
  maxObserving?: number;
  maxDiscarded?: number;
  fs?: AtomicFs;
  retryDelaysMs?: readonly number[];
}

export class LearnedRuleStore {
  readonly file: string;
  private readonly now: () => number;
  private readonly normalizer: number;
  private data: LearnedRulesFile | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private pending = false;
  private active: readonly CompiledLearnedRule[] = [];

  constructor(private readonly o: LearnedRuleStoreOptions) {
    this.file = join(o.dir, LEARNED_RULES_FILE);
    this.now = o.now ?? Date.now;
    this.normalizer = o.normalizer ?? TEXT_NORMALIZER_VERSION;
  }

  /**
   * Active rules, oldest activation first, compiled; swapped (never mutated)
   * after each committed change, so the router reads it synchronously.
   */
  snapshot(): readonly CompiledLearnedRule[] {
    return this.active;
  }

  /** Loads the file now (startup), runs the load-time checks. Never rejects. */
  async load(): Promise<void> {
    await this.change(undefined, () => ({ result: undefined, changed: false }));
  }

  /** Counts one observation of an extracted pattern. Never rejects. */
  observe(x: Extracted): Promise<ObserveResult> {
    const signature = x.signature;
    return this.change<ObserveResult>(undefined, (data) => {
      const stamp = this.stamp();
      const key = tokenKey(x.tokens);
      const entry = data.rules.find((r) => tokenKey(r.tokens) === key);
      if (!entry) {
        const id = ruleId(x.tokens, signature);
        if (data.rules.some((r) => r.id === id)) return { result: undefined, changed: false };
        const rule: LearnedRuleRecord = {
          id,
          status: "observing",
          tokens: [...x.tokens],
          normalizer: this.normalizer,
          service: x.service,
          tool: x.tool,
          domains: [...x.domains],
          keywords: [...x.keywords],
          binding: { ...x.binding },
          observations: 1,
          conflicts: 0,
          firstSeen: stamp,
          lastSeen: stamp,
          activatedAt: null,
          activatedBy: null,
          uses: 0,
          consecutiveFailures: 0,
          lastFailure: null,
        };
        data.rules.push(rule);
        this.prune(data);
        return { result: summary(rule), changed: true };
      }
      entry.lastSeen = stamp;
      if (entry.status !== "observing" && entry.status !== "candidate") {
        // Active, suspended, rejected, blocked: the phrasing is known; only its recency changes.
        return { result: summary(entry), changed: true };
      }
      if (signatureOf(entry) === signature) {
        entry.observations++;
        if (entry.status === "observing" && entry.observations >= this.o.config.learning.minObservations) entry.status = "candidate";
      } else {
        // Same words, another outcome: start again with the new one; twice → never suggested.
        const id = ruleId(x.tokens, signature);
        if (data.rules.some((r) => r !== entry && r.id === id)) return { result: undefined, changed: true };
        entry.id = id;
        entry.service = x.service;
        entry.tool = x.tool;
        entry.domains = [...x.domains];
        entry.keywords = [...x.keywords];
        entry.binding = { ...x.binding };
        entry.observations = 1;
        entry.conflicts++;
        entry.status = entry.conflicts >= BLOCK_AFTER_CONFLICTS ? "blocked" : "observing";
      }
      this.prune(data);
      return { result: summary(entry), changed: true };
    });
  }

  /**
   * candidate → active ("Kuralı ekle") or suspended → active ("Yeniden aç",
   * T7.w.8). Re-validated against the current ceilings; applied (file, then
   * snapshot) only once the file is written. The failure count restarts.
   * `by`: the device name that approved it (replaces an earlier one).
   *
   * A candidate must also have been counted under the current normalizer (at
   * load an older one goes back to observing anyway). A suspended rule was
   * active, and active rules stay across a normalizer change (§Data file), so
   * it is checked like an active rule at load: the ceilings and its tokens.
   */
  activate(id: string, by: string): Promise<ActivateResult> {
    if (!NAME_RE.test(by)) return Promise.resolve({ ok: false, reason: "not_allowed" });
    return this.transaction<ActivateResult>({ ok: false, reason: "unavailable" }, (data) => {
      const entry = data.rules.find((r) => r.id === id);
      if (!entry) return { ok: false, reason: "unknown" };
      if (entry.status !== "candidate" && entry.status !== "suspended") return { ok: false, reason: "not_candidate" };
      if (entry.status === "candidate" && entry.normalizer !== this.normalizer) return { ok: false, reason: "not_allowed" };
      if (!this.allowed(entry)) return { ok: false, reason: "not_allowed" };
      entry.status = "active";
      entry.activatedAt = this.stamp();
      entry.activatedBy = by;
      entry.consecutiveFailures = 0;
      entry.lastFailure = null;
      delete entry.removedBy;
      return { ok: true, rule: structuredClone(entry) };
    });
  }

  /**
   * active → rejected ("Kaldır", T7.w.8): the rule stops running and the
   * phrasing is not suggested again (the entry keeps its pattern and
   * signature). Applied (file, then snapshot) only once the file is written.
   * `by`: the device name that removed it, stored as `removedBy`.
   */
  remove(id: string, by: string): Promise<RemoveResult> {
    if (!NAME_RE.test(by)) return Promise.resolve({ ok: false, reason: "not_allowed" });
    return this.transaction<RemoveResult>({ ok: false, reason: "unavailable" }, (data) => {
      const entry = data.rules.find((r) => r.id === id);
      if (!entry) return { ok: false, reason: "unknown" };
      if (entry.status !== "active") return { ok: false, reason: "not_active" };
      entry.status = "rejected";
      entry.lastSeen = this.stamp(); // fresh, so prune() does not drop the just-removed rule first
      entry.removedBy = by;
      const rule = structuredClone(entry);
      this.prune(data);
      return { ok: true, rule };
    });
  }

  /**
   * candidate or suspended → rejected ("Yok say"): the phrasing is not
   * suggested again. An active rule is never rejected here (that is
   * `remove()`, limited to CORE_DEV_DEVICES). Resolves whether it changed.
   */
  reject(id: string): Promise<boolean> {
    return this.change(false, (data) => {
      const entry = data.rules.find((r) => r.id === id);
      if (!entry || (entry.status !== "candidate" && entry.status !== "suspended")) return { result: false, changed: false };
      entry.status = "rejected";
      this.prune(data);
      return { result: true, changed: true };
    });
  }

  /**
   * Result of one run of an active rule. `failure` (a fallback: name not
   * found, ambiguous, refused target, tool or live-context error) counts
   * toward suspension; `success` resets the count; `neutral` (denied,
   * cancelled, service unreachable) changes nothing. Resolves whether this
   * run suspended the rule.
   */
  recordOutcome(id: string, outcome: RuleOutcome, reason?: string): Promise<{ suspended: boolean }> {
    if (outcome === "neutral") return Promise.resolve({ suspended: false });
    return this.change<{ suspended: boolean }>({ suspended: false }, (data) => {
      const entry = data.rules.find((r) => r.id === id);
      if (!entry || entry.status !== "active") return { result: { suspended: false }, changed: false };
      if (outcome === "success") {
        entry.uses++;
        entry.consecutiveFailures = 0;
        return { result: { suspended: false }, changed: true };
      }
      entry.consecutiveFailures++;
      entry.lastFailure = reason !== undefined && REASON_RE.test(reason) ? reason : "failed";
      if (entry.consecutiveFailures < this.o.config.learning.maxFailures) return { result: { suspended: false }, changed: true };
      entry.status = "suspended";
      this.o.log?.(`[shadow-core] learned rule ${entry.id} suspended after ${entry.consecutiveFailures} fallbacks in a row`);
      return { result: { suspended: true }, changed: true };
    });
  }

  /** All entries (copies), for the Development tab (T7.w.4b). Empty if the file cannot be read. */
  list(): Promise<LearnedRuleRecord[]> {
    return this.change<LearnedRuleRecord[]>([], (data) => ({ result: structuredClone(data.rules), changed: false }));
  }

  /** Retries a failed write now (shutdown). Never rejects. */
  async flush(): Promise<void> {
    await this.change(undefined, () => ({ result: undefined, changed: false }));
  }

  // ---------------------------------------------------------------- internals

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }

  /** Tool, service and domains inside the current ceilings, and the tokens still compile. */
  private allowed(r: LearnedRuleRecord): boolean {
    if (r.service !== LEARNABLE_SERVICE || !this.o.config.learning.tools.has(r.tool)) return false;
    const domains = learnableDomainsFor(r.tool, this.o.config.learning.domains);
    if (r.domains.length === 0 || !r.domains.every((d) => domains.includes(d))) return false;
    try {
      compileLearnedTokens(r.tokens, r.tool, this.o.config.direct.maxNameWords);
      return true;
    } catch {
      return false;
    }
  }

  private prune(data: LearnedRulesFile): void {
    const drop = (statuses: readonly LearnedStatus[], max: number) => {
      const group = data.rules.filter((r) => statuses.includes(r.status));
      if (group.length <= max) return;
      group.sort((a, b) => Date.parse(a.lastSeen) - Date.parse(b.lastSeen) || (a.id < b.id ? -1 : 1));
      const gone = new Set(group.slice(0, group.length - max));
      data.rules = data.rules.filter((r) => !gone.has(r));
    };
    drop(["observing"], this.o.maxObserving ?? MAX_OBSERVING);
    drop(["rejected", "blocked"], this.o.maxDiscarded ?? MAX_DISCARDED);
  }

  private rebuildSnapshot(data: LearnedRulesFile): void {
    const rules = data.rules
      .filter((r) => r.status === "active" && this.allowed(r))
      .sort((a, b) => Date.parse(a.activatedAt ?? "") - Date.parse(b.activatedAt ?? "") || (a.id < b.id ? -1 : 1));
    this.active = Object.freeze(
      rules.map((r) =>
        compileLearnedRule(
          { id: r.id, tokens: [...r.tokens], service: r.service, tool: r.tool as LearnableTool, domains: [...r.domains], keywords: [...r.keywords] },
          this.o.config.direct.maxNameWords,
        ),
      ),
    );
  }

  private async write(data: LearnedRulesFile): Promise<void> {
    await writeFileAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`, { fs: this.o.fs, retryDelaysMs: this.o.retryDelaysMs });
  }

  /**
   * Runs `fn` on the loaded data under the chain and writes when it changed
   * anything (or an earlier write failed). A failed write keeps the change in
   * memory (retried by the next write).
   */
  private change<T>(fallback: T, fn: (data: LearnedRulesFile) => { result: T; changed: boolean }): Promise<T> {
    const run = this.chain.then(async () => {
      let data: LearnedRulesFile;
      try {
        data = await this.loaded();
      } catch (err) {
        this.o.log?.(`[shadow-core] learned rules file could not be read: ${errName(err)}`);
        return fallback;
      }
      const { result, changed } = fn(data);
      if (changed || this.pending) {
        try {
          await this.write(data);
          this.pending = false;
        } catch (err) {
          this.pending = true;
          this.o.log?.(`[shadow-core] learned rules write failed: ${errName(err)}`);
        }
      }
      if (changed) this.rebuildSnapshot(data);
      return result;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  /**
   * Like `change`, but all or nothing: `fn` works on a copy, which replaces
   * the in-memory state only after it was written (activation).
   */
  private transaction<T extends { ok: boolean }>(fallback: T, fn: (data: LearnedRulesFile) => T): Promise<T | { ok: false; reason: "write_failed" }> {
    const run = this.chain.then(async (): Promise<T | { ok: false; reason: "write_failed" }> => {
      let current: LearnedRulesFile;
      try {
        current = await this.loaded();
      } catch (err) {
        this.o.log?.(`[shadow-core] learned rules file could not be read: ${errName(err)}`);
        return fallback;
      }
      const next = structuredClone(current);
      const result = fn(next);
      if (!result.ok) return result;
      try {
        await this.write(next);
      } catch (err) {
        this.o.log?.(`[shadow-core] learned rules write failed, change not applied: ${errName(err)}`);
        return { ok: false, reason: "write_failed" };
      }
      this.pending = false;
      this.data = next;
      this.rebuildSnapshot(next);
      return result;
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private async loaded(): Promise<LearnedRulesFile> {
    if (this.data) return this.data;
    let leftInPlace = false;
    const read = await readJsonOrQuarantine(this.file, validateFile, {
      fs: this.o.fs,
      retryDelaysMs: this.o.retryDelaysMs,
      now: this.now,
      onQuarantine: (info) => {
        if (info.movedTo) this.o.log?.("[shadow-core] learned rules file was invalid and was moved aside; starting with no learned rules");
        else leftInPlace = true;
      },
    });
    if (leftInPlace) throw Object.assign(new Error("invalid file could not be moved aside"), { code: "QUARANTINE_FAILED" });
    const data = read ?? { version: 1 as const, rules: [] };
    // Load-time checks; a change is written by the next write (marked pending).
    for (const r of data.rules) {
      if ((r.status === "observing" || r.status === "candidate") && r.normalizer !== this.normalizer) {
        r.status = "observing";
        r.observations = 0;
        r.conflicts = 0;
        r.normalizer = this.normalizer;
        this.pending = true;
      } else if (r.status === "active" && !this.allowed(r)) {
        r.status = "suspended";
        r.lastFailure = "not_allowed";
        this.pending = true;
        this.o.log?.(`[shadow-core] learned rule ${r.id} suspended: no longer allowed by router.yaml`);
      }
    }
    this.data = data;
    this.rebuildSnapshot(data);
    return data;
  }
}

function tokenKey(tokens: readonly string[]): string {
  return tokens.join(" ");
}

/** Stable id from the token array and the signature. */
export function ruleId(tokens: readonly string[], signature: string): string {
  return `lr-${createHash("sha256").update(JSON.stringify([tokens, signature])).digest("hex").slice(0, 8)}`;
}

function summary(r: LearnedRuleRecord): ObserveResult {
  return { id: r.id, status: r.status, observations: r.observations };
}

function errName(err: unknown): string {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
    if (err instanceof Error) return err.name;
  }
  return "error";
}

// ---------------------------------------------------------------- validation

const isIso = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isStrings = (v: unknown, re: RegExp): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && re.test(x));

function validateBinding(v: unknown): Binding | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (o.name !== "ad") return undefined;
  if (o.brightness !== undefined && o.brightness !== "sayi") return undefined;
  if (Object.keys(o).some((k) => k !== "name" && k !== "brightness")) return undefined;
  return { name: "ad", ...(o.brightness === "sayi" ? { brightness: "sayi" as const } : {}) };
}

function validateRule(v: unknown): LearnedRuleRecord | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !ID_RE.test(o.id)) return undefined;
  if (typeof o.status !== "string" || !STATUSES.has(o.status)) return undefined;
  if (typeof o.service !== "string" || !NAME_RE.test(o.service)) return undefined;
  if (typeof o.tool !== "string" || !NAME_RE.test(o.tool)) return undefined;
  if (!Array.isArray(o.tokens) || !o.tokens.every((t) => typeof t === "string")) return undefined;
  try {
    // Plain words and slots only, the slot set the tool needs: no pattern metacharacter is ever compiled from the file.
    compileLearnedTokens(o.tokens as string[], o.tool, 8);
  } catch {
    return undefined;
  }
  if (!isStrings(o.domains, /^[a-z_]{1,64}$/) || o.domains.length === 0) return undefined;
  if (!isStrings(o.keywords, LEARNED_KEYWORD)) return undefined;
  const binding = validateBinding(o.binding);
  if (!binding) return undefined;
  if (!isCount(o.normalizer) || !isCount(o.observations) || !isCount(o.conflicts) || !isCount(o.uses) || !isCount(o.consecutiveFailures)) return undefined;
  if (!isIso(o.firstSeen) || !isIso(o.lastSeen)) return undefined;
  if (o.activatedAt !== null && !isIso(o.activatedAt)) return undefined;
  if (o.activatedBy !== null && (typeof o.activatedBy !== "string" || !NAME_RE.test(o.activatedBy))) return undefined;
  if (o.lastFailure !== null && (typeof o.lastFailure !== "string" || !REASON_RE.test(o.lastFailure))) return undefined;
  if (o.removedBy !== undefined && (typeof o.removedBy !== "string" || !NAME_RE.test(o.removedBy))) return undefined;
  if (o.status === "active" && (o.activatedAt === null || o.activatedBy === null)) return undefined;
  return {
    id: o.id,
    status: o.status as LearnedStatus,
    tokens: [...(o.tokens as string[])],
    normalizer: o.normalizer,
    service: o.service,
    tool: o.tool,
    domains: [...o.domains],
    keywords: [...o.keywords],
    binding,
    observations: o.observations,
    conflicts: o.conflicts,
    firstSeen: o.firstSeen,
    lastSeen: o.lastSeen,
    activatedAt: o.activatedAt as string | null,
    activatedBy: o.activatedBy as string | null,
    uses: o.uses,
    consecutiveFailures: o.consecutiveFailures,
    lastFailure: o.lastFailure as string | null,
    ...(typeof o.removedBy === "string" ? { removedBy: o.removedBy } : {}),
  };
}

/** The whole file or nothing: one malformed entry, a duplicate id or a duplicate phrasing quarantines it. */
function validateFile(v: unknown): LearnedRulesFile | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (o.version !== 1 || !Array.isArray(o.rules)) return undefined;
  const rules: LearnedRuleRecord[] = [];
  const ids = new Set<string>();
  const phrasings = new Set<string>();
  for (const raw of o.rules as unknown[]) {
    const r = validateRule(raw);
    if (!r || ids.has(r.id) || phrasings.has(tokenKey(r.tokens))) return undefined;
    ids.add(r.id);
    phrasings.add(tokenKey(r.tokens));
    rules.push(r);
  }
  return { version: 1, rules };
}
