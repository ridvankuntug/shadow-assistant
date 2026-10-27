/**
 * The platform adapter: everything the UI needs from the host (browser or the
 * Android WebView shell). UI components and the assistant controller only
 * talk to this interface — never to getUserMedia, Audio, navigator.vibrate,
 * localStorage or the Android bridge directly.
 *
 * Contract and the Android bridge mapping: docs/03-platform-adapter.md.
 */
import type { ClientKind } from "../protocol/types.ts";

export type DeviceClass = "phone" | "tablet" | "desktop";

export type PlatformErrorCode =
  | "permission_denied" // user or OS refused microphone access
  | "not_supported" // capability missing on this host
  | "busy" // e.g. capture already running / mic in use by another app
  | "not_recording" // stop() without a running capture
  | "capture_aborted" // stop() after the host cut the recording (app/tab went to the background); nothing is sent
  | "playback_failed" // audio could not be decoded or played
  | "timeout" // the host did not answer in time (Android bridge)
  | "cancelled" // the host abandoned a pending request (cancelCapture); not shown to the user
  | "unknown";

export class PlatformError extends Error {
  readonly code: PlatformErrorCode;
  constructor(code: PlatformErrorCode, message?: string) {
    super(message ?? code);
    this.name = "PlatformError";
    this.code = code;
  }
}

export function toPlatformError(err: unknown): PlatformError {
  if (err instanceof PlatformError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new PlatformError("unknown", message);
}

/** One complete push-to-talk utterance, ready for the Core `audio` message. */
export type Utterance = {
  /** Base MIME type without parameters, e.g. "audio/webm". */
  mime: string;
  /** Standard base64 (no data: prefix). */
  data: string;
  durationMs: number;
};

export type AudioClip = { mime: string; data: string };

export interface MicrophoneCapability {
  /** Starts capturing. Rejects with PlatformError (permission_denied, busy, not_supported…). */
  start(): Promise<void>;
  /** Stops and returns the encoded utterance. */
  stop(): Promise<Utterance>;
  /** Stops and discards. Never throws. */
  cancel(): void;
  /** 0..1 input loudness for the visuals; 0 when not capturing. Cheap, called every frame. */
  level(): number;
}

export interface PlaybackCapability {
  /** Plays a clip; resolves when it finishes or is stopped. Rejects with playback_failed. */
  play(clip: AudioClip): Promise<void>;
  /** Stops current playback (resolves the pending play()). Never throws. */
  stop(): void;
  /** 0..1 output loudness for the visuals; 0 when silent. */
  level(): number;
  /** Call from a user gesture so later playback is allowed by autoplay rules. */
  unlock(): void;
}

/**
 * How assistant replies are spoken.
 * - "core": the app sends a Core `speak` message and plays the returned
 *   `speech` clip through `playback` (web).
 * - "native": the host speaks the text itself (Android TextToSpeech).
 */
export type TtsCapability =
  | { mode: "core" }
  | {
      mode: "native";
      /** Resolves when speech ends or is stopped. */
      speak(text: string): Promise<void>;
      stop(): void;
    };

export interface KeyValueStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export interface PlatformAdapter {
  readonly kind: "web" | "android";
  /** Value for the Core `hello.client` field. */
  readonly clientKind: ClientKind;
  readonly mic: MicrophoneCapability;
  readonly playback: PlaybackCapability;
  readonly tts: TtsCapability;
  readonly storage: KeyValueStorage;
  /** Short haptic feedback; silently ignored where unsupported. */
  vibrate(pattern: number[]): void;
  /** Optional system notification; silently ignored where unsupported. */
  notify(title: string, body: string): void;
  deviceClass(): DeviceClass;
  prefersReducedMotion(): boolean;
  isVisible(): boolean;
  /** Subscribes to foreground/background changes. Returns an unsubscribe function. */
  onVisibilityChange(listener: (visible: boolean) => void): () => void;
}

/** Storage keys used by the app (documented for the Android side). */
export const STORAGE_KEYS = {
  coreUrl: "shadow.coreUrl",
  token: "shadow.deviceToken",
  quality: "shadow.quality",
  voiceReplies: "shadow.voiceReplies",
} as const;
