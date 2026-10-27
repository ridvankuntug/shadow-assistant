/**
 * Web adapter privacy rule: a recording never continues in a hidden tab
 * (docs/03-platform-adapter.md §4.5). Browser APIs are replaced by small fakes
 * (the test environment is node, no DOM).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantController, MAX_UTTERANCE_MS, type CoreClientLike } from "../assistant/controller.ts";
import type { CoreClientOptions } from "../protocol/client.ts";
import type { ClientMessage } from "../protocol/types.ts";
import { PlatformError } from "./types.ts";
import { createWebAdapter } from "./web.ts";

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  readonly tracks = [new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
}

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((ev: { data: Blob }) => void) | null = null;
  onstop: ((ev: Event) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly stream: FakeStream) {
    FakeRecorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    // Like the browser: the last data and `stop` arrive asynchronously.
    queueMicrotask(() => {
      this.ondataavailable?.({ data: new Blob(["some-sound"]) });
      this.onstop?.(new Event("stop"));
    });
  }
}

type Env = {
  streams: FakeStream[];
  getUserMedia: ReturnType<typeof vi.fn>;
  hide(): void;
  show(): void;
};

function installBrowser(): Env {
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
  const streams: FakeStream[] = [];
  const getUserMedia = vi.fn(async () => {
    const s = new FakeStream();
    streams.push(s);
    return s;
  });
  FakeRecorder.instances = [];
  vi.stubGlobal("document", doc);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("AudioContext", undefined); // metering is optional
  const set = (v: DocumentVisibilityState) => {
    doc.visibilityState = v;
    doc.dispatchEvent(new Event("visibilitychange"));
  };
  return { streams, getUserMedia, hide: () => set("hidden"), show: () => set("visible") };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (err) {
    return err instanceof PlatformError ? err.code : "other";
  }
}

let env: Env;
beforeEach(() => {
  env = installBrowser();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("web adapter microphone", () => {
  it("a normal stop returns the recorded utterance and releases the mic", async () => {
    const a = createWebAdapter();
    await a.mic.start();
    const u = await a.mic.stop();
    expect(u.mime).toBe("audio/webm");
    expect(u.data.length).toBeGreaterThan(0);
    expect(env.streams[0].tracks[0].stopped).toBe(true);
  });

  it("tab hidden while recording: recorder and tracks stop, data is dropped, stop() reports capture_aborted once", async () => {
    const a = createWebAdapter();
    await a.mic.start();
    const rec = FakeRecorder.instances[0];
    env.hide();
    expect(rec.state).toBe("inactive");
    expect(env.streams[0].tracks[0].stopped).toBe(true);
    expect(rec.ondataavailable).toBeNull();
    expect(rec.onstop).toBeNull();
    expect(a.mic.level()).toBe(0);
    expect(await codeOf(a.mic.stop())).toBe("capture_aborted");
    expect(await codeOf(a.mic.stop())).toBe("not_recording");
  });

  it("hiding the tab while idle does nothing; stop() stays not_recording", async () => {
    const a = createWebAdapter();
    env.hide();
    expect(await codeOf(a.mic.stop())).toBe("not_recording");
  });

  it("a getUserMedia that completes while the tab is hidden records nothing", async () => {
    const a = createWebAdapter();
    let open!: (s: FakeStream) => void;
    env.getUserMedia.mockImplementationOnce(
      () =>
        new Promise<FakeStream>((r) => {
          open = (s) => {
            env.streams.push(s);
            r(s);
          };
        }),
    );
    const starting = a.mic.start();
    env.hide();
    open(new FakeStream());
    expect(await codeOf(starting)).toBe("capture_aborted");
    expect(env.streams[0].tracks[0].stopped).toBe(true);
  });

  it("cancel() after an abort forgets it: the next stop() is not_recording", async () => {
    const a = createWebAdapter();
    await a.mic.start();
    env.hide();
    a.mic.cancel();
    expect(await codeOf(a.mic.stop())).toBe("not_recording");
  });

  it("a stop() already in progress when the tab is hidden still returns its foreground audio", async () => {
    const a = createWebAdapter();
    await a.mic.start();
    const stopping = a.mic.stop();
    env.hide(); // before the recorder's async stop event
    const u = await stopping;
    expect(u.data.length).toBeGreaterThan(0);
    expect(env.streams[0].tracks[0].stopped).toBe(true);
  });

  it("a new recording after an abort works normally", async () => {
    const a = createWebAdapter();
    await a.mic.start();
    env.hide();
    env.show();
    await a.mic.start(); // the abort is forgotten without a stop() in between
    const u = await a.mic.stop();
    expect(u.data.length).toBeGreaterThan(0);
  });
});

// --- controller + real web adapter: nothing reaches the Core ----------------

function setupController() {
  const adapter = createWebAdapter();
  const sent: ClientMessage[] = [];
  let opts!: CoreClientOptions;
  const client: CoreClientLike = {
    start: () => {},
    stop: () => {},
    reconnectNow: () => {},
    send: (msg) => {
      sent.push(msg);
      return true;
    },
  };
  const controller = new AssistantController({
    adapter,
    clientVersion: "test",
    createClient: (o) => {
      opts = o;
      return client;
    },
    newId: () => "t1",
  });
  controller.connect("ws://localhost:8700/ws", "tok");
  opts.onStatus({ status: "connected", attempt: 0 });
  opts.onMessage({ type: "welcome", protocol: 1, sessionId: "s", device: "browser" });
  sent.length = 0; // history_request
  return { controller, sent, state: () => controller.getState() };
}

describe("tab hidden during push-to-talk (web)", () => {
  it("hold mode: releasing after the tab was hidden sends no audio and shows the short note", async () => {
    const t = setupController();
    await t.controller.startTalk();
    expect(t.state().capture).toBe("recording");
    env.hide();
    expect(env.streams[0].tracks[0].stopped).toBe(true);
    env.show();
    await t.controller.stopTalk(); // finger released
    await flush();
    expect(t.sent.map((m) => m.type)).not.toContain("audio");
    expect(t.state().capture).toBe("off");
    expect(t.state().notice?.code).toBe("mic_capture_aborted");
  });

  it("latched mode: the 60 s auto-stop after the tab was hidden sends no audio", async () => {
    vi.useFakeTimers();
    const t = setupController();
    await t.controller.startTalk(); // tap: recording stays on until the next tap
    env.hide();
    expect(FakeRecorder.instances[0].state).toBe("inactive");
    expect(env.streams[0].tracks[0].stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(MAX_UTTERANCE_MS);
    expect(t.sent.map((m) => m.type)).not.toContain("audio");
    expect(t.state().capture).toBe("off");
    expect(t.state().notice?.code).toBe("mic_capture_aborted");
  });

  it("latched mode: coming back closes the cut recording at once with the note (foreground)", async () => {
    const t = setupController();
    await t.controller.startTalk();
    env.hide();
    env.show();
    t.controller.foreground(); // App calls this when visible again
    await flush();
    expect(t.state().capture).toBe("off");
    expect(t.state().notice?.code).toBe("mic_capture_aborted");
    expect(t.sent).toEqual([]);
  });

  it("foreground() does nothing while idle", async () => {
    const t = setupController();
    t.controller.foreground(); // idle: nothing to do
    expect(t.state().capture).toBe("off");
    expect(t.state().notice).toBeNull();
  });

  it("latched mode: the second tap after coming back sends no audio", async () => {
    const t = setupController();
    await t.controller.startTalk();
    env.hide();
    env.show();
    await t.controller.stopTalk(); // second tap
    expect(t.sent).toEqual([]);
    expect(t.state().notice?.code).toBe("mic_capture_aborted");
  });
});
