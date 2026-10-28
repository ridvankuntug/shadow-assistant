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

/**
 * tts-svc rejects longer texts with 413 (services/tts-svc `MAX_TEXT_CHARS`).
 * tts-svc counts code points; JS `length` counts UTF-16 units (>= code points),
 * so a text within this many JS chars is always within tts-svc's limit.
 */
export const TTS_MAX_TEXT_CHARS = 2000;

/**
 * Clips text for tts-svc: cuts at the last sentence end (. ! ? … followed by
 * whitespace) if that keeps at least half, otherwise at the last whitespace,
 * otherwise hard at `max`. Shorter texts are returned unchanged. Needed because
 * the Core accepts longer `speak` texts (MAX_TEXT_CHARS) and the pronunciation
 * lexicon can lengthen a text that the client had already clipped.
 */
export function clipForTts(text: string, max = TTS_MAX_TEXT_CHARS): string {
  if (text.length <= max) return text;
  // One char of lookahead so a boundary right at `max` still counts.
  const window = text.slice(0, max + 1);
  let sentenceEnd = -1;
  for (const m of window.matchAll(/[.!?…](?=\s)/g)) sentenceEnd = m.index;
  if (sentenceEnd >= 0 && sentenceEnd + 1 > max * 0.5) return text.slice(0, sentenceEnd + 1);
  const head = text.slice(0, max);
  if (/\s/.test(text.charAt(max))) return head.trimEnd();
  const space = head.search(/\s\S*$/);
  if (space > 0) return head.slice(0, space).trimEnd();
  // No boundary at all: hard cut, never leaving half of a surrogate pair.
  return /[\uD800-\uDBFF]$/.test(head) ? head.slice(0, -1) : head;
}

export interface Transcription {
  text: string;
  language?: string;
  durationMs?: number;
}

export interface SttClient {
  transcribe(audio: Buffer, mime: string, signal?: AbortSignal): Promise<Transcription>;
}

/** Voices tts-svc can speak with, from its `/health`. */
export interface TtsVoiceCatalog {
  /** tts-svc's default voice id. */
  default: string;
  /** Selectable voice ids (loaded + downloadable), default first, no duplicates. */
  voices: string[];
}

export interface TtsClient {
  /**
   * `voice` is a voice id from `voices()`; an unknown or absent id uses the
   * default voice (never an error).
   */
  synthesize(text: string, signal?: AbortSignal, voice?: string): Promise<{ mime: string; data: Buffer }>;
  /** The voice list; fails with `tts_unavailable` when tts-svc is not ready. */
  voices(): Promise<TtsVoiceCatalog>;
}

/** How long a fetched voice list is reused (the list only changes when tts-svc is reconfigured). */
export const VOICE_CACHE_MS = 30_000;
/** Upper bound for the `/health` request behind the voice list. */
export const VOICE_LIST_TIMEOUT_MS = 5_000;
/** Same shape tts-svc accepts (`<lang>-<name>-<quality>`); anything else is dropped from its list. */
const VOICE_ID_RE = /^[A-Za-z0-9_]+-[A-Za-z0-9_]+-[A-Za-z0-9_]+$/;
const MAX_VOICES = 200;

const QUALITY_TR: Record<string, string> = {
  x_low: "çok düşük kalite",
  low: "düşük kalite",
  medium: "orta kalite",
  high: "yüksek kalite",
};
/** Speaker names that are not plain given names. */
const NAME_LABELS: Record<string, string> = { dfki: "DFKI" };

/** Human-readable (Turkish) description of a Piper voice id such as `tr_TR-fahrettin-medium`. */
export function describeVoice(voiceId: string): { id: string; label: string; quality?: string } {
  const parts = voiceId.split("-");
  if (parts.length !== 3 || !VOICE_ID_RE.test(voiceId)) return { id: voiceId, label: voiceId };
  const [lang, name, quality] = parts as [string, string, string];
  const speaker =
    NAME_LABELS[name.toLowerCase()] ??
    name
      .split("_")
      .map((w) => w.charAt(0).toLocaleUpperCase("tr-TR") + w.slice(1))
      .join(" ");
  const details = [QUALITY_TR[quality] ?? quality.replace(/_/g, " ")];
  if (!lang.toLowerCase().startsWith("tr")) details.unshift(lang);
  return { id: voiceId, label: `${speaker} (${details.join(", ")})`, quality };
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
  private cached: { at: number; catalog: TtsVoiceCatalog } | undefined;
  private pending: Promise<TtsVoiceCatalog> | undefined;

  constructor(
    private readonly baseUrl: string | undefined,
    private readonly timeoutMs = 30_000,
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Voice list from tts-svc's `/health` (`available`, or `voices` from a
   * tts-svc without on-demand loading), cached for VOICE_CACHE_MS. Concurrent
   * callers share one request; failures are not cached.
   */
  voices(): Promise<TtsVoiceCatalog> {
    if (this.cached && this.now() - this.cached.at < VOICE_CACHE_MS) return Promise.resolve(this.cached.catalog);
    this.pending ??= this.fetchVoices()
      .then((catalog) => {
        this.cached = { at: this.now(), catalog };
        return catalog;
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private async fetchVoices(): Promise<TtsVoiceCatalog> {
    if (!this.baseUrl) throw new SpeechServiceError("tts_unavailable", "tts-svc is not configured");
    let body: unknown;
    try {
      // Own timeout, no caller signal: the request is shared between callers.
      const res = await this.fetchFn(`${this.baseUrl}/health`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, VOICE_LIST_TIMEOUT_MS)),
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new SpeechServiceError("tts_unavailable", `tts-svc is not ready (${res.status})`);
      }
      body = await res.json();
    } catch (err) {
      if (err instanceof SpeechServiceError) throw err;
      throw new SpeechServiceError("tts_unavailable", `tts-svc: ${describe(err)}`);
    }
    const b = (typeof body === "object" && body !== null ? body : {}) as {
      status?: unknown;
      voice?: unknown;
      voices?: unknown;
      available?: unknown;
    };
    if (b.status !== "ok" || typeof b.voice !== "string" || !VOICE_ID_RE.test(b.voice)) {
      throw new SpeechServiceError("tts_unavailable", "tts-svc returned no usable voice list");
    }
    const listed = Array.isArray(b.available) ? b.available : Array.isArray(b.voices) ? b.voices : [];
    const ids = [b.voice, ...listed].filter((v): v is string => typeof v === "string" && VOICE_ID_RE.test(v));
    return { default: b.voice, voices: [...new Set(ids)].slice(0, MAX_VOICES) };
  }

  /** `voice` if tts-svc lists it; otherwise undefined (= tts-svc's default voice). */
  private async resolveVoice(voice: string | undefined): Promise<string | undefined> {
    if (!voice) return undefined;
    try {
      return (await this.voices()).voices.includes(voice) ? voice : undefined;
    } catch {
      return undefined; // list unavailable: speak with the default rather than fail here
    }
  }

  async synthesize(text: string, signal?: AbortSignal, voice?: string): Promise<{ mime: string; data: Buffer }> {
    if (!this.baseUrl) throw new SpeechServiceError("tts_unavailable", "tts-svc is not configured");
    const selected = await this.resolveVoice(voice);
    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl}/synthesize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selected ? { text, voice: selected } : { text }),
        signal: withTimeout(this.timeoutMs, signal),
      });
    } catch (err) {
      throw new SpeechServiceError("tts_unavailable", `tts-svc: ${describe(err)}`);
    }
    if (res.status === 400 || res.status === 413) {
      throw new SpeechServiceError("bad_request", `tts-svc rejected the text (${res.status})`);
    }
    if (res.status === 503 && selected) {
      // A selected voice that is not loaded yet is fetched by tts-svc on first use;
      // it answers 503 voice_loading if that takes longer than its wait limit.
      const error = await res
        .json()
        .then((j: unknown) => (typeof j === "object" && j !== null ? (j as { error?: unknown }).error : undefined))
        .catch(() => undefined);
      if (error === "voice_loading") {
        throw new SpeechServiceError("tts_unavailable", `tts-svc is still loading voice ${selected}; try again shortly`);
      }
      if (error === "voice_unavailable") {
        throw new SpeechServiceError("tts_unavailable", `tts-svc could not load voice ${selected}`);
      }
      throw new SpeechServiceError("tts_unavailable", "tts-svc returned 503");
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
