/*
 * Adapted from adewaskar/jarvis (MIT) — Copyright (c) 2026 Aditya Dewaskar — see THIRD_PARTY_NOTICES.md
 *
 * Origin: src/lib/audio.ts (shared mic stream + AnalyserNode loudness metering
 * and the output analyser that lets the reactor pulse while the assistant
 * speaks). Reworked into the web implementation of the PlatformAdapter:
 * push-to-talk capture with MediaRecorder, Web Audio playback of Core
 * `speech` clips, storage and lifecycle. The always-open mic, wake word,
 * VAD and Web Speech parts of the original were not taken.
 */
import { base64ToBytes, baseMime, bytesToBase64 } from "./base64.ts";
import {
  PlatformError,
  type AudioClip,
  type DeviceClass,
  type KeyValueStorage,
  type MicrophoneCapability,
  type PlatformAdapter,
  type PlaybackCapability,
  type Utterance,
} from "./types.ts";

/** Preferred recording formats, best first. whisper-svc decodes all of them. */
const RECORDING_MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

// ---------------------------------------------------------------------------
// Shared AudioContext (one per page; browsers limit how many may exist).

let sharedContext: AudioContext | null = null;

function audioContext(): AudioContext {
  if (typeof AudioContext === "undefined") {
    throw new PlatformError("not_supported", "Web Audio API is not available");
  }
  sharedContext ??= new AudioContext();
  if (sharedContext.state === "suspended") void sharedContext.resume().catch(() => {});
  return sharedContext;
}

/**
 * 0..1 loudness from an analyser. Skips the lowest bins (rumble, mains hum)
 * and stretches the result because voice sits low in the range.
 */
function readLevel(analyser: AnalyserNode | null, buf: Uint8Array<ArrayBuffer> | null, skip: number, gain: number): number {
  if (!analyser || !buf) return 0;
  analyser.getByteFrequencyData(buf);
  let sum = 0;
  for (let i = skip; i < buf.length; i++) sum += buf[i];
  return Math.min(1, (sum / (buf.length - skip) / 255) * gain);
}

function makeAnalyser(ctx: AudioContext, smoothing: number): AnalyserNode {
  const a = ctx.createAnalyser();
  a.fftSize = 512;
  a.smoothingTimeConstant = smoothing;
  return a;
}

// ---------------------------------------------------------------------------
// Microphone: push-to-talk -> one encoded utterance.

function mapGetUserMediaError(err: unknown): PlatformError {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new PlatformError("permission_denied", "Microphone permission denied");
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return new PlatformError("not_supported", "No microphone found");
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return new PlatformError("busy", "Microphone is in use");
  }
  return new PlatformError("unknown", err instanceof Error ? err.message : String(err));
}

function pickRecordingMime(): string | undefined {
  if (typeof MediaRecorder.isTypeSupported !== "function") return undefined;
  return RECORDING_MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
}

type Capture = {
  stream: MediaStream;
  recorder: MediaRecorder;
  chunks: Blob[];
  startedAt: number;
  analyser: AnalyserNode | null;
  source: MediaStreamAudioSourceNode | null;
  buf: Uint8Array<ArrayBuffer> | null;
};

type WebMicrophone = MicrophoneCapability & {
  /**
   * Cuts a running recording without encoding it (the page went to the
   * background). The next stop() rejects with `capture_aborted`.
   */
  abort(): void;
};

/** `pageHidden` is read when a start completes: a page hidden by then does not record. */
function createMicrophone(pageHidden: () => boolean): WebMicrophone {
  let capture: Capture | null = null;
  let starting = false;
  /** The last recording was cut by abort() and its stop() has not been called yet. */
  let aborted = false;

  const release = (c: Capture) => {
    c.source?.disconnect();
    for (const track of c.stream.getTracks()) track.stop();
  };

  /** Stops the recorder and the tracks; the recorded data is dropped. */
  const discard = (c: Capture) => {
    c.recorder.ondataavailable = null;
    c.recorder.onstop = null;
    try {
      if (c.recorder.state !== "inactive") c.recorder.stop();
    } catch {
      // already stopped
    }
    c.chunks.length = 0;
    release(c);
  };

  return {
    async start() {
      if (capture || starting) throw new PlatformError("busy", "Capture already running");
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        // getUserMedia only exists in secure contexts (https or localhost).
        throw new PlatformError("not_supported", "Microphone capture needs https or localhost");
      }
      starting = true;
      aborted = false;
      try {
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          });
        } catch (err) {
          throw mapGetUserMediaError(err);
        }
        const mimeType = pickRecordingMime();
        let recorder: MediaRecorder;
        try {
          recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        } catch (err) {
          for (const track of stream.getTracks()) track.stop();
          throw new PlatformError("not_supported", err instanceof Error ? err.message : "MediaRecorder failed");
        }
        const c: Capture = { stream, recorder, chunks: [], startedAt: performance.now(), analyser: null, source: null, buf: null };
        recorder.ondataavailable = (ev) => {
          if (ev.data.size > 0) c.chunks.push(ev.data);
        };
        try {
          const ctx = audioContext();
          c.source = ctx.createMediaStreamSource(stream);
          c.analyser = makeAnalyser(ctx, 0.75);
          c.source.connect(c.analyser);
          c.buf = new Uint8Array(c.analyser.frequencyBinCount);
        } catch {
          // Metering is cosmetic; recording still works without it.
        }
        if (pageHidden()) {
          // Hidden while the browser was opening the mic: never record in the background.
          release(c);
          throw new PlatformError("capture_aborted", "Page went to the background");
        }
        recorder.start();
        c.startedAt = performance.now();
        capture = c;
      } finally {
        starting = false;
      }
    },

    stop() {
      const c = capture;
      if (!c) {
        const code = aborted ? "capture_aborted" : "not_recording";
        aborted = false;
        return Promise.reject(new PlatformError(code));
      }
      capture = null;
      return new Promise<Utterance>((resolve, reject) => {
        c.recorder.onstop = async () => {
          release(c);
          try {
            const mime = baseMime(c.recorder.mimeType || c.chunks[0]?.type || "audio/webm");
            const blob = new Blob(c.chunks, { type: mime });
            const bytes = new Uint8Array(await blob.arrayBuffer());
            resolve({ mime, data: bytesToBase64(bytes), durationMs: Math.round(performance.now() - c.startedAt) });
          } catch (err) {
            reject(new PlatformError("unknown", err instanceof Error ? err.message : String(err)));
          }
        };
        c.recorder.onerror = () => {
          release(c);
          reject(new PlatformError("unknown", "Recording failed"));
        };
        if (c.recorder.state === "inactive") c.recorder.onstop?.(new Event("stop"));
        else c.recorder.stop();
      });
    },

    cancel() {
      const c = capture;
      capture = null;
      aborted = false;
      if (c) discard(c);
    },

    abort() {
      const c = capture;
      if (!c) return;
      capture = null;
      aborted = true;
      discard(c);
    },

    level() {
      return capture ? readLevel(capture.analyser, capture.buf, 4, 3.2) : 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Playback of Core `speech` clips.

function createPlayback(): PlaybackCapability {
  let current: { source: AudioBufferSourceNode; done: () => void } | null = null;
  let analyser: AnalyserNode | null = null;
  let buf: Uint8Array<ArrayBuffer> | null = null;
  /** Bumped on every play/stop so a slow decode cannot start a stale clip. */
  let generation = 0;

  const stopCurrent = () => {
    const c = current;
    current = null;
    if (!c) return;
    try {
      c.source.stop();
    } catch {
      // not started yet / already ended
    }
    c.done();
  };

  return {
    async play(clip: AudioClip) {
      stopCurrent();
      const mine = ++generation;
      let ctx: AudioContext;
      let audio: AudioBuffer;
      try {
        ctx = audioContext();
        audio = await ctx.decodeAudioData(base64ToBytes(clip.data).buffer);
      } catch (err) {
        throw new PlatformError("playback_failed", err instanceof Error ? err.message : "Audio decode failed");
      }
      if (mine !== generation) return; // stopped or replaced while decoding
      if (!analyser) {
        analyser = makeAnalyser(ctx, 0.7);
        analyser.connect(ctx.destination);
        buf = new Uint8Array(analyser.frequencyBinCount);
      }
      const source = ctx.createBufferSource();
      source.buffer = audio;
      source.connect(analyser);
      await new Promise<void>((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          source.disconnect();
          if (current?.source === source) current = null;
          resolve();
        };
        source.onended = done;
        current = { source, done };
        source.start();
      });
    },

    stop() {
      generation++;
      stopCurrent();
    },

    level() {
      return current ? readLevel(analyser, buf, 2, 3) : 0;
    },

    unlock() {
      try {
        audioContext();
      } catch {
        // not supported; play() reports it
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Storage, device class, lifecycle.

function createStorage(): KeyValueStorage {
  const memory = new Map<string, string>();
  const ls = (): Storage | null => {
    try {
      return window.localStorage;
    } catch {
      return null; // blocked (privacy mode, sandboxed iframe)
    }
  };
  return {
    get(key) {
      try {
        return ls()?.getItem(key) ?? memory.get(key) ?? null;
      } catch {
        return memory.get(key) ?? null;
      }
    },
    set(key, value) {
      memory.set(key, value);
      try {
        ls()?.setItem(key, value);
      } catch {
        // quota / blocked: the in-memory copy keeps this session working
      }
    },
    remove(key) {
      memory.delete(key);
      try {
        ls()?.removeItem(key);
      } catch {
        // ignore
      }
    },
  };
}

/** Pure classification so it can be unit-tested. */
export function classifyDevice(input: { coarsePointer: boolean; shortSidePx: number }): DeviceClass {
  if (!input.coarsePointer) return "desktop";
  if (input.shortSidePx < 600) return "phone";
  if (input.shortSidePx < 1024) return "tablet";
  return "desktop";
}

const matches = (query: string): boolean =>
  typeof window.matchMedia === "function" && window.matchMedia(query).matches;

export function createWebAdapter(): PlatformAdapter {
  const hidden = () => document.visibilityState === "hidden";
  const mic = createMicrophone(hidden);
  // Privacy: a recording never continues in a hidden tab. It is cut here and
  // its audio dropped; the controller learns it from stop() (capture_aborted).
  // Lives as long as the page, like the adapter itself.
  document.addEventListener("visibilitychange", () => {
    if (hidden()) mic.abort();
  });
  return {
    kind: "web",
    clientKind: "web",
    mic,
    playback: createPlayback(),
    tts: { mode: "core" },
    storage: createStorage(),
    vibrate(pattern) {
      if (typeof navigator.vibrate === "function") {
        try {
          navigator.vibrate(pattern);
        } catch {
          // ignore
        }
      }
    },
    notify() {
      // Browser notifications are not used in v1 (the page is in front while talking).
    },
    deviceClass() {
      return classifyDevice({
        coarsePointer: matches("(pointer: coarse)"),
        shortSidePx: Math.min(window.screen?.width ?? window.innerWidth, window.screen?.height ?? window.innerHeight),
      });
    },
    prefersReducedMotion() {
      return matches("(prefers-reduced-motion: reduce)");
    },
    isVisible() {
      return !hidden();
    },
    onVisibilityChange(listener) {
      const handler = () => listener(!hidden());
      document.addEventListener("visibilitychange", handler);
      return () => document.removeEventListener("visibilitychange", handler);
    },
  };
}
