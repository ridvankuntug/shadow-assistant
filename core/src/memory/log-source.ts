/**
 * Extractor input (docs/06-memory.md §Automatic extraction → Input, task M4):
 * one device's turns from the Core's own conversation logs
 * (`<dataDir>/conversations/YYYY-MM-DD/*.jsonl`), never from a provider
 * transcript. Read-only; the log format is conversation-log.ts.
 *
 * - A file belongs to a device by its `session_start` entry.
 * - Candidate files: every file in the day folders of the last
 *   `SCAN_MAX_DAYS` days whose mtime is not older than the cursor. A session
 *   open past midnight keeps writing into its start-day folder, so the folder
 *   date alone does not tell whether a file has new entries.
 * - Entries are grouped by turn id over the whole file (so a turn's tools and
 *   routing are known even when some of its entries are older than the
 *   cursor). A turn is returned when it is complete and has a content entry
 *   (user, assistant, tool call, route) newer than `afterTs`.
 * - Complete: it has an `assistant` or `error` entry, or its newest entry is
 *   older than `TURN_STALE_MS` (a crashed turn must not hold the cursor
 *   forever). An incomplete turn is left out and the cursor stops before its
 *   first entry, so the next pass sees the whole turn (with its tool calls,
 *   which the vault filter needs).
 * - `lastTs`: the newest entry after `afterTs` (any kind), capped before the
 *   first entry of the oldest incomplete turn; the cursor value after a
 *   successful pass.
 * - Only a missing folder/file (ENOENT) counts as empty; any other read error
 *   is thrown, so the pass fails and the cursor stays.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { dayStamp, type StoredEntry } from "../conversation-log.js";

/** Day folders older than this are not scanned (bounds the work; the extractor reads 24 h back at most for new devices). */
export const SCAN_MAX_DAYS = 14;
/** A turn without an answer this old counts as finished (crash, lost write). */
export const TURN_STALE_MS = 30 * 60_000;
/** File mtime slack (coarse file-system timestamps). */
const MTIME_SLACK_MS = 2000;

export interface LogTurn {
  id: string;
  sessionId: string;
  /** Newest content entry of the turn. */
  ts: number;
  /** "" when the turn has no user entry. */
  user: string;
  assistant?: string;
  /** Full tool names (`mcp__<server>__<tool>`) called in the turn. */
  tools: string[];
  /** False when every routing decision was tier 0 (no model call). A turn without a `route` entry counts as a model turn. */
  model: boolean;
}

export interface DeviceTurns {
  /** Oldest first. */
  turns: LogTurn[];
  /** Cursor after a successful pass (see the module comment); `afterTs` when nothing new. */
  lastTs: number;
}

interface TurnAcc extends LogTurn {
  routes: number[];
  /** Oldest and newest entry of any kind. */
  first: number;
  newest: number;
  done: boolean;
}

/** Complete turns of `device` with content newer than `afterTs`. Throws on read errors other than ENOENT. */
export async function readDeviceTurns(dataDir: string, device: string, afterTs: number, now: Date): Promise<DeviceTurns> {
  const turns = new Map<string, TurnAcc>();
  let lastTs = afterTs;
  for (const file of await candidateFiles(join(dataDir, "conversations"), afterTs, now)) {
    const text = await orEnoent(readFile(file, "utf8"), "");
    const entries = parseLines(text);
    const start = entries.find((e) => e.kind === "session_start");
    if (!start || start.kind !== "session_start" || start.device !== device) continue;
    for (const e of entries) {
      if (e.ts > afterTs && e.ts > lastTs) lastTs = e.ts;
      if (!("id" in e) || typeof e.id !== "string") continue;
      const key = `${e.sessionId}\u0000${e.id}`;
      let t = turns.get(key);
      if (!t) {
        t = { id: e.id, sessionId: e.sessionId, ts: -Infinity, user: "", tools: [], model: true, routes: [], first: e.ts, newest: e.ts, done: false };
        turns.set(key, t);
      }
      t.first = Math.min(t.first, e.ts);
      t.newest = Math.max(t.newest, e.ts);
      switch (e.kind) {
        case "user":
          if (typeof e.text === "string") t.user = e.text;
          break;
        case "assistant":
          t.done = true;
          if (typeof e.text === "string" && e.text !== "") t.assistant = e.text;
          break;
        case "tool_call":
          if (typeof e.tool === "string") t.tools.push(e.tool);
          break;
        case "route":
          if (typeof e.tier === "number") t.routes.push(e.tier);
          break;
        case "error":
          t.done = true;
          continue;
        default:
          continue;
      }
      if (e.ts > t.ts) t.ts = e.ts;
    }
  }
  const out: LogTurn[] = [];
  for (const { routes, first, newest, done, ...t } of turns.values()) {
    const complete = done || now.getTime() - newest >= TURN_STALE_MS;
    if (!complete) {
      // Only an unfinished turn with entries past the cursor can hold it back.
      if (newest > afterTs) lastTs = Math.min(lastTs, Math.max(afterTs, first - 1));
      continue;
    }
    if (t.ts > afterTs) out.push({ ...t, model: routes.length === 0 || routes.some((r) => r !== 0) });
  }
  // Turns past a cursor held back by an incomplete turn are left for the next pass (no double processing).
  return { turns: out.filter((t) => t.ts <= lastTs).sort((a, b) => a.ts - b.ts), lastTs };
}

/** `.jsonl` files in the last `SCAN_MAX_DAYS` day folders modified at or after the cursor. */
async function candidateFiles(root: string, afterTs: number, now: Date): Promise<string[]> {
  const oldest = new Date(now);
  oldest.setDate(oldest.getDate() - SCAN_MAX_DAYS);
  const minDay = dayStamp(oldest);
  const days = (await orEnoent(readdir(root), [] as string[]))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= minDay)
    .sort();
  const out: string[] = [];
  for (const day of days) {
    const files = (await orEnoent(readdir(join(root, day)), [] as string[])).filter((f) => f.endsWith(".jsonl")).sort();
    for (const f of files) {
      const path = join(root, day, f);
      const st = await orEnoent(stat(path), undefined);
      if (st && st.mtimeMs + MTIME_SLACK_MS > afterTs) out.push(path);
    }
  }
  return out;
}

/** Resolves `fallback` for a missing path; rethrows every other error. */
async function orEnoent<T, F>(p: Promise<T>, fallback: F): Promise<T | F> {
  try {
    return await p;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

function parseLines(text: string): StoredEntry[] {
  const out: StoredEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as StoredEntry;
      if (e && typeof e === "object" && typeof e.kind === "string" && typeof e.ts === "number") out.push(e);
    } catch {
      // A torn last line (crash mid-write) is skipped.
    }
  }
  return out;
}
