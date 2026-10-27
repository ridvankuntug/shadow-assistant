import { describe, expect, it, vi } from "vitest";
import { defaultQuality, resolveQuality } from "../scene/quality.ts";
import { BRIDGE_CALL_TIMEOUT_MS, createAndroidAdapter, type AndroidWindow, type ShadowAndroidBridge } from "./android.ts";
import { base64ToBytes, baseMime, bytesToBase64 } from "./base64.ts";
import { selectAdapter } from "./select.ts";
import type { PlatformAdapter } from "./types.ts";
import { classifyDevice } from "./web.ts";

const webStub = { kind: "web" } as PlatformAdapter;

function fakeBridge(overrides: Partial<ShadowAndroidBridge> = {}): ShadowAndroidBridge {
  return {
    getInfo: () => JSON.stringify({ bridgeVersion: 1, appVersion: "1.0", deviceClass: "phone" }),
    startCapture: vi.fn(),
    stopCapture: vi.fn(),
    cancelCapture: vi.fn(),
    getInputLevel: () => 0.5,
    playAudio: vi.fn(),
    stopAudio: vi.fn(),
    getOutputLevel: () => 2, // out of range: must be clamped
    speak: vi.fn(),
    stopSpeaking: vi.fn(),
    vibrate: vi.fn(),
    notify: vi.fn(),
    getItem: vi.fn(() => null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    ...overrides,
  };
}

describe("selectAdapter", () => {
  it("uses the web adapter when there is no bridge", () => {
    const choice = selectAdapter({}, { web: () => webStub });
    expect(choice.reason).toBe("no-bridge");
    expect(choice.adapter).toBe(webStub);
  });

  it("uses the Android adapter when window.ShadowAndroid is complete", () => {
    const choice = selectAdapter({ ShadowAndroid: fakeBridge() }, { web: () => webStub });
    expect(choice.reason).toBe("android-bridge");
    expect(choice.adapter.kind).toBe("android");
    expect(choice.adapter.clientKind).toBe("android");
    expect(choice.adapter.tts.mode).toBe("native");
  });

  it("falls back to web for an incomplete bridge", () => {
    const choice = selectAdapter({ ShadowAndroid: { getInfo: () => "{}" } }, { web: () => webStub });
    expect(choice.reason).toBe("bridge-invalid");
  });

  it("falls back to web for an incompatible bridge version", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bridge = fakeBridge({ getInfo: () => JSON.stringify({ bridgeVersion: 99 }) });
    const choice = selectAdapter({ ShadowAndroid: bridge }, { web: () => webStub });
    expect(choice.reason).toBe("bridge-invalid");
    warn.mockRestore();
  });
});

describe("Android adapter", () => {
  it("resolves async calls through window.__shadowAndroidCallback", async () => {
    const win: AndroidWindow = { ShadowAndroid: fakeBridge() };
    const adapter = createAndroidAdapter(win);
    const bridge = win.ShadowAndroid as ShadowAndroidBridge;

    const started = adapter.mic.start();
    const startId = vi.mocked(bridge.startCapture).mock.calls[0][0];
    win.__shadowAndroidCallback!(startId, '{"ok":true}');
    await expect(started).resolves.toBeUndefined();

    const stopped = adapter.mic.stop();
    const stopId = vi.mocked(bridge.stopCapture).mock.calls[0][0];
    expect(stopId).not.toBe(startId);
    // the payload may also arrive as an object
    win.__shadowAndroidCallback!(stopId, { ok: true, mime: "audio/mp4", data: "AAAA", durationMs: 900 });
    await expect(stopped).resolves.toEqual({ mime: "audio/mp4", data: "AAAA", durationMs: 900 });
  });

  it("maps bridge errors to PlatformError codes", async () => {
    const win: AndroidWindow = { ShadowAndroid: fakeBridge() };
    const adapter = createAndroidAdapter(win);
    const started = adapter.mic.start();
    const id = vi.mocked((win.ShadowAndroid as ShadowAndroidBridge).startCapture).mock.calls[0][0];
    win.__shadowAndroidCallback!(id, JSON.stringify({ ok: false, error: { code: "permission_denied", message: "no" } }));
    await expect(started).rejects.toMatchObject({ name: "PlatformError", code: "permission_denied" });
  });

  it("passes the shell's capture_aborted answer to stopCapture through", async () => {
    const win: AndroidWindow = { ShadowAndroid: fakeBridge() };
    const adapter = createAndroidAdapter(win);
    const stopped = adapter.mic.stop();
    const id = vi.mocked((win.ShadowAndroid as ShadowAndroidBridge).stopCapture).mock.calls[0][0];
    win.__shadowAndroidCallback!(id, '{"ok":false,"error":{"code":"capture_aborted"}}');
    await expect(stopped).rejects.toMatchObject({ name: "PlatformError", code: "capture_aborted" });
  });

  it("passes the shell's cancelled answer through as code cancelled", async () => {
    const win: AndroidWindow = { ShadowAndroid: fakeBridge() };
    const adapter = createAndroidAdapter(win);
    const bridge = win.ShadowAndroid as ShadowAndroidBridge;
    const started = adapter.mic.start();
    adapter.mic.cancel();
    const id = vi.mocked(bridge.startCapture).mock.calls[0][0];
    win.__shadowAndroidCallback!(id, '{"ok":false,"error":{"code":"cancelled"}}');
    await expect(started).rejects.toMatchObject({ name: "PlatformError", code: "cancelled" });
    // only the explicit cancel; a cancelled (not timed-out) start does not cancel again
    expect(bridge.cancelCapture).toHaveBeenCalledTimes(1);
  });

  it("times out capture calls the shell never answers", async () => {
    vi.useFakeTimers();
    try {
      const bridge = fakeBridge();
      const adapter = createAndroidAdapter({ ShadowAndroid: bridge });
      const started = adapter.mic.start();
      const assertion = expect(started).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(BRIDGE_CALL_TIMEOUT_MS);
      await assertion;
      // the shell must not keep a late-starting recording open
      expect(bridge.cancelCapture).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes playback and TTS through and resolves when the shell reports the end", async () => {
    const win: AndroidWindow = { ShadowAndroid: fakeBridge() };
    const adapter = createAndroidAdapter(win);
    const bridge = win.ShadowAndroid as ShadowAndroidBridge;
    const played = adapter.playback.play({ mime: "audio/wav", data: "UklGRg==" });
    const [playId, mime, data] = vi.mocked(bridge.playAudio).mock.calls[0];
    expect([mime, data]).toEqual(["audio/wav", "UklGRg=="]);
    win.__shadowAndroidCallback!(playId, '{"ok":true}');
    await expect(played).resolves.toBeUndefined();

    if (adapter.tts.mode !== "native") throw new Error("expected native tts");
    const spoken = adapter.tts.speak("Merhaba");
    const [speakId, text] = vi.mocked(bridge.speak).mock.calls[0];
    expect(text).toBe("Merhaba");
    win.__shadowAndroidCallback!(speakId, '{"ok":true}');
    await expect(spoken).resolves.toBeUndefined();
  });

  it("clamps levels, serialises vibration patterns, reads device class from getInfo", () => {
    const win: AndroidWindow = { ShadowAndroid: fakeBridge() };
    const adapter = createAndroidAdapter(win);
    expect(adapter.mic.level()).toBe(0.5);
    expect(adapter.playback.level()).toBe(1);
    adapter.vibrate([10, 20]);
    expect((win.ShadowAndroid as ShadowAndroidBridge).vibrate).toHaveBeenCalledWith("[10,20]");
    expect(adapter.deviceClass()).toBe("phone");
  });

  it("follows visibility events pushed by the shell", () => {
    const win: AndroidWindow = { ShadowAndroid: fakeBridge() };
    const adapter = createAndroidAdapter(win);
    const seen: boolean[] = [];
    const off = adapter.onVisibilityChange((v) => seen.push(v));
    win.__shadowAndroidEvent!("visibility", '{"visible":false}');
    expect(adapter.isVisible()).toBe(false);
    win.__shadowAndroidEvent!("visibility", { visible: true });
    expect(seen).toEqual([false, true]);
    off();
    win.__shadowAndroidEvent!("visibility", '{"visible":false}');
    expect(seen).toHaveLength(2);
    win.__shadowAndroidEvent!("visibility", "not json"); // ignored, no throw
  });

  it("ignores callbacks for unknown request ids", () => {
    const win: AndroidWindow = { ShadowAndroid: fakeBridge() };
    createAndroidAdapter(win);
    expect(() => win.__shadowAndroidCallback!("nope", '{"ok":true}')).not.toThrow();
  });
});

describe("device class and 3D quality defaults", () => {
  it("classifies devices", () => {
    expect(classifyDevice({ coarsePointer: true, shortSidePx: 390 })).toBe("phone");
    expect(classifyDevice({ coarsePointer: true, shortSidePx: 800 })).toBe("tablet");
    expect(classifyDevice({ coarsePointer: false, shortSidePx: 390 })).toBe("desktop");
  });

  it("defaults to low on phones, medium on tablets, high on desktops", () => {
    expect(defaultQuality("phone")).toBe("low");
    expect(defaultQuality("tablet")).toBe("medium");
    expect(defaultQuality("desktop")).toBe("high");
  });

  it("a stored valid choice wins; garbage falls back to the default", () => {
    expect(resolveQuality("high", "phone")).toBe("high");
    expect(resolveQuality(null, "phone")).toBe("low");
    expect(resolveQuality("ultra", "desktop")).toBe("high");
  });
});

describe("base64 helpers", () => {
  it("round-trips bytes larger than one chunk", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("strips MIME parameters", () => {
    expect(baseMime("audio/webm;codecs=opus")).toBe("audio/webm");
  });
});
