/**
 * HTTP clients for whisper-svc (speech-to-text) and tts-svc (text-to-speech).
 * Contracts: docs/02-core-protocol.md and the services' own READMEs.
 * Any failure (service down, timeout, non-2xx) becomes a SpeechServiceError
 * whose `code` maps 1:1 to the WebSocket error code.
 */

export class SpeechServiceError extends Error {
  constructor(
    readonly code: "stt_unavailable" | "tts_unavailable" | "bad_request",
    message: string,
  ) {
    super(message);
    this.name = "SpeechServiceError";
  }
}

export type FetchFn = typeof fetch;

export interface Transcription {
  text: string;
  language?: string;
  durationMs?: number;
}

export interface SttClient {
  transcribe(audio: Buffer, mime: string, signal?: AbortSignal): Promise<Transcription>;
}

export interface TtsClient {
  synthesize(text: string, signal?: AbortSignal): Promise<{ mime: string; data: Buffer }>;
}

function withTimeout(ms: number, outer?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return outer ? AbortSignal.any([t, outer]) : t;
}

function describe(err: unknown): string {
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) return "timed out or aborted";
  return "service unreachable";
}

export class WhisperClient implements SttClient {
  constructor(
    private readonly baseUrl: string | undefined,
    private readonly timeoutMs = 60_000,
    private readonly language = "tr",
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async transcribe(audio: Buffer, mime: string, signal?: AbortSignal): Promise<Transcription> {
    if (!this.baseUrl) throw new SpeechServiceError("stt_unavailable", "whisper-svc is not configured");
    const url = `${this.baseUrl}/transcribe?language=${encodeURIComponent(this.language)}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": mime.split(";")[0] ?? mime },
        body: new Uint8Array(audio),
        signal: withTimeout(this.timeoutMs, signal),
      });
    } catch (err) {
      throw new SpeechServiceError("stt_unavailable", `whisper-svc: ${describe(err)}`);
    }
    if (res.status === 400 || res.status === 413) {
      throw new SpeechServiceError("bad_request", `whisper-svc rejected the audio (${res.status})`);
    }
    if (!res.ok) throw new SpeechServiceError("stt_unavailable", `whisper-svc returned ${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new SpeechServiceError("stt_unavailable", "whisper-svc returned invalid JSON");
    }
    const b = body as { text?: unknown; language?: unknown; duration_ms?: unknown };
    if (typeof b.text !== "string") throw new SpeechServiceError("stt_unavailable", "whisper-svc response has no text");
    return {
      text: b.text.trim(),
      language: typeof b.language === "string" ? b.language : undefined,
      durationMs: typeof b.duration_ms === "number" ? b.duration_ms : undefined,
    };
  }
}

export class PiperTtsClient implements TtsClient {
  constructor(
    private readonly baseUrl: string | undefined,
    private readonly timeoutMs = 30_000,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  async synthesize(text: string, signal?: AbortSignal): Promise<{ mime: string; data: Buffer }> {
    if (!this.baseUrl) throw new SpeechServiceError("tts_unavailable", "tts-svc is not configured");
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: withTimeout(this.timeoutMs, signal),
      });
    } catch (err) {
      throw new SpeechServiceError("tts_unavailable", `tts-svc: ${describe(err)}`);
    }
    if (res.status === 400 || res.status === 413) {
      throw new SpeechServiceError("bad_request", `tts-svc rejected the text (${res.status})`);
    }
    if (!res.ok) throw new SpeechServiceError("tts_unavailable", `tts-svc returned ${res.status}`);
    try {
      const data = Buffer.from(await res.arrayBuffer());
      const mime = (res.headers.get("content-type") ?? "audio/wav").split(";")[0]?.trim() || "audio/wav";
      return { mime, data };
    } catch (err) {
      throw new SpeechServiceError("tts_unavailable", `tts-svc: ${describe(err)}`);
    }
  }
}
