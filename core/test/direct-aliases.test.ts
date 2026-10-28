/**
 * A3: tier-0 execution of the new matches — area synonyms
 * (`direct.area_aliases`) and brightness (`light__HassLightSet`). Plans come
 * from the shipped router.yaml; the live context is a fake home with generic
 * names.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { runDirectPlan, type GatedCall } from "../src/direct.js";
import { loadRouterFile, matchRules, type DirectPlan } from "../src/router-config.js";
import { prepareText } from "../src/turkish.js";

const cfg = loadRouterFile(fileURLToPath(new URL("../../router.yaml", import.meta.url)));

function plan(text: string): DirectPlan {
  const hit = matchRules(cfg, prepareText(text, cfg.fillers));
  assert.ok(hit?.tier === 0, `no tier-0 match for '${text}'`);
  return hit.plan;
}

function liveContext(entities: string[][]): string {
  return JSON.stringify({ result: ["Live Context: An overview of the areas and the devices in this smart home:", ...entities.flat()].join("\n") });
}

/** One light in "Oturma odası" (no "salon" anywhere), two lights in "Mutfak". */
const HOME = liveContext([
  ["- names: Oturma Odası Işık", "  domain: light", "  state: 'off'", "  areas: Oturma odası"],
  ["- names: Tezgah Lamba", "  domain: light", "  state: 'on'", "  areas: Mutfak"],
  ["- names: Tavan Lamba", "  domain: light", "  state: 'on'", "  areas: Mutfak"],
  ["- names: Priz Işık", "  domain: switch", "  state: 'off'", "  areas: Çalışma odası"],
]);

function fakeCall(context: string) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const call: GatedCall = async (tool, args) => {
    calls.push({ tool, args });
    if (tool === "homeassistant__GetLiveContext") return { status: "ok", result: { text: context, isError: false } };
    return { status: "ok", result: { text: "{}", isError: false } };
  };
  return { call, calls };
}

const run = (text: string, context = HOME) => {
  const f = fakeCall(context);
  return runDirectPlan(plan(text), f.call, { fallbackOnError: true }).then((outcome) => ({ outcome, calls: f.calls }));
};

describe("area aliases", () => {
  test("'Salonun ışığını yakmayı dener misin' resolves through salon = oturma odası", async () => {
    const { outcome, calls } = await run("Salonun ışığını yakmayı dener misin?");
    assert.equal(outcome.kind, "reply");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], { tool: "intent__HassTurnOn", args: { name: "Oturma Odası Işık", domain: ["light"] } });
  });

  test("the spoken name wins when it matches directly", async () => {
    const ctx = liveContext([
      ["- names: Salon Lamba", "  domain: light", "  state: 'off'", "  areas: Salon"],
      ["- names: Oturma Odası Işık", "  domain: light", "  state: 'off'", "  areas: Oturma odası"],
    ]);
    const { calls } = await run("salon ışığını kapat", ctx);
    assert.deepEqual(calls[1], { tool: "intent__HassTurnOff", args: { name: "Salon Lamba", domain: ["light"] } });
  });

  test("an ambiguous name is not 'fixed' by a synonym: fallback to the model", async () => {
    const ctx = liveContext([
      ["- names: Salon Işık 1", "  domain: light", "  state: 'off'", "  areas: Salon"],
      ["- names: Salon Işık 2", "  domain: light", "  state: 'off'", "  areas: Salon"],
      ["- names: Oturma Odası Işık", "  domain: light", "  state: 'off'", "  areas: Oturma odası"],
    ]);
    const { outcome, calls } = await run("salon ışığını aç", ctx);
    assert.deepEqual(outcome, { kind: "fallback", reason: "name_ambiguous" });
    assert.equal(calls.length, 1, "nothing but the live context was called");
  });

  test("several lights in the named area and no single match: fallback, nothing switched", async () => {
    const { outcome, calls } = await run("mutfak ışığını kapat");
    assert.deepEqual(outcome, { kind: "fallback", reason: "name_ambiguous" });
    assert.equal(calls.length, 1);
  });

  test("a name with no entity and no synonym: fallback", async () => {
    const { outcome } = await run("banyo ışığını aç");
    assert.deepEqual(outcome, { kind: "fallback", reason: "name_not_found" });
  });
});

describe("brightness (light-level)", () => {
  for (const text of ["Işığın seviyesini %50 yap oturma odası", "Oturma odasında ışığın seviyesini %50'ye ayarla", "salonun ışığını yüzde 50 yap"]) {
    test(`'${text}' calls HassLightSet with brightness 50`, async () => {
      const { outcome, calls } = await run(text);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[1], { tool: "light__HassLightSet", args: { name: "Oturma Odası Işık", domain: ["light"], brightness: 50 } });
      assert.equal(outcome.kind, "reply");
      assert.match(outcome.kind === "reply" ? outcome.text : "", /yüzde 50/);
    });
  }

  test("a switch is never dimmed: not found, fallback", async () => {
    const { outcome, calls } = await run("çalışma odası ışığını %40 yap");
    assert.deepEqual(outcome, { kind: "fallback", reason: "name_not_found" });
    assert.equal(calls.length, 1);
  });

  test("HassLightSet keeps going through the gate (a denial is answered, not retried)", async () => {
    const call: GatedCall = async (tool) =>
      tool === "homeassistant__GetLiveContext" ? { status: "ok", result: { text: HOME, isError: false } } : { status: "denied", reason: "read_only" };
    const outcome = await runDirectPlan(plan("oturma odası ışığını %20 yap"), call, { fallbackOnError: true });
    assert.equal(outcome.kind, "reply");
    assert.equal(outcome.kind === "reply" ? outcome.status : "", "denied");
  });
});
