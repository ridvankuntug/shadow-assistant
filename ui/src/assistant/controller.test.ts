import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreClientOptions, StatusEvent } from "../protocol/client.ts";
import type { ClientMessage, ServerMessage } from "../protocol/types.ts";
import { PlatformError, type PlatformAdapter, type TtsCapability, type Utterance } from "../platform/types.ts";
import {
  AssistantController,
  CANCEL_SETTLE_MS,
  MAX_UTTERANCE_MS,
  SPEECH_FINAL_TIMEOUT_MS,
  VOICES_TIMEOUT_MS,
  VOICE_SAMPLE_TEXT,
  clipForSpeech,
  type CoreClientLike,
} from "./controller.ts";
import { derivePhase } from "./state.ts";
import { noticeMessage } from "../ui/strings.ts";

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
    /** `features`: the Core's `welcome.features` (absent = an older Core). */
    connect(features?: string[]) {
      connected = true;
      opts.onStatus({ status: "connected", attempt: 0 } satisfies StatusEvent);
      opts.onMessage(
        features
          ? { type: "welcome", protocol: 1, sessionId: "s", device: "browser", features }
          : { type: "welcome", protocol: 1, sessionId: "s", device: "browser" },
      );
    },
    drop() {
      connected = false;
      opts.onStatus({ status: "reconnecting", attempt: 1, retryInMs: 1000 });
    },
    receive: (m: ServerMessage) => opts.onMessage(m),
    sentTypes: () => sent.map((m) => m.type),
  };
}

function setup(tts?: TtsCapability, features?: string[]) {
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
  c.connect(features);
  c.sent.length = 0; // drop the history_request (and speech_prefs) sent on welcome
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

  it("a usage_limit error shows its reset time in the notice card text", () => {
    const t = setup();
    t.controller.sendText("selam");
    const now = new Date(2026, 9, 28, 12, 0).getTime();
    const retryAt = new Date(2026, 9, 28, 14, 30).getTime();
    t.receive({ type: "error", id: "t1", code: "usage_limit", message: "limit", retryAt });
    const notice = t.controller.getState().notice!;
    expect(noticeMessage(notice, now)).toBe("Kullanım limitine ulaşıldı; 14:30'da sıfırlanır.");
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

describe("streamed speech (speech_stream)", () => {
  const STREAM = ["speech_stream", "memory", "usage_limit"];
  const nativeTts = (speak: (text: string) => Promise<void>) => ({ mode: "native" as const, speak: vi.fn(speak), stop: vi.fn() });
  const chunk = (id: string, seq: number, data?: string, final = false): ServerMessage =>
    data ? { type: "speech_chunk", id, seq, final, mime: "audio/wav", data } : { type: "speech_chunk", id, seq, final };
  const playedData = (t: ReturnType<typeof setup>) => vi.mocked(t.adapter.playback.play).mock.calls.map(([clip]) => clip.data);

  it("opts in after a welcome with speech_stream: audio mode for core TTS, with the chosen voice", () => {
    const a = fakeAdapter();
    const c = fakeClient();
    const controller = new AssistantController({ adapter: a.adapter, clientVersion: "x", createClient: c.create });
    controller.setVoice("tr_TR-b");
    controller.connect("ws://localhost:8700/ws", "tok");
    c.connect(STREAM);
    expect(c.sent).toEqual([
      { type: "speech_prefs", enabled: true, mode: "audio", voice: "tr_TR-b" },
      { type: "history_request", limit: 20 },
    ]);
  });

  it("native TTS opts in with text mode and no voice", () => {
    const t = setup(nativeTts(async () => {}));
    t.controller.setVoice("tr_TR-b");
    t.drop();
    t.connect(STREAM);
    expect(t.sent).toContainEqual({ type: "speech_prefs", enabled: true, mode: "text" });
  });

  it("sends speech_prefs again only when voice replies or the voice change", () => {
    const t = setup(undefined, STREAM);
    t.controller.setVoiceReplies(true); // unchanged
    t.controller.setVoice(null); // unchanged
    expect(t.sent).toEqual([]);
    t.controller.setVoiceReplies(false);
    t.controller.setVoice("tr_TR-b");
    t.controller.setVoiceReplies(true);
    expect(t.sent).toEqual([
      { type: "speech_prefs", enabled: false, mode: "audio" },
      { type: "speech_prefs", enabled: false, mode: "audio", voice: "tr_TR-b" },
      { type: "speech_prefs", enabled: true, mode: "audio", voice: "tr_TR-b" },
    ]);
  });

  it("an older Core (no speech_stream) gets no speech_prefs and speak still follows assistant_done", () => {
    const t = setup(undefined, ["memory"]);
    t.controller.setVoiceReplies(false);
    t.controller.setVoiceReplies(true);
    t.controller.sendText("selam");
    t.receive({ type: "assistant_done", id: "t1", text: "Merhaba" });
    expect(t.sentTypes()).toEqual(["user_text", "speak"]);
  });

  it("plays chunks in order, one after another; speaking from the first chunk until the queue drains after final", async () => {
    const t = setup(undefined, STREAM);
    t.controller.sendText("anlat");
    t.receive({ type: "state", state: "thinking" });
    t.receive(chunk("t1", 0, "A"));
    expect(t.phase()).toBe("speaking");
    t.receive(chunk("t1", 1, "B"));
    t.receive({ type: "assistant_delta", id: "t1", text: "…" });
    expect(playedData(t)).toEqual(["A"]); // B waits for A
    t.finishPlayback();
    await flush();
    expect(playedData(t)).toEqual(["A", "B"]);
    t.receive({ type: "assistant_done", id: "t1", text: "Bir. İki." });
    t.receive({ type: "state", state: "idle" });
    expect(t.phase()).toBe("speaking"); // more may come until final
    t.finishPlayback();
    await flush();
    expect(t.phase()).toBe("speaking");
    t.receive(chunk("t1", 2, "C", true));
    expect(playedData(t)).toEqual(["A", "B", "C"]);
    t.finishPlayback();
    await flush();
    expect(t.phase()).toBe("idle");
  });

  it("does not speak twice: no speak after assistant_done while streaming", () => {
    const t = setup(undefined, STREAM);
    t.controller.sendText("selam");
    t.receive(chunk("t1", 0, "A"));
    t.receive({ type: "assistant_done", id: "t1", text: "Merhaba" });
    t.receive(chunk("t1", 1, undefined, true));
    expect(t.sentTypes()).toEqual(["user_text"]);
  });

  it("a payload-less final ends the speaking phase once the last clip finished", async () => {
    const t = setup(undefined, STREAM);
    t.controller.sendText("selam");
    t.receive(chunk("t1", 0, "A"));
    t.receive(chunk("t1", 1, undefined, true));
    expect(t.phase()).toBe("speaking");
    t.finishPlayback();
    await flush();
    expect(t.controller.getState().playing).toBeNull();
    expect(t.phase()).toBe("thinking"); // the turn itself has not ended yet
    expect(playedData(t)).toEqual(["A"]);
  });

  it("barge-in clears the queue: playback stops, cancel is sent, queued and late chunks are dropped", async () => {
    const t = setup(undefined, STREAM);
    t.controller.sendText("anlat");
    t.receive({ type: "state", state: "thinking" });
    t.receive(chunk("t1", 0, "A"));
    t.receive(chunk("t1", 1, "B"));
    await t.controller.startTalk();
    expect(t.calls).toContain("playback.stop");
    expect(t.sent).toContainEqual({ type: "cancel", id: "t1" });
    expect(t.phase()).toBe("listening");
    t.receive(chunk("t1", 2, "C"));
    await flush();
    expect(playedData(t)).toEqual(["A"]);
  });

  it("stop() and stopSpeaking() clear the queue; later chunks of that turn stay silent", async () => {
    const t = setup(undefined, STREAM);
    t.controller.sendText("anlat");
    t.receive(chunk("t1", 0, "A"));
    t.receive(chunk("t1", 1, "B"));
    t.controller.stopSpeaking();
    expect(t.phase()).not.toBe("speaking");
    t.receive(chunk("t1", 2, "C"));
    await flush();
    expect(playedData(t)).toEqual(["A"]);

    const u = setup(undefined, STREAM);
    u.controller.sendText("anlat");
    u.receive(chunk("t1", 0, "A"));
    u.receive(chunk("t1", 1, "B"));
    u.controller.stop();
    expect(u.sent).toContainEqual({ type: "cancel", id: "t1" });
    u.receive(chunk("t1", 2, "C", true));
    await flush();
    expect(playedData(u)).toEqual(["A"]);
    expect(u.phase()).toBe("idle");
  });

  it("chunks that arrive after voice replies were switched off are ignored", () => {
    const t = setup(undefined, STREAM);
    t.controller.sendText("anlat");
    t.controller.setVoiceReplies(false);
    t.receive(chunk("t1", 0, "A"));
    expect(playedData(t)).toEqual([]);
    expect(t.sent).toContainEqual({ type: "speech_prefs", enabled: false, mode: "audio" });
  });

  it("native mode speaks the chunk texts in order through tts.speak", async () => {
    const pending: Array<() => void> = [];
    const tts = nativeTts(() => new Promise<void>((res) => pending.push(res)));
    const t = setup(tts, STREAM);
    t.controller.sendText("anlat");
    t.receive({ type: "speech_chunk", id: "t1", seq: 0, final: false, text: "Birinci cümle." });
    t.receive({ type: "speech_chunk", id: "t1", seq: 1, final: true, text: "İkinci cümle." });
    expect(tts.speak.mock.calls.map(([x]) => x)).toEqual(["Birinci cümle."]);
    expect(t.phase()).toBe("speaking");
    pending.shift()!();
    await flush();
    expect(tts.speak.mock.calls.map(([x]) => x)).toEqual(["Birinci cümle.", "İkinci cümle."]);
    t.receive({ type: "assistant_done", id: "t1", text: "Birinci cümle. İkinci cümle." });
    expect(t.sentTypes()).toEqual(["user_text"]);
    t.receive({ type: "state", state: "idle" });
    expect(t.phase()).toBe("speaking");
    pending.shift()!();
    await flush();
    expect(t.phase()).toBe("idle");
    expect(vi.mocked(t.adapter.playback.play)).not.toHaveBeenCalled();
  });

  it("ignores repeated chunks and chunks without a payload for this client's mode", () => {
    const t = setup(undefined, STREAM);
    t.controller.sendText("anlat");
    t.receive(chunk("t1", 0, "A"));
    t.receive(chunk("t1", 0, "A"));
    t.receive({ type: "speech_chunk", id: "t1", seq: 1, final: false, text: "metin" });
    t.finishPlayback();
    return flush().then(() => expect(playedData(t)).toEqual(["A"]));
  });

  it("a failed clip shows a notice and skips the rest of the answer", async () => {
    const t = setup(undefined, STREAM);
    vi.mocked(t.adapter.playback.play).mockRejectedValueOnce(new PlatformError("playback_failed", "blocked"));
    t.controller.sendText("anlat");
    t.receive(chunk("t1", 0, "A"));
    t.receive(chunk("t1", 1, "B"));
    await flush();
    expect(t.controller.getState().notice?.code).toBe("playback_failed");
    expect(playedData(t)).toEqual(["A"]);
    expect(t.phase()).toBe("thinking"); // the turn itself still runs
  });

  it("tts_unavailable during a streamed turn keeps the turn and its text running", () => {
    const t = setup(undefined, STREAM);
    t.controller.sendText("anlat");
    t.receive({ type: "state", state: "thinking" });
    t.receive({ type: "assistant_delta", id: "t1", text: "Bir" });
    t.receive({ type: "error", id: "t1", code: "tts_unavailable", message: "down" });
    t.receive(chunk("t1", 0, undefined, true));
    expect(t.controller.getState().notice?.code).toBe("tts_unavailable");
    expect(t.controller.getState().activeTurn?.id).toBe("t1");
    t.receive({ type: "assistant_delta", id: "t1", text: " iki" });
    t.receive({ type: "assistant_done", id: "t1", text: "Bir iki" });
    const reply = t.controller.getState().messages.find((m) => m.key === "t1:assistant");
    expect(reply).toMatchObject({ text: "Bir iki", pending: false });
    expect(reply?.failed).toBeUndefined();
    expect(t.sentTypes()).toEqual(["user_text"]);
  });

  it("a chunk of a newer turn replaces what is left of the previous one", async () => {
    const t = setup(undefined, STREAM);
    t.controller.sendText("bir");
    t.receive(chunk("t1", 0, "A"));
    t.receive(chunk("t1", 1, "B"));
    t.receive(chunk("t9", 0, "X"));
    await flush();
    expect(playedData(t)).toEqual(["A", "X"]);
    expect(t.controller.getState().playing).toBe("t9");
  });

  it("a dropped socket plays what arrived and then ends the speaking phase", async () => {
    const t = setup(undefined, STREAM);
    t.controller.sendText("anlat");
    t.receive(chunk("t1", 0, "A"));
    t.receive(chunk("t1", 1, "B"));
    t.drop();
    t.finishPlayback();
    await flush();
    expect(playedData(t)).toEqual(["A", "B"]);
    t.finishPlayback();
    await flush();
    expect(t.phase()).toBe("idle");
  });

  it("disconnect() plays what arrived and then ends the speaking phase", async () => {
    const t = setup(undefined, STREAM);
    t.controller.sendText("anlat");
    t.receive(chunk("t1", 0, "A"));
    t.receive(chunk("t1", 1, "B"));
    t.controller.disconnect();
    t.finishPlayback();
    await flush();
    expect(playedData(t)).toEqual(["A", "B"]);
    t.finishPlayback();
    await flush();
    expect(t.controller.getState().playing).toBeNull();
  });

  it("a turn that ended before its first chunk still speaks when nothing else happened", async () => {
    const t = setup(undefined, STREAM);
    t.controller.sendText("bir");
    t.receive({ type: "state", state: "thinking" });
    t.receive({ type: "assistant_done", id: "t1", text: "A" });
    t.receive({ type: "state", state: "idle" });
    t.receive(chunk("t1", 0, "A", true));
    expect(playedData(t)).toEqual(["A"]);
  });

  it("late chunks of a turn that ended before its first chunk stay silent after a new turn, stop or push-to-talk", async () => {
    const run = async (act: (t: ReturnType<typeof setup>) => Promise<void> | void) => {
      const t = setup(undefined, STREAM);
      t.controller.sendText("bir");
      t.receive({ type: "state", state: "thinking" });
      t.receive({ type: "assistant_done", id: "t1", text: "A" });
      t.receive({ type: "state", state: "idle" });
      await act(t);
      t.receive(chunk("t1", 0, "A"));
      t.receive(chunk("t1", 1, "B", true));
      await flush();
      expect(playedData(t)).toEqual([]);
      expect(t.controller.getState().playing).toBeNull();
      return t;
    };
    const typed = await run((t) => void t.controller.sendText("iki"));
    // The new turn's own speech still plays.
    typed.receive(chunk("t2", 0, "X", true));
    expect(playedData(typed)).toEqual(["X"]);
    await run((t) => t.controller.stop());
    const talk = await run((t) => t.controller.startTalk());
    expect(talk.phase()).toBe("listening");
  });

  it("a new welcome opts in again", () => {
    const t = setup(undefined, STREAM);
    t.drop();
    t.connect(STREAM);
    expect(t.sent).toContainEqual({ type: "speech_prefs", enabled: true, mode: "audio" });
  });

  describe("with fake timers", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("after assistant_done a missing final ends the queue after SPEECH_FINAL_TIMEOUT_MS", async () => {
      const t = setup(undefined, STREAM);
      t.controller.sendText("anlat");
      t.receive(chunk("t1", 0, "A"));
      t.receive({ type: "assistant_done", id: "t1", text: "A" });
      t.receive({ type: "state", state: "idle" });
      t.finishPlayback();
      await vi.advanceTimersByTimeAsync(SPEECH_FINAL_TIMEOUT_MS - 1);
      expect(t.phase()).toBe("speaking");
      await vi.advanceTimersByTimeAsync(1);
      expect(t.phase()).toBe("idle");
    });

    it("a turn error without a final chunk also ends the queue after the timeout", async () => {
      const t = setup(undefined, STREAM);
      t.controller.sendText("anlat");
      t.receive(chunk("t1", 0, "A"));
      t.receive({ type: "error", id: "t1", code: "model_error", message: "x" });
      t.finishPlayback();
      await vi.advanceTimersByTimeAsync(SPEECH_FINAL_TIMEOUT_MS);
      expect(t.controller.getState().playing).toBeNull();
      expect(t.phase()).toBe("idle");
    });

    it("no timeout before assistant_done (a confirm may pause the turn for long)", async () => {
      const t = setup(undefined, STREAM);
      t.controller.sendText("anlat");
      t.receive({ type: "state", state: "thinking" });
      t.receive(chunk("t1", 0, "A"));
      t.finishPlayback();
      await vi.advanceTimersByTimeAsync(SPEECH_FINAL_TIMEOUT_MS * 3);
      expect(t.controller.getState().playing).toBe("t1");
      t.receive(chunk("t1", 1, "B", true));
      expect(playedData(t)).toEqual(["A", "B"]);
    });
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
