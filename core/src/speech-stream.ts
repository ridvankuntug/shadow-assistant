/**
 * Per-turn speech stream (docs/07-speed.md A2, S9): turns the answer's text
 * deltas into ordered `speech_chunk` frames for a client that opted in with
 * `speech_prefs`.
 *
 *   delta → SentenceSplitter → lexicon.apply → clipForTts →
 *     audio mode: tts.synthesize(text, signal, voice) → {mime, data(base64)}
 *     text mode:  the text itself (Android native TTS)
 *
 * - Synthesis is sequential with one chunk of lookahead: at most two chunks
 *   are synthesized or waiting to be sent at any time, so at most two tts-svc
 *   requests are in flight. Frames are sent strictly in `seq` order; `seq`
 *   starts at 0 and has no gaps.
 * - `end()` marks the end of the answer. The last content frame carries
 *   `final: true` when it is still unsent at that point; otherwise a separate
 *   `{final: true}` marker without data/text is sent. An empty answer sends
 *   nothing at all.
 * - A synthesis failure calls `onError` once (the session sends
 *   `error tts_unavailable` with the turn id), stops synthesis for the turn
 *   and sends `{seq: n, final: true}`. Later deltas are ignored.
 * - `cancel()` or an aborted signal stops everything: running requests are
 *   aborted and no further frame is sent (no `final` either).
 *
 * The lexicon is applied only to what is spoken (07: displayed text is
 * unchanged); this module never logs chunk text.
 *
 * Wiring into Session (speech_prefs, feeding from the live text path,
 * firstSpeechMs in the timing log) is task S10.
 */
import type { Lexicon } from "./pronunciation.js";
import { SentenceSplitter, type SentenceSplitterOptions } from "./sentence-splitter.js";
import { clipForTts, SpeechServiceError, TTS_MAX_TEXT_CHARS, type TtsClient } from "./speech.js";

export type SpeechMode = "audio" | "text";

/**
 * Server frame `speech_chunk`. Defined here until P1 adds it to protocol.ts;
 * the shapes are the ones in 07 §Protocol.
 */
export type SpeechChunkFrame =
  | { type: "speech_chunk"; id: string; seq: number; final: boolean; mime: string; data: string }
  | { type: "speech_chunk"; id: string; seq: number; final: boolean; text: string }
  | { type: "speech_chunk"; id: string; seq: number; final: true };

export interface SpeechStreamOptions {
  /** Turn id, copied into every frame. */
  turnId: string;
  mode: SpeechMode;
  /** Voice id for tts-svc (audio mode); absent/unknown = default voice. */
  voice?: string;
  /** Required in audio mode. */
  tts?: TtsClient;
  /** Pronunciation lexicon (pronunciation.ts), applied in both modes. */
  lexicon: Pick<Lexicon, "apply">;
  /** Sends one frame to the client. A throwing send cancels the stream. */
  send: (frame: SpeechChunkFrame) => void;
  /** Called at most once, when synthesis fails (never after a cancel). */
  onError?: (error: SpeechServiceError) => void;
  /** The turn's abort signal and the session's side signal; any of them cancels. */
  signals?: readonly AbortSignal[];
  splitter?: SentenceSplitterOptions;
  /** Text limit per chunk for tts-svc; default TTS_MAX_TEXT_CHARS. */
  maxTextChars?: number;
  now?: () => number;
}

type Outcome = { ok: true; frame: { mime: string; data: string } | { text: string } } | { ok: false; error: unknown };

interface Task {
  /** Text to speak (lexicon applied, clipped). */
  text: string;
  /** Set once synthesis started. */
  result?: Promise<Outcome>;
}

export class SpeechStream {
  private readonly splitter: SentenceSplitter;
  private readonly abort = new AbortController();
  private readonly now: () => number;
  /** Chunks not yet sent, in order; the first two are being synthesized. */
  private readonly queue: Task[] = [];
  private seq = 0;
  private ended = false;
  private stopped = false; // cancelled, failed or finished: no more frames
  private pumping = false;
  private finished!: () => void;
  private firstAt: number | undefined;
  /** Resolves when the stream is finished, failed or cancelled. Never rejects. */
  readonly done: Promise<void>;

  constructor(private readonly options: SpeechStreamOptions) {
    if (options.mode === "audio" && !options.tts) throw new Error("SpeechStream: audio mode needs a TTS client");
    this.splitter = new SentenceSplitter(options.splitter);
    this.now = options.now ?? Date.now;
    this.done = new Promise<void>((resolve) => (this.finished = resolve));
    for (const s of options.signals ?? []) {
      if (s.aborted) this.cancel();
      else s.addEventListener("abort", () => this.cancel(), { once: true });
    }
  }

  /** Time (from `now`) the first content frame was sent; for `firstSpeechMs`. */
  get firstChunkAt(): number | undefined {
    return this.firstAt;
  }

  /** Number of frames sent so far. */
  get sentFrames(): number {
    return this.seq;
  }

  /** Feeds an answer delta. Ignored after end/cancel/failure. */
  push(delta: string): void {
    if (this.ended || this.stopped) return;
    for (const chunk of this.splitter.push(delta)) this.enqueue(chunk);
    this.pump();
  }

  /** End of the answer: flushes the splitter; resolves when the last frame is sent. */
  end(): Promise<void> {
    if (!this.ended && !this.stopped) {
      for (const chunk of this.splitter.flush()) this.enqueue(chunk);
      this.ended = true;
      this.pump();
    }
    this.ended = true;
    return this.done;
  }

  /** Stops the turn's speech: aborts synthesis, sends nothing more. Idempotent. */
  cancel(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.queue.length = 0;
    this.abort.abort();
    this.finished();
  }

  private enqueue(chunk: string): void {
    const spoken = clipForTts(this.options.lexicon.apply(chunk), this.options.maxTextChars ?? TTS_MAX_TEXT_CHARS);
    if (spoken.trim() === "") return;
    this.queue.push({ text: spoken });
  }

  /** Starts synthesis for the first two queued chunks (one of lookahead). */
  private startLookahead(): void {
    for (const task of this.queue.slice(0, 2)) task.result ??= this.synthesize(task.text);
  }

  private async synthesize(text: string): Promise<Outcome> {
    if (this.options.mode === "text") return { ok: true, frame: { text } };
    try {
      const audio = await this.options.tts!.synthesize(text, this.abort.signal, this.options.voice);
      return { ok: true, frame: { mime: audio.mime, data: audio.data.toString("base64") } };
    } catch (error) {
      return { ok: false, error };
    }
  }

  /** Sends finished chunks in order; one loop at a time. */
  private pump(): void {
    if (this.stopped) return;
    // Even while the loop awaits the head, a newly queued second chunk starts
    // synthesizing now (the head stays in queue[0] until sent, so the 2-chunk
    // cap holds); sending stays in seq order because only the loop sends.
    this.startLookahead();
    if (this.pumping) return;
    this.pumping = true;
    this.drain().catch(() => this.cancel()); // not expected; never leave the turn hanging
  }

  /**
   * The send loop. `pumping` is cleared in this function's own `finally`, i.e.
   * in the same tick as the loop's last step: a `push` right after the loop
   * decided to stop then starts a new loop instead of finding it "running".
   */
  private async drain(): Promise<void> {
    try {
      for (;;) {
        if (this.stopped) return;
        this.startLookahead();
        const head = this.queue[0];
        if (!head) {
          if (this.ended) this.finish();
          return;
        }
        const outcome = await head.result!;
        if (this.stopped) return;
        this.queue.shift();
        if (!outcome.ok) {
          this.fail(outcome.error);
          return;
        }
        // `final` on the content frame when the answer has ended and nothing follows.
        const last = this.ended && this.queue.length === 0;
        const frame = { type: "speech_chunk", id: this.options.turnId, seq: this.seq, final: last, ...outcome.frame } as const;
        if (!this.sendFrame(frame)) return;
        if (this.firstAt === undefined) this.firstAt = this.now();
        if (last) {
          this.stopAndResolve();
          return;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** End reached with nothing pending: a bare final marker, unless nothing was ever sent. */
  private finish(): void {
    if (this.seq > 0) this.sendFrame({ type: "speech_chunk", id: this.options.turnId, seq: this.seq, final: true });
    this.stopAndResolve();
  }

  private fail(error: unknown): void {
    const err =
      error instanceof SpeechServiceError && error.code === "tts_unavailable"
        ? error
        : new SpeechServiceError(
            "tts_unavailable",
            error instanceof Error ? `speech synthesis failed: ${error.message}` : "speech synthesis failed",
          );
    // Stop the lookahead request; it cannot be sent anyway.
    this.queue.length = 0;
    this.abort.abort();
    try {
      this.options.onError?.(err);
    } catch {
      // the session's error path must not break the final frame
    }
    this.sendFrame({ type: "speech_chunk", id: this.options.turnId, seq: this.seq, final: true });
    this.stopAndResolve();
  }

  /** Sends a frame and advances seq; a throwing send cancels the stream. */
  private sendFrame(frame: SpeechChunkFrame): boolean {
    try {
      this.options.send(frame);
    } catch {
      this.cancel();
      return false;
    }
    this.seq++;
    return true;
  }

  private stopAndResolve(): void {
    this.stopped = true;
    this.finished();
  }
}
