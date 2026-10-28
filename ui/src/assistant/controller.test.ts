import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreClientOptions, StatusEvent } from "../protocol/client.ts";
import type { ClientMessage, ServerMessage } from "../protocol/types.ts";
import { PlatformError, type PlatformAdapter, type TtsCapability, type Utterance } from "../platform/types.ts";
import {
  AssistantController,
  CANCEL_SETTLE_MS,
  MAX_UTTERANCE_MS,
  VOICES_TIMEOUT_MS,
  VOICE_SAMPLE_TEXT,
  clipForSpeech,
  type CoreClientLike,
} from "./controller.ts";
import { derivePhase } from "./state.ts";

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeAdapter(tts: TtsCapability = { mode: "core" }) {
  const calls: string[] = [];
  let utterance: Utterance = { mime: "audio/webm", data: "AAAA", durationMs: 1200 };
  let playing: Deferred<void> | null = null;
  const adapter: PlatformAdapter = {
    kind: "web",
    clientKind: "web",
    mic: {
      start: vi.fn(async () => {
        calls.push("mic.start");
      }),
      stop: vi.fn(async () => {
        calls.push("mic.stop");
        return utterance;
      }),
      cancel: vi.fn(() => calls.push("mic.cancel")),
      level: () => 0,
    },
    playback: {
      play: vi.fn((clip) => {
        calls.push(`play:${clip.mime}`);
        playing = deferred<void>();
        return playing.promise;
      }),
      stop: vi.fn(() => {
        calls.push("playback.stop");
        playing?.resolve();
        playing = null;
      }),
      level: () => 0,
      unlock: () => {},
    },
    tts,
    storage: { get: () => null, set: () => {}, remove: () => {} },
    vibrate: vi.fn(),
    notify: vi.fn(),
    deviceClass: () => "phone",
    prefersReducedMotion: () => false,
    isVisible: () => true,
    onVisibilityChange: () => () => {},
  };
  return {
    adapter,
    calls,
    setUtterance: (u: Utterance) => (utterance = u),
    finishPlayback: () => {
      playing?.resolve();
      playing = null;
    },
  };
}

function fakeClient() {
  const sent: ClientMessage[] = [];
  let opts!: CoreClientOptions;
  let connected = false;
  const client: CoreClientLike = {
    start: () => {},
    stop: () => {},
    reconnectNow: () => {},
    send: (msg) => {
      if (!connected) return false;
      sent.push(msg);
      return true;
    },
  };
  return {
    client,
    sent,
    create: (o: CoreClientOptions) => {
      opts = o;
      return client;
    },
    connect() {
      connected = true;
      opts.onStatus({ status: "connected", attempt: 0 } satisfies StatusEvent);
      opts.onMessage({ type: "welcome", protocol: 1, sessionId: "s", device: "browser" });
    },
    drop() {
      connected = false;
      opts.onStatus({ status: "reconnecting", attempt: 1, retryInMs: 1000 });
    },
    receive: (m: ServerMessage) => opts.onMessage(m),
    sentTypes: () => sent.map((m) => m.type),
  };
}

function setup(tts?: TtsCapability) {
  const a = fakeAdapter(tts);
  const c = fakeClient();
  let n = 0;
  const controller = new AssistantController({
    adapter: a.adapter,
    clientVersion: "test",
    createClient: c.create,
    newId: () => `t${++n}`,
  });
  controller.connect("ws://localhost:8700/ws", "tok");
  c.connect();
  c.sent.length = 0; // drop the history_request sent on welcome
  return { ...a, ...c, controller, phase: () => derivePhase(controller.getState()) };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("AssistantController", () => {
  it("requests recent history right after welcome", () => {
    const a = fakeAdapter();
    const c = fakeClient();
    const controller = new AssistantController({ adapter: a.adapter, clientVersion: "x", createClient: c.create });
    controller.connect("ws://localhost:8700/ws", "tok");
    c.connect();
    expect(c.sent).toEqual([{ type: "history_request", limit: 20 }]);
  });

  it("sends typed text as user_text", () => {
    const t = setup();
    expect(t.controller.sendText("  ışığı aç ")).toBe(true);
    expect(t.sent).toEqual([{ type: "user_text", id: "t1", text: "ışığı aç" }]);
    expect(t.phase()).toBe("thinking");
    expect(t.controller.sendText("   ")).toBe(false);
  });

  it("push-to-talk: start -> listening, stop -> one audio message", async () => {
    const t = setup();
    await t.controller.startTalk();
    expect(t.phase()).toBe("listening");
    await t.controller.stopTalk();
    expect(t.sent).toEqual([{ type: "audio", id: "t1", mime: "audio/webm", data: "AAAA" }]);
    expect(t.phase()).toBe("thinking");
  });

  it("discards a too-short utterance", async () => {
    const t = setup();
    t.setUtterance({ mime: "audio/webm", data: "AA", durationMs: 120 });
    await t.controller.startTalk();
    await t.controller.stopTalk();
    expect(t.sent).toEqual([]);
    expect(t.controller.getState().notice?.code).toBe("too_short");
    expect(t.phase()).toBe("idle");
  });

  it("a release during mic start stops as soon as the mic is up", async () => {
    const t = setup();
    const started = t.controller.startTalk();
    await t.controller.stopTalk(); // released while 'starting'
    await started;
    await flush();
    expect(t.calls).toContain("mic.stop");
    expect(t.sentTypes()).toEqual(["audio"]);
  });

  it("reports microphone permission errors", async () => {
    const t = setup();
    vi.mocked(t.adapter.mic.start).mockRejectedValueOnce(new PlatformError("permission_denied"));
    await t.controller.startTalk();
    expect(t.controller.getState().notice?.code).toBe("mic_permission_denied");
    expect(t.phase()).toBe("idle");
  });

  it("a start the host cancelled ends the capture without a notice", async () => {
    const t = setup();
    vi.mocked(t.adapter.mic.start).mockRejectedValueOnce(new PlatformError("cancelled"));
    await t.controller.startTalk();
    expect(t.controller.getState().capture).toBe("off");
    expect(t.controller.getState().notice).toBeNull();
    expect(t.phase()).toBe("idle");
  });

  it("a stop the host cancelled ends the capture without a notice and sends nothing", async () => {
    const t = setup();
    vi.mocked(t.adapter.mic.stop).mockRejectedValueOnce(new PlatformError("cancelled"));
    await t.controller.startTalk();
    await t.controller.stopTalk();
    expect(t.controller.getState().capture).toBe("off");
    expect(t.controller.getState().notice).toBeNull();
    expect(t.sent).toEqual([]);
  });

  it("a stop after the host cut the recording (capture_aborted) ends the capture with a short note and sends nothing", async () => {
    const t = setup();
    vi.mocked(t.adapter.mic.stop).mockRejectedValueOnce(new PlatformError("capture_aborted"));
    await t.controller.startTalk();
    await t.controller.stopTalk();
    expect(t.controller.getState().capture).toBe("off");
    expect(t.controller.getState().notice?.code).toBe("mic_capture_aborted");
    expect(t.sent).toEqual([]);
  });

  it("a new push-to-talk waits for a cancelled mic.start to settle, so its late cleanup cannot kill the new recording", async () => {
    const t = setup();
    const first = deferred<void>();
    vi.mocked(t.adapter.mic.start).mockImplementationOnce(() => first.promise);
    const starting = t.controller.startTalk();
    t.controller.cancelTalk();
    // Pressed again before the first mic.start answered: ignored.
    await t.controller.startTalk();
    expect(t.adapter.mic.start).toHaveBeenCalledTimes(1);
    expect(t.controller.getState().capture).toBe("off");

    first.resolve(); // late answer of the cancelled start: released at once
    await starting;
    const cancelsAfterSettle = t.calls.filter((c) => c === "mic.cancel").length;

    await t.controller.startTalk();
    expect(t.adapter.mic.start).toHaveBeenCalledTimes(2);
    expect(t.controller.getState().capture).toBe("recording");
    await flush();
    expect(t.calls.filter((c) => c === "mic.cancel").length).toBe(cancelsAfterSettle);
    await t.controller.stopTalk();
    expect(t.sentTypes()).toEqual(["audio"]);
  });

  it("a new push-to-talk is accepted again after a cancelled mic.start was rejected", async () => {
    const t = setup();
    const first = deferred<void>();
    vi.mocked(t.adapter.mic.start).mockImplementationOnce(() => first.promise);
    const starting = t.controller.startTalk();
    t.controller.cancelTalk();
    first.reject(new PlatformError("cancelled"));
    await starting;
    expect(t.controller.getState().notice).toBeNull();
    await t.controller.startTalk();
    expect(t.controller.getState().capture).toBe("recording");
  });

  describe("with fake timers", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("sends a held turn after CANCEL_SETTLE_MS if the Core never reports idle", async () => {
      const t = setup();
      t.controller.sendText("ilk");
      t.receive({ type: "state", state: "thinking" });
      t.controller.sendText("ikinci");
      expect(t.sentTypes()).toEqual(["user_text", "cancel"]);
      await vi.advanceTimersByTimeAsync(CANCEL_SETTLE_MS);
      expect(t.sentTypes()).toEqual(["user_text", "cancel", "user_text"]);
    });

    it("auto-stops a recording after the maximum length", async () => {
      const t = setup();
      await t.controller.startTalk();
      await vi.advanceTimersByTimeAsync(MAX_UTTERANCE_MS);
      expect(t.sentTypes()).toEqual(["audio"]);
    });
  });

  it("typed barge-in waits for the cancelled turn's idle before sending the new turn", () => {
    const t = setup();
    t.controller.sendText("ilk");
    t.receive({ type: "state", state: "thinking" });
    t.receive({ type: "assistant_delta", id: "t1", text: "Bir" });
    expect(t.controller.sendText("ikinci")).toBe(true);
    expect(t.sent).toEqual([
      { type: "user_text", id: "t1", text: "ilk" },
      { type: "cancel", id: "t1" },
    ]);
    expect(t.phase()).toBe("thinking");
    t.receive({ type: "assistant_done", id: "t1", text: "Bir" }); // Core reports the partial text
    t.receive({ type: "state", state: "idle" });
    expect(t.sent[t.sent.length - 1]).toEqual({ type: "user_text", id: "t2", text: "ikinci" });
    expect(t.phase()).toBe("thinking"); // the idle belonged to t1, not to t2
    expect(t.sentTypes().filter((x) => x === "speak")).toHaveLength(0);
  });

  it("does not hold new turns when only local playback was interrupted", () => {
    const t = setup();
    t.controller.sendText("x");
    t.receive({ type: "assistant_done", id: "t1", text: "y" });
    t.receive({ type: "state", state: "idle" });
    t.receive({ type: "speech", id: "t1", mime: "audio/wav", data: "UklGRg==" });
    t.controller.sendText("z");
    expect(t.sent[t.sent.length - 1]).toEqual({ type: "user_text", id: "t2", text: "z" });
  });

  it("web: assistant_done -> speak -> speech -> play -> speaking -> idle", async () => {
    const t = setup();
    t.controller.sendText("selam");
    t.receive({ type: "state", state: "thinking" });
    t.receive({ type: "assistant_done", id: "t1", text: "Merhaba!" });
    expect(t.sent[t.sent.length - 1]).toEqual({ type: "speak", id: "t1", text: "Merhaba!" });
    t.receive({ type: "state", state: "idle" });
    expect(t.phase()).toBe("thinking"); // waiting for the clip
    t.receive({ type: "speech", id: "t1", mime: "audio/wav", data: "UklGRg==" });
    expect(t.calls).toContain("play:audio/wav");
    expect(t.phase()).toBe("speaking");
    t.finishPlayback();
    await flush();
    expect(t.phase()).toBe("idle");
  });

  it("does not speak when voice replies are off", () => {
    const t = setup();
    t.controller.setVoiceReplies(false);
    t.controller.sendText("selam");
    t.receive({ type: "assistant_done", id: "t1", text: "Merhaba" });
    expect(t.sentTypes()).toEqual(["user_text"]);
  });

  it("barge-in while speaking stops playback, sends cancel and starts listening", async () => {
    const t = setup();
    t.controller.sendText("anlat");
    t.receive({ type: "assistant_done", id: "t1", text: "Uzun bir cevap" });
    t.receive({ type: "state", state: "idle" });
    t.receive({ type: "speech", id: "t1", mime: "audio/wav", data: "UklGRg==" });
    expect(t.phase()).toBe("speaking");

    await t.controller.startTalk();
    expect(t.calls).toContain("playback.stop");
    expect(t.sent).toContainEqual({ type: "cancel", id: "t1" });
    expect(t.phase()).toBe("listening");
    expect(t.calls.indexOf("playback.stop")).toBeLessThan(t.calls.indexOf("mic.start"));
  });

  it("barge-in while thinking cancels the turn and ignores its late speech", async () => {
    const t = setup();
    t.controller.sendText("anlat");
    t.receive({ type: "state", state: "thinking" });
    t.receive({ type: "assistant_delta", id: "t1", text: "Bir" });
    await t.controller.startTalk();
    expect(t.sent).toContainEqual({ type: "cancel", id: "t1" });
    t.receive({ type: "assistant_done", id: "t1", text: "Bir iki" });
    t.receive({ type: "speech", id: "t1", mime: "audio/wav", data: "UklGRg==" });
    expect(t.sentTypes().filter((x) => x === "speak")).toHaveLength(0);
    expect(t.calls.some((c) => c.startsWith("play:"))).toBe(false);
  });

  it("talking while a confirm is pending does not cancel the paused turn", async () => {
    const t = setup();
    t.controller.sendText("kilidi aç");
    t.receive({ type: "state", state: "awaiting_confirm" });
    t.receive({ type: "confirm_request", requestId: "c1", id: "t1", tool: "lock", summary: "Açılsın mı?", expiresAt: 1 });
    await t.controller.startTalk();
    await t.controller.stopTalk();
    expect(t.sentTypes()).toEqual(["user_text", "audio"]);
  });

  it("confirm button sends confirm_response once and the card closes on confirm_resolved", () => {
    const t = setup();
    t.receive({ type: "confirm_request", requestId: "c1", id: "t1", tool: "lock", summary: "Açılsın mı?", expiresAt: 1 });
    expect(t.adapter.vibrate).toHaveBeenCalled();
    t.controller.respondConfirm(true);
    t.controller.respondConfirm(true); // double tap
    expect(t.sent).toEqual([{ type: "confirm_response", requestId: "c1", approved: true }]);
    expect(t.phase()).toBe("awaiting_confirm");
    t.receive({ type: "confirm_resolved", requestId: "c1", approved: true, by: "button" });
    expect(t.controller.getState().confirms).toEqual([]);
  });

  it("typed text while a confirm is pending is refused with a hint", () => {
    const t = setup();
    t.controller.sendText("kilidi aç");
    t.receive({ type: "confirm_request", requestId: "c1", id: "t1", tool: "lock", summary: "Açılsın mı?", expiresAt: 1 });
    expect(t.controller.sendText("evet")).toBe(false);
    expect(t.sentTypes()).toEqual(["user_text"]);
    expect(t.controller.getState().notice?.code).toBe("confirm_pending");
  });

  it("voice answer: the paused turn stays active and the card closes on confirm_resolved by voice", async () => {
    const t = setup();
    t.controller.sendText("kilidi aç");
    t.receive({ type: "state", state: "awaiting_confirm" });
    t.receive({ type: "confirm_request", requestId: "c1", id: "t1", tool: "lock", summary: "Açılsın mı?", expiresAt: 1 });
    await t.controller.startTalk();
    await t.controller.stopTalk();
    t.receive({ type: "transcript", id: "t2", text: "evet" });
    t.receive({ type: "confirm_resolved", requestId: "c1", approved: true, by: "voice" });
    t.receive({ type: "state", state: "thinking" });
    expect(t.controller.getState().confirms).toEqual([]);
    expect(t.controller.getState().activeTurn?.id).toBe("t1");
    expect(t.phase()).toBe("thinking");
    t.receive({ type: "assistant_done", id: "t1", text: "Açtım." });
    t.receive({ type: "state", state: "idle" });
    expect(t.controller.getState().activeTurn).toBeNull();
  });

  it("a second barge-in drops the still-queued turn locally and sends only the latest", () => {
    const t = setup();
    t.controller.sendText("ilk");
    t.receive({ type: "state", state: "thinking" });
    t.controller.sendText("ikinci"); // queued behind cancel(t1)
    t.controller.sendText("üçüncü"); // replaces the queued one
    expect(t.sent.filter((m) => m.type === "cancel")).toEqual([{ type: "cancel", id: "t1" }]);
    t.receive({ type: "state", state: "idle" });
    expect(t.sent[t.sent.length - 1]).toEqual({ type: "user_text", id: "t3", text: "üçüncü" });
    expect(t.sent.some((m) => m.type === "user_text" && m.id === "t2")).toBe(false);
    expect(t.controller.getState().activeTurn?.id).toBe("t3");
  });

  it("a queued turn lost with the connection is marked failed and never sent", () => {
    const t = setup();
    t.controller.sendText("ilk");
    t.receive({ type: "state", state: "thinking" });
    t.controller.sendText("ikinci");
    t.drop();
    expect(t.sent.some((m) => m.type === "user_text" && m.id === "t2")).toBe(false);
    expect(t.controller.getState().messages.find((m) => m.key === "t2:user")?.failed).toBe(true);
  });

  it("cancelling while the utterance is being encoded sends nothing", async () => {
    const t = setup();
    await t.controller.startTalk();
    const stopping = t.controller.stopTalk();
    t.controller.cancelTalk();
    await stopping;
    expect(t.sent).toEqual([]);
    expect(t.controller.getState().capture).toBe("off");
  });

  it("cancelling while the mic starts keeps capture off and releases the mic", async () => {
    const t = setup();
    const starting = t.controller.startTalk();
    t.controller.cancelTalk();
    await starting;
    expect(t.controller.getState().capture).toBe("off");
    expect(t.calls.filter((c) => c === "mic.cancel").length).toBeGreaterThanOrEqual(1);
    expect(t.calls[t.calls.length - 1]).toBe("mic.cancel");
  });

  it("sending text abandons a recording in progress", async () => {
    const t = setup();
    await t.controller.startTalk();
    t.controller.sendText("yazarak");
    expect(t.controller.getState().capture).toBe("off");
    expect(t.calls).toContain("mic.cancel");
    await t.controller.stopTalk();
    expect(t.sentTypes()).toEqual(["user_text"]);
  });

  it("stopSpeaking() stops the reply audio without cancelling the turn", () => {
    const t = setup();
    t.controller.sendText("x");
    t.receive({ type: "assistant_done", id: "t1", text: "y" });
    t.controller.stopSpeaking();
    t.receive({ type: "speech", id: "t1", mime: "audio/wav", data: "UklGRg==" });
    expect(t.sentTypes()).not.toContain("cancel");
    expect(t.calls.some((c) => c.startsWith("play:"))).toBe(false);
    expect(t.controller.getState().activeTurn?.id).toBe("t1");
  });

  it("no haptics/notification for a confirm_request of a cancelled turn", async () => {
    const t = setup();
    t.controller.sendText("kilidi aç");
    t.receive({ type: "state", state: "thinking" });
    await t.controller.startTalk(); // barge-in cancels t1
    t.controller.cancelTalk();
    vi.mocked(t.adapter.vibrate).mockClear();
    t.receive({ type: "confirm_request", requestId: "c1", id: "t1", tool: "lock", summary: "s", expiresAt: 1 });
    expect(t.adapter.vibrate).not.toHaveBeenCalled();
    expect(t.controller.getState().confirms).toEqual([]);
  });

  it("explicit stop() cancels speech without listening", () => {
    const t = setup();
    t.controller.sendText("x");
    t.receive({ type: "assistant_done", id: "t1", text: "y" });
    t.receive({ type: "speech", id: "t1", mime: "audio/wav", data: "UklGRg==" });
    t.controller.stop();
    expect(t.sent).toContainEqual({ type: "cancel", id: "t1" });
    expect(t.phase()).toBe("idle");
  });

  it("stop() while a confirm is pending sends nothing and keeps the card (the stop button is hidden then)", () => {
    const t = setup();
    t.controller.sendText("kilidi aç");
    t.receive({ type: "state", state: "awaiting_confirm" });
    t.receive({ type: "confirm_request", requestId: "c1", id: "t1", tool: "lock", summary: "s", expiresAt: 1 });
    t.sent.length = 0;
    t.controller.stop();
    expect(t.sent).toEqual([]);
    expect(t.controller.getState().confirms).toHaveLength(1);
  });

  it("refuses to send while disconnected", () => {
    const t = setup();
    t.drop();
    expect(t.controller.sendText("x")).toBe(false);
    expect(t.controller.getState().notice?.code).toBe("not_connected");
  });

  it("native TTS (Android): speaks locally instead of sending speak", async () => {
    const speak = deferred<void>();
    const stop = vi.fn(() => speak.resolve());
    const t = setup({ mode: "native", speak: vi.fn(() => speak.promise), stop });
    t.controller.sendText("selam");
    t.receive({ type: "assistant_done", id: "t1", text: "Merhaba" });
    expect(t.sentTypes()).toEqual(["user_text"]);
    expect(t.phase()).toBe("speaking");
    await t.controller.startTalk(); // barge-in
    expect(stop).toHaveBeenCalled();
    expect(t.sent).toContainEqual({ type: "cancel", id: "t1" });
  });
});

describe("voice picker (T5.3)", () => {
  const VOICES = [
    { id: "tr_TR-dfki-medium", label: "DFKI", quality: "medium" },
    { id: "tr_TR-b", label: "B" },
  ];

  it("requests the voice list and stores the answer", () => {
    const t = setup();
    t.controller.requestVoices();
    expect(t.sent).toEqual([{ type: "voices", id: "t1" }]);
    expect(t.controller.getState().voices.status).toBe("loading");
    t.controller.requestVoices(); // already in flight: no second frame
    expect(t.sent).toHaveLength(1);
    t.receive({ type: "voices", id: "t1", default: "tr_TR-dfki-medium", voices: VOICES });
    expect(t.controller.getState().voices).toEqual({
      status: "ready",
      requestId: "t1",
      defaultVoice: "tr_TR-dfki-medium",
      voices: VOICES,
    });
  });

  it("ignores a voices frame for another request", () => {
    const t = setup();
    t.controller.requestVoices();
    t.receive({ type: "voices", id: "other", default: "x", voices: [] });
    expect(t.controller.getState().voices.status).toBe("loading");
  });

  it("tts_unavailable for the list marks it unavailable without a chat notice", () => {
    const t = setup();
    t.controller.requestVoices();
    t.receive({ type: "error", id: "t1", code: "tts_unavailable", message: "down" });
    expect(t.controller.getState().voices.status).toBe("unavailable");
    expect(t.controller.getState().notice).toBeNull();
    // Asking again (panel reopened / "Yeniden dene") works.
    t.controller.requestVoices();
    expect(t.sent[t.sent.length - 1]).toEqual({ type: "voices", id: "t2" });
  });

  it("does not ask while disconnected or on a native-TTS host (Android)", () => {
    const native = setup({ mode: "native", speak: vi.fn(async () => {}), stop: vi.fn() });
    native.controller.requestVoices();
    expect(native.sent).toEqual([]);
    const t = setup();
    t.drop();
    t.controller.requestVoices();
    expect(t.sent).toEqual([]);
    expect(t.controller.getState().voices.status).toBe("idle");
  });

  it("a dropped socket or a new welcome resets the list", () => {
    const t = setup();
    t.controller.requestVoices();
    t.drop();
    expect(t.controller.getState().voices.status).toBe("idle");
    t.connect();
    t.controller.requestVoices();
    const id = (t.sent[t.sent.length - 1] as { id: string }).id;
    t.receive({ type: "voices", id, default: "a", voices: [] });
    expect(t.controller.getState().voices.status).toBe("ready");
    t.receive({ type: "welcome", protocol: 1, sessionId: "s2", device: "browser" });
    expect(t.controller.getState().voices.status).toBe("idle");
  });

  describe("with fake timers", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("no answer (e.g. an older Core) -> unavailable; a late answer still fills the list", () => {
      const t = setup();
      t.controller.requestVoices();
      vi.advanceTimersByTime(VOICES_TIMEOUT_MS - 1);
      expect(t.controller.getState().voices.status).toBe("loading");
      vi.advanceTimersByTime(1);
      expect(t.controller.getState().voices.status).toBe("unavailable");
      t.receive({ type: "voices", id: "t1", default: "a", voices: VOICES });
      expect(t.controller.getState().voices.status).toBe("ready");
    });

    it("an answer in time cancels the timeout", () => {
      const t = setup();
      t.controller.requestVoices();
      t.receive({ type: "voices", id: "t1", default: "a", voices: VOICES });
      vi.advanceTimersByTime(VOICES_TIMEOUT_MS * 2);
      expect(t.controller.getState().voices.status).toBe("ready");
    });
  });

  it("every speak carries the chosen voice; none -> no voice field", () => {
    const t = setup();
    t.controller.setVoice("tr_TR-b");
    t.controller.sendText("selam");
    t.receive({ type: "assistant_done", id: "t1", text: "Merhaba" });
    expect(t.sent[t.sent.length - 1]).toEqual({ type: "speak", id: "t1", text: "Merhaba", voice: "tr_TR-b" });
    t.receive({ type: "state", state: "idle" });
    t.receive({ type: "speech", id: "t1", mime: "audio/wav", data: "UklGRg==" });
    t.finishPlayback();

    t.controller.setVoice(null);
    t.controller.sendText("tekrar");
    t.receive({ type: "assistant_done", id: "t2", text: "Tamam" });
    expect(t.sent[t.sent.length - 1]).toEqual({ type: "speak", id: "t2", text: "Tamam" });
  });

  it("Dene: speaks the sample with the selected voice and plays it", async () => {
    const t = setup();
    expect(t.controller.previewVoice("tr_TR-b")).toBe(true);
    expect(t.sent).toEqual([{ type: "speak", id: "t1", text: VOICE_SAMPLE_TEXT, voice: "tr_TR-b" }]);
    expect(t.controller.getState().voicePreview).toEqual({ id: "t1", failed: false });
    t.receive({ type: "speech", id: "t1", mime: "audio/wav", data: "UklGRg==" });
    expect(t.calls).toContain("play:audio/wav");
    expect(t.phase()).toBe("speaking");
    t.finishPlayback();
    await flush();
    expect(t.phase()).toBe("idle");
    // Default voice: no voice field.
    t.controller.previewVoice(null);
    expect(t.sent[t.sent.length - 1]).toEqual({ type: "speak", id: "t2", text: VOICE_SAMPLE_TEXT });
  });

  it("Dene is refused while a turn is in flight or a confirm is pending, and on Android", () => {
    const t = setup();
    t.controller.sendText("selam");
    expect(t.controller.previewVoice(null)).toBe(false);
    t.receive({ type: "state", state: "thinking" });
    t.receive({ type: "confirm_request", requestId: "c1", id: "t1", tool: "x", summary: "s", expiresAt: Date.now() + 60_000 });
    expect(t.controller.previewVoice(null)).toBe(false);
    expect(t.sentTypes()).toEqual(["user_text"]);

    const native = setup({ mode: "native", speak: vi.fn(async () => {}), stop: vi.fn() });
    expect(native.controller.previewVoice(null)).toBe(false);
    expect(native.sent).toEqual([]);
  });

  it("Dene stops a reply that is being spoken first", () => {
    const t = setup();
    t.controller.sendText("selam");
    t.receive({ type: "assistant_done", id: "t1", text: "Merhaba" });
    t.receive({ type: "state", state: "idle" });
    t.receive({ type: "speech", id: "t1", mime: "audio/wav", data: "UklGRg==" });
    expect(t.phase()).toBe("speaking");
    expect(t.controller.previewVoice(null)).toBe(true);
    expect(t.calls).toContain("playback.stop");
    expect(t.controller.getState().awaitingSpeech).toBe("t2");
  });

  it("a failed sample is reported in the picker, not as a chat notice", () => {
    const t = setup();
    t.controller.previewVoice("tr_TR-b");
    t.receive({ type: "error", id: "t1", code: "tts_unavailable", message: "down" });
    const s = t.controller.getState();
    expect(s.voicePreview).toEqual({ id: "t1", failed: true });
    expect(s.notice).toBeNull();
    expect(s.awaitingSpeech).toBeNull();
    expect(t.phase()).toBe("idle");
  });
});

describe("clipForSpeech", () => {
  it("keeps short text and cuts long text at a sentence boundary", () => {
    expect(clipForSpeech(" kısa ")).toBe("kısa");
    const long = "Bir cümle. ".repeat(300);
    const clipped = clipForSpeech(long, 2000);
    expect(clipped.length).toBeLessThanOrEqual(2000);
    expect(clipped.endsWith(".")).toBe(true);
  });
});
