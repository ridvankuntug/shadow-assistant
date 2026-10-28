import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clipForTts,
  describeVoice,
  PiperTtsClient,
  SpeechServiceError,
  TTS_MAX_TEXT_CHARS,
  VOICE_CACHE_MS,
  WhisperClient,
  type FetchFn,
} from "../src/speech.js";

const fakeFetch = (handler: (url: string, init: RequestInit) => Response | Promise<Response>): FetchFn =>
  (async (url: string | URL | Request, init?: RequestInit) => handler(String(url), init ?? {})) as FetchFn;

const code = (c: string) => (err: unknown) => err instanceof SpeechServiceError && err.code === c;

test("whisper: posts raw audio and returns trimmed text", async () => {
  let seen: { url: string; type: string | null } | undefined;
  const c = new WhisperClient(
    "http://stt",
    1000,
    "tr",
    fakeFetch((url, init) => {
      seen = { url, type: new Headers(init.headers).get("content-type") };
      return Response.json({ text: " merhaba ", language: "tr", duration_ms: 900, processing_ms: 100 });
    }),
  );
  const r = await c.transcribe(Buffer.from("x"), "audio/webm;codecs=opus");
  assert.deepEqual(r, { text: "merhaba", language: "tr", durationMs: 900 });
  assert.equal(seen?.url, "http://stt/transcribe?language=tr");
  assert.equal(seen?.type, "audio/webm");
});

test("whisper: unavailable / rejected / not configured", async () => {
  const down = new WhisperClient("http://stt", 1000, "tr", fakeFetch(() => Promise.reject(new TypeError("fetch failed"))));
  await assert.rejects(down.transcribe(Buffer.from("x"), "audio/wav"), code("stt_unavailable"));
  const loading = new WhisperClient("http://stt", 1000, "tr", fakeFetch(() => Response.json({ status: "loading" }, { status: 503 })));
  await assert.rejects(loading.transcribe(Buffer.from("x"), "audio/wav"), code("stt_unavailable"));
  const bad = new WhisperClient("http://stt", 1000, "tr", fakeFetch(() => new Response("bad", { status: 400 })));
  await assert.rejects(bad.transcribe(Buffer.from("x"), "audio/wav"), code("bad_request"));
  await assert.rejects(new WhisperClient(undefined).transcribe(Buffer.from("x"), "audio/wav"), code("stt_unavailable"));
});

test("tts: returns wav bytes; errors map to tts_unavailable", async () => {
  const ok = new PiperTtsClient(
    "http://tts",
    1000,
    fakeFetch((url, init) => {
      assert.equal(url, "http://tts/synthesize");
      assert.deepEqual(JSON.parse(String(init.body)), { text: "selam" });
      return new Response(new Uint8Array([82, 73, 70, 70]), { headers: { "content-type": "audio/wav" } });
    }),
  );
  const r = await ok.synthesize("selam");
  assert.equal(r.mime, "audio/wav");
  assert.equal(r.data.toString(), "RIFF");
  const down = new PiperTtsClient("http://tts", 1000, fakeFetch(() => Promise.reject(new TypeError("fetch failed"))));
  await assert.rejects(down.synthesize("x"), code("tts_unavailable"));
  await assert.rejects(new PiperTtsClient(undefined).synthesize("x"), code("tts_unavailable"));
});

const HEALTH = {
  status: "ok",
  service: "tts-svc",
  voice: "tr_TR-dfki-medium",
  voices: ["tr_TR-dfki-medium"],
  available: ["tr_TR-dfki-medium", "tr_TR-fahrettin-medium", "tr_TR-fettah-medium", "../bad", 7],
};

/** Fake tts-svc: /health answers `health`, /synthesize records the body. */
function fakeTts(health: () => Response, synth: () => Response = () => new Response(new Uint8Array([82]))) {
  const calls = { health: 0, bodies: [] as unknown[] };
  const fetchFn = fakeFetch((url, init) => {
    if (url.endsWith("/health")) {
      calls.health++;
      return health();
    }
    calls.bodies.push(JSON.parse(String(init.body)));
    return synth();
  });
  return { calls, fetchFn };
}

test("tts voices: available list (default first, invalid ids dropped), cached, shared, failures not cached", async () => {
  let now = 1_000;
  let up = true;
  const { calls, fetchFn } = fakeTts(() => (up ? Response.json(HEALTH) : Response.json({ status: "loading" }, { status: 503 })));
  const c = new PiperTtsClient("http://tts", 1000, fetchFn, () => now);
  const [a, b] = await Promise.all([c.voices(), c.voices()]);
  assert.deepEqual(a, {
    default: "tr_TR-dfki-medium",
    voices: ["tr_TR-dfki-medium", "tr_TR-fahrettin-medium", "tr_TR-fettah-medium"],
  });
  assert.deepEqual(b, a);
  assert.equal(calls.health, 1);
  now += VOICE_CACHE_MS - 1;
  await c.voices();
  assert.equal(calls.health, 1);
  now += 2;
  up = false;
  await assert.rejects(c.voices(), code("tts_unavailable"));
  up = true;
  await c.voices();
  assert.equal(calls.health, 3);
});

test("tts voices: older tts-svc without `available` falls back to loaded `voices`", async () => {
  const { fetchFn } = fakeTts(() => Response.json({ status: "ok", voice: "tr_TR-dfki-medium", voices: ["tr_TR-dfki-medium"] }));
  assert.deepEqual(await new PiperTtsClient("http://tts", 1000, fetchFn).voices(), {
    default: "tr_TR-dfki-medium",
    voices: ["tr_TR-dfki-medium"],
  });
  const garbage = fakeTts(() => Response.json({ status: "ok" }));
  await assert.rejects(new PiperTtsClient("http://tts", 1000, garbage.fetchFn).voices(), code("tts_unavailable"));
  await assert.rejects(new PiperTtsClient(undefined).voices(), code("tts_unavailable"));
});

test("tts synthesize: known voice is sent, unknown voice or unavailable list → default (no voice field)", async () => {
  const { calls, fetchFn } = fakeTts(() => Response.json(HEALTH));
  const c = new PiperTtsClient("http://tts", 1000, fetchFn);
  await c.synthesize("a", undefined, "tr_TR-fettah-medium");
  await c.synthesize("b", undefined, "xx_XX-nope-medium");
  await c.synthesize("c");
  assert.deepEqual(calls.bodies, [{ text: "a", voice: "tr_TR-fettah-medium" }, { text: "b" }, { text: "c" }]);
  const down = fakeTts(() => Response.json({ status: "loading" }, { status: 503 }));
  await new PiperTtsClient("http://tts", 1000, down.fetchFn).synthesize("d", undefined, "tr_TR-fettah-medium");
  assert.deepEqual(down.calls.bodies, [{ text: "d" }]);
});

test("tts synthesize: voice still loading / failed → tts_unavailable with a clear message", async () => {
  const loading = fakeTts(
    () => Response.json(HEALTH),
    () => Response.json({ error: "voice_loading", status: "loading", voice: "tr_TR-fettah-medium" }, { status: 503 }),
  );
  await assert.rejects(
    new PiperTtsClient("http://tts", 1000, loading.fetchFn).synthesize("x", undefined, "tr_TR-fettah-medium"),
    (err: unknown) => code("tts_unavailable")(err) && /still loading voice tr_TR-fettah-medium/.test((err as Error).message),
  );
  const failed = fakeTts(() => Response.json(HEALTH), () => Response.json({ error: "voice_unavailable" }, { status: 503 }));
  await assert.rejects(
    new PiperTtsClient("http://tts", 1000, failed.fetchFn).synthesize("x", undefined, "tr_TR-fettah-medium"),
    (err: unknown) => code("tts_unavailable")(err) && /could not load voice/.test((err as Error).message),
  );
});

test("describeVoice: Turkish labels from Piper ids", () => {
  assert.deepEqual(describeVoice("tr_TR-dfki-medium"), { id: "tr_TR-dfki-medium", label: "DFKI (orta kalite)", quality: "medium" });
  assert.deepEqual(describeVoice("tr_TR-ilker_bey-x_low"), {
    id: "tr_TR-ilker_bey-x_low",
    label: "İlker Bey (çok düşük kalite)",
    quality: "x_low",
  });
  assert.equal(describeVoice("en_US-lessac-high").label, "Lessac (en_US, yüksek kalite)");
  assert.deepEqual(describeVoice("custom"), { id: "custom", label: "custom" });
});

test("clipForTts: unchanged within the limit, else sentence > word > hard cut", () => {
  assert.equal(TTS_MAX_TEXT_CHARS, 2000);
  assert.equal(clipForTts("Merhaba."), "Merhaba.");
  const exact = "x".repeat(TTS_MAX_TEXT_CHARS);
  assert.equal(clipForTts(exact), exact);
  // Sentence end in the second half wins.
  assert.equal(clipForTts("Bir cümle burada. İkinci cümle uzun", 25), "Bir cümle burada.");
  assert.equal(clipForTts("Soru mu? Evet ünlem! Sonra devam ediyor", 30), "Soru mu? Evet ünlem!");
  // A sentence end right at the limit (whitespace just after it) counts.
  assert.equal(clipForTts("aaaa bbbb. cccc", 10), "aaaa bbbb.");
  // Sentence end in the first half only: cut at the last word boundary instead.
  assert.equal(clipForTts("Ok. bir iki üç dört beş altı", 20), "Ok. bir iki üç dört");
  // Whitespace right after the limit: the whole head is kept.
  assert.equal(clipForTts("abc def ghi", 7), "abc def");
  // Newlines are word boundaries too.
  assert.equal(clipForTts("abc\ndefghij", 8), "abc");
  // No boundary at all: hard cut, without splitting a surrogate pair.
  assert.equal(clipForTts("x".repeat(30), 10), "x".repeat(10));
  assert.equal(clipForTts("xxxxxxxxx😀yy", 10), "xxxxxxxxx");
});
