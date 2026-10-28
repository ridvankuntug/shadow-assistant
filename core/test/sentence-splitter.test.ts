import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_CHARS, SentenceSplitter } from "../src/sentence-splitter.js";

/** Feeds the whole text at once and flushes. */
function split(text: string): string[] {
  const s = new SentenceSplitter();
  return [...s.push(text), ...s.flush()];
}

/** Feeds the text in pieces of `size` characters (code points). */
function splitStreamed(text: string, size: number): string[] {
  const s = new SentenceSplitter();
  const cps = [...text];
  const out: string[] = [];
  for (let i = 0; i < cps.length; i += size) out.push(...s.push(cps.slice(i, i + size).join("")));
  return [...out, ...s.flush()];
}

const S1 = "Merhaba, bugün hava çok güzel görünüyor.";
const S2 = "Oturma odasının ışığını yüzde kırka ayarladım.";
const S3 = "Başka bir isteğin var mı?";

const cases: { name: string; text: string; want: string[] }[] = [
  { name: "plain sentences", text: `${S1} ${S2} ${S3}`, want: [S1, S2, S3] },
  { name: "! and ? and …", text: "Harika bir fikir! Bunu deneyelim mi? Belki yarın… Sonra konuşuruz bunu.", want: ["Harika bir fikir!", "Bunu deneyelim mi? Belki yarın…", "Sonra konuşuruz bunu."] },
  { name: "decimal with dot", text: "Sıcaklık şu an 21.5 derece civarında. Nem oranı yüzde kırk beş.", want: ["Sıcaklık şu an 21.5 derece civarında.", "Nem oranı yüzde kırk beş."] },
  { name: "decimal with comma", text: "Sıcaklık 21,5 derece, nem 3,5 kat fazla. Başka bir şey var mı acaba?", want: ["Sıcaklık 21,5 derece, nem 3,5 kat fazla.", "Başka bir şey var mı acaba?"] },
  { name: "ordinal before lower-case word", text: "Lamba binanın 3. katındaki salonda yanıyor. Kapatayım mı onu şimdi?", want: ["Lamba binanın 3. katındaki salonda yanıyor.", "Kapatayım mı onu şimdi?"] },
  { name: "number at sentence end before upper-case", text: "Bugün sıcaklık hedefi 21. Yarın için 22 dereceye ayarlayabilirim.", want: ["Bugün sıcaklık hedefi 21.", "Yarın için 22 dereceye ayarlayabilirim."] },
  { name: "abbreviations", text: "Randevun Dr. Ahmet Yılmaz ile, Prof. Ayşe Hanım da orada. Lamba, priz vb. cihazlar da hazır olacak.", want: ["Randevun Dr. Ahmet Yılmaz ile, Prof. Ayşe Hanım da orada.", "Lamba, priz vb. cihazlar da hazır olacak."] },
  { name: "abbreviations Doç./Av./Sn./örn./bkz./No./vs.", text: "Doç. Mehmet ve Av. Zeynep geldi, Sn. Ali de. Örn. ışıklar, bkz. 4. bölüm, Kapı No. 5 vs. hepsi tamam.", want: ["Doç. Mehmet ve Av. Zeynep geldi, Sn. Ali de.", "Örn. ışıklar, bkz. 4. bölüm, Kapı No. 5 vs. hepsi tamam."] },
  { name: "abbreviation case-insensitive (DR.)", text: "DR. Ahmet geldi ve kapıda bekliyor. Kapıyı açayım mı hemen?", want: ["DR. Ahmet geldi ve kapıda bekliyor.", "Kapıyı açayım mı hemen?"] },
  { name: "dot run glued to a word is not a boundary", text: "Hmm...bir saniye düşüneyim bunu. Tamam, buldum galiba çözümü.", want: ["Hmm...bir saniye düşüneyim bunu.", "Tamam, buldum galiba çözümü."] },
  { name: "dot run followed by space is a boundary", text: "Bir saniye düşüneyim... Tamam, şimdi buldum galiba çözümü.", want: ["Bir saniye düşüneyim...", "Tamam, şimdi buldum galiba çözümü."] },
  { name: "URL dots", text: "Ayrıntılar https://www.ornek.com.tr/a.b?x=1 adresinde var. Oraya bakabilirsin istersen.", want: ["Ayrıntılar https://www.ornek.com.tr/a.b?x=1 adresinde var.", "Oraya bakabilirsin istersen."] },
  { name: "closing quote stays with the sentence", text: "Ona \"Geliyorum.\" dedim ve çıktım. Sonra kapıyı kilitledim hemen.", want: ["Ona \"Geliyorum.\"", "dedim ve çıktım. Sonra kapıyı kilitledim hemen."] },
  { name: "newline is a boundary", text: "Işıklar kapatıldı ve perdeler indirildi\nKlima yirmi bir dereceye ayarlandı", want: ["Işıklar kapatıldı ve perdeler indirildi", "Klima yirmi bir dereceye ayarlandı"] },
  { name: "first chunk needs 2 words: one-word first sentence merges forward", text: "Tamam. Işığı kapattım.", want: ["Tamam. Işığı kapattım."] },
  { name: "first chunk with 2 words is emitted at once; later short ones merge", text: "Tamam, kapattım. Evet. Hayır. Oturma odası şimdi karanlık.", want: ["Tamam, kapattım.", "Evet. Hayır. Oturma odası şimdi karanlık."] },
  { name: "short trailing sentence is still flushed", text: `${S1} Tamam.`, want: [S1, "Tamam."] },
  { name: "emoji kept inside, emoji-only chunk dropped", text: "Harika bir haber bu! 😀 Bir şey daha söylemem lazım sana. 🎉", want: ["Harika bir haber bu!", "😀 Bir şey daha söylemem lazım sana."] },
  { name: "empty and whitespace", text: "   \n\n  ", want: [] },
  { name: "whitespace collapsed", text: "Birinci   cümle  burada\tbitti.   İkinci cümle de buradaydı.", want: ["Birinci cümle burada bitti.", "İkinci cümle de buradaydı."] },
];

for (const c of cases) {
  test(`split: ${c.name}`, () => {
    assert.deepEqual(split(c.text), c.want);
  });
  test(`split streamed char by char: ${c.name}`, () => {
    assert.deepEqual(splitStreamed(c.text, 1), c.want);
    assert.deepEqual(splitStreamed(c.text, 3), c.want);
  });
}

test("punctuation split across deltas", () => {
  const s = new SentenceSplitter();
  assert.deepEqual(s.push("Işığı kapattım"), []);
  assert.deepEqual(s.push("."), [], "undecided until the next character");
  assert.deepEqual(s.push(" Başka"), ["Işığı kapattım."]);
  assert.deepEqual(s.push(" bir şey var mı"), []);
  assert.deepEqual(s.push("?"), []);
  assert.deepEqual(s.flush(), ["Başka bir şey var mı?"]);
});

test("abbreviation split across deltas", () => {
  const s = new SentenceSplitter();
  assert.deepEqual(s.push("Bunu D"), []);
  assert.deepEqual(s.push("r."), []);
  assert.deepEqual(s.push(" Ahmet söyledi bana."), []);
  assert.deepEqual(s.push(" Sonra"), ["Bunu Dr. Ahmet söyledi bana."]);
});

test("ordinal waits for the next word before deciding", () => {
  const s = new SentenceSplitter();
  assert.deepEqual(s.push("Lamba 3. "), []);
  assert.deepEqual(s.push("katta yanıyor, kapatıyorum."), []);
  assert.deepEqual(s.flush(), ["Lamba 3. katta yanıyor, kapatıyorum."]);
  const t = new SentenceSplitter();
  assert.deepEqual(t.push("Bugün hedef 3. "), []);
  assert.deepEqual(t.push("Yarın"), ["Bugün hedef 3."]);
});

test("a number with a dot at the very end of the answer is flushed", () => {
  assert.deepEqual(split("Sonuç tam olarak 3."), ["Sonuç tam olarak 3."]);
});

test("long sentence without punctuation is cut while streaming, never over the max", () => {
  const words = Array.from({ length: 120 }, (_, i) => `kelime${i}`);
  const text = words.join(" ");
  const s = new SentenceSplitter();
  const early: string[] = [];
  for (const w of words) early.push(...s.push(`${w} `));
  assert.ok(early.length >= 1, "chunks are emitted before the end");
  const all = [...early, ...s.flush()];
  for (const c of all) assert.ok(c.length <= MAX_CHARS, `chunk length ${c.length}`);
  assert.equal(all.join(" "), text, "no text lost or duplicated");
});

test("long sentence is cut at the last comma when that keeps at least half", () => {
  const head = `${"a".repeat(200)}, `;
  const tail = "b ".repeat(80);
  const out = split(`${head}${tail}son.`);
  assert.equal(out[0], `${"a".repeat(200)},`);
  for (const c of out) assert.ok(c.length <= MAX_CHARS);
});

test("text with no whitespace is hard-cut at the max without splitting a surrogate pair", () => {
  // U+1D400 (a letter outside the BMP): two UTF-16 units each.
  const text = "x".repeat(MAX_CHARS - 1) + "𝐀".repeat(5);
  const out = split(text);
  assert.ok(out.every((c) => c.length <= MAX_CHARS));
  assert.equal(out.join(""), text);
  assert.ok(!out.some((c) => /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(c)), "no broken surrogates");
});

test("custom sizes", () => {
  const s = new SentenceSplitter({ minChars: 6, firstMinWords: 1 });
  assert.deepEqual([...s.push("Tamam. Evet. Olur. "), ...s.flush()], ["Tamam.", "Evet. Olur."]);
});

test("flush resets the splitter for reuse", () => {
  const s = new SentenceSplitter();
  s.push("Birinci cevap burada bitti.");
  assert.deepEqual(s.flush(), ["Birinci cevap burada bitti."]);
  assert.deepEqual([...s.push("Tamam. İkinci cevap."), ...s.flush()], ["Tamam. İkinci cevap."]);
});

test("the escalation marker is not special (it is never fed in)", () => {
  // Documented contract: the caller feeds post-buffering text only. The splitter treats it as text.
  assert.deepEqual(split("[[ESCALATE]]"), ["[[ESCALATE]]"]);
});
