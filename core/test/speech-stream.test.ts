import assert from "node:assert/strict";
import { test } from "node:test";
import { compileLexicon, EMPTY_LEXICON } from "../src/pronunciation.js";
import { SpeechServiceError, type TtsClient } from "../src/speech.js";
import { SpeechStream, type SpeechChunkFrame, type SpeechStreamOptions } from "../src/speech-stream.js";

const lexicon = compileLexicon([{ from: "Shadow", to: "Şadov" }]).lexicon;

interface Call {
  text: string;
  voice?: string;
  signal?: AbortSignal;
  resolve: () => void;
  reject: (err: unknown) => void;
}

/** TTS whose requests complete only when the test says so. Audio = the text bytes. */
function controlledTts() {
  const calls: Call[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const tts: TtsClient = {
    synthesize(text, signal, voice) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve, reject) => {
        const done = () => inFlight--;
        signal?.addEventListener("abort", () => {
          done();
          reject(new SpeechServiceError("tts_unavailable", "tts-svc: timed out or aborted"));
        });
        calls.push({
          text,
          voice,
          signal,
          resolve: () => {
            done();
            resolve({ mime: "audio/wav", data: Buffer.from(text, "utf8") });
          },
          reject: (err) => {
            done();
            reject(err);
          },
        });
      });
    },
    voices: async () => ({ default: "tr_TR-dfki-medium", voices: ["tr_TR-dfki-medium"] }),
  };
  return { tts, calls, maxInFlight: () => maxInFlight };
}

/** TTS that answers immediately. */
const instantTts: TtsClient = {
  synthesize: async (text) => ({ mime: "audio/wav", data: Buffer.from(text, "utf8") }),
  voices: async () => ({ default: "v-a-b", voices: ["v-a-b"] }),
};

const tick = () => new Promise<void>((r) => setImmediate(r));

function make(extra: Partial<SpeechStreamOptions> & Pick<SpeechStreamOptions, "mode">) {
  const frames: SpeechChunkFrame[] = [];
  const errors: SpeechServiceError[] = [];
  const stream = new SpeechStream({
    turnId: "t1",
    lexicon,
    send: (f) => frames.push(f),
    onError: (e) => errors.push(e),
    ...extra,
  });
  return { stream, frames, errors };
}

const decode = (f: SpeechChunkFrame) => ("data" in f ? Buffer.from(f.data, "base64").toString("utf8") : undefined);

const A = "Merhaba, ben Shadow ve buradayım.";
const B = "Oturma odasının ışığını yüzde kırka ayarladım.";
const C = "Başka bir isteğin var mı acaba?";

test("text mode: chunks in order with seq from 0, lexicon applied, final on the last chunk", async () => {
  const { stream, frames } = make({ mode: "text" });
  stream.push(`${A} ${B.slice(0, 10)}`);
  stream.push(`${B.slice(10)} ${C}`);
  await stream.end();
  assert.deepEqual(frames, [
    { type: "speech_chunk", id: "t1", seq: 0, final: false, text: "Merhaba, ben Şadov ve buradayım." },
    { type: "speech_chunk", id: "t1", seq: 1, final: false, text: B },
    { type: "speech_chunk", id: "t1", seq: 2, final: true, text: C },
  ]);
});

test("audio mode: lexicon applied before synthesis, base64 data, voice passed through", async () => {
  const { tts, calls } = controlledTts();
  const { stream, frames } = make({ mode: "audio", tts, voice: "tr_TR-fahrettin-medium" });
  stream.push(`${A} `);
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.text, "Merhaba, ben Şadov ve buradayım.");
  assert.equal(calls[0]!.voice, "tr_TR-fahrettin-medium");
  calls[0]!.resolve();
  await tick();
  assert.equal(frames.length, 1);
  assert.equal(frames[0]!.final, false);
  assert.equal("mime" in frames[0]! && frames[0]!.mime, "audio/wav");
  assert.equal(decode(frames[0]!), "Merhaba, ben Şadov ve buradayım.");
  const end = stream.end();
  await end;
  assert.deepEqual(frames[1], { type: "speech_chunk", id: "t1", seq: 1, final: true });
});

test("one chunk of lookahead: at most two requests in flight; frames strictly in seq order", async () => {
  const { tts, calls, maxInFlight } = controlledTts();
  const { stream, frames } = make({ mode: "audio", tts });
  const D = "Yatak odasındaki klimayı da kapattım şimdi.";
  stream.push(`${A} ${B} ${C} ${D}`);
  const end = stream.end();
  await tick();
  assert.equal(calls.length, 2, "sentence 1 and one ahead");
  // The second finishes first: it must wait for the first.
  calls[1]!.resolve();
  await tick();
  assert.equal(frames.length, 0);
  assert.equal(calls.length, 2, "no third request while two are unsent");
  calls[0]!.resolve();
  await tick();
  assert.deepEqual(frames.map((f) => f.seq), [0, 1]);
  assert.equal(calls.length, 4);
  calls[3]!.resolve();
  calls[2]!.resolve();
  await end;
  assert.deepEqual(frames.map((f) => [f.seq, f.final, decode(f)]), [
    [0, false, "Merhaba, ben Şadov ve buradayım."],
    [1, false, B],
    [2, false, C],
    [3, true, D],
  ]);
  assert.ok(maxInFlight() <= 2);
});

test("a chunk pushed while the first is synthesizing starts its synthesis at once (lookahead while pumping)", async () => {
  const { tts, calls, maxInFlight } = controlledTts();
  const { stream, frames } = make({ mode: "audio", tts });
  stream.push(`${A} `);
  await tick();
  assert.equal(calls.length, 1);
  // The send loop is awaiting chunk 1; chunk 2 arrives now.
  stream.push(`${B} `);
  await tick();
  assert.equal(calls.length, 2, "second synthesis runs alongside the first");
  stream.push(`${C} `);
  await tick();
  assert.equal(calls.length, 2, "cap of two unsent chunks holds");
  calls[1]!.resolve();
  await tick();
  assert.equal(frames.length, 0, "chunk 2 waits for chunk 1");
  calls[0]!.resolve();
  await tick();
  assert.deepEqual(frames.map((f) => f.seq), [0, 1]);
  assert.equal(calls.length, 3);
  const end = stream.end();
  calls[2]!.resolve();
  await end;
  assert.deepEqual(frames.map((f) => [f.seq, f.final, decode(f)]), [
    [0, false, "Merhaba, ben Şadov ve buradayım."],
    [1, false, B],
    [2, true, C],
  ]);
  assert.ok(maxInFlight() <= 2);
});

test("synthesis starts while the model is still writing (sentence 1 before the answer ends)", async () => {
  const { tts, calls } = controlledTts();
  const { stream, frames } = make({ mode: "audio", tts });
  stream.push(`${A} Oturma oda`);
  await tick();
  calls[0]!.resolve();
  await tick();
  assert.equal(frames.length, 1, "first chunk sent before end()");
  stream.push("sının ışığını açtım.");
  const end = stream.end();
  await tick();
  calls[1]!.resolve();
  await end;
  assert.deepEqual(frames.map((f) => [f.seq, f.final]), [[0, false], [1, true]]);
});

test("cancel during synthesis: requests aborted, no further frames, no final, no error", async () => {
  const { tts, calls } = controlledTts();
  const { stream, frames, errors } = make({ mode: "audio", tts });
  stream.push(`${A} ${B} ${C}`);
  await tick();
  calls[0]!.resolve();
  await tick();
  assert.equal(frames.length, 1);
  stream.cancel();
  assert.equal(calls[1]!.signal?.aborted, true);
  stream.push("Daha fazla metin geliyor burada.");
  await stream.end();
  await tick();
  assert.equal(frames.length, 1);
  assert.equal(errors.length, 0);
});

test("the turn's abort signal (or the side signal) cancels", async () => {
  const { tts, calls } = controlledTts();
  const turn = new AbortController();
  const side = new AbortController();
  const { stream, frames, errors } = make({ mode: "audio", tts, signals: [turn.signal, side.signal] });
  stream.push(`${A} `);
  await tick();
  side.abort();
  assert.equal(calls[0]!.signal?.aborted, true);
  await stream.done;
  assert.equal(frames.length, 0);
  assert.equal(errors.length, 0);
});

test("an already-aborted signal: nothing is synthesized or sent", async () => {
  const { tts, calls } = controlledTts();
  const ac = new AbortController();
  ac.abort();
  const { stream, frames } = make({ mode: "audio", tts, signals: [ac.signal] });
  stream.push(`${A} ${B}`);
  await stream.end();
  assert.equal(calls.length, 0);
  assert.equal(frames.length, 0);
});

test("tts failure: one error, synthesis stops, a final frame with the next seq", async () => {
  const { tts, calls } = controlledTts();
  const { stream, frames, errors } = make({ mode: "audio", tts });
  stream.push(`${A} ${B} ${C} `);
  await tick();
  calls[0]!.resolve();
  await tick();
  calls[1]!.reject(new SpeechServiceError("tts_unavailable", "tts-svc returned 500"));
  await tick();
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, "tts_unavailable");
  assert.equal(calls[2]?.signal?.aborted ?? true, true, "lookahead aborted");
  assert.deepEqual(frames.map((f) => [f.seq, f.final, "data" in f]), [[0, false, true], [1, true, false]]);
  stream.push("Bu metin artık konuşulmaz, gönderilmez de.");
  await stream.end();
  assert.equal(frames.length, 2);
  assert.equal(errors.length, 1);
});

test("tts failure on the first chunk: error + final seq 0; other errors are mapped to tts_unavailable", async () => {
  const tts: TtsClient = {
    synthesize: async () => {
      throw new SpeechServiceError("bad_request", "tts-svc rejected the text (413)");
    },
    voices: async () => ({ default: "v-a-b", voices: [] }),
  };
  const { stream, frames, errors } = make({ mode: "audio", tts });
  stream.push(`${A} `);
  await stream.done;
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.code, "tts_unavailable");
  assert.deepEqual(frames, [{ type: "speech_chunk", id: "t1", seq: 0, final: true }]);
});

test("empty answer sends nothing", async () => {
  const { stream, frames } = make({ mode: "audio", tts: instantTts });
  stream.push("   ");
  stream.push("😀");
  await stream.end();
  assert.equal(frames.length, 0);
});

test("a single short answer is sent as one final chunk", async () => {
  const { stream, frames } = make({ mode: "audio", tts: instantTts });
  stream.push("Tamam.");
  await stream.end();
  assert.deepEqual(frames.map((f) => [f.seq, f.final, decode(f)]), [[0, true, "Tamam."]]);
});

test("end() after everything was sent: a bare final marker", async () => {
  const { stream, frames } = make({ mode: "text" });
  stream.push(`${A} ${B} `);
  await tick();
  assert.equal(frames.length, 2);
  await stream.end();
  assert.deepEqual(frames[2], { type: "speech_chunk", id: "t1", seq: 2, final: true });
  assert.equal(await stream.end(), undefined, "end is idempotent");
  assert.equal(frames.length, 3);
});

test("chunk text is clipped to the TTS limit after the lexicon", async () => {
  const long = compileLexicon([{ from: "x", to: "uzun bir değiştirme metni" }]).lexicon;
  const { stream, frames } = make({ mode: "text", lexicon: long, maxTextChars: 60 });
  stream.push("x x x x x x x x.");
  await stream.end();
  const text = "text" in frames[0]! ? frames[0]!.text : "";
  assert.ok(text.length <= 60, `clipped (${text.length})`);
});

test("a throwing send cancels the stream", async () => {
  let n = 0;
  const stream = new SpeechStream({
    turnId: "t1",
    mode: "text",
    lexicon: EMPTY_LEXICON,
    send: () => {
      if (n++ > 0) throw new Error("socket closed");
    },
  });
  stream.push(`${A} ${B} ${C}`);
  await stream.end();
  assert.equal(n, 2);
});

test("firstChunkAt is set when the first content frame is sent", async () => {
  let t = 1000;
  const { stream } = make({ mode: "text", now: () => t });
  assert.equal(stream.firstChunkAt, undefined);
  t = 1250;
  stream.push(`${A} `);
  await tick();
  assert.equal(stream.firstChunkAt, 1250);
  await stream.end();
  assert.equal(stream.sentFrames, 2);
});

test("audio mode without a TTS client is a programming error", () => {
  assert.throws(() => new SpeechStream({ turnId: "t", mode: "audio", lexicon, send: () => {} }));
});
