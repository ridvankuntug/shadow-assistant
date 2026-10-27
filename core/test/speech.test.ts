import assert from "node:assert/strict";
import { test } from "node:test";
import { PiperTtsClient, SpeechServiceError, WhisperClient, type FetchFn } from "../src/speech.js";

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
