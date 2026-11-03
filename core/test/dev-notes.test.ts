/** dev-notes store tests (T7.y): one note per kind + tool, counters instead of repeats. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DEV_NOTES_FILE, DevNotes, type CatalogEntry } from "../src/dev-notes.js";

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
