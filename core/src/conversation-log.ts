/**
 * Conversation records: one JSONL file per WebSocket session under
 * `<SHADOW_DATA_DIR>/conversations/YYYY-MM-DD/<sessionId>.jsonl`.
 *
 * The data dir usually lives inside the user's vault (a git repository whose
 * own .gitignore we must not edit), so on creation the Core writes a
 * `.gitignore` containing `*` into the data dir itself: the folder ignores
 * itself and everything in it.
 */
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HistoryItem } from "./protocol.js";

export type LogEntry =
  | { kind: "session_start"; device: string; client?: string; clientVersion?: string }
  | { kind: "session_end"; reason: string }
  | { kind: "user"; id: string; text: string; source: "text" | "voice" }
  | { kind: "assistant"; id: string; text: string; cancelled?: boolean }
  | { kind: "tool_call"; id: string; tool: string; level: string; reason: string; input: unknown }
  | { kind: "tool_result"; id: string; tool: string; status: "done" | "error" }
  | {
      kind: "permission";
      id: string;
      tool: string;
      decision: "allow" | "deny";
      level: string;
      by?: string;
      requestId?: string;
    }
  | {
      kind: "usage";
      id: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      durationMs: number;
      costUsd?: number;
    }
  | { kind: "error"; id?: string; code: string; message: string };

export type StoredEntry = LogEntry & { ts: number; sessionId: string };

const SELF_IGNORE = "# Created by Shadow Assistant Core: this folder holds private runtime data.\n*\n";
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Local calendar date `YYYY-MM-DD`. */
export function dayStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class ConversationLog {
  private ready: Promise<void> | undefined;

  constructor(
    readonly dataDir: string,
    private readonly now: () => Date = () => new Date(),
    private readonly warn: (msg: string) => void = (m) => console.warn(m),
  ) {}

  /** Creates the data dir and its self-ignoring .gitignore (idempotent). */
  ensureDir(): Promise<void> {
    this.ready ??= (async () => {
      await mkdir(join(this.dataDir, "conversations"), { recursive: true });
      // `wx`: never overwrite a .gitignore the user may have edited.
      await writeFile(join(this.dataDir, ".gitignore"), SELF_IGNORE, { flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") throw err;
      });
    })();
    return this.ready;
  }

  session(sessionId: string): SessionLog {
    if (!SESSION_ID_RE.test(sessionId)) throw new Error("invalid session id");
    const file = join(this.dataDir, "conversations", dayStamp(this.now()), `${sessionId}.jsonl`);
    return new SessionLog(this, sessionId, file, this.now, this.warn);
  }

  /**
   * Most recent user/assistant messages across all sessions (newest last).
   * Scans the newest day folders until `limit` items are collected.
   */
  async history(limit: number, maxDays = 14): Promise<HistoryItem[]> {
    const root = join(this.dataDir, "conversations");
    let days: string[];
    try {
      days = (await readdir(root)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().reverse().slice(0, maxDays);
    } catch {
      return [];
    }
    const items: HistoryItem[] = [];
    // A session spanning midnight keeps writing into its start-day folder, so
    // read one more (older) folder after the limit is reached.
    let extra = 1;
    for (const day of days) {
      const files = (await readdir(join(root, day)).catch(() => [] as string[])).filter((f) => f.endsWith(".jsonl"));
      for (const f of files) {
        const text = await readFile(join(root, day, f), "utf8").catch(() => "");
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const e = JSON.parse(line) as StoredEntry;
            if ((e.kind === "user" || e.kind === "assistant") && typeof e.text === "string" && e.text !== "") {
              items.push({ id: e.id, role: e.kind, text: e.text, ts: e.ts });
            }
          } catch {
            // A torn last line (crash mid-write) is skipped.
          }
        }
      }
      if (items.length >= limit && extra-- <= 0) break;
    }
    items.sort((a, b) => a.ts - b.ts);
    return items.slice(-limit);
  }
}

export class SessionLog {
  private queue: Promise<void> = Promise.resolve();
  private dirMade = false;

  constructor(
    private readonly log: ConversationLog,
    readonly sessionId: string,
    readonly file: string,
    private readonly now: () => Date,
    private readonly warn: (msg: string) => void,
  ) {}

  /** Appends one entry. Writes are serialized; failures are warned, never thrown. */
  append(entry: LogEntry): Promise<void> {
    const line = `${JSON.stringify({ ts: this.now().getTime(), sessionId: this.sessionId, ...entry })}\n`;
    this.queue = this.queue
      .then(async () => {
        await this.log.ensureDir();
        if (!this.dirMade) {
          await mkdir(join(this.file, ".."), { recursive: true });
          this.dirMade = true;
        }
        await appendFile(this.file, line, "utf8");
      })
      .catch((err: Error) => this.warn(`[shadow-core] conversation log write failed: ${err.message}`));
    return this.queue;
  }

  /** Resolves when all queued writes finished. */
  flush(): Promise<void> {
    return this.queue;
  }
}
