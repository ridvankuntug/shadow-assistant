/**
 * TTS pronunciation lexicon (repo-root `pronunciations.yaml`).
 *
 * Rewrites words the Turkish Piper voices mispronounce into a spelling they
 * read correctly ("Shadow" → "Şadov") — applied only to the text sent for
 * synthesis, never to displayed, logged or stored text.
 *
 * Matching rules:
 *   - whole words only: a key matches when it is neither preceded nor followed
 *     by a word character (any Unicode letter, combining mark, digit or `_`,
 *     so ç ğ ı İ ö ş ü are word characters). "Shadowlar" is NOT rewritten
 *     unless "Shadowlar" itself is a key;
 *   - an apostrophe is not a word character, so a Turkish suffix after `'` or
 *     `’` is kept: "Shadow'u" → "Şadov'u", "Shadow’a" → "Şadov’a";
 *   - case-insensitive under both Turkish and default casing (I/ı/İ/i are
 *     treated as the same letter); the replacement is inserted as written,
 *     so "SHADOW" → "Şadov";
 *   - a key may hold several words; any run of whitespace in the text matches
 *     the space(s) between them;
 *   - leftmost match first; at the same position the longest key wins
 *     ("Shadow Asistan" before "Shadow").
 *
 * This module is pure (no I/O): the same entries and rules could later be
 * shipped to clients (e.g. Android native TTS) and applied there.
 */
import { parse as parseYaml } from "yaml";

export interface PronunciationEntry {
  /** Word or phrase as written, e.g. `Shadow`. */
  from: string;
  /** Spelling the TTS voice reads correctly, e.g. `Şadov`. */
  to: string;
}

export interface Lexicon {
  /** Entries in effect (after dropping invalid/duplicate ones). */
  readonly entries: readonly PronunciationEntry[];
  /** Text with every entry replaced; the input itself when nothing matches. */
  apply(text: string): string;
}

/** Characters that form words; the boundary check uses this class. */
const WORD_CHAR = "[\\p{L}\\p{M}\\p{N}_]";

function escapeRegex(s: string): string {
  // Only syntax characters and `/`: other identity escapes (e.g. `\-`) are errors under the `u` flag.
  return s.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

/** One character → a regex atom matching all its single-character case variants (Turkish + default). */
function caseInsensitiveChar(ch: string): string {
  const variants = new Set<string>([ch]);
  for (const v of [
    ch.toLocaleLowerCase("tr-TR"),
    ch.toLocaleUpperCase("tr-TR"),
    ch.toLowerCase(),
    ch.toUpperCase(),
  ]) {
    // Skip mappings that change length (e.g. "İ".toLowerCase() === "i̇", "ß" → "SS").
    if ([...v].length === 1) variants.add(v);
  }
  // I/ı/İ/i: one letter for matching purposes whatever casing the text uses.
  if (/^[iıIİ]$/u.test(ch)) for (const v of "iıIİ") variants.add(v);
  if (variants.size === 1) return escapeRegex(ch);
  return `(?:${[...variants].map(escapeRegex).join("|")})`;
}

function keyPattern(key: string): string {
  return key
    .split(/\s+/u)
    .map((word) => [...word].map(caseInsensitiveChar).join(""))
    .join("\\s+");
}

/** Normalized key: NFC, trimmed, inner whitespace collapsed. */
function normalizeKey(key: string): string {
  return key.normalize("NFC").trim().replace(/\s+/gu, " ");
}

/** Comparison form of a key, for duplicate detection. */
function foldKey(key: string): string {
  return key.toLocaleLowerCase("tr-TR").replace(/ı/g, "i");
}

/**
 * Builds a lexicon. Empty keys/values are dropped; when two keys differ only
 * in case, the first one wins. Problems are returned as warnings.
 */
export function compileLexicon(entries: Iterable<PronunciationEntry>): { lexicon: Lexicon; warnings: string[] } {
  const warnings: string[] = [];
  const kept: PronunciationEntry[] = [];
  const seen = new Set<string>();
  for (const e of entries) {
    const from = normalizeKey(e.from);
    const to = e.to.trim();
    if (from === "" || to === "") {
      warnings.push(`entry '${e.from}': key and value must be non-empty; ignored`);
      continue;
    }
    const folded = foldKey(from);
    if (seen.has(folded)) {
      warnings.push(`entry '${e.from}': duplicate key (case-insensitive); ignored`);
      continue;
    }
    seen.add(folded);
    kept.push({ from, to });
  }
  if (kept.length === 0) return { lexicon: EMPTY_LEXICON, warnings };

  // Longest key first: at a given position the alternation takes the first
  // alternative that matches, so this makes the longest key win.
  const ordered = [...kept].sort((a, b) => [...b.from].length - [...a.from].length);
  const re = new RegExp(
    `(?<!${WORD_CHAR})(?:${ordered.map((e) => `(${keyPattern(e.from)})`).join("|")})(?!${WORD_CHAR})`,
    "gu",
  );
  const lexicon: Lexicon = {
    entries: kept,
    apply(text: string): string {
      return text.replace(re, (...args: unknown[]) => {
        // args: match, group1..groupN, offset, input — exactly one group is set.
        for (let i = 0; i < ordered.length; i++) if (args[i + 1] !== undefined) return ordered[i]!.to;
        return args[0] as string;
      });
    },
  };
  return { lexicon, warnings };
}

export const EMPTY_LEXICON: Lexicon = Object.freeze({
  entries: Object.freeze([]) as readonly PronunciationEntry[],
  apply: (text: string) => text,
});

/** Thrown for a file that cannot be used at all (not YAML / not a mapping). */
export class PronunciationsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PronunciationsError";
  }
}

/**
 * Parses `pronunciations.yaml`: a flat mapping `word or phrase: spelling`.
 * An empty file (or only comments) is an empty lexicon. A file that is not
 * YAML or not a mapping throws PronunciationsError; single bad entries (a
 * non-string value, an empty key) are dropped with a warning.
 */
export function parsePronunciations(text: string): { lexicon: Lexicon; warnings: string[] } {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    throw new PronunciationsError(`not valid YAML: ${err instanceof Error ? err.message.split("\n")[0] : "parse error"}`);
  }
  if (data === null || data === undefined) return { lexicon: EMPTY_LEXICON, warnings: [] };
  if (typeof data !== "object" || Array.isArray(data)) {
    throw new PronunciationsError("top level must be a mapping of `word: spelling`");
  }
  const warnings: string[] = [];
  const entries: PronunciationEntry[] = [];
  for (const [from, to] of Object.entries(data as Record<string, unknown>)) {
    if (typeof to !== "string") {
      warnings.push(`entry '${from}': value must be a string; ignored`);
      continue;
    }
    entries.push({ from, to });
  }
  const compiled = compileLexicon(entries);
  return { lexicon: compiled.lexicon, warnings: [...warnings, ...compiled.warnings] };
}
