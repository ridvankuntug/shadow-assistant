/**
 * Streaming sentence splitter for spoken replies (docs/07-speed.md A2, S9).
 *
 * Fed with the answer's text deltas (`push`) it returns finished speech
 * chunks; `flush()` at the end of the answer returns the rest. Pure: no I/O.
 *
 * Boundaries:
 *   - `.`, `!`, `?`, `…` (a run of them, e.g. `?!`, `...`) followed by
 *     whitespace; closing quotes/brackets between the mark and the whitespace
 *     stay with the sentence (`"Evet." dedi` splits after `"`);
 *   - a newline.
 * Not a boundary:
 *   - a mark not followed by whitespace: decimals `21.5`, URLs and file names
 *     `ornek.com/a.b`, a dot run glued to the next word `Hmm...evet`;
 *   - an ordinal: digits + `.` + whitespace + a lower-case letter (`3. kat`);
 *   - a dot after a listed abbreviation (`Dr.`, `vb.`, …), whatever follows.
 *
 * Sizes (characters):
 *   - the first chunk is emitted as soon as it ends at a boundary and has at
 *     least FIRST_MIN_WORDS words (so speech can start early);
 *   - after that, a sentence shorter than MIN_CHARS is merged into the next;
 *   - a chunk longer than MAX_CHARS is cut at the last comma in the window
 *     (if that keeps at least half), else at the last whitespace, else hard;
 *     this also applies while a long sentence without punctuation streams in.
 * Chunks with no letter or digit (only emoji or punctuation) are dropped:
 * there is nothing to speak. Chunk whitespace is collapsed to single spaces.
 *
 * The splitter never sees the escalation marker: it is fed from the same path
 * as `assistant_delta`, after tier-1 buffering (07 A2).
 */

export const FIRST_MIN_WORDS = 2;
export const MIN_CHARS = 25;
export const MAX_CHARS = 300;

/** Lower-case (Turkish-folded) abbreviations whose dot never ends a sentence. */
export const ABBREVIATIONS: ReadonlySet<string> = new Set([
  "dr",
  "sn",
  "vb",
  "vs",
  "örn",
  "no",
  "prof",
  "doç",
  "av",
  "bkz",
]);

export interface SentenceSplitterOptions {
  firstMinWords?: number;
  minChars?: number;
  maxChars?: number;
}

const TERMINAL = new Set([".", "!", "?", "…"]);
/** May follow the terminal mark(s) and still belong to the sentence. */
const CLOSERS = new Set(['"', "'", "”", "’", "»", ")", "]", "}"]);
const SPEAKABLE = /[\p{L}\p{N}]/u;

const isSpace = (ch: string) => /\s/u.test(ch);
const isLower = (ch: string) => /\p{Ll}/u.test(ch);

function normalize(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function wordCount(text: string): number {
  let n = 0;
  for (const w of text.split(" ")) if (SPEAKABLE.test(w)) n++;
  return n;
}

/** Index just after the cut for an over-long text (cut ≤ max). */
function cutPoint(text: string, max: number): number {
  const window = text.slice(0, max + 1);
  const comma = window.lastIndexOf(",", max - 1);
  if (comma + 1 >= max * 0.5) return comma + 1;
  for (let i = max; i > 0; i--) if (isSpace(text.charAt(i))) return i;
  // No whitespace at all: hard cut, never through a surrogate pair.
  const code = text.charCodeAt(max - 1);
  return code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
}

export class SentenceSplitter {
  private readonly firstMinWords: number;
  private readonly minChars: number;
  private readonly maxChars: number;
  /** Raw text not yet cut into sentences. */
  private buf = "";
  /** Finished sentences waiting to reach the minimum size (normalized). */
  private acc = "";
  private emittedAny = false;

  constructor(options: SentenceSplitterOptions = {}) {
    this.firstMinWords = options.firstMinWords ?? FIRST_MIN_WORDS;
    this.minChars = options.minChars ?? MIN_CHARS;
    this.maxChars = Math.max(10, options.maxChars ?? MAX_CHARS);
  }

  /** Adds a delta; returns the chunks it completed (possibly none). */
  push(delta: string): string[] {
    if (delta === "") return [];
    this.buf += delta;
    const out: string[] = [];
    this.scan(out, false);
    return out;
  }

  /** End of the answer: returns everything left (possibly nothing) and resets. */
  flush(): string[] {
    const out: string[] = [];
    this.scan(out, true);
    const rest = normalize(`${this.acc} ${this.buf}`);
    this.acc = "";
    this.buf = "";
    this.emitSized(rest, out, true);
    this.emittedAny = false;
    return out;
  }

  /** Cuts complete sentences off `buf`. */
  private scan(out: string[], atEnd: boolean): void {
    for (;;) {
      const end = this.findBoundary(atEnd);
      if (end === undefined) break;
      const sentence = normalize(this.buf.slice(0, end));
      this.buf = this.buf.slice(end);
      if (sentence !== "") this.addSentence(sentence, out);
    }
    // A long run without a boundary: cut it now instead of waiting for the end.
    // Works on the raw text (only leading whitespace dropped): a trailing space
    // still separates it from the next delta.
    let raw = this.acc === "" ? this.buf.trimStart() : `${this.acc} ${this.buf.trimStart()}`;
    if (raw.length <= this.maxChars) return;
    while (raw.length > this.maxChars) {
      const cut = cutPoint(raw, this.maxChars);
      this.emit(normalize(raw.slice(0, cut)), out);
      raw = raw.slice(cut).trimStart();
    }
    this.acc = "";
    this.buf = raw;
  }

  /**
   * Index just after the first boundary in `buf`, or undefined when there is
   * none yet (or it cannot be decided before more text arrives).
   */
  private findBoundary(atEnd: boolean): number | undefined {
    const s = this.buf;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charAt(i);
      if (ch === "\n") return i + 1;
      if (!TERMINAL.has(ch)) continue;
      // The whole run of marks and closers.
      let j = i + 1;
      while (j < s.length && TERMINAL.has(s.charAt(j))) j++;
      while (j < s.length && CLOSERS.has(s.charAt(j))) j++;
      if (j >= s.length) return undefined; // need the next character to decide
      if (!isSpace(s.charAt(j))) {
        i = j - 1; // `21.5`, `a.b`, `Hmm...evet`: not a boundary
        continue;
      }
      if (s.charAt(i) === "." && j === i + 1) {
        // A single dot: abbreviation or ordinal?
        const word = /[\p{L}\p{N}]+$/u.exec(s.slice(0, i))?.[0] ?? "";
        if (ABBREVIATIONS.has(word.toLocaleLowerCase("tr-TR"))) continue;
        if (/^\d+$/.test(word)) {
          let k = j;
          while (k < s.length && isSpace(s.charAt(k)) && s.charAt(k) !== "\n") k++;
          if (k >= s.length) {
            if (!atEnd) return undefined; // `3. ` — wait for the next word
          } else if (s.charAt(k) !== "\n" && isLower(s.charAt(k))) {
            continue; // `3. kat`
          }
        }
      }
      return j;
    }
    return undefined;
  }

  private addSentence(sentence: string, out: string[]): void {
    this.acc = this.acc === "" ? sentence : `${this.acc} ${sentence}`;
    const ready = this.emittedAny
      ? this.acc.length >= this.minChars
      : wordCount(this.acc) >= this.firstMinWords;
    if (ready) {
      const text = this.acc;
      this.acc = "";
      this.emitSized(text, out, false);
    }
  }

  /** Emits `text`, cutting it into pieces of at most maxChars. */
  private emitSized(text: string, out: string[], final: boolean): void {
    let rest = text;
    while (rest.length > this.maxChars) {
      const cut = cutPoint(rest, this.maxChars);
      this.emit(rest.slice(0, cut), out);
      rest = rest.slice(cut).trim();
    }
    if (rest === "") return;
    if (!final && this.emittedAny && rest.length < this.minChars) {
      // A short tail left after cutting: wait for the next sentence.
      this.acc = rest;
      return;
    }
    this.emit(rest, out);
  }

  private emit(text: string, out: string[]): void {
    const t = text.trim();
    if (!SPEAKABLE.test(t)) return;
    out.push(t);
    this.emittedAny = true;
  }
}
