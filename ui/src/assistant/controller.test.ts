import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreClientOptions, StatusEvent } from "../protocol/client.ts";
import type { ClientMessage, DevItem, NotificationInfo, ServerMessage } from "../protocol/types.ts";
import { PlatformError, type PlatformAdapter, type TtsCapability, type Utterance } from "../platform/types.ts";
import {
  AssistantController,
  CANCEL_SETTLE_MS,
  CATCH_UP_SUMMARY_ID,
  DEV_TIMEOUT_MS,
  MAX_UTTERANCE_MS,
  MEMORY_TIMEOUT_MS,
  NOTIFICATIONS_RETRY_MS,
  NOTIFICATIONS_TIMEOUT_MS,
  SPEECH_FINAL_TIMEOUT_MS,
  VOICES_TIMEOUT_MS,
  VOICE_SAMPLE_TEXT,
  clipForSpeech,
  type CoreClientLike,
} from "./controller.ts";
import {
  derivePhase,
  devBadgeCount,
  devItemActions,
  notificationsBadgeCount,
  notificationsSuppressAvailable,
  notificationsUnavailable,
  notificationsUrgencyFeedbackAvailable,
} from "./state.ts";
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

/** An Android-like host: Core speech plus a native fallback; `speak` answers through `pending`. */
function fallbackTts() {
  const pending: Array<() => void> = [];
  const speak = vi.fn((text: string) => {
    void text;
    return new Promise<void>((res) => pending.push(res));
  });
  const stop = vi.fn(() => {
    for (const res of pending.splice(0)) res();
  });
  const tts: TtsCapability = { mode: "core", fallback: { speak, stop } };
  return { tts, speak, stop, pending, spoken: () => speak.mock.calls.map(([x]) => x) };
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

  it("Android (fallback host): the reply is a Core speak played through playback; native TTS stays silent", async () => {
    const f = fallbackTts();
    const t = setup(f.tts);
    t.controller.setVoice("tr_TR-b");
    t.controller.sendText("selam");
    t.receive({ type: "assistant_done", id: "t1", text: "Merhaba" });
    expect(t.sent[t.sent.length - 1]).toEqual({ type: "speak", id: "t1", text: "Merhaba", voice: "tr_TR-b" });
    t.receive({ type: "state", state: "idle" });
    t.receive({ type: "speech", id: "t1", mime: "audio/wav", data: "UklGRg==" });
    expect(t.calls).toContain("play:audio/wav");
    t.finishPlayback();
    await flush();
    expect(t.phase()).toBe("idle");
    expect(f.speak).not.toHaveBeenCalled();
  });

  it("a failed speak is spoken natively once, without the notice; barge-in stops it", async () => {
    const f = fallbackTts();
    const t = setup(f.tts);
    t.controller.sendText("selam");
    t.receive({ type: "assistant_done", id: "t1", text: "Merhaba" });
    t.receive({ type: "state", state: "idle" });
    t.receive({ type: "error", id: "t1", code: "tts_unavailable", message: "down" });
    expect(f.spoken()).toEqual(["Merhaba"]);
    expect(t.controller.getState().notice).toBeNull();
    expect(t.phase()).toBe("speaking");
    // A repeated error does not speak it again.
    t.receive({ type: "error", id: "t1", code: "tts_unavailable", message: "down" });
    expect(f.spoken()).toEqual(["Merhaba"]);
    await t.controller.startTalk(); // barge-in
    expect(f.stop).toHaveBeenCalled();
    await flush();
    expect(t.phase()).toBe("listening");
  });

  it("a speak error after a stop, and an error for the Dene sample, are not spoken natively", () => {
    const f = fallbackTts();
    const t = setup(f.tts);
    t.controller.sendText("selam");
    t.receive({ type: "assistant_done", id: "t1", text: "Merhaba" });
    t.receive({ type: "state", state: "idle" });
    t.controller.stopSpeaking();
    t.receive({ type: "error", id: "t1", code: "tts_unavailable", message: "down" });
    t.controller.previewVoice(null);
    t.receive({ type: "error", id: "t2", code: "tts_unavailable", message: "down" });
    expect(f.speak).not.toHaveBeenCalled();
    expect(t.controller.getState().voicePreview).toEqual({ id: "t2", failed: true });
  });

  it("a host without a fallback (web) keeps the notice and stays silent when speak fails", () => {
    const t = setup();
    t.controller.sendText("selam");
    t.receive({ type: "assistant_done", id: "t1", text: "Merhaba" });
    t.receive({ type: "error", id: "t1", code: "tts_unavailable", message: "down" });
    expect(t.controller.getState().notice?.code).toBe("tts_unavailable");
    expect(t.phase()).not.toBe("speaking");
  });

  it("a failing fallback shows tts_failed and ends the speaking phase", async () => {
    const speak = vi.fn(async () => {
      throw new PlatformError("unknown", "no engine");
    });
    const t = setup({ mode: "core", fallback: { speak, stop: vi.fn() } });
    t.controller.sendText("selam");
    t.receive({ type: "assistant_done", id: "t1", text: "Merhaba" });
    t.receive({ type: "state", state: "idle" });
    t.receive({ type: "error", id: "t1", code: "tts_unavailable", message: "down" });
    await flush();
    expect(t.controller.getState().notice?.code).toBe("tts_failed");
    expect(t.phase()).toBe("idle");
  });
});

describe("streamed speech (speech_stream)", () => {
  const STREAM = ["speech_stream", "memory", "usage_limit"];
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

  it("a host with a native fallback (Android) also opts in with audio mode and the chosen voice", () => {
    const t = setup(fallbackTts().tts);
    t.controller.setVoice("tr_TR-b");
    t.drop();
    t.connect(STREAM);
    expect(t.sent).toContainEqual({ type: "speech_prefs", enabled: true, mode: "audio", voice: "tr_TR-b" });
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

  it("an older Core: leaving for another app before assistant_done sends no speak for that turn", () => {
    const t = setup(undefined, ["memory"]);
    t.controller.sendText("selam");
    t.controller.leaveForOtherApp();
    t.receive({ type: "assistant_done", id: "t1", text: "Merhaba" });
    expect(t.sentTypes()).toEqual(["user_text"]);
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

  it("leaving for another app (Gemini) silences the turn in flight, before its first chunk too; its text still arrives", async () => {
    const t = setup(undefined, STREAM);
    t.controller.sendText("anlat");
    t.receive({ type: "state", state: "thinking" });
    t.controller.leaveForOtherApp();
    t.receive(chunk("t1", 0, "A"));
    t.receive({ type: "assistant_done", id: "t1", text: "Bir." });
    t.receive(chunk("t1", 1, "B", true));
    await flush();
    expect(playedData(t)).toEqual([]);
    expect(t.sentTypes()).toEqual(["user_text"]); // no cancel: the answer is not thrown away
    expect(t.controller.getState().messages.at(-1)?.text).toBe("Bir.");
    // The next turn speaks normally.
    t.controller.sendText("devam");
    t.receive(chunk("t2", 0, "C", true));
    expect(playedData(t)).toEqual(["C"]);
  });

  it("leaving for another app stops a playing chunk and cuts a recording", async () => {
    const t = setup(undefined, STREAM);
    t.controller.sendText("anlat");
    t.receive(chunk("t1", 0, "A"));
    expect(playedData(t)).toEqual(["A"]);
    t.controller.leaveForOtherApp();
    expect(t.adapter.playback.stop).toHaveBeenCalled();
    t.receive(chunk("t1", 1, "B", true));
    await flush();
    expect(playedData(t)).toEqual(["A"]);
    await t.controller.startTalk();
    t.controller.leaveForOtherApp();
    expect(t.adapter.mic.cancel).toHaveBeenCalled();
    expect(t.controller.getState().capture).toBe("off");
  });

  it("a failed Gemini open shows its hint as a notice that can be dismissed", () => {
    const t = setup(undefined, STREAM);
    t.controller.geminiFailed();
    const notice = t.controller.getState().notice;
    expect(notice).toEqual({ code: "gemini_failed" });
    expect(noticeMessage(notice!)).toMatch(/^Gemini açılamadı/);
    t.controller.dismissNotice();
    expect(t.controller.getState().notice).toBeNull();
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

  it("Android plays the Core chunks through playback; the fallback stays silent", async () => {
    const f = fallbackTts();
    const t = setup(f.tts, STREAM);
    t.controller.sendText("anlat");
    t.receive(chunk("t1", 0, "A"));
    t.receive(chunk("t1", 1, "B", true));
    t.finishPlayback();
    await flush();
    expect(playedData(t)).toEqual(["A", "B"]);
    expect(f.speak).not.toHaveBeenCalled();
  });

  it("tts_unavailable before any clip and before assistant_done: the whole answer is spoken natively at assistant_done", async () => {
    const f = fallbackTts();
    const t = setup(f.tts, STREAM);
    t.controller.sendText("anlat");
    t.receive({ type: "state", state: "thinking" });
    t.receive({ type: "assistant_delta", id: "t1", text: "Bir." });
    t.receive({ type: "error", id: "t1", code: "tts_unavailable", message: "down" });
    t.receive(chunk("t1", 0, undefined, true)); // the Core's final marker after the failure
    expect(t.controller.getState().notice).toBeNull();
    expect(f.speak).not.toHaveBeenCalled();
    t.receive({ type: "assistant_delta", id: "t1", text: " İki." });
    t.receive({ type: "assistant_done", id: "t1", text: "Bir. İki." });
    t.receive({ type: "state", state: "idle" });
    expect(f.spoken()).toEqual(["Bir. İki."]);
    expect(t.phase()).toBe("speaking");
    expect(t.sentTypes()).toEqual(["user_text"]); // no speak: it is not said twice
    f.pending.shift()!();
    await flush();
    expect(t.phase()).toBe("idle");
    expect(vi.mocked(t.adapter.playback.play)).not.toHaveBeenCalled();
  });

  it("tts_unavailable after assistant_done (before any clip): spoken natively at once", async () => {
    const f = fallbackTts();
    const t = setup(f.tts, STREAM);
    t.controller.sendText("anlat");
    t.receive({ type: "assistant_done", id: "t1", text: "Merhaba" });
    t.receive({ type: "state", state: "idle" });
    t.receive({ type: "error", id: "t1", code: "tts_unavailable", message: "down" });
    expect(f.spoken()).toEqual(["Merhaba"]);
    t.receive(chunk("t1", 0, undefined, true));
    expect(t.phase()).toBe("speaking");
    f.pending.shift()!();
    await flush();
    expect(t.phase()).toBe("idle");
  });

  it("tts_unavailable after a clip: the clips that arrived play, nothing is spoken natively, the notice stays", async () => {
    const f = fallbackTts();
    const t = setup(f.tts, STREAM);
    t.controller.sendText("anlat");
    t.receive(chunk("t1", 0, "A"));
    t.receive({ type: "error", id: "t1", code: "tts_unavailable", message: "down" });
    t.receive(chunk("t1", 1, undefined, true));
    t.receive({ type: "assistant_done", id: "t1", text: "Bir. İki." });
    t.finishPlayback();
    await flush();
    expect(playedData(t)).toEqual(["A"]);
    expect(f.speak).not.toHaveBeenCalled();
    expect(t.controller.getState().notice?.code).toBe("tts_unavailable");
  });

  it("barge-in while the fallback waits for or speaks the answer stops it", async () => {
    const f = fallbackTts();
    const t = setup(f.tts, STREAM);
    t.controller.sendText("anlat");
    t.receive({ type: "state", state: "thinking" });
    t.receive({ type: "error", id: "t1", code: "tts_unavailable", message: "down" });
    await t.controller.startTalk(); // barge-in before assistant_done
    t.receive({ type: "assistant_done", id: "t1", text: "Merhaba" });
    expect(f.speak).not.toHaveBeenCalled();

    const u = setup(fallbackTts().tts, STREAM);
    const g = u.adapter.tts.fallback!;
    u.controller.sendText("anlat");
    u.receive({ type: "assistant_done", id: "t1", text: "Merhaba" });
    u.receive({ type: "state", state: "idle" });
    u.receive({ type: "error", id: "t1", code: "tts_unavailable", message: "down" });
    expect(g.speak).toHaveBeenCalledTimes(1);
    await u.controller.startTalk();
    expect(g.stop).toHaveBeenCalled();
    await flush();
    expect(u.phase()).toBe("listening");
  });

  it("a voices error while the fallback waits for the answer does not disturb it", async () => {
    const f = fallbackTts();
    const t = setup(f.tts, STREAM);
    t.controller.sendText("anlat");
    t.receive({ type: "state", state: "thinking" });
    t.receive({ type: "error", id: "t1", code: "tts_unavailable", message: "down" });
    t.receive(chunk("t1", 0, undefined, true));
    t.controller.requestVoices();
    t.receive({ type: "error", id: "t2", code: "tts_unavailable", message: "down" });
    expect(t.controller.getState().voices.status).toBe("unavailable");
    t.receive({ type: "assistant_done", id: "t1", text: "Merhaba" });
    expect(f.spoken()).toEqual(["Merhaba"]);
  });

  it("a turn error after a fallback was chosen ends the queue silently", async () => {
    const f = fallbackTts();
    const t = setup(f.tts, STREAM);
    t.controller.sendText("anlat");
    t.receive({ type: "state", state: "thinking" });
    t.receive({ type: "error", id: "t1", code: "tts_unavailable", message: "down" });
    t.receive(chunk("t1", 0, undefined, true));
    t.receive({ type: "error", id: "t1", code: "model_error", message: "boom" });
    t.receive({ type: "state", state: "idle" });
    await flush();
    expect(f.speak).not.toHaveBeenCalled();
    expect(t.phase()).toBe("idle");
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

  it("asks on a host with a native fallback (Android) too, but not while disconnected", () => {
    const android = setup(fallbackTts().tts);
    android.controller.requestVoices();
    expect(android.sent).toEqual([{ type: "voices", id: "t1" }]);
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

  it("Dene is refused while a turn is in flight or a confirm is pending; allowed on Android", () => {
    const t = setup();
    t.controller.sendText("selam");
    expect(t.controller.previewVoice(null)).toBe(false);
    t.receive({ type: "state", state: "thinking" });
    t.receive({ type: "confirm_request", requestId: "c1", id: "t1", tool: "x", summary: "s", expiresAt: Date.now() + 60_000 });
    expect(t.controller.previewVoice(null)).toBe(false);
    expect(t.sentTypes()).toEqual(["user_text"]);

    const android = setup(fallbackTts().tts);
    expect(android.controller.previewVoice(null)).toBe(true);
    expect(android.sentTypes()).toEqual(["speak"]);
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

describe("memory panel (M8)", () => {
  const frame = (id: string, entries = [{ id: "m-1", text: "Rıdvan" }]): ServerMessage => ({
    type: "memory",
    id,
    brief: { chars: 5, budget: 800, entries },
    topics: [],
    warnings: [],
  });

  it("does nothing without the memory feature (older Core) or while not connected", () => {
    const t = setup(undefined, ["speech_stream"]);
    expect(t.controller.requestMemory()).toBe(false);
    expect(t.controller.deleteMemoryEntry("m-1")).toBe(false);
    expect(t.sent).toEqual([]);
    const d = setup(undefined, ["memory"]);
    d.drop();
    expect(d.controller.requestMemory()).toBe(false);
    expect(d.sent).toEqual([]);
  });

  it("list: sends memory_list and shows the answer", () => {
    const t = setup(undefined, ["memory"]);
    expect(t.controller.requestMemory()).toBe(true);
    expect(t.sent).toEqual([{ type: "memory_list", id: "t1" }]);
    expect(t.controller.requestMemory()).toBe(false); // one request at a time
    t.receive(frame("t1"));
    expect(t.controller.getState().memory.status).toBe("ready");
    expect(t.controller.getState().memory.contents?.brief.entries[0].id).toBe("m-1");
  });

  it("delete: sends memory_delete with the entry id; the fresh list replaces the old one", () => {
    const t = setup(undefined, ["memory"]);
    t.controller.requestMemory();
    t.receive(frame("t1"));
    expect(t.controller.deleteMemoryEntry("m-1")).toBe(true);
    expect(t.sent[1]).toEqual({ type: "memory_delete", id: "t2", entryId: "m-1" });
    expect(t.controller.getState().memory.deleting).toBe("m-1");
    t.receive(frame("t2", []));
    expect(t.controller.getState().memory).toMatchObject({ status: "ready", deleting: null });
    expect(t.controller.getState().memory.contents?.brief.entries).toEqual([]);
  });

  it("an error for a memory request is shown in the panel, not as a chat notice", () => {
    const t = setup(undefined, ["memory"]);
    t.controller.requestMemory();
    t.receive({ type: "error", id: "t1", code: "bad_request", message: "memory is disabled" });
    expect(t.controller.getState().notice).toBeNull();
    expect(t.controller.getState().memory).toMatchObject({ status: "error", errorCode: "bad_request" });
    expect(t.controller.requestMemory()).toBe(true); // can retry
  });

  it("closing the panel abandons the request: its late answer and error change nothing", () => {
    const t = setup(undefined, ["memory"]);
    t.controller.requestMemory();
    t.controller.closeMemory();
    expect(t.controller.getState().memory).toMatchObject({ status: "idle", requestId: null, contents: null });
    t.receive(frame("t1"));
    t.receive({ type: "error", id: "t1", code: "internal", message: "late" });
    expect(t.controller.getState().memory).toMatchObject({ status: "idle", requestId: null, contents: null, errorCode: null });
    expect(t.controller.getState().notice).toBeNull();
    // Opened again: a new request, whose answer counts.
    expect(t.controller.requestMemory()).toBe(true);
    t.receive(frame("t2"));
    expect(t.controller.getState().memory.status).toBe("ready");
  });

  it("closing during a delete keeps the shown contents and drops the delete's answer", () => {
    const t = setup(undefined, ["memory"]);
    t.controller.requestMemory();
    t.receive(frame("t1"));
    t.controller.deleteMemoryEntry("m-1");
    t.controller.closeMemory();
    expect(t.controller.getState().memory).toMatchObject({ status: "ready", deleting: null, requestId: null });
    t.receive(frame("t2", []));
    expect(t.controller.getState().memory.contents?.brief.entries.map((e) => e.id)).toEqual(["m-1"]);
    // Nothing in flight: closing again is a no-op.
    const before = t.controller.getState();
    t.controller.closeMemory();
    expect(t.controller.getState()).toBe(before);
  });

  describe("with fake timers", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("no answer -> timeout error; a late answer still fills the panel", () => {
      const t = setup(undefined, ["memory"]);
      t.controller.requestMemory();
      vi.advanceTimersByTime(MEMORY_TIMEOUT_MS - 1);
      expect(t.controller.getState().memory.status).toBe("loading");
      vi.advanceTimersByTime(1);
      expect(t.controller.getState().memory).toMatchObject({ status: "error", errorCode: "timeout" });
      t.receive(frame("t1"));
      expect(t.controller.getState().memory.status).toBe("ready");
    });

    it("a newer request after a timeout: the old request's late answer and error are ignored", () => {
      const t = setup(undefined, ["memory"]);
      t.controller.requestMemory();
      vi.advanceTimersByTime(MEMORY_TIMEOUT_MS);
      expect(t.controller.requestMemory()).toBe(true); // "Yenile"
      t.receive({ type: "error", id: "t1", code: "internal", message: "late" });
      t.receive(frame("t1"));
      expect(t.controller.getState().notice).toBeNull();
      expect(t.controller.getState().memory).toMatchObject({ status: "loading", requestId: "t2" });
      t.receive(frame("t2", []));
      expect(t.controller.getState().memory).toMatchObject({ status: "ready", requestId: "t2" });
    });

    it("closing the panel stops the timeout of the abandoned request", () => {
      const t = setup(undefined, ["memory"]);
      t.controller.requestMemory();
      t.controller.closeMemory();
      vi.advanceTimersByTime(MEMORY_TIMEOUT_MS * 2);
      expect(t.controller.getState().memory).toMatchObject({ status: "idle", errorCode: null });
    });

    it("an answer in time cancels the timeout", () => {
      const t = setup(undefined, ["memory"]);
      t.controller.requestMemory();
      t.receive(frame("t1"));
      vi.advanceTimersByTime(MEMORY_TIMEOUT_MS * 2);
      expect(t.controller.getState().memory.status).toBe("ready");
    });

    it("a late error of a closed panel's request does not touch the streamed speech of the last turn", async () => {
      const t = setup(undefined, ["speech_stream", "memory"]);
      t.controller.sendText("anlat"); // t1
      t.receive({ type: "assistant_done", id: "t1", text: "A" }); // no chunk yet: t1 pending
      t.receive({ type: "state", state: "idle" });
      t.controller.requestMemory(); // t2
      t.controller.closeMemory();
      t.receive({ type: "error", id: "t2", code: "internal", message: "late" });
      expect(t.controller.getState().notice).toBeNull();
      // t1's first chunk (no final) still belongs to the finished turn: the queue ends by timeout.
      t.receive({ type: "speech_chunk", id: "t1", seq: 0, final: false, mime: "audio/wav", data: "A" });
      t.finishPlayback();
      await vi.advanceTimersByTimeAsync(SPEECH_FINAL_TIMEOUT_MS);
      expect(t.controller.getState().playing).toBeNull();
      expect(t.phase()).toBe("idle");
    });
  });
});

describe("development panel (T7.w.4c)", () => {
  const rule = (status = "candidate"): DevItem => ({
    itemId: "r-1",
    type: "rule",
    kind: "learned_rule",
    status,
    message: "Kural önerisi",
    count: 3,
    firstSeen: "2026-11-07T18:00:00.000Z",
    lastSeen: "2026-11-08T07:30:00.000Z",
    rule: { tokens: ["<ad>", "yüzde", "<sayi>", "yap"], tool: "light__HassLightSet", domains: ["light"], observations: 3 },
  });
  const note = (status = "open"): DevItem => ({
    itemId: "n-1",
    type: "note",
    kind: "wandering",
    status,
    message: "Uzun tur",
    count: 2,
    firstSeen: "2026-11-07T18:00:00.000Z",
    lastSeen: "2026-11-08T07:30:00.000Z",
  });
  const frame = (id: string, canManage = false, items: DevItem[] = [rule(), note()], open = items.length): ServerMessage => ({
    type: "dev",
    id,
    items,
    open,
    canManage,
  });
  /** Connected to a Core with `dev`; the dev_list sent on welcome ("t1") answered with `answer`. */
  const ready = (answer = frame("t1")) => {
    const t = setup(undefined, ["dev"]);
    t.receive(answer);
    return t;
  };

  it("without the dev feature: no dev_list on welcome, no requests, no badge", () => {
    const t = setup(undefined, ["memory"]);
    expect(t.controller.getState().dev.status).toBe("idle");
    expect(t.controller.requestDev()).toBe(false);
    expect(t.controller.devAction("r-1", "ignore")).toBe(false);
    expect(t.sent).toEqual([]);
    t.receive({ type: "dev_count", open: 4 }); // an odd Core: still no badge
    expect(devBadgeCount(t.controller.getState())).toBe(0);
  });

  it("list: dev_list right after welcome (for the badge); the answer fills the panel", () => {
    const a = fakeAdapter();
    const c = fakeClient();
    const controller = new AssistantController({ adapter: a.adapter, clientVersion: "x", createClient: c.create, newId: () => "d1" });
    controller.connect("ws://localhost:8700/ws", "tok");
    c.connect(["dev"]);
    expect(c.sent).toContainEqual({ type: "dev_list", id: "d1" });
    expect(controller.requestDev()).toBe(false); // one request at a time
    c.receive(frame("d1", true));
    const dev = controller.getState().dev;
    expect(dev).toMatchObject({ status: "ready", open: 2, canManage: true });
    expect(dev.items?.map((i) => i.itemId)).toEqual(["r-1", "n-1"]);
    expect(devBadgeCount(controller.getState())).toBe(2);
    expect(controller.requestDev()).toBe(true); // "Yenile"
  });

  it("badge: dev_count changes it; it is gone while disconnected", () => {
    const t = ready();
    t.receive({ type: "dev_count", open: 5 });
    expect(devBadgeCount(t.controller.getState())).toBe(5);
    t.receive({ type: "dev_count", open: 0 });
    expect(devBadgeCount(t.controller.getState())).toBe(0);
    t.receive({ type: "dev_count", open: 1 });
    t.drop();
    expect(devBadgeCount(t.controller.getState())).toBe(0);
  });

  it("development frames never notify, vibrate or play a sound (also in the background)", () => {
    const t = setup(undefined, ["dev"]);
    t.adapter.isVisible = () => false;
    t.receive(frame("t1", true));
    t.receive({ type: "dev_count", open: 7 });
    t.controller.devAction("n-1", "fixed");
    t.receive(frame("t2", true, [rule()], 1));
    expect(t.adapter.notify).not.toHaveBeenCalled();
    expect(t.adapter.vibrate).not.toHaveBeenCalled();
    expect(t.adapter.playback.play).not.toHaveBeenCalled();
    expect(t.calls).toEqual([]);
    expect(t.controller.getState().notice).toBeNull();
  });

  it("ignore / fixed: dev_action with the item id; the fresh list replaces the old one", () => {
    const t = ready();
    expect(t.controller.devAction("n-1", "fixed")).toBe(true);
    expect(t.sent).toEqual([{ type: "dev_action", id: "t2", itemId: "n-1", action: "fixed" }]);
    expect(t.controller.getState().dev).toMatchObject({ status: "loading", acting: { itemId: "n-1", action: "fixed" } });
    expect(t.controller.devAction("r-1", "ignore")).toBe(false); // one request at a time
    t.receive(frame("t2", false, [rule()], 1));
    expect(t.controller.getState().dev).toMatchObject({ status: "ready", acting: null, open: 1 });
    expect(t.controller.devAction("r-1", "ignore")).toBe(true);
    expect(t.sent[1]).toEqual({ type: "dev_action", id: "t3", itemId: "r-1", action: "ignore" });
  });

  it("canManage: add_rule is only sent when the Core says this device may", () => {
    const t = ready(frame("t1", false));
    expect(t.controller.devAction("r-1", "add_rule")).toBe(false);
    expect(t.sent).toEqual([]);
    const m = ready(frame("t1", true));
    expect(m.controller.devAction("r-1", "add_rule")).toBe(true);
    expect(m.sent).toEqual([{ type: "dev_action", id: "t2", itemId: "r-1", action: "add_rule" }]);
  });

  it("T7.w.11.10: an HA urgency suggestion offers Kabul (accept) and Yok say (ignore) on any device", () => {
    const sug: DevItem = { ...note(), itemId: "h-1", kind: "ha_urgency", message: "HA uyarı türü “pn:x” acil sayılsın mı?" };
    const t = ready(frame("t1", false, [sug]));
    expect(devItemActions(sug, false)).toEqual(["accept", "ignore"]);
    expect(devItemActions({ ...sug, status: "ignored" }, true)).toEqual([]);
    expect(t.controller.devAction("h-1", "fixed")).toBe(false);
    expect(t.controller.devAction("h-1", "add_rule")).toBe(false);
    expect(t.controller.devAction("n-1", "accept")).toBe(false); // accept is only for suggestions
    expect(t.sent).toEqual([]);
    expect(t.controller.devAction("h-1", "accept")).toBe(true);
    expect(t.sent).toEqual([{ type: "dev_action", id: "t2", itemId: "h-1", action: "accept" }]);
    t.receive(frame("t2", false, [], 0));
    expect(t.controller.getState().dev).toMatchObject({ status: "ready", open: 0 });
    const u = ready(frame("t1", false, [sug]));
    expect(u.controller.devAction("h-1", "ignore")).toBe(true);
    expect(u.sent).toEqual([{ type: "dev_action", id: "t2", itemId: "h-1", action: "ignore" }]);
  });

  it("only actions valid for the listed item are sent", () => {
    const t = ready(frame("t1", true, [rule("active"), note("fixed"), { ...rule("suspended"), itemId: "r-2" }]));
    expect(t.controller.devAction("r-1", "add_rule")).toBe(false); // already active
    expect(t.controller.devAction("r-1", "ignore")).toBe(false);
    expect(t.controller.devAction("n-1", "ignore")).toBe(false); // already fixed
    expect(t.controller.devAction("n-1", "remove_rule")).toBe(false); // rules only
    expect(t.controller.devAction("r-2", "fixed")).toBe(false); // fixed is for notes
    expect(t.controller.devAction("r-2", "remove_rule")).toBe(false); // suspended: "Yok say", not "Kaldır"
    expect(t.controller.devAction("nope", "ignore")).toBe(false);
    expect(t.controller.devAction("", "ignore")).toBe(false);
    expect(t.sent).toEqual([]);
    expect(t.controller.devAction("r-2", "ignore")).toBe(true);
  });

  it("T7.w.8: remove_rule on an active rule and add_rule on a suspended one are sent only with canManage", () => {
    const items = [rule("active"), { ...rule("suspended"), itemId: "r-2" }];
    const t = ready(frame("t1", false, items));
    expect(t.controller.devAction("r-1", "remove_rule")).toBe(false);
    expect(t.controller.devAction("r-2", "add_rule")).toBe(false);
    expect(t.sent).toEqual([]);
    const m = ready(frame("t1", true, items));
    expect(m.controller.devAction("r-1", "remove_rule")).toBe(true);
    expect(m.sent).toEqual([{ type: "dev_action", id: "t2", itemId: "r-1", action: "remove_rule" }]);
    expect(m.controller.getState().dev).toMatchObject({ status: "loading", acting: { itemId: "r-1", action: "remove_rule" } });
    m.receive(frame("t2", true, [{ ...rule("suspended"), itemId: "r-2" }], 1));
    expect(m.controller.getState().dev).toMatchObject({ status: "ready", acting: null });
    expect(m.controller.devAction("r-2", "add_rule")).toBe(true);
    expect(m.sent[1]).toEqual({ type: "dev_action", id: "t3", itemId: "r-2", action: "add_rule" });
  });

  it("not_allowed / unknown_item stay in the panel (no chat notice) and keep the list", () => {
    const t = ready(frame("t1", true));
    t.controller.sendText("ışığı aç"); // a turn running meanwhile is not touched
    t.controller.devAction("r-1", "add_rule");
    t.receive({ type: "error", id: "t3", code: "not_allowed", message: "device may not add rules" });
    const s = t.controller.getState();
    expect(s.notice).toBeNull();
    expect(s.dev).toMatchObject({ status: "error", acting: null, errorCode: "not_allowed" });
    expect(s.dev.items).toHaveLength(2);
    expect(s.activeTurn?.id).toBe("t2");
    expect(t.controller.devAction("n-1", "ignore")).toBe(true); // can go on
    t.receive({ type: "error", id: "t4", code: "unknown_item", message: "gone" });
    expect(t.controller.getState().dev).toMatchObject({ status: "error", errorCode: "unknown_item" });
    expect(t.controller.getState().notice).toBeNull();
  });

  describe("with fake timers", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("no answer -> timeout error; a late answer still fills the panel", () => {
      const t = setup(undefined, ["dev"]);
      vi.advanceTimersByTime(DEV_TIMEOUT_MS - 1);
      expect(t.controller.getState().dev.status).toBe("loading");
      vi.advanceTimersByTime(1);
      expect(t.controller.getState().dev).toMatchObject({ status: "error", errorCode: "timeout" });
      t.receive(frame("t1"));
      expect(t.controller.getState().dev.status).toBe("ready");
    });

    it("a late error for a replaced request is dropped (no chat notice, panel unchanged)", () => {
      const t = setup(undefined, ["dev"]);
      vi.advanceTimersByTime(DEV_TIMEOUT_MS);
      expect(t.controller.requestDev()).toBe(true); // "Yenile" after the timeout: t2
      t.receive({ type: "error", id: "t1", code: "not_allowed", message: "late" });
      expect(t.controller.getState().notice).toBeNull();
      expect(t.controller.getState().dev).toMatchObject({ status: "loading", requestId: "t2" });
      t.receive(frame("t2"));
      t.receive({ type: "error", id: "t1", code: "unknown_item", message: "later" });
      expect(t.controller.getState().notice).toBeNull();
      expect(t.controller.getState().dev.status).toBe("ready");
    });

    it("an answer in time cancels the timeout; a dropped connection fails the request", () => {
      const t = ready();
      vi.advanceTimersByTime(DEV_TIMEOUT_MS * 2);
      expect(t.controller.getState().dev.status).toBe("ready");
      t.controller.requestDev();
      t.drop();
      expect(t.controller.getState().dev).toMatchObject({ status: "error", errorCode: "connection" });
    });
  });
});

describe("notification inbox (T7.w.5c)", () => {
  const item = (id: string, over: Partial<NotificationInfo> = {}): NotificationInfo => ({
    id,
    source: "test",
    urgency: "normal",
    title: `Başlık ${id}`,
    body: `Metin ${id}`,
    createdAt: "2026-11-07T18:00:00.000Z",
    updatedAt: "2026-11-07T18:00:00.000Z",
    readAt: null,
    raised: 1,
    ...over,
  });
  const list = (id: string, items: NotificationInfo[]): ServerMessage => ({
    type: "notifications",
    id,
    items,
    unread: items.filter((i) => i.readAt === null).length,
  });
  const READ = "2026-11-07T19:00:00.000Z";

  /**
   * Connected to a Core with `notifications` (+ `extra`), an in-memory storage
   * shared by every connection of this controller; the notifications_list sent
   * on welcome ("t1") is answered with `answer` (unless null).
   */
  function inbox(answer: NotificationInfo[] | null = [], extra: string[] = [], store = new Map<string, string>()) {
    const t = setup(undefined, undefined);
    t.adapter.storage.get = (k) => store.get(k) ?? null;
    t.adapter.storage.set = (k, v) => void store.set(k, v);
    t.adapter.storage.remove = (k) => void store.delete(k);
    let visible = true;
    t.adapter.isVisible = () => visible;
    // Reconnect with the feature now that the storage is in place.
    t.drop();
    t.connect(["notifications", ...extra]);
    const listId = () => {
      const last = [...t.sent].reverse().find((m) => m.type === "notifications_list");
      return last && "id" in last ? (last.id as string) : "";
    };
    if (answer) t.receive(list(listId(), answer));
    return {
      ...t,
      store,
      listId,
      setVisible: (v: boolean) => (visible = v),
      notified: () => (t.adapter.notify as ReturnType<typeof vi.fn>).mock.calls,
      badge: () => notificationsBadgeCount(t.controller.getState()),
      /** Drops and reconnects; answers the new list with `items`. */
      reconnect(items: NotificationInfo[]) {
        t.drop();
        t.sent.length = 0;
        t.connect(["notifications", ...extra]);
        t.receive(list(listId(), items));
      },
    };
  }

  it("without the feature: no notifications_list on welcome, no requests, no badge", () => {
    const t = setup(undefined, ["dev"]);
    expect(t.sentTypes()).not.toContain("notifications_list");
    expect(t.controller.requestNotifications()).toBe(false);
    t.receive({ type: "notification", item: item("n-1") });
    expect(notificationsBadgeCount(t.controller.getState())).toBe(0);
    expect(t.adapter.notify).not.toHaveBeenCalled();
  });

  it("list after welcome fills the inbox and the badge; broadcasts keep both current", () => {
    const t = inbox([item("n-1"), item("n-2", { readAt: READ })]);
    expect(t.controller.getState().notifications).toMatchObject({ status: "ready", unread: 1 });
    expect(t.badge()).toBe(1);
    t.receive({ type: "notification", item: item("n-3", { updatedAt: "2026-11-08T08:00:00.000Z" }) });
    expect(t.badge()).toBe(2);
    expect(t.controller.getState().notifications.items?.map((i) => i.id)).toEqual(["n-3", "n-1", "n-2"]);
    t.receive({ type: "notification", item: item("n-1", { readAt: READ }) }); // read on another device
    expect(t.badge()).toBe(1);
    t.receive({ type: "notification", item: item("n-1", { readAt: READ }) }); // repeated: no change
    expect(t.badge()).toBe(1);
    t.receive({ type: "notification_removed", notificationId: "n-3" });
    expect(t.badge()).toBe(0);
    t.receive({ type: "notification_removed", notificationId: "n-2" }); // a read one
    expect(t.badge()).toBe(0);
    expect(t.controller.getState().notifications.items?.map((i) => i.id)).toEqual(["n-1"]);
    t.receive({ type: "notification", item: item("n-4") });
    t.drop();
    expect(t.badge()).toBe(0); // gone while disconnected
  });

  it("read / unread / delete: one frame per user action, only when valid for the listed item", () => {
    const t = inbox([item("n-1"), item("n-2", { readAt: READ })]);
    t.sent.length = 0;
    expect(t.controller.notificationAction("n-1", "unread")).toBe(false); // already unread
    expect(t.controller.notificationAction("n-2", "read")).toBe(false); // already read
    expect(t.controller.notificationAction("nope", "delete")).toBe(false);
    expect(t.sent).toEqual([]);
    expect(t.controller.notificationAction("n-1", "read")).toBe(true);
    const id = "t2";
    expect(t.sent).toEqual([{ type: "notification_action", id, notificationId: "n-1", action: "read" }]);
    expect(t.controller.getState().notifications).toMatchObject({ status: "loading", acting: { notificationId: "n-1", action: "read" } });
    expect(t.controller.notificationAction("n-2", "delete")).toBe(false); // one request at a time
    t.receive({ type: "notification", item: item("n-1", { readAt: READ }) });
    t.receive(list(id, [item("n-1", { readAt: READ }), item("n-2", { readAt: READ })]));
    expect(t.controller.getState().notifications).toMatchObject({ status: "ready", acting: null, unread: 0 });
    expect(t.controller.notificationAction("n-2", "unread")).toBe(true);
    expect(t.sent[1]).toMatchObject({ type: "notification_action", notificationId: "n-2", action: "unread" });
    t.receive(list("t3", [item("n-1", { readAt: READ }), item("n-2")]));
    expect(t.controller.notificationAction("n-2", "delete")).toBe(true);
    expect(t.sent[2]).toMatchObject({ type: "notification_action", notificationId: "n-2", action: "delete" });
  });

  it("delete raced by another device: unknown_item after notification_removed is swallowed", () => {
    const t = inbox([item("n-1"), item("n-2")]);
    t.controller.notificationAction("n-1", "delete");
    t.receive({ type: "notification_removed", notificationId: "n-1" }); // the other device was first
    t.receive({ type: "error", id: "t2", code: "unknown_item", message: "gone" });
    const s = t.controller.getState();
    expect(s.notice).toBeNull();
    expect(s.notifications).toMatchObject({ status: "ready", acting: null, errorCode: null });
    expect(s.notifications.items?.map((i) => i.id)).toEqual(["n-2"]);
  });

  it("suppress (T7.w.11.8): not sent and not offered without notifications_suppress", () => {
    const t = inbox([item("n-1")]);
    expect(notificationsSuppressAvailable(t.controller.getState())).toBe(false);
    t.sent.length = 0;
    expect(t.controller.notificationAction("n-1", "suppress")).toBe(false);
    expect(t.sent).toEqual([]);
    // "Gördüm" (delete) stays available on an older Core.
    expect(t.controller.notificationAction("n-1", "delete")).toBe(true);
    expect(t.sent).toEqual([{ type: "notification_action", id: "t2", notificationId: "n-1", action: "delete" }]);
  });

  it("suppress with notifications_suppress: one frame; the item goes on notification_removed", () => {
    const t = inbox([item("n-1"), item("n-2", { readAt: READ })], ["notifications_suppress"]);
    expect(notificationsSuppressAvailable(t.controller.getState())).toBe(true);
    t.sent.length = 0;
    expect(t.controller.notificationAction("nope", "suppress")).toBe(false);
    expect(t.controller.notificationAction("n-2", "suppress")).toBe(true); // read or unread alike
    expect(t.sent).toEqual([{ type: "notification_action", id: "t2", notificationId: "n-2", action: "suppress" }]);
    expect(t.controller.getState().notifications).toMatchObject({ status: "loading", acting: { notificationId: "n-2", action: "suppress" } });
    t.receive({ type: "notification_removed", notificationId: "n-2" });
    t.receive(list("t2", [item("n-1")]));
    expect(t.controller.getState().notifications).toMatchObject({ status: "ready", acting: null, unread: 1 });
    expect(t.controller.getState().notifications.items?.map((i) => i.id)).toEqual(["n-1"]);
    // "Gördüm" next to it removes the same way.
    expect(t.controller.notificationAction("n-1", "delete")).toBe(true);
    expect(t.sent[1]).toMatchObject({ type: "notification_action", notificationId: "n-1", action: "delete" });
    t.receive({ type: "notification_removed", notificationId: "n-1" });
    expect(t.controller.getState().notifications.items).toEqual([]);
    expect(t.badge()).toBe(0);
  });

  it("suppress raced by another device: unknown_item after notification_removed is swallowed", () => {
    const t = inbox([item("n-1"), item("n-2")], ["notifications_suppress"]);
    t.controller.notificationAction("n-1", "suppress");
    t.receive({ type: "notification_removed", notificationId: "n-1" });
    t.receive({ type: "error", id: "t2", code: "unknown_item", message: "gone" });
    expect(t.controller.getState().notifications).toMatchObject({ status: "ready", acting: null, errorCode: null });
    expect(t.controller.getState().notifications.items?.map((i) => i.id)).toEqual(["n-2"]);
  });

  it("T7.w.11.10: urgent_yes / urgent_no only on ha items and only with ha_urgency_feedback", () => {
    const old = inbox([item("n-1", { source: "ha" })]);
    expect(notificationsUrgencyFeedbackAvailable(old.controller.getState())).toBe(false);
    old.sent.length = 0;
    expect(old.controller.notificationAction("n-1", "urgent_yes")).toBe(false);
    expect(old.controller.notificationAction("n-1", "urgent_no")).toBe(false);
    expect(old.sent).toEqual([]);

    const t = inbox([item("n-1", { source: "ha" }), item("n-2", { source: "service" })], ["ha_urgency_feedback"]);
    expect(notificationsUrgencyFeedbackAvailable(t.controller.getState())).toBe(true);
    t.sent.length = 0;
    expect(t.controller.notificationAction("n-2", "urgent_yes")).toBe(false); // not a Home Assistant item
    expect(t.controller.notificationAction("nope", "urgent_yes")).toBe(false);
    expect(t.sent).toEqual([]);
    expect(t.controller.notificationAction("n-1", "urgent_yes")).toBe(true);
    expect(t.sent).toEqual([{ type: "notification_action", id: "t2", notificationId: "n-1", action: "urgent_yes" }]);
    expect(t.controller.getState().notifications).toMatchObject({ status: "loading", acting: { notificationId: "n-1", action: "urgent_yes" } });
    expect(t.controller.getState().notifications.feedback ?? null).toBeNull(); // not before the Core's reply
    t.receive(list("t2", [item("n-1", { source: "ha" }), item("n-2", { source: "service" })]));
    expect(t.controller.getState().notifications).toMatchObject({
      status: "ready",
      acting: null,
      feedback: { notificationId: "n-1", action: "urgent_yes" },
    });
    expect(t.controller.getState().notifications.items).toHaveLength(2); // nothing removed
    expect(t.controller.notificationAction("n-1", "urgent_no")).toBe(true);
    expect(t.sent[1]).toEqual({ type: "notification_action", id: "t3", notificationId: "n-1", action: "urgent_no" });
    // A refusal (e.g. type not known yet) stays in the panel.
    t.receive({ type: "error", id: "t3", code: "not_allowed", message: "not yet" });
    expect(t.controller.getState().notifications).toMatchObject({
      status: "error",
      errorCode: "not_allowed",
      feedback: { notificationId: "n-1", action: "urgent_yes" }, // the refused urgent_no is never shown as saved
    });
    expect(t.controller.getState().notice).toBeNull();
  });

  it("other inbox errors stay in the panel (no chat notice) and keep the list", () => {
    const t = inbox([item("n-1")]);
    t.controller.notificationAction("n-1", "delete");
    t.receive({ type: "error", id: "t2", code: "unknown_item", message: "gone" }); // still listed: a real error
    expect(t.controller.getState().notice).toBeNull();
    expect(t.controller.getState().notifications).toMatchObject({ status: "error", errorCode: "unknown_item" });
    expect(t.controller.getState().notifications.items).toHaveLength(1);
    expect(t.controller.requestNotifications()).toBe(true);
    t.receive({ type: "error", id: "t3", code: "internal", message: "boom" });
    expect(t.controller.getState().notifications).toMatchObject({ status: "error", errorCode: "internal" });
    expect(t.controller.getState().notice).toBeNull();
  });

  it("urgent with speak: title + body spoken once through `speak`; never read, never again", async () => {
    const t = inbox([]);
    t.sent.length = 0;
    const urgent = item("n-9", { urgency: "urgent", title: "Kapı açık", body: "Bahçe kapısı açık kaldı" });
    t.receive({ type: "notification", item: urgent, speak: true });
    await flush();
    expect(t.sent).toEqual([{ type: "speak", id: "t2", text: "Kapı açık. Bahçe kapısı açık kaldı" }]);
    t.receive({ type: "speech", id: "t2", mime: "audio/wav", data: "AAAA" });
    expect(t.adapter.playback.play).toHaveBeenCalledTimes(1);
    expect(t.phase()).toBe("speaking");
    // Changed later without `speak` (e.g. read elsewhere), and after a reconnect: silent.
    t.receive({ type: "notification", item: { ...urgent, readAt: READ } });
    t.reconnect([urgent]);
    await flush();
    expect(t.sentTypes().filter((x) => x === "speak")).toEqual([]);
    expect(t.sentTypes()).not.toContain("notification_action");
    expect(t.controller.getState().notifications.items?.[0].readAt).toBeNull();
  });

  it("urgent speech waits for a running turn and follows once it is idle", async () => {
    const t = inbox([]);
    t.controller.sendText("merhaba");
    t.sent.length = 0;
    t.receive({ type: "notification", item: item("n-9", { urgency: "urgent", body: "" }), speak: true });
    await flush();
    expect(t.sentTypes()).toEqual([]);
    t.receive({ type: "state", state: "thinking" });
    t.receive({ type: "state", state: "idle" });
    await flush();
    expect(t.sent).toEqual([{ type: "speak", id: "t3", text: "Başlık n-9" }]);
  });

  it("urgent speech is skipped with voice replies off; a normal item is never spoken", async () => {
    const t = inbox([]);
    t.sent.length = 0;
    t.receive({ type: "notification", item: item("n-1") });
    t.controller.setVoiceReplies(false);
    t.receive({ type: "notification", item: item("n-2", { urgency: "urgent" }), speak: true });
    await flush();
    expect(t.sentTypes()).not.toContain("speak");
  });

  it("queued urgent items: voice replies off or Durdur drops them; push-to-talk keeps the mic clear", async () => {
    const urgent = (id: string): ServerMessage => ({ type: "notification", item: item(id, { urgency: "urgent" }), speak: true });
    const t = inbox([]);
    t.controller.sendText("merhaba"); // t2: the queue waits behind it
    t.receive(urgent("n-1"));
    t.controller.setVoiceReplies(false);
    t.controller.setVoiceReplies(true);
    t.receive({ type: "state", state: "thinking" });
    t.receive({ type: "state", state: "idle" });
    await flush();
    expect(t.sentTypes()).not.toContain("speak");

    // Two queued while one plays: Durdur stops it and drops the rest.
    t.sent.length = 0;
    t.receive(urgent("n-2"));
    t.receive(urgent("n-3"));
    await flush();
    expect(t.sentTypes()).toEqual(["speak"]);
    t.receive({ type: "speech", id: t.sent[0] && "id" in t.sent[0] ? (t.sent[0].id as string) : "", mime: "audio/wav", data: "AAAA" });
    t.controller.stop();
    await flush();
    expect(t.sentTypes().filter((x) => x === "speak")).toHaveLength(1);

    // Push-to-talk while one plays: the next one does not start under the open mic.
    t.sent.length = 0;
    t.receive(urgent("n-4"));
    t.receive(urgent("n-5"));
    await flush();
    const first = t.sent.find((m) => m.type === "speak");
    t.receive({ type: "speech", id: first && "id" in first ? (first.id as string) : "", mime: "audio/wav", data: "AAAA" });
    const talk = t.controller.startTalk();
    await flush();
    expect(t.sentTypes().filter((x) => x === "speak")).toHaveLength(1);
    await talk;
    expect(t.controller.getState().capture).toBe("recording");
  });

  it("streamed speech: an empty answer does not hold the queue; a silent final wakes it", async () => {
    const t = inbox([], ["speech_stream"]);
    // An empty streamed answer: no chunk will come for it.
    t.controller.sendText("merhaba"); // t2
    t.receive({ type: "assistant_done", id: "t2", text: "" });
    t.receive({ type: "state", state: "idle" });
    t.sent.length = 0;
    t.receive({ type: "notification", item: item("n-1", { urgency: "urgent" }), speak: true });
    await flush();
    expect(t.sentTypes()).toEqual(["speak"]);
    t.receive({ type: "error", id: t.sent[0] && "id" in t.sent[0] ? (t.sent[0].id as string) : "", code: "tts_unavailable", message: "x" });

    // An answer with text waits for its chunks; a final without audio releases the queue.
    t.controller.sendText("ikinci"); // a new turn
    const turn = [...t.sent].reverse().find((m) => m.type === "user_text");
    const turnId = turn && "id" in turn ? (turn.id as string) : "";
    t.receive({ type: "assistant_done", id: turnId, text: "Yanıt." });
    t.receive({ type: "state", state: "idle" });
    t.sent.length = 0;
    t.receive({ type: "notification", item: item("n-2", { urgency: "urgent" }), speak: true });
    await flush();
    expect(t.sentTypes()).toEqual([]);
    t.receive({ type: "speech_chunk", id: turnId, seq: 0, final: true });
    await flush();
    expect(t.sentTypes()).toEqual(["speak"]);
  });

  it("phone: a new item while hidden goes to notify (own id, urgency); in front it only counts as shown", () => {
    const t = inbox([]);
    t.setVisible(false);
    t.receive({ type: "notification", item: item("n-1") });
    t.receive({ type: "notification", item: item("n-2", { urgency: "urgent" }) });
    expect(t.notified()).toEqual([
      ["Başlık n-1", "Metin n-1", { id: "n-1", urgent: false }],
      ["Başlık n-2", "Metin n-2", { id: "n-2", urgent: true }],
    ]);
    t.receive({ type: "notification", item: item("n-1", { readAt: READ }) }); // read elsewhere
    t.receive({ type: "notification", item: item("n-1") }); // marked unread again: not a new raise
    expect(t.notified()).toHaveLength(2);
    t.receive({ type: "notification", item: item("n-1", { raised: 2 }) }); // raised again (renotify)
    expect(t.notified()).toHaveLength(3);
    t.setVisible(true);
    t.receive({ type: "notification", item: item("n-3") });
    expect(t.notified()).toHaveLength(3);
    t.reconnect([item("n-3"), item("n-2", { urgency: "urgent" }), item("n-1", { raised: 2 })]);
    expect(t.notified()).toHaveLength(3); // all of them were shown here already
  });

  it("catch-up on connect: each unread item not yet shown here, once, oldest first", () => {
    const store = new Map<string, string>();
    const items = [item("n-3"), item("n-2", { readAt: READ }), item("n-1", { urgency: "urgent" })];
    const t = inbox(items, [], store);
    expect(t.notified()).toEqual([
      ["Başlık n-1", "Metin n-1", { id: "n-1", urgent: true }],
      ["Başlık n-3", "Metin n-3", { id: "n-3", urgent: false }],
    ]);
    t.reconnect(items);
    expect(t.notified()).toHaveLength(2);
    // A new controller on the same device (app restarted): the record is kept.
    const again = inbox(items, [], store);
    expect(again.notified()).toEqual([]);
    // Raised again while away -> once more; the record keeps only listed items.
    t.reconnect([item("n-3", { raised: 2 })]);
    expect(t.notified()).toHaveLength(3);
    expect(JSON.parse(store.get("shadow.notificationsShown") ?? "{}")).toEqual({ "n-3": 2 });
    // Only the first list of a connection is a catch-up ("Yenile" is not).
    t.controller.requestNotifications();
    t.receive(list(t.listId(), [item("n-5")]));
    expect(t.notified()).toHaveLength(3);
  });

  it("catch-up: more than 3 normal items -> one summary; urgent ones on their own, on top, never spoken", () => {
    const store = new Map<string, string>();
    const items = [
      item("n-6", { urgency: "urgent" }),
      item("n-5"),
      item("n-4"),
      item("n-3", { readAt: READ }),
      item("n-2"),
      item("n-1"),
      item("n-0", { urgency: "urgent" }),
    ];
    const t = inbox(items, ["speech_stream"], store);
    expect(t.notified()).toEqual([
      ["4 yeni bildirim", "Ayrıntılar Bildirimler panelinde.", { id: CATCH_UP_SUMMARY_ID, urgent: false }],
      ["Başlık n-0", "Metin n-0", { id: "n-0", urgent: true }],
      ["Başlık n-6", "Metin n-6", { id: "n-6", urgent: true }],
    ]);
    expect(t.sentTypes()).not.toContain("speak");
    // The summarized items count as shown.
    expect(JSON.parse(store.get("shadow.notificationsShown") ?? "{}")).toEqual({
      "n-0": 1,
      "n-1": 1,
      "n-2": 1,
      "n-3": 1,
      "n-4": 1,
      "n-5": 1,
      "n-6": 1,
    });
    t.reconnect(items);
    expect(t.notified()).toHaveLength(3);
  });

  it("catch-up: 3 normal items (urgent ones not counted) are shown one by one", () => {
    const items = [item("n-4", { urgency: "urgent" }), item("n-3"), item("n-2"), item("n-1")];
    const t = inbox(items);
    expect(t.notified().map((c) => c[2])).toEqual([
      { id: "n-1", urgent: false },
      { id: "n-2", urgent: false },
      { id: "n-3", urgent: false },
      { id: "n-4", urgent: true },
    ]);
    // Only items not shown yet count: one new normal item later is shown on its own.
    t.reconnect([item("n-9"), ...items]);
    expect(t.notified().slice(4).map((c) => c[2])).toEqual([{ id: "n-9", urgent: false }]);
  });

  it("a damaged shown record reads as empty", () => {
    const store = new Map([["shadow.notificationsShown", "{not json"]]);
    const t = inbox([item("n-1")], [], store);
    expect(t.notified()).toHaveLength(1);
  });

  describe("with fake timers", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("notifications_unavailable: the inbox is unknown (\"!\" badge, not empty); a later list clears it; a timeout does not set it", () => {
      // The first list after welcome fails: nothing listed, no count, "!".
      const t = inbox(null);
      t.receive({ type: "error", id: t.listId(), code: "notifications_unavailable", message: "notifications could not be read" });
      let s = t.controller.getState();
      expect(s.notice).toBeNull();
      expect(s.notifications).toMatchObject({ status: "error", unavailable: true, items: null, unread: null });
      expect(notificationsUnavailable(s)).toBe(true);
      expect(t.badge()).toBe(0);
      // Still unknown while the next request runs, and after it times out.
      expect(t.controller.requestNotifications()).toBe(true);
      expect(notificationsUnavailable(t.controller.getState())).toBe(true);
      vi.advanceTimersByTime(NOTIFICATIONS_TIMEOUT_MS);
      expect(t.controller.getState().notifications).toMatchObject({ errorCode: "timeout", unavailable: true });
      // The Core can read it again: the list clears the flag and runs the catch-up.
      expect(t.controller.requestNotifications()).toBe(true);
      t.receive(list(t.listId(), [item("n-1")]));
      s = t.controller.getState();
      expect(s.notifications).toMatchObject({ status: "ready", unavailable: false, unread: 1 });
      expect(notificationsUnavailable(s)).toBe(false);
      expect(t.badge()).toBe(1);
      // An action answered the same way sets it again and keeps the shown items.
      t.controller.notificationAction("n-1", "read");
      t.receive({ type: "error", id: t.controller.getState().notifications.requestId ?? "", code: "notifications_unavailable" });
      s = t.controller.getState();
      expect(s.notifications).toMatchObject({ status: "error", unavailable: true, acting: null });
      expect(s.notifications.items?.map((i) => i.id)).toEqual(["n-1"]);
      // A reconnect starts from scratch (the list after welcome decides again).
      t.drop();
      expect(notificationsUnavailable(t.controller.getState())).toBe(false);
    });

    it("while unavailable the inbox is asked for again every minute until it answers; a drop stops it (T7.w.13)", () => {
      const t = inbox(null);
      const lists = () => t.sent.filter((m) => m.type === "notifications_list").length;
      t.receive({ type: "error", id: t.listId(), code: "notifications_unavailable" });
      expect(lists()).toBe(1);
      vi.advanceTimersByTime(NOTIFICATIONS_RETRY_MS - 1);
      expect(lists()).toBe(1);
      vi.advanceTimersByTime(1);
      expect(lists()).toBe(2);
      // Still unreadable: the next minute asks again.
      t.receive({ type: "error", id: t.listId(), code: "notifications_unavailable" });
      vi.advanceTimersByTime(NOTIFICATIONS_RETRY_MS);
      expect(lists()).toBe(3);
      // Readable again: "!" clears, the badge shows the count, no more retries.
      t.receive(list(t.listId(), [item("n-1")]));
      expect(notificationsUnavailable(t.controller.getState())).toBe(false);
      expect(t.badge()).toBe(1);
      vi.advanceTimersByTime(NOTIFICATIONS_RETRY_MS * 3);
      expect(lists()).toBe(3);
      // Unavailable again, then the socket drops: no request after the drop.
      t.controller.requestNotifications();
      t.receive({ type: "error", id: t.listId(), code: "notifications_unavailable" });
      expect(lists()).toBe(4);
      t.drop();
      vi.advanceTimersByTime(NOTIFICATIONS_RETRY_MS * 3);
      expect(lists()).toBe(4);
    });

    it("a timeout or another error never marks the inbox unavailable", () => {
      const t = inbox(null);
      vi.advanceTimersByTime(NOTIFICATIONS_TIMEOUT_MS);
      expect(t.controller.getState().notifications).toMatchObject({ errorCode: "timeout", unavailable: false });
      expect(t.controller.requestNotifications()).toBe(true);
      t.receive({ type: "error", id: t.listId(), code: "internal" });
      expect(t.controller.getState().notifications).toMatchObject({ errorCode: "internal", unavailable: false });
    });

    it("no answer -> timeout error; a late answer still fills the inbox and runs the catch-up", () => {
      const t = inbox(null);
      vi.advanceTimersByTime(NOTIFICATIONS_TIMEOUT_MS);
      expect(t.controller.getState().notifications).toMatchObject({ status: "error", errorCode: "timeout" });
      t.receive(list(t.listId(), [item("n-1")]));
      expect(t.controller.getState().notifications.status).toBe("ready");
      expect(t.notified()).toHaveLength(1);
    });

    it("a dropped connection fails the request and drops pending urgent speech", () => {
      const t = inbox([]);
      t.controller.sendText("merhaba");
      t.receive({ type: "notification", item: item("n-9", { urgency: "urgent" }), speak: true });
      t.controller.requestNotifications();
      t.drop();
      expect(t.controller.getState().notifications).toMatchObject({ status: "error", errorCode: "connection" });
      t.sent.length = 0;
      t.connect(["notifications"]);
      t.receive(list(t.listId(), []));
      expect(t.sentTypes()).not.toContain("speak");
    });
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
