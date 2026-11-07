/**
 * Turkish number words → digits, for matching short home commands (T7.w.1).
 *
 *   "salon ışığını yüzde elli yap"   → "salon ışığını yüzde 50 yap"
 *   "yüzde yüze ayarla"              → "yüzde 100 ayarla"
 *   "yüz de elliye getir" (Whisper)  → "yüzde 50 getir"
 *   "yüzlü yap" (Whisper)            → "yüzde 100 yap"
 *   "%100", "% 100"                  → "yüzde 100" (already done by cleanTurkish)
 *
 * Scope is deliberately small: 0..100 (sıfır … doksan dokuz, yüz), one or two
 * words ("otuz beş"), with an optional case suffix on the last word ("elliye",
 * "ellide", "dörde", "yüzden"). Anything larger or odd-looking ("yüz elli",
 * "iki yüz", "elli bin", "bir iki") is left exactly as it was; the matcher then
 * sends such requests to the model, as before.
 *
 * Ambiguous words. Some number words are also ordinary words: "yüz" (face /
 * swim), "bir" (the article "a"), "altı" (under), "yedi" (ate), "ona" / "onu"
 * (to him / him), "yüzlü" (-faced: "güler yüzlü", "iki yüzlü"), and every
 * diacritic-less spelling ("uc" is "uç" as well as "üç"). Such a word is only
 * converted when the context says it is a number:
 *   - it follows "yüzde" ("yüzde yüz", "yüzde bir"), or
 *   - the next word is a level verb of the light-level rule (yap, ayarla,
 *     getir, olarak and their polite forms, see `LEVEL_VERBS`):
 *     "ışığı yüz yap", "yüzlü yap".
 * The article "bir" (and "bire", "biri", "birden" …) and the pronoun forms
 * "ona" / "onu" / "onda" / "ondan" are so common that a level verb is not
 * enough ("lambayı ona getir" = bring the lamp to him, "onu yap" = do it,
 * "bir yap" = make one): they are converted only right after "yüzde"
 * ("yüzde bir", "yüzde ona").
 * Otherwise it stays: "yüzünü yıka", "yüz yıka", "yüze krem sür", "bir lamba
 * aç", "güler yüzlü biri" are unchanged. Bare "yüz" / "yüzlü" with no context
 * is therefore NOT converted — a wrong 100 is worse than a model turn.
 * Two-word compounds ("otuz bir", "kırk altı") are never ambiguous.
 *
 * The split "yüz de" is weaker evidence than "yüzde" ("yüz de bir sorun var" =
 * the face has a problem too): it becomes "yüzde" before an unambiguous number
 * ("yüz de elli", "yüz de 50") and before an ambiguous one only when a level
 * verb or another number word follows ("yüz de bir yap", "yüz de ona getir").
 *
 * "yüzde" itself (also "on the face") is never changed; only a number after it.
 *
 * Input and output are in the cleanTurkish form (lower case, no punctuation,
 * single spaces); raw text is cleaned first. One pass over the words, a
 * constant amount of work per word, no regex backtracking: O(n).
 */
import { cleanTurkish, fold, type PreparedText } from "./turkish.js";

interface NumberForm {
  /** Canonical spelling with Turkish letters ("dörde"). */
  form: string;
  value: number;
  /** Has a case suffix: must be the last word of the number. */
  suffixed: boolean;
  /** Also an ordinary word: needs a number context (see the header). */
  ambiguous: boolean;
  /** So common as another word that only a preceding "yüzde" is context enough ("bir", "ona"). */
  percentOnly: boolean;
}

const BASES: readonly [word: string, value: number][] = [
  ["sıfır", 0],
  ["bir", 1],
  ["iki", 2],
  ["üç", 3],
  ["dört", 4],
  ["beş", 5],
  ["altı", 6],
  ["yedi", 7],
  ["sekiz", 8],
  ["dokuz", 9],
  ["on", 10],
  ["yirmi", 20],
  ["otuz", 30],
  ["kırk", 40],
  ["elli", 50],
  ["altmış", 60],
  ["yetmiş", 70],
  ["seksen", 80],
  ["doksan", 90],
  ["yüz", 100],
];

/** Bases that are also ordinary words; all their forms need a number context. */
const AMBIGUOUS_BASES = new Set(["bir", "altı", "yedi", "yüz"]);
/** Single inflected forms that are also other words (pronoun "o": ona, onu, onda, ondan). */
const AMBIGUOUS_FORMS = new Set(["ona", "onu", "onda", "ondan"]);
/** Bases whose every form is a common other word: the article "bir" ("biri", "birden"). */
const PERCENT_ONLY_BASES = new Set(["bir"]);
/** Words that make a number larger than this module handles: the whole run is left alone. */
const BIG_WORDS = new Set(["bin", "milyon", "milyar"]);
/**
 * Next words that mark a level ("… yüz yap", "… yüzlü getir"), folded and
 * matched as whole words. Exactly the words that may follow `<sayi>` in the
 * light-level rule of router.yaml: "olarak" and the first word of each
 * `groups.set-to` entry ("yapar mısın" → "yapar"). A verb that no rule accepts
 * after a number would only add false positives, so keep the two in step.
 */
const LEVEL_VERBS = new Set([
  "olarak",
  "yap",
  "yapar",
  "yapabilir",
  "yapin",
  "ayarla",
  "ayarlar",
  "ayarlayabilir",
  "ayarlayin",
  "ayarlamayi",
  "getir",
  "getirir",
  "getirebilir",
]);

const BACK_VOWELS = "aıou";
const VOWELS = "aeıioöuü";
const VOICELESS = "çfhkpsşt";

/** Dative, locative, ablative and accusative forms with vowel harmony ("elliye", "otuzda", "dörtten", "kırkı"). */
function inflect(base: string): string[] {
  const lastVowel = [...base].reverse().find((c) => VOWELS.includes(c)) ?? "e";
  const back = BACK_VOWELS.includes(lastVowel);
  const a = back ? "a" : "e";
  const acc = { a: "ı", ı: "ı", o: "u", u: "u", e: "i", i: "i", ö: "ü", ü: "ü" }[lastVowel] ?? "i";
  const last = base.slice(-1);
  const endsInVowel = VOWELS.includes(last);
  const d = VOICELESS.includes(last) ? "t" : "d";
  // Only "dört" softens before a vowel (dörde, dördü); the other numbers keep their consonant.
  const stem = base === "dört" ? "dörd" : base;
  const y = endsInVowel ? "y" : "";
  return [stem + y + a, base + d + a, base + d + a + "n", stem + y + acc];
}

/** Folded spelling → form. Built once; the forms never collide (checked in tests). */
const FORMS = new Map<string, NumberForm>();
for (const [word, value] of BASES) {
  const ambiguousBase = AMBIGUOUS_BASES.has(word);
  for (const [form, suffixed] of [[word, false] as const, ...inflect(word).map((f) => [f, true] as const)]) {
    // The locative of "yüz" is the percent word itself: never a number, only a marker before one.
    if (form === "yüzde") continue;
    const percentOnly = PERCENT_ONLY_BASES.has(word) || AMBIGUOUS_FORMS.has(form);
    FORMS.set(fold(form), { form, value, suffixed, ambiguous: ambiguousBase || percentOnly, percentOnly });
  }
}

/** Exposed for tests. */
export const NUMBER_FORM_COUNT = FORMS.size;

/**
 * Looks a word up. The spoken word must be the canonical form, except that a
 * Turkish letter may be written without its marks ("dort", "yuzde") — then it
 * is treated as ambiguous ("uc" may be "uç") — and "ı" may stand for "i" (an
 * ASCII capital I lower-cased with Turkish rules: "ELLI" → "ellı"). A Turkish
 * letter where the form has a plain one ("ön" vs "on") is a different word.
 */
function lookup(word: string): NumberForm | undefined {
  const entry = FORMS.get(fold(word));
  if (!entry) return undefined;
  if (word === entry.form) return entry;
  let marksDropped = false;
  const w = [...word];
  const c = [...entry.form];
  for (let k = 0; k < c.length; k++) {
    if (w[k] === c[k]) continue;
    if (w[k] === "ı" && c[k] === "i") continue;
    if (w[k] === fold(c[k] as string)) {
      marksDropped = true;
      continue;
    }
    return undefined;
  }
  return marksDropped ? { ...entry, ambiguous: true } : entry;
}

const isPercentWord = (w: string | undefined) => w !== undefined && fold(w) === "yuzde";
const isLevelVerb = (w: string | undefined) => w !== undefined && LEVEL_VERBS.has(fold(w));
/** "yüzlü": a mis-heard "yüzde yüz" — or "-faced", see the header. */
const isYuzlu = (w: string) => fold(w) === "yuzlu";
/** A digit run with a case suffix written without an apostrophe ("50ye", "30a", "50de"). */
const DIGITS_SUFFIX = /^(\d{1,3})(?:y?[ae]|[dt][ae]n?|y?[ıiuü])$/u;

/** Value of a number-word run, or undefined when it is not a single number 0..100. */
function runValue(run: readonly NumberForm[]): number | undefined {
  if (run.length === 1) return (run[0] as NumberForm).value;
  if (run.length !== 2) return undefined;
  const [tens, unit] = run as [NumberForm, NumberForm];
  if (tens.suffixed || tens.value < 10 || tens.value > 90 || tens.value % 10 !== 0) return undefined;
  if (unit.value < 1 || unit.value > 9) return undefined;
  return tens.value + unit.value;
}

/** Words after conversion, and for each one the range of input words it came from. */
interface Converted {
  words: string[];
  /** `from[k]`..`to[k]` (exclusive): input words behind output word k. */
  from: number[];
  to: number[];
}

function convert(words: readonly string[]): Converted {
  const res: Converted = { words: [], from: [], to: [] };
  const out = res.words;
  const emit = (ws: readonly string[], start: number, end: number) => {
    for (const w of ws) {
      out.push(w);
      res.from.push(start);
      res.to.push(end);
    }
  };
  let i = 0;
  while (i < words.length) {
    const w = words[i] as string;

    // Whisper splits "yüzde" before a number: "yüz de elli", "yüz de 50".
    if (fold(w) === "yuz" && words[i + 1] === "de") {
      const next = words[i + 2];
      const entry = next === undefined ? undefined : lookup(next);
      const strong = next !== undefined && (/^\d/.test(next) || isYuzlu(next) || (entry !== undefined && !entry.ambiguous));
      // An ambiguous number word after a split "yüz de" needs more: a level verb,
      // or a unit after a tens word spelled without marks ("yuz de kirk bes").
      const after = words[i + 3];
      const tens = entry !== undefined && !entry.suffixed && entry.value >= 20 && entry.value <= 90 && entry.value % 10 === 0;
      const weak = entry !== undefined && (isLevelVerb(after) || (tens && after !== undefined && lookup(after) !== undefined));
      if (strong || weak) {
        emit(["yüzde"], i, i + 2);
        i += 2;
        continue;
      }
    }

    const digits = DIGITS_SUFFIX.exec(w);
    if (digits) {
      emit([digits[1] as string], i, i + 1);
      i += 1;
      continue;
    }

    // Collect a run of number-ish words; a suffixed word ends it ("otuz beşe").
    const run: NumberForm[] = [];
    let j = i;
    let breaksRun = false;
    while (j < words.length) {
      const word = words[j] as string;
      if (BIG_WORDS.has(fold(word)) || isYuzlu(word)) {
        breaksRun = true;
        j += 1;
        if (isYuzlu(word) && run.length === 0) break;
        continue;
      }
      const entry = lookup(word);
      if (!entry) break;
      run.push(entry);
      j += 1;
      if (entry.suffixed) break;
    }

    if (j === i) {
      emit([w], i, i + 1);
      i += 1;
      continue;
    }
    const afterPercent = isPercentWord(out[out.length - 1]);
    const numberContext = afterPercent || isLevelVerb(words[j]);
    const single = run.length === 1 ? run[0] : undefined;
    // "bir", "ona" …: a level verb is not enough, only "yüzde" (see the header).
    const singleContext = single?.percentOnly ? afterPercent : numberContext;

    // "yüzlü" on its own: "yüzde 100" (or "100" right after "yüzde"), only in a number context.
    if (run.length === 0 && j === i + 1 && isYuzlu(w)) {
      emit(numberContext ? (afterPercent ? ["100"] : ["yüzde", "100"]) : [w], i, j);
      i = j;
      continue;
    }

    const value = breaksRun ? undefined : runValue(run);
    if (value === undefined || (single?.ambiguous && !singleContext)) {
      for (let k = i; k < j; k++) emit([words[k] as string], k, k + 1);
    } else {
      emit([String(value)], i, j);
    }
    i = j;
  }
  return res;
}

/**
 * Converts Turkish number words (0..100) to digits; see the module header for
 * what is and is not converted. The result is in the cleanTurkish form; text
 * without number words comes back as `cleanTurkish(text)`. Idempotent.
 */
export function normalizeNumbers(text: string): string {
  return convert(cleanTurkish(text).split(" ").filter(Boolean)).words.join(" ");
}

/** A prepared text with number words as digits, for the matcher (see router.ts). */
export interface NumberPreparedText extends PreparedText {
  /**
   * The words of the text as said behind a word-aligned `[start, end)` span of
   * `display`: a name captured from the converted text is given back as said
   * ("oda iki", not "oda 2"), so it resolves against the real entity names and
   * the converted form never reaches a reply.
   */
  original(start: number, end: number): string;
}

/**
 * `prepared` (a prepareText result) with number words as digits, or undefined
 * when there is nothing to convert.
 */
export function prepareNumbers(prepared: PreparedText): NumberPreparedText | undefined {
  const source = prepared.display.split(" ").filter(Boolean);
  const conv = convert(source);
  const display = conv.words.join(" ");
  if (display === prepared.display) return undefined;
  // Character offset in `display` → output word index.
  const wordAt: number[] = [];
  conv.words.forEach((w, k) => {
    for (let c = 0; c <= w.length; c++) wordAt.push(k);
  });
  return {
    display,
    folded: fold(display),
    original(start, end) {
      if (end <= start) return "";
      const first = wordAt[start] as number;
      const last = wordAt[end - 1] as number;
      return source.slice(conv.from[first], conv.to[last]).join(" ");
    },
  };
}
