import { useState } from "react";
import type { NamesView } from "../assistant/state.ts";
import { Drawer } from "./Panels.tsx";
import {
  NAMES_EMPTY,
  NAMES_INTRO,
  NAMES_TITLE,
  NAMES_UI,
  nameDeleteLabel,
  nameRowText,
  nameStatusHint,
  nameStatusText,
  namesErrorText,
} from "./strings.ts";

type Props = {
  names: NamesView;
  connected: boolean;
  onRefresh: () => void;
  onDelete: (nameId: string) => void;
  onClose: () => void;
};

/**
 * "Cihaz adları" (docs/14 Decision 8): one row per confirmed name,
 * "söylenen → Hedef (alan)", with its status ("Pasif" / "Bulunamadı") and Sil
 * ("Silinsin mi?" first, as in the memory panel). No adding or editing:
 * entries come only from "Evet, hep bu" on a confirm card. The caller sends
 * `names_list` when the panel opens and renders it only with the Core feature
 * `names`.
 */
export function NamesPanel({ names, connected, onRefresh, onDelete, onClose }: Props) {
  /** Row whose "Silinsin mi?" question is shown. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const busy = names.status === "loading";
  const items = names.items;

  return (
    <Drawer title={NAMES_TITLE} onClose={onClose}>
      <p className="hint">{NAMES_INTRO}</p>
      <button type="button" className="btn btn-ghost" disabled={!connected || busy} onClick={onRefresh}>
        {NAMES_UI.refresh}
      </button>
      {!connected ? (
        <p className="hint">{NAMES_UI.offline}</p>
      ) : (
        busy && (
          <p className="hint" role="status">
            {names.deleting ? NAMES_UI.deleting : NAMES_UI.loading}
          </p>
        )
      )}
      {names.status === "error" && names.errorCode && (
        <p className="hint memory-error" role="alert">
          {namesErrorText(names.errorCode, names.errorMessage)}
        </p>
      )}
      {items && items.length === 0 && <p className="hint">{NAMES_EMPTY}</p>}
      {items && items.length > 0 && (
        <ul className="memory-list">
          {items.map((item) => {
            const text = nameRowText(item);
            const status = nameStatusText(item);
            const statusHint = nameStatusHint(item);
            return (
              <li key={item.id} className="memory-entry">
                <p>
                  {text}
                  {status && (
                    <>
                      {" "}
                      <span className="history-meta">· {status}</span>
                    </>
                  )}
                </p>
                {/* Visible, not a tooltip: touch screens and screen readers need it too. */}
                {statusHint && <p className="hint">{statusHint}</p>}
                {confirming === item.id ? (
                  <div className="memory-actions" role="group" aria-label={NAMES_UI.askGroup}>
                    <span className="hint">{NAMES_UI.ask}</span>
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={!connected || busy}
                      onClick={() => {
                        setConfirming(null);
                        onDelete(item.id);
                      }}
                    >
                      {NAMES_UI.yes}
                    </button>
                    <button type="button" className="btn btn-ghost" onClick={() => setConfirming(null)}>
                      {NAMES_UI.cancel}
                    </button>
                  </div>
                ) : (
                  <div className="memory-actions">
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={!connected || busy}
                      aria-label={nameDeleteLabel(text)}
                      onClick={() => setConfirming(item.id)}
                    >
                      {names.deleting === item.id ? NAMES_UI.deleting : NAMES_UI.remove}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Drawer>
  );
}
