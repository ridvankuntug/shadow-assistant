/**
 * T7.w.1: Turkish number words → digits before tier-0 matching.
 *
 * Pins the conversions (incl. Whisper slips and case suffixes), the words that
 * must NOT change ("yüz" as face, "bir" as the article …) and the router
 * integration: the converted form only feeds the matcher.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { NUMBER_FORM_COUNT, normalizeNumbers, prepareNumbers } from "../src/numbers.js";
import { TEXT_NORMALIZER_VERSION, loadRouterFile, matchRules } from "../src/router-config.js";
import { TieredRouter } from "../src/router.js";
import { prepareText } from "../src/turkish.js";

const cfg = loadRouterFile(fileURLToPath(new URL("../../router.yaml", import.meta.url)));
const router = new TieredRouter({ config: cfg, models: { 1: "m1", 2: "m2", 3: "m3" } });
const route = (text: string) => router.route({ text, source: "voice", device: "test-device" });

describe("normalizeNumbers: conversions", () => {
  const cases: [string, string][] = [
    // the task's examples
    ["yüzde yüz", "yüzde 100"],
    ["%100", "yüzde 100"],
    ["% 100", "yüzde 100"],
    ["yüzde 100", "yüzde 100"],
    ["yüzde elli", "yüzde 50"],
    ["yüzlü yap", "yüzde 100 yap"],
    // all words 0..100
    ["yüzde sıfır", "yüzde 0"],
    ["yüzde bir", "yüzde 1"],
    ["yüzde on", "yüzde 10"],
    ["yüzde on beş", "yüzde 15"],
    ["yüzde yirmi", "yüzde 20"],
    ["yüzde otuz üç", "yüzde 33"],
    ["yüzde kırk altı", "yüzde 46"],
    ["yüzde altmış yedi", "yüzde 67"],
    ["yüzde yetmiş", "yüzde 70"],
    ["yüzde seksen dört", "yüzde 84"],
    ["yüzde doksan dokuz", "yüzde 99"],
    ["elli yap", "50 yap"],
    // Whisper slips
    ["yüz de elli", "yüzde 50"],
    ["Yüz de 50", "yüzde 50"],
    ["yüzde yüzlü yap", "yüzde 100 yap"],
    // case suffixes
    ["yüzde elliye", "yüzde 50"],
    ["yüzde ellide", "yüzde 50"],
    ["yüzde elli'ye", "yüzde 50"],
    ["elliye ayarla", "50 ayarla"],
    ["yüzde yüze", "yüzde 100"],
    ["yüze getir", "100 getir"],
    ["yüzde otuza", "yüzde 30"],
    ["yüzde kırka", "yüzde 40"],
    ["yüzde dörde", "yüzde 4"],
    ["yüzde dörtte", "yüzde 4"],
    ["yüzde otuz beşe", "yüzde 35"],
    ["yüzde ona", "yüzde 10"],
    ["yüzde on bire", "yüzde 11"],
    ["yüzde 50ye", "yüzde 50"],
    // a stray apostrophe from speech to text is ignored (T7.w.10)
    ["yüz'de elli", "yüzde 50"],
    ["Yüz’de elli", "yüzde 50"],
    ["YÜZ'DE ELLİ", "yüzde 50"],
    ["yuz'de elli", "yuzde 50"],
    ["yüz'de elli'ye", "yüzde 50"],
    ["yüz'de 50", "yüzde 50"],
    ["yüz'de yüz yap", "yüzde 100 yap"],
    ["yüzde'yi elli yap", "yüzde 50 yap"],
    ["yüzde elli'yi", "yüzde 50"],
    // "bir" and the pronoun forms: right after "yüzde" only
    ["yüzde bir yap", "yüzde 1 yap"],
    ["yüzde on yap", "yüzde 10 yap"],
    ["yüzde ona getir", "yüzde 10 getir"],
    ["yüzde onu", "yüzde 10"],
    ["yüzde bire ayarla", "yüzde 1 ayarla"],
    // a split "yüz de" before an ambiguous number needs a level verb (or a unit after a tens word)
    ["yüz de bir yap", "yüzde 1 yap"],
    ["yüz de ona getir", "yüzde 10 getir"],
    ["yüz de yüz yap", "yüzde 100 yap"],
    ["yuz de kirk bes", "yüzde 45"],
    // case and Turkish İ/ı
    ["YÜZDE ELLİ", "yüzde 50"],
    ["YÜZDE ELLI", "yüzde 50"],
    ["Yüzde Yüz", "yüzde 100"],
    // typed without Turkish letters
    ["yuzde elli", "yuzde 50"],
    ["yuzde yuz", "yuzde 100"],
    ["yuzde doksan dort", "yuzde 94"],
  ];
  for (const [input, expected] of cases) {
    test(`'${input}' -> '${expected}'`, () => assert.equal(normalizeNumbers(input), expected));
  }
});

describe("normalizeNumbers: left unchanged (false positives)", () => {
  const cases: string[] = [
    // "yüz" as face / swim, with no number context
    "yüzünü yıka",
    "yüz yıka",
    "yüz",
    "yüze krem sür",
    "denizde yüz",
    "bu yüzden",
    // "yüzlü" as "-faced"
    "güler yüzlü biri",
    "iki yüzlü",
    "yüzlü",
    // "yüzde" as "on the face", no number after it
    "yüzde sivilce var",
    // the article / pronouns / other words
    "bir lamba aç",
    "ona söyle",
    "masanın altı",
    "yemeği yedi",
    "ön kapı",
    // pronoun forms and "bir" before a level verb: not enough context
    "masa lambasını ona getir",
    "onu yap",
    "onda yap",
    "ondan getir",
    "ışığını bir yap",
    "bir ayarla",
    "biri getir",
    "birden yap",
    // a split "yüz de" before an ambiguous word without a level verb
    "yüz de bir sorun var",
    "yüz de bir",
    "yüz de ona söyle",
    // words that only begin like a level verb
    "bir çekmece aç",
    "bir yaprak",
    "yüz indirim",
    "yüz getirdi",
    "yüz yapraklı",
    // out of range or not one number
    "yüz elli",
    "yüzde yüz elli",
    "iki yüz",
    "elli bin",
    "bir iki",
    "elli altmış",
  ];
  for (const input of cases) {
    test(`'${input}' unchanged`, () => assert.equal(normalizeNumbers(input), input));
  }

  test("only \"yüz'de\" keeps its apostrophe suffix; other suffixes are dropped as before, no number", () => {
    assert.equal(normalizeNumbers("yüz'den"), "yüz");
    assert.equal(normalizeNumbers("yüz'ünü yıka"), "yüz yıka");
    assert.equal(normalizeNumbers("Salon'da yüz'de leke var"), "salon yüzde leke var");
  });

  test("ambiguous diacritic-less spelling needs a context ('uc' may be 'uç')", () => {
    assert.equal(normalizeNumbers("uc lamba"), "uc lamba");
    assert.equal(normalizeNumbers("yuzde uc"), "yuzde 3");
    assert.equal(normalizeNumbers("otuz uc"), "33");
  });

  test("an unambiguous number word converts without context", () => {
    assert.equal(normalizeNumbers("elli kere söyledim"), "50 kere söyledim");
  });
});

describe("normalizeNumbers: properties", () => {
  test("idempotent", () => {
    for (const s of ["yüzde elliye", "yüzlü yap", "yüz de elli", "güler yüzlü biri", "yüzde otuz beşe ayarla"]) {
      const once = normalizeNumbers(s);
      assert.equal(normalizeNumbers(once), once, s);
    }
  });

  test("no two inflected forms collide when folded", () => {
    // 20 bases × (base + 4 suffixes) − "yüzde" (the percent word, never a number).
    assert.equal(NUMBER_FORM_COUNT, 20 * 5 - 1);
  });

  test("the \"yüz'de\" change bumped the text normalizer version (learned counters restart)", () => {
    assert.equal(TEXT_NORMALIZER_VERSION, 2);
  });

  test("linear on long input", () => {
    // Relative, not an absolute time limit (which a loaded machine can miss): the
    // best of a few runs at n and at 4n words. Linear work gives a ratio near 4,
    // quadratic work near 16; the limit of 10 leaves room for noise either way.
    const N0 = 4_000;
    const RATIO = 10;
    const RUNS = 3;
    // The small run must take at least this long, or timer/GC noise dominates the ratio;
    // n is doubled until it does (no floor on the divisor, which would hide small times).
    const MIN_SMALL_MS = 15;
    const MAX_N = 256_000;
    const work = (text: string) => {
      const start = performance.now();
      normalizeNumbers(text);
      route(text);
      return performance.now() - start;
    };
    const inputs: Array<[label: string, make: (n: number) => string]> = [
      ["yüz", (n) => "yüz ".repeat(n)],
      ["on", (n) => "on ".repeat(n)],
      ["yüz de", (n) => "yüz de ".repeat(n)],
      ["digits + suffix", (n) => "1".repeat(3 * n) + "ye"],
    ];
    for (const [label, make] of inputs) {
      let n = N0;
      let small = make(n);
      let bestSmall: number;
      for (;;) {
        bestSmall = Infinity;
        for (let k = 0; k < RUNS; k++) bestSmall = Math.min(bestSmall, work(small));
        if (bestSmall >= MIN_SMALL_MS || n >= MAX_N) break;
        n *= 2;
        small = make(n);
      }
      assert.ok(bestSmall >= MIN_SMALL_MS, `${label}: even ${small.length} chars take only ${bestSmall.toFixed(2)} ms - nothing meaningful to compare`);
      const large = make(4 * n);
      let bestLarge = Infinity;
      // Interleaved, so both sizes see the same load.
      for (let k = 0; k < RUNS; k++) {
        bestLarge = Math.min(bestLarge, work(large));
        bestSmall = Math.min(bestSmall, work(small));
      }
      // Linear work gives a ratio near 4, quadratic near 16; the limit of 10 leaves room for noise.
      const ratio = bestLarge / bestSmall;
      assert.ok(ratio < RATIO, `${label}: ${small.length} chars ${bestSmall.toFixed(1)} ms, ${large.length} chars ${bestLarge.toFixed(1)} ms (x${ratio.toFixed(1)})`);
    }
  });
});

describe("router integration (tier 0)", () => {
  const cases: Array<[text: string, rule: string, name: string, level: number]> = [
    ["salon lambasını yüzde elli yap", "light-level", "salon", 50],
    ["Salon ışığını yüzde yüz yap", "light-level", "salon", 100],
    ["salon ışığını yüzlü yap", "light-level", "salon", 100],
    ["salon ışığını yüz de elliye ayarla", "light-level", "salon", 50],
    ["salon ışığını yüzde ellide yap", "light-level", "salon", 50],
    ["mutfak ışığını yüze getir", "light-level", "mutfak", 100],
    ["salon ışığını otuz beş yap", "light-level", "salon", 35],
    ["ışığın seviyesini yüzde kırka ayarla oturma odası", "light-level", "oturma odası", 40],
    ["salon ışığını yüzde sıfır yap", "light-level", "salon", 0],
    ["salon ışığını yüz'de elli yap", "light-level", "salon", 50],
    ["salon ışığını yüz'de elli'ye ayarla", "light-level", "salon", 50],
  ];
  for (const [text, rule, name, level] of cases) {
    test(text, () => {
      const d = route(text);
      assert.equal(d.tier, 0, JSON.stringify(d));
      assert.equal(d.rule, rule);
      assert.equal(d.direct?.name, name);
      assert.equal(d.direct?.brightness, level);
    });
  }

  test("the converted form reaches the matcher; the prepared text as said does not match", () => {
    const text = "salon lambasını yüzde elli yap";
    const prepared = prepareText(text, cfg.fillers);
    assert.equal(matchRules(cfg, prepared), undefined);
    assert.equal(normalizeNumbers(prepared.display), "salon lambasını yüzde 50 yap");
  });

  test("the route input is not modified", () => {
    const input = { text: "Salon ışığını yüzde elli yap", source: "voice" as const, device: "test-device" };
    router.route(input);
    assert.equal(input.text, "Salon ışığını yüzde elli yap");
  });

  test("a name with a number word is captured as said when the text matched before", () => {
    const d = route("oda iki ışığını aç");
    assert.equal(d.rule, "light-on");
    assert.equal(d.direct?.name, "oda iki");
  });

  test("second pass: a name holding a number word is captured as said, not as digits", () => {
    for (const [text, name] of [
      ["oda iki ışığını yüzde elli yap", "oda iki"],
      ["yatak odası iki lambasını yüzde elli yap", "yatak odası iki"],
      ["ışığın seviyesini yüzde elli yap oda on", "oda on"],
      ["oda üç ışığını yüzlü yap", "oda üç"],
    ] as const) {
      const d = route(text);
      assert.equal(d.rule, "light-level", text);
      assert.equal(d.direct?.name, name, text);
      assert.equal(d.direct?.brightness, text.includes("yüzlü") ? 100 : 50, text);
    }
  });

  test("prepareNumbers maps spans back to the words as said", () => {
    const p = prepareNumbers(prepareText("yüz de elli oda iki ve yüzlü yap"));
    assert.ok(p);
    assert.equal(p.display, "yüzde 50 oda 2 ve yüzde 100 yap");
    const span = (s: string) => [p.display.indexOf(s), p.display.indexOf(s) + s.length] as const;
    assert.equal(p.original(...span("yüzde 50")), "yüz de elli");
    assert.equal(p.original(...span("oda 2")), "oda iki");
    assert.equal(p.original(...span("100 yap")), "yüzlü yap");
    assert.equal(prepareNumbers(prepareText("salon ışığını aç")), undefined);
  });

  for (const [text, level] of [
    ["salon ışığını yüzde bir yap", 1],
    ["salon ışığını yüzde on yap", 10],
    ["salon ışığını yüzde ona getir", 10],
    ["salon ışığını yüz de bir yap", 1],
  ] as const) {
    test(`tier 0 after "yüzde": ${text}`, () => {
      const d = route(text);
      assert.equal(d.tier, 0, JSON.stringify(d));
      assert.equal(d.rule, "light-level");
      assert.equal(d.direct?.name, "salon");
      assert.equal(d.direct?.brightness, level);
    });
  }

  for (const text of [
    "salon ışığını yüz elli yap",
    "salon ışığını yüzde yüz elli yap",
    "yüzünü yıka",
    "güler yüzlü biri",
    // pronoun forms / "bir" before a level verb (was: brightness 10 / 1)
    "masa lambasını ona getir",
    "masa lambasını onu yap",
    "salon ışığını onu yap",
    "salon ışığını ona ayarla",
    "salon ışığını onda yap",
    "salon ışığını ondan getir",
    "salon ışığını bir yap",
    "salon lambasını bir ayarla",
    "salon ışığını biri getir",
    "salon ışığını yüz de bir",
  ]) {
    test(`not tier 0: ${text}`, () => {
      const d = route(text);
      assert.notEqual(d.tier, 0, JSON.stringify(d));
      assert.equal(d.direct, undefined);
    });
  }

  // Some of these match a rule as said ("bir lamba aç" → light-on, name "bir"):
  // that is the first pass, unchanged by T7.w.1. What must not happen is a level from a number word.
  test("no left-unchanged phrase becomes a light level when it reaches the router", () => {
    for (const text of [
      "yüz yıka",
      "yüze krem sür",
      "denizde yüz",
      "bu yüzden",
      "iki yüzlü",
      "yüzlü",
      "yüzde sivilce var",
      "bir lamba aç",
      "ona söyle",
      "masanın altı",
      "yemeği yedi",
      "onu yap",
      "ışığını bir yap",
      "yüz de bir sorun var",
      "bir çekmece aç",
      "yüz indirim",
      "elli bin",
      "bir iki",
    ]) {
      const d = route(text);
      assert.notEqual(d.rule, "light-level", `${text}: ${JSON.stringify(d)}`);
      assert.equal(d.direct?.brightness, undefined, `${text}: ${JSON.stringify(d)}`);
      // Nothing matched as said → the second (number) pass must not make it tier 0 either.
      if (matchRules(cfg, prepareText(text, cfg.fillers)) === undefined) assert.notEqual(d.tier, 0, text);
    }
  });
});
