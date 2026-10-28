/**
 * A3: natural Turkish home commands reach tier 0.
 *
 * Before this change every real voice/text turn went to tier 1 with rule
 * `default`: the patterns knew only "<ad> ışığını {aç|yak|…}" with a handful
 * of polite forms, had no brightness rule, no free word order, and "%50'ye"
 * was split into "50 ye". The "decision path" tests print and pin the whole
 * path (normalized text → rule → captured name / level → tier) for the
 * utterances seen in real use, so a regression is easy to read in the output.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { compilePattern, loadRouterFile, matchRules, parseRouterConfig, RouterConfigError, TIER0_MAX_CHARS } from "../src/router-config.js";
import { TieredRouter } from "../src/router.js";
import { aliasVariants, cleanTurkish, prepareText, stemCandidates } from "../src/turkish.js";

const cfg = loadRouterFile(fileURLToPath(new URL("../../router.yaml", import.meta.url)));
const router = new TieredRouter({ config: cfg, models: { 1: "m1", 2: "m2", 3: "m3" } });
const route = (text: string) => router.route({ text, source: "voice", device: "test-device" });

/** Normalized text → decision, one line (shown in the test output). */
function decisionPath(text: string): string {
  const p = prepareText(text, cfg.fillers);
  const d = route(text);
  const extra = d.direct ? ` name='${d.direct.name ?? ""}'${d.direct.brightness !== undefined ? ` level=${d.direct.brightness}` : ""}` : "";
  return `'${text}' → '${p.folded}' → tier ${d.tier} rule=${d.rule}${extra}`;
}

// ------------------------------------------------------------------ real utterances

describe("decision path: real utterances", () => {
  const cases: Array<[text: string, rule: string, name: string, level?: number]> = [
    ["Salonun ışığını yakmayı dener misin?", "light-on", "salonun"],
    ["Işığın seviyesini %50 yap oturma odası", "light-level", "oturma odası", 50],
    ["Oturma odasında ışığın seviyesini %50'ye ayarla", "light-level", "oturma odasında", 50],
    ["Oturma odası ışığını kapat", "light-off", "oturma odası"],
  ];
  for (const [text, rule, name, level] of cases) {
    test(text, (t) => {
      t.diagnostic(decisionPath(text));
      const d = route(text);
      assert.equal(d.tier, 0, decisionPath(text));
      assert.equal(d.rule, rule);
      assert.equal(d.direct?.name, name);
      assert.equal(d.direct?.brightness, level);
    });
  }

  // Seen in real use; must keep going to the model (several sentences / mis-heard level).
  for (const text of [
    "Salonun ışığını yakmayı dener misin? İlk testimizi yapalım.",
    "Işığın seviyesini 150'ye ayarlar mısın? Oturma odası ışığın.",
    "Oturma odası şiayet.",
    "Test deneme. Naber?",
  ]) {
    test(`model: ${text}`, (t) => {
      t.diagnostic(decisionPath(text));
      const d = route(text);
      assert.equal(d.tier, 1, decisionPath(text));
      assert.equal(d.rule, "default");
      assert.equal(d.direct, undefined);
    });
  }
});

// ------------------------------------------------------------------ variants

describe("tier 0 variants", () => {
  const cases: Array<[text: string, rule: string, name: string, level?: number]> = [
    // polite / indirect forms
    ["Salon ışığını açar mısın?", "light-on", "salon"],
    ["salon ışığını yakabilir misin", "light-on", "salon"],
    ["Mutfak lambasını yakar mısınız", "light-on", "mutfak"],
    ["salonun ışığını açmayı dener misin", "light-on", "salonun"],
    ["salon ışığını yaksana", "light-on", "salon"],
    ["oturma odası ışığını kapatabilir misin", "light-off", "oturma odası"],
    ["Salonun ışığını söndürür müsün", "light-off", "salonun"],
    ["salon ışıklarını kapatmayı dener misin", "light-off", "salon"],
    // case + Turkish letters
    ["OTURMA ODASI IŞIĞINI KAPAT", "light-off", "oturma odası"],
    ["SALONUN IŞIĞINI YAK", "light-on", "salonun"],
    ["oturma odasi isigini kapat", "light-off", "oturma odasi"],
    // suffixes on the name
    ["Oturma odasının ışığını kapat", "light-off", "oturma odasının"],
    ["oturma odasında ışığı aç", "light-on", "oturma odasında"],
    ["oturma odasındaki lambayı söndür", "light-off", "oturma odasındaki"],
    ["Salon'un ışığını yak", "light-on", "salon"],
    // word order
    ["yak salonun ışığını", "light-on", "salonun"],
    ["ışığı kapat oturma odasının", "light-off", "oturma odasının"],
    ["ışıkları açar mısın salonun", "light-on", "salonun"],
    ["söndür mutfak lambasını", "light-off", "mutfak"],
    // brightness: %N, N%, yüzde N, suffixes, verbs
    ["salon ışığını %30 yap", "light-level", "salon", 30],
    ["Salon ışığını 30% yap", "light-level", "salon", 30],
    ["salon ışığını yüzde 80 olarak ayarla", "light-level", "salon", 80],
    ["salon ışığını %50 ayarla", "light-level", "salon", 50],
    ["salon ışığını %50'ye getir", "light-level", "salon", 50],
    ["Oturma odası ışığını %100'e getirir misin", "light-level", "oturma odası", 100],
    ["oturma odası ışığının parlaklığını %20'ye ayarlar mısın", "light-level", "oturma odası", 20],
    ["salonun ışık seviyesini yüzde 40 yap", "light-level", "salonun", 40],
    ["ışığın seviyesini yüzde 50 ayarlar mısın salonun", "light-level", "salonun", 50],
    ["ışığı %10 yap yatak odasının", "light-level", "yatak odasının", 10],
    ["salon ışığını %0 yap", "light-level", "salon", 0],
    // filler words
    ["lütfen salonun ışığını yakar mısın", "light-on", "salonun"],
    // other devices keep working
    ["televizyonu kapatabilir misin", "device-off", "televizyonu"],
    ["fanı çalıştırır mısın", "device-on", "fanı"],
  ];
  for (const [text, rule, name, level] of cases) {
    test(`'${text}' -> ${rule} (${name}${level !== undefined ? ` ${level}` : ""})`, (t) => {
      t.diagnostic(decisionPath(text));
      const d = route(text);
      assert.equal(d.tier, 0, decisionPath(text));
      assert.equal(d.rule, rule);
      assert.equal(d.direct?.rule, rule);
      assert.equal(d.direct?.name, name);
      assert.equal(d.direct?.brightness, level);
    });
  }

  test("light-level plan: HassLightSet on lights only", () => {
    const d = route("salon ışığını %30 yap");
    assert.equal(d.direct?.tool, "light__HassLightSet");
    assert.deepEqual(d.direct?.domains, ["light"]);
    assert.equal(d.direct?.service, "home-assistant");
    assert.match(d.direct?.reply ?? "", /\{seviye\}/);
  });

  test("tier-0 plans carry the area aliases", () => {
    const d = route("salon ışığını aç");
    assert.ok(d.direct?.areaAliases.some((g) => g.includes("salon") && g.includes("oturma odası")));
  });
});

// ------------------------------------------------------------------ negatives

describe("not tier 0 (go to the model)", () => {
  const texts = [
    // questions / past / state
    "salon ışığı açık mı",
    "salon ışığını açtın mı",
    "salon ışığını kim açtı",
    "salon ışığını açar mıyım",
    "oturma odası ışığı neden yanıyor",
    "ışığın seviyesi kaç",
    "salon ışığının seviyesi yüzde kaç",
    // negative command
    "salon ışığını açma",
    "salon ışığını kapatma",
    // no name / ambiguous target
    "ışıkları aç",
    "ışığı kapat",
    "ışığın seviyesini %50 yap",
    "%50 değil. %50.",
    // compound / second clause captured as a name
    "ışığı kapat ve mutfağı aç",
    "ışığı aç sonra mutfak",
    "ışığı açar mısın bir de",
    // brightness out of range / not a light
    "salon ışığını %150 yap",
    "salon ışığını 1000 yap",
    "ses seviyesini %50 yap",
    "televizyonun sesini yüzde 50 yap",
    // relative change: "yüzde 10 yükselt" is +10, not 10 (the dative of a
    // target, "%30'a indir", is dropped during normalization, so these verbs
    // are never read as "set to")
    "salon ışığının parlaklığını yüzde 10 yükselt",
    "salon ışığını yüzde 10 yükseltir misin",
    "salon ışığını %20 artır",
    "salon ışığını %20 azalt",
    "salon ışığını yüzde 30'a indir",
    "oturma odası ışığının parlaklığını %20'ye düşürür müsün",
    "Oturma odası ışığını %100'e çıkar",
    "salon ışığını %40'a çek",
    // negative level: the sign must not be dropped
    "salon ışığını -20 yap",
    "salon ışığını %-20 yap",
    "salon ışığını % -20 yap",
    "salon ışığını −20 yap",
    // chat
    "Sen kimsin? Kendini tanıyor musun?",
    "Şu an sen hangi model ile çalışıyorsun?",
    "selam",
  ];
  for (const text of texts) {
    test(`'${text}'`, (t) => {
      t.diagnostic(decisionPath(text));
      assert.notEqual(route(text).tier, 0, decisionPath(text));
    });
  }
});

// ------------------------------------------------------------------ normalization

describe("cleanTurkish: numbers and percent", () => {
  const cases: [string, string][] = [
    ["%50", "yüzde 50"],
    ["%50'ye", "yüzde 50"],
    ["% 50", "yüzde 50"],
    ["50%", "yüzde 50"],
    ["50'ye", "50"],
    ["Oda 2'yi", "oda 2"],
    ["30’a indir", "30 indir"],
    ["Işığın Seviyesini %50 Yap", "ışığın seviyesini yüzde 50 yap"],
    ["-20", "eksi 20"],
    ["%-20", "eksi 20"],
    ["ışığı -20 yap", "ışığı eksi 20 yap"],
    ["lamba-2", "lamba 2"],
    ["1-2", "1 2"],
    ["1234%", "1234"],
  ];
  for (const [input, expected] of cases) {
    test(`'${input}' -> '${expected}'`, () => assert.equal(cleanTurkish(input), expected));
  }
});

describe("stemCandidates: locative after the possessive", () => {
  const cases: [string, string][] = [
    ["oturma odasında", "oturma odası"],
    ["oturma odasındaki", "oturma odası"],
    ["salondaki", "salon"],
    ["mutfaktaki", "mutfak"],
    ["oturma odasının", "oturma odası"],
  ];
  for (const [input, expected] of cases) {
    test(`'${input}' includes '${expected}'`, () => {
      assert.ok(stemCandidates(input).includes(expected), JSON.stringify(stemCandidates(input)));
    });
  }
});

describe("aliasVariants", () => {
  const groups = [["salon", "oturma odası"], ["çalışma odası", "ofis"]];
  test("finds the group through any suffix form", () => {
    assert.deepEqual(aliasVariants("salon", groups), ["oturma odası"]);
    assert.deepEqual(aliasVariants("salonun", groups), ["oturma odası"]);
    assert.deepEqual(aliasVariants("Oturma odasında", groups), ["salon"]);
    assert.deepEqual(aliasVariants("oturma odasi", groups), ["salon"]);
    assert.deepEqual(aliasVariants("ofisteki", groups), ["çalışma odası"]);
  });
  test("no group, no variants", () => {
    assert.deepEqual(aliasVariants("mutfak", groups), []);
    assert.deepEqual(aliasVariants("salon", []), []);
    assert.deepEqual(aliasVariants("", groups), []);
  });
  test("a word inside a longer name does not count", () => {
    assert.deepEqual(aliasVariants("salon lambası", groups), []);
  });
});

// ------------------------------------------------------------------ pattern syntax

describe("pattern groups and <sayi>", () => {
  const groups = { on: ["aç", "açar mısın"] };
  const matches = (src: string, folded: string) => compilePattern(src, 4, groups).regex.test(`${folded} `);

  test("{@group} expands, mixes with literals and may be optional", () => {
    assert.ok(matches("<ad> {@on}", "salon acar misin"));
    assert.ok(matches("<ad> {@on|yak}", "salon yak"));
    assert.ok(matches("<ad> x {@on|}", "salon x"));
    assert.ok(!matches("<ad> {@on}", "salon kapat"));
  });

  test("<sayi> captures 1..3 digits", () => {
    const p = compilePattern("<ad> {yüzde|} <sayi> yap", 4);
    assert.equal(p.hasNumber, true);
    assert.equal(p.regex.exec("salon yuzde 50 yap ")?.groups?.sayi, "50");
    assert.equal(p.regex.exec("salon 7 yap ")?.groups?.sayi, "7");
    assert.ok(!p.regex.test("salon 1000 yap "));
    assert.ok(!p.regex.test("salon elli yap "));
  });

  test("invalid group / placeholder use throws", () => {
    assert.throws(() => compilePattern("<ad> {@nope}", 4, groups), /unknown group @nope/);
    assert.throws(() => compilePattern("<sayi> <sayi>", 4), /only one <sayi>/);
  });

  test("brightness over 100 does not match, 100 does", () => {
    const c = parseRouterConfig(
      JSON.stringify({
        version: 1,
        rules: [{ id: "lv", tier: 0, patterns: ["<ad> <sayi> yap"], service: "s", tool: "light__HassLightSet", domains: ["light"], reply: "ok" }],
      }),
    );
    const hit = (t: string) => matchRules(c, prepareText(t));
    const ok = hit("salon 100 yap");
    assert.ok(ok?.tier === 0 && ok.plan.brightness === 100);
    assert.equal(hit("salon 101 yap"), undefined);
  });

  test("name_stop_words reject a capture that holds one", () => {
    const c = parseRouterConfig(
      JSON.stringify({
        version: 1,
        direct: { name_stop_words: ["ve"] },
        rules: [{ id: "on", tier: 0, patterns: ["ışığı aç <ad>"], service: "s", tool: "intent__HassTurnOn", domains: ["light"], reply: "ok" }],
      }),
    );
    assert.equal(matchRules(c, prepareText("ışığı aç salon"))?.rule, "on");
    assert.equal(matchRules(c, prepareText("ışığı aç ve salon")), undefined);
  });
});

describe("router.yaml validation: groups, <sayi>, aliases", () => {
  const lightSet = (over: Record<string, unknown> = {}) => ({
    id: "lv",
    tier: 0,
    patterns: ["<ad> <sayi> yap"],
    service: "s",
    tool: "light__HassLightSet",
    domains: ["light"],
    reply: "ok",
    ...over,
  });
  const bad: [string, unknown, RegExp][] = [
    ["light-set pattern without <sayi>", { version: 1, rules: [lightSet({ patterns: ["<ad> yap"] })] }, /need <sayi>/],
    ["light-set pattern without <ad>", { version: 1, rules: [lightSet({ patterns: ["<sayi> yap"] })] }, /need <ad>/],
    [
      "<sayi> on a switch rule",
      { version: 1, rules: [lightSet({ tool: "intent__HassTurnOn", patterns: ["<ad> <sayi> aç"] })] },
      /only allowed with light__HassLightSet/,
    ],
    ["<sayi> on a tier 2 rule", { version: 1, rules: [{ id: "t2", tier: 2, patterns: ["* <sayi> *"] }] }, /only allowed with light__HassLightSet/],
    ["unknown group", { version: 1, rules: [lightSet({ patterns: ["<ad> <sayi> {@nope}"] })] }, /unknown group/],
    ["group name not kebab-case", { version: 1, groups: { Bad_Name: ["x"] } }, /groups/],
    ["empty group", { version: 1, groups: { g: [] } }, /groups\.g/],
    ["alias group of one", { version: 1, direct: { area_aliases: [["salon"]] } }, /area_aliases/],
  ];
  for (const [label, doc, re] of bad) {
    test(`rejects: ${label}`, () => {
      assert.throws(
        () => parseRouterConfig(JSON.stringify(doc)),
        (err: unknown) => err instanceof RouterConfigError && re.test(err.message),
      );
    });
  }

  test("defaults: no groups, no aliases, no name stop words", () => {
    const c = parseRouterConfig("version: 1");
    assert.deepEqual(c.direct.areaAliases, []);
    assert.equal(c.direct.nameStopWords.size, 0);
  });

  test("shipped router.yaml has the light-level rule and a salon / oturma odası alias group", () => {
    assert.ok(cfg.rules.some((r) => r.rule.id === "light-level"));
    assert.ok(cfg.direct.areaAliases.some((g) => g.includes("salon") && g.includes("oturma odası")));
    assert.ok(cfg.direct.nameStopWords.has("ve"));
  });
});

// ------------------------------------------------------------------ hostile / long input

describe("long input", () => {
  test("negative levels never produce a write plan", () => {
    for (const text of ["salon ışığını -20 yap", "salon ışığını %-20 yap"]) {
      const hit = matchRules(cfg, prepareText(text, cfg.fillers));
      assert.ok(hit === undefined || hit.tier !== 0, `${text}: ${JSON.stringify(hit)}`);
      assert.equal(route(text).direct, undefined, text);
    }
  });

  test("a long digit run is normalized in linear time", () => {
    // 50k digits: the old unbounded `(\d+)\s*%` took ~2 s here, the bounded form well under 1 ms.
    const digits = "1".repeat(50_000);
    for (const text of [digits, `${digits} x`, `${digits}%`, `%${digits}`, `-${digits}`, `${"1 ".repeat(10_000)}%`]) {
      const start = performance.now();
      cleanTurkish(text);
      route(text);
      const ms = performance.now() - start;
      assert.ok(ms < 500, `${text.slice(0, 20)}… (${text.length} chars) took ${ms.toFixed(0)} ms`);
    }
  });

  test("text over the cap never reaches tier 0; a command just under it still does", () => {
    const pad = "a ".repeat(10_000);
    const long = `${pad}salon ışığını aç`;
    const start = performance.now();
    assert.notEqual(route(long).tier, 0);
    assert.ok(performance.now() - start < 500);

    const name = "x".repeat(TIER0_MAX_CHARS - " ışığını aç".length);
    assert.equal(prepareText(`${name} ışığını aç`).folded.length, TIER0_MAX_CHARS);
    assert.equal(route(`${name} ışığını aç`).tier, 0);
    assert.notEqual(route(`${name}x ışığını aç`).tier, 0);
  });
});
