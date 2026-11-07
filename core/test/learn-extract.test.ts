/**
 * T7.w.2b: pattern extraction (pure, no I/O). Generic names only.
 * T7.w.9: the cross-check (the `<ad>` span is the model's one target) and
 * name words before device words (the "prizma" / "lambada" residual).
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runDirectPlan } from "../src/direct.js";
import { checkTurn, extractPattern, isDenyWord, learnPolicy, learnTargetFilter, type LearnPolicy, type ObservedCall, type ObservedTurn } from "../src/learn/extract.js";
import type { LiveEntity } from "../src/live-context.js";
import { prepareNumbers } from "../src/numbers.js";
import {
  compileLearnedRule,
  isLearnableDomain,
  LEARNED_WORD,
  loadRouterFile,
  matchLearnedRules,
  NEVER_LEARNABLE_DOMAINS,
  parseRouterConfig,
  type DirectPlan,
  type MatchText,
} from "../src/router-config.js";
import { parseServices } from "../src/services.js";
import { prepareText } from "../src/turkish.js";

const YAML = `
version: 1
fillers: [lütfen]
direct:
  stop_names: [şunu]
  name_stop_words: [ve]
learning:
  keywords:
    light: [ışık, lamba, lambası]
    switch: [priz]
`;
const config = parseRouterConfig(YAML);
const services = parseServices(
  [
    "services:",
    "  - name: home-assistant",
    "    kind: mcp",
    "    url: http://localhost:1/sse",
    "    permission: confirm",
    "    confirm_inputs:",
    "      domain: [lock]",
    "      device_class: [garage, TV]",
  ].join("\n"),
  {},
).services;
const policy: LearnPolicy = learnPolicy(config, services);
const noConfirmClasses: LearnPolicy = { config, confirmDeviceClasses: new Set() };

const ent = (names: string, domain: string, extra: Partial<LiveEntity> = {}): LiveEntity => ({
  names: names.split(", "),
  domain,
  state: "off",
  areas: [],
  attributes: {},
  ...extra,
});

const ENTITIES: LiveEntity[] = [
  ent("Salon Lamba", "light", { areas: ["Salon"] }),
  ent("Mutfak Lamba", "light"),
  ent("Lamba 2", "light"),
  ent("Kitaplık Lamba", "light"),
  ent("Şunu", "light"),
  ent("Tavan", "light", { areas: ["Garaj"] }),
  ent("Kahve Prizi", "switch", { attributes: { device_class: "outlet" } }),
  ent("Bahçe Rölesi", "switch"),
  ent("Avlu Rölesi", "switch", { attributes: { device_class: "door" } }),
  ent("Garaj Kapısı", "switch", { attributes: { device_class: "outlet" } }),
  ent("Salon Tv", "media_player", { attributes: { device_class: "tv" } }),
  ent("Mutfak Radyo", "media_player", { attributes: { device_class: "speaker" } }),
  ent("Ön Kapı", "lock"),
  ent("Tavan Lambası", "light", { areas: ["Oturma"] }),
  ent("Bahçekapısı Prizi", "switch", { attributes: { device_class: "outlet" } }),
  ent("Garage Plug", "switch", { attributes: { device_class: "outlet" } }),
];

/** The text the router matches on: number words as digits when there are any. */
function textOf(s: string): MatchText {
  const prepared = prepareText(s, config.fillers);
  return prepareNumbers(prepared) ?? prepared;
}

const action = (tool: string, args: Record<string, unknown>, over: Partial<ObservedCall> = {}): ObservedCall => ({
  service: "home-assistant",
  tool,
  args,
  level: "write",
  allowed: true,
  isError: false,
  ...over,
});
const read: ObservedCall = { service: "home-assistant", tool: "homeassistant__GetLiveContext", args: {}, level: "read", allowed: true, isError: false };

const extract = (s: string, call: ObservedCall, p: LearnPolicy = policy) => extractPattern(textOf(s), call, ENTITIES, p);
const setLevel = (name: string, brightness: number) => action("light__HassLightSet", { name, domain: ["light"], brightness });
const turnOn = (name: string, domain: string) => action("intent__HassTurnOn", { name, domain: [domain] });

function learned(s: string, call: ObservedCall, p: LearnPolicy = policy) {
  const r = extract(s, call, p);
  assert.ok(r.ok, `expected a pattern for '${s}', got ${r.ok ? "" : r.reason}`);
  return r.value;
}
function rejected(s: string, call: ObservedCall, p: LearnPolicy = policy) {
  const r = extract(s, call, p);
  assert.ok(!r.ok, `expected no pattern for '${s}', got ${r.ok ? r.value.tokens.join(" ") : ""}`);
  return r.reason;
}

describe("extractPattern: slots", () => {
  test("number slot: brightness becomes <sayi>, the name <ad>; names and numbers are not stored", () => {
    const v = learned("Salon lambası parlaklığı yüzde 40 olsun", setLevel("Salon Lamba", 40));
    assert.deepEqual(v.tokens, ["<ad>", "lambası", "parlaklığı", "yüzde", "<sayi>", "olsun"]);
    assert.equal(v.tool, "light__HassLightSet");
    assert.deepEqual(v.domains, ["light"]);
    assert.deepEqual(v.binding, { name: "ad", brightness: "sayi" });
    assert.equal(v.signature, "home-assistant|light__HassLightSet|light|name=ad|brightness=sayi");
    const json = JSON.stringify(v);
    assert.ok(!/salon|40/i.test(json), json);
  });

  test("a second room with another number is the same pattern and signature", () => {
    const a = learned("salon lambası parlaklığı yüzde 40 olsun", setLevel("Salon Lamba", 40));
    const b = learned("mutfak lambası parlaklığı yüzde 70 olsun", setLevel("Mutfak Lamba", 70));
    assert.deepEqual(a.tokens, b.tokens);
    assert.equal(a.signature, b.signature);
  });

  test("number words were turned into digits by the router's own normalizer", () => {
    const v = learned("salon lambası parlaklığı yüzde elli olsun", setLevel("Salon Lamba", 50));
    assert.deepEqual(v.tokens, ["<ad>", "lambası", "parlaklığı", "yüzde", "<sayi>", "olsun"]);
  });

  test("a device name holding a digit ('Lamba 2') with a brightness: the digit stays in the name", () => {
    const v = learned("lamba 2 parlaklığı yüzde 40 olsun", setLevel("Lamba 2", 40));
    assert.deepEqual(v.tokens, ["<ad>", "parlaklığı", "yüzde", "<sayi>", "olsun"]);
  });

  test("stray number: a digit no argument explains", () => {
    assert.equal(rejected("salon lambası 2 dakika sonra açılsın", turnOn("Salon Lamba", "light")), "stray_number");
  });

  test("number not in text: a relative change", () => {
    assert.equal(rejected("salon lambasını biraz kıs", setLevel("Salon Lamba", 30)), "number_not_in_text");
  });

  test("name span not found: the target is not in the utterance", () => {
    assert.equal(rejected("yüzde elli yap", setLevel("Salon Lamba", 50)), "name_not_in_text");
  });

  test("nested spans of the same target: the widest one is <ad>", () => {
    // "kitaplık" alone also resolves (keyword), leaving "lamba" as a literal; the whole name wins.
    assert.deepEqual(learned("kitaplık lamba açılsın", turnOn("Kitaplık Lamba", "light")).tokens, ["<ad>", "açılsın"]);
  });

  test("name span ambiguous: two spans side by side give the same call", () => {
    // Both names are device words, so neither is a name word in the other's pattern.
    const both = [ent("Lamba, Işık", "light")];
    const r = extractPattern(textOf("lamba ışık açılsın"), turnOn("Lamba", "light"), both, policy);
    assert.ok(!r.ok && r.reason === "name_ambiguous", r.ok ? r.value.tokens.join(" ") : r.reason);
  });

  test("a stop name is never a name span", () => {
    assert.equal(rejected("şunu açıver", turnOn("Şunu", "light")), "name_not_in_text");
  });

  test("the model's call must be the executor's call: other name, other domain", () => {
    assert.equal(rejected("salon lambası açılsın", turnOn("Mutfak Lamba", "light")), "name_not_in_text");
    // No light is called "Kahve Prizi": the model's call names no entity of the home (T7.w.9).
    assert.equal(rejected("kahve prizi açılsın", turnOn("Kahve Prizi", "light")), "model_target_unresolved");
  });

  test("media on/off and an outlet are learnable", () => {
    assert.deepEqual(learned("mutfak radyo açılsın", turnOn("Mutfak Radyo", "media_player")).tokens, ["<ad>", "açılsın"]);
    const plug = learned("kahve prizi açılsın", turnOn("Kahve Prizi", "switch"));
    assert.deepEqual(plug.domains, ["switch"]);
    assert.ok(plug.keywords.includes("priz"));
  });
});

describe("extractPattern: arguments", () => {
  test("area-only call (area-wide)", () => {
    assert.equal(rejected("salon açılsın", action("intent__HassTurnOn", { area: "Salon", domain: ["light"] })), "area_target");
  });

  test("an unexplained argument", () => {
    assert.equal(rejected("salon lambası açılsın", action("intent__HassTurnOn", { name: "Salon Lamba", domain: ["light"], color: "red" })), "unexplained_arg");
    assert.equal(rejected("salon lambası açılsın", action("intent__HassTurnOn", { name: "Salon Lamba", domain: ["light"], brightness: 10 })), "unexplained_arg");
    assert.equal(rejected("salon lambası açılsın", action("intent__HassTurnOn", { name: "Salon Lamba", domain: ["light"], floor: "zemin" })), "unexplained_arg");
  });

  test("no name, no domain, several domains", () => {
    assert.equal(rejected("ışıklar açılsın", action("intent__HassTurnOn", { domain: ["light"] })), "no_name");
    assert.equal(rejected("salon lambası açılsın", action("intent__HassTurnOn", { name: "Salon Lamba" })), "bad_domain");
    assert.equal(rejected("salon lambası açılsın", action("intent__HassTurnOn", { name: "Salon Lamba", domain: ["light", "switch"] })), "bad_domain");
  });

  test("brightness only on lights", () => {
    assert.equal(rejected("kahve prizi yüzde 40 olsun", action("light__HassLightSet", { name: "Kahve Prizi", domain: ["switch"], brightness: 40 })), "domain_not_learnable");
  });

  test("each never-learnable domain is refused", () => {
    for (const d of NEVER_LEARNABLE_DOMAINS) {
      assert.equal(rejected("ön kapı açılsın", turnOn("Ön Kapı", d)), "domain_not_learnable", d);
    }
    assert.equal(rejected("ön kapı açılsın", turnOn("Ön Kapı", "fan")), "domain_not_learnable");
  });
});

describe("never-learnable domains: locks, alarms, covers, valves (T7.w.10)", () => {
  const BANNED = ["lock", "alarm_control_panel", "cover", "valve"];
  // A neutral name and an outlet class: only the domain can refuse these.
  const neutral = (domain: string) => ent("Masa Prizi", domain, { attributes: { device_class: "outlet" } });

  test("each one is in NEVER_LEARNABLE_DOMAINS and outside the ceiling", () => {
    for (const d of BANNED) {
      assert.ok(NEVER_LEARNABLE_DOMAINS.has(d), d);
      assert.equal(isLearnableDomain(d), false, d);
    }
  });

  test("never learned, whatever the name", () => {
    for (const d of BANNED) {
      const r = extractPattern(textOf("masa prizi açılsın"), turnOn("Masa Prizi", d), [neutral(d)], noConfirmClasses);
      assert.deepEqual(r, { ok: false, reason: "domain_not_learnable" }, d);
    }
  });

  test("never run: the run-time filter refuses them and a stored rule naming one does not match", () => {
    const allow = learnTargetFilter(noConfirmClasses);
    for (const d of BANNED) {
      assert.equal(allow(neutral(d)), false, d);
      const rule = compileLearnedRule(
        { id: "lr-test", tokens: ["<ad>", "açılsın"], service: "home-assistant", tool: "intent__HassTurnOn", domains: [d], keywords: [] },
        config.direct.maxNameWords,
      );
      assert.equal(matchLearnedRules(config, [rule], textOf("masa prizi açılsın"), allow), undefined, d);
    }
    // Control: the same rule on a plug domain does match.
    const plugRule = compileLearnedRule(
      { id: "lr-test", tokens: ["<ad>", "açılsın"], service: "home-assistant", tool: "intent__HassTurnOn", domains: ["switch"], keywords: [] },
      config.direct.maxNameWords,
    );
    assert.ok(matchLearnedRules(config, [plugRule], textOf("masa prizi açılsın"), allow));
  });
});

describe("extractPattern: target check (layer 3)", () => {
  test("a deny word in English", () => {
    assert.equal(rejected("garage plug açılsın", turnOn("Garage Plug", "switch")), "target_refused");
  });

  test("deny words match whole words with a suffix, not substrings (T7.w.10)", () => {
    const allow = learnTargetFilter(policy);
    const plug = (names: string, areas: string[] = []) => ent(names, "switch", { areas, attributes: { device_class: "outlet" } });
    // Inside another word: not a deny word.
    assert.equal(allow(plug("Wall Clock")), true, "clock is not lock");
    assert.equal(allow(plug("Duvar Saati", ["Clockroom"])), true);
    // The word itself, any case, with a suffix, softened, in an alias or an area.
    for (const [names, areas] of [
      ["Lock"],
      ["Front Door Lock"],
      ["Locks"],
      ["Kilit"],
      ["Kilitli Priz"],
      ["Kapı Kilidi"],
      ["Garaj Kapısı Prizi"],
      ["Masa Prizi, Kilit Prizi"],
      ["Masa Prizi", ["Kiler Kapısı"]],
    ] as [string, string[]?][]) {
      assert.equal(allow(plug(names, areas ?? [])), false, `${names} / ${(areas ?? []).join(",")}`);
    }
    // Compounds are no longer caught by the name (the domain ban is the guard).
    assert.equal(allow(plug("Bahçekapısı Prizi")), true);
  });

  test("isDenyWord: start of the word, softened stem, never inside", () => {
    assert.equal(isDenyWord("lock", "lock"), true);
    assert.equal(isDenyWord("locked", "lock"), true);
    assert.equal(isDenyWord("clock", "lock"), false);
    assert.equal(isDenyWord("kilidi", "kilit"), true);
    assert.equal(isDenyWord("kepengi", "kepenk"), true);
    assert.equal(isDenyWord("kilid", "kilit"), false, "a softened stem needs a suffix");
    assert.equal(isDenyWord("bahcekapisi", "kapi"), false);
    assert.equal(isDenyWord("kap", "kapi"), false);
    assert.equal(isDenyWord("kapi", ""), false);
  });

  test("a deny word in the name or in the area", () => {
    assert.equal(rejected("garaj kapısı açılsın", turnOn("Garaj Kapısı", "switch")), "target_refused");
    assert.equal(rejected("tavan açılsın", turnOn("Tavan", "light")), "target_refused");
  });

  test("a switch without a device class, with outlet, with door", () => {
    assert.equal(rejected("bahçe rölesi açılsın", turnOn("Bahçe Rölesi", "switch")), "target_refused");
    assert.ok(extract("kahve prizi açılsın", turnOn("Kahve Prizi", "switch")).ok);
    assert.equal(rejected("avlu rölesi açılsın", turnOn("Avlu Rölesi", "switch")), "target_refused");
  });

  test("a device_class from confirm_inputs is refused (case-insensitive)", () => {
    assert.equal(rejected("salon tv açılsın", turnOn("Salon Tv", "media_player")), "target_refused");
    assert.ok(extract("salon tv açılsın", turnOn("Salon Tv", "media_player"), noConfirmClasses).ok);
  });

  test("a narrowed learning block refuses what it no longer lists", () => {
    const narrow: LearnPolicy = { config: parseRouterConfig(`${YAML}  domains: [light]\n`), confirmDeviceClasses: new Set() };
    assert.equal(rejected("kahve prizi açılsın", turnOn("Kahve Prizi", "switch"), narrow), "domain_not_learnable");
  });

  test("the run-time filter refuses the same targets", () => {
    const allow = learnTargetFilter(policy);
    const byName = (n: string) => ENTITIES.find((e) => e.names[0] === n) as LiveEntity;
    assert.equal(allow(byName("Salon Lamba")), true);
    assert.equal(allow(byName("Kahve Prizi")), true);
    for (const n of ["Bahçe Rölesi", "Avlu Rölesi", "Garaj Kapısı", "Salon Tv", "Ön Kapı", "Tavan"]) assert.equal(allow(byName(n)), false, n);
  });

  test("a learned plan with the filter never calls a refused target and falls back", async () => {
    const plan: DirectPlan = {
      rule: "learned:lr-test",
      service: "home-assistant",
      tool: "intent__HassTurnOn",
      name: "garaj kapısı",
      areaAliases: [],
      domains: ["switch"],
      keywords: [],
      reply: "ok",
      maxItems: 4,
      messages: config.direct.messages,
      targetFilter: learnTargetFilter(policy),
    };
    const calls: string[] = [];
    const live = JSON.stringify({ result: "Live Context:\n- names: Garaj Kapısı\n  domain: switch\n  state: 'off'\n  attributes:\n    device_class: outlet" });
    const out = await runDirectPlan(
      plan,
      async (tool) => {
        calls.push(tool);
        return { status: "ok", result: { text: live, isError: false } };
      },
      { fallbackOnError: true },
    );
    assert.deepEqual(out, { kind: "fallback", reason: "target_refused" });
    assert.deepEqual(calls, ["homeassistant__GetLiveContext"]);
  });
});

describe("extractPattern: stored words", () => {
  test("a room or device name word is never stored as a literal word", () => {
    // The target resolves from "tavan lambasını" alone; "oturma" (its area) would become a literal.
    // (The area span "oturma" also resolves here; each candidate pattern would hold a name word.)
    for (const t of ["oturma tavan lambasını açıver", "oturmadaki tavan lambasını açıver"]) {
      assert.ok(["name_word_in_pattern", "name_ambiguous"].includes(rejected(t, turnOn("Tavan Lambası", "light"))), t);
    }
    // Media has no keywords here: only the name span resolves, so the reason is exact.
    assert.equal(rejected("oturma mutfak radyo açılsın", turnOn("Mutfak Radyo", "media_player")), "name_word_in_pattern");
    // Another device's name word too.
    assert.equal(rejected("mutfak radyo kahvesi açılsın", turnOn("Mutfak Radyo", "media_player")), "name_word_in_pattern");
    // Device words (keywords) are phrasing, not names.
    assert.ok(extract("salon lambası parlaklığı yüzde 40 olsun", setLevel("Salon Lamba", 40)).ok);
  });

  test("a word outside the plain Turkish alphabet is never stored", () => {
    assert.equal(rejected("salon lambası café modu", turnOn("Salon Lamba", "light")), "bad_word");
  });

  test("tokens are only slots or plain words (no pattern metacharacters)", () => {
    const samples: [string, ObservedCall][] = [
      ["salon lambası parlaklığı yüzde 40 olsun", setLevel("Salon Lamba", 40)],
      ["Salon lambası {aç|kapat} * <ad> @open", turnOn("Salon Lamba", "light")],
      ["kahve prizi açılsın!", turnOn("Kahve Prizi", "switch")],
    ];
    for (const [s, call] of samples) {
      const r = extract(s, call);
      if (!r.ok) continue;
      for (const t of r.value.tokens) assert.ok(t === "<ad>" || t === "<sayi>" || LEARNED_WORD.test(t), `${s}: ${t}`);
    }
  });
});

describe("extractPattern: name words (review round 3)", () => {
  const home = (extra: LiveEntity[], p: LearnPolicy = policy) => (s: string, call: ObservedCall) =>
    extractPattern(textOf(s), call, [ent("Salon Lamba", "light", { areas: ["Salon"] }), ...extra], p);
  const reason = (r: ReturnType<ReturnType<typeof home>>) => (r.ok ? `learned: ${r.value.tokens.join(" ")}` : r.reason);

  test("a name that merely starts with a device word is not exempt ('lambaderin')", () => {
    const run = home([ent("Lambader", "light")]);
    assert.equal(reason(run("salon lambasını lambaderin yanında yak", turnOn("Salon Lamba", "light"))), "name_word_in_pattern");
    // Control: real inflected device words are still phrasing.
    for (const t of ["salon lambasını yak", "salon lambalarını yak", "salon ışığını yak", "salon lambasındaki ışığı yak"]) {
      assert.ok(run(t, turnOn("Salon Lamba", "light")).ok, t);
    }
  });

  test("a short room name with a compound suffix is refused ('odamızdaki')", () => {
    const run = home([ent("Çalışma Lambası", "light", { areas: ["Oda"] })]);
    assert.equal(reason(run("salon lambasını odamızdaki gibi yak", turnOn("Salon Lamba", "light"))), "name_word_in_pattern");
  });

  test("a softened room name is refused ('mutfağımızdaki')", () => {
    const run = home([ent("Mutfak Radyo", "media_player")]);
    assert.equal(reason(run("salon lambasını mutfağımızdaki gibi yak", turnOn("Salon Lamba", "light"))), "name_word_in_pattern");
  });

  test("a room name known only from direct.area_aliases is refused ('oturma')", () => {
    const aliased = parseRouterConfig(YAML.replace("direct:", "direct:\n  area_aliases: [[salon, oturma odası]]"));
    assert.deepEqual(aliased.direct.areaAliases, [["salon", "oturma odası"]]);
    const run = home([], learnPolicy(aliased, services));
    assert.equal(reason(run("salon lambasını oturma tarafında yak", turnOn("Salon Lamba", "light"))), "name_word_in_pattern");
    // Without the alias the same word is plain phrasing (nothing in the home is called that).
    assert.ok(home([])("salon lambasını oturma tarafında yak", turnOn("Salon Lamba", "light")).ok);
  });
});

describe("extractPattern: cross-check (T7.w.9)", () => {
  // The shipped router.yaml: its keyword lists are what a real home runs with.
  const shipped = learnPolicy(loadRouterFile(fileURLToPath(new URL("../../router.yaml", import.meta.url))), services);
  const shippedText = (s: string) => {
    const prepared = prepareText(s, shipped.config.fillers);
    return prepareNumbers(prepared) ?? prepared;
  };
  const HOME: LiveEntity[] = [
    ent("Salon Lamba", "light", { areas: ["Salon"] }),
    ent("Tavan Lambası", "light"),
    ent("Prizma", "light"),
    ent("Lambada", "switch", { attributes: { device_class: "outlet" } }),
  ];
  const run = (s: string, call: ObservedCall, home: LiveEntity[] = HOME) => extractPattern(shippedText(s), call, home, shipped);
  const outcome = (r: ReturnType<typeof run>) => (r.ok ? r.value.tokens.join(" ") : r.reason);

  test("a device word plus a suffix that is a home name is never a literal word ('prizma', 'lambada')", () => {
    for (const t of ["salon lambasını prizma gibi yak", "salon lambasını lambada gibi yak", "salon lambasını prizmadaki gibi yak"]) {
      assert.equal(outcome(run(t, turnOn("Salon Lamba", "light"))), "name_word_in_pattern", t);
    }
    // Control: in a home with no such name, the same word is plain phrasing.
    const plain = [ent("Salon Lamba", "light", { areas: ["Salon"] })];
    assert.equal(outcome(run("salon lambasını prizma gibi yak", turnOn("Salon Lamba", "light"), plain)), "<ad> lambasını prizma gibi yak");
    // Spoken as the target, the name is the slot, not a literal.
    assert.equal(outcome(run("prizmayı açıver", turnOn("Prizma", "light"))), "<ad> açıver");
    assert.equal(outcome(run("lambadayı açıver", turnOn("Lambada", "switch"))), "<ad> açıver");
  });

  test("'tavan lambasını …' for a device called 'Tavan Lambası' stays learnable; 'lambası' is no name word", () => {
    const v = run("tavan lambasını açıver", turnOn("Tavan Lambası", "light"));
    assert.equal(outcome(v), "<ad> açıver");
    assert.ok(v.ok && !/tavan/i.test(JSON.stringify(v.value)));
    assert.equal(outcome(run("tavan lambasını yüzde 40 yap", setLevel("Tavan Lambası", 40))), "<ad> yüzde <sayi> yap");
    // The device word "lambası" is still learned as a literal for another lamp in the same home.
    assert.equal(outcome(run("salon lambasını açıver", turnOn("Salon Lamba", "light"))), "<ad> lambasını açıver");
  });

  test("the model's call must name exactly one entity of the home", () => {
    // Not in the live context at all.
    assert.equal(outcome(run("salon lambasını açıver", turnOn("Yok Lamba", "light"))), "model_target_unresolved");
    // Two lights share the name and the call gives no area: HA's target is not one entity.
    const twins = [ent("Masa Lamba", "light", { areas: ["Salon"] }), ent("Masa Lamba", "light", { areas: ["Mutfak"] })];
    assert.equal(outcome(run("masa lamba açıver", turnOn("Masa Lamba", "light"), twins)), "model_target_unresolved");
    // An area that is not the entity's.
    assert.equal(outcome(run("salon lambasını açıver", action("intent__HassTurnOn", { name: "Salon Lamba", area: "Mutfak", domain: ["light"] }))), "model_target_unresolved");
  });

  test("the <ad> span must resolve to the model's target, not to another entity", () => {
    // "salon" resolves to "Salon Lamba"; the model switched "Tavan Lambası".
    assert.equal(outcome(run("salon lambasını açıver", turnOn("Tavan Lambası", "light"))), "name_not_in_text");
  });
});

describe("checkTurn: eligibility", () => {
  const turn = (calls: ObservedCall[], over: Partial<ObservedTurn> = {}): ObservedTurn => ({
    routedByDefault: true,
    completed: true,
    readOnly: false,
    text: textOf("salon lambası açılsın"),
    calls,
    ...over,
  });
  const on = turnOn("Salon Lamba", "light");
  const reason = (t: ObservedTurn) => {
    const r = checkTurn(t, policy);
    return r.ok ? "ok" : r.reason;
  };

  test("one write call with live-context reads is eligible", () => {
    assert.equal(reason(turn([read, on, read])), "ok");
  });

  test("turns that never teach", () => {
    assert.equal(reason(turn([on], { routedByDefault: false })), "not_default");
    assert.equal(reason(turn([on], { completed: false })), "not_done");
    assert.equal(reason(turn([on], { readOnly: true })), "read_only");
    assert.equal(reason(turn([on], { text: textOf("") })), "empty_text");
    assert.equal(reason(turn([on], { text: textOf("a ".repeat(150)) })), "too_long");
    assert.equal(reason(turn([read])), "no_action");
    assert.equal(reason(turn([on, turnOn("Mutfak Lamba", "light")])), "extra_calls");
    assert.equal(reason(turn([on, { ...read, service: "memory", tool: "memory_search" }])), "extra_calls");
    assert.equal(reason(turn([{ ...on, level: "confirm" }])), "not_write");
    assert.equal(reason(turn([on, { ...read, allowed: false }])), "denied");
    assert.equal(reason(turn([{ ...on, allowed: false }])), "denied");
    assert.equal(reason(turn([{ ...on, isError: true }])), "tool_error");
    assert.equal(reason(turn([{ ...on, isError: undefined }])), "no_result");
    assert.equal(reason(turn([action("intent__HassVacuumStart", { name: "x" })])), "tool_not_learnable");
    assert.equal(reason(turn([{ ...on, service: "other" }])), "tool_not_learnable");
  });

  test("a narrowed tool list refuses the other tools", () => {
    const narrow: LearnPolicy = { config: parseRouterConfig(`${YAML}  tools: [intent__HassTurnOff]\n`), confirmDeviceClasses: new Set() };
    const r = checkTurn(turn([on]), narrow);
    assert.ok(!r.ok && r.reason === "tool_not_learnable");
  });
});
