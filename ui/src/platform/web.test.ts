/**
 * Web adapter rule: a recording keeps running when the tab is hidden and its
 * audio is sent normally (docs/03-platform-adapter.md §4.5). Browser APIs are
 * replaced by small fakes (the test environment is node, no DOM).
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

  it("tab hidden while recording: the recording keeps running and stop() returns its audio", async () => {
    const a = createWebAdapter();
    await a.mic.start();
    const rec = FakeRecorder.instances[0];
    env.hide();
    expect(rec.state).toBe("recording");
    expect(env.streams[0].tracks[0].stopped).toBe(false);
    const u = await a.mic.stop();
    expect(u.data.length).toBeGreaterThan(0);
    expect(env.streams[0].tracks[0].stopped).toBe(true);
    expect(await codeOf(a.mic.stop())).toBe("not_recording");
  });

  it("hiding the tab while idle does nothing; stop() stays not_recording", async () => {
    const a = createWebAdapter();
    env.hide();
    expect(await codeOf(a.mic.stop())).toBe("not_recording");
  });

  it("a getUserMedia that completes while the tab is hidden records normally", async () => {
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
    await starting;
    expect(FakeRecorder.instances[0].state).toBe("recording");
    expect(env.streams[0].tracks[0].stopped).toBe(false);
    const u = await a.mic.stop();
    expect(u.data.length).toBeGreaterThan(0);
  });

  it("a start while the tab is hidden records normally", async () => {
    const a = createWebAdapter();
    env.hide();
    await a.mic.start();
    const u = await a.mic.stop();
    expect(u.data.length).toBeGreaterThan(0);
  });

  it("cancel() while hidden drops the recording and releases the mic", async () => {
    const a = createWebAdapter();
    await a.mic.start();
    env.hide();
    a.mic.cancel();
    expect(FakeRecorder.instances[0].state).toBe("inactive");
    expect(env.streams[0].tracks[0].stopped).toBe(true);
    expect(await codeOf(a.mic.stop())).toBe("not_recording");
  });
});

// --- controller + real web adapter: the audio reaches the Core ----------------

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
  // Fake timers also fake performance.now(), so the utterance is long enough
  // (MIN_UTTERANCE_MS) to be sent.
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("hold mode: releasing while the tab is hidden sends the audio", async () => {
    const t = setupController();
    await t.controller.startTalk();
    expect(t.state().capture).toBe("recording");
    env.hide();
    await vi.advanceTimersByTimeAsync(1500);
    expect(t.state().capture).toBe("recording");
    await t.controller.stopTalk(); // finger released
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent.map((m) => m.type)).toEqual(["audio"]);
    expect(t.state().capture).toBe("off");
    expect(t.state().notice).toBeNull();
  });

  it("hold mode: hidden and back again, releasing sends the audio", async () => {
    const t = setupController();
    await t.controller.startTalk();
    env.hide();
    await vi.advanceTimersByTimeAsync(1500);
    env.show();
    await t.controller.stopTalk();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent.map((m) => m.type)).toEqual(["audio"]);
    expect(t.state().notice).toBeNull();
  });

  it("latched mode: the 60 s auto-stop while the tab is hidden sends the audio", async () => {
    const t = setupController();
    await t.controller.startTalk(); // tap: recording stays on until the next tap
    env.hide();
    expect(FakeRecorder.instances[0].state).toBe("recording");
    await vi.advanceTimersByTimeAsync(MAX_UTTERANCE_MS);
    expect(t.sent.map((m) => m.type)).toEqual(["audio"]);
    expect(t.state().capture).toBe("off");
    expect(t.state().notice).toBeNull();
    expect(env.streams[0].tracks[0].stopped).toBe(true);
  });

  it("latched mode: coming back leaves the recording running; the second tap sends the audio", async () => {
    const t = setupController();
    await t.controller.startTalk();
    env.hide();
    await vi.advanceTimersByTimeAsync(1500);
    env.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.state().capture).toBe("recording");
    expect(t.sent).toEqual([]);
    await t.controller.stopTalk(); // second tap
    await vi.advanceTimersByTimeAsync(0);
    expect(t.sent.map((m) => m.type)).toEqual(["audio"]);
    expect(t.state().notice).toBeNull();
  });
});
