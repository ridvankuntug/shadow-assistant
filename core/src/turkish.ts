/**
 * Turkish text preparation for the tier-0 matcher (router.yaml patterns).
 *
 * Two parallel forms of the same text are produced:
 *   display  lower-cased with Turkish rules (İ→i, I→ı), punctuation removed,
 *            fillers dropped, single spaces — Turkish letters kept, so captured
 *            names can be spoken back ("yatak odası", not "yatak odasi").
 *   folded   `display` with Turkish letters folded to ASCII one character at
 *            a time (ı→i, ş→s, ğ→g, ç→c, ö→o, ü→u, â→a …). Because folding is
 *            1:1, an index in `folded` is the same index in `display`: patterns
 *            match on `folded` (so "isigini ac" == "ışığını aç") and captures
 *            are cut from `display`.
 */

const FOLD: Record<string, string> = {
  ı: "i",
  ş: "s",
  ğ: "g",
  ç: "c",
  ö: "o",
  ü: "u",
  â: "a",
  î: "i",
  û: "u",
};

/** Folds Turkish letters to ASCII, one character for one character. */
export function fold(text: string): string {
  let out = "";
  for (const ch of text) out += FOLD[ch] ?? ch;
  return out;
}

/**
 * Lower-cases with Turkish rules and cleans up: an apostrophe suffix of a
 * proper noun or a number is dropped ("Salon'u" → "salon", "Mutfak’taki" →
 * "mutfak", "50'ye" → "50"), a percent sign becomes the spoken word ("%50",
 * "50 %" → "yüzde 50"), a minus sign before a number becomes "eksi" ("-20" →
 * "eksi 20"), other punctuation becomes a space, whitespace collapses.
 */
export function cleanTurkish(text: string): string {
  return (
    text
      .normalize("NFC")
      .toLocaleLowerCase("tr-TR")
      // "i̇" (i + combining dot) can appear when upper-case input was lower-cased elsewhere.
      .replace(/i̇/g, "i")
      .replace(/([\p{L}\p{N}])['’‘`´](\p{L}+)/gu, "$1")
      // A minus sign in front of a number is kept as a word ("-20", "%-20" → "eksi 20"),
      // so a negative level never turns into a positive one. A hyphen inside a word
      // or between numbers ("lamba-2", "1-2") is left to the punctuation rule below.
      .replace(/(?<![\p{L}\p{N}])[-−–]\s*(\d)/gu, " eksi $1")
      // Turkish writes the sign first ("%50"); speech-to-text sometimes puts it last.
      .replace(/%\s*(\d)/gu, " yüzde $1")
      // Bounded and anchored at the start of a digit run: an unbounded `(\d+)\s*%`
      // retries from every digit of a long run (quadratic). Longer numbers never
      // match <sayi> (1..3 digits) anyway.
      .replace(/(?<!\d)(\d{1,3})\s*%/gu, " yüzde $1 ")
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      // Remaining combining marks (unusual input) would break the 1:1 fold.
      .replace(/\p{M}/gu, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

export interface PreparedText {
  display: string;
  folded: string;
}

/** `cleanTurkish` + removal of whole filler words (compared folded). */
export function prepareText(text: string, fillers: readonly string[] = []): PreparedText {
  const fillerSet = new Set(fillers.map((f) => fold(cleanTurkish(f))));
  const words = cleanTurkish(text)
    .split(" ")
    .filter((w) => w !== "" && !fillerSet.has(fold(w)));
  const display = words.join(" ");
  return { display, folded: fold(display) };
}

/**
 * Accusative / possessive ("salonu", "lambayı", "odasını"), genitive ("salonun", "odasının"),
 * locative ("salonda", "mutfakta", "odasında") and locative + "-ki" ("salondaki", "odasındaki").
 */
// With and without the buffer consonant as separate candidates: "salonu" → "salon", "odasını" → "odası",
// "odasında" → "odası".
const CASE_SUFFIXES = [/[ıiuü]$/u, /[yn][ıiuü]$/u, /[ıiuü]n$/u, /n[ıiuü]n$/u, /[dt][ae]$/u, /n[dt][ae]$/u, /[dt][ae]ki$/u, /n[dt][ae]ki$/u];
/** Final consonant softened before a vowel suffix: mutfağı → mutfak, dolabı → dolap. */
const UNSOFTEN: Record<string, string> = { ğ: "k", b: "p", c: "ç", d: "t" };

/**
 * Candidate base forms of a captured name whose last word may carry a case
 * suffix without an apostrophe ("salonu", "lambayı", "yatak odasını",
 * "mutfağı", "salonun", "mutfakta"). The input form comes first; candidates are only
 * ever compared against real entity names, so a wrong guess just fails to match.
 */
export function stemCandidates(name: string): string[] {
  const words = name.split(" ").filter(Boolean);
  if (words.length === 0) return [];
  const head = words.slice(0, -1);
  const last = words[words.length - 1] as string;
  const out = [last];
  for (const suffix of CASE_SUFFIXES) {
    if (last.length <= 3 || !suffix.test(last)) continue;
    const stem = last.replace(suffix, "");
    if (stem.length < 2) continue;
    out.push(stem);
    const hard = UNSOFTEN[stem.slice(-1)];
    if (hard) out.push(stem.slice(0, -1) + hard);
  }
  return [...new Set(out)].map((w) => [...head, w].join(" "));
}

/**
 * Other names for a spoken place name, from synonym groups (router.yaml
 * `direct.area_aliases`, e.g. `[salon, oturma odası]`). Every stem candidate
 * of the name is compared (folded), so "salonun" and "oturma odasında" find
 * their group too. Returns the other members of every matching group, in
 * group order, without the name itself; empty when nothing matches.
 */
export function aliasVariants(name: string, groups: readonly (readonly string[])[]): string[] {
  const key = (s: string) => fold(cleanTurkish(s));
  const cands = new Set(stemCandidates(cleanTurkish(name)).map(key));
  const out: string[] = [];
  for (const group of groups) {
    const keys = group.map(key);
    if (!keys.some((k) => cands.has(k))) continue;
    group.forEach((member, i) => {
      if (!cands.has(keys[i] as string) && !out.includes(member)) out.push(member);
    });
  }
  return out;
}
