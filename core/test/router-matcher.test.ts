import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BASE_DENY_NAME_WORDS,
  checkRouterServices,
  compileLearnedRule,
  compileLearnedTokens,
  compilePattern,
  LEARNABLE_DOMAINS,
  LEARNABLE_TOOLS,
  learnableDomainsFor,
  loadRouterFile,
  matchLearnedRules,
  matchRules,
  NEVER_LEARNABLE_DOMAINS,
  parseRouterConfig,
  RouterConfigError,
  TIER0_MAX_CHARS,
  type CompiledLearnedRule,
  type LearnableTool,
} from "../src/router-config.js";
import { TieredRouter } from "../src/router.js";
import { cleanTurkish, fold, prepareText, stemCandidates } from "../src/turkish.js";

const ROUTER_YAML = fileURLToPath(new URL("../../router.yaml", import.meta.url));
const cfg = loadRouterFile(ROUTER_YAML);
const m = (text: string) => matchRules(cfg, prepareText(text, cfg.fillers));

/** Asserts a tier-0 match and returns its plan. */
function direct(text: string) {
  const hit = m(text);
  assert.ok(hit, `no match for '${text}'`);
  assert.equal(hit.tier, 0, `'${text}' matched ${hit.rule} at tier ${hit.tier}`);
  return { rule: hit.rule, plan: (hit as Extract<typeof hit, { tier: 0 }>).plan };
}

// ------------------------------------------------------------------ A) normalization

describe("prepareText", () => {
  const cases: [string, string][] = [
    ["İSTANBUL", "istanbul"],
    ["IŞIK", "ışık"],
    ["Işığı", "ışığı"],
    ["  Salon   ışığını aç!!! ", "salon ışığını aç"],
    ["Salon'u", "salon"],
    ["Salon’u", "salon"],
    ["Mutfak’taki", "mutfak"],
    ["Mutfak'taki", "mutfak"],
    ["", ""],
    ["!!!", ""],
  ];
  for (const [input, expected] of cases) {
    test(`'${input}' -> '${expected}'`, () => {
      assert.equal(prepareText(input).display, expected);
    });
  }

  test("fold is 1:1 (display and folded have equal length)", () => {
    const inputs = ["İSTANBUL çalışma ODASI", "ğüşiöç ĞÜŞİÖÇ", "Işığını AÇ", "Mutfağı kapat!", "âîû", "yatak odası"];
    for (const s of inputs) {
      assert.equal(fold(s).length, s.length, s);
      const p = prepareText(s);
      assert.equal(p.folded.length, p.display.length, s);
      assert.equal(p.folded, fold(p.display));
    }
  });

  test("fold maps Turkish letters to ASCII", () => {
    assert.equal(fold("ışığını aç çöğüş"), "isigini ac cogus");
  });

  test("cleanTurkish keeps digits and drops other punctuation", () => {
    assert.equal(cleanTurkish("Oda 2, ışık!"), "oda 2 ışık");
  });

  test("fillers are removed as whole words only", () => {
    const f = ["lütfen", "hadi"];
    const out = prepareText("lütfen salon ışığını aç lütfen", f).display;
    assert.equal(out, "salon ışığını aç");
    assert.ok(!out.includes("lütfen"));
    assert.equal(prepareText("Hadi salon", f).display, "salon");
    assert.equal(prepareText("LÜTFEN salon", f).display, "salon");
    assert.equal(prepareText("hadiye gidelim", f).display, "hadiye gidelim");
    assert.equal(prepareText("lütfenle salon", f).display, "lütfenle salon");
  });
});

// ------------------------------------------------------------------ B) stemCandidates

describe("stemCandidates", () => {
  const includes: [string, string][] = [
    ["salonu", "salon"],
    ["salonun", "salon"],
    ["salonda", "salon"],
    ["mutfağı", "mutfak"],
    ["mutfakta", "mutfak"],
    ["lambayı", "lamba"],
    ["kombiyi", "kombi"],
  ];
  for (const [input, expected] of includes) {
    test(`'${input}' includes '${expected}'`, () => {
      assert.ok(stemCandidates(input).includes(expected), JSON.stringify(stemCandidates(input)));
    });
  }

  test("'yatak odasını' includes 'yatak odası'", () => {
    assert.ok(stemCandidates("yatak odasını").includes("yatak odası"), JSON.stringify(stemCandidates("yatak odasını")));
  });

  test("only the last word is stemmed; head words are preserved", () => {
    for (const c of stemCandidates("yatak odasını")) assert.ok(c.startsWith("yatak "), c);
    for (const c of stemCandidates("çalışma odasında")) assert.ok(c.startsWith("çalışma "), c);
  });

  test("first candidate is always the input", () => {
    for (const s of ["salonu", "yatak odasını", "mutfağı", "ev", "lambayı", "su ısıtıcısını"]) {
      assert.equal(stemCandidates(s)[0], s);
    }
  });

  test("short words stay unchanged", () => {
    assert.deepEqual(stemCandidates("ev"), ["ev"]);
    assert.deepEqual(stemCandidates("ütü"), ["ütü"]);
  });

  test("empty input yields no candidates", () => {
    assert.deepEqual(stemCandidates(""), []);
  });
});

// ------------------------------------------------------------------ C) tier 0 matches

describe("tier 0: lights and devices", () => {
  const cases: [string, string, string, string][] = [
    // text, rule, name, tool
    ["salon ışığını aç", "light-on", "salon", "intent__HassTurnOn"],
    ["Salon Işığını Aç", "light-on", "salon", "intent__HassTurnOn"],
    ["SALON IŞIĞINI AÇ", "light-on", "salon", "intent__HassTurnOn"],
    ["salon isigini ac", "light-on", "salon", "intent__HassTurnOn"],
    ["salon ışığı aç", "light-on", "salon", "intent__HassTurnOn"],
    ["salon lambasını aç", "light-on", "salon", "intent__HassTurnOn"],
    ["salon lambası aç", "light-on", "salon", "intent__HassTurnOn"],
    ["salon ışıklarını yak", "light-on", "salon", "intent__HassTurnOn"],
    ["yatak odası lambasını açar mısın?", "light-on", "yatak odası", "intent__HassTurnOn"],
    ["lütfen mutfak ışığını açabilir misin", "light-on", "mutfak", "intent__HassTurnOn"],
    ["çalışma odası ışığını aç", "light-on", "çalışma odası", "intent__HassTurnOn"],
    ["salon ışığını kapat", "light-off", "salon", "intent__HassTurnOff"],
    ["mutfak lambasını söndür", "light-off", "mutfak", "intent__HassTurnOff"],
    ["salon ışığını kapatır mısın", "light-off", "salon", "intent__HassTurnOff"],
    ["SALON IŞIKLARINI KAPAT.", "light-off", "salon", "intent__HassTurnOff"],
    ["salon'u aç", "device-on", "salon", "intent__HassTurnOn"],
    ["salonu aç", "device-on", "salonu", "intent__HassTurnOn"],
    ["su ısıtıcısını aç", "device-on", "su ısıtıcısını", "intent__HassTurnOn"],
    ["mutfağı kapat", "device-off", "mutfağı", "intent__HassTurnOff"],
    ["kombi'yi kapat", "device-off", "kombi", "intent__HassTurnOff"],
    ["Fan’ı kapat", "device-off", "fan", "intent__HassTurnOff"],
    ["televizyonu kapatır mısın", "device-off", "televizyonu", "intent__HassTurnOff"],
  ];
  for (const [text, rule, name, tool] of cases) {
    test(`'${text}' -> ${rule} (${name})`, () => {
      const hit = direct(text);
      assert.equal(hit.rule, rule);
      assert.equal(hit.plan.rule, rule);
      assert.equal(hit.plan.name, name);
      assert.equal(hit.plan.tool, tool);
      assert.equal(hit.plan.service, "home-assistant");
    });
  }

  test("light rules carry domains and keywords", () => {
    const { plan } = direct("salon ışığını aç");
    assert.deepEqual(plan.domains, ["light", "switch"]);
    assert.ok(plan.keywords.includes("ışık"));
    assert.deepEqual(direct("fan kapat").plan.domains, ["light", "switch", "fan"]);
  });
});

describe("tier 0: sensors", () => {
  const home: [string, string, string][] = [
    ["evde sıcaklık kaç", "temperature-home", "temperature"],
    ["Evde sıcaklık kaç derece?", "temperature-home", "temperature"],
    ["sıcaklık ne kadar", "temperature-home", "temperature"],
    ["ev sıcaklığı nedir", "temperature-home", "temperature"],
    ["nem ne kadar", "humidity-home", "humidity"],
    ["evde nem kaç", "humidity-home", "humidity"],
  ];
  for (const [text, rule, sensor] of home) {
    test(`'${text}' -> ${rule}`, () => {
      const hit = direct(text);
      assert.equal(hit.rule, rule);
      assert.equal(hit.plan.name, undefined);
      assert.equal(hit.plan.defaultName, "ev");
      assert.equal(hit.plan.sensor, sensor);
      assert.equal(hit.plan.tool, "homeassistant__GetLiveContext");
    });
  }

  const place: [string, string, string, string][] = [
    ["mutfak sıcaklığı kaç", "temperature-place", "mutfak", "temperature"],
    ["salonda sıcaklık kaç", "temperature-place", "salonda", "temperature"],
    ["yatak odası kaç derece", "temperature-place", "yatak odası", "temperature"],
    ["salon nemi kaç", "humidity-place", "salon", "humidity"],
  ];
  for (const [text, rule, name, sensor] of place) {
    test(`'${text}' -> ${rule} (${name})`, () => {
      const hit = direct(text);
      assert.equal(hit.rule, rule);
      assert.equal(hit.plan.name, name);
      assert.equal(hit.plan.sensor, sensor);
      assert.equal(hit.plan.defaultName, undefined);
    });
  }
});

// ------------------------------------------------------------------ D) must not match tier 0

describe("not tier 0", () => {
  const texts = [
    "ışığı ne zaman açtım",
    "kapat şunu",
    "şunu kapat",
    "bunu aç",
    "ışığı aç",
    "ışıkları kapat",
    "hepsini kapat",
    "salon ışığı açık mı",
    "salon ışığını açtın mı",
    "bugün hava nasıl",
    "merhaba",
    "",
    "   ",
    "!!!",
    "bir iki üç dört beş ışığını aç",
    "bir iki üç dört beş altı kapat",
  ];
  for (const t of texts) {
    test(`'${t}'`, () => {
      assert.notEqual(m(t)?.tier, 0);
    });
  }

  test("compound command never captures ' ve ' in a name", () => {
    const hit = m("salon ışığını aç ve mutfağı kapat");
    if (hit?.tier === 0) {
      assert.ok(!(hit.plan.name ?? "").includes(" ve "), hit.plan.name);
    }
    // Documented behaviour: the name would need 5 words (max_name_words is 4), so nothing matches.
    assert.equal(hit, undefined);
  });

  test("a name of exactly max_name_words (4) words still matches", () => {
    assert.equal(direct("bir iki üç dört ışığını aç").plan.name, "bir iki üç dört");
  });
});

// ------------------------------------------------------------------ E) tier 3 / tier 2

describe("tier 3 and tier 2 rules", () => {
  for (const t of ["bana derinlemesine analiz yap", "bunun detaylı incelemesini yap", "yarın için plan yap", "adım adım plan çıkar"]) {
    test(`tier 3: '${t}'`, () => {
      assert.equal(m(t)?.tier, 3);
      assert.equal(m(t)?.rule, "deep-analysis");
    });
  }
  for (const t of ["iki seçeneği karşılaştır", "şu yazıyı özetle"]) {
    test(`tier 2: '${t}'`, () => {
      assert.equal(m(t)?.tier, 2);
      assert.equal(m(t)?.rule, "long-form");
    });
  }
  for (const t of ["planladığım şey ne", "plan nedir"]) {
    test(`not tier 3: '${t}'`, () => {
      assert.notEqual(m(t)?.tier, 3);
    });
  }
});

// ------------------------------------------------------------------ F) TieredRouter

describe("TieredRouter.route", () => {
  const router = new TieredRouter({ config: cfg, models: { 1: "m1", 2: "m2", 3: "m3" } });
  const input = (text: string) => ({ text, source: "text" as const, device: "test-device" });

  test("tier 0 text", () => {
    const d = router.route(input("salon ışığını aç"));
    assert.equal(d.tier, 0);
    assert.equal(d.model, "m1");
    assert.ok(d.direct);
    assert.equal(d.direct.name, "salon");
    assert.equal(d.fallbackOnError, true);
    assert.deepEqual(d.escalateTo, { tier: 2, model: "m2" });
    assert.equal(d.rule, "light-on");
  });

  test("plain chat goes to tier 1 with escalation", () => {
    const d = router.route(input("merhaba nasılsın"));
    assert.equal(d.tier, 1);
    assert.equal(d.model, "m1");
    assert.deepEqual(d.escalateTo, { tier: 2, model: "m2" });
    assert.equal(d.rule, "default");
    assert.equal(d.direct, undefined);
  });

  test("31+ word sentence goes to tier 2 (long_input)", () => {
    const d = router.route(input(Array.from({ length: 31 }, () => "kelime").join(" ")));
    assert.equal(d.tier, 2);
    assert.equal(d.model, "m2");
    assert.equal(d.rule, "long_input");
  });

  test("exactly 30 words stays on tier 1", () => {
    const d = router.route(input(Array.from({ length: 30 }, () => "kelime").join(" ")));
    assert.equal(d.tier, 1);
  });

  test("tier 3 text", () => {
    const d = router.route(input("bana derinlemesine analiz yap"));
    assert.equal(d.tier, 3);
    assert.equal(d.model, "m3");
    assert.equal(d.escalateTo, undefined);
    assert.equal(d.rule, "deep-analysis");
  });

  test("tier 2 rule text", () => {
    const d = router.route(input("şu yazıyı özetle"));
    assert.equal(d.tier, 2);
    assert.equal(d.model, "m2");
    assert.equal(d.escalateTo, undefined);
  });

  test("empty text goes to tier 1 default", () => {
    const d = router.route(input("   "));
    assert.equal(d.tier, 1);
    assert.equal(d.rule, "default");
  });
});

// ------------------------------------------------------------------ G) config validation

describe("parseRouterConfig validation", () => {
  const switchRule = (over: Record<string, unknown> = {}) => ({
    id: "r1",
    tier: 0,
    patterns: ["<ad> aç"],
    service: "svc",
    tool: "intent__HassTurnOn",
    domains: ["light"],
    reply: "ok",
    ...over,
  });
  const sensorRule = (over: Record<string, unknown> = {}) => ({
    id: "s1",
    tier: 0,
    patterns: ["sıcaklık kaç"],
    service: "svc",
    tool: "homeassistant__GetLiveContext",
    sensor: "temperature",
    reply: "ok",
    ...over,
  });
  const without = (obj: Record<string, unknown>, key: string) => {
    const copy = { ...obj };
    delete copy[key];
    return copy;
  };
  // JSON is valid YAML.
  const doc = (rules: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ version: 1, rules, ...extra });

  const bad: [string, string, RegExp][] = [
    ["unknown top-level key", JSON.stringify({ version: 1, bogus: true }), /bogus/],
    ["version 2", JSON.stringify({ version: 2 }), /version/],
    ["tier 0 without service", doc([without(switchRule(), "service")]), /rules\.0\.service/],
    ["tier 0 without reply", doc([without(switchRule(), "reply")]), /rules\.0\.reply/],
    ["tier 0 without tool", doc([without(switchRule(), "tool")]), /rules\.0\.tool/],
    ["switch rule without domains", doc([without(switchRule(), "domains")]), /rules\.0\.domains/],
    ["switch pattern without <ad>", doc([switchRule({ patterns: ["salon aç"] })]), /rules\.0\.patterns\.0/],
    ["unknown tool", doc([switchRule({ tool: "intent__HassUnknown" })]), /rules\.0\.tool/],
    ["GetLiveContext without sensor", doc([without(sensorRule(), "sensor")]), /rules\.0\.sensor/],
    ["sensor on switch rule", doc([switchRule({ sensor: "temperature" })]), /rules\.0\.sensor/],
    ["domains on tier 2 rule", doc([{ id: "t2", tier: 2, patterns: ["* x *"], domains: ["light"] }]), /rules\.0\.domains/],
    ["domains on sensor rule", doc([sensorRule({ domains: ["light"] })]), /rules\.0\.domains/],
    ["duplicate rule id", doc([switchRule(), switchRule()]), /duplicate/],
    ["invalid id 'Light On'", doc([switchRule({ id: "Light On" })]), /rules\.0\.id/],
    ["unbalanced '{'", doc([switchRule({ patterns: ["<ad> {aç|kapat"] })]), /rules\.0\.patterns\.0/],
    ["two <ad>", doc([switchRule({ patterns: ["<ad> <ad> aç"] })]), /<ad>/],
    ["<isim> placeholder", doc([switchRule({ patterns: ["<ad> <isim> aç"] })]), /<isim>/],
    ["empty patterns list", doc([switchRule({ patterns: [] })]), /rules\.0\.patterns/],
    ["max_name_words out of range", JSON.stringify({ version: 1, direct: { max_name_words: 99 } }), /max_name_words/],
    ["unknown key in rule", doc([switchRule({ extra: 1 })]), /extra/],
  ];
  for (const [label, text, re] of bad) {
    test(`rejects: ${label}`, () => {
      assert.throws(
        () => parseRouterConfig(text),
        (err: unknown) => {
          assert.ok(err instanceof RouterConfigError, String(err));
          assert.match(err.message, re);
          assert.ok(err.problems.length >= 1);
          return true;
        },
      );
    });
  }

  test("rejects invalid YAML with a YAML message", () => {
    assert.throws(
      () => parseRouterConfig("rules: ["),
      (err: unknown) => err instanceof RouterConfigError && /YAML/.test(err.message),
    );
  });

  test("minimal valid config parses with defaults", () => {
    const c = parseRouterConfig("version: 1");
    assert.equal(c.direct.onToolError, "fallback");
    assert.equal(c.direct.enabled, true);
    assert.equal(c.direct.maxItems, 4);
    assert.equal(c.tier1.maxWords, 30);
    assert.equal(c.escalation.enabled, true);
    assert.deepEqual(c.fillers, []);
    assert.deepEqual(c.rules, []);
    assert.equal(c.direct.stopNames.size, 0);
  });

  test("valid switch and sensor rules compile", () => {
    const c = parseRouterConfig(doc([switchRule(), sensorRule()]));
    assert.equal(c.rules.length, 2);
    assert.equal(c.rules[0]?.patterns.length, 1);
  });

  test("stop_names are normalized (folded)", () => {
    const c = parseRouterConfig(JSON.stringify({ version: 1, direct: { stop_names: ["Şunu"] } }));
    assert.ok(c.direct.stopNames.has("sunu"));
  });

  test("loadRouterFile on a missing path throws RouterConfigError", () => {
    assert.throws(
      () => loadRouterFile(fileURLToPath(new URL("../../does-not-exist.yaml", import.meta.url))),
      (err: unknown) => err instanceof RouterConfigError && /cannot read/.test(err.message),
    );
  });

  test("real router.yaml loads with the expected rules", () => {
    assert.deepEqual(
      cfg.rules.map((r) => r.rule.id),
      ["light-on", "light-off", "light-level", "device-on", "device-off", "temperature-home", "temperature-place", "humidity-home", "humidity-place", "deep-analysis", "long-form"],
    );
  });
});

// ------------------------------------------------------------------ H) compilePattern

describe("compilePattern", () => {
  const matches = (src: string, folded: string, max = 4) => compilePattern(src, max).regex.test(`${folded} `);

  test("optional group matches with and without", () => {
    assert.ok(matches("{evde|} sıcaklık", "evde sicaklik"));
    assert.ok(matches("{evde|} sıcaklık", "sicaklik"));
    assert.ok(!matches("{evde|} sıcaklık", "salonda sicaklik"));
  });

  test("alternatives, including multi-word ones", () => {
    assert.ok(matches("{aç|açar mısın} x", "ac x"));
    assert.ok(matches("{aç|açar mısın} x", "acar misin x"));
    assert.ok(!matches("{aç|açar mısın} x", "acar x"));
  });

  test("prefix words", () => {
    assert.ok(matches("plan* x", "plan x"));
    assert.ok(matches("plan* x", "planla x"));
    assert.ok(matches("plan* x", "plani x"));
    assert.ok(!matches("plan* x", "aplan x"));
  });

  test("'*' matches zero or more words", () => {
    assert.ok(matches("* x", "x"));
    assert.ok(matches("* x", "a x"));
    assert.ok(matches("* x", "a b c x"));
    assert.ok(matches("a * b", "a b"));
    assert.ok(matches("a * b", "a q r b"));
  });

  test("regex is anchored on both ends", () => {
    assert.ok(!matches("x y", "x y z"));
    assert.ok(!matches("x y", "z x y"));
    assert.ok(matches("x y", "x y"));
  });

  test("literal words match folded forms", () => {
    assert.ok(matches("ışığını aç", "isigini ac"));
  });

  test("<ad> capture respects max words and reports hasName", () => {
    const p = compilePattern("<ad> aç", 2);
    assert.equal(p.hasName, true);
    assert.ok(p.regex.test("a b ac "));
    assert.ok(!p.regex.test("a b c ac "));
    assert.equal(compilePattern("aç", 2).hasName, false);
  });

  test("invalid patterns throw", () => {
    assert.throws(() => compilePattern("", 4), /empty/);
    assert.throws(() => compilePattern("{a|b", 4), /stray|unbalanced/);
    assert.throws(() => compilePattern("<ad> <ad>", 4), /only one <ad>/);
    assert.throws(() => compilePattern("<isim> x", 4), /<isim>/);
    assert.throws(() => compilePattern("{|} x", 4), /empty group/);
  });
});

// ------------------------------------------------------------------ I) checkRouterServices

describe("checkRouterServices", () => {
  test("no warnings when home-assistant is enabled", () => {
    assert.deepEqual(checkRouterServices(cfg, ["home-assistant"]), []);
  });

  test("warnings mention rule ids when no service is enabled", () => {
    const warnings = checkRouterServices(cfg, []);
    for (const id of ["light-on", "light-off", "device-on", "device-off", "temperature-home", "temperature-place", "humidity-home", "humidity-place"]) {
      assert.ok(
        warnings.some((w) => w.includes(`'${id}'`)),
        id,
      );
    }
    assert.ok(warnings.every((w) => w.includes("home-assistant")));
    assert.ok(!warnings.some((w) => w.includes("deep-analysis")));
  });

  test("tier services that are not enabled produce warnings", () => {
    const c = parseRouterConfig("version: 1\ntier1:\n  services: [nope]\n");
    const warnings = checkRouterServices(c, ["home-assistant"]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /tier1\.services.*nope/);
  });
});

// ------------------------------------------------------------------ I) learning block and learned patterns (T7.w.2a)

describe("learning config (T7.w.2a)", () => {
  const learn = (learning: Record<string, unknown>) => JSON.stringify({ version: 1, learning });

  const bad: [string, string, RegExp][] = [
    ["a tool outside the ceiling", learn({ tools: ["intent__HassTurnOn", "lock__HassLock"] }), /learning\.tools\.1: 'lock__HassLock' is not learnable/],
    ["GetLiveContext as a learnable tool", learn({ tools: ["homeassistant__GetLiveContext"] }), /learning\.tools\.0/],
    ["a never-learnable domain", learn({ domains: ["light", "lock"] }), /learning\.domains\.1: 'lock' is never learnable/],
    ["alarm_control_panel", learn({ domains: ["alarm_control_panel"] }), /never learnable/],
    ["cover (garage doors, blinds)", learn({ domains: ["cover"] }), /never learnable/],
    ["valve", learn({ domains: ["valve"] }), /never learnable/],
    ["fan (static tier 0, not learnable)", learn({ domains: ["fan"] }), /learning\.domains\.0: 'fan' is not a learnable domain/],
    ["keywords for a never-learnable domain", learn({ keywords: { lock: ["kilit"] } }), /learning\.keywords\.lock/],
    // rules.json accepts only single words of at most 64 characters; a keyword it would refuse
    // must fail here, not quarantine every stored rule at the next start.
    ["a keyword with a space", learn({ keywords: { light: ["ışık", "tavan lambası"] } }), /learning\.keywords\.light\.1: must be a single word/],
    ["a keyword longer than 64 characters", learn({ keywords: { light: ["a".repeat(65)] } }), /learning\.keywords\.light\.0: must be a single word/],
    ["unknown key", learn({ auto_activate: true }), /auto_activate/],
    ["unknown reply tool", learn({ replies: { lock__HassLock: "x" } }), /lock__HassLock/],
    ["min_observations 1", learn({ min_observations: 1 }), /min_observations/],
    ["max_failures 0", learn({ max_failures: 0 }), /max_failures/],
  ];
  for (const [label, text, re] of bad) {
    test(`startup fails: ${label}`, () => {
      assert.throws(
        () => parseRouterConfig(text),
        (err: unknown) => {
          assert.ok(err instanceof RouterConfigError, String(err));
          assert.match(err.message, re);
          return true;
        },
      );
    });
  }

  test("defaults: on, the full ceiling, 3 / 3, base deny words always present", () => {
    const c = parseRouterConfig("version: 1");
    assert.equal(c.learning.enabled, true);
    assert.equal(c.learning.minObservations, 3);
    assert.equal(c.learning.maxFailures, 3);
    assert.deepEqual([...c.learning.tools], [...LEARNABLE_TOOLS]);
    assert.deepEqual([...c.learning.domains], [...LEARNABLE_DOMAINS]);
    for (const w of BASE_DENY_NAME_WORDS) assert.ok(c.learning.denyNameWords.has(fold(w)), w);
    assert.match(c.learning.replies.light__HassLightSet, /\{seviye\}/);
  });

  test("router.yaml can narrow; an empty deny list never removes the base words", () => {
    const c = parseRouterConfig(learn({ tools: ["intent__HassTurnOn"], domains: ["light"], deny_name_words: [] }));
    assert.deepEqual([...c.learning.tools], ["intent__HassTurnOn"]);
    assert.deepEqual([...c.learning.domains], ["light"]);
    assert.ok(c.learning.denyNameWords.has("kapi"));
    assert.ok(c.learning.denyNameWords.has("kilit"));
  });

  test("extra deny words are folded and added", () => {
    const c = parseRouterConfig(learn({ deny_name_words: ["Şofben"] }));
    assert.ok(c.learning.denyNameWords.has("sofben"));
    assert.ok(c.learning.denyNameWords.has("garaj"));
  });

  test("brightness is learnable on lights only; never-learnable domains never come back", () => {
    const all = new Set(["light", "switch", "media_player", "lock", "cover"]);
    assert.deepEqual(learnableDomainsFor("light__HassLightSet", all), ["light"]);
    assert.deepEqual(learnableDomainsFor("intent__HassTurnOn", all), ["light", "switch", "media_player"]);
    assert.deepEqual(learnableDomainsFor("intent__HassTurnOn", new Set(["switch"])), ["switch"]);
    assert.deepEqual(learnableDomainsFor("lock__HassLock", all), []);
    for (const d of ["lock", "alarm_control_panel", "cover", "valve", "garage_door", "siren", "climate"]) assert.ok(NEVER_LEARNABLE_DOMAINS.has(d), d);
  });

  test("the shipped router.yaml learning block stays inside the ceiling", () => {
    assert.equal(cfg.learning.enabled, true);
    for (const d of cfg.learning.domains) assert.ok(!NEVER_LEARNABLE_DOMAINS.has(d), d);
    assert.ok(cfg.learning.keywords.light && cfg.learning.keywords.light.length > 0);
  });
});

describe("learned patterns (T7.w.2a)", () => {
  const rule = (tokens: string[], tool: LearnableTool = "light__HassLightSet", domains = ["light"]): CompiledLearnedRule =>
    compileLearnedRule({ id: "lr-00000001", tokens, service: "home-assistant", tool, domains, keywords: ["lamba"] }, cfg.direct.maxNameWords);
  const textOf = (s: string) => prepareText(s, cfg.fillers);

  test("compiles and matches like the equivalent static pattern", () => {
    const learned = rule(["<ad>", "parlaklığı", "yüzde", "<sayi>", "olsun"]);
    const stat = compilePattern("<ad> parlaklığı yüzde <sayi> olsun", cfg.direct.maxNameWords);
    assert.equal(learned.pattern.regex.source, stat.regex.source);
    const hit = matchLearnedRules(cfg, [learned], textOf("Salon lambası parlaklığı yüzde 40 olsun"));
    assert.ok(hit);
    assert.equal(hit.plan.rule, "learned:lr-00000001");
    assert.equal(hit.plan.name, "salon lambası");
    assert.equal(hit.plan.brightness, 40);
    assert.equal(hit.plan.tool, "light__HassLightSet");
    assert.deepEqual(hit.plan.domains, ["light"]);
    assert.equal(hit.plan.permission, undefined);
    assert.match(hit.plan.reply, /\{seviye\}/);
  });

  test("the shared capture checks apply: stop names, name stop words, level over 100, TIER0_MAX_CHARS", () => {
    const learned = rule(["<ad>", "parlaklığı", "yüzde", "<sayi>", "olsun"]);
    assert.equal(matchLearnedRules(cfg, [learned], textOf("şunu parlaklığı yüzde 40 olsun")), undefined);
    assert.equal(matchLearnedRules(cfg, [learned], textOf("salon ve mutfak parlaklığı yüzde 40 olsun")), undefined);
    assert.equal(matchLearnedRules(cfg, [learned], textOf("salon parlaklığı yüzde 150 olsun")), undefined);
    const long = `${"a".repeat(TIER0_MAX_CHARS)} parlaklığı yüzde 40 olsun`;
    assert.equal(matchLearnedRules(cfg, [learned], textOf(long)), undefined);
  });

  test("a narrowed learning block disables a stored rule (tool or domain) instead of widening", () => {
    const narrowed = parseRouterConfig(JSON.stringify({ version: 1, learning: { tools: ["intent__HassTurnOn"], domains: ["light"] } }));
    const set = rule(["<ad>", "parlaklığı", "yüzde", "<sayi>", "olsun"]);
    assert.equal(matchLearnedRules(narrowed, [set], textOf("salon parlaklığı yüzde 40 olsun")), undefined);
    const plug = rule(["<ad>", "fişini", "tak"], "intent__HassTurnOn", ["switch"]);
    assert.equal(matchLearnedRules(narrowed, [plug], textOf("mutfak fişini tak")), undefined);
    assert.ok(matchLearnedRules(cfg, [plug], textOf("mutfak fişini tak")));
  });

  test("invalid token arrays never compile", () => {
    const bad: [string[], string][] = [
      [[], "light__HassLightSet"],
      [["parlaklığı", "<sayi>"], "light__HassLightSet"],
      [["<ad>", "<ad>", "<sayi>"], "light__HassLightSet"],
      [["<ad>", "aç"], "light__HassLightSet"],
      [["<ad>", "<sayi>", "aç"], "intent__HassTurnOn"],
      [["<ad>", "{aç|kapat}"], "intent__HassTurnOn"],
      [["<ad>", "*"], "intent__HassTurnOn"],
      [["<ad>", "a|b"], "intent__HassTurnOn"],
      [["<ad>", "@open"], "intent__HassTurnOn"],
      [["<ad>", "Aç"], "intent__HassTurnOn"],
      [["<ad>", "aç kapat"], "intent__HassTurnOn"],
      [["<ad>", "<isim>"], "intent__HassTurnOn"],
    ];
    for (const [tokens, tool] of bad) assert.throws(() => compileLearnedTokens(tokens, tool, 4), Error, JSON.stringify(tokens));
    assert.doesNotThrow(() => compileLearnedTokens(["<ad>", "fişini", "tak"], "intent__HassTurnOn", 4));
  });

  test("first active rule in the given order wins", () => {
    const def = { tokens: ["<ad>", "fişini", "tak"], service: "home-assistant", domains: ["switch"], keywords: [] };
    const a = compileLearnedRule({ ...def, id: "lr-0000000a", tool: "intent__HassTurnOn" }, 4);
    const b = compileLearnedRule({ ...def, id: "lr-0000000b", tool: "intent__HassTurnOff" }, 4);
    assert.equal(matchLearnedRules(cfg, [a, b], textOf("mutfak fişini tak"))?.plan.rule, "learned:lr-0000000a");
  });
});
