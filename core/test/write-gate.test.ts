/**
 * T4.3a: pure write gate (docs/14 Decisions 2-4). Question lock and target
 * provenance; the live context is a fake home with the generic names of the
 * design document.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LiveEntity } from "../src/live-context.js";
import {
  gateWordForms,
  isNamedCall,
  isQuestionTurn,
  nameMatchNeedsSnapshot,
  namedTarget,
  PROVENANCE_WINDOW,
  targetProvenance,
  type GateConfirmedName,
} from "../src/write-gate.js";

const entity = (names: string[], domain: string, areas: string[] = []): LiveEntity => ({ names, domain, state: "off", areas, attributes: {} });

const home: LiveEntity[] = [
  entity(["Bahçe Pompası"], "switch", ["Bahçe"]),
  entity(["Salon Tavan Işığı", "Salon Lambası"], "light", ["Salon"]),
  entity(["Mutfak Işık"], "light", ["Mutfak"]),
  entity(["Yatak Odası Işık"], "light", ["Yatak Odası"]),
  entity(["Okuma Lambası"], "light", ["Çalışma Odası"]),
  entity(["Masa Lambası"], "light", ["Çalışma Odası"]),
  entity(["Kahve Makinesi"], "switch", ["Mutfak"]),
  entity(["Alışveriş Listesi"], "todo"),
];

const domainWords = {
  light: ["ışık", "ışığı", "ışıklar", "ışıkları", "lamba", "lambası", "lambalar", "lambaları", "aydınlatma"],
  switch: ["priz", "prizi", "prizler", "prizleri"],
};

const opts = { domainWords };

describe("isQuestionTurn: Decision 3 examples", () => {
  const table: Array<[string, boolean]> = [
    ["Sonoff hangi cihazlar var", true],
    ["salon lambası açık mı", true],
    ["salon lambasını kapatır mısın", false],
    ["evdeki ışıkları listele", true],
    ["salon ışığını yüzde 40 yap", false],
    ["hangi ışıklar açık, hepsini kapat", true],
  ];
  for (const [text, locked] of table) {
    test(`"${text}" → ${locked ? "locked" : "not locked"}`, () => assert.equal(isQuestionTurn(text), locked));
  }
});

describe("isQuestionTurn: signals", () => {
  test("question words anywhere", () => {
    for (const t of ["hangileri açık", "neler açık", "ne açık", "bu nedir", "kaç ışık yanıyor", "kac derece", "anahtar nerede", "evde ışık var mı", "pompa yok mu"]) {
      assert.equal(isQuestionTurn(t), true, t);
    }
  });
  test("say is not a question word", () => assert.equal(isQuestionTurn("ışıkları say"), false));
  test("particle with endings after a non-verb", () => {
    for (const t of [
      "pompa çalışıyor mu",
      "kapı kilitli mi",
      "salon sıcak mıdır",
      "evde miyim",
      "ışık açık mıydı",
      "pompa açık mıymış",
      "kilitli misiniz",
      "salon lambaları açık mıydılar",
      "lambalar açık mıymışlar",
    ]) {
      assert.equal(isQuestionTurn(t), true, t);
    }
  });
  test("polite requests (aorist, -abil/-ebil) are commands", () => {
    for (const t of ["ışığı açar mısın", "kapatabilir misin", "kısar mısınız", "fanı açabilir misiniz", "pompayı kapatır mısın?"]) {
      assert.equal(isQuestionTurn(t), false, t);
    }
  });
  test("adjectives that end like an aorist stay questions (only '<aorist> m…sın(ız)' is polite)", () => {
    for (const t of ["kahve makinesi hazır mı?", "bahçe pompası hazır mı", "ışıklar mı", "pompa açar mı"]) {
      assert.equal(isQuestionTurn(t), true, t);
    }
  });
  test("a question word beats a polite form", () => assert.equal(isQuestionTurn("hangi ışıkların açık olduğunu söyler misin"), true));
  test("a polite particle and a real particle: the real one locks", () => assert.equal(isQuestionTurn("salon açık mı, kapatır mısın"), true));
  test("var mı / yok mu lock even though 'var' ends like an aorist", () => {
    assert.equal(isQuestionTurn("bahçede pompa var mıydı"), true);
  });
  test("trailing ? locks typed text, also with closing quotes", () => {
    assert.equal(isQuestionTurn("salon ışığını kapat?"), true);
    assert.equal(isQuestionTurn("salon ışığını kapat? "), true);
    assert.equal(isQuestionTurn('"salon ışığını kapat?"'), true);
    assert.equal(isQuestionTurn("salon ışığını kapat"), false);
    assert.equal(isQuestionTurn("ne?"), true);
  });
  test("whole words only: 'nem', 'muz', 'mide', 'hepsi' are not signals", () => {
    for (const t of ["nemi yüzde 40 yap", "muz al", "mide ilacını listeye ekle", "hepsini kapat"]) {
      assert.equal(isQuestionTurn(t), false, t);
    }
  });
  test("upper case and Turkish İ/I", () => {
    assert.equal(isQuestionTurn("SALON IŞIĞI AÇIK MI"), true);
    assert.equal(isQuestionTurn("HANGİ IŞIKLAR AÇIK"), true);
  });
  test("a trailing ? is excused only by a polite form right before it", () => {
    const table: Array<[string, boolean]> = [
      ["ışığı açar mısın, hangisi açık?", true],
      ["ışığı açar mısın, salon açık?", true],
      ["kapatır mısın, salon ışığını kapat?", true],
      ["salon lambasını kapatır mısın?", false],
      ["salon lambasını kapatır mısın", false],
      ["ışığı açar mısın, salonu da kapatır mısın?", false],
    ];
    for (const [text, locked] of table) assert.equal(isQuestionTurn(text), locked, text);
  });
  test("empty text is not a question", () => {
    assert.equal(isQuestionTurn(""), false);
    assert.equal(isQuestionTurn("   "), false);
  });
});

describe("targetProvenance: rule 3 (text match)", () => {
  test("the name as said, with case suffixes per word", () => {
    assert.deepEqual(targetProvenance({ name: "Bahçe Pompası" }, ["bahçe pompasını kapat"]), { status: "known", via: "text" });
    assert.deepEqual(targetProvenance({ name: "Mutfak Işık" }, ["mutfak ışığını aç"]), { status: "known", via: "text" });
    assert.deepEqual(targetProvenance({ name: "Mutfak Işık" }, ["Mutfak'taki ışığı aç"]), { status: "known", via: "text" });
  });
  test("no substrings, no single shared word: 'pompa' does not cover 'Bahçe Pompası'", () => {
    assert.deepEqual(targetProvenance({ name: "Bahçe Pompası" }, ["pompayı kapat"]), { status: "unknown", needsSnapshot: true });
    assert.deepEqual(targetProvenance({ name: "Bahçe Pompası" }, ["bahçede pompa"]), { status: "unknown", needsSnapshot: true });
  });
  test("words must be contiguous and in order", () => {
    assert.equal(targetProvenance({ name: "Bahçe Pompası" }, ["pompası bahçe"]).status, "unknown");
    assert.equal(targetProvenance({ name: "Bahçe Pompası" }, ["bahçe ve pompası"]).status, "unknown");
  });
  test("every target argument must be named (area, floor)", () => {
    assert.deepEqual(targetProvenance({ name: "Mutfak Işık", area: "Mutfak" }, ["mutfak ışığını kapat"]), { status: "known", via: "text" });
    assert.deepEqual(targetProvenance({ area: "Salon", domain: "light" }, ["salondaki ışıkları kapat"]), { status: "known", via: "text" });
    assert.deepEqual(targetProvenance({ area: "Salon" }, ["mutfağı kapat"]), { status: "unknown", needsSnapshot: false });
    assert.deepEqual(targetProvenance({ name: "Mutfak Işık", floor: "Zemin Kat" }, ["mutfak ışığını kapat"]), { status: "unknown", needsSnapshot: false });
    assert.deepEqual(targetProvenance({ floor: "Zemin Kat" }, ["zemin kattaki ışıkları kapat"]), { status: "known", via: "text" });
  });
  test("todo list in `name`: 'alışveriş listesine ekle' names the list (dative)", () => {
    assert.deepEqual(targetProvenance({ name: "Alışveriş Listesi", item: "süt" }, ["alışveriş listesine süt ekle"]), { status: "known", via: "text" });
  });
  test("a set but unusable target argument is never known", () => {
    assert.deepEqual(targetProvenance({ name: 42 }, ["42 kapat"]), { status: "unknown", needsSnapshot: false });
    assert.deepEqual(targetProvenance({ name: "  " }, ["kapat"]), { status: "unknown", needsSnapshot: false });
    assert.deepEqual(targetProvenance({ name: null }, ["kapat"]), { status: "unknown", needsSnapshot: false });
  });
});

describe("targetProvenance: the 3-utterance window (user decision 6)", () => {
  test("'salon ışığı açık mı?' then 'kapat': the target is in the window", () => {
    assert.deepEqual(targetProvenance({ name: "Salon Işık" }, ["salon ışığı açık mı?", "kapat"]), { status: "known", via: "text" });
  });
  test("after two more utterances the naming one left the window", () => {
    const utterances = ["salon ışığı açık mı?", "hava nasıl", "saat kaç", "kapat"];
    assert.equal(PROVENANCE_WINDOW, 3);
    assert.deepEqual(targetProvenance({ name: "Salon Işık" }, utterances), { status: "unknown", needsSnapshot: true });
    assert.deepEqual(targetProvenance({ name: "Salon Işık" }, ["salon ışığı açık mı?", "hava nasıl", "kapat"]), { status: "known", via: "text" });
  });
  test("pronoun-only follow-up once the name left the window, and 'ikincisi', stay unknown", () => {
    const old = ["bahçe pompasını aç", "hava nasıl", "saat kaç", "onu da kapat"];
    assert.equal(targetProvenance({ name: "Bahçe Pompası" }, old, home, [], opts).status, "unknown");
    assert.equal(targetProvenance({ name: "Okuma Lambası" }, ["çalışma odasındaki lambayı aç", "ikincisi"], home, [], opts).status, "unknown");
  });
  test("an empty window is never known", () => {
    assert.equal(targetProvenance({ name: "Salon Işık" }, []).status, "unknown");
  });
});

describe("targetProvenance: rule 4 (alias in the live context)", () => {
  test("canonical name called for an HA alias the user said", () => {
    assert.deepEqual(targetProvenance({ name: "Salon Tavan Işığı" }, ["salon lambasını kapat"]), { status: "unknown", needsSnapshot: true });
    assert.deepEqual(targetProvenance({ name: "Salon Tavan Işığı" }, ["salon lambasını kapat"], home, [], opts), { status: "known", via: "alias" });
  });
  test("name + device word ('yatak odası' → 'Yatak Odası Işık')", () => {
    assert.deepEqual(targetProvenance({ name: "Yatak Odası Işık" }, ["yatak odası lambasını kapat"], home, [], opts), { status: "known", via: "alias" });
  });
  test("name prefix + device word counts as said ('salonu' → 'Salon Lambası', resolveDevice score 2)", () => {
    assert.deepEqual(targetProvenance({ name: "Salon Tavan Işığı" }, ["salonu kapat"], home, [], opts), { status: "known", via: "alias" });
  });
  const areaOnly = [entity(["Tavan"], "light", ["Salon"]), entity(["Mutfak Işık"], "light", ["Mutfak"])];
  test("area + device word for the only light in the area", () => {
    assert.deepEqual(targetProvenance({ name: "Tavan" }, ["salondaki ışığı kapat"], areaOnly, [], opts), { status: "known", via: "alias" });
  });
  test("area alone (no device word) is not enough", () => {
    assert.equal(targetProvenance({ name: "Tavan" }, ["salonu kapat"], areaOnly, [], opts).status, "unknown");
    assert.equal(targetProvenance({ name: "Tavan" }, ["salondaki ışığı kapat"], areaOnly, [], {}).status, "unknown");
  });
  test("area + device word with two lights in the area is a guess", () => {
    assert.equal(targetProvenance({ name: "Okuma Lambası" }, ["çalışma odası lambasını kapat"], home, [], opts).status, "unknown");
  });
  test("a name owned by two entities is not resolved", () => {
    const twin = [...home, entity(["Salon Tavan Işığı"], "light", ["Salon"])];
    assert.equal(targetProvenance({ name: "Salon Tavan Işığı" }, ["salon lambasını kapat"], twin, [], opts).status, "unknown");
  });
  test("the user's words resolving to another device do not count, even when they stem to the alias", () => {
    const clash = [entity(["Tavan", "Salon Lamba"], "light", ["Salon"]), entity(["Salondaki Lamba"], "light", ["Salon"])];
    assert.equal(targetProvenance({ name: "Tavan" }, ["salondaki lambayı kapat"], clash, [], opts).status, "unknown");
    assert.deepEqual(targetProvenance({ name: "Tavan" }, ["salon lambayı kapat"], clash, [], opts), { status: "known", via: "alias" });
  });
  test("a run that is another domain's device name does not count", () => {
    const mixed = [entity(["Salon"], "switch", ["Salon"]), entity(["Salon Işık"], "light", ["Salon"])];
    assert.equal(targetProvenance({ name: "Salon Işık" }, ["salonu kapat"], mixed, [], opts).status, "unknown");
  });
  test("the matched words must be the user's whole name phrase, not part of a longer one", () => {
    const lamp2 = [...home, entity(["Salon Lambası 2"], "light", ["Salon"])];
    const longName = [entity(["Tavan", "Salon Lambası"], "light", ["Salon"]), entity(["Salon Lambası Philips Hue Beyaz Ambiyans 2"], "light", ["Salon"])];
    const table: Array<[string, string, LiveEntity[], "known" | "unknown"]> = [
      // A longer phrase naming another device ("kahve makinesi") or another / several devices.
      ["Mutfak Işık", "mutfak kahve makinesini kapat", home, "unknown"],
      ["Salon Tavan Işığı", "salon lambası 2 kapat", lamp2, "unknown"],
      ["Salon Tavan Işığı", "salon lambası 2", lamp2, "unknown"],
      ["Salon Tavan Işığı", "salon masa lambasını kapat", home, "unknown"],
      // A device word of another domain next to the name ("mutfak prizi").
      ["Mutfak Işık", "mutfak prizini kapat", home, "unknown"],
      ["Mutfak Işık", "mutfak akıllı prizini kapat", home, "unknown"],
      // Left extension, and a longer phrase than MAX_RUN_WORDS (7 words) naming another device.
      ["Salon Tavan Işığı", "masa salon lambası", [...home, entity(["Masa Salon Lambası"], "light", ["Salon"])], "unknown"],
      ["Tavan", "salon lambası philips hue beyaz ambiyans 2 kapat", longName, "unknown"],
      // 7-word names that only a maxRun beyond MAX_RUN_WORDS reaches (containing run).
      ["Tavan", "salon lambası aa bb cc dd ee kapat", [entity(["Tavan", "Salon Lambası"], "light", ["Salon"]), entity(["Salon Lambası Aa Bb Cc Dd Ee"], "light", ["Salon"])], "unknown"],
      // The name phrase stands alone: still known.
      ["Salon Tavan Işığı", "salon lambasını kapat", lamp2, "known"],
      ["Salon Tavan Işığı", "lütfen salon lambasını kapat", home, "known"],
      ["Mutfak Işık", "mutfağı kapat", home, "known"],
      ["Yatak Odası Işık", "yatak odası lambasını kapat", home, "known"],
    ];
    for (const [name, said, snapshot, status] of table) {
      assert.equal(targetProvenance({ name }, [said], snapshot, [], opts).status, status, `${name} / ${said}`);
    }
  });
  test("the alias must belong to the called entity", () => {
    assert.equal(targetProvenance({ name: "Mutfak Işık" }, ["salon lambasını kapat"], home, [], opts).status, "unknown");
  });
  test("area and domain narrow the entity; a contradicting area fails", () => {
    assert.deepEqual(targetProvenance({ name: "Salon Tavan Işığı", area: "Salon", domain: "light" }, ["salon lambasını kapat"], home, [], opts), {
      status: "known",
      via: "alias",
    });
    assert.deepEqual(targetProvenance({ name: "Salon Tavan Işığı", area: "Mutfak" }, ["salon lambasını kapat"], home, [], opts), {
      status: "unknown",
      needsSnapshot: false,
    });
    assert.equal(targetProvenance({ name: "Salon Tavan Işığı", domain: "switch" }, ["salon lambasını kapat"], home, [], opts).status, "unknown");
  });
  test("the area is implied by the named entity", () => {
    assert.equal(targetProvenance({ name: "Salon Tavan Işığı", area: "Salon" }, ["tavan lambasını"], home, [], opts).status, "unknown");
    const aliasOnly = [entity(["Tavan Işığı", "Büyük Lamba"], "light", ["Salon"])];
    assert.deepEqual(targetProvenance({ name: "Tavan Işığı", area: "Salon" }, ["büyük lambayı kapat"], aliasOnly, [], opts), { status: "known", via: "alias" });
  });
});

describe("targetProvenance: rule 5 (confirmed name)", () => {
  const pump: GateConfirmedName = {
    keys: ["bahce pompasni", "bahce pompasn", "bahce pompas"],
    target: { name: "Bahçe Pompası", domain: "switch", areas: ["Bahçe"] },
    status: "active",
  };
  test("an utterance holding the key, fingerprint present once", () => {
    assert.deepEqual(targetProvenance({ name: "Bahçe Pompası" }, ["bahçe pompasnı kapat"], home, [pump], opts), { status: "known", via: "confirmed_name" });
  });
  test("without a snapshot the caller is told to read one", () => {
    assert.deepEqual(targetProvenance({ name: "Bahçe Pompası" }, ["bahçe pompasnı kapat"], undefined, [pump], opts), { status: "unknown", needsSnapshot: true });
  });
  test("passive entry, other target, missing or ambiguous fingerprint: not used", () => {
    const said = ["bahçe pompasnı kapat"];
    assert.equal(targetProvenance({ name: "Bahçe Pompası" }, said, home, [{ ...pump, status: "passive" }], opts).status, "unknown");
    assert.equal(targetProvenance({ name: "Kahve Makinesi" }, said, home, [pump], opts).status, "unknown");
    assert.equal(targetProvenance({ name: "Bahçe Pompası", area: "Mutfak" }, said, home, [pump], opts).status, "unknown");
    const gone = home.filter((e) => e.names[0] !== "Bahçe Pompası");
    assert.equal(targetProvenance({ name: "Bahçe Pompası" }, said, gone, [pump], opts).status, "unknown");
    const moved = [...gone, entity(["Bahçe Pompası"], "switch", ["Garaj"])];
    assert.equal(targetProvenance({ name: "Bahçe Pompası" }, said, moved, [pump], opts).status, "unknown");
    const twice = [...home, entity(["Bahçe Pompası"], "switch", ["Bahçe"])];
    assert.equal(targetProvenance({ name: "Bahçe Pompası" }, said, twice, [pump], opts).status, "unknown");
  });
  test("a same-named device elsewhere: the call must reach the confirmed one only", () => {
    const said = ["bahçe pompasnı kapat"];
    const twins = [...home, entity(["Bahçe Pompası"], "switch", ["Garaj"])];
    assert.equal(targetProvenance({ name: "Bahçe Pompası" }, said, twins, [pump], opts).status, "unknown");
    assert.deepEqual(targetProvenance({ name: "Bahçe Pompası", area: "Bahçe" }, said, twins, [pump], opts), {
      status: "known",
      via: "confirmed_name",
    });
  });
  test("the key must be in the window", () => {
    assert.equal(targetProvenance({ name: "Bahçe Pompası" }, ["bahçe pompasnı kapat", "a", "b", "kapat"], home, [pump], opts).status, "unknown");
  });
  test("an entry without status counts as active (caller passes active entries)", () => {
    const noStatus: GateConfirmedName = { keys: pump.keys, target: pump.target };
    assert.equal(targetProvenance({ name: "Bahçe Pompası" }, ["bahçe pompasnı kapat"], home, [noStatus], opts).status, "known");
  });
});

describe("targetProvenance: broad calls and no target (Decision 2)", () => {
  test("whole-set word + domain word in one utterance", () => {
    assert.deepEqual(targetProvenance({ domain: "light" }, ["hangi ışıklar açık, hepsini kapat"], undefined, undefined, opts), { status: "known", via: "broad" });
    assert.deepEqual(targetProvenance({ domain: ["light"] }, ["tüm lambaları kapat"], undefined, undefined, opts), { status: "known", via: "broad" });
    assert.deepEqual(targetProvenance({ domain: "light" }, ["bütün ışıkları kapat"], undefined, undefined, opts), { status: "known", via: "broad" });
    assert.deepEqual(targetProvenance({ domain: "light" }, ["her ışığı kapat"], undefined, undefined, opts), { status: "known", via: "broad" });
  });
  test("without the whole-set word, the other domain, or the words in one utterance: unknown", () => {
    const unknown = { status: "unknown", needsSnapshot: false };
    assert.deepEqual(targetProvenance({ domain: "light" }, ["ışıkları kapat"], undefined, undefined, opts), unknown);
    assert.deepEqual(targetProvenance({ domain: "switch" }, ["tüm ışıkları kapat"], undefined, undefined, opts), unknown);
    assert.deepEqual(targetProvenance({ domain: ["light", "switch"] }, ["tüm ışıkları kapat"], undefined, undefined, opts), unknown);
    assert.deepEqual(targetProvenance({ domain: "light" }, ["hepsini", "ışıkları kapat"], undefined, undefined, opts), unknown);
    assert.deepEqual(targetProvenance({ domain: "cover" }, ["tüm perdeleri kapat"], undefined, undefined, opts), unknown);
    assert.deepEqual(targetProvenance({ domain: "light" }, ["tüm ışıkları kapat"]), unknown);
    assert.deepEqual(targetProvenance({ device_class: "outlet" }, ["tüm prizleri kapat"], undefined, undefined, opts), unknown);
    assert.deepEqual(targetProvenance({ domain: 5 }, ["tüm ışıkları kapat"], undefined, undefined, opts), unknown);
  });
  test("no target argument at all", () => {
    assert.deepEqual(targetProvenance({}, ["zamanlayıcıları iptal et"]), { status: "no_target" });
  });
});

describe("gateWordForms", () => {
  test("two stripping steps reach the root; dative and ablative are gate-local", () => {
    assert.ok(gateWordForms("ışığını").has("isik"));
    assert.ok(gateWordForms("listesine").has("listesi"));
    assert.ok(gateWordForms("salondan").has("salon"));
    assert.ok(gateWordForms("mutfağı").has("mutfak"));
    assert.ok(!gateWordForms("pompayı").has("pompasi"));
  });
});

describe("rule 3 against the live list (docs/14 decision 10, T4.9)", () => {
  const lamps = [entity(["Salon Lambası"], "light", ["Salon"]), entity(["Salon Lambası 2"], "light", ["Salon"])];
  test("a longer phrase that is another device's name: the text match does not count", () => {
    assert.equal(targetProvenance({ name: "Salon Lambası" }, ["salon lambası 2 kapat"], lamps, [], opts).status, "unknown");
    assert.equal(targetProvenance({ name: "Salon Lambası", domain: "light" }, ["salon lambası 2 kapat"], lamps, [], opts).status, "unknown");
    // Left extension naming another device.
    const masa = [...lamps, entity(["Masa Salon Lambası"], "light", ["Salon"])];
    assert.equal(targetProvenance({ name: "Salon Lambası" }, ["masa salon lambasını kapat"], masa, [], opts).status, "unknown");
    // Without a snapshot the plain text answer stands (the caller reads one when `nameMatchNeedsSnapshot`).
    assert.deepEqual(targetProvenance({ name: "Salon Lambası" }, ["salon lambası 2 kapat"]), { status: "known", via: "text" });
  });
  test("the name as the whole phrase, a second phrase next to it, or another utterance that fits: known", () => {
    assert.deepEqual(targetProvenance({ name: "Salon Lambası" }, ["salon lambasını kapat"], lamps, [], opts), { status: "known", via: "text" });
    assert.deepEqual(targetProvenance({ name: "Salon Lambası" }, ["salon lambasını ve salon lambası 2'yi kapat"], lamps, [], opts), { status: "known", via: "text" });
    assert.deepEqual(targetProvenance({ name: "Salon Lambası" }, ["salon lambası açık mı", "salon lambası 2 kapat"], lamps, [], opts), { status: "known", via: "text" });
    assert.deepEqual(targetProvenance({ name: "Salon Lambası 2" }, ["salon lambası 2 kapat"], lamps, [], opts), { status: "known", via: "text" });
  });
  test("a name that reaches no entity keeps the text match (left to HA and the name-only check)", () => {
    assert.deepEqual(targetProvenance({ name: "Depo Lambası" }, ["depo lambası 2 kapat"], lamps, [], opts), { status: "known", via: "text" });
  });
  test("a name owned by several entities: a longer phrase naming another device still does not count", () => {
    const twins = [entity(["Salon Lambası"], "light", ["Salon"]), entity(["Salon Lambası"], "light", ["Mutfak"]), entity(["Salon Lambası 2"], "light", ["Salon"])];
    assert.equal(targetProvenance({ name: "Salon Lambası", domain: ["light"] }, ["salon lambası 2 kapat"], twins, [], opts).status, "unknown");
    assert.deepEqual(targetProvenance({ name: "Salon Lambası", domain: ["light"] }, ["salon lambasını kapat"], twins, [], opts), { status: "known", via: "text" });
  });
  test("the matched words themselves naming another device (by stemming) do not count", () => {
    const clash = [entity(["Salon Lamba"], "light", ["Salon"]), entity(["Salondaki Lamba"], "light", ["Salon"])];
    assert.equal(targetProvenance({ name: "Salon Lamba" }, ["salondaki lambayı kapat"], clash, [], opts).status, "unknown");
    assert.deepEqual(targetProvenance({ name: "Salon Lamba" }, ["salon lambayı kapat"], clash, [], opts), { status: "known", via: "text" });
    // Without a snapshot the plain text answer stands (the session reads one first, nameMatchNeedsSnapshot).
    assert.deepEqual(targetProvenance({ name: "Salon Lamba" }, ["salondaki lambayı kapat"]), { status: "known", via: "text" });
  });
  test("nameMatchNeedsSnapshot: a text match with a word next to it", () => {
    assert.equal(nameMatchNeedsSnapshot({ name: "Salon Lambası" }, ["salon lambası 2 kapat"]), true);
    assert.equal(nameMatchNeedsSnapshot({ name: "Salon Lambası" }, ["salon lambasını kapat"]), true);
    assert.equal(nameMatchNeedsSnapshot({ name: "Salon Lambası" }, ["salon lambası"]), false, "the whole utterance");
    assert.equal(nameMatchNeedsSnapshot({ name: "Salon Lambası" }, ["salon lambası 2 kapat", "salon lambası"]), false, "one whole-utterance match is enough");
    assert.equal(nameMatchNeedsSnapshot({ name: "Salon Lambası" }, ["mutfağı kapat"]), false, "no text match");
    assert.equal(nameMatchNeedsSnapshot({ area: "Salon" }, ["salon ışıklarını kapat"]), false, "no name");
  });
});

describe("named targets (docs/14 decisions 9 and 14, T4.8, T4.13)", () => {
  test("isNamedCall: `name`, with or without `domain` / `device_class`", () => {
    assert.equal(isNamedCall({ name: "Ön Kapı" }), true);
    assert.equal(isNamedCall({ name: "Ön Kapı", area: "Giriş" }), true);
    assert.equal(isNamedCall({ name: "Ön Kapı", domain: "lock" }), true);
    assert.equal(isNamedCall({ name: "Ön Kapı", device_class: "door" }), true);
    assert.equal(isNamedCall({ area: "Salon" }), false);
    assert.equal(isNamedCall({ domain: ["light"] }), false);
  });
  const sensitive = (e: LiveEntity) => e.domain === "lock";
  const snap = [entity(["Ön Kapı", "Kapı"], "lock", ["Giriş"]), entity(["Salon Lambası"], "light", ["Salon"]), entity(["Tavan"], "light", ["Salon"]), entity(["Tavan"], "light", ["Mutfak"])];
  test("one plain entity -> ok; a sensitive one (also by alias) -> sensitive", () => {
    assert.equal(namedTarget({ name: "Salon Lambası" }, snap, sensitive), "ok");
    assert.equal(namedTarget({ name: "ön kapı" }, snap, sensitive), "sensitive");
    assert.equal(namedTarget({ name: "Kapı" }, snap, sensitive), "sensitive");
  });
  test("no entity, several, a contradicting area or a bad value -> unresolved; area narrows", () => {
    assert.equal(namedTarget({ name: "Depo" }, snap, sensitive), "unresolved");
    assert.equal(namedTarget({ name: "Tavan" }, snap, sensitive), "unresolved");
    assert.equal(namedTarget({ name: "Tavan", area: "Mutfak" }, snap, sensitive), "ok");
    assert.equal(namedTarget({ name: "Salon Lambası", area: "Mutfak" }, snap, sensitive), "unresolved");
    assert.equal(namedTarget({ name: 42 }, snap, sensitive), "unresolved");
    assert.equal(namedTarget({ name: "Salon Lambası", area: 7 }, snap, sensitive), "unresolved");
  });
  test("a sensitive entity among several wins", () => {
    const shared = [entity(["Giriş"], "lock"), entity(["Giriş"], "light")];
    assert.equal(namedTarget({ name: "Giriş" }, shared, sensitive), "sensitive");
  });
  test("`domain` narrows like HA does; a sensitive entity in the called domain still wins (T4.13)", () => {
    const shared = [entity(["Giriş"], "lock"), entity(["Giriş"], "light")];
    assert.equal(namedTarget({ name: "Giriş", domain: ["light"] }, shared, sensitive), "ok");
    assert.equal(namedTarget({ name: "Giriş", domain: "light" }, shared, sensitive), "ok");
    assert.equal(namedTarget({ name: "Giriş", domain: ["lock"] }, shared, sensitive), "sensitive");
    assert.equal(namedTarget({ name: "Giriş", domain: ["light", "lock"] }, shared, sensitive), "sensitive");
    assert.equal(namedTarget({ name: "Ön Kapı", domain: ["lock"], device_class: "door" }, snap, sensitive), "sensitive");
  });
  test("with `domain`: no entity in that domain, several, or a bad domain -> unresolved", () => {
    assert.equal(namedTarget({ name: "Salon Lambası", domain: ["switch"] }, snap, sensitive), "unresolved");
    assert.equal(namedTarget({ name: "Tavan", domain: ["light"] }, snap, sensitive), "unresolved");
    assert.equal(namedTarget({ name: "Tavan", domain: ["light"], area: "Mutfak" }, snap, sensitive), "ok");
    assert.equal(namedTarget({ name: "Salon Lambası", domain: [] }, snap, sensitive), "unresolved");
    assert.equal(namedTarget({ name: "Salon Lambası", domain: 3 }, snap, sensitive), "unresolved");
  });
});
