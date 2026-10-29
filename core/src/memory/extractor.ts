/**
 * Background memory extraction (docs/06-memory.md §Automatic extraction, task M4).
 *
 * The caller (M6) decides when to try a pass (idle, every N model turns,
 * before a compaction, after start) and calls `maybeRun(device, reason)`.
 * The extractor applies the skip rules, reads the device's new turns from the
 * Core's own conversation logs (log-source.ts), redacts them (filters.ts),
 * asks a small model through the provider-neutral `ModelProvider.oneShot`
 * for JSON ops, and applies them through the memory store in one
 * transaction (merge, dedupe, filters, tombstones, at most 2 deletes).
 *
 * State (state.json through the store): per-device cursor, last run, failures
 * in a row; the global daily run count; `usageLimitUntil`.
 *
 * Cursor rules: on success it moves to the newest processed log entry. A
 * failed call (error, invalid output, write failure) leaves it, so the next
 * pass retries the same turns once; after two failures in a row it moves on.
 * A usage limit sets `usageLimitUntil` (provider `retryAt`, else one hour)
 * and suspends passes; the cursor stays.
 *
 * State writes: a failed state.json write fails the pass (`write_failed`),
 * also in the usage-limit branch (the limit still holds in memory).
 * The state is kept in memory (cursor, counters, limits) and written first by
 * the next pass; until that succeeds no pass reads logs or calls the model.
 * A missing/corrupt state.json (`readState()` → undefined) is replaced by one
 * with `resetAt` = now, so devices without a cursor start there even after a
 * restart. A read error (EIO, EACCES, ...) is not "missing": the pass fails
 * (`error`) and nothing is written, so cursors, counters and limits survive.
 *
 * Crash between applying ops and saving the cursor: just before applying, the
 * pass writes `state.pending` (device, cursor before, cursor after); the
 * cursor save after applying clears it. A `pending` found on load means the
 * pass stopped in between: that range counts as applied, the device's cursor
 * moves to its end, and the turns are not sent to the model again. A second
 * call could rephrase a fact (Jaccard < 0.8 to the stored one) and store it
 * twice; skipping instead loses at most the ops of a crash that hit before
 * the store wrote them (the same give-up as two failures in a row). Likewise
 * a store write failure after some ops were applied moves the cursor on
 * instead of retrying the range.
 *
 * Log lines hold counts, filter names and the device name only, never
 * conversation or entry text.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dayStamp } from "../conversation-log.js";
import type { ModelProvider, OneShotResult } from "../model-provider.js";
import type { UsageRecord } from "../router.js";
import { formatFilterCounts, mergeFilterCounts, redactTurn, rejectReason, type FilterCounts } from "./filters.js";
import { readDeviceTurns, type LogTurn } from "./log-source.js";
import { foldedWords, selectRelevant, textHash } from "./match.js";
import type { MemoryLogger, MemoryStore, MemoryTx } from "./store.js";
import { isEntryId, isMemoryKind, MEMORY_BUDGETS, MEMORY_KINDS, type EntrySource, type MemoryEntry, type MemoryKind, type MemoryState } from "./types.js";

export type ExtractReason = "idle" | "turns" | "compact" | "startup";

export type SkipReason =
  /** Another pass is running (passes run one at a time). */
  | "busy"
  /** `now < usageLimitUntil`. */
  | "usage_limit"
  /** `runsToday` reached the daily cap. */
  | "daily_cap"
  /** The device's previous pass was less than `minIntervalMs` ago (not for `compact`). */
  | "too_soon"
  /** Fewer than 2 new user turns. */
  | "too_few_turns"
  /** Only tier-0 commands (or nothing left after redaction): the cursor moves on, no model call. */
  | "nothing_to_learn";

export type FailReason = "error" | "invalid_output" | "write_failed" | "usage_limit" | "cancelled";

export type ExtractResult =
  | { status: "skipped"; reason: SkipReason }
  | { status: "failed"; reason: FailReason }
  | { status: "done"; added: number; updated: number; deleted: number; rejected: number };

export interface UsageSink {
  append(record: UsageRecord): unknown;
}

export interface ExtractorOptions {
  store: MemoryStore;
  provider: Pick<ModelProvider, "oneShot">;
  /** `SHADOW_DATA_DIR` (holds `conversations/`). */
  dataDir: string;
  /** `CORE_MEMORY_MODEL` (default `haiku`). */
  model: string;
  /** `CORE_MEMORY_MAX_RUNS_DAY`, global. Default 30. */
  maxRunsPerDay?: number;
  /** Minimum spacing of two passes of one device. Default 10 minutes. */
  minIntervalMs?: number;
  /** Suspension after a usage limit without `retryAt`. Default 1 hour. */
  usageLimitFallbackMs?: number;
  /** `CORE_MEMORY_EVERY_TURNS` for `noteModelTurn`. Default 10. */
  everyTurns?: number;
  /** Output budget of the call. Default 800. */
  maxTokens?: number;
  /** System prompt; default `core/prompts/memory-extract.md`. */
  systemPrompt?: string;
  usage?: UsageSink;
  logger?: MemoryLogger;
  now?: () => number;
  /** Aborts an in-flight call (Core shutdown). */
  signal?: AbortSignal;
}

/** Newest conversation text sent to the model. */
export const INPUT_MAX_CHARS = 6000;
/** Existing entries sent with it (summed text). */
export const EXISTING_MAX_CHARS = 3000;
export const MAX_OPS = 5;
export const MAX_DELETES = 2;
export const MERGE_JACCARD = 0.8;
/** A device without a cursor (first pass in a valid state.json) reads at most this far back. */
const NEW_DEVICE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

const PROMPT_FILE = fileURLToPath(new URL("../../prompts/memory-extract.md", import.meta.url));

/** JSON schema of the answer (docs/06 §The call). */
export const OPS_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["ops"],
  properties: {
    ops: {
      type: "array",
      maxItems: MAX_OPS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["op"],
        properties: {
          op: { type: "string", enum: ["add", "update", "delete"] },
          kind: { type: "string", enum: [...MEMORY_KINDS] },
          id: { type: "string", pattern: "^m-[0-9a-f]{6}$" },
          text: { type: "string", maxLength: MEMORY_BUDGETS.textMaxChars },
          keywords: { type: "array", maxItems: MEMORY_BUDGETS.keywordsMax, items: { type: "string" } },
        },
      },
    },
  },
};

export type MemoryOp =
  | { op: "add"; kind: MemoryKind; text: string; keywords: string[] }
  | { op: "update"; id: string; text?: string; keywords?: string[] }
  | { op: "delete"; id: string };

/**
 * Validates the model's answer: `{ ops: [...] }`, at most MAX_OPS ops are
 * kept. Undefined when the shape is wrong; single malformed ops are dropped
 * and counted in `invalid`.
 */
export function parseOps(value: unknown): { ops: MemoryOp[]; invalid: number } | undefined {
  if (!isObj(value) || !Array.isArray(value.ops)) return undefined;
  const ops: MemoryOp[] = [];
  let invalid = 0;
  for (const raw of value.ops.slice(0, MAX_OPS)) {
    const op = parseOp(raw);
    if (op) ops.push(op);
    else invalid++;
  }
  return { ops, invalid: invalid + Math.max(0, value.ops.length - MAX_OPS) };
}

function parseOp(v: unknown): MemoryOp | undefined {
  if (!isObj(v)) return undefined;
  const keywords = Array.isArray(v.keywords)
    ? v.keywords.filter((k): k is string => typeof k === "string").slice(0, MEMORY_BUDGETS.keywordsMax)
    : undefined;
  switch (v.op) {
    case "add":
      if (!isMemoryKind(v.kind) || typeof v.text !== "string") return undefined;
      return { op: "add", kind: v.kind, text: v.text, keywords: keywords ?? [] };
    case "update":
      if (!isEntryId(v.id) || (v.text !== undefined && typeof v.text !== "string")) return undefined;
      if (v.text === undefined && keywords === undefined) return undefined;
      return { op: "update", id: v.id, ...(typeof v.text === "string" ? { text: v.text } : {}), ...(keywords ? { keywords } : {}) };
    case "delete":
      return isEntryId(v.id) ? { op: "delete", id: v.id } : undefined;
    default:
      return undefined;
  }
}

/** Token Jaccard similarity of two texts (folded words). */
export function jaccard(a: string, b: string): number {
  const x = new Set(foldedWords(a));
  const y = new Set(foldedWords(b));
  if (x.size === 0 && y.size === 0) return 1;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/** Folded left-hand side of an alias equation ("Otomodos = oturma odası" → "otomodos"). */
function aliasLhs(text: string): string | undefined {
  const i = text.indexOf("=");
  if (i <= 0) return undefined;
  const lhs = foldedWords(text.slice(0, i)).join(" ");
  return lhs === "" ? undefined : lhs;
}

/** The existing entry an `add` should update instead: same kind and Jaccard ≥ 0.8, or (alias) the same left-hand side. */
export function mergeTarget(entries: readonly MemoryEntry[], kind: MemoryKind, text: string): MemoryEntry | undefined {
  const lhs = kind === "alias" ? aliasLhs(text) : undefined;
  return entries.find(
    (e) => e.kind === kind && ((lhs !== undefined && aliasLhs(e.text) === lhs) || jaccard(e.text, text) >= MERGE_JACCARD),
  );
}

export class MemoryExtractor {
  private readonly now: () => number;
  private running = false;
  /** State whose write failed: written first by the next pass, which is blocked until it is saved. */
  private unsaved: MemoryState | undefined;
  /** Highest known `usageLimitUntil` (kept in memory even when state.json cannot be written; merged into every state write). */
  private limitUntil = 0;
  private readonly turnsSinceRun = new Map<string, number>();
  private prompt: string | undefined;

  constructor(private readonly opts: ExtractorOptions) {
    this.now = opts.now ?? Date.now;
    this.prompt = opts.systemPrompt;
  }

  /** Reads state.json once at Core start (creates it when missing, so new devices are read from now on). Never throws. */
  async init(): Promise<void> {
    try {
      await this.loadState();
    } catch (err) {
      // A failed write is already warned (the state stays in memory, the next pass retries it); a read error is not.
      if (!(err instanceof StateWriteError)) this.warn(`state.json unreadable (${err instanceof Error ? err.name : "error"})`);
    }
  }

  /** Counts a model turn of `device`; true when `everyTurns` turns were reached since its last pass. */
  noteModelTurn(device: string): boolean {
    const n = (this.turnsSinceRun.get(device) ?? 0) + 1;
    this.turnsSinceRun.set(device, n);
    return n >= (this.opts.everyTurns ?? 10);
  }

  /** A live turn hit the usage limit: passes are suspended until `until` (epoch ms). */
  async noteUsageLimit(until: number): Promise<void> {
    if (!(until > this.limitUntil)) return;
    this.limitUntil = until;
    // A running pass merges it into its own state write; otherwise persist it now
    // (holding `running`, so no pass writes an older state in between).
    if (this.running) return;
    this.running = true;
    try {
      await this.saveState(await this.loadState());
    } catch (err) {
      // The limit holds in memory and is written with the next state.
      if (!(err instanceof StateWriteError)) this.warn(`state.json unreadable (${err instanceof Error ? err.name : "error"})`);
    } finally {
      this.running = false;
    }
  }

  /** Runs one pass for `device` unless a skip rule applies. Never throws. */
  async maybeRun(device: string, reason: ExtractReason): Promise<ExtractResult> {
    if (this.running) return { status: "skipped", reason: "busy" };
    this.running = true;
    try {
      return await this.pass(device, reason);
    } catch (err) {
      if (err instanceof StateWriteError) return { status: "failed", reason: "write_failed" };
      this.warn(`extraction failed for ${device} (${err instanceof Error ? err.name : "error"})`);
      return { status: "failed", reason: "error" };
    } finally {
      this.running = false;
    }
  }

  // -------------------------------------------------------------- internals

  private async pass(device: string, reason: ExtractReason): Promise<ExtractResult> {
    const now = this.now();
    const state = await this.loadState();
    const today = dayStamp(new Date(now));
    if (state.day !== today) {
      state.day = today;
      state.runsToday = 0;
    }
    if (now < Math.max(state.usageLimitUntil, this.limitUntil)) return { status: "skipped", reason: "usage_limit" };
    if (state.runsToday >= (this.opts.maxRunsPerDay ?? 30)) return { status: "skipped", reason: "daily_cap" };
    const dev = (state.devices[device] ??= {
      cursorTs: Math.max(state.resetAt ?? -Infinity, now - NEW_DEVICE_LOOKBACK_MS),
      lastRunAt: 0,
      modelTurnsSinceRun: 0,
    });
    if (reason !== "compact" && now - dev.lastRunAt < (this.opts.minIntervalMs ?? 10 * 60_000)) {
      return { status: "skipped", reason: "too_soon" };
    }

    const { turns, lastTs } = await readDeviceTurns(this.opts.dataDir, device, dev.cursorTs, new Date(now));
    if (turns.filter((t) => t.user.trim() !== "").length < 2) return { status: "skipped", reason: "too_few_turns" };

    const redacted: FilterCounts = {};
    const conversation = this.buildConversation(
      turns.filter((t) => t.model),
      redacted,
    );
    if (conversation === "") {
      dev.cursorTs = lastTs;
      dev.failures = 0;
      await this.saveState(state);
      return { status: "skipped", reason: "nothing_to_learn" };
    }

    const existing = selectRelevant(conversation, await this.opts.store.entries(), {
      maxChars: EXISTING_MAX_CHARS,
      maxEntries: MEMORY_BUDGETS.entriesMax,
    });
    const res = await this.call(this.composePrompt(conversation, existing));
    this.recordUsage(res, this.now() - now);

    if (res.status === "usage_limit") {
      this.limitUntil = Math.max(this.limitUntil, res.retryAt ?? now + (this.opts.usageLimitFallbackMs ?? 60 * 60_000));
      this.info(`extraction for ${device} hit the usage limit, suspended`);
      // A failed write throws StateWriteError (→ `write_failed`); the limit holds in memory either way.
      await this.saveState(state);
      return { status: "failed", reason: "usage_limit" };
    }
    if (res.status === "cancelled") return { status: "failed", reason: "cancelled" };

    state.runsToday++;
    dev.lastRunAt = now;
    dev.modelTurnsSinceRun = 0;
    this.turnsSinceRun.delete(device);

    const parsed = res.status === "ok" ? parseOps(res.json ?? tryJson(res.text)) : undefined;
    let failure: FailReason | undefined = res.status !== "ok" ? "error" : parsed ? undefined : "invalid_output";
    let applied: Omit<Extract<ExtractResult, { status: "done" }>, "status"> | undefined;
    if (parsed) {
      const last = turns[turns.length - 1] as LogTurn;
      const source: EntrySource = { by: "extract", device, sessionId: last.sessionId, turnId: last.id };
      const rejected = new Map<string, number>();
      if (parsed.invalid > 0) rejected.set("invalid_op", parsed.invalid);
      // Recovery record (see the header): written before anything is applied.
      state.pending = { device, fromTs: dev.cursorTs, toTs: lastTs };
      try {
        await this.saveState(state);
      } catch (err) {
        // Nothing applied: the state kept for the next pass must not claim it was.
        delete state.pending;
        throw err;
      }
      try {
        const r = await this.opts.store.transaction((tx) => applyOps(tx, parsed.ops, source, rejected));
        if (r.writeFailed) failure = "write_failed";
        applied = { added: r.added, updated: r.updated, deleted: r.deleted, rejected: [...rejected.values()].reduce((a, b) => a + b, 0) };
        this.info(
          `extraction for ${device} (${reason}): add=${r.added} update=${r.updated} delete=${r.deleted}` +
            countsSuffix(" rejected", Object.fromEntries(rejected)) +
            countsSuffix(" redacted", redacted),
        );
      } catch (err) {
        this.warn(`extraction for ${device}: store failed (${err instanceof Error ? err.name : "error"})`);
        failure = "write_failed";
      }
    }

    delete state.pending;
    const partial = failure === "write_failed" && applied !== undefined && applied.added + applied.updated + applied.deleted > 0;
    if (failure) {
      dev.failures = (dev.failures ?? 0) + 1;
      // A partly applied range is not retried either (a second call could rephrase and duplicate).
      if (dev.failures >= 2 || partial) {
        // No endless retries: the turns are given up.
        dev.cursorTs = lastTs;
        dev.failures = 0;
      }
      this.warn(`extraction for ${device} failed (${failure})${dev.failures === 0 ? ", turns skipped" : ""}`);
    } else {
      dev.cursorTs = lastTs;
      dev.failures = 0;
    }
    await this.saveState(state);
    if (failure) return { status: "failed", reason: failure };
    return { status: "done", ...(applied as NonNullable<typeof applied>) };
  }

  /** Redacted conversation of the model turns, newest `INPUT_MAX_CHARS` (whole turns, the newest one cut from the front if alone too long). */
  private buildConversation(turns: readonly LogTurn[], counts: FilterCounts): string {
    const blocks: string[] = [];
    for (const t of turns) {
      const r = redactTurn({ user: t.user, ...(t.assistant !== undefined ? { assistant: t.assistant } : {}), tools: t.tools });
      mergeFilterCounts(counts, r.counts);
      const lines: string[] = [];
      if (r.user.trim()) lines.push(`Kullanıcı: ${neutralize(r.user)}`);
      if (r.assistant?.trim()) lines.push(`Asistan: ${neutralize(r.assistant)}`);
      if (lines.length > 0) blocks.push(lines.join("\n"));
    }
    const kept: string[] = [];
    let chars = 0;
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i] as string;
      if (kept.length === 0 && b.length > INPUT_MAX_CHARS) {
        kept.push(b.slice(-INPUT_MAX_CHARS));
        break;
      }
      if (chars + b.length + 2 > INPUT_MAX_CHARS) break;
      kept.unshift(b);
      chars += b.length + 2;
    }
    return kept.join("\n\n");
  }

  private composePrompt(conversation: string, existing: readonly MemoryEntry[]): string {
    const rows = existing.map((e) => `- ${e.id} [${e.kind}] ${neutralize(e.text)}`);
    return [
      "Hafızadaki ilgili kayıtlar (veri):",
      "<kayitlar>",
      rows.length > 0 ? rows.join("\n") : "(yok)",
      "</kayitlar>",
      "",
      "Son konuşma (veri):",
      "<konusma>",
      conversation,
      "</konusma>",
      "",
      'Yalnızca {"ops": [...]} JSON nesnesini döndür.',
    ].join("\n");
  }

  private async call(prompt: string): Promise<OneShotResult> {
    try {
      return await this.opts.provider.oneShot({
        model: this.opts.model,
        system: this.systemPrompt(),
        prompt,
        schema: OPS_SCHEMA,
        maxTokens: this.opts.maxTokens ?? 800,
        ...(this.opts.signal ? { signal: this.opts.signal } : {}),
      });
    } catch (err) {
      return {
        status: "error",
        text: "",
        inputTokens: 0,
        outputTokens: 0,
        model: this.opts.model,
        error: err instanceof Error ? err.name : "error",
      };
    }
  }

  private systemPrompt(): string {
    this.prompt ??= readFileSync(PROMPT_FILE, "utf8");
    return this.prompt;
  }

  private recordUsage(res: OneShotResult, durationMs: number): void {
    if (res.status !== "ok" && res.status !== "error") return;
    if (res.inputTokens === 0 && res.outputTokens === 0 && res.costUsd === undefined) return;
    try {
      void this.opts.usage?.append({
        turnId: "memory-extract",
        model: res.model,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        durationMs: Math.max(0, durationMs),
        ...(res.costUsd !== undefined ? { costUsd: res.costUsd } : {}),
        outcome: res.status === "ok" ? "done" : "error",
      });
    } catch {
      // Usage records are best effort.
    }
  }

  /**
   * state.json, or a fresh one (written at once, with `resetAt` = now) when
   * missing or corrupt. A state whose earlier write failed is written first
   * and returned instead of the stale file. A leftover `pending` is resolved
   * (see the header) and saved. Throws `StateWriteError`, and passes a read
   * error of state.json through without writing anything.
   */
  private async loadState(): Promise<MemoryState> {
    if (this.unsaved) {
      const pending = this.unsaved;
      await this.saveState(pending);
      return pending;
    }
    // undefined = missing or corrupt (quarantined). A throw (EIO, EACCES) is not a reason to reset: it propagates.
    const state = await this.opts.store.readState();
    if (state) {
      if (state.pending) await this.resolvePending(state);
      return state;
    }
    const now = this.now();
    this.warn("state.json missing or corrupt, extraction starts from now");
    const fresh: MemoryState = { version: 1, devices: {}, day: dayStamp(new Date(now)), runsToday: 0, usageLimitUntil: 0, resetAt: now };
    await this.saveState(fresh);
    return fresh;
  }

  /** A pass stopped between applying ops and saving its cursor: its range counts as applied. */
  private async resolvePending(state: MemoryState): Promise<void> {
    const p = state.pending as NonNullable<MemoryState["pending"]>;
    delete state.pending;
    const dev = state.devices[p.device];
    if (dev && dev.cursorTs === p.fromTs) {
      dev.cursorTs = p.toTs;
      dev.failures = 0;
      this.warn(`an extraction for ${p.device} stopped after applying, its turns are not read again`);
    }
    await this.saveState(state);
  }

  /** Writes state.json; on failure keeps `state` for the next pass and throws `StateWriteError`. */
  private async saveState(state: MemoryState): Promise<void> {
    state.usageLimitUntil = Math.max(state.usageLimitUntil, this.limitUntil);
    this.limitUntil = state.usageLimitUntil;
    try {
      await this.opts.store.writeState(state);
      this.unsaved = undefined;
    } catch (err) {
      this.unsaved = state;
      this.warn(`state.json write failed (${err instanceof Error ? err.name : "error"}), passes paused until it is saved`);
      throw new StateWriteError();
    }
  }

  private info(msg: string): void {
    this.opts.logger?.info(`[shadow-core] memory: ${msg}`);
  }

  private warn(msg: string): void {
    this.opts.logger?.warn(`[shadow-core] memory: ${msg}`);
  }
}

class StateWriteError extends Error {
  override name = "StateWriteError";
}

interface ApplyResult {
  added: number;
  updated: number;
  deleted: number;
  writeFailed: boolean;
}

/** Applies validated ops inside one store transaction. Rejections are counted by reason in `rejected`. */
export async function applyOps(
  tx: MemoryTx,
  ops: readonly MemoryOp[],
  source: EntrySource,
  rejected: Map<string, number>,
): Promise<ApplyResult> {
  const out: ApplyResult = { added: 0, updated: 0, deleted: 0, writeFailed: false };
  const reject = (reason: string) => {
    rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
    if (reason === "write_failed") out.writeFailed = true;
  };
  let deletes = 0;
  for (const op of ops) {
    if (op.op === "delete") {
      if (deletes >= MAX_DELETES) {
        reject("delete_cap");
        continue;
      }
      deletes++;
      const r = await tx.remove([op.id]);
      if (!r.ok) reject(r.reason ?? "write_failed");
      else if (r.removed.length === 0) reject("not_found");
      else out.deleted++;
      continue;
    }
    if (op.text !== undefined) {
      const why = rejectReason(op.text);
      if (why) {
        reject(why);
        continue;
      }
      if (await tx.isForgotten(op.text)) {
        reject("tombstone");
        continue;
      }
    }
    if (op.op === "update") {
      const r = await tx.update(op.id, {
        ...(op.text !== undefined ? { text: op.text } : {}),
        ...(op.keywords && op.keywords.length > 0 ? { keywords: op.keywords } : {}),
        source,
      });
      if (r.ok) out.updated++;
      else reject(r.reason);
      continue;
    }
    // add: drop exact duplicates, merge into a similar entry of the same kind, else append.
    const entries = await tx.entries();
    const hash = textHash(op.text);
    if (entries.some((e) => e.hash === hash)) {
      reject("duplicate");
      continue;
    }
    const target = mergeTarget(entries, op.kind, op.text);
    const r = target
      ? await tx.update(target.id, { text: op.text, ...(op.keywords.length > 0 ? { keywords: op.keywords } : {}), source })
      : await tx.add({ kind: op.kind, text: op.text, keywords: op.keywords, source });
    if (!r.ok) reject(r.reason);
    else if (target) out.updated++;
    else out.added++;
  }
  return out;
}

function countsSuffix(label: string, counts: FilterCounts | Record<string, number>): string {
  const s = formatFilterCounts(counts as FilterCounts);
  return s ? `${label}(${s})` : "";
}

/** Angle brackets replaced so data cannot close the prompt's tags. */
function neutralize(text: string): string {
  return text.replace(/</g, "‹").replace(/>/g, "›");
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
