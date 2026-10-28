/**
 * Memory filters (docs/06-memory.md §Filters, task M2).
 *
 * They run twice:
 *   - on the extractor's input (`redactForExtraction`, `redactTurn`): secrets
 *     and personal numbers are replaced with `[gizli]`, lines that mention a
 *     vault `Private` path are dropped, and the assistant text of a turn that
 *     used a `shadow-vault` tool is dropped. Health, permission-like and
 *     time-bound wording is kept (the model needs the context);
 *   - on every proposed memory text (`rejectReason`): any hit rejects the text.
 *
 * | Filter          | Input          | Output |
 * |-----------------|----------------|--------|
 * | secret          | replace        | reject |
 * | personal_number | replace        | reject |
 * | health          | keep           | reject |
 * | private_path    | drop line/turn | reject |
 * | permission      | keep           | reject |
 * | transient       | keep           | reject |
 * | tombstone       | –              | reject |
 *
 * Every filter first normalizes the text (`normalizeText`: invisible format
 * characters such as ZWSP/ZWJ/soft hyphen/BOM removed, then NFKC), so "ş"
 * written as s + combining cedilla, or a word split by a zero-width space, is
 * the same as the plain spelling. The redaction functions return the
 * normalized text (it only goes to the extractor; the difference is
 * invisible). Keyword filters then match on a lower-cased (Turkish rules),
 * diacritic-folded copy (`fold` from turkish.ts), so "ŞİFRE", "şifre" and
 * "sifre" are the same. This module never logs; callers log `formatFilterCounts(counts)`,
 * which holds filter names and numbers only, never text.
 */
import { fold } from "../turkish.js";

/**
 * vault.ts `VAULT_SERVER_NAME`, copied so this pure module does not load the
 * agent SDK through vault.ts; a test keeps the two equal.
 */
export const VAULT_SERVER = "shadow-vault";

export type FilterName =
  | "secret"
  | "personal_number"
  | "health"
  | "private_path"
  | "permission"
  | "transient"
  | "tombstone";

/** Replacement for a redacted value. */
export const REDACTED = "[gizli]";

export type FilterCounts = Partial<Record<FilterName, number>>;

function add(counts: FilterCounts, name: FilterName, n = 1): void {
  if (n > 0) counts[name] = (counts[name] ?? 0) + n;
}

/** Adds `b` into `a` (for aggregating counts over a pass). */
export function mergeFilterCounts(a: FilterCounts, b: FilterCounts): FilterCounts {
  for (const [k, v] of Object.entries(b) as [FilterName, number][]) add(a, k, v);
  return a;
}

/** Log form: `secret=2 health=1` (names and numbers only). Empty string when nothing was filtered. */
export function formatFilterCounts(counts: FilterCounts): string {
  return (Object.entries(counts) as [FilterName, number][])
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

// ---------------------------------------------------------------------------
// Normalized matching copy

/**
 * Invisible characters that can split a word without changing how it looks:
 * all format characters (\p{Cf}: ZWSP, ZWNJ, ZWJ, soft hyphen, BOM, word
 * joiner, bidi controls …) and the combining grapheme joiner.
 */
const INVISIBLE = /[\p{Cf}͏]/gu;

/**
 * Removes invisible characters, then applies NFKC (composes s + U+0327 into
 * "ş", maps full-width and other compatibility forms to plain ones). Every
 * filter works on this form, and redaction output is in this form.
 */
export function normalizeText(text: string): string {
  return text.replace(INVISIBLE, "").normalize("NFKC");
}

/**
 * Lower-case (Turkish rules) + diacritic fold, one UTF-16 unit for one: an
 * index in the result is the same index in the input, so a match found on the
 * folded copy can be cut from the original. Characters whose lower case has a
 * different length are kept as they are.
 */
function matchForm(text: string): string {
  // Fast path (per-character locale calls are slow on long input): lower-casing
  // never shortens a character, so an unchanged total length means every
  // character kept its length and the indexes still line up.
  const whole = text.toLocaleLowerCase("tr-TR");
  if (whole.length === text.length) return fold(whole);
  let out = "";
  for (const ch of text) {
    const lower = ch.toLocaleLowerCase("tr-TR");
    out += fold(lower.length === ch.length ? lower : ch);
  }
  return out;
}

const L = "\\p{L}\\p{N}"; // word characters for boundaries
const B = `(?<![${L}])`; // word start
const E = `(?![${L}])`; // word end

function wordRegex(alternatives: readonly string[]): RegExp {
  return new RegExp(`${B}(?:${alternatives.join("|")})${E}`, "u");
}

// ---------------------------------------------------------------------------
// Secrets

/**
 * Replace-all rules applied to the (normalized) text, in order. `$1` keeps a
 * prefix; `accept` can veto a match.
 */
const SECRET_PATTERNS: readonly { re: RegExp; keep?: boolean; accept?: (match: string, prefix: string) => boolean }[] = [
  // An explicit `Authorization:` header: the value is a credential whatever it
  // looks like ("authorization: bearer abcdefgh"), scheme any case or absent.
  { re: /\b(Authorization\s*:\s*(?:(?:Bearer|Basic)\s+)?)[A-Za-z0-9._~+/=-]{8,}/gi, keep: true },
  // Bearer/Basic in free text, any case ("bearer", "BASIC"). A non-canonical
  // spelling needs a token-looking value, so "basic settings" stays prose.
  {
    re: /\b(Bearer\s+|Basic\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
    keep: true,
    accept: (m, prefix) => {
      const word = prefix.trimEnd();
      if (word === "Bearer" || word === "Basic") return true;
      const value = m.slice(prefix.length);
      return /[0-9._~+/=-]/.test(value) || (/[a-z]/.test(value) && /[A-Z]/.test(value));
    },
  },
  // Known token formats.
  {
    re: /(?<![A-Za-z0-9])(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/g,
  },
  // JWT.
  { re: /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){0,2}/g },
  // Long hex run (≥ 20).
  { re: /(?<![A-Za-z0-9])[0-9a-fA-F]{20,}(?![A-Za-z0-9])/g },
];

const SCHEME_CHAR = /[a-z0-9+.-]/i;
/** `user:pass@` right after "://" (sticky; each part stops at the first character outside its class). */
const URL_USERINFO = /[^\s/:@]+:[^\s/@]+@/y;

/**
 * URL with credentials: scheme://user:pass@ → scheme://[gizli]@. Not one
 * regex: `\b[a-z][a-z0-9+.-]*://` retried from every position of a long
 * "a-a-a-…" run is quadratic. Instead every "://" is found with indexOf and
 * its scheme is scanned backwards, at most 32 characters.
 */
function redactUrlCredentials(text: string): { text: string; count: number } {
  let count = 0;
  let out = "";
  let last = 0;
  for (let at = text.indexOf("://"); at !== -1; at = text.indexOf("://", at + 3)) {
    let start = at;
    while (start > 0 && at - start < 32 && SCHEME_CHAR.test(text.charAt(start - 1))) start--;
    // A scheme starts with a letter: skip leading digits and symbols.
    while (start < at && !/[a-z]/i.test(text.charAt(start))) start++;
    if (start === at) continue;
    // Word boundary before the scheme (also rejects a scheme longer than 32).
    if (start > 0 && /[\p{L}\p{N}_]/u.test(text.charAt(start - 1))) continue;
    const userStart = at + 3;
    URL_USERINFO.lastIndex = userStart;
    const m = URL_USERINFO.exec(text);
    if (!m) continue;
    out += `${text.slice(last, userStart)}${REDACTED}@`;
    last = userStart + m[0].length;
    count++;
  }
  return { text: out + text.slice(last), count };
}

/** Long base64-like run (≥ 20): only with digits and both letter cases, so words and ids are not hit. */
const BASE64_RUN = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{20,}={0,2}(?![A-Za-z0-9+/_-])/g;
function looksRandom(run: string): boolean {
  return /\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run);
}

/**
 * Secret keywords (on the match form). Each is followed by a value; see
 * KEYWORD_VALUE. `anahtar` is also a physical key, so for output it rejects
 * only together with a value (see STRONG_SECRET_WORDS).
 */
const SECRET_KEYWORD = [
  "sifre\\p{L}*",
  "parola\\p{L}*",
  "anahtar\\p{L}*",
  "token\\p{L}*",
  "api[\\s_-]?(?:key|anahtar\\p{L}*)s?",
  "apikey",
  "password",
  "passwd",
  "passcode",
  "passphrase",
  "secret",
  "pin(?:['’]?(?:i|im|imi|in|ini|e|de|le))?(?:\\s+kod\\p{L}*)?",
].join("|");

/**
 * keyword + separator + value. After `:`/`=` any token is a value; after plain
 * whitespace (and optional filler words) only a quoted string or a token with
 * a digit or a symbol is (so "şifremi değiştirdim" is not a value).
 */
const KEYWORD_VALUE = new RegExp(
  `${B}(?:${SECRET_KEYWORD})${E}` +
    `(?:\\s*[:=]\\s*(?<sep>"[^"\\n]+"|'[^'\\n]+'|“[^”\\n]+”|[^\\s]+)` +
    `|(?:\\s+(?:is|de|da|ise|su|soyle|olarak|->|→))*\\s+(?<bare>"[^"\\n]+"|'[^'\\n]+'|“[^”\\n]+”|[^\\s]*[\\p{N}@#$%^&*_+=<>|\\\\/~][^\\s]*))`,
  "gu",
);

/**
 * Strong labels in a form that is followed by its value (nominative or
 * possessive: "şifre", "şifrem", "şifresi", "token", "password"; not the object
 * form "şifremi", "şifresini"). After them a letter-only word is a value too
 * ("Wifi şifrem bulutlar", "token abcdefgh"), unless it is in VALUELESS_WORDS
 * ("şifrem nedir", "şifresi değişti").
 */
const STRONG_LABEL = [
  "sifre(?:m|n|si|miz|niz|leri)?",
  "parola(?:m|n|si|miz|niz|lari)?",
  "token(?:['’]?(?:i|im|in|imiz|iniz|lari))?",
  "password",
  "passwd",
  "passcode",
  "passphrase",
  "pin(?:['’]?(?:i|im|in))?(?:\\s+kod(?:u|um|un))?",
].join("|");

/** Fillers between a label and its value (as in KEYWORD_VALUE). */
const FILLER = "is|de|da|ise|su|soyle|olarak";

/**
 * Words after a strong label that are not its value (match form): fillers,
 * question words, conjunctions, verbs about the secret itself. A heuristic: an
 * unlisted word is redacted (over-redaction costs the extractor one word; a
 * missed value leaks the secret).
 */
const VALUELESS_WORDS = [
  FILLER,
  "kod\\p{L}*|ve|veya|ya|ile|icin|gibi|ama|fakat|ki|mi|mu|ne|nedir|neydi|nerede|hangi\\p{L}*|kim\\p{L}*|bu|o|bir|cok|en|hep|hala|artik|yine|da",
  "var\\p{L}*|yok\\p{L}*|lazim|gerek\\p{L}*|degis\\p{L}*|unut\\p{L}*|hatirla\\p{L}*|sifirla\\p{L}*|yenile\\p{L}*|guncelle\\p{L}*",
  "olustur\\p{L}*|belirle\\p{L}*|ayarla\\p{L}*|gir\\p{L}*|sor\\p{L}*|gonder\\p{L}*|bil\\p{L}*|yaz\\p{L}*|kaydet\\p{L}*|paylas\\p{L}*",
  "sure\\p{L}*|sayi\\p{L}*|limit\\p{L}*|yonetici\\p{L}*|alan\\p{L}*|kutu\\p{L}*|ekran\\p{L}*|kurtarma\\p{L}*|sifirlama\\p{L}*",
  "and|or|for|of|to|the|a|an|was|are|reset|change\\p{L}*|manager|field|expired|expires|count",
].join("|");

const STRONG_LETTER_VALUE = new RegExp(
  `${B}(?:${STRONG_LABEL})${E}(?:\\s+(?:${FILLER})${E})*\\s+(?!(?:${VALUELESS_WORDS})${E})(?<word>\\p{L}\\S*)`,
  "gu",
);

/**
 * The value is only an earlier rule's marker, quotes and trailing punctuation
 * aside. The punctuation strip also takes the marker's own "]", hence the
 * comparison with "[gizli".
 */
function isOnlyMarker(value: string): boolean {
  const start = /^["'“]/.test(value) ? 1 : 0;
  const end = trimValueEnd(value, start, value.length, true);
  return value.slice(start, end) === REDACTED.slice(0, -1);
}

/** Mentioning these in a memory text is enough to reject it (they never belong in memory). */
const STRONG_SECRET_WORDS = wordRegex([
  "sifre\\p{L}*",
  "parola\\p{L}*",
  "password",
  "passwd",
  "passcode",
  "passphrase",
  "pin(?:['’]?(?:i|im|imi|in|ini|e|de|le))?(?:\\s+kod\\p{L}*)?",
  "api[\\s_-]?(?:key|anahtar\\p{L}*)s?",
  "apikey",
]);

const TRAILING_PUNCT = /[.,;:!?)\]]/;
const TRAILING_PUNCT_OR_QUOTE = /[.,;:!?)\]"'”]/;

/**
 * Trailing sentence punctuation (and closing quotes with `quotes`) is not part
 * of a value. One backward scan: a `[…]*$` regex retried from every position
 * would be quadratic on a long punctuation run.
 */
function trimValueEnd(original: string, start: number, end: number, quotes = false): number {
  const re = quotes ? TRAILING_PUNCT_OR_QUOTE : TRAILING_PUNCT;
  while (end > start && re.test(original.charAt(end - 1))) end--;
  return end;
}

/**
 * Replaces secrets with REDACTED; returns the new text (normalized, see
 * normalizeText) and how many were replaced.
 */
export function redactSecrets(text: string): { text: string; count: number } {
  const url = redactUrlCredentials(normalizeText(text));
  let count = url.count;
  let out = url.text;
  for (const { re, keep, accept } of SECRET_PATTERNS) {
    out = out.replace(re, (m: string, prefix: unknown) => {
      const p = typeof prefix === "string" ? prefix : "";
      if (accept && !accept(m, p)) return m;
      count++;
      return keep ? `${p}${REDACTED}` : REDACTED;
    });
  }
  out = out.replace(BASE64_RUN, (m) => {
    if (!looksRandom(m)) return m;
    count++;
    return REDACTED;
  });
  // Keyword + value: find on the match form (same length as `out`), cut from `out`.
  const form = matchForm(out);
  const cuts: [number, number][] = [];
  const addCut = (index: number, whole: string, value: string | undefined) => {
    if (value === undefined) return;
    const end0 = index + whole.length;
    const start = end0 - value.length;
    // A value that is only an earlier rule's marker (`api_key: sk-…`) has
    // nothing left to hide; a partly redacted one ("abc [gizli] xyz") is
    // replaced whole, or its other words would leak.
    if (isOnlyMarker(out.slice(start, end0))) return;
    const end = trimValueEnd(out, start, end0);
    if (end > start) cuts.push([start, end]);
  };
  for (const m of form.matchAll(KEYWORD_VALUE)) addCut(m.index, m[0], m.groups?.sep ?? m.groups?.bare);
  for (const m of form.matchAll(STRONG_LETTER_VALUE)) addCut(m.index, m[0], m.groups?.word);
  // Both rules can find the same value ("password is hunter2"): merge overlaps.
  cuts.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of cuts) {
    const prev = merged[merged.length - 1];
    if (prev && start < prev[1]) prev[1] = Math.max(prev[1], end);
    else merged.push([start, end]);
  }
  for (const [start, end] of merged.reverse()) {
    out = `${out.slice(0, start)}${REDACTED}${out.slice(end)}`;
    count++;
  }
  return { text: out, count };
}

/** `text` must already be normalized. */
function hasSecret(text: string): boolean {
  if (redactSecrets(text).count > 0) return true;
  return STRONG_SECRET_WORDS.test(matchForm(text));
}

// ---------------------------------------------------------------------------
// Personal numbers

/** Luhn checksum for card-like digit runs. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

const IBAN_TR = /(?<![A-Za-z0-9])TR(?:\s?\d){24}(?!\d)/gi;
/**
 * A run of digit groups joined by short separators (whitespace incl. newline
 * and NBSP, ".", "-"). Separators and digits are disjoint, so the match is
 * linear. Cards and TC numbers are looked for inside a run (see digitRunSpans).
 */
const DIGIT_RUN = /\d+(?:[\s.-]{1,3}\d+)*/g;
const DIGIT_GROUP = /\d+/g;

/** TC kimlik checksum (digits 10 and 11). `d` is 11 digits, first non-zero. */
function tcValid(d: string): boolean {
  const n = [...d].map((c) => c.charCodeAt(0) - 48);
  const odd = n[0]! + n[2]! + n[4]! + n[6]! + n[8]!;
  const even = n[1]! + n[3]! + n[5]! + n[7]!;
  if ((((odd * 7 - even) % 10) + 10) % 10 !== n[9]) return false;
  return n.slice(0, 10).reduce((a, b) => a + b, 0) % 10 === n[10];
}

/** Words right before a digit run that make it a card or TC number (match form). */
const NUMBER_CONTEXT = wordRegex([
  "t\\.?c\\.?",
  "tckn",
  "kimlik\\p{L}*",
  "kart\\p{L}*",
  "kredi",
  "card",
  "credit",
  "visa",
  "mastercard",
]);
/** How far before a run NUMBER_CONTEXT is looked for. */
const CONTEXT_WINDOW = 40;

/**
 * Card numbers and TC kimlik numbers in one digit run, as [start, end] offsets
 * into `text`.
 *
 * Groups of one digit join others only with a TC/kimlik/kart word just before
 * the run ("Kart 4 111 1111 1111 1111", "TC 1 000 000 0146") and only when the
 * joined digits pass the checksum (Luhn / TC); otherwise "1 2 3 … 10" is a
 * list, not a number, and single digits stand alone.
 *
 * - Card: 13–19 digits passing Luhn, made of whole groups. Sub-runs starting
 *   at each group are tried (longest first), so a trailing or leading number
 *   ("4111 1111 1111 1111 5 yıldır") does not hide the card.
 * - TC kimlik: 11 digits, first non-zero, either one group of its own or the
 *   whole run ("100 000 001 46"), not after ".", "," or "+". No
 *   checksum: a mistyped number is just as private.
 */
function digitRunSpans(text: string, runStart: number, run: string): [number, number][] {
  const groups = [...run.matchAll(DIGIT_GROUP)].map((g) => ({ start: runStart + g.index, digits: g[0] }));
  const spans: [number, number][] = [];
  const used = new Set<number>();
  const context = NUMBER_CONTEXT.test(matchForm(text.slice(Math.max(0, runStart - CONTEXT_WINDOW), runStart)));
  for (let i = 0; i < groups.length; i++) {
    let digits = "";
    let best = -1;
    // At most 19 digits: the inner loop is bounded, the whole pass is linear.
    for (let j = i; j < groups.length && digits.length + groups[j]!.digits.length <= 19; j++) {
      // Without context single digits are counts and list items, not number groups.
      if (!context && j > i && (groups[i]!.digits.length < 2 || groups[j]!.digits.length < 2)) break;
      digits += groups[j]!.digits;
      if (digits.length >= 13 && luhnValid(digits)) best = j;
    }
    if (best < 0) continue;
    const last = groups[best]!;
    spans.push([groups[i]!.start, last.start + last.digits.length]);
    for (let k = i; k <= best; k++) used.add(k);
    i = best;
  }
  // Not a decimal part ("3,10000000146") and not an international phone ("+49 30 1234567").
  const beforeOk = (at: number) => at === 0 || !/[.,+]/.test(text.charAt(at - 1));
  const isTc = (d: string) => d.length === 11 && d.charAt(0) !== "0";
  const allDigits = groups.map((g) => g.digits).join("");
  const grouped =
    groups.length > 1 &&
    (groups.every((g) => g.digits.length >= 2) || (context && isTc(allDigits) && tcValid(allDigits)));
  if (spans.length === 0 && grouped && isTc(allDigits) && beforeOk(runStart)) {
    return [[runStart, runStart + run.length]];
  }
  groups.forEach((g, k) => {
    if (!used.has(k) && isTc(g.digits) && beforeOk(g.start)) spans.push([g.start, g.start + g.digits.length]);
  });
  return spans.sort((a, b) => a[0] - b[0]);
}

/** Turkish numbers: +90 / 0090 / 0 prefix optional, area or mobile code 2xx-5xx, then 3+2+2. */
const PHONE_TR = /(?<![\d+])(?:(?:\+\s?90|0090|0)[\s.-]?)?\(?[2-5]\d{2}\)?[\s.-]?\d{3}[\s.-]?\d{2}[\s.-]?\d{2}(?!\d)/g;
/** International: + country code and 7-14 more digits in groups. */
const PHONE_INTL = /(?<![\d+])\+\d{1,3}(?:[\s.-]?\(?\d{1,4}\)?){2,5}(?!\d)/g;

const digitCount = (s: string) => s.replace(/\D/g, "").length;

/** Replaces IBANs, card numbers (Luhn), TC kimlik numbers and phone numbers with REDACTED. */
export function redactPersonalNumbers(text: string): { text: string; count: number } {
  let count = 0;
  const sub = (re: RegExp, accept: (m: string) => boolean) => (s: string) =>
    s.replace(re, (m) => {
      if (!accept(m)) return m;
      count++;
      return REDACTED;
    });
  let out = normalizeText(text);
  out = sub(IBAN_TR, () => true)(out);
  out = out.replace(DIGIT_RUN, (run: string, offset: number, whole: string) => {
    const spans = digitRunSpans(whole, offset, run);
    if (spans.length === 0) return run;
    let res = "";
    let last = offset;
    for (const [start, end] of spans) {
      res += `${whole.slice(last, start)}${REDACTED}`;
      last = end;
      count++;
    }
    return res + whole.slice(last, offset + run.length);
  });
  out = sub(PHONE_TR, (m) => {
    const n = digitCount(m);
    return n >= 10 && n <= 12;
  })(out);
  out = sub(PHONE_INTL, (m) => {
    const n = digitCount(m);
    return n >= 8 && n <= 15;
  })(out);
  return { text: out, count };
}

// ---------------------------------------------------------------------------
// Health (output only)

const HEALTH = wordRegex([
  // Turkish (match form: folded, lower case)
  "ilac\\p{L}*",
  "doz(?:u|unu|un|a|da|dan|lar\\p{L}*|aj\\p{L}*)?",
  "hap(?:i|in|ini|im|imi|imin|lar\\p{L}*|ta|tan)?",
  "teshis\\p{L}*",
  "tani(?:si|sini|siyla|lar\\p{L}*|\\s+kon\\p{L}*)?",
  "hastalig\\p{L}*",
  "hastalik\\p{L}*",
  "hastane\\p{L}*",
  "ameliyat\\p{L}*",
  "tansiyon\\p{L}*",
  "kolesterol\\p{L}*",
  "diyabet\\p{L}*",
  "seker\\s+hasta\\p{L}*",
  "insulin\\p{L}*",
  "depresyon\\p{L}*",
  "antidepresan\\p{L}*",
  "anksiyete\\p{L}*",
  "panik\\s+atak\\p{L}*",
  "terapi\\p{L}*",
  "kemoterapi\\p{L}*",
  "psikiyatr\\p{L}*",
  "psikolog\\p{L}*",
  "hamile\\p{L}*",
  "gebe(?:lik\\p{L}*)?",
  "alerji\\p{L}*",
  "kanser\\p{L}*",
  "tumor\\p{L}*",
  "migren\\p{L}*",
  "epilepsi\\p{L}*",
  "astim\\s+hasta\\p{L}*",
  "recete\\p{L}*",
  "tedavi\\p{L}*",
  // English
  "medication\\p{L}*",
  "medicine\\p{L}*",
  "dose",
  "doses",
  "dosage\\p{L}*",
  "pills?",
  "diagnos\\p{L}*",
  "disease\\p{L}*",
  "illness\\p{L}*",
  "surger(?:y|ies)",
  "blood\\s+pressure",
  "hypertension",
  "cholesterol",
  "diabet\\p{L}*",
  "depress(?:ion|ed)",
  "anxiety",
  "therap\\p{L}*",
  "psychiatr\\p{L}*",
  "psycholog\\p{L}*",
  "pregnan\\p{L}*",
  "allerg\\p{L}*",
  "cancer",
  "asthma",
  "prescription\\p{L}*",
]);

/**
 * Health words that fold to an ordinary word, matched on the lower-cased but
 * not folded text: "astım" (asthma) folds to "astim", the same as "aştım"
 * ("I exceeded"), so only the Turkish spelling counts ("astımı var", "astım
 * nedeniyle"). The folded "astim hasta…" in HEALTH stays.
 */
const HEALTH_UNFOLDED = wordRegex(["astım\\p{L}*"]);

// ---------------------------------------------------------------------------
// Vault Private/

/** A path segment `Private` (any case): next to a `/` or `\`. */
const PRIVATE_PATH = /(?:(?<![\p{L}\p{N}_.-])private(?=[\\/])|[\\/]private(?![\p{L}\p{N}_-]))/iu;

export function mentionsPrivatePath(text: string): boolean {
  return PRIVATE_PATH.test(text);
}

/** True for a tool of the vault service (`mcp__shadow-vault__…`); such turns lose their assistant text. */
export function isVaultTool(toolName: string): boolean {
  return toolName.startsWith(`mcp__${VAULT_SERVER}__`);
}

// ---------------------------------------------------------------------------
// Permission-like (output only)

const PERMISSION = wordRegex([
  "onay\\p{L}*\\s+(?:iste(?:me|meden|mesin|meyin|mene|mek\\s+yok)|sor(?:ma|madan|mayin|masin)|al(?:ma|madan)|gerek(?:mez|miyor|siz|meden))",
  "onaysiz\\p{L}*",
  "sormadan",
  "sormana\\s+gerek\\s+yok",
  "(?:her\\s+zaman|hep|daima|direkt|dogrudan|otomatik(?:\\s+olarak)?)\\s+evet\\p{L}*",
  "izin\\s+ver\\p{L}*",
  "yetki(?:\\s+ver\\p{L}*|lendir\\p{L}*|si\\s+var)",
  "(?:kural|talimat|kisitlama|sinir|guvenlik|izin)\\p{L}*\\s+(?:yok\\s+say|gormezden\\s+gel|atla|devre\\s+disi|kaldir|gecersiz)\\p{L}*",
  "yok\\s+say\\p{L}*",
  "gormezden\\s+gel\\p{L}*",
  "(?:ignore|disregard|override|bypass)\\s+(?:(?:all|any|the|previous|prior|your|earlier)\\s+)*(?:rules?|instructions?|permissions?|restrictions?|safety|confirmations?)",
  "always\\s+(?:allow|approve|say\\s+yes|confirm)",
  "(?:do\\s+not|don['’]?t|never)\\s+ask\\p{L}*",
  "without\\s+(?:asking|confirmation|permission)",
  "(?:sistem|system)\\s+(?:mesaj\\p{L}*|prompt\\p{L}*|talimat\\p{L}*)",
]);

// ---------------------------------------------------------------------------
// Transient state (output only)

const TRANSIENT_WORDS = wordRegex([
  "su\\s+an(?:da|ki|lik)?",
  "suan\\p{L}*",
  "simdi\\p{L}*",
  "bugun\\p{L}*",
  "yarin\\p{L}*",
  "dun(?:ku)?",
  "bu\\s+(?:aksam|sabah|gece|hafta|ogle)\\p{L}*",
  "az\\s+once",
  "biraz\\s+once",
  "birazdan",
  "demin",
  "right\\s+now",
  "today",
  "tonight",
  "tomorrow",
  "yesterday",
  "at\\s+the\\s+moment",
  "currently",
]);

/** `21:30`, `7.45`, `saat 7`, `saat yedide` (match form). Not `21.5`, not "saat gibi". */
const CLOCK_TIME = new RegExp(
  `(?<![\\d.,:])(?:[01]?\\d|2[0-3])[:.][0-5]\\d(?![\\d.,:])|${B}saat\\s+(?:\\d|(?:bir|iki|uc|dort|bes|alti|yedi|sekiz|dokuz|on)${E}|(?:bir|iki|uc|dort|bes|alti|yedi|sekiz|dokuz|on)(?:de|da|te|ta|e|a|ye|ya)${E})`,
  "u",
);

/** Wording that makes a clock time a routine rather than a moment. */
const ROUTINE = wordRegex([
  "her",
  "hep",
  "genelde",
  "genellikle",
  "daima",
  "sabahlari",
  "aksamlari",
  "geceleri",
  "ogleleri",
  "hafta\\s+ici",
  "hafta\\s+son\\p{L}*",
  "(?:pazartesi|sali|carsamba|persembe|cuma|cumartesi|pazar)(?:lari|leri)",
  "every",
  "usually",
  "always",
  "daily",
]);

function isTransient(form: string): boolean {
  if (TRANSIENT_WORDS.test(form)) return true;
  return CLOCK_TIME.test(form) && !ROUTINE.test(form);
}

// ---------------------------------------------------------------------------
// Public API

export interface RejectOptions {
  /**
   * True when the text's folded hash is tombstoned (`forgotten` in index.json).
   * The hash itself is the memory store's business (M1).
   */
  isForgotten?: (text: string) => boolean;
}

/**
 * Output filter for a proposed memory text: the first filter that rejects it,
 * in table order, or undefined when the text may be stored.
 */
export function rejectReason(text: string, options: RejectOptions = {}): FilterName | undefined {
  const normal = normalizeText(text);
  if (hasSecret(normal)) return "secret";
  if (redactPersonalNumbers(normal).count > 0) return "personal_number";
  const form = matchForm(normal);
  if (HEALTH.test(form) || HEALTH_UNFOLDED.test(normal.toLocaleLowerCase("tr-TR"))) return "health";
  if (mentionsPrivatePath(normal)) return "private_path";
  if (PERMISSION.test(form)) return "permission";
  if (isTransient(form)) return "transient";
  if (options.isForgotten?.(text)) return "tombstone";
  return undefined;
}

/**
 * Input filter for conversation text sent to the extractor: drops lines that
 * mention a `Private` path, replaces personal numbers and secrets with
 * REDACTED. Health, permission-like and transient wording is kept.
 */
export function redactForExtraction(text: string): { text: string; counts: FilterCounts } {
  const counts: FilterCounts = {};
  const kept: string[] = [];
  for (const line of normalizeText(text).split(/\r?\n/)) {
    if (mentionsPrivatePath(line)) {
      add(counts, "private_path");
      continue;
    }
    kept.push(line);
  }
  // Numbers first: an IBAN or a long number must not be half-eaten by the hex rule.
  const numbers = redactPersonalNumbers(kept.join("\n"));
  add(counts, "personal_number", numbers.count);
  const secrets = redactSecrets(numbers.text);
  add(counts, "secret", secrets.count);
  return { text: secrets.text, counts };
}

export interface ExtractionTurn {
  user: string;
  assistant?: string;
  /** Full tool names called in the turn (`mcp__<server>__<tool>`). */
  tools?: readonly string[];
}

/**
 * Input filter for one conversation turn: the assistant text of a turn that
 * used a `shadow-vault` tool is dropped (counted as private_path); the user's
 * own words stay. Both texts then go through redactForExtraction.
 */
export function redactTurn(turn: ExtractionTurn): { user: string; assistant?: string; counts: FilterCounts } {
  const counts: FilterCounts = {};
  const user = redactForExtraction(turn.user);
  mergeFilterCounts(counts, user.counts);
  if (turn.assistant === undefined) return { user: user.text, counts };
  if (turn.tools?.some(isVaultTool)) {
    add(counts, "private_path");
    return { user: user.text, counts };
  }
  const assistant = redactForExtraction(turn.assistant);
  mergeFilterCounts(counts, assistant.counts);
  return { user: user.text, assistant: assistant.text, counts };
}
