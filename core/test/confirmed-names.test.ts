/** Confirmed-name store tests (docs/14 Decision 6, T4.4a). Generic device names from the design only. */
import assert from "node:assert/strict";
import * as nodeFs from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { AtomicFs } from "../src/atomic-file.js";
import {
  CONFIRMED_NAMES_FILE,
  ConfirmedNameStore,
  fingerprintOf,
  isValidSnapshot,
  MISSING_TO_PASSIVE_MS,
  verifyTarget,
  type AddInput,
  type ConfirmedNamesFile,
  type NameTarget,
} from "../src/confirmed-names.js";
import type { LiveEntity } from "../src/live-context.js";

const base = mkdtempSync(join(tmpdir(), "shadow-confirmed-names-test-"));
after(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
const freshDir = () => join(base, `d${++n}`);
const DAY = 24 * 60 * 60 * 1000;

function clock(start = "2026-11-20T09:00:00.000Z") {
  let now = Date.parse(start);
  return { now: () => now, tick: (ms: number) => (now += ms) };
}

function entity(name: string, domain: string, areas: string[] = [], state = "off"): LiveEntity {
  return { names: [name], domain, state, areas, attributes: {} };
}

const PUMP = entity("Bahçe Pompası", "switch", ["Bahçe"]);
const LAMP = entity("Salon Lambası", "light", ["Salon"]);
const PUMP_TARGET: NameTarget = { name: "Bahçe Pompası", domain: "switch", areas: ["Bahçe"] };
const LAMP_TARGET: NameTarget = { name: "Salon Lambası", domain: "light", areas: ["Salon"] };

const pumpInput = (over: Partial<AddInput> = {}): AddInput => ({
  spoken: "bahçe pompasnı",
  keys: ["bahce pompasni", "bahce pompasn", "bahce pompas"],
  target: PUMP_TARGET,
  ...over,
});
const lampInput: AddInput = { spoken: "salon ışığı", keys: ["salon isigi", "salon isig"], target: LAMP_TARGET };

let idSeq = 0;
function store(dir: string, over: Partial<ConstructorParameters<typeof ConfirmedNameStore>[0]> = {}) {
  const c = clock();
  const logs: string[] = [];
  const s = new ConfirmedNameStore({
    dir,
    now: c.now,
    log: (m) => logs.push(m),
    retryDelaysMs: [],
    randomId: () => (++idSeq).toString(16).padStart(6, "0"),
    ...over,
  });
  return { s, c, logs };
}

const disk = (dir: string) => JSON.parse(readFileSync(join(dir, CONFIRMED_NAMES_FILE), "utf8")) as ConfirmedNamesFile;

function flakyFs() {
  const state = { failRename: false };
  const fs: AtomicFs = {
    mkdir: (p, o) => nodeFs.mkdir(p, o),
    open: (p, f, m) => nodeFs.open(p, f, m),
    rename: (a, b) => (state.failRename ? Promise.reject(Object.assign(new Error("simulated"), { code: "EIO" })) : nodeFs.rename(a, b)),
    unlink: (p) => nodeFs.unlink(p),
    readFile: (p, e) => nodeFs.readFile(p, e),
    readdir: (p) => nodeFs.readdir(p),
  };
  return { fs, state };
}

describe("snapshot checks (pure)", () => {
  test("valid snapshot: a non-empty list of well-formed entities", () => {
    assert.equal(isValidSnapshot([PUMP]), true);
    assert.equal(isValidSnapshot([]), false);
    assert.equal(isValidSnapshot(undefined), false);
    assert.equal(isValidSnapshot(null), false);
    assert.equal(isValidSnapshot("Live Context"), false);
    assert.equal(isValidSnapshot([PUMP, { names: "x", domain: "switch", areas: [] }]), false);
    assert.equal(isValidSnapshot([PUMP, { names: [], domain: "switch", areas: [] }]), false);
    assert.equal(isValidSnapshot([PUMP, null]), false);
    assert.equal(isValidSnapshot([{ names: [""], domain: "", areas: [] }]), false);
    assert.equal(isValidSnapshot([PUMP, { names: ["  "], domain: "switch", areas: [] }]), false);
    assert.equal(isValidSnapshot([PUMP, { names: ["Lamba"], domain: " ", areas: [] }]), false);
  });

  test("fingerprint: name + domain + areas; state is not part of it; unavailable is present", () => {
    assert.equal(verifyTarget(PUMP_TARGET, [LAMP, entity("Bahçe Pompası", "switch", ["Bahçe"], "unavailable")]).status, "present");
    assert.equal(verifyTarget(PUMP_TARGET, [entity("Bahçe Pompası", "light", ["Bahçe"])]).status, "missing");
    assert.equal(verifyTarget(PUMP_TARGET, [entity("Bahçe Pompası", "switch", ["Salon"])]).status, "missing");
    assert.equal(verifyTarget(PUMP_TARGET, [entity("Bahçe Pompası 2", "switch", ["Bahçe"])]).status, "missing");
    // Only the canonical name (first of names) counts, not an alias.
    assert.equal(verifyTarget(PUMP_TARGET, [{ ...PUMP, names: ["Pompa", "Bahçe Pompası"] }]).status, "missing");
    // Areas as a set; NFC and spacing do not matter.
    const multi: NameTarget = { name: "Bahçe Pompası", domain: "switch", areas: ["Bahçe", "Dış"] };
    assert.equal(verifyTarget(multi, [entity("Bahçe  Pompası", "switch", ["Dış", "Bahçe"])]).status, "present");
    assert.deepEqual(fingerprintOf(PUMP), PUMP_TARGET);
  });

  test("two entities with the same fingerprint are ambiguous (not used)", () => {
    const v = verifyTarget(PUMP_TARGET, [PUMP, LAMP, { ...PUMP, state: "on" }]);
    assert.deepEqual(v, { status: "ambiguous", count: 2 });
  });

  test("an invalid snapshot is reported as such", () => {
    assert.equal(verifyTarget(PUMP_TARGET, []).status, "invalid_snapshot");
    assert.equal(verifyTarget(PUMP_TARGET, undefined).status, "invalid_snapshot");
  });
});

describe("ConfirmedNameStore", () => {
  test("add, lookup, verify, list and the file on disk", async () => {
    const dir = freshDir();
    const { s } = store(dir);
    await s.load();
    assert.equal(s.lookup(["bahce pompasni"]), undefined);
    const r = await s.add(pumpInput());
    assert.ok(r.ok);
    assert.match(r.entry.id, /^n-[0-9a-f]{6}$/);
    assert.equal(r.entry.status, "active");
    assert.equal(r.entry.missingSince, null);
    assert.equal(r.entry.createdAt, "2026-11-20T09:00:00.000Z");
    assert.deepEqual(r.replaced, []);

    const hit = s.lookup(["bahce pompa", "bahce pompas"]);
    assert.equal(hit?.id, r.entry.id);
    assert.ok(Object.isFrozen(hit) && Object.isFrozen(hit?.target));
    assert.equal(s.verify(hit!, [LAMP, PUMP]).status, "present");

    const f = disk(dir);
    assert.equal(f.version, 1);
    assert.equal(f.names.length, 1);
    assert.deepEqual(f.names[0]?.target, PUMP_TARGET);
    assert.deepEqual((await s.list()).map((e) => e.id), [r.entry.id]);
  });

  test("lookup: keys hitting two different entries give no result (no guess)", async () => {
    const { s } = store(freshDir());
    await s.add(pumpInput());
    await s.add(lampInput);
    assert.equal(s.lookup(["bahce pompas", "salon isig"]), undefined);
    assert.equal(s.lookup(["salon isig", "nothing"])?.target.name, "Salon Lambası");
  });

  test("a store reloads its file (new instance)", async () => {
    const dir = freshDir();
    const { s } = store(dir);
    const r = await s.add(pumpInput());
    assert.ok(r.ok);
    const { s: s2 } = store(dir);
    assert.equal(s2.lookup(["bahce pompas"]), undefined, "empty before load");
    await s2.load();
    assert.equal(s2.lookup(["bahce pompas"])?.id, r.entry.id);
  });

  test("add replaces every entry that shares a key, active or passive", async () => {
    const dir = freshDir();
    const { s } = store(dir);
    const a = await s.add(pumpInput({ keys: ["bahce pompasni", "bahce pompas"] }));
    const b = await s.add(lampInput);
    assert.ok(a.ok && b.ok);
    const c = await s.add(pumpInput({ keys: ["bahce pompas", "salon isig"], target: { ...PUMP_TARGET, areas: ["Dış"] } }));
    assert.ok(c.ok);
    assert.deepEqual([...c.replaced].sort(), [a.entry.id, b.entry.id].sort());
    const all = await s.list();
    assert.deepEqual(all.map((e) => e.id), [c.entry.id]);
    assert.equal(s.lookup(["bahce pompasni"]), undefined, "keys of the replaced entry are gone");
    assert.deepEqual(s.lookup(["salon isig"])?.target.areas, ["Dış"]);
  });

  test("invalid input is refused without touching the file", async () => {
    const dir = freshDir();
    const { s } = store(dir);
    for (const bad of [
      pumpInput({ keys: [] }),
      pumpInput({ keys: ["  "] }),
      pumpInput({ spoken: "" }),
      pumpInput({ spoken: "x".repeat(201) }),
      pumpInput({ keys: Array.from({ length: 17 }, (_, i) => `k${i}`) }),
      pumpInput({ target: { ...PUMP_TARGET, name: " " } }),
      pumpInput({ target: { ...PUMP_TARGET, domain: "Switch!" } }),
    ]) {
      assert.deepEqual(await s.add(bad), { ok: false, reason: "invalid" });
    }
    assert.equal(existsSync(join(dir, CONFIRMED_NAMES_FILE)), false);
  });

  test("cap: at the limit a new entry is refused and logged, nothing is evicted; a replacement still works", async () => {
    const dir = freshDir();
    const { s, logs } = store(dir, { maxNames: 2 });
    const a = await s.add(pumpInput());
    const b = await s.add(lampInput);
    assert.ok(a.ok && b.ok);
    const c = await s.add({ spoken: "mutfak", keys: ["mutfak"], target: { name: "Mutfak Lambası", domain: "light", areas: ["Mutfak"] } });
    assert.deepEqual(c, { ok: false, reason: "cap" });
    assert.ok(logs.some((l) => /cap of 2 reached/.test(l)));
    assert.ok(!logs.some((l) => /mutfak|Mutfak/.test(l)), "no user words in the log");
    assert.equal(disk(dir).names.length, 2);
    // Same key as an existing entry: replaces, so it fits.
    const d = await s.add(pumpInput({ target: { ...PUMP_TARGET, areas: ["Dış"] } }));
    assert.ok(d.ok);
    assert.equal(disk(dir).names.length, 2);
  });

  test("a file above the cap (hand edit) is kept whole; add refuses until rows are deleted", async () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    const entries = Array.from({ length: 3 }, (_, i) => ({
      id: `n-00000${i}`,
      spoken: `ad ${i}`,
      keys: [`ad ${i}`],
      target: { name: `Cihaz ${i}`, domain: "switch", areas: [] },
      status: "active",
      missingSince: null,
      createdAt: "2026-11-01T00:00:00.000Z",
      lastUsedAt: null,
      uses: 0,
    }));
    writeFileSync(join(dir, CONFIRMED_NAMES_FILE), JSON.stringify({ version: 1, names: entries }));
    const { s } = store(dir, { maxNames: 2 });
    assert.deepEqual(await s.add(lampInput), { ok: false, reason: "cap" });
    assert.equal((await s.list()).length, 3);
    assert.deepEqual(await s.delete("n-000000"), { ok: true });
    assert.deepEqual(await s.add(lampInput), { ok: false, reason: "cap" });
    assert.deepEqual(await s.delete("n-000001"), { ok: true });
    assert.ok((await s.add(lampInput)).ok);
  });

  test("delete: any status; unknown id", async () => {
    const dir = freshDir();
    const { s } = store(dir);
    const r = await s.add(pumpInput());
    assert.ok(r.ok);
    assert.deepEqual(await s.delete("n-ffffff"), { ok: false, reason: "unknown" });
    assert.deepEqual(await s.delete(r.entry.id), { ok: true });
    assert.equal(s.lookup(["bahce pompas"]), undefined);
    assert.deepEqual(disk(dir).names, []);
  });

  test("recordUse counts uses of active entries", async () => {
    const dir = freshDir();
    const { s, c } = store(dir);
    const r = await s.add(pumpInput());
    assert.ok(r.ok);
    c.tick(DAY);
    assert.equal(await s.recordUse(r.entry.id), true);
    assert.equal(await s.recordUse("n-ffffff"), false);
    const e = disk(dir).names[0];
    assert.equal(e?.uses, 1);
    assert.equal(e?.lastUsedAt, "2026-11-21T09:00:00.000Z");
  });

  test("atomic write: a failed add leaves file and memory unchanged; a failed sweep is retried by the next change", async () => {
    const dir = freshDir();
    const { fs, state } = flakyFs();
    const { s, c, logs } = store(dir, { fs });
    const a = await s.add(pumpInput());
    assert.ok(a.ok);
    const before = readFileSync(join(dir, CONFIRMED_NAMES_FILE), "utf8");

    state.failRename = true;
    assert.deepEqual(await s.add(lampInput), { ok: false, reason: "write_failed" });
    assert.equal(s.lookup(["salon isig"]), undefined);
    assert.equal(readFileSync(join(dir, CONFIRMED_NAMES_FILE), "utf8"), before);
    assert.deepEqual(readdirSync(dir), [CONFIRMED_NAMES_FILE], "no temp file left behind");
    assert.ok(logs.some((l) => /write failed, change not applied: EIO/.test(l)));

    // Sweep applies in memory at once; the write is retried by the next change.
    c.tick(DAY);
    const sw = await s.sweep([LAMP]);
    assert.equal(sw.started, 1);
    assert.equal(disk(dir).names[0]?.missingSince, null);
    state.failRename = false;
    await s.flush();
    assert.equal(disk(dir).names[0]?.missingSince, "2026-11-21T09:00:00.000Z");
  });

  test("a failed delete keeps the entry; a failed passivation stops use at once and lands with the next write", async () => {
    const dir = freshDir();
    const { fs, state } = flakyFs();
    const { s, c } = store(dir, { fs });
    const a = await s.add(pumpInput());
    assert.ok(a.ok);
    state.failRename = true;
    assert.deepEqual(await s.delete(a.entry.id), { ok: false, reason: "write_failed" });
    assert.equal(s.lookup(["bahce pompas"])?.id, a.entry.id);
    assert.equal(disk(dir).names.length, 1);

    await s.sweep([LAMP]);
    c.tick(MISSING_TO_PASSIVE_MS);
    assert.equal((await s.sweep([LAMP])).passivated, 1);
    assert.equal(s.lookup(["bahce pompas"]), undefined, "passive in memory although not on disk");
    assert.equal(disk(dir).names[0]?.status, "active");
    state.failRename = false;
    await s.flush();
    assert.equal(disk(dir).names[0]?.status, "passive");
  });

  test("sweep works on the snapshot as it was when called", async () => {
    const dir = freshDir();
    const { s } = store(dir);
    const a = await s.add(pumpInput());
    assert.ok(a.ok);
    const snap = [{ ...PUMP, names: [...PUMP.names] }, LAMP];
    const pending = s.sweep(snap);
    (snap[0] as LiveEntity).names[0] = "Başka Cihaz";
    assert.equal((await pending).started, 0);
    assert.equal(disk(dir).names[0]?.missingSince, null);
  });

  test("serial chain: concurrent adds all land", async () => {
    const dir = freshDir();
    const { s } = store(dir);
    const inputs = Array.from({ length: 10 }, (_, i) => ({ spoken: `ad ${i}`, keys: [`ad ${i}`], target: { name: `Cihaz ${i}`, domain: "switch", areas: [] } }));
    const results = await Promise.all(inputs.map((x) => s.add(x)));
    assert.ok(results.every((r) => r.ok));
    assert.equal(disk(dir).names.length, 10);
  });
});

describe("quarantine", () => {
  for (const [label, content] of [
    ["not JSON", "{ nope"],
    ["wrong version", JSON.stringify({ version: 2, names: [] })],
    ["malformed entry", JSON.stringify({ version: 1, names: [{ id: "n-000001" }] })],
    [
      "a key used by two entries",
      JSON.stringify({
        version: 1,
        names: ["n-000001", "n-000002"].map((id) => ({
          id,
          spoken: "ad",
          keys: ["ad"],
          target: { name: "Cihaz", domain: "switch", areas: [] },
          status: "active",
          missingSince: null,
          createdAt: "2026-11-01T00:00:00.000Z",
          lastUsedAt: null,
          uses: 0,
        })),
      }),
    ],
  ] as const) {
    test(`${label}: moved aside, one warning, start empty, next add writes a fresh file`, async () => {
      const dir = freshDir();
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, CONFIRMED_NAMES_FILE), content);
      const { s, logs } = store(dir);
      await s.load();
      assert.deepEqual(await s.list(), []);
      assert.equal(logs.filter((l) => /moved aside/.test(l)).length, 1);
      assert.ok(readdirSync(dir).some((f) => f.startsWith(`${CONFIRMED_NAMES_FILE}.corrupt-`)));
      assert.ok((await s.add(pumpInput())).ok);
      assert.equal(disk(dir).names.length, 1);
    });
  }

  test("a valid hand-edited file with extra spaces or another Unicode form is normalized, not quarantined", async () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    const entry = {
      id: "n-3f9a1c",
      spoken: " bahçe  pompasnı ",
      keys: ["bahce pompasni "],
      target: { name: "Bahçe Pompası", domain: "switch", areas: ["Bahçe"] },
      status: "active",
      missingSince: null,
      createdAt: "2026-11-20T09:12:00.000Z",
      lastUsedAt: "2026-11-21T18:40:00.000Z",
      uses: 4,
    };
    writeFileSync(join(dir, CONFIRMED_NAMES_FILE), JSON.stringify({ version: 1, names: [entry] }));
    const { s } = store(dir);
    await s.load();
    const hit = s.lookup(["bahce pompasni"]);
    assert.equal(hit?.spoken, "bahçe pompasnı");
    assert.equal(hit?.target.name, "Bahçe Pompası");
    assert.equal(s.verify(hit!, [PUMP]).status, "present");
  });

  test("an invalid file that cannot be moved aside is never overwritten", async () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, CONFIRMED_NAMES_FILE), "{ nope");
    const { fs, state } = flakyFs();
    state.failRename = true;
    const { s, logs } = store(dir, { fs });
    assert.deepEqual(await s.add(pumpInput()), { ok: false, reason: "unavailable" });
    assert.equal(readFileSync(join(dir, CONFIRMED_NAMES_FILE), "utf8"), "{ nope");
    assert.ok(logs.some((l) => /could not be read: QUARANTINE_FAILED/.test(l)));
  });
});

describe("sweep: missing clock and passive", () => {
  async function withPump() {
    const dir = freshDir();
    const h = store(dir);
    const r = await h.s.add(pumpInput());
    assert.ok(r.ok);
    return { ...h, dir, id: r.entry.id };
  }

  test("an invalid, empty or malformed snapshot changes nothing", async () => {
    const { s, c, dir } = await withPump();
    const before = readFileSync(join(dir, CONFIRMED_NAMES_FILE), "utf8");
    for (const snap of [undefined, null, [], "error", [{ names: "Bahçe Pompası", domain: "switch", areas: [] }], [LAMP, null], [{ names: [""], domain: "", areas: [] }]]) {
      c.tick(40 * DAY);
      assert.deepEqual(await s.sweep(snap), { checked: false, started: 0, cleared: 0, passivated: 0 });
    }
    assert.equal(readFileSync(join(dir, CONFIRMED_NAMES_FILE), "utf8"), before);
    assert.equal(s.lookup(["bahce pompas"])?.status, "active");
  });

  test("missing sets the clock once; present clears it; nothing written when nothing changes", async () => {
    const { s, c, dir } = await withPump();
    assert.deepEqual(await s.sweep([PUMP, LAMP]), { checked: true, started: 0, cleared: 0, passivated: 0 });
    c.tick(DAY);
    assert.equal((await s.sweep([LAMP])).started, 1);
    assert.equal(disk(dir).names[0]?.missingSince, "2026-11-21T09:00:00.000Z");
    c.tick(DAY);
    assert.equal((await s.sweep([LAMP])).started, 0);
    assert.equal(disk(dir).names[0]?.missingSince, "2026-11-21T09:00:00.000Z", "measured from the first miss");
    assert.equal(s.lookup(["bahce pompas"])?.missingSince, "2026-11-21T09:00:00.000Z");
    // Back (even unavailable): cleared, usable again at once.
    c.tick(DAY);
    assert.equal((await s.sweep([entity("Bahçe Pompası", "switch", ["Bahçe"], "unavailable")])).cleared, 1);
    assert.equal(disk(dir).names[0]?.missingSince, null);
    assert.equal(s.lookup(["bahce pompas"])?.status, "active");
  });

  test("ambiguous counts as present for the clock", async () => {
    const { s, c, dir } = await withPump();
    c.tick(DAY);
    await s.sweep([LAMP]);
    c.tick(DAY);
    assert.equal((await s.sweep([PUMP, { ...PUMP }])).cleared, 1);
    assert.equal(disk(dir).names[0]?.missingSince, null);
    assert.equal(s.verify(s.lookup(["bahce pompas"])!, [PUMP, { ...PUMP }]).status, "ambiguous");
  });

  test("30 days missing without a break → passive; passive is not used, not swept, and stays after the device returns", async () => {
    const { s, c, dir, id, logs } = await withPump();
    await s.sweep([LAMP]);
    c.tick(MISSING_TO_PASSIVE_MS - 1);
    assert.equal((await s.sweep([LAMP])).passivated, 0);
    c.tick(1);
    assert.equal((await s.sweep([LAMP])).passivated, 1);
    assert.equal(disk(dir).names[0]?.status, "passive");
    assert.ok(logs.some((l) => l.includes(id) && /passive/.test(l)));
    assert.ok(!logs.some((l) => /Bahçe|bahce/.test(l)), "no device names or user words in the log");
    assert.equal(s.lookup(["bahce pompas"]), undefined, "passive is never matched");
    // The device comes back: still passive, never reactivated by itself.
    c.tick(DAY);
    assert.deepEqual(await s.sweep([PUMP]), { checked: true, started: 0, cleared: 0, passivated: 0 });
    assert.equal(disk(dir).names[0]?.status, "passive");
    assert.equal(s.verify(disk(dir).names[0]!, [PUMP]).status, "missing");
    // Survives a reload.
    const { s: s2 } = store(dir);
    await s2.load();
    assert.equal(s2.lookup(["bahce pompas"]), undefined);
    assert.equal((await s2.list())[0]?.status, "passive");
    // Not deleted automatically; a fresh confirmation replaces it with an active entry.
    const again = await s2.add(pumpInput());
    assert.ok(again.ok);
    assert.deepEqual(again.replaced, [id]);
    assert.equal(s2.lookup(["bahce pompas"])?.status, "active");
    assert.equal(s2.lookup(["bahce pompas"])?.missingSince, null);
  });

  test("a sighting inside the 30 days restarts the count", async () => {
    const { s, c, dir } = await withPump();
    await s.sweep([LAMP]);
    c.tick(20 * DAY);
    await s.sweep([PUMP]);
    c.tick(DAY);
    await s.sweep([LAMP]);
    c.tick(20 * DAY);
    assert.equal((await s.sweep([LAMP])).passivated, 0);
    assert.equal(disk(dir).names[0]?.status, "active");
  });

  test("invalid snapshots in between neither clear nor restart the clock", async () => {
    const { s, c, dir } = await withPump();
    await s.sweep([LAMP]);
    c.tick(15 * DAY);
    await s.sweep([]);
    await s.sweep(undefined);
    c.tick(15 * DAY);
    assert.equal((await s.sweep([LAMP])).passivated, 1);
    assert.equal(disk(dir).names[0]?.missingSince, "2026-11-20T09:00:00.000Z");
  });
});
