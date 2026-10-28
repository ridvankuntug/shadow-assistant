/**
 * Memory text helpers and the per-turn matcher (docs/06-memory.md §Loading
 * memory into a turn, task M3).
 *
 * Text helpers (also used by the store, M1):
 *   - `textHash`: `sha256:<16 hex>` of the folded, punctuation-free text; used
 *     for dedupe and tombstones;
 *   - `normalizeKeyword` / `deriveKeywords`: folded keywords, 1-6 per entry.
 *
 * Matching is cheap and model-free: the user text is cleaned and folded
 * (turkish.ts `cleanTurkish` + `fold`) and every word is expanded into its
 * stem candidates (`stemCandidates`). A keyword word matches a user word when
 * their candidate sets share a form, so "Otomodos'un", "otomodosun" and
 * "otomodos" all hit the keyword "otomodos", and "oturma odasında" hits
 * "oturma odası". Multi-word keywords must appear as a phrase (consecutive
 * words). Both sides are stemmed, so a keyword may be stored inflected.
 */
import { createHash } from "node:crypto";
import { cleanTurkish, fold, stemCandidates } from "../turkish.js";
import { MEMORY_BUDGETS } from "./types.js";

/** Folded, cleaned words of a text ("Otomodos'un ışığı" → ["otomodos", "isigi"]). */
export function foldedWords(text: string): string[] {
  return fold(cleanTurkish(text)).split(" ").filter(Boolean);
}

/** `sha256:<16 hex>` of the folded, punctuation-free text. Equal for "Işık %40." and "isik yuzde 40". */
export function textHash(text: string): string {
  const digest = createHash("sha256").update(foldedWords(text).join(" "), "utf8").digest("hex");
  return `sha256:${digest.slice(0, 16)}`;
}

const KEYWORD_MAX_CHARS = 40;
const KEYWORD_MAX_WORDS = 3;

/** Folded keyword, or undefined when it is empty, too long or more than three words. */
export function normalizeKeyword(keyword: string): string | undefined {
  const words = foldedWords(keyword);
  if (words.length === 0 || words.length > KEYWORD_MAX_WORDS) return undefined;
  const k = words.join(" ");
  if (k.length < 2 || k.length > KEYWORD_MAX_CHARS) return undefined;
  return k;
}

/** Folded function words that never make a useful keyword. */
const STOPWORDS = new Set([
  "ve", "ile", "bir", "bu", "su", "o", "de", "da", "ki", "icin", "gibi", "cok", "en", "daha", "ama", "veya",
  "ya", "mi", "mu", "ne", "her", "hep", "genelde", "genellikle", "olarak", "olan", "demek", "demektir",
  "yani", "kullanici", "kullanicinin", "kullaniciya", "kullaniciyi", "sever", "ister",
  "kullanir", "yapar", "eder", "olur", "dir", "dur", "tir", "tur", "the", "and", "is",
]);

/**
 * Keywords for an entry: the given ones (normalized, deduped) completed with
 * the text's own content words (≥ 3 letters, no stopwords, no pure numbers),
 * at most `max` in total.
 */
export function deriveKeywords(text: string, given: readonly string[] = [], max: number = MEMORY_BUDGETS.keywordsMax): string[] {
  const out: string[] = [];
  const add = (k: string | undefined) => {
    if (k !== undefined && out.length < max && !out.includes(k)) out.push(k);
  };
  for (const k of given) add(normalizeKeyword(k));
  for (const w of foldedWords(text)) {
    if (w.length < 3 || STOPWORDS.has(w) || /^\d+$/.test(w)) continue;
    // A word that already occurs in a keyword (same stem forms) adds nothing.
    const forms = wordForms(w);
    if (out.some((k) => k.split(" ").some((kw) => intersects(wordForms(kw), forms)))) continue;
    add(w);
  }
  return out;
}

/** Final consonant softened before a vowel suffix, after folding (ğ→g): mutfag → mutfak. */
const UNSOFTEN_FOLDED: Record<string, string> = { g: "k", b: "p", d: "t" };

const formsCache = new Map<string, ReadonlySet<string>>();

/** Shortest stem a second stripping step may produce (keeps short false hits out). */
const SECOND_STEM_MIN = 3;

/**
 * Stem forms of one folded word (cached; the vocabulary is small).
 * `stemCandidates` strips one suffix; stripping is applied a second time to
 * its candidates, so a possessive + case form reaches the root:
 * "isigini" → "isigi" → "isig" → "isik" (ışığını → ışık).
 */
export function wordForms(word: string): ReadonlySet<string> {
  const hit = formsCache.get(word);
  if (hit) return hit;
  const out = new Set<string>();
  const add = (c: string) => {
    out.add(c);
    const hard = UNSOFTEN_FOLDED[c.slice(-1)];
    if (hard && c !== word && c.length > 2) out.add(c.slice(0, -1) + hard);
  };
  for (const c of stemCandidates(word)) {
    add(c);
    if (c === word) continue;
    for (const c2 of stemCandidates(c)) if (c2 !== c && c2.length >= SECOND_STEM_MIN) add(c2);
  }
  if (formsCache.size > 5000) formsCache.clear();
  formsCache.set(word, out);
  return out;
}

function intersects(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

export interface PreparedQuery {
  /** Stem forms per user word, in order. */
  forms: ReadonlySet<string>[];
}

export function prepareQuery(text: string): PreparedQuery {
  return { forms: foldedWords(text).map(wordForms) };
}

/** True when the (folded) keyword occurs in the query; multi-word keywords as a phrase. */
export function keywordMatches(keyword: string, query: PreparedQuery): boolean {
  const kw = keyword.split(" ").filter(Boolean).map(wordForms);
  if (kw.length === 0 || kw.length > query.forms.length) return false;
  for (let i = 0; i + kw.length <= query.forms.length; i++) {
    if (kw.every((forms, j) => intersects(forms, query.forms[i + j] as ReadonlySet<string>))) return true;
  }
  return false;
}

/** Number of the entry's keywords found in the query (each counted once). */
export function scoreKeywords(keywords: readonly string[], query: PreparedQuery): number {
  let score = 0;
  for (const k of new Set(keywords)) if (keywordMatches(k, query)) score++;
  return score;
}

export interface MatchableEntry {
  id: string;
  text: string;
  keywords: readonly string[];
  updatedAt: number;
}

export interface SelectOptions {
  maxEntries?: number;
  /** Cap on the summed entry text length. */
  maxChars?: number;
}

/**
 * Entries relevant to `text`: score > 0, highest score first, then newest
 * `updatedAt`, then id (stable). Added while they fit into `maxChars`
 * (summed text length) and `maxEntries`; an entry that does not fit is left
 * out and the next lower-scored one is tried.
 */
export function selectRelevant<T extends MatchableEntry>(text: string, entries: readonly T[], opts: SelectOptions = {}): T[] {
  const maxEntries = opts.maxEntries ?? MEMORY_BUDGETS.turnMaxEntries;
  const maxChars = opts.maxChars ?? MEMORY_BUDGETS.turnMaxChars;
  const query = prepareQuery(text);
  if (query.forms.length === 0) return [];
  const scored = entries
    .map((entry) => ({ entry, score: scoreKeywords(entry.keywords, query) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt || a.entry.id.localeCompare(b.entry.id));
  const out: T[] = [];
  let chars = 0;
  for (const { entry } of scored) {
    if (out.length >= maxEntries) break;
    if (chars + entry.text.length > maxChars) continue;
    out.push(entry);
    chars += entry.text.length;
  }
  return out;
}

/**
 * The `<hafiza>` block for the turn envelope, or "" for no entries. Angle
 * brackets inside entry texts are replaced, so a (hand-edited) text cannot
 * close the block or open another tag.
 */
export function renderMemoryBlock(entries: readonly Pick<MatchableEntry, "text">[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((e) => `- ${e.text.replace(/</g, "‹").replace(/>/g, "›").replace(/\s+/g, " ").trim()}`);
  return `<hafiza>\n${lines.join("\n")}\n</hafiza>`;
}

/**
 * Once-per-query bookkeeping: the entry ids (and their `updatedAt`) already
 * sent in the running query. An entry is sent again only after it changed.
 * The owner (DeviceAgent, M6) calls `clear()` when the query restarts or is
 * compacted.
 */
export class SentEntries {
  private readonly sent = new Map<string, number>();

  /** True when the entry was not sent yet in this query, or changed since. */
  isFresh(entry: Pick<MatchableEntry, "id" | "updatedAt">): boolean {
    return this.sent.get(entry.id) !== entry.updatedAt;
  }

  markSent(entries: readonly Pick<MatchableEntry, "id" | "updatedAt">[]): void {
    for (const e of entries) this.sent.set(e.id, e.updatedAt);
  }

  clear(): void {
    this.sent.clear();
  }

  get size(): number {
    return this.sent.size;
  }
}

/**
 * Memory for one model turn: the relevant entries not yet sent in this query
 * (cut to the per-turn budget), marked as sent, and their rendered block.
 */
export function memoryForTurn<T extends MatchableEntry>(
  text: string,
  entries: readonly T[],
  sent: SentEntries,
  opts: SelectOptions = {},
): { entries: T[]; block: string } {
  const picked = selectRelevant(
    text,
    entries.filter((e) => sent.isFresh(e)),
    opts,
  );
  sent.markSent(picked);
  return { entries: picked, block: renderMemoryBlock(picked) };
}
