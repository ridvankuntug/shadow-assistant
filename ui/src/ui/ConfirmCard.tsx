import { useEffect, useState } from "react";
import type { PendingConfirm } from "../assistant/state.ts";
import { CONFIRM_REMEMBER_HINT, CONFIRM_REMEMBER_LABEL, CONFIRM_REMEMBER_VOICE_HINT, confirmRememberText } from "./strings.ts";

type Props = {
  confirm: PendingConfirm;
  /** `remember`: "Evet, hep bu" (only offered when `confirm.remember` is set). */
  onAnswer: (approved: boolean, remember?: boolean) => void;
};

/**
 * Pending confirmation for a `confirm`-level tool. It can also be answered by
 * voice ("evet" / "hayır"); the card closes when the Core sends
 * `confirm_resolved`, whichever way it was answered.
 *
 * With `confirm.remember` (docs/14 Decision 7) the card names what the user
 * said and the device it means ("“bahçe pompasnı” → Bahçe Pompası") and offers
 * three answers: Hayır / Evet (this time only) / Evet, hep bu (store the name).
 * Without it, the two answers as before.
 */
export function ConfirmCard({ confirm, onAnswer }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const secondsLeft = Math.max(0, Math.ceil((confirm.expiresAt - now) / 1000));
  const remember = confirm.remember;

  return (
    <section
      className="confirm-card"
      role="alertdialog"
      aria-labelledby="confirm-title"
      aria-describedby={remember ? "confirm-summary confirm-remember" : "confirm-summary"}
    >
      <h2 id="confirm-title">Onay gerekiyor</h2>
      <p id="confirm-summary" className="confirm-summary">
        {confirm.summary}
      </p>
      {remember && (
        <p id="confirm-remember" className="confirm-summary confirm-remember">
          {confirmRememberText(remember.spoken, remember.target)}
        </p>
      )}
      <p className="confirm-meta">
        <span className="confirm-tool">{confirm.tool}</span>
        <span>{secondsLeft > 0 ? `${secondsLeft} sn` : "süre doluyor"}</span>
      </p>
      {remember ? (
        <>
          <p className="hint">{CONFIRM_REMEMBER_HINT}</p>
          <p className="hint">{CONFIRM_REMEMBER_VOICE_HINT}</p>
        </>
      ) : (
        <p className="hint">Sesle de cevap verebilirsin: “evet” ya da “hayır”.</p>
      )}
      {remember ? (
        // Hayır | Evet on the first row, "Evet, hep bu" across the second (index.css).
        <div className="confirm-actions confirm-actions-remember">
          <button type="button" className="btn btn-danger" disabled={confirm.responding} onClick={() => onAnswer(false)}>
            {CONFIRM_REMEMBER_LABEL.no}
          </button>
          <button type="button" className="btn btn-primary" disabled={confirm.responding} onClick={() => onAnswer(true)}>
            {CONFIRM_REMEMBER_LABEL.once}
          </button>
          <button type="button" className="btn btn-ghost confirm-always" disabled={confirm.responding} onClick={() => onAnswer(true, true)}>
            {CONFIRM_REMEMBER_LABEL.always}
          </button>
        </div>
      ) : (
        <div className="confirm-actions">
          <button
            type="button"
            className="btn btn-danger"
            disabled={confirm.responding}
            onClick={() => onAnswer(false)}
          >
            Reddet
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={confirm.responding}
            onClick={() => onAnswer(true)}
          >
            Onayla
          </button>
        </div>
      )}
    </section>
  );
}
