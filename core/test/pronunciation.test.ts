import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig, loadPronunciationsFile } from "../src/config.js";
import {
  compileLexicon,
  EMPTY_LEXICON,
  parsePronunciations,
  PronunciationsError,
  type PronunciationEntry,
} from "../src/pronunciation.js";

const REPO_FILE = join(fileURLToPath(new URL("../../", import.meta.url)), "pronunciations.yaml");
const dir = mkdtempSync(join(tmpdir(), "shadow-pron-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function lex(entries: Record<string, string>) {
  const list: PronunciationEntry[] = Object.entries(entries).map(([from, to]) => ({ from, to }));
  return compileLexicon(list).lexicon;
}

const shadow = lex({ Shadow: "Şadov" });

test("basic replacement, text around it unchanged", () => {
  assert.equal(shadow.apply("Merhaba, ben Shadow."), "Merhaba, ben Şadov.");
  assert.equal(shadow.apply("Shadow"), "Şadov");
  assert.equal(shadow.apply("Shadow ve Shadow"), "Şadov ve Şadov");
  assert.equal(shadow.apply("merhaba"), "merhaba");
  assert.equal(shadow.apply(""), "");
});

test("case-insensitive; replacement is inserted as written", () => {
  assert.equal(shadow.apply("SHADOW"), "Şadov");
  assert.equal(shadow.apply("shadow"), "Şadov");
  assert.equal(shadow.apply("sHaDoW!"), "Şadov!");
});

test("Turkish casing: I/ı/İ/i are the same letter", () => {
  const l = lex({ ışık: "ışık lambası", Siri: "Siri asistanı" });
  assert.equal(l.apply("IŞIK"), "ışık lambası");
  assert.equal(l.apply("Işık"), "ışık lambası");
  assert.equal(l.apply("SİRİ"), "Siri asistanı");
  assert.equal(l.apply("SIRI"), "Siri asistanı");
  assert.equal(l.apply("siri"), "Siri asistanı");
});

test("apostrophe suffixes are kept, straight and typographic", () => {
  assert.equal(shadow.apply("Shadow'u aç"), "Şadov'u aç");
  assert.equal(shadow.apply("Shadow'a sor"), "Şadov'a sor");
  assert.equal(shadow.apply("Shadow’un sesi"), "Şadov’un sesi");
  assert.equal(shadow.apply("SHADOW’A"), "Şadov’A");
  assert.equal(shadow.apply("'Shadow'"), "'Şadov'");
});

test("whole words only: no match inside other words or with a bare suffix", () => {
  assert.equal(shadow.apply("Shadowlar"), "Shadowlar");
  assert.equal(shadow.apply("Shadowing"), "Shadowing");
  assert.equal(shadow.apply("MyShadow"), "MyShadow");
  assert.equal(shadow.apply("Shadow2"), "Shadow2");
  assert.equal(shadow.apply("shadow_x"), "shadow_x");
  // Punctuation and whitespace are boundaries.
  assert.equal(shadow.apply("(Shadow)"), "(Şadov)");
  assert.equal(shadow.apply("Shadow-Asistan"), "Şadov-Asistan");
  assert.equal(shadow.apply("Shadow\nShadow"), "Şadov\nŞadov");
});

test("Turkish letters count as word characters at the boundaries", () => {
  for (const ch of ["ç", "ğ", "ı", "İ", "ö", "ş", "ü", "Ç", "Ş", "â"]) {
    assert.equal(shadow.apply(`Shadow${ch}`), `Shadow${ch}`, `suffix ${ch}`);
    assert.equal(shadow.apply(`${ch}Shadow`), `${ch}Shadow`, `prefix ${ch}`);
  }
  // A Turkish key is bounded by Turkish letters too.
  const l = lex({ çay: "çaay" });
  assert.equal(l.apply("çay"), "çaay");
  assert.equal(l.apply("Çay'ı"), "çaay'ı");
  assert.equal(l.apply("çaylık"), "çaylık");
  assert.equal(l.apply("açay"), "açay");
});

test("multi-word keys: longest first, flexible whitespace", () => {
  const l = lex({ Shadow: "Şadov", "Shadow Assistant": "Şadov Asistan" });
  assert.equal(l.apply("Shadow Assistant'a hoş geldin"), "Şadov Asistan'a hoş geldin");
  assert.equal(l.apply("shadow   assistant"), "Şadov Asistan");
  assert.equal(l.apply("Shadow ve Assistant"), "Şadov ve Assistant");
  assert.equal(l.apply("Shadow Assistants"), "Şadov Assistants");
  // Order in the file does not matter.
  const reversed = lex({ "Shadow Assistant": "Şadov Asistan", Shadow: "Şadov" });
  assert.equal(reversed.apply("Shadow Assistant"), "Şadov Asistan");
});

test("regex characters in keys and `$` in values are literal", () => {
  const l = lex({ "C++": "si artı artı", "a.b": "a nokta b", USD: "$1 dolar" });
  assert.equal(l.apply("C++ ve axb ve a.b"), "si artı artı ve axb ve a nokta b");
  assert.equal(l.apply("USD"), "$1 dolar");
});

test("compile drops empty and case-duplicate entries with warnings", () => {
  const { lexicon, warnings } = compileLexicon([
    { from: "Shadow", to: "Şadov" },
    { from: "SHADOW", to: "Şedov" },
    { from: "  ", to: "x" },
    { from: "y", to: "" },
  ]);
  assert.deepEqual(lexicon.entries, [{ from: "Shadow", to: "Şadov" }]);
  assert.equal(warnings.length, 3);
  assert.equal(lexicon.apply("shadow"), "Şadov");
});

test("parsePronunciations: mapping, empty file, bad entries, invalid file", () => {
  const ok = parsePronunciations("# comment\nShadow: Şadov\nHome Assistant: Hom Asistant\n");
  assert.equal(ok.lexicon.entries.length, 2);
  assert.deepEqual(ok.warnings, []);
  assert.equal(parsePronunciations("").lexicon, EMPTY_LEXICON);
  assert.equal(parsePronunciations("# only comments\n").lexicon, EMPTY_LEXICON);

  const partial = parsePronunciations("Shadow: Şadov\nR2: 2\nx: [a]\n");
  assert.deepEqual(partial.lexicon.entries, [{ from: "Shadow", to: "Şadov" }]);
  assert.equal(partial.warnings.length, 2);

  assert.throws(() => parsePronunciations("- Shadow\n- Şadov\n"), PronunciationsError);
  assert.throws(() => parsePronunciations("just a string"), PronunciationsError);
  assert.throws(() => parsePronunciations("a: [unclosed\n"), PronunciationsError);
  assert.throws(() => parsePronunciations("Shadow: a\nShadow: b\n"), PronunciationsError);
});

test("loadPronunciationsFile: missing file = empty, invalid file = empty + warning, never throws", () => {
  const missing = loadPronunciationsFile(join(dir, "nope.yaml"));
  assert.equal(missing.lexicon, EMPTY_LEXICON);
  assert.deepEqual(missing.warnings, []);
  assert.equal(missing.found, false);

  const badPath = join(dir, "bad.yaml");
  writeFileSync(badPath, "- not\n- a mapping\n");
  const bad = loadPronunciationsFile(badPath);
  assert.equal(bad.lexicon, EMPTY_LEXICON);
  assert.equal(bad.warnings.length, 1);
  assert.match(bad.warnings[0]!, /lexicon disabled/);

  const brokenPath = join(dir, "broken.yaml");
  writeFileSync(brokenPath, "Shadow: [\n");
  assert.equal(loadPronunciationsFile(brokenPath).lexicon, EMPTY_LEXICON);

  // A directory is unreadable as a file: warning, no throw.
  const unreadable = loadPronunciationsFile(dir);
  assert.equal(unreadable.lexicon, EMPTY_LEXICON);
  assert.equal(unreadable.warnings.length, 1);

  const goodPath = join(dir, "good.yaml");
  writeFileSync(goodPath, "Shadow: Şadov\n");
  const good = loadPronunciationsFile(goodPath);
  assert.equal(good.found, true);
  assert.equal(good.lexicon.apply("Shadow'u"), "Şadov'u");
});

test("repo pronunciations.yaml is valid and maps Shadow to Şadov", () => {
  const { lexicon, warnings, found } = loadPronunciationsFile(REPO_FILE);
  assert.equal(found, true);
  assert.deepEqual(warnings, []);
  assert.equal(lexicon.apply("Ben Shadow, Shadow'a sor."), "Ben Şadov, Şadov'a sor.");
});

test("config: SHADOW_PRONUNCIATIONS_FILE overrides the repo-root default", () => {
  const env = { DEVICE_TOKEN_X: "x".repeat(16), CORE_ROUTER: "off" };
  assert.equal(loadConfig(env).pronunciationsFile, REPO_FILE);
  assert.equal(loadConfig({ ...env, SHADOW_PRONUNCIATIONS_FILE: "/tmp/p.yaml" }).pronunciationsFile, "/tmp/p.yaml");
});
