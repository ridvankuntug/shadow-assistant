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
  | "capture_aborted" // stop() after the host cut the recording (Android app went to the background); nothing is sent
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

/** Speech synthesized on the device (Android TextToSpeech). */
export interface NativeSpeech {
  /** Resolves when speech ends or is stopped. Rejects when it cannot speak. */
  speak(text: string): Promise<void>;
  /** Stops current speech (resolves the pending speak()). Never throws. */
  stop(): void;
}

/**
 * How assistant replies are spoken. There is a single voice: the Core
 * synthesizes all speech (tts-svc) — streamed `speech_chunk` clips or a
 * `speak` → `speech` clip — and the app plays it through `playback`.
 * `fallback` (Android only) speaks the reply on the device when the Core
 * cannot produce audio (`error` for the turn's speech, e.g. `tts_unavailable`).
 */
export type TtsCapability = {
  mode: "core";
  fallback?: NativeSpeech;
};

export interface KeyValueStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/** An inbox item shown as a system notification (`PlatformAdapter.notify`). */
export type NotifyItem = { id: string; urgent: boolean };

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
  /**
   * Optional system notification; silently ignored where unsupported. Without
   * `item` it is a confirmation request (one high-importance notification
   * that the next request replaces). With `item` it is an inbox item: its own
   * system notification per `item.id` (raising the item again replaces it), on
   * a quiet channel or, `urgent`, a high-importance one. Dismissing it never
   * changes the item.
   */
  notify(title: string, body: string, item?: NotifyItem): void;
  deviceClass(): DeviceClass;
  prefersReducedMotion(): boolean;
  isVisible(): boolean;
  /** Subscribes to foreground/background changes. Returns an unsubscribe function. */
  onVisibilityChange(listener: (visible: boolean) => void): () => void;
  /**
   * Hand-off to Google's Gemini (the app, else its web page), a target the
   * host picks. Present only on hosts that can do it (Android shells from T15
   * on); absent in the browser, where the top bar shows no Gemini button.
   */
  readonly gemini?: GeminiHandoff;
  /** The installed app (Android shell); absent in the browser (T16.2). */
  readonly app?: AppInfo;
}

export interface GeminiHandoff {
  /**
   * Whether a target exists right now. Asked at start and again each time the
   * app comes back to the foreground (Gemini may have been installed or
   * removed meanwhile, T16.3). Never throws.
   */
  available(): boolean;
  /** Opens the fixed target the host picks. Never throws. */
  open(): void;
  /** The host could not start any target (T16.3). Returns an unsubscribe function. */
  onFailed(listener: () => void): () => void;
}

/** The installed Android app as the shell reports it (T16.2). */
export type AppInfo = {
  /** versionName, e.g. "0.1.57"; absent when the shell does not say. */
  versionName?: string;
  /** versionCode, e.g. 57; absent on shells before T16.2. */
  versionCode?: number;
  /** Opens the shell's update check (Android shells from T16.2 on); absent = not offered here. */
  openUpdates?: () => void;
};

/** Storage keys used by the app (documented for the Android side). */
export const STORAGE_KEYS = {
  coreUrl: "shadow.coreUrl",
  token: "shadow.deviceToken",
  quality: "shadow.quality",
  voiceReplies: "shadow.voiceReplies",
  /** tts-svc voice id for Core speech (`speak`, `speech_prefs`); absent = the Core's default. */
  ttsVoice: "shadow.ttsVoice",
  /**
   * Inbox items already shown as a system notification on this device, as
   * JSON `{ "<item id>": <raised> }`: each raise of an item is shown once
   * (docs/08 §T7.w.5 Delivery, catch-up on connect).
   */
  notificationsShown: "shadow.notificationsShown",
} as const;
