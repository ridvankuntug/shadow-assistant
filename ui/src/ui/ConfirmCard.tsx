import { useEffect, useState } from "react";
import type { PendingConfirm } from "../assistant/state.ts";

type Props = {
  confirm: PendingConfirm;
  onAnswer: (approved: boolean) => void;
};

/**
 * Pending confirmation for a `confirm`-level tool. It can also be answered by
 * voice ("evet" / "hayır"); the card closes when the Core sends
 * `confirm_resolved`, whichever way it was answered.
 */
export function ConfirmCard({ confirm, onAnswer }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const secondsLeft = Math.max(0, Math.ceil((confirm.expiresAt - now) / 1000));

  return (
    <section className="confirm-card" role="alertdialog" aria-labelledby="confirm-title" aria-describedby="confirm-summary">
      <h2 id="confirm-title">Onay gerekiyor</h2>
      <p id="confirm-summary" className="confirm-summary">
        {confirm.summary}
      </p>
      <p className="confirm-meta">
        <span className="confirm-tool">{confirm.tool}</span>
        <span>{secondsLeft > 0 ? `${secondsLeft} sn` : "süre doluyor"}</span>
      </p>
      <p className="hint">Sesle de cevap verebilirsin: “evet” ya da “hayır”.</p>
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
    </section>
  );
}
