/** dev-notes store tests (T7.y): one note per kind + tool, counters instead of repeats. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  capNotes,
  DEV_NOTES_FILE,
  DevNotes,
  INVALID_NAME,
  MAX_NOTES,
  MAX_WANDER_TOOLS,
  observeNote,
  toolNoteKey,
  TURN_NOTES_FILE,
  turnNoteKey,
  TurnNotes,
  type CatalogEntry,
  type TurnNotesFile,
} from "../src/dev-notes.js";

const base = mkdtempSync(join(tmpdir(), "shadow-devnotes-test-"));
after(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
const entry = (name: string, classified = true, level = "write"): CatalogEntry => ({ name, classified, level });

test("first list: unclassified tools and stale exact rules noted; no 'added' flood; catalog stored", async () => {
  const dir = join(base, `d${++n}`);
  const notes = new DevNotes({ dir, now: () => Date.parse("2026-11-03T10:00:00Z") });
  await notes.recordCatalog("ha", [entry("a"), entry("b", false, "confirm")], ["a", "gone_rule"]);
  const f = await notes.read();
  assert.deepEqual(f.catalog, { ha: ["a", "b"] });
  assert.deepEqual(
    f.notes.map((x) => [x.kind, x.tool, x.count]),
    [
      ["new_tool", "b", 1],
      ["rule_unmatched", "gone_rule", 1],
    ],
  );
  assert.equal(f.notes[0]?.message, "yeni araç: sınıflandır");
  assert.equal(f.notes[0]?.level, "confirm");
  // On disk, in the dev-notes folder.
  const disk = JSON.parse(readFileSync(join(dir, DEV_NOTES_FILE), "utf8")) as { version: number };
  assert.equal(disk.version, 1);
});

test("next lists: added and removed tools (a rename shows as both); repeats only bump the counter after touchMs", async () => {
  const dir = join(base, `d${++n}`);
  let now = Date.parse("2026-11-03T10:00:00Z");
  const notes = new DevNotes({ dir, now: () => now, touchMs: 60_000 });
  await notes.recordCatalog("ha", [entry("a"), entry("old_name")]);
  now += 1_000;
  await notes.recordCatalog("ha", [entry("a"), entry("new_name", false, "confirm")]);
  let f = await notes.read();
  assert.deepEqual(
    f.notes.map((x) => `${x.kind}:${x.tool}`).sort(),
    ["new_tool:new_name", "tool_added:new_name", "tool_removed:old_name"],
  );
  assert.deepEqual(f.catalog.ha, ["a", "new_name"]);

  // Same list again inside touchMs: nothing changes, nothing is written.
  const mtime = statSync(join(dir, DEV_NOTES_FILE)).mtimeMs;
  now += 1_000;
  await notes.recordCatalog("ha", [entry("a"), entry("new_name", false, "confirm")]);
  assert.equal(statSync(join(dir, DEV_NOTES_FILE)).mtimeMs, mtime);
  f = await notes.read();
  assert.equal(f.notes.find((x) => x.kind === "new_tool")?.count, 1);

  // After touchMs: count + lastSeen, still one note.
  now += 120_000;
  await notes.recordCatalog("ha", [entry("a"), entry("new_name", false, "confirm")]);
  f = await notes.read();
  const fresh = f.notes.filter((x) => x.kind === "new_tool");
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0]?.count, 2);
  assert.equal(fresh[0]?.lastSeen, new Date(now).toISOString());

  // A fresh instance reads the same file (survives a Core restart).
  const again = new DevNotes({ dir, now: () => now, touchMs: 60_000 });
  assert.deepEqual(await again.read(), f);
});

test("an invalid file is moved aside and a fresh one started; write failures never throw", async () => {
  const dir = join(base, `d${++n}`);
  const notes = new DevNotes({ dir });
  await notes.recordCatalog("ha", [entry("a")]);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, DEV_NOTES_FILE), "{ not json");
  const logs: string[] = [];
  const fresh = new DevNotes({ dir, log: (m) => logs.push(m) });
  await fresh.recordCatalog("ha", [entry("a")]);
  assert.deepEqual((await fresh.read()).catalog, { ha: ["a"] });
  assert.ok(logs.some((l) => l.includes("invalid")));

  // dir is a file → mkdir fails → logged, not thrown.
  const blocked = join(base, `d${++n}`);
  writeFileSync(blocked, "x");
  const bad = new DevNotes({ dir: join(blocked, "sub"), log: (m) => logs.push(m) });
  await bad.recordCatalog("ha", [entry("a")]);
  assert.ok(logs.some((l) => l.includes("dev-notes write failed")));
});

// ---------------------------------------------------------------------------
// T7.w.3a: shared helper, status and turns.json

test("tools.json: status ignored keeps counting; fixed reopens on the next observation after statusAt", async () => {
  const dir = join(base, `d${++n}`);
  let now = Date.parse("2026-11-07T10:00:00Z");
  const notes = new DevNotes({ dir, now: () => now, touchMs: 60_000 });
  await notes.recordCatalog("ha", [entry("a"), entry("b", false, "confirm")], ["gone"]);
  assert.equal(await notes.setStatus(toolNoteKey({ kind: "new_tool", service: "ha", tool: "b" }), "fixed"), true);
  assert.equal(await notes.setStatus(toolNoteKey({ kind: "rule_unmatched", service: "ha", tool: "gone" }), "ignored"), true);
  assert.equal(await notes.setStatus(toolNoteKey({ kind: "new_tool", service: "ha", tool: "nope" }), "fixed"), false);
  let f = await notes.read();
  assert.equal(f.notes.find((x) => x.tool === "b")?.status, "fixed");
  assert.equal(f.notes.find((x) => x.tool === "b")?.statusAt, new Date(now).toISOString());
  // On disk too (immediate write), and a fresh instance keeps the fields.
  assert.deepEqual(await new DevNotes({ dir }).read(), f);

  // Same instant as statusAt: not "after", stays fixed.
  await notes.recordCatalog("ha", [entry("a"), entry("b", false, "confirm")], ["gone"]);
  assert.equal((await notes.read()).notes.find((x) => x.tool === "b")?.status, "fixed");

  // Later, still unclassified: open again (even inside touchMs); ignored stays ignored and counts after touchMs.
  now += 120_000;
  await notes.recordCatalog("ha", [entry("a"), entry("b", false, "confirm")], ["gone"]);
  f = await notes.read();
  const b = f.notes.find((x) => x.tool === "b");
  assert.equal(b?.status, undefined);
  assert.equal(b?.statusAt, undefined);
  const gone = f.notes.find((x) => x.tool === "gone");
  assert.equal(gone?.status, "ignored");
  assert.equal(gone?.count, 2);
});

test("observeNote / capNotes: touchMs, every-occurrence mode, cap keeps the most recently seen", () => {
  type N = { id: string; count: number; firstSeen: string; lastSeen: string };
  const notes: N[] = [];
  const keyOf = (x: N) => x.id;
  const mk = (id: string) => (stamp: string) => ({ id, count: 1, firstSeen: stamp, lastSeen: stamp });
  assert.equal(observeNote(notes, keyOf, "a", 1_000, mk("a"), 10_000).created, true);
  assert.equal(observeNote(notes, keyOf, "a", 2_000, mk("a"), 10_000).changed, false);
  assert.equal(observeNote(notes, keyOf, "a", 3_000, mk("a")).changed, true);
  assert.equal(notes[0]?.count, 2);
  for (let i = 0; i < 5; i++) observeNote(notes, keyOf, `k${i}`, 10_000 + i, mk(`k${i}`));
  assert.equal(capNotes(notes, 3), true);
  assert.deepEqual(notes.map((x) => x.id), ["k4", "k3", "k2"]);
  assert.equal(capNotes(notes, 3), false);
});

const T0 = Date.parse("2026-11-07T12:00:00Z");

test("turns.json: each kind becomes one note per key, every occurrence counts, lastTurnId follows", async () => {
  const dir = join(base, `d${++n}`);
  let now = T0;
  const turns = new TurnNotes({ dir, now: () => now, coalesceMs: 0 });
  await turns.record({ kind: "missing_capability", reason: "builtin", tool: "Bash", turnId: "t-1" });
  await turns.record({ kind: "missing_capability", reason: "unknown_tool", service: "ha", tool: "mcp__ha__Nope", turnId: "t-2" });
  await turns.record({ kind: "missing_capability", reason: "tier_service", service: "memory", tool: "mcp__memory__save", turnId: "t-3" });
  await turns.record({
    kind: "wandering",
    trigger: "calls",
    tier: 1,
    routeSource: "static",
    routeRule: "light-on",
    tools: ["mcp__ha__b", "mcp__ha__a", "mcp__ha__b", "t3", "t4", "t5", "t6"],
    turnId: "t-4",
  });
  await turns.record({ kind: "tool_error", service: "ha", tool: "mcp__ha__HassTurnOn", errorClass: "error", turnId: "t-5" });
  await turns.record({ kind: "tool_error", service: "ha", tool: "mcp__ha__HassTurnOn", errorClass: "unavailable", turnId: "t-6" });
  await turns.record({ kind: "rule_suspended", ruleId: "lr-1a2b", reason: "name_not_found", turnId: "t-7" });

  let f = await turns.read();
  assert.equal(f.version, 1);
  assert.deepEqual(
    f.notes.map((x) => x.kind),
    ["missing_capability", "missing_capability", "missing_capability", "wandering", "tool_error", "tool_error", "rule_suspended"],
  );
  const wander = f.notes.find((x) => x.kind === "wandering");
  // Sorted, unique, at most MAX_WANDER_TOOLS.
  assert.deepEqual(wander?.tools, ["mcp__ha__a", "mcp__ha__b", "t3", "t4", "t5"]);
  assert.equal(wander?.tools?.length, MAX_WANDER_TOOLS);
  assert.equal(wander?.tier, 1);
  assert.equal(wander?.routeRule, "light-on");
  assert.equal(wander?.trigger, "calls");
  assert.equal(f.notes.find((x) => x.reason === "builtin")?.message, "model kapalı bir yerleşik araç istedi");
  assert.equal(f.notes.find((x) => x.errorClass === "unavailable")?.message, "servise ulaşılamadı");
  for (const x of f.notes) {
    assert.equal(x.count, 1);
    assert.equal(x.firstSeen, new Date(T0).toISOString());
    assert.ok(x.lastTurnId?.startsWith("t-"));
  }

  // Repeats a second later: same notes, count 2, lastSeen / lastTurnId / trigger updated; tool order does not matter.
  now += 1_000;
  await turns.record({ kind: "missing_capability", reason: "builtin", tool: "Bash", turnId: "t-8" });
  await turns.record({
    kind: "wandering",
    trigger: "tool_cap",
    tier: 1,
    routeSource: "static",
    routeRule: "light-on",
    tools: ["t6", "t5", "t4", "t3", "mcp__ha__a", "mcp__ha__b"],
    turnId: "t-9",
  });
  // A different tier is a different wandering note.
  await turns.record({ kind: "wandering", trigger: "calls", tier: 2, routeSource: "default", tools: ["mcp__ha__a"] });
  f = await turns.read();
  assert.equal(f.notes.length, 8);
  const bash = f.notes.find((x) => x.reason === "builtin");
  assert.equal(bash?.count, 2);
  assert.equal(bash?.lastSeen, new Date(now).toISOString());
  assert.equal(bash?.lastTurnId, "t-8");
  const w = f.notes.filter((x) => x.kind === "wandering");
  assert.equal(w[0]?.count, 2);
  assert.equal(w[0]?.trigger, "tool_cap");
  assert.equal(w[0]?.lastTurnId, "t-9");
  assert.equal(w[1]?.lastTurnId, undefined);

  // Invalid enum values are ignored (nothing recorded).
  await turns.record({ kind: "tool_error", service: "ha", tool: "x", errorClass: "boom" as never });
  await turns.record({ kind: "rule_suspended", ruleId: "lr-1", reason: "Has Spaces" });
  await turns.record({ kind: "other" } as never);
  assert.equal((await turns.read()).notes.length, 8);

  // Survives a restart.
  assert.deepEqual(await new TurnNotes({ dir }).read(), f);
  const disk = JSON.parse(readFileSync(join(dir, TURN_NOTES_FILE), "utf8")) as { version: number };
  assert.equal(disk.version, 1);
});

test("turns.json: reopen after fixed, ignored keeps counting without reopening", async () => {
  const dir = join(base, `d${++n}`);
  let now = T0;
  const turns = new TurnNotes({ dir, now: () => now, coalesceMs: 0 });
  const err = { kind: "tool_error", service: "ha", tool: "mcp__ha__HassTurnOn", errorClass: "error" } as const;
  const sus = { kind: "rule_suspended", ruleId: "lr-1", reason: "ambiguous" } as const;
  await turns.record(err);
  await turns.record(sus);
  const [first, second] = (await turns.read()).notes;
  assert.ok(first && second);
  const errKey = turnNoteKey(first);
  const susKey = turnNoteKey(second);
  now += 1_000;
  assert.equal(await turns.setStatus(errKey, "fixed"), true);
  assert.equal(await turns.setStatus(susKey, "ignored"), true);
  assert.equal(await turns.setStatus("nope", "fixed"), false);
  let f = await turns.read();
  assert.equal(f.notes[0]?.status, "fixed");
  assert.equal(f.notes[0]?.statusAt, new Date(now).toISOString());

  now += 1_000;
  await turns.record(err);
  await turns.record(sus);
  f = await turns.read();
  assert.equal(f.notes[0]?.status, undefined);
  assert.equal(f.notes[0]?.statusAt, undefined);
  assert.equal(f.notes[0]?.count, 2);
  assert.equal(f.notes[1]?.status, "ignored");
  assert.equal(f.notes[1]?.count, 2);
});

test("turns.json: writes are coalesced and flushed; a failed write keeps the notes and is retried", async () => {
  const dir = join(base, `d${++n}`);
  const logs: string[] = [];
  const turns = new TurnNotes({ dir, now: () => T0, coalesceMs: 60_000, log: (m) => logs.push(m) });
  const file = join(dir, TURN_NOTES_FILE);
  for (let i = 0; i < 10; i++) await turns.record({ kind: "missing_capability", reason: "builtin", tool: "Bash" });
  // Nothing on disk yet; the in-memory view already has the notes.
  assert.equal(existsSync(file), false);
  assert.equal((await turns.read()).notes[0]?.count, 10);
  await turns.flush();
  assert.equal((JSON.parse(readFileSync(file, "utf8")) as TurnNotesFile).notes[0]?.count, 10);
  // A flush with nothing pending does not write.
  const mtime = statSync(file).mtimeMs;
  await turns.flush();
  assert.equal(statSync(file).mtimeMs, mtime);

  // The timer writes without a flush.
  const quick = new TurnNotes({ dir: join(base, `d${++n}`), now: () => T0, coalesceMs: 20 });
  await quick.record({ kind: "missing_capability", reason: "builtin", tool: "Bash" });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(existsSync(quick.file), true);

  // Write failure: the target is a directory, so the rename fails. Logged, not thrown; notes kept.
  await turns.record({ kind: "missing_capability", reason: "builtin", tool: "Read" });
  rmSync(file);
  mkdirSync(file);
  await turns.flush();
  assert.ok(logs.some((l) => l.includes("dev-notes (turns) write failed")));
  assert.equal((await turns.read()).notes.length, 2);
  // Next flush retries and succeeds.
  rmSync(file, { recursive: true });
  await turns.flush();
  assert.equal((JSON.parse(readFileSync(file, "utf8")) as TurnNotesFile).notes.length, 2);
});

test("immediate mode: a failed write stays pending and flush() writes it once the disk recovers", async () => {
  const dir = join(base, `d${++n}`);
  const logs: string[] = [];
  const turns = new TurnNotes({ dir, now: () => T0, coalesceMs: 0, log: (m) => logs.push(m) });
  const file = join(dir, TURN_NOTES_FILE);
  await turns.record({ kind: "missing_capability", reason: "builtin", tool: "Bash" });
  rmSync(file);
  mkdirSync(file);
  await turns.record({ kind: "missing_capability", reason: "builtin", tool: "Read" });
  assert.ok(logs.some((l) => l.includes("dev-notes (turns) write failed")));
  rmSync(file, { recursive: true });
  await turns.flush();
  assert.equal((JSON.parse(readFileSync(file, "utf8")) as TurnNotesFile).notes.length, 2);
});

test("turns.json: an invalid file is quarantined; unknown note kinds dropped; cap of MAX_NOTES", async () => {
  const dir = join(base, `d${++n}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, TURN_NOTES_FILE), "{ broken");
  const logs: string[] = [];
  let now = T0;
  const turns = new TurnNotes({ dir, now: () => now, coalesceMs: 0, log: (m) => logs.push(m) });
  await turns.record({ kind: "missing_capability", reason: "builtin", tool: "Bash" });
  assert.ok(logs.some((l) => l.includes("invalid")));
  assert.ok(readdirSync(dir).some((x) => x.startsWith(`${TURN_NOTES_FILE}.corrupt-`)));

  writeFileSync(
    join(dir, TURN_NOTES_FILE),
    JSON.stringify({ version: 1, notes: [{ kind: "future_kind", count: 1, firstSeen: "x", lastSeen: "x" }] }),
  );
  assert.deepEqual((await new TurnNotes({ dir }).read()).notes, []);

  const capped = new TurnNotes({ dir: join(base, `d${++n}`), now: () => now, coalesceMs: 0 });
  for (let i = 0; i < MAX_NOTES + 5; i++) {
    now += 1;
    await capped.record({ kind: "tool_error", service: "ha", tool: `t${i}`, errorClass: "error" });
  }
  const f = await capped.read();
  assert.equal(f.notes.length, MAX_NOTES);
  // The least recently seen (t0…t4) were dropped.
  assert.ok(!f.notes.some((x) => ["t0", "t4"].includes(x.tool ?? "")));
  assert.ok(f.notes.some((x) => x.tool === `t${MAX_NOTES + 4}`));
});

test("privacy: arguments, user text, entity names and error messages never reach tools.json or turns.json", async () => {
  const dir = join(base, `d${++n}`);
  // Test values only; deliberately not shaped like any real token format.
  const SECRET = "not-a-real-secret-123";
  const TEXT = "salon lambasını yüzde elli yap";
  const ENTITY = "light.salon_lambasi_test";
  const ROOM = "Çalışma Odası Test";
  const ERROR = "Connection refused at http://ha.local:8123/api?token=not-a-real-secret-123";
  const sentinels = [SECRET, TEXT, ENTITY, ROOM, ERROR, "salon", "Çalışma", "8123", "http"];
  const extra = {
    args: { entity_id: ENTITY, name: ROOM, password: SECRET },
    arguments: JSON.stringify({ entity_id: ENTITY, token: SECRET }),
    text: TEXT,
    utterance: TEXT,
    result: { content: [{ type: "text", text: ERROR }] },
    error: ERROR,
    entity: ENTITY,
    area: ROOM,
    url: ERROR,
  };

  const turns = new TurnNotes({ dir, now: () => T0, coalesceMs: 0 });
  // Whitelisted string fields that do not look like identifiers become "?"; a bad turn id is dropped.
  await turns.record({ ...extra, kind: "missing_capability", reason: "unknown_tool", service: ROOM, tool: `${TEXT} ${SECRET}`, turnId: ERROR } as never);
  await turns.record({ ...extra, kind: "missing_capability", reason: "builtin", tool: "Bash", turnId: "t-1" } as never);
  await turns.record({
    ...extra,
    kind: "wandering",
    trigger: "calls",
    tier: 2,
    routeSource: TEXT,
    routeRule: ERROR,
    tools: ["mcp__ha__HassTurnOn", TEXT, ERROR],
  } as never);
  await turns.record({ ...extra, kind: "tool_error", service: "ha", tool: "mcp__ha__HassTurnOn", errorClass: "error" } as never);
  await turns.record({ ...extra, kind: "rule_suspended", ruleId: TEXT, reason: "is_error" } as never);
  await turns.flush();

  const tools = new DevNotes({ dir, now: () => T0 });
  const catalog = [
    { ...extra, name: "a", classified: false, level: "confirm", description: `${TEXT} ${ERROR}`, inputSchema: { entity_id: ENTITY } },
  ] as unknown as CatalogEntry[];
  await tools.recordCatalog("ha", catalog, ["gone"]);

  const turnsRaw = readFileSync(join(dir, TURN_NOTES_FILE), "utf8");
  const toolsRaw = readFileSync(join(dir, DEV_NOTES_FILE), "utf8");
  for (const s of sentinels) {
    assert.ok(!turnsRaw.includes(s), `turns.json must not contain ${JSON.stringify(s)}`);
    assert.ok(!toolsRaw.includes(s), `tools.json must not contain ${JSON.stringify(s)}`);
  }
  // Only known fields per note.
  const allowed = new Set([
    "kind", "reason", "service", "tool", "tier", "routeSource", "routeRule", "tools", "trigger", "errorClass", "ruleId",
    "message", "count", "firstSeen", "lastSeen", "lastTurnId", "status", "statusAt",
  ]);
  const f = JSON.parse(turnsRaw) as TurnNotesFile;
  for (const note of f.notes) {
    for (const k of Object.keys(note)) assert.ok(allowed.has(k), `unexpected field ${k}`);
  }
  assert.equal(f.notes[0]?.tool, INVALID_NAME);
  assert.equal(f.notes[0]?.service, INVALID_NAME);
  assert.equal(f.notes[0]?.lastTurnId, undefined);
  assert.deepEqual(f.notes.find((x) => x.kind === "wandering")?.tools, [INVALID_NAME, "mcp__ha__HassTurnOn"]);
});
