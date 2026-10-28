import { describe, expect, it } from "vitest";
import type { ServerMessage, ServiceHealth } from "../protocol/types.ts";
import {
  bargeInTarget,
  canStop,
  currentConfirm,
  derivePhase,
  initialState,
  reducer,
  shouldPlaySpeech,
  type Action,
  type AssistantState,
} from "./state.ts";

const connected: AssistantState = reducer(initialState, { type: "status", ev: { status: "connected", attempt: 0 } });

const run = (actions: Action[], from: AssistantState = connected) => actions.reduce(reducer, from);
const srv = (msg: ServerMessage): Action => ({ type: "server", msg });

describe("derivePhase — five visible states", () => {
  it("idle by default", () => {
    expect(derivePhase(connected)).toBe("idle");
  });

  it("listening while the mic is starting or recording", () => {
    expect(derivePhase(run([{ type: "capture", state: "starting" }]))).toBe("listening");
    expect(derivePhase(run([{ type: "capture", state: "recording" }]))).toBe("listening");
  });

  it("thinking from the Core state, an unanswered turn, a pending clip or an encoding utterance", () => {
    expect(derivePhase(run([srv({ type: "state", state: "thinking" })]))).toBe("thinking");
    expect(derivePhase(run([{ type: "user_text_sent", id: "t1", text: "x" }]))).toBe("thinking");
    expect(derivePhase(run([{ type: "speech_requested", id: "t1" }]))).toBe("thinking");
    expect(derivePhase(run([{ type: "capture", state: "sending" }]))).toBe("thinking");
  });

  it("speaking while a reply plays", () => {
    expect(derivePhase(run([{ type: "playback_started", id: "t1" }]))).toBe("speaking");
  });

  it("awaiting_confirm from the Core state or a pending confirm card", () => {
    expect(derivePhase(run([srv({ type: "state", state: "awaiting_confirm" })]))).toBe("awaiting_confirm");
    expect(
      derivePhase(
        run([srv({ type: "confirm_request", requestId: "c1", id: "t1", tool: "lock", summary: "s", expiresAt: 1 })]),
      ),
    ).toBe("awaiting_confirm");
  });

  it("listening wins over awaiting_confirm (answering by voice)", () => {
    const s = run([
      srv({ type: "confirm_request", requestId: "c1", id: "t1", tool: "lock", summary: "s", expiresAt: 1 }),
      { type: "capture", state: "recording" },
    ]);
    expect(derivePhase(s)).toBe("listening");
  });

  it("all five phases are distinct outcomes", () => {
    const phases = new Set([
      derivePhase(connected),
      derivePhase(run([{ type: "capture", state: "recording" }])),
      derivePhase(run([srv({ type: "state", state: "thinking" })])),
      derivePhase(run([{ type: "playback_started", id: "t" }])),
      derivePhase(run([srv({ type: "state", state: "awaiting_confirm" })])),
    ]);
    expect(phases.size).toBe(5);
  });
});

describe("turn lifecycle", () => {
  it("streams deltas into one assistant message and finalises on done", () => {
    const s = run([
      { type: "user_text_sent", id: "t1", text: "selam" },
      srv({ type: "state", state: "thinking" }),
      srv({ type: "assistant_delta", id: "t1", text: "Mer" }),
      srv({ type: "assistant_delta", id: "t1", text: "haba" }),
    ]);
    const a = s.messages.find((m) => m.key === "t1:assistant");
    expect(a).toMatchObject({ text: "Merhaba", pending: true });
    const done = run([srv({ type: "assistant_done", id: "t1", text: "Merhaba!" }), srv({ type: "state", state: "idle" })], s);
    expect(done.messages.find((m) => m.key === "t1:assistant")).toMatchObject({ text: "Merhaba!", pending: false });
    expect(done.messages.find((m) => m.key === "t1:user")?.text).toBe("selam");
    expect(done.activeTurn).toBeNull();
    expect(derivePhase(done)).toBe("idle");
  });

  it("fills the user bubble from the transcript of an audio turn", () => {
    const s = run([{ type: "audio_sent", id: "t2" }]);
    expect(s.messages[0]).toMatchObject({ key: "t2:user", text: "", pending: true });
    expect(s.capture).toBe("off");
    const t = run([srv({ type: "transcript", id: "t2", text: "ışığı aç" })], s);
    expect(t.messages[0]).toMatchObject({ text: "ışığı aç", pending: false });
  });

  it("a state:idle that arrives before any activity for the new turn does not end it", () => {
    // barge-in: cancel(t1) then audio(t2); the Core's idle for t1 arrives after t2 was sent
    const s = run([{ type: "audio_sent", id: "t2" }, srv({ type: "state", state: "idle" })]);
    expect(s.activeTurn?.id).toBe("t2");
    expect(derivePhase(s)).toBe("thinking");
    const after = run([srv({ type: "transcript", id: "t2", text: "x" }), srv({ type: "state", state: "idle" })], s);
    expect(after.activeTurn).toBeNull();
  });

  it("records tool status on the assistant message, replacing older status of the same tool", () => {
    const s = run([
      srv({ type: "tool", id: "t1", name: "light.on", status: "started" }),
      srv({ type: "tool", id: "t1", name: "light.on", status: "done" }),
    ]);
    expect(s.messages[0].tools).toEqual([{ name: "light.on", status: "done" }]);
  });

  it("an error with a turn id ends that turn and marks its pending messages", () => {
    const s = run([
      { type: "audio_sent", id: "t3" },
      srv({ type: "error", id: "t3", code: "stt_unavailable", message: "down" }),
    ]);
    expect(s.activeTurn).toBeNull();
    expect(s.notice).toEqual({ code: "stt_unavailable", message: "down", turnId: "t3" });
    expect(s.messages[0]).toMatchObject({ pending: false, failed: true });
    expect(derivePhase(s)).toBe("idle");
  });

  it("tts_unavailable clears the pending speech request", () => {
    const s = run([{ type: "speech_requested", id: "t1" }, srv({ type: "error", id: "t1", code: "tts_unavailable" })]);
    expect(s.awaitingSpeech).toBeNull();
    expect(derivePhase(s)).toBe("idle");
  });

  it("history replaces the list", () => {
    const s = run([srv({ type: "history", items: [{ id: "h", role: "assistant", text: "x", ts: 5 }] })]);
    expect(s.historyLoaded).toBe(true);
    expect(s.history).toHaveLength(1);
  });

  it("losing the connection clears server-side work in flight", () => {
    const s = run([
      { type: "user_text_sent", id: "t1", text: "x" },
      srv({ type: "confirm_request", requestId: "c1", id: "t1", tool: "lock", summary: "s", expiresAt: 1 }),
      { type: "speech_requested", id: "t0" },
      { type: "status", ev: { status: "reconnecting", attempt: 1, retryInMs: 1000 } },
    ]);
    expect(s.confirms).toEqual([]);
    expect(s.activeTurn).toBeNull();
    expect(s.awaitingSpeech).toBeNull();
    expect(derivePhase(s)).toBe("idle");
  });
});

describe("confirm flow", () => {
  const request = srv({
    type: "confirm_request",
    requestId: "c1",
    id: "t1",
    tool: "lock.unlock",
    summary: "Ön kapı açılsın mı?",
    expiresAt: 123,
  });

  it("stores the request, marks a button answer as responding, closes on confirm_resolved", () => {
    let s = run([request]);
    expect(s.confirms[0]).toMatchObject({ requestId: "c1", tool: "lock.unlock", responding: false });
    s = run([{ type: "confirm_sent", requestId: "c1" }], s);
    expect(s.confirms[0]?.responding).toBe(true);
    s = run([srv({ type: "confirm_resolved", requestId: "c1", approved: true, by: "button" })], s);
    expect(s.confirms).toEqual([]);
    expect(s.lastResolved).toEqual({ requestId: "c1", approved: true, by: "button" });
  });

  it("closes the card when answered by voice", () => {
    const s = run([request, srv({ type: "confirm_resolved", requestId: "c1", approved: false, by: "voice" })]);
    expect(s.confirms).toEqual([]);
    expect(s.lastResolved?.by).toBe("voice");
  });

  it("closes the card on timeout", () => {
    const s = run([request, srv({ type: "confirm_resolved", requestId: "c1", approved: false, by: "timeout" })]);
    expect(s.confirms).toEqual([]);
  });

  it("ignores a confirm_resolved for another request", () => {
    const s = run([request, srv({ type: "confirm_resolved", requestId: "other", approved: true, by: "button" })]);
    expect(s.confirms[0]?.requestId).toBe("c1");
  });

  it("drops a confirm_request for a turn the user already cancelled", () => {
    const s = run([
      { type: "user_text_sent", id: "t1", text: "kilidi aç" },
      { type: "barge_in", turnId: "t1" },
      request,
      srv({ type: "confirm_resolved", requestId: "c1", approved: false, by: "button" }),
    ]);
    expect(s.confirms).toEqual([]);
    expect(s.lastResolved).toBeNull();
    expect(derivePhase(s)).toBe("idle");
  });

  it("is not a barge-in target (the user may be answering by voice)", () => {
    const s = run([{ type: "user_text_sent", id: "t1", text: "kilidi aç" }, request]);
    expect(bargeInTarget(s)).toBeNull();
  });

  it("hides the stop button while a confirm is pending (also before its confirm_request arrives)", () => {
    const thinking = run([{ type: "user_text_sent", id: "t1", text: "kilidi aç" }, srv({ type: "state", state: "thinking" })]);
    expect(canStop(thinking)).toBe(true);
    expect(canStop(run([srv({ type: "state", state: "awaiting_confirm" })], thinking))).toBe(false);
    expect(canStop(run([request], thinking))).toBe(false);
    expect(canStop(run([request, { type: "confirm_sent", requestId: "c1" }], thinking))).toBe(false);
  });
});

describe("stop button (canStop)", () => {
  it("shown while speaking or while a turn is running; hidden when idle, recording, or encoding with nothing to stop", () => {
    expect(canStop(connected)).toBe(false);
    expect(canStop(run([{ type: "user_text_sent", id: "t1", text: "x" }]))).toBe(true);
    expect(canStop(run([{ type: "playback_started", id: "t1" }]))).toBe(true);
    expect(canStop(run([{ type: "user_text_sent", id: "t1", text: "x" }, { type: "capture", state: "recording" }]))).toBe(false);
    expect(canStop(run([{ type: "capture", state: "sending" }]))).toBe(false);
  });
});

describe("incompatible protocol (close 4400)", () => {
  it("drops the id-less bad_request notice that precedes it; only the banner remains", () => {
    const s = run(
      [
        srv({ type: "error", code: "bad_request", message: "Desteklenmeyen protokol sürümü" }),
        { type: "status", ev: { status: "incompatible", attempt: 0 } },
      ],
      initialState,
    );
    expect(s.connection.status).toBe("incompatible");
    expect(s.notice).toBeNull();
  });

  it("keeps a turn-scoped notice (not about the handshake)", () => {
    const s = run([
      srv({ type: "error", id: "t1", code: "model_error", message: "x" }),
      { type: "status", ev: { status: "incompatible", attempt: 0 } },
    ]);
    expect(s.notice?.code).toBe("model_error");
  });
});

describe("barge-in", () => {
  it("targets the playing turn, then a pending clip, then the active turn", () => {
    expect(bargeInTarget(run([{ type: "playback_started", id: "p" }]))).toBe("p");
    expect(bargeInTarget(run([{ type: "speech_requested", id: "s" }]))).toBe("s");
    expect(bargeInTarget(run([{ type: "user_text_sent", id: "a", text: "x" }]))).toBe("a");
    expect(bargeInTarget(connected)).toBeNull();
  });

  it("stops speaking, drops late deltas/done and refuses late speech for the cancelled turn", () => {
    let s = run([
      { type: "user_text_sent", id: "t1", text: "uzun anlat" },
      srv({ type: "assistant_delta", id: "t1", text: "Bir " }),
      { type: "barge_in", turnId: "t1" },
    ]);
    expect(s.activeTurn).toBeNull();
    expect(s.messages.find((m) => m.key === "t1:assistant")).toMatchObject({ cancelled: true, pending: false });
    s = run([srv({ type: "assistant_delta", id: "t1", text: "iki" }), srv({ type: "assistant_done", id: "t1", text: "Bir iki" })], s);
    expect(s.messages.find((m) => m.key === "t1:assistant")?.text).toBe("Bir ");
    expect(shouldPlaySpeech(s, "t1")).toBe(false);
  });

  it("clears speaking immediately", () => {
    const s = run([{ type: "playback_started", id: "t1" }, { type: "barge_in", turnId: "t1" }]);
    expect(s.playing).toBeNull();
    expect(derivePhase(s)).toBe("idle");
  });

  it("only plays speech that was requested", () => {
    const s = run([{ type: "speech_requested", id: "t1" }]);
    expect(shouldPlaySpeech(s, "t1")).toBe(true);
    expect(shouldPlaySpeech(s, "t9")).toBe(false);
  });
});

describe("several confirms, voice answers", () => {
  const req = (requestId: string, id = "t1") =>
    srv({ type: "confirm_request", requestId, id, tool: "lock", summary: requestId, expiresAt: 1 });

  it("shows the oldest pending confirm; the next one appears when it resolves", () => {
    let s = run([req("c1"), req("c2")]);
    expect(currentConfirm(s)?.requestId).toBe("c1");
    s = run([srv({ type: "confirm_resolved", requestId: "c1", approved: true, by: "voice" })], s);
    expect(currentConfirm(s)?.requestId).toBe("c2");
    expect(derivePhase(s)).toBe("awaiting_confirm");
  });

  it("an utterance during a confirm is a voice answer, not a new active turn", () => {
    let s = run([{ type: "user_text_sent", id: "t1", text: "kilidi aç" }, req("c1"), { type: "audio_sent", id: "t2" }]);
    expect(s.voiceAnswer).toBe("t2");
    expect(s.activeTurn?.id).toBe("t1");
    s = run([srv({ type: "transcript", id: "t2", text: "evet" })], s);
    expect(s.activeTurn?.id).toBe("t1");
    expect(s.voiceAnswer).toBe("t2");
    s = run([srv({ type: "confirm_resolved", requestId: "c1", approved: true, by: "voice" })], s);
    expect(s.voiceAnswer).toBeNull();
    expect(s.confirms).toEqual([]);
    expect(s.activeTurn?.id).toBe("t1");
  });

  it("busy for a voice answer keeps the confirm and asks for yes/no", () => {
    const s = run([
      { type: "user_text_sent", id: "t1", text: "kilidi aç" },
      req("c1"),
      { type: "audio_sent", id: "t2" },
      srv({ type: "transcript", id: "t2", text: "bilmem" }),
      srv({ type: "error", id: "t2", code: "busy" }),
    ]);
    expect(s.notice?.code).toBe("not_an_answer");
    expect(s.voiceAnswer).toBeNull();
    expect(s.activeTurn?.id).toBe("t1");
    expect(currentConfirm(s)?.requestId).toBe("c1");
  });

  it("a voice answer that the Core turned into a new turn becomes the active turn", () => {
    const s = run([
      req("c1"),
      { type: "audio_sent", id: "t2" },
      srv({ type: "confirm_resolved", requestId: "c1", approved: false, by: "timeout" }),
      srv({ type: "state", state: "idle" }),
      srv({ type: "assistant_delta", id: "t2", text: "Tamam" }),
    ]);
    expect(s.voiceAnswer).toBeNull();
    expect(s.activeTurn).toEqual({ id: "t2", seen: true });
  });
});

describe("voice answer turned into a new turn", () => {
  it("is owned as soon as the Core reports thinking for it", () => {
    const s = run([
      { type: "user_text_sent", id: "t1", text: "kilidi aç" },
      srv({ type: "state", state: "thinking" }),
      srv({ type: "confirm_request", requestId: "c1", id: "t1", tool: "lock", summary: "s", expiresAt: 1 }),
      { type: "audio_sent", id: "t2" },
      srv({ type: "confirm_resolved", requestId: "c1", approved: false, by: "timeout" }),
      srv({ type: "assistant_done", id: "t1", text: "Yapmadım." }),
      srv({ type: "state", state: "idle" }),
      srv({ type: "transcript", id: "t2", text: "evet" }),
      srv({ type: "state", state: "thinking" }),
    ]);
    expect(s.activeTurn).toEqual({ id: "t2", seen: true });
    expect(s.voiceAnswer).toBeNull();
    expect(bargeInTarget(s)).toBe("t2");
  });
});

describe("queued turns", () => {
  it("a queued turn is not active until it is actually sent", () => {
    let s = run([{ type: "user_text_sent", id: "t2", text: "x", queued: true }]);
    expect(s.queuedTurn).toBe("t2");
    expect(s.activeTurn).toBeNull();
    expect(derivePhase(s)).toBe("thinking");
    s = run([{ type: "queued_turn_sent", id: "t2" }], s);
    expect(s.queuedTurn).toBeNull();
    expect(s.activeTurn).toEqual({ id: "t2", seen: false });
  });

  it("a dropped or disconnected queued turn is marked failed", () => {
    const dropped = run([{ type: "user_text_sent", id: "t2", text: "x", queued: true }, { type: "queued_turn_dropped", id: "t2" }]);
    expect(dropped.messages[0]).toMatchObject({ failed: true, pending: false });
    const lost = run([
      { type: "user_text_sent", id: "t3", text: "y", queued: true },
      { type: "status", ev: { status: "reconnecting", attempt: 1, retryInMs: 500 } },
    ]);
    expect(lost.queuedTurn).toBeNull();
    expect(lost.messages[0]).toMatchObject({ failed: true });
  });

  it("barge-in on a queued turn drops it and marks it cancelled", () => {
    const s = run([{ type: "user_text_sent", id: "t2", text: "x", queued: true }]);
    expect(bargeInTarget(s)).toBe("t2");
    const after = run([{ type: "barge_in", turnId: "t2" }], s);
    expect(after.queuedTurn).toBeNull();
    expect(after.messages[0]).toMatchObject({ cancelled: true });
    expect(derivePhase(after)).toBe("idle");
  });
});

describe("service health", () => {
  const items: ServiceHealth[] = [
    { name: "whisper-svc", status: "down", checkedAt: 1, detail: "timeout" },
    { name: "tts-svc", status: "ok", checkedAt: 1 },
  ];

  it("starts empty and stores the latest services frame", () => {
    expect(connected.services).toEqual([]);
    const s = run([srv({ type: "services", items: [...items] })]);
    expect(s.services).toEqual(items);
    const s2 = run([srv({ type: "services", items: [{ name: "whisper-svc", status: "ok", checkedAt: 2 }] })], s);
    expect(s2.services).toEqual([{ name: "whisper-svc", status: "ok", checkedAt: 2 }]);
  });

  it("is cleared by a new welcome (the Core resends its list)", () => {
    const s = run([
      srv({ type: "services", items: [...items] }),
      srv({ type: "welcome", protocol: 1, sessionId: "s2", device: "d" }),
    ]);
    expect(s.services).toEqual([]);
  });

  it("does not touch the turn or the phase", () => {
    const s = run([{ type: "user_text_sent", id: "t1", text: "selam" }, srv({ type: "services", items: [...items] })]);
    expect(derivePhase(s)).toBe("thinking");
  });
});
