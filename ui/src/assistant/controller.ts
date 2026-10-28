/**
 * AssistantController: wires the Core client, the platform adapter and the
 * state reducer together. All side effects (sending frames, microphone,
 * playback, haptics) live here; React only renders `getState()`.
 *
 * Framework-free so the flows (push-to-talk, barge-in, confirm, speech) can be
 * unit-tested with a fake adapter and a fake socket.
 */
import { CoreClient, type CoreClientOptions, type StatusEvent } from "../protocol/client.ts";
import type { ClientMessage, ServerMessage } from "../protocol/types.ts";
import { toPlatformError, type PlatformAdapter } from "../platform/types.ts";
import {
  bargeInTarget,
  canPreviewVoice,
  confirmPending,
  currentConfirm,
  initialState,
  isCancelled,
  reducer,
  shouldPlaySpeech,
  type Action,
  type AssistantState,
} from "./state.ts";

/** Taps shorter than this are treated as accidental and not sent. */
export const MIN_UTTERANCE_MS = 300;
/** Push-to-talk auto-stops after this long. */
export const MAX_UTTERANCE_MS = 60_000;
/** tts-svc rejects longer texts (413). */
export const MAX_SPEAK_CHARS = 2000;
export const HISTORY_LIMIT = 20;
/**
 * After cancelling a running server turn, a new turn frame waits this long at
 * most for the Core's `state: idle`. The Core aborts asynchronously and
 * answers `busy` to a new turn until the old one has wound down.
 */
export const CANCEL_SETTLE_MS = 2_000;
/**
 * A `voices` request without an answer after this long is shown as
 * unavailable (e.g. an older Core that does not know the frame). A late answer
 * still fills the list.
 */
export const VOICES_TIMEOUT_MS = 8_000;
/** Spoken by the "Dene" button in the voice picker. */
export const VOICE_SAMPLE_TEXT = "Merhaba, ben Shadow. Sesim kulağına nasıl geliyor?";

type TurnFrame = Extract<ClientMessage, { type: "user_text" } | { type: "audio" }>;

export interface CoreClientLike {
  start(): void;
  stop(): void;
  reconnectNow(): void;
  send(msg: Exclude<ClientMessage, { type: "hello" }>): boolean;
}

export type ControllerDeps = {
  adapter: PlatformAdapter;
  clientVersion: string;
  createClient?: (opts: CoreClientOptions) => CoreClientLike;
  newId?: () => string;
};

let idSeq = 0;
const defaultNewId = () => `t${Date.now().toString(36)}${(++idSeq).toString(36)}`;

/** Cuts long replies for TTS at a sentence/word boundary when possible. */
export function clipForSpeech(text: string, max = MAX_SPEAK_CHARS): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const cut = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (cut > max * 0.5) return head.slice(0, cut + 1);
  const space = head.lastIndexOf(" ");
  return space > 0 ? head.slice(0, space) : head;
}

export class AssistantController {
  private state: AssistantState = initialState;
  private readonly listeners = new Set<() => void>();
  private readonly adapter: PlatformAdapter;
  private readonly deps: ControllerDeps;
  private readonly newId: () => string;
  private client: CoreClientLike | null = null;
  private releaseRequested = false;
  /**
   * Bumped by every start/cancel of a recording. An async mic step whose
   * generation is no longer current was cancelled meanwhile and must not
   * change state or send anything.
   */
  private captureGen = 0;
  /**
   * A `mic.start()` call has not settled yet (even if its recording was
   * cancelled meanwhile). No new recording may start until it does: the stale
   * start, once it settles, releases the mic with `mic.cancel()`, which on the
   * host is not tied to a request and would kill a newer recording.
   */
  private micStartInFlight = false;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  /** Speak assistant replies aloud (user setting). */
  private voiceReplies = true;
  /** A server turn was cancelled and its `state: idle` has not arrived yet. */
  private cancelling = false;
  private queuedTurn: TurnFrame | null = null;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** tts-svc voice for `speak` (user setting); null = the Core's default. */
  private voice: string | null = null;
  private voicesTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(deps: ControllerDeps) {
    this.deps = deps;
    this.adapter = deps.adapter;
    this.newId = deps.newId ?? defaultNewId;
  }

  // --- store interface (useSyncExternalStore) ------------------------------

  getState = (): AssistantState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private dispatch(action: Action): void {
    const next = reducer(this.state, action);
    if (next === this.state) return;
    this.state = next;
    for (const l of this.listeners) l();
  }

  private get connected(): boolean {
    return this.state.connection.status === "connected";
  }

  // --- connection ------------------------------------------------------------

  connect(url: string, token: string): void {
    this.client?.stop();
    this.resetCancelling();
    const create = this.deps.createClient ?? ((o: CoreClientOptions) => new CoreClient(o));
    const client = create({
      url,
      token,
      client: this.adapter.clientKind,
      clientVersion: this.deps.clientVersion,
      onMessage: (msg) => {
        if (this.client === client) this.handleServer(msg);
      },
      onStatus: (ev: StatusEvent) => {
        if (this.client !== client) return;
        // A queued turn cannot survive a dropped socket; the reducer marks it failed.
        if (ev.status !== "connected") this.resetCancelling();
        this.dispatch({ type: "status", ev });
      },
    });
    this.client = client;
    client.start();
  }

  disconnect(): void {
    const c = this.client;
    this.client = null;
    c?.stop();
    this.dispatch({ type: "status", ev: { status: "closed", attempt: 0 } });
  }

  /** Called when the app returns to the foreground. */
  resume(): void {
    this.client?.reconnectNow();
  }

  dispose(): void {
    this.disconnect();
    this.cancelTalk();
    this.resetCancelling();
    this.clearVoicesTimer();
    this.stopLocalAudio();
  }

  private send(msg: Exclude<ClientMessage, { type: "hello" }>): boolean {
    if (this.client?.send(msg)) return true;
    this.dispatch({ type: "notice", notice: { code: "not_connected" } });
    return false;
  }

  // --- user actions ------------------------------------------------------------

  sendText(text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    if (!this.connected) {
      this.dispatch({ type: "notice", notice: { code: "not_connected" } });
      return false;
    }
    // The Core only checks spoken answers against a pending confirm; typed text
    // would just be refused as `busy`.
    if (confirmPending(this.state)) {
      this.dispatch({ type: "notice", notice: { code: "confirm_pending" } });
      return false;
    }
    // Typing wins over a recording in progress: it would otherwise be sent as
    // a second turn without a barge-in.
    this.cancelTalk();
    this.adapter.playback.unlock();
    this.bargeIn();
    const id = this.newId();
    const sent = this.sendTurn({ type: "user_text", id, text: t });
    if (!sent) return false;
    this.dispatch({ type: "user_text_sent", id, text: t, queued: sent === "queued" });
    return true;
  }

  /** Push-to-talk pressed. Barges in on anything in flight first. */
  async startTalk(): Promise<void> {
    if (this.state.capture !== "off" || this.micStartInFlight) return;
    this.adapter.playback.unlock();
    this.bargeIn();
    this.releaseRequested = false;
    const gen = ++this.captureGen;
    this.dispatch({ type: "capture", state: "starting" });
    this.micStartInFlight = true;
    try {
      await this.adapter.mic.start();
    } catch (err) {
      if (gen !== this.captureGen) return;
      this.micFailed(err);
      return;
    } finally {
      this.micStartInFlight = false;
    }
    if (gen !== this.captureGen) {
      // Cancelled while the mic was starting.
      this.adapter.mic.cancel();
      return;
    }
    this.dispatch({ type: "capture", state: "recording" });
    this.adapter.vibrate([12]);
    this.maxTimer = setTimeout(() => void this.stopTalk(), MAX_UTTERANCE_MS);
    if (this.releaseRequested) await this.stopTalk();
  }

  /** Push-to-talk released: encode and send the utterance. */
  async stopTalk(): Promise<void> {
    if (this.state.capture === "starting") {
      this.releaseRequested = true;
      return;
    }
    if (this.state.capture !== "recording") return;
    this.clearMaxTimer();
    const gen = this.captureGen;
    this.dispatch({ type: "capture", state: "sending" });
    let utterance;
    try {
      utterance = await this.adapter.mic.stop();
    } catch (err) {
      if (gen !== this.captureGen) return;
      this.micFailed(err);
      return;
    }
    if (gen !== this.captureGen) return; // cancelled while encoding: do not send
    // durationMs 0 means "unknown" (a host that does not measure it).
    if (!utterance.data || (utterance.durationMs > 0 && utterance.durationMs < MIN_UTTERANCE_MS)) {
      this.dispatch({ type: "capture", state: "off" });
      this.dispatch({ type: "notice", notice: { code: "too_short" } });
      return;
    }
    const id = this.newId();
    const sent = this.sendTurn({ type: "audio", id, mime: utterance.mime, data: utterance.data });
    if (!sent) {
      this.dispatch({ type: "capture", state: "off" });
      return;
    }
    this.dispatch({ type: "audio_sent", id, queued: sent === "queued" });
  }

  /** Abandons the current recording without sending it. */
  cancelTalk(): void {
    this.clearMaxTimer();
    this.releaseRequested = false;
    this.captureGen++;
    if (this.state.capture === "off") return;
    this.adapter.mic.cancel();
    this.dispatch({ type: "capture", state: "off" });
  }

  /** Stops speaking / the turn in flight without starting to listen. */
  stop(): void {
    this.bargeIn();
  }

  /**
   * Stops only the spoken reply (local audio and a pending `speech` clip);
   * the model turn keeps running. Used when voice replies are switched off.
   */
  stopSpeaking(): void {
    this.stopLocalAudio();
    this.dispatch({ type: "speech_stopped" });
  }

  respondConfirm(approved: boolean): void {
    const c = currentConfirm(this.state);
    if (!c || c.responding) return;
    if (this.send({ type: "confirm_response", requestId: c.requestId, approved })) {
      this.dispatch({ type: "confirm_sent", requestId: c.requestId });
      this.adapter.vibrate([10]);
    }
  }

  requestHistory(limit = HISTORY_LIMIT): void {
    if (this.connected) this.client?.send({ type: "history_request", limit });
  }

  setVoiceReplies(enabled: boolean): void {
    this.voiceReplies = enabled;
  }

  /** Voice id sent with every `speak`; null or "" = the Core's default. */
  setVoice(voice: string | null): void {
    this.voice = voice || null;
  }

  /**
   * Asks the Core for the tts-svc voice list (core TTS mode only). Does
   * nothing while not connected or while a request is already in flight.
   */
  requestVoices(): void {
    if (this.adapter.tts.mode !== "core" || !this.connected) return;
    if (this.state.voices.status === "loading") return;
    const id = this.newId();
    if (!this.client?.send({ type: "voices", id })) return;
    this.dispatch({ type: "voices_requested", id });
    this.clearVoicesTimer();
    this.voicesTimer = setTimeout(() => {
      this.voicesTimer = null;
      this.dispatch({ type: "voices_timeout", id });
    }, VOICES_TIMEOUT_MS);
  }

  /**
   * "Dene": speaks a short sample with `voice` (null = the Core's default)
   * and plays it like a reply. Only while no turn is in flight
   * (canPreviewVoice); a reply being spoken is stopped first.
   */
  previewVoice(voice: string | null): boolean {
    if (this.adapter.tts.mode !== "core" || !canPreviewVoice(this.state)) return false;
    this.adapter.playback.unlock();
    this.stopSpeaking();
    const id = this.newId();
    const frame = voice
      ? { type: "speak" as const, id, text: VOICE_SAMPLE_TEXT, voice }
      : { type: "speak" as const, id, text: VOICE_SAMPLE_TEXT };
    if (!this.send(frame)) return false;
    this.dispatch({ type: "voice_preview_requested", id });
    return true;
  }

  dismissNotice(): void {
    this.dispatch({ type: "dismiss_notice" });
  }

  clearConversation(): void {
    this.dispatch({ type: "reset_conversation" });
  }

  // --- internals -------------------------------------------------------------

  /**
   * Barge-in: stop local audio at once and tell the Core to drop the turn.
   * Late deltas/speech for that turn are then ignored (state.cancelled).
   */
  private bargeIn(): void {
    const target = bargeInTarget(this.state);
    this.stopLocalAudio();
    if (!target) return;
    if (this.queuedTurn?.id === target) {
      // Never reached the Core: drop it locally. The earlier cancel is still
      // settling, so `cancelling` and its timer stay as they are.
      this.queuedTurn = null;
      this.dispatch({ type: "barge_in", turnId: target });
      return;
    }
    const serverTurnRunning = this.state.activeTurn?.id === target;
    if (this.connected && this.client?.send({ type: "cancel", id: target }) && serverTurnRunning) {
      this.resetCancelling();
      this.cancelling = true;
      this.settleTimer = setTimeout(() => this.flushQueuedTurn(), CANCEL_SETTLE_MS);
    }
    this.dispatch({ type: "barge_in", turnId: target });
  }

  private stopLocalAudio(): void {
    this.adapter.playback.stop();
    if (this.adapter.tts.mode === "native") this.adapter.tts.stop();
  }

  /**
   * Sends a new turn, or holds it until the cancelled turn has wound down on
   * the Core (its `state: idle`), at most CANCEL_SETTLE_MS. Returns false only
   * when it cannot be sent at all (not connected).
   */
  private sendTurn(frame: TurnFrame): "sent" | "queued" | false {
    if (!this.cancelling || !this.connected) return this.send(frame) ? "sent" : false;
    this.queuedTurn = frame;
    return "queued";
  }

  private flushQueuedTurn(): void {
    const frame = this.queuedTurn;
    this.resetCancelling();
    if (!frame) return;
    if (this.send(frame)) this.dispatch({ type: "queued_turn_sent", id: frame.id });
    else this.dispatch({ type: "queued_turn_dropped", id: frame.id });
  }

  private resetCancelling(): void {
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    this.settleTimer = null;
    this.cancelling = false;
    this.queuedTurn = null;
  }

  /**
   * A mic step failed: capture goes off. `cancelled` (the host abandoned the
   * request after cancelCapture) is not an error for the user, so no notice.
   */
  private micFailed(err: unknown): void {
    this.dispatch({ type: "capture", state: "off" });
    const e = toPlatformError(err);
    if (e.code === "cancelled") return;
    this.dispatch({ type: "notice", notice: { code: `mic_${e.code}`, message: e.message } });
  }

  private clearVoicesTimer(): void {
    if (this.voicesTimer !== null) clearTimeout(this.voicesTimer);
    this.voicesTimer = null;
  }

  private clearMaxTimer(): void {
    if (this.maxTimer !== null) clearTimeout(this.maxTimer);
    this.maxTimer = null;
  }

  private handleServer(msg: ServerMessage): void {
    this.dispatch({ type: "server", msg });
    switch (msg.type) {
      case "welcome":
        this.clearVoicesTimer(); // the reducer reset the voice list
        this.requestHistory();
        break;
      case "voices":
        if (msg.id === this.state.voices.requestId) this.clearVoicesTimer();
        break;
      case "state":
        if (msg.state === "idle" && this.cancelling) this.flushQueuedTurn();
        break;
      case "assistant_done":
        if (this.voiceReplies && !isCancelled(this.state, msg.id) && msg.text.trim()) {
          this.speakReply(msg.id, msg.text);
        }
        break;
      case "speech":
        if (shouldPlaySpeech(this.state, msg.id)) this.play(msg.id, { mime: msg.mime, data: msg.data });
        break;
      case "confirm_request":
        if (isCancelled(this.state, msg.id)) break; // dropped by the reducer too
        this.adapter.vibrate([30, 60, 30]);
        if (!this.adapter.isVisible()) this.adapter.notify("Shadow onay bekliyor", msg.summary);
        break;
      default:
        break;
    }
  }

  private speakReply(id: string, text: string): void {
    const clipped = clipForSpeech(text);
    const tts = this.adapter.tts;
    if (tts.mode === "core") {
      const frame = this.voice ? { type: "speak" as const, id, text: clipped, voice: this.voice } : { type: "speak" as const, id, text: clipped };
      if (this.client?.send(frame)) {
        this.dispatch({ type: "speech_requested", id });
      }
      return;
    }
    this.dispatch({ type: "playback_started", id });
    tts
      .speak(clipped)
      .catch((err) => {
        if (!isCancelled(this.state, id)) {
          this.dispatch({ type: "notice", notice: { code: "tts_failed", message: toPlatformError(err).message } });
        }
      })
      .finally(() => this.dispatch({ type: "playback_ended", id }));
  }

  private play(id: string, clip: { mime: string; data: string }): void {
    this.dispatch({ type: "playback_started", id });
    this.adapter.playback
      .play(clip)
      .catch((err) => {
        this.dispatch({ type: "notice", notice: { code: "playback_failed", message: toPlatformError(err).message } });
      })
      .finally(() => this.dispatch({ type: "playback_ended", id }));
  }
}
