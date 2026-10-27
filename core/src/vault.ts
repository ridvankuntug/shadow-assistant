/**
 * Read-only access to selected notes of the Shadow vault, exposed to the model
 * as an in-process SDK MCP server (`shadow-vault`: `list_notes`, `read_note`).
 *
 * Guarantees (enforced on the resolved real path, so symlinks cannot escape):
 *   - only paths inside SHADOW_VAULT_DIR
 *   - only `.md` files matching the configured allowlist globs
 *   - never a `Private` path segment (any case, any depth) or a dot-segment
 *     (`.git`, `.obsidian`, `.shadow-assistant`, …)
 *   - at most `maxBytes` bytes are returned per note
 */
import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { matchGlob } from "./glob.js";

export const DEFAULT_MAX_BYTES = 64 * 1024;
const MAX_LIST_ENTRIES = 300;
const MAX_WALK_ENTRIES = 20_000;

export class VaultAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultAccessError";
  }
}

export interface VaultOptions {
  root: string;
  allow: readonly string[];
  maxBytes?: number;
}

function toPosix(p: string): string {
  return p.split(sep).join("/").replace(/\\/g, "/");
}

const ignoreCase = process.platform === "win32" || process.platform === "darwin";

/** Segment-level checks shared by request paths and resolved paths. */
function forbiddenSegment(rel: string): string | null {
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === "." || seg === "..") return "invalid path segment";
    if (seg.startsWith(".")) return "hidden files and folders are not readable";
    // ':' would address an NTFS alternate data stream (a.txt:x.md) or a drive.
    if (seg.includes(":")) return "invalid character in path";
    if (seg.toLowerCase() === "private") return "Private notes are never readable";
  }
  return null;
}

export class VaultReader {
  readonly maxBytes: number;
  private realRoot: Promise<string> | undefined;

  constructor(private readonly opts: VaultOptions) {
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  private root(): Promise<string> {
    this.realRoot ??= realpath(this.opts.root);
    return this.realRoot;
  }

  isAllowed(rel: string): boolean {
    return this.opts.allow.some((g) => matchGlob(g, rel, ignoreCase));
  }

  /** Validates a model-supplied path and returns the vault-relative real path. */
  async resolve(requested: string): Promise<{ abs: string; rel: string }> {
    if (typeof requested !== "string" || requested.trim() === "" || requested.includes("\0")) {
      throw new VaultAccessError("path is required");
    }
    const cleaned = requested.trim().replace(/\\/g, "/").replace(/^\.\/+/, "");
    if (isAbsolute(cleaned) || cleaned.startsWith("/") || /^[A-Za-z]:/.test(cleaned)) {
      throw new VaultAccessError("path must be relative to the vault");
    }
    const bad = forbiddenSegment(cleaned);
    if (bad) throw new VaultAccessError(bad);
    if (!cleaned.toLowerCase().endsWith(".md")) throw new VaultAccessError("only .md notes are readable");
    if (!this.isAllowed(cleaned)) throw new VaultAccessError("note is outside the allowed folders");

    const root = await this.root();
    let real: string;
    try {
      real = await realpath(join(root, cleaned));
    } catch {
      throw new VaultAccessError("note not found");
    }
    const relReal = relative(root, real);
    if (relReal === "" || relReal.startsWith("..") || isAbsolute(relReal)) {
      throw new VaultAccessError("path escapes the vault");
    }
    const relPosix = toPosix(relReal);
    // Re-check on the resolved path: a symlink inside an allowed folder must
    // not lead to Private/, a dot-folder or a non-allowed note.
    const badReal = forbiddenSegment(relPosix);
    if (badReal) throw new VaultAccessError(badReal);
    if (!relPosix.toLowerCase().endsWith(".md") || !this.isAllowed(relPosix)) {
      throw new VaultAccessError("note is outside the allowed folders");
    }
    return { abs: real, rel: relPosix };
  }

  async read(requested: string): Promise<{ path: string; text: string; truncated: boolean; size: number }> {
    const { abs, rel } = await this.resolve(requested);
    const st = await stat(abs);
    if (!st.isFile()) throw new VaultAccessError("not a file");
    const fh = await open(abs, "r");
    try {
      const len = Math.min(st.size, this.maxBytes);
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, 0);
      let text = buf.subarray(0, bytesRead).toString("utf8");
      const truncated = st.size > this.maxBytes;
      // Drop a possibly cut multi-byte character at the end.
      if (truncated) text = text.replace(/�+$/, "");
      return { path: rel, text, truncated, size: st.size };
    } finally {
      await fh.close();
    }
  }

  /** Lists allowed notes, optionally below `folder`. Does not follow symlinks. */
  async list(folder?: string): Promise<{ notes: string[]; truncated: boolean }> {
    let prefix = "";
    if (folder !== undefined && folder.trim() !== "") {
      prefix = folder.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
      if (isAbsolute(prefix) || /^[A-Za-z]:/.test(prefix)) throw new VaultAccessError("folder must be relative");
      const bad = forbiddenSegment(prefix);
      if (bad) throw new VaultAccessError(bad);
    }
    const root = await this.root();
    const notes: string[] = [];
    let visited = 0;
    let truncated = false;

    const starts = new Set<string>();
    for (const g of this.opts.allow) {
      // Walk only from the literal prefix of each glob.
      const literal: string[] = [];
      for (const seg of g.split("/")) {
        if (/[*?]/.test(seg)) break;
        literal.push(seg);
      }
      if (literal.length === g.split("/").length) literal.pop(); // exact file
      starts.add(literal.join("/"));
    }

    const walk = async (relDir: string): Promise<void> => {
      if (truncated) return;
      let entries;
      try {
        entries = await readdir(relDir ? join(root, relDir) : root, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (++visited > MAX_WALK_ENTRIES || notes.length >= MAX_LIST_ENTRIES) {
          truncated = true;
          return;
        }
        const rel = relDir ? `${relDir}/${e.name}` : e.name;
        if (e.isSymbolicLink() || forbiddenSegment(rel)) continue;
        if (e.isDirectory()) await walk(rel);
        else if (e.isFile() && e.name.toLowerCase().endsWith(".md") && this.isAllowed(rel)) {
          if (!prefix || rel === prefix || rel.startsWith(`${prefix}/`)) notes.push(rel);
        }
      }
    };

    const seen = new Set<string>();
    for (const s of [...starts].sort()) {
      // Skip starts nested in an already walked start.
      if ([...seen].some((p) => p === "" || s === p || s.startsWith(`${p}/`))) continue;
      if (s !== "" && forbiddenSegment(s)) continue;
      // The start folder must not be (or sit below) a symlink/junction: its
      // resolved path has to equal the requested one.
      if (s !== "") {
        let real: string;
        try {
          real = await realpath(join(root, s));
        } catch {
          continue;
        }
        const relReal = toPosix(relative(root, real));
        if (ignoreCase ? relReal.toLowerCase() !== s.toLowerCase() : relReal !== s) continue;
      }
      seen.add(s);
      await walk(s);
    }
    notes.sort();
    return { notes, truncated };
  }
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

export const VAULT_SERVER_NAME = "shadow-vault";

export function createVaultMcpServer(reader: VaultReader, name = VAULT_SERVER_NAME): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name,
    version: "1.0.0",
    alwaysLoad: true,
    tools: [
      tool(
        "list_notes",
        "Shadow vault'unda okunmasına izin verilen notları listeler (salt okuma).",
        { folder: z.string().max(300).optional().describe("İsteğe bağlı alt klasör, vault köküne göre") },
        async ({ folder }) => {
          try {
            const { notes, truncated } = await reader.list(folder);
            const body = notes.length > 0 ? notes.join("\n") : "(izinli not yok)";
            return textResult(truncated ? `${body}\n(liste kısaltıldı)` : body);
          } catch (err) {
            return textResult(err instanceof VaultAccessError ? err.message : "listing failed", true);
          }
        },
        { annotations: { readOnlyHint: true } },
      ),
      tool(
        "read_note",
        "Shadow vault'undan izinli bir notu okur (salt okuma, boyut sınırlı).",
        { path: z.string().min(1).max(500).describe("Notun vault köküne göre yolu, ör. knowledge/konu.md") },
        async ({ path }) => {
          try {
            const r = await reader.read(path);
            const tail = r.truncated ? `\n\n[not ${reader.maxBytes} bayttan sonra kesildi]` : "";
            return textResult(`# ${r.path}\n\n${r.text}${tail}`);
          } catch (err) {
            return textResult(err instanceof VaultAccessError ? err.message : "read failed", true);
          }
        },
        { annotations: { readOnlyHint: true } },
      ),
    ],
  });
}
