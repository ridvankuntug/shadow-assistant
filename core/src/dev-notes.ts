/**
 * Development notes about the tools the gateway mirrors (T7.y): the narrow
 * store until the "Development" tab exists (T7.w). One JSON file,
 * `<SHADOW_DATA_DIR>/dev-notes/tools.json`:
 *
 *   {
 *     "version": 1,
 *     "catalog": { "<service>": ["<tool>", …] },   // last tool list seen
 *     "notes": [ { kind, service, tool, level?, count, firstSeen, lastSeen } ]
 *   }
 *
 * Note kinds (one note per kind + service + tool; repeats only bump `count`
 * and `lastSeen`, at most once per `touchMs`, so the file does not grow):
 *   - `new_tool`       "new tool: classify" — listed, but no services.yaml rule names it
 *                      (it runs at `confirm` until classified)
 *   - `tool_added`     appeared since the previous list (not on the first list)
 *   - `tool_removed`   was in the previous list, gone now (a rename shows as removed + added)
 *   - `rule_unmatched` an exact services.yaml rule names a tool the service does not list
 *
 * Only tool names and levels are stored: no arguments, results, URLs or tokens.
 * No UI, push or notification reads this yet.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { readJsonOrQuarantine, writeFileAtomic } from "./atomic-file.js";

export type DevNoteKind = "new_tool" | "tool_added" | "tool_removed" | "rule_unmatched";

export interface DevNote {
  kind: DevNoteKind;
  service: string;
  tool: string;
  /** Short Turkish text for the future Development tab. */
  message: string;
  /** Permission level a plain call gets (new_tool / tool_added). */
  level?: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface DevNotesFile {
  version: 1;
  catalog: Record<string, string[]>;
  notes: DevNote[];
}

/** One tool of a fresh list, as the policy classifies it. */
export interface CatalogEntry {
  name: string;
  classified: boolean;
  level: string;
}

export const DEV_NOTES_FILE = "tools.json";
/** A repeated observation updates `count`/`lastSeen` at most this often. */
export const DEFAULT_TOUCH_MS = 60 * 60_000;
/** Hard cap so a service with a huge or churning tool list cannot grow the file without bound. */
export const MAX_NOTES = 500;

const MESSAGES: Record<DevNoteKind, string> = {
  new_tool: "yeni araç: sınıflandır",
  tool_added: "araç eklendi",
  tool_removed: "araç kayboldu (adı değişmiş olabilir)",
  rule_unmatched: "services.yaml kuralındaki araç listede yok (adı değişmiş olabilir)",
};

export interface DevNotesOptions {
  /** `<SHADOW_DATA_DIR>/dev-notes`. */
  dir: string;
  now?: () => number;
  touchMs?: number;
  log?: (msg: string) => void;
}

export class DevNotes {
  readonly file: string;
  private readonly now: () => number;
  private readonly touchMs: number;
  private data: DevNotesFile | undefined;
  /** Serializes load + update + write. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: DevNotesOptions) {
    this.file = join(o.dir, DEV_NOTES_FILE);
    this.now = o.now ?? Date.now;
    this.touchMs = o.touchMs ?? DEFAULT_TOUCH_MS;
  }

  /**
   * Records one successful tool list of `service`. `exactRules` are the
   * services.yaml exact rule names of the service. Never throws; the
   * returned promise settles once the file is written (or the write failed).
   */
  recordCatalog(service: string, tools: readonly CatalogEntry[], exactRules: readonly string[] = []): Promise<void> {
    const run = this.chain.then(() => this.apply(service, tools, exactRules));
    this.chain = run.catch(() => {});
    return run.catch((err: unknown) => this.o.log?.(`[shadow-core] dev-notes write failed: ${(err as Error)?.message ?? String(err)}`));
  }

  /** Current contents (for tests and the future Development tab). */
  async read(): Promise<DevNotesFile> {
    await this.chain;
    return structuredClone(await this.load());
  }

  private async load(): Promise<DevNotesFile> {
    if (!this.data) {
      const loaded = await readJsonOrQuarantine(this.file, validateFile, {
        onQuarantine: () => this.o.log?.("[shadow-core] dev-notes file was invalid and was moved aside"),
      });
      this.data = loaded ?? { version: 1, catalog: {}, notes: [] };
    }
    return this.data;
  }

  private async apply(service: string, tools: readonly CatalogEntry[], exactRules: readonly string[]): Promise<void> {
    const data = await this.load();
    const nowMs = this.now();
    const stamp = new Date(nowMs).toISOString();
    let dirty = false;
    const observe = (kind: DevNoteKind, tool: string, level?: string) => {
      const existing = data.notes.find((n) => n.kind === kind && n.service === service && n.tool === tool);
      if (existing) {
        if (level !== undefined && existing.level !== level) {
          existing.level = level;
          dirty = true;
        }
        if (nowMs - Date.parse(existing.lastSeen) >= this.touchMs) {
          existing.count++;
          existing.lastSeen = stamp;
          dirty = true;
        }
        return;
      }
      data.notes.push({
        kind,
        service,
        tool,
        message: MESSAGES[kind],
        ...(level !== undefined ? { level } : {}),
        count: 1,
        firstSeen: stamp,
        lastSeen: stamp,
      });
      dirty = true;
    };

    const names = new Set(tools.map((t) => t.name));
    const previous = data.catalog[service];
    for (const t of tools) {
      if (!t.classified) observe("new_tool", t.name, t.level);
      if (previous && !previous.includes(t.name)) observe("tool_added", t.name, t.level);
    }
    for (const old of previous ?? []) if (!names.has(old)) observe("tool_removed", old);
    for (const rule of exactRules) if (!names.has(rule)) observe("rule_unmatched", rule);

    const sorted = [...names].sort();
    if (!previous || previous.length !== sorted.length || previous.some((n, i) => n !== sorted[i])) {
      data.catalog[service] = sorted;
      dirty = true;
    }
    if (data.notes.length > MAX_NOTES) {
      // Keep the most recently seen notes.
      data.notes.sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen));
      data.notes.length = MAX_NOTES;
      dirty = true;
    }
    if (!dirty) return;
    await mkdir(this.o.dir, { recursive: true });
    await writeFileAtomic(this.file, `${JSON.stringify(data, null, 2)}\n`);
  }
}

function validateFile(v: unknown): DevNotesFile | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (o.version !== 1 || typeof o.catalog !== "object" || o.catalog === null || !Array.isArray(o.notes)) return undefined;
  const catalog: Record<string, string[]> = {};
  for (const [k, list] of Object.entries(o.catalog as Record<string, unknown>)) {
    if (Array.isArray(list)) catalog[k] = list.filter((x): x is string => typeof x === "string");
  }
  const notes = (o.notes as unknown[]).filter(
    (n): n is DevNote =>
      typeof n === "object" &&
      n !== null &&
      typeof (n as DevNote).kind === "string" &&
      typeof (n as DevNote).service === "string" &&
      typeof (n as DevNote).tool === "string" &&
      typeof (n as DevNote).count === "number" &&
      typeof (n as DevNote).firstSeen === "string" &&
      typeof (n as DevNote).lastSeen === "string",
  );
  return { version: 1, catalog, notes };
}
