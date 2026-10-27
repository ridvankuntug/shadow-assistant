/**
 * Usage records: append-only JSONL, one file per local day under
 * `<SHADOW_DATA_DIR>/usage/YYYY-MM-DD.jsonl`.
 *
 * The data dir usually lives inside a git repository, so before the first
 * write the Core puts a `.gitignore` containing `*` into the `usage` folder
 * (never overwriting an existing one): the folder ignores itself.
 * Only whitelisted fields are written, so nothing unexpected can leak.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dayStamp } from "./conversation-log.js";
import type { UsageRecord } from "./router.js";

const SELF_IGNORE = "# Created by Shadow Assistant Core: this folder holds private runtime data.\n*\n";

const count = (n: number): number => (Number.isFinite(n) ? n : 0);
const optCount = (n: number | undefined): number | undefined => (n === undefined ? undefined : count(n));

export class UsageLog {
  private queue: Promise<void> = Promise.resolve();
  private ready: Promise<void> | undefined;

  constructor(
    readonly dataDir: string,
    private readonly now: () => Date = () => new Date(),
    private readonly warn: (msg: string) => void = (m) => console.warn(m),
  ) {}

  private ensureDir(): Promise<void> {
    const dir = join(this.dataDir, "usage");
    this.ready ??= (async () => {
      await mkdir(dir, { recursive: true });
      // `wx`: never overwrite a .gitignore the user may have edited.
      await writeFile(join(dir, ".gitignore"), SELF_IGNORE, { flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "EEXIST") throw err;
      });
    })();
    // Retry on the next append if setup failed.
    this.ready.catch(() => {
      this.ready = undefined;
    });
    return this.ready;
  }

  /** Appends one record. Writes are serialized; failures are warned, never thrown. */
  append(record: UsageRecord): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        const at = this.now();
        const line = `${JSON.stringify({
          ts: at.getTime(),
          sessionId: record.sessionId,
          turnId: record.turnId,
          tier: record.tier,
          model: record.model,
          inputTokens: count(record.inputTokens),
          outputTokens: count(record.outputTokens),
          cacheReadTokens: optCount(record.cacheReadTokens),
          cacheWriteTokens: optCount(record.cacheWriteTokens),
          costUsd: record.costUsd !== undefined && Number.isFinite(record.costUsd) ? record.costUsd : undefined,
          durationMs: count(record.durationMs),
          services: record.services,
          tools: record.tools,
          outcome: record.outcome,
        })}\n`;
        await this.ensureDir();
        await appendFile(join(this.dataDir, "usage", `${dayStamp(at)}.jsonl`), line, "utf8");
      })
      .catch((err: Error) => this.warn(`[shadow-core] usage log write failed: ${err.message}`));
    return this.queue;
  }

  /** Resolves when all queued writes finished. */
  flush(): Promise<void> {
    return this.queue;
  }
}
