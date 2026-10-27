/**
 * Android adapter: a thin wrapper around the `window.ShadowAndroid` object that
 * the Kotlin shell (T6) injects with `addJavascriptInterface`. All bridge
 * methods take and return strings/numbers only; long-running operations
 * answer asynchronously through `window.__shadowAndroidCallback(requestId, json)`
 * and the shell pushes events through `window.__shadowAndroidEvent(name, json)`.
 *
 * The exact contract is in docs/03-platform-adapter.md — keep both in sync.
 */
import {
  PlatformError,
  type DeviceClass,
  type PlatformAdapter,
  type PlatformErrorCode,
  type Utterance,
} from "./types.ts";

export const ANDROID_BRIDGE_VERSION = 1;

/** The object injected by Kotlin (`@JavascriptInterface` methods). */
export interface ShadowAndroidBridge {
  getInfo(): string;
  startCapture(requestId: string): void;
  stopCapture(requestId: string): void;
  cancelCapture(): void;
  getInputLevel(): number;
  playAudio(requestId: string, mime: string, base64: string): void;
  stopAudio(): void;
  getOutputLevel(): number;
  speak(requestId: string, text: string): void;
  stopSpeaking(): void;
  vibrate(patternJson: string): void;
  notify(title: string, body: string): void;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type AndroidInfo = {
  bridgeVersion: number;
  appVersion?: string;
  deviceClass?: DeviceClass;
  reducedMotion?: boolean;
};

type CallbackPayload =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error?: { code?: string; message?: string } };

export type AndroidWindow = {
  ShadowAndroid?: unknown;
  __shadowAndroidCallback?: (requestId: string, payload: string | object) => void;
  __shadowAndroidEvent?: (name: string, payload?: string | object) => void;
  document?: { visibilityState?: string; addEventListener?: Document["addEventListener"]; removeEventListener?: Document["removeEventListener"] };
  matchMedia?: (q: string) => { matches: boolean };
};

const REQUIRED_METHODS: (keyof ShadowAndroidBridge)[] = [
  "getInfo",
  "startCapture",
  "stopCapture",
  "cancelCapture",
  "playAudio",
  "stopAudio",
  "speak",
  "stopSpeaking",
  "getItem",
  "setItem",
  "removeItem",
];

/** Timeout for bridge calls that should answer quickly (capture start/stop). */
export const BRIDGE_CALL_TIMEOUT_MS = 15_000;

const KNOWN_CODES: PlatformErrorCode[] = [
  "permission_denied",
  "not_supported",
  "busy",
  "not_recording",
  "capture_aborted",
  "playback_failed",
  "timeout",
  "cancelled",
  "unknown",
];

export function isAndroidBridge(value: unknown): value is ShadowAndroidBridge {
  if (typeof value !== "object" || value === null) return false;
  const o = value as Record<string, unknown>;
  return REQUIRED_METHODS.every((m) => typeof o[m] === "function");
}

/** Parses getInfo(); throws if the bridge speaks an incompatible version. */
export function parseAndroidInfo(raw: unknown): AndroidInfo {
  const info = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  if (typeof info !== "object" || info === null) throw new Error("getInfo returned no object");
  const o = info as Record<string, unknown>;
  if (o.bridgeVersion !== ANDROID_BRIDGE_VERSION) {
    throw new Error(`Unsupported ShadowAndroid bridgeVersion ${String(o.bridgeVersion)}`);
  }
  const deviceClass = ["phone", "tablet", "desktop"].includes(o.deviceClass as string)
    ? (o.deviceClass as DeviceClass)
    : undefined;
  return {
    bridgeVersion: ANDROID_BRIDGE_VERSION,
    appVersion: typeof o.appVersion === "string" ? o.appVersion : undefined,
    deviceClass,
    reducedMotion: typeof o.reducedMotion === "boolean" ? o.reducedMotion : undefined,
  };
}

function toError(payload: CallbackPayload): PlatformError {
  const e = payload.ok ? undefined : payload.error;
  const code = KNOWN_CODES.includes(e?.code as PlatformErrorCode) ? (e?.code as PlatformErrorCode) : "unknown";
  return new PlatformError(code, e?.message);
}

export function createAndroidAdapter(win: AndroidWindow, timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = globalThis): PlatformAdapter {
  const bridge = win.ShadowAndroid;
  if (!isAndroidBridge(bridge)) throw new Error("window.ShadowAndroid is missing required methods");
  const info = parseAndroidInfo(bridge.getInfo());

  // --- async request/response plumbing ------------------------------------
  let seq = 0;
  const pending = new Map<string, { resolve: (p: CallbackPayload) => void; timer: ReturnType<typeof setTimeout> | null }>();

  win.__shadowAndroidCallback = (requestId, payload) => {
    const entry = pending.get(requestId);
    if (!entry) return; // late answer after a timeout, or unknown id
    pending.delete(requestId);
    if (entry.timer !== null) timers.clearTimeout(entry.timer);
    let parsed: CallbackPayload;
    try {
      parsed = (typeof payload === "string" ? JSON.parse(payload) : payload) as CallbackPayload;
    } catch {
      parsed = { ok: false, error: { code: "unknown", message: "Invalid callback JSON" } };
    }
    entry.resolve(parsed && typeof parsed === "object" ? parsed : { ok: false });
  };

  /** Calls a bridge method with a fresh requestId and waits for its callback. */
  const request = (invoke: (requestId: string) => void, timeoutMs: number | null): Promise<CallbackPayload> =>
    new Promise((resolve) => {
      const requestId = `a${++seq}`;
      const timer =
        timeoutMs === null
          ? null
          : timers.setTimeout(() => {
              pending.delete(requestId);
              resolve({ ok: false, error: { code: "timeout", message: "ShadowAndroid did not answer" } });
            }, timeoutMs);
      pending.set(requestId, { resolve, timer });
      try {
        invoke(requestId);
      } catch (err) {
        pending.delete(requestId);
        if (timer !== null) timers.clearTimeout(timer);
        resolve({ ok: false, error: { code: "unknown", message: err instanceof Error ? err.message : String(err) } });
      }
    });

  // --- lifecycle events from the shell -------------------------------------
  let nativeVisible = true;
  const visibilityListeners = new Set<(visible: boolean) => void>();
  const docVisible = () => win.document?.visibilityState !== "hidden";
  const visible = () => nativeVisible && docVisible();
  const emitVisibility = () => {
    const v = visible();
    for (const l of visibilityListeners) l(v);
  };

  win.__shadowAndroidEvent = (name, payload) => {
    let data: Record<string, unknown>;
    try {
      data = (typeof payload === "string" ? JSON.parse(payload) : payload ?? {}) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof data !== "object" || data === null) return;
    if (name === "visibility" && typeof data.visible === "boolean") {
      nativeVisible = data.visible;
      emitVisibility();
    }
  };

  const cancelCapture = () => {
    try {
      bridge.cancelCapture();
    } catch {
      // ignore
    }
  };

  const safeNumber = (fn: () => number): number => {
    try {
      const n = Number(fn());
      return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
    } catch {
      return 0;
    }
  };

  return {
    kind: "android",
    clientKind: "android",
    mic: {
      async start() {
        const res = await request((id) => bridge.startCapture(id), BRIDGE_CALL_TIMEOUT_MS);
        // A timed-out start may still succeed later on the native side (e.g. a
        // slow permission dialog); make sure the mic does not stay open.
        if (!res.ok && res.error?.code === "timeout") cancelCapture();
        if (!res.ok) throw toError(res);
      },
      async stop(): Promise<Utterance> {
        const res = await request((id) => bridge.stopCapture(id), BRIDGE_CALL_TIMEOUT_MS);
        if (!res.ok && res.error?.code === "timeout") cancelCapture();
        if (!res.ok) throw toError(res);
        if (typeof res.mime !== "string" || typeof res.data !== "string") {
          throw new PlatformError("unknown", "stopCapture returned no audio");
        }
        return { mime: res.mime, data: res.data, durationMs: typeof res.durationMs === "number" ? res.durationMs : 0 };
      },
      cancel: cancelCapture,
      level: () => (typeof bridge.getInputLevel === "function" ? safeNumber(() => bridge.getInputLevel()) : 0),
    },
    playback: {
      async play(clip) {
        // No timeout: a clip may legitimately play for a long time.
        const res = await request((id) => bridge.playAudio(id, clip.mime, clip.data), null);
        if (!res.ok) throw toError(res);
      },
      stop() {
        try {
          bridge.stopAudio();
        } catch {
          // ignore
        }
      },
      level: () => (typeof bridge.getOutputLevel === "function" ? safeNumber(() => bridge.getOutputLevel()) : 0),
      unlock() {
        // Native playback has no autoplay restriction.
      },
    },
    tts: {
      mode: "native",
      async speak(text) {
        const res = await request((id) => bridge.speak(id, text), null);
        if (!res.ok) throw toError(res);
      },
      stop() {
        try {
          bridge.stopSpeaking();
        } catch {
          // ignore
        }
      },
    },
    storage: {
      get(key) {
        try {
          const v = bridge.getItem(key);
          return typeof v === "string" ? v : null;
        } catch {
          return null;
        }
      },
      set(key, value) {
        try {
          bridge.setItem(key, value);
        } catch {
          // ignore
        }
      },
      remove(key) {
        try {
          bridge.removeItem(key);
        } catch {
          // ignore
        }
      },
    },
    vibrate(pattern) {
      try {
        bridge.vibrate?.(JSON.stringify(pattern));
      } catch {
        // ignore
      }
    },
    notify(title, body) {
      try {
        bridge.notify?.(title, body);
      } catch {
        // ignore
      }
    },
    deviceClass: () => info.deviceClass ?? "phone",
    prefersReducedMotion: () =>
      info.reducedMotion ?? (typeof win.matchMedia === "function" && win.matchMedia("(prefers-reduced-motion: reduce)").matches),
    isVisible: visible,
    onVisibilityChange(listener) {
      visibilityListeners.add(listener);
      const onDoc = () => listener(visible());
      win.document?.addEventListener?.("visibilitychange", onDoc);
      return () => {
        visibilityListeners.delete(listener);
        win.document?.removeEventListener?.("visibilitychange", onDoc);
      };
    },
  };
}
