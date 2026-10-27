import { useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from "react";
import type { CaptureState, Phase } from "../assistant/state.ts";

/** A press shorter than this latches recording on (tap to start, tap to send). */
const TAP_MS = 300;

type Props = {
  phase: Phase;
  capture: CaptureState;
  connected: boolean;
  /** Show "Durdur" (see canStop in assistant/state.ts). */
  canStop: boolean;
  onSendText: (text: string) => boolean;
  onTalkStart: () => void;
  onTalkStop: () => void;
  onStop: () => void;
};

/**
 * Bottom bar: text input + the push-to-talk button. Hold to talk, or tap once
 * to start and tap again to send. Starting to talk while Shadow is speaking or
 * thinking interrupts it (barge-in, handled by the controller).
 */
export function Composer({ phase, capture, connected, canStop, onSendText, onTalkStart, onTalkStop, onStop }: Props) {
  const [text, setText] = useState("");
  const [latched, setLatched] = useState(false);
  const pressedAt = useRef(0);
  const ignoreNextUp = useRef(false);

  const recording = capture === "starting" || capture === "recording";
  const busy = capture === "sending";

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (onSendText(text)) setText("");
  };

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0 || busy) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    if (recording && latched) {
      // Second tap of tap-to-talk: send.
      ignoreNextUp.current = true;
      setLatched(false);
      onTalkStop();
      return;
    }
    if (recording) return;
    ignoreNextUp.current = false;
    pressedAt.current = performance.now();
    setLatched(false);
    onTalkStart();
  };

  const onPointerUp = () => {
    if (ignoreNextUp.current) {
      ignoreNextUp.current = false;
      return;
    }
    if (!recording && capture !== "off") return;
    if (performance.now() - pressedAt.current < TAP_MS) {
      setLatched(true); // quick tap: keep listening until the next tap
      return;
    }
    onTalkStop();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if ((e.key !== " " && e.key !== "Enter") || e.repeat) return;
    e.preventDefault();
    if (recording) {
      setLatched(false);
      onTalkStop();
    } else if (!busy) {
      setLatched(true);
      onTalkStart();
    }
  };

  const talkLabel = recording
    ? latched
      ? "Göndermek için dokun"
      : "Bırakınca gönderilir"
    : busy
      ? "Gönderiliyor…"
      : phase === "speaking" || phase === "thinking"
        ? "Sözünü kes ve konuş"
        : "Konuşmak için basılı tut";

  return (
    <div className="composer">
      <form className="composer-text" onSubmit={submit}>
        <label className="visually-hidden" htmlFor="composer-input">
          Mesaj
        </label>
        <input
          id="composer-input"
          type="text"
          enterKeyHint="send"
          autoComplete="off"
          placeholder={connected ? "Bir şey yaz…" : "Bağlantı bekleniyor…"}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button type="submit" className="btn btn-icon" disabled={!connected || !text.trim()} aria-label="Gönder">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 11.5 21 3l-8.5 18-2.2-7.3z" />
          </svg>
        </button>
      </form>
      <div className="composer-actions">
        {canStop && (
          <button type="button" className="btn btn-ghost btn-stop" onClick={onStop}>
            Durdur
          </button>
        )}
        <button
          type="button"
          className={`talk${recording ? " talk-active" : ""}`}
          aria-pressed={recording}
          aria-label={talkLabel}
          disabled={!connected || busy}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
          onContextMenu={(e) => e.preventDefault()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-2.1A7 7 0 0 0 19 12h-2Z" />
          </svg>
        </button>
        <span className="talk-label" aria-hidden="true">
          {talkLabel}
        </span>
      </div>
    </div>
  );
}
