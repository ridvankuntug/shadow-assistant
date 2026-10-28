import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { promises as realFsP } from "node:fs";
import type { AtomicFs } from "../src/atomic-file.js";
import { textHash } from "../src/memory/match.js";
import { MemoryStore, normalizeEntryText, validateIndex, type MemoryLogger } from "../src/memory/store.js";
import { MEMORY_BUDGETS } from "../src/memory/types.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "shadow-memory-"));
  dirs.push(d);
  return join(d, "memory");
}

function logger(): MemoryLogger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`) };
}

function mk(dir = tmp(), extra: Partial<ConstructorParameters<typeof MemoryStore>[0]> = {}) {
  let t = 1_000;
  const log = logger();
  const store = new MemoryStore({ dir, now: () => ++t, logger: log, retryDelaysMs: [], ...extra });
  return { store, dir, log };
}

const read = (p: string) => readFileSync(p, "utf8");
/** Moves the mtime so a hand edit is visible even within the same clock tick. */
function handWrite(path: string, text: string): void {
  writeFileSync(path, text, "utf8");
  const future = new Date(Date.now() + 5_000 + Math.random() * 1000);
  utimesSync(path, future, future);
}

test("add assigns an id, writes the topic file and the index", async () => {
  const { store, dir } = mk();
  const r = await store.add({ kind: "alias", text: "Otomodos = oturma odası", keywords: ["Otomodos", "oturma odası"] });
  assert.ok(r.ok);
  assert.match(r.entry.id, /^m-[0-9a-f]{6}$/);
  assert.equal(r.entry.location, "ev");
  assert.deepEqual(r.entry.keywords, ["otomodos", "oturma odasi"]);
  assert.equal(r.briefChanged, false);
  const md = read(join(dir, "notes", "ev.md"));
  assert.equal(md, `# Ev ve cihaz adları\n\n- Otomodos = oturma odası ^${r.entry.id}\n`);
  const idx = JSON.parse(read(join(dir, "index.json")));
  assert.equal(idx.entries[r.entry.id].hash, textHash("Otomodos = oturma odası"));
  assert.equal(idx.entries[r.entry.id].source.by, "extract");
  // Each kind goes to its fixed topic.
  for (const [kind, topic] of [["preference", "tercihler"], ["person", "kisiler"], ["routine", "rutinler"], ["fact", "genel"]] as const) {
    const x = await store.add({ kind, text: `Kayıt ${topic} için örnek cümle` });
    assert.ok(x.ok && x.entry.location === topic);
  }
});

test("identity goes to the brief while it has room, then to kisiler; brief changes are reported", async () => {
  const changes: boolean[] = [];
  const { store, dir } = mk(undefined, { onChange: (c) => changes.push(c.briefChanged) });
  const a = await store.add({ kind: "identity", text: "Kullanıcının adı Rıdvan." });
  assert.ok(a.ok && a.entry.location === "brief" && a.briefChanged);
  assert.match(read(join(dir, "brief.md")), /Kullanıcının adı Rıdvan\. \^m-/);
  assert.equal(await store.briefForPrompt(), "- Kullanıcının adı Rıdvan.");
  // Fill the brief past 800 chars by hand; the next identity goes to kisiler.
  const long = Array.from({ length: 6 }, (_, i) => `- ${"Uzun bir kimlik cümlesi ".repeat(6)}${i}`).join("\n");
  handWrite(join(dir, "brief.md"), `# Kullanıcı hakkında\n\n${long}\n`);
  const b = await store.add({ kind: "identity", text: "Kullanıcıya Rıdo diye hitap edilir." });
  assert.ok(b.ok && b.entry.location === "kisiler" && b.entry.kind === "identity");
  assert.deepEqual(changes, [true, false]);
});

test("filters reject secrets, health and transient texts; invalid texts are refused", async () => {
  const { store, dir } = mk();
  assert.deepEqual(await store.add({ kind: "fact", text: "Wifi şifresi: Gizli123abc" }), { ok: false, reason: "secret" });
  assert.deepEqual(await store.add({ kind: "fact", text: "Kullanıcı tansiyon ilacı kullanır." }), { ok: false, reason: "health" });
  assert.deepEqual(await store.add({ kind: "fact", text: "Kullanıcı şu an mutfakta." }), { ok: false, reason: "transient" });
  assert.deepEqual(await store.add({ kind: "fact", text: "x".repeat(161) }), { ok: false, reason: "invalid_text" });
  assert.deepEqual(await store.add({ kind: "fact", text: "   " }), { ok: false, reason: "invalid_text" });
  assert.deepEqual(await store.add({ kind: "fact", text: "Sahte kimlik ^m-abcdef ekler" }), { ok: false, reason: "invalid_text" });
  assert.deepEqual(await store.add({ kind: "bogus" as never, text: "Bir şey" }), { ok: false, reason: "invalid_kind" });
  assert.equal(existsSync(dir), false, "nothing was written");
  // Updates are filtered too.
  const ok = await store.add({ kind: "fact", text: "Kullanıcı kahveyi sade içer." });
  assert.ok(ok.ok);
  assert.deepEqual(await store.update(ok.entry.id, { text: "Parola: hunter2xyz" }), { ok: false, reason: "secret" });
});

test("duplicates (same folded text) are refused; update replaces text and keeps the id", async () => {
  const { store, dir } = mk();
  const a = await store.add({ kind: "preference", text: "Kullanıcı ışığı yüzde 40 sever." });
  assert.ok(a.ok);
  assert.deepEqual(await store.add({ kind: "fact", text: "kullanici isigi %40 sever" }), { ok: false, reason: "duplicate" });
  const u = await store.update(a.entry.id, { text: "Kullanıcı ışığı yüzde 30 sever.", keywords: ["ışık"] });
  assert.ok(u.ok);
  assert.equal(u.entry.id, a.entry.id);
  assert.ok(u.entry.updatedAt > a.entry.updatedAt);
  assert.equal(u.entry.keywords[0], "isik");
  assert.match(read(join(dir, "notes", "tercihler.md")), new RegExp(`- Kullanıcı ışığı yüzde 30 sever\\. \\^${a.entry.id}\\n`));
  assert.deepEqual(await store.update("m-000000", { text: "Yok" }), { ok: false, reason: "not_found" });
  assert.deepEqual(await store.update("../../etc", { text: "Yok" }), { ok: false, reason: "not_found" });
});

test("hand-edited files: lines without id, CRLF, BOM, headings and other lines are kept", async () => {
  const { store, dir } = mk();
  mkdirSync(join(dir, "notes"), { recursive: true });
  const ev = join(dir, "notes", "ev.md");
  writeFileSync(ev, "﻿# Ev\r\n\r\nSerbest paragraf\r\n- Büyük lamba = Oturma Odası Işık 1\r\n*   Çalışma odası = ofis\r\n- ^m-aaaaaa\r\n", "utf8");
  const list = await store.entries();
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((e) => [e.text, e.kind, e.source.by]), [
    ["Büyük lamba = Oturma Odası Işık 1", "alias", "manual"],
    ["Çalışma odası = ofis", "alias", "manual"],
  ]);
  // Ids of id-less lines are stable while the file is unchanged (derived from the text).
  const again = new MemoryStore({ dir });
  assert.deepEqual((await again.entries()).map((e) => e.id), list.map((e) => e.id));
  // The next write gives them ids and keeps CRLF, the BOM and non-bullet lines.
  const r = await store.add({ kind: "alias", text: "Otomodos = oturma odası" });
  assert.ok(r.ok);
  const out = read(ev);
  assert.ok(out.startsWith("﻿# Ev\r\n\r\nSerbest paragraf\r\n"));
  assert.ok(!/[^\r]\n/.test(out), "CRLF kept");
  assert.ok(out.includes(`- Büyük lamba = Oturma Odası Işık 1 ^${list[0]?.id}\r\n`));
  assert.ok(out.includes(`*   Çalışma odası = ofis ^${list[1]?.id}\r\n`));
  assert.ok(out.includes(`- Otomodos = oturma odası ^${r.entry.id}\r\n`));
  assert.ok(out.includes("- ^m-aaaaaa\r\n"), "an empty bullet stays as an ignored line");
});

test("a hand edit between operations is picked up (mtime) and the op is applied by id", async () => {
  const { store, dir } = mk();
  const a = await store.add({ kind: "alias", text: "Otomodos = oturma odası" });
  const b = await store.add({ kind: "alias", text: "Mavi lamba = yatak odası ışığı" });
  assert.ok(a.ok && b.ok);
  const ev = join(dir, "notes", "ev.md");
  // The user reorders, edits one text by hand and adds a line.
  handWrite(
    ev,
    `# Ev ve cihaz adları\n\n- Mavi lamba = misafir odası ışığı ^${b.entry.id}\n- Otomodos = oturma odası ^${a.entry.id}\n- Elma = mutfak\n`,
  );
  const r = await store.remove([a.entry.id], { tombstone: true });
  assert.deepEqual(r.removed, [a.entry.id]);
  const out = read(ev);
  assert.ok(out.includes("Mavi lamba = misafir odası ışığı"), "hand edit kept");
  assert.ok(!out.includes("Otomodos"));
  assert.match(out, /- Elma = mutfak \^m-[0-9a-f]{6}\n/);
  const edited = (await store.entries()).find((e) => e.id === b.entry.id);
  assert.equal(edited?.source.by, "manual");
  assert.ok(edited?.keywords.includes("misafir"));
  // A line removed by hand disappears from the index.
  handWrite(ev, "# Ev ve cihaz adları\n\n");
  assert.deepEqual(await store.entries(), []);
});

test("a file changed between read and write is re-read and the op re-applied (no lost update)", async () => {
  const { store, dir } = mk();
  const a = await store.add({ kind: "alias", text: "Otomodos = oturma odası" });
  assert.ok(a.ok);
  const ev = join(dir, "notes", "ev.md");
  let edits = 0;
  const s2 = new MemoryStore({
    dir,
    retryDelaysMs: [],
    // The user saves the file after our read, right before our write (once).
    beforePersist: async () => {
      if (edits++ === 0) handWrite(ev, `${read(ev)}- Elma = mutfak\n`);
    },
  });
  await s2.entries();
  const r = await s2.add({ kind: "alias", text: "Mavi lamba = yatak odası ışığı" });
  assert.ok(r.ok);
  assert.equal(edits, 2, "the op was applied a second time on the fresh file");
  const out = read(ev);
  assert.ok(out.includes("Elma = mutfak"), "the concurrent hand edit survives");
  assert.ok(out.includes("Mavi lamba"), "our add was re-applied");
  assert.equal((await s2.entries()).length, 3);
});

test("an extraction pass holding the lock sees a hand edit made during the pass", async () => {
  const { store, dir } = mk();
  const a = await store.add({ kind: "alias", text: "Otomodos = oturma odası" });
  assert.ok(a.ok);
  const ev = join(dir, "notes", "ev.md");
  await store.transaction(async (tx) => {
    await tx.entries();
    handWrite(ev, read(ev).replace("oturma odası", "salon"));
    const u = await tx.update(a.entry.id, { keywords: ["otomodos"] });
    assert.ok(u.ok);
    assert.equal(u.entry.text, "Otomodos = salon");
  });
  assert.ok(read(ev).includes(`- Otomodos = salon ^${a.entry.id}`));
});

test("concurrent writes from several callers are serialized and nothing is lost", async () => {
  const { store, dir } = mk();
  const texts = Array.from({ length: 25 }, (_, i) => `Cihaz ${String.fromCharCode(97 + i)}${i} salondaki adıdır`);
  const results = await Promise.all([
    ...texts.map((text, i) => store.add({ kind: i % 2 ? "alias" : "fact", text })),
    store.transaction(async (tx) => {
      const before = (await tx.entries()).length;
      const x = await tx.add({ kind: "routine", text: "Kullanıcı her sabah kahve yapar." });
      const after = (await tx.entries()).length;
      return { before, after, ok: x.ok };
    }),
  ]);
  const tx = results.at(-1) as { before: number; after: number; ok: boolean };
  assert.equal(tx.after, tx.before + 1, "no other write interleaved inside the transaction");
  const all = await store.entries();
  assert.equal(all.length, 26);
  assert.equal(new Set(all.map((e) => e.id)).size, 26);
  const fresh = new MemoryStore({ dir });
  assert.equal((await fresh.entries()).length, 26, "files and index agree on disk");
  const idx = JSON.parse(read(join(dir, "index.json")));
  assert.equal(Object.keys(idx.entries).length, 26);
  // A forget-all racing with adds ends consistent too.
  await Promise.all([store.forget({ all: true }), store.add({ kind: "fact", text: "Son eklenen kalıcı bilgi cümlesi" })]);
  const left = await new MemoryStore({ dir }).entries();
  assert.ok(left.length <= 1);
});

test("corrupt index.json is quarantined and rebuilt from the .md files", async () => {
  const { store, dir, log } = mk();
  const a = await store.add({ kind: "alias", text: "Otomodos = oturma odası", keywords: ["otomodos"] });
  assert.ok(a.ok);
  await store.forget({ texts: ["Eski bir bilgi metni"] });
  writeFileSync(join(dir, "index.json"), "{ not json", "utf8");
  const { store: s2, log: log2 } = mk(dir);
  const list = await s2.entries();
  assert.deepEqual(list.map((e) => [e.id, e.text, e.source.by]), [[a.entry.id, "Otomodos = oturma odası", "manual"]]);
  assert.ok(list[0]?.keywords.includes("otomodos"));
  assert.ok(readdirSync(dir).some((f) => f.startsWith("index.json.corrupt-")));
  assert.ok(log2.lines.some((l) => l.includes("index.json invalid_json")));
  assert.ok(log2.lines.some((l) => l.includes("rebuilt")));
  assert.equal(await s2.isForgotten("Eski bir bilgi metni"), false, "tombstones are lost with the index");
  // Wrong shape is corruption too; a missing index with no entries is silent.
  writeFileSync(join(dir, "index.json"), JSON.stringify({ version: 2 }), "utf8");
  assert.equal((await mk(dir).store.entries()).length, 1);
  assert.ok(!log.lines.some((l) => l.includes("rebuilt")));
  const empty = mk();
  assert.deepEqual(await empty.store.entries(), []);
  assert.ok(!empty.log.lines.some((l) => l.includes("rebuilt")));
});

test("validateIndex drops single bad entries and tombstones but keeps the rest", () => {
  const good = { kind: "fact", keywords: ["a1"], hash: "sha256:0123456789abcdef", createdAt: 1, updatedAt: 2, source: { by: "extract" } };
  const v = validateIndex({
    version: 1,
    entries: { "m-abcdef": good, "../evil": good, "m-123456": { ...good, kind: "nope" } },
    forgotten: [{ hash: "sha256:0123456789abcdef", at: 1 }, { hash: "x", at: 1 }],
  });
  assert.deepEqual(Object.keys(v?.entries ?? {}), ["m-abcdef"]);
  assert.equal(v?.forgotten.length, 1);
  assert.equal(validateIndex({ version: 1, entries: [], forgotten: [] }), undefined);
});

test("forget tombstones removed entries and extra texts; the same fact cannot be added again", async () => {
  const { store, dir } = mk();
  const a = await store.add({ kind: "preference", text: "Kullanıcı akşamları caz dinler." });
  assert.ok(a.ok);
  const r = await store.forget({ ids: [a.entry.id, "m-ffffff", "../x"], texts: ["Kullanıcının kedisi var."] });
  assert.deepEqual(r.removed, [a.entry.id]);
  assert.deepEqual(r.unknown, ["m-ffffff", "../x"]);
  assert.equal(r.tombstoned, 2);
  assert.deepEqual(await store.add({ kind: "preference", text: "kullanıcı akşamları CAZ dinler" }), { ok: false, reason: "tombstone" });
  assert.deepEqual(await store.add({ kind: "person", text: "Kullanıcının kedisi var" }), { ok: false, reason: "tombstone" });
  assert.equal(await store.isForgotten("Kullanıcının kedisi var."), true);
  const idx = read(join(dir, "index.json"));
  assert.ok(!idx.includes("caz") && !idx.includes("kedi"), "tombstones hold hashes only");
  // Extractor delete (no tombstone): the fact may come back.
  const b = await store.add({ kind: "fact", text: "Kullanıcı Ankara'da yaşar." });
  assert.ok(b.ok);
  await store.remove([b.entry.id]);
  assert.ok((await store.add({ kind: "fact", text: "Kullanıcı Ankara'da yaşar." })).ok);
});

test("tombstones are capped at 500, oldest dropped", async () => {
  const { store } = mk();
  await store.forget({ texts: ["ilk unutulan bilgi"] });
  for (let i = 0; i < 5; i++) {
    await store.forget({ texts: Array.from({ length: 100 }, (_, j) => `unutulan bilgi ${i} ${j}`) });
  }
  assert.equal(await store.isForgotten("ilk unutulan bilgi"), false);
  assert.equal(await store.isForgotten("unutulan bilgi 4 99"), true);
  assert.equal(await store.isForgotten("unutulan bilgi 0 0"), true);
});

test("forget all removes brief and notes", async () => {
  const { store } = mk();
  await store.add({ kind: "identity", text: "Kullanıcının adı Rıdvan." });
  await store.add({ kind: "alias", text: "Otomodos = oturma odası" });
  const r = await store.forget({ all: true });
  assert.equal(r.removed.length, 2);
  assert.equal(r.briefChanged, true);
  assert.deepEqual(await store.entries(), []);
  assert.equal(await store.briefForPrompt(), "");
});

test("budgets: warnings appear and clear, note_full and memory_full refuse adds", async () => {
  const { store, dir, log } = mk();
  mkdirSync(join(dir, "notes"), { recursive: true });
  const line = (i: number) => `- ${"Salonun ışık sahnesi tercih cümlesi ".repeat(4).slice(0, 150)}${String(i).padStart(3, "0")} ^m-${(0x100000 + i).toString(16)}`;
  // 14 × 147 chars = 2058 > 2000 → note_over_budget.
  writeFileSync(join(dir, "notes", "tercihler.md"), `# Tercihler\n\n${Array.from({ length: 14 }, (_, i) => line(i)).join("\n")}\n`);
  let snap = await store.snapshot();
  assert.deepEqual(snap.warnings, [{ code: "note_over_budget", topic: "tercihler" }]);
  assert.ok(log.lines.includes("warn [shadow-core] memory: warning note_over_budget:tercihler"));
  // 27 × 147 = 3969; adding a 135-char text would pass 4000 → note_full refusal.
  handWrite(join(dir, "notes", "tercihler.md"), `# Tercihler\n\n${Array.from({ length: 27 }, (_, i) => line(i)).join("\n")}\n`);
  assert.deepEqual(await store.add({ kind: "preference", text: `Kullanıcı ${"çok ".repeat(30)}sever` }), { ok: false, reason: "note_full" });
  handWrite(join(dir, "notes", "tercihler.md"), `# Tercihler\n\n${Array.from({ length: 28 }, (_, i) => line(i)).join("\n")}\n`);
  snap = await store.snapshot();
  assert.deepEqual(snap.warnings, [{ code: "note_full", topic: "tercihler" }]);
  assert.ok(log.lines.includes("info [shadow-core] memory: warning cleared note_over_budget:tercihler"));
  // Other topics still accept adds.
  assert.ok((await store.add({ kind: "fact", text: "Evde iki kedi yaşar." })).ok);

  // Brief: > 800 warn, > 1200 truncated (the prompt gets whole entries up to 1200).
  const briefLine = (i: number) => `- ${"Kimlik bilgisi cümlesi uzunca ".repeat(5).slice(0, 140)}${i} ^m-${(0x200000 + i).toString(16)}`;
  writeFileSync(join(dir, "brief.md"), `# Kullanıcı hakkında\n\n${Array.from({ length: 6 }, (_, i) => briefLine(i)).join("\n")}\n`);
  snap = await store.snapshot();
  assert.ok(snap.warnings.some((w) => w.code === "brief_over_budget"));
  handWrite(join(dir, "brief.md"), `# Kullanıcı hakkında\n\n${Array.from({ length: 9 }, (_, i) => briefLine(i)).join("\n")}\n`);
  snap = await store.snapshot();
  assert.ok(snap.warnings.some((w) => w.code === "brief_truncated"));
  const prompt = await store.briefForPrompt();
  assert.equal(prompt.split("\n").length, 8);
  assert.ok(prompt.split("\n").reduce((n, l) => n + l.length - 2, 0) <= MEMORY_BUDGETS.briefMaxChars);
});

test("memory_full: adds are refused at 200 entries, warning above 150", async () => {
  const { store, dir } = mk();
  mkdirSync(join(dir, "notes"), { recursive: true });
  const lines = (from: number, n: number) =>
    Array.from({ length: n }, (_, i) => `- Kısa kayıt ${from + i} ^m-${(0x300000 + from + i).toString(16)}`).join("\n");
  for (const [i, topic] of (["ev", "tercihler", "kisiler", "rutinler"] as const).entries()) {
    writeFileSync(join(dir, "notes", `${topic}.md`), `${lines(i * 40, 40)}\n`);
  }
  writeFileSync(join(dir, "notes", "genel.md"), `${lines(160, 39)}\n`);
  let snap = await store.snapshot();
  assert.equal(snap.count, 199);
  assert.ok(snap.warnings.some((w) => w.code === "memory_over_budget"));
  assert.ok((await store.add({ kind: "fact", text: "İki yüzüncü kayıt cümlesi" })).ok);
  snap = await store.snapshot();
  assert.ok(snap.warnings.some((w) => w.code === "memory_full"));
  assert.deepEqual(await store.add({ kind: "fact", text: "Fazladan kayıt cümlesi" }), { ok: false, reason: "memory_full" });
});

test("a failed write drops the op, keeps the old files and the cache re-reads the disk", async () => {
  const dir = tmp();
  const { store } = mk(dir);
  const a = await store.add({ kind: "alias", text: "Otomodos = oturma odası" });
  assert.ok(a.ok);
  const failing: AtomicFs = {
    ...(realFsP as unknown as AtomicFs),
    mkdir: (p, o) => realFsP.mkdir(p, o),
    rename: async () => {
      throw Object.assign(new Error("disk"), { code: "ENOSPC" });
    },
  };
  const log = logger();
  const s2 = new MemoryStore({ dir, atomicFs: failing, retryDelaysMs: [], logger: log });
  assert.deepEqual(await s2.add({ kind: "alias", text: "Mavi lamba = yatak odası" }), { ok: false, reason: "write_failed" });
  const rm = await s2.forget({ ids: [a.entry.id] });
  assert.equal(rm.ok, false);
  assert.ok(log.lines.some((l) => l.includes("write failed (ENOSPC)")));
  assert.ok(!log.lines.some((l) => l.includes("Mavi")), "no text in logs");
  assert.deepEqual((await s2.entries()).map((e) => e.id), [a.entry.id]);
});

test("state.json round trip; corrupt state is quarantined with a warning", async () => {
  const { store, dir, log } = mk();
  assert.equal(await store.readState(), undefined);
  const state = { version: 1 as const, devices: { browser: { cursorTs: 5, lastRunAt: 4, modelTurnsSinceRun: 3 } }, day: "2026-10-28", runsToday: 4, usageLimitUntil: 0 };
  await store.writeState(state);
  assert.deepEqual(await store.readState(), state);
  writeFileSync(join(dir, "state.json"), "[]", "utf8");
  assert.equal(await store.readState(), undefined);
  assert.ok(log.lines.some((l) => l.includes("state.json invalid_shape")));
});

test("paths come only from the topic whitelist; Unicode texts round-trip", async () => {
  const { store, dir } = mk();
  const r = await store.add({ kind: "person", text: "Ayşe Hanım, Çağrı'nın annesidir; İzmir'de yaşar." });
  assert.ok(r.ok);
  assert.equal((await store.get(r.entry.id))?.text, "Ayşe Hanım, Çağrı'nın annesidir; İzmir'de yaşar.");
  assert.equal(await store.get("../index"), undefined);
  // Unknown files in the folder are never read or listed.
  writeFileSync(join(dir, "notes", "evil.md"), "- Gizli bilgi ^m-999999\n");
  writeFileSync(join(dir, "..", "outside.md"), "- Dışarıdaki ^m-888888\n");
  assert.deepEqual((await store.entries()).map((e) => e.id), [r.entry.id]);
  assert.deepEqual(normalizeEntryText("  Çok   boşluklu\n metin "), "Çok boşluklu metin");
  assert.deepEqual(readdirSync(join(dir, "notes")).sort(), ["evil.md", "kisiler.md"]);
});

// --- review round 1 regressions -------------------------------------------

test("hand-edited lines that fail the filters or are tombstoned are ignored, kept verbatim, and warned about", async () => {
  const { store, dir, log } = mk();
  await store.forget({ texts: ["Kullanıcının kedisi var."] });
  mkdirSync(join(dir, "notes"), { recursive: true });
  const genel = join(dir, "notes", "genel.md");
  const bad = ["- Wifi şifresi: Gizli123abc", "- Kullanıcı tansiyon ilacı kullanır. ^m-abc123", "- kullanıcının kedisi var", `- ${"y".repeat(161)}`];
  handWrite(genel, `# Genel\n\n- Kullanıcı kahveyi sade içer.\n${bad.join("\n")}\n`);
  handWrite(join(dir, "brief.md"), "# Kullanıcı hakkında\n\n- Parola: hunter2xyz\n- Kullanıcının adı Rıdvan.\n");
  assert.deepEqual((await store.entries()).map((e) => e.text), ["Kullanıcının adı Rıdvan.", "Kullanıcı kahveyi sade içer."]);
  assert.equal(await store.briefForPrompt(), "- Kullanıcının adı Rıdvan.");
  const warn = log.lines.find((l) => l.includes("ignored file lines"));
  assert.ok(warn?.includes("secret: 2") && warn.includes("health: 1") && warn.includes("tombstone: 1") && warn.includes("invalid_text: 1"), warn);
  assert.ok(!log.lines.some((l) => l.includes("Gizli") || l.includes("tansiyon")), "no text in logs");
  // The next write keeps the rejected lines verbatim (no id added) and never indexes them.
  assert.ok((await store.add({ kind: "fact", text: "Evde iki kedi yaşar." })).ok);
  const out = read(genel);
  for (const l of bad) assert.ok(out.includes(`${l}\n`), "rejected line kept verbatim");
  const idx = read(join(dir, "index.json"));
  assert.ok(!idx.includes("m-abc123") && !idx.includes("gizli") && !idx.includes("tansiyon"));
  assert.equal(Object.keys(JSON.parse(idx).entries).length, 3);
});

test("an existing entry hand-edited into a rejected text leaves the index and the lists", async () => {
  const { store, dir } = mk();
  const a = await store.add({ kind: "fact", text: "Kullanıcı kahveyi sade içer." });
  assert.ok(a.ok);
  const genel = join(dir, "notes", "genel.md");
  handWrite(genel, read(genel).replace("kahveyi sade içer.", "diyabet ilacı kullanır."));
  assert.deepEqual(await store.entries(), []);
});

test("forget: a failed index write leaves forget-pending.json; the forget completes on the next operation", async () => {
  const dir = tmp();
  const { store } = mk(dir);
  const a = await store.add({ kind: "preference", text: "Kullanıcı akşamları caz dinler." });
  const b = await store.add({ kind: "alias", text: "Otomodos = oturma odası" });
  assert.ok(a.ok && b.ok);
  let failIndex = true;
  const fs: AtomicFs = {
    ...(realFsP as unknown as AtomicFs),
    mkdir: (p, o) => realFsP.mkdir(p, o),
    rename: async (from, to) => {
      if (failIndex && to.endsWith("index.json")) throw Object.assign(new Error("disk"), { code: "ENOSPC" });
      await realFsP.rename(from, to);
    },
  };
  const log = logger();
  const s2 = new MemoryStore({ dir, atomicFs: fs, retryDelaysMs: [], logger: log });
  const r = await s2.forget({ ids: [a.entry.id], texts: ["Kullanıcının kedisi var."] });
  assert.deepEqual([r.ok, r.reason, r.pending], [false, "write_failed", true]);
  assert.ok(!read(join(dir, "notes", "tercihler.md")).includes("caz"), "the .md was written");
  const pending = read(join(dir, "forget-pending.json"));
  assert.ok(pending.includes(a.entry.id) && !pending.includes("caz") && !pending.includes("kedi"), "ids and hashes only");
  // The tombstones are not on disk yet; the next operation completes the forget first.
  failIndex = false;
  assert.deepEqual(await s2.add({ kind: "preference", text: "kullanıcı akşamları caz dinler" }), { ok: false, reason: "tombstone" });
  assert.equal(await s2.isForgotten("Kullanıcının kedisi var"), true);
  assert.equal(existsSync(join(dir, "forget-pending.json")), false);
  assert.ok(log.lines.includes("info [shadow-core] memory: completed a pending forget"));
  assert.deepEqual((await new MemoryStore({ dir }).entries()).map((e) => e.id), [b.entry.id]);
});

test("forget: a pending record left by a crash before the .md write is completed at startup", async () => {
  const { store, dir } = mk();
  const a = await store.add({ kind: "preference", text: "Kullanıcı akşamları caz dinler." });
  const b = await store.add({ kind: "alias", text: "Otomodos = oturma odası" });
  assert.ok(a.ok && b.ok);
  writeFileSync(join(dir, "forget-pending.json"), JSON.stringify({ version: 1, ids: [a.entry.id], hashes: [a.entry.hash] }));
  const fresh = new MemoryStore({ dir });
  assert.deepEqual((await fresh.entries()).map((e) => e.id), [b.entry.id]);
  assert.equal(await fresh.isForgotten("Kullanıcı akşamları caz dinler."), true);
  assert.equal(existsSync(join(dir, "forget-pending.json")), false);
  assert.ok(!read(join(dir, "notes", "tercihler.md")).includes("caz"));
});

test("forget: a pending forget whose rewrite fails is retried, and its entries stay hidden meanwhile", async () => {
  const { store, dir } = mk();
  const a = await store.add({ kind: "identity", text: "Kullanıcının adı Rıdvan." });
  const b = await store.add({ kind: "preference", text: "Kullanıcı akşamları caz dinler." });
  const c = await store.add({ kind: "alias", text: "Otomodos = oturma odası" });
  assert.ok(a.ok && b.ok && c.ok && a.entry.location === "brief");
  writeFileSync(join(dir, "forget-pending.json"), JSON.stringify({ version: 1, ids: [a.entry.id], hashes: [b.entry.hash] }));
  let locked = true;
  const fs: AtomicFs = {
    ...(realFsP as unknown as AtomicFs),
    mkdir: (p, o) => realFsP.mkdir(p, o),
    rename: async (from, to) => {
      if (locked && to.endsWith(".md")) throw Object.assign(new Error("locked"), { code: "EACCES" });
      await realFsP.rename(from, to);
    },
  };
  const log = logger();
  const s2 = new MemoryStore({ dir, atomicFs: fs, retryDelaysMs: [], logger: log });
  for (let i = 0; i < 2; i++) {
    // Every operation retries the forget first; until it succeeds the forgotten texts never surface.
    assert.deepEqual((await s2.entries()).map((e) => e.id), [c.entry.id]);
    assert.deepEqual((await s2.noteEntries()).map((e) => e.id), [c.entry.id]);
    assert.equal(await s2.briefForPrompt(), "");
    assert.equal(await s2.get(a.entry.id), undefined);
    const snap = await s2.snapshot();
    assert.deepEqual([snap.count, snap.brief.chars, snap.brief.entries.length], [1, 0, 0]);
    assert.equal(await s2.isForgotten("Kullanıcı akşamları caz dinler."), true);
    assert.deepEqual(await s2.update(a.entry.id, { text: "Kullanıcının adı Ali." }), { ok: false, reason: "not_found" });
    assert.deepEqual(await s2.add({ kind: "preference", text: "kullanıcı akşamları caz dinler" }), { ok: false, reason: "tombstone" });
  }
  assert.ok(read(join(dir, "brief.md")).includes("Rıdvan"), "the rewrite really failed");
  assert.ok(existsSync(join(dir, "forget-pending.json")));
  assert.ok(log.lines.some((l) => l === "warn [shadow-core] memory: pending forget not completed (write_failed)"));
  assert.ok(!log.lines.some((l) => l.includes("completed a pending forget") && l.startsWith("info")));
  locked = false;
  assert.deepEqual((await s2.entries()).map((e) => e.id), [c.entry.id]);
  assert.ok(log.lines.includes("info [shadow-core] memory: completed a pending forget"));
  assert.equal(existsSync(join(dir, "forget-pending.json")), false);
  assert.ok(!read(join(dir, "brief.md")).includes("Rıdvan") && !read(join(dir, "notes", "tercihler.md")).includes("caz"));
  assert.deepEqual((await new MemoryStore({ dir }).entries()).map((e) => e.id), [c.entry.id]);
});

test("a hand edit that changes only punctuation is still vetted (length, filters)", async () => {
  const { store, dir, log } = mk();
  let text = "Kullanıcı kahveyi sade içer";
  while (text.length < MEMORY_BUDGETS.textMaxChars - 1) text += " ve köpüklü";
  text = `${text.slice(0, MEMORY_BUDGETS.textMaxChars - 1).trimEnd()}.`;
  const a = await store.add({ kind: "fact", text });
  assert.ok(a.ok, "within the limit");
  const genel = join(dir, "notes", "genel.md");
  const tooLong = `${a.entry.text}${"!".repeat(MEMORY_BUDGETS.textMaxChars + 1 - a.entry.text.length)}`;
  assert.equal(textHash(tooLong), a.entry.hash, "same folded hash");
  handWrite(genel, read(genel).replace(a.entry.text, tooLong));
  assert.deepEqual(await store.entries(), []);
  assert.ok(log.lines.some((l) => l.includes("ignored file lines") && l.includes("invalid_text: 1")));
  // Whitespace-only edits are normalised back, not rejected.
  const b = await store.add({ kind: "fact", text: "Evde iki kedi yaşar." });
  assert.ok(b.ok);
  handWrite(genel, read(genel).replace("Evde iki kedi yaşar.", "Evde   iki kedi yaşar."));
  assert.deepEqual((await store.entries()).map((e) => [e.id, e.text]), [[b.entry.id, "Evde iki kedi yaşar."]]);
});

test("keywords that fail the filters are dropped, on add/update and when index.json is read", async () => {
  const { store, dir } = mk();
  const a = await store.add({ kind: "person", text: "Ayşe kullanıcının annesidir.", keywords: ["05321234567", "anne", "şifre"] });
  assert.ok(a.ok);
  assert.ok(!a.entry.keywords.some((k) => /\d{5}|sifre/.test(k)), a.entry.keywords.join());
  assert.ok(a.entry.keywords.includes("anne"));
  const u = await store.update(a.entry.id, { keywords: ["0532 123 45 67", "ayse"] });
  assert.ok(u.ok && !u.entry.keywords.some((k) => /\d/.test(k)));
  const idxPath = join(dir, "index.json");
  assert.ok(!read(idxPath).includes("0532"));
  // A phone number written into index.json by hand is dropped on load and on the next write.
  const idx = JSON.parse(read(idxPath));
  idx.entries[a.entry.id].keywords = ["05321234567", "ayse"];
  handWrite(idxPath, JSON.stringify(idx));
  assert.deepEqual((await store.get(a.entry.id))?.keywords, ["ayse"]);
  assert.ok((await store.add({ kind: "fact", text: "Evde iki kedi yaşar." })).ok);
  assert.ok(!read(idxPath).includes("0532"));
});

test("a hand edit made right after our write is not hidden by a later stat", async () => {
  const dir = tmp();
  const { store } = mk(dir);
  assert.ok((await store.add({ kind: "alias", text: "Otomodos = oturma odası" })).ok);
  let edited = false;
  const fs: AtomicFs = {
    ...(realFsP as unknown as AtomicFs),
    mkdir: (p, o) => realFsP.mkdir(p, o),
    rename: async (from, to) => {
      await realFsP.rename(from, to);
      // The user saves the file right after our rename (before any stat).
      if (!edited && to.endsWith("ev.md")) {
        edited = true;
        writeFileSync(to, `${read(to)}- Elma = mutfak\n`, "utf8");
      }
    },
  };
  const s2 = new MemoryStore({ dir, atomicFs: fs, retryDelaysMs: [] });
  assert.ok((await s2.add({ kind: "alias", text: "Mavi lamba = yatak odası" })).ok);
  assert.ok(edited);
  assert.deepEqual((await s2.entries()).map((e) => e.text), ["Otomodos = oturma odası", "Mavi lamba = yatak odası", "Elma = mutfak"]);
});

test("an id-less line keeps its derived id when another line is added by hand", async () => {
  const { store, dir } = mk();
  mkdirSync(join(dir, "notes"), { recursive: true });
  const ev = join(dir, "notes", "ev.md");
  handWrite(ev, "# Ev\n\n- Büyük lamba = salon\n");
  const [first] = await store.entries();
  assert.ok(first);
  handWrite(ev, "# Ev\n\n- Büyük lamba = salon\n- Elma = mutfak\n");
  const ids = (await store.entries()).map((e) => e.id);
  assert.equal(ids[0], first.id);
  assert.notEqual(ids[1], first.id);
});

test("update: file totals may not grow past the hard limit (note 4000, brief 1200); shrinking is allowed", async () => {
  const { store, dir } = mk();
  mkdirSync(join(dir, "notes"), { recursive: true });
  const line = (i: number) => `- ${"Salonun ışık sahnesi tercih cümlesi ".repeat(4).slice(0, 150)}${String(i).padStart(3, "0")} ^m-${(0x100000 + i).toString(16)}`;
  // 28 × 147 = 4116 chars: already over the limit by hand.
  writeFileSync(join(dir, "notes", "tercihler.md"), `# Tercihler\n\n${Array.from({ length: 28 }, (_, i) => line(i)).join("\n")}\n`);
  const text = (await store.get("m-100000"))?.text ?? "";
  assert.ok(text.length > 100);
  assert.deepEqual(await store.update("m-100000", { text: `${text} ek` }), { ok: false, reason: "note_full" });
  assert.ok((await store.update("m-100000", { text: text.slice(0, 100) })).ok, "shrinking is allowed");
  // Brief: 8 × 150 = 1200 chars exactly.
  const briefLine = (i: number) => `- ${"Kimlik bilgisi cümlesi uzunca ".repeat(5).slice(0, 149)}${i} ^m-${(0x200000 + i).toString(16)}`;
  writeFileSync(join(dir, "brief.md"), `# Kullanıcı hakkında\n\n${Array.from({ length: 8 }, (_, i) => briefLine(i)).join("\n")}\n`);
  const b = await store.get("m-200000");
  assert.ok(b && b.text.length === 150);
  assert.deepEqual(await store.update(b.id, { text: `${b.text} ekle` }), { ok: false, reason: "brief_full" });
  assert.ok((await store.update(b.id, { text: `${b.text.slice(0, 140)} kısa` })).ok);
});
