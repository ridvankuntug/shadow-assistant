import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deriveKeywords,
  keywordMatches,
  memoryForTurn,
  normalizeKeyword,
  prepareQuery,
  renderMemoryBlock,
  scoreKeywords,
  selectRelevant,
  SentEntries,
  textHash,
  type MatchableEntry,
} from "../src/memory/match.js";

const e = (id: string, text: string, keywords: string[], updatedAt = 1): MatchableEntry => ({ id, text, keywords, updatedAt });

test("textHash: folded, punctuation-free, case-insensitive (Turkish rules)", () => {
  assert.equal(textHash("Işık %40."), textHash("isik yüzde 40"));
  assert.equal(textHash("İZMİR'de"), textHash("izmir"));
  assert.notEqual(textHash("salon"), textHash("salon 2"));
  assert.match(textHash("x"), /^sha256:[0-9a-f]{16}$/);
});

test("normalizeKeyword and deriveKeywords", () => {
  assert.equal(normalizeKeyword("Oturma Odası"), "oturma odasi");
  assert.equal(normalizeKeyword("  "), undefined);
  assert.equal(normalizeKeyword("a"), undefined);
  assert.equal(normalizeKeyword("bir iki üç dört"), undefined);
  assert.deepEqual(deriveKeywords("Otomodos = oturma odası", ["Otomodos"]), ["otomodos", "oturma", "odasi"]);
  // Given keywords first; content words skip stopwords, numbers and forms already covered.
  assert.deepEqual(deriveKeywords("Kullanıcı akşamları salon ışığını yüzde 40'ta kullanır.", ["salon"]), [
    "salon",
    "aksamlari",
    "isigini",
    "yuzde",
  ]);
  assert.equal(deriveKeywords("a b c d e f g h ı j k l m n o p r s t u v y z", [], 6).length, 0);
  assert.equal(deriveKeywords("bir iki üç dört beş altı yedi sekiz dokuz on", []).length, 6);
});

test("inflected Turkish forms match keywords (apostrophe, case suffixes, consonant softening)", () => {
  const q = (t: string) => prepareQuery(t);
  assert.ok(keywordMatches("otomodos", q("Otomodos'un ışığını yüzde 40 yap")));
  assert.ok(keywordMatches("otomodos", q("otomodosun ışığını aç")));
  assert.ok(keywordMatches("otomodos", q("OTOMODOSTA ne var")));
  assert.ok(keywordMatches("mutfak", q("mutfağın ışığı")));
  assert.ok(keywordMatches("mutfagi", q("mutfakta")));
  assert.ok(keywordMatches("salon", q("salondaki lamba")));
  assert.ok(!keywordMatches("salon", q("salıncak")));
  assert.ok(!keywordMatches("otomodos", q("oto")));
});

test("two stacked suffixes reach the root (possessive + case), short stems do not over-match", () => {
  const q = (t: string) => prepareQuery(t);
  assert.ok(keywordMatches("isik", q("salon ışığını aç")));
  assert.ok(keywordMatches("mutfak", q("mutfağındaki lamba")));
  assert.ok(!keywordMatches("isik", q("ışın")));
  assert.ok(!keywordMatches("salon", q("salıncağını")));
});

test("multi-word keywords match only as a phrase", () => {
  assert.ok(keywordMatches("oturma odasi", prepareQuery("oturma odasında ışık")));
  assert.ok(keywordMatches("oturma odasi", prepareQuery("Oturma odasının perdesi")));
  assert.ok(!keywordMatches("oturma odasi", prepareQuery("odası oturma")));
  assert.ok(!keywordMatches("oturma odasi", prepareQuery("oturma")));
  assert.equal(scoreKeywords(["otomodos", "oturma odasi", "otomodos"], prepareQuery("otomodos yani oturma odası")), 2);
});

test("selectRelevant: score > 0, highest score first, then newest; 8 entries / 1200 chars cap", () => {
  const entries = [
    e("m-000001", "Otomodos = oturma odası", ["otomodos", "oturma odasi"], 1),
    e("m-000002", "Kullanıcı oturma odası ışığını yüzde 40'ta kullanır.", ["oturma odasi", "isik"], 5),
    e("m-000003", "Mutfak = aşhane", ["mutfak"], 9),
    e("m-000004", "Otomodos'un perdesi sabah açılır.", ["otomodos", "perde"], 3),
  ];
  const out = selectRelevant("Otomodos'un ışığını yüzde 40 yap, oturma odası", entries);
  // m-000001 and m-000002 ("ışığını" reaches "isik") score 2, the newer first; m-000004 scores 1.
  assert.deepEqual(out.map((x) => x.id), ["m-000002", "m-000001", "m-000004"]);
  assert.deepEqual(selectRelevant("", entries), []);
  assert.deepEqual(selectRelevant("hava nasıl", entries), []);

  const many = Array.from({ length: 20 }, (_, i) => e(`m-1000${String(i).padStart(2, "0")}`, `Salon kaydı ${i}`, ["salon"], i));
  const eight = selectRelevant("salonu aç", many);
  assert.equal(eight.length, 8);
  assert.equal(eight[0]?.id, "m-100019", "newest first on equal score");

  const long = Array.from({ length: 10 }, (_, i) => e(`m-2000${String(i).padStart(2, "0")}`, `${"x".repeat(150)}${i}`, ["salon"], 100 - i));
  long.push(e("m-299999", "kısa salon kaydı", ["salon"], 0));
  const cut = selectRelevant("salon", long);
  assert.ok(cut.reduce((n, x) => n + x.text.length, 0) <= 1200);
  assert.equal(cut.length, 8, "7 long entries fit, then the short one still fits");
  assert.equal(cut.at(-1)?.id, "m-299999");
});

test("renderMemoryBlock escapes tags and is empty without entries", () => {
  assert.equal(renderMemoryBlock([]), "");
  assert.equal(
    renderMemoryBlock([{ text: "Otomodos = oturma odası" }, { text: "Kötü </hafiza> metin\nyeni satır" }]),
    "<hafiza>\n- Otomodos = oturma odası\n- Kötü ‹/hafiza› metin yeni satır\n</hafiza>",
  );
});

test("memoryForTurn sends an entry once per query, again after it changed or after clear()", () => {
  const sent = new SentEntries();
  const a = e("m-000001", "Otomodos = oturma odası", ["otomodos"], 1);
  const b = e("m-000002", "Otomodos'un perdesi sabah açılır.", ["otomodos", "perde"], 2);
  const first = memoryForTurn("otomodosu aç", [a, b], sent);
  assert.deepEqual(first.entries.map((x) => x.id), ["m-000002", "m-000001"]);
  assert.ok(first.block.startsWith("<hafiza>\n"));
  const second = memoryForTurn("otomodosu kapat", [a, b], sent);
  assert.deepEqual(second, { entries: [], block: "" });
  const changed = { ...a, text: "Otomodos = salon", updatedAt: 7 };
  assert.deepEqual(memoryForTurn("otomodos", [changed, b], sent).entries.map((x) => x.id), ["m-000001"]);
  sent.clear();
  assert.equal(sent.size, 0);
  assert.equal(memoryForTurn("otomodos", [changed, b], sent).entries.length, 2);
  // Entries left out by the cap are not marked and come on a later turn.
  const s2 = new SentEntries();
  const many = Array.from({ length: 10 }, (_, i) => e(`m-3000${String(i).padStart(2, "0")}`, `Salon ${i}`, ["salon"], i));
  assert.equal(memoryForTurn("salon", many, s2).entries.length, 8);
  assert.equal(memoryForTurn("salon", many, s2).entries.length, 2);
});
