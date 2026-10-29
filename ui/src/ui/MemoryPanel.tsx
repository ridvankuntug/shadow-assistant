import { useState } from "react";
import type { MemoryView } from "../assistant/state.ts";
import type { MemoryEntry } from "../protocol/types.ts";
import { Drawer } from "./Panels.tsx";
import { formatTime, memoryCharsText, memoryErrorText, memoryWarningText } from "./strings.ts";

type Props = {
  memory: MemoryView;
  connected: boolean;
  /** The Core has the `memory` feature. */
  available: boolean;
  onRefresh: () => void;
  onDelete: (entryId: string) => void;
  onClose: () => void;
};

/**
 * Settings → "Hafıza": the brief and each topic note with a delete button per
 * entry ("Silinsin mi?" first), warnings on top, "Yenile". No editing. The
 * caller sends `memory_list` when the panel opens.
 */
export function MemoryPanel({ memory, connected, available, onRefresh, onDelete, onClose }: Props) {
  /** Entry whose "Silinsin mi?" question is shown. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const busy = memory.status === "loading";
  const usable = connected && available;
  const { contents } = memory;
  const titles = Object.fromEntries((contents?.topics ?? []).map((t) => [t.topic, t.title]));
  const empty = contents !== null && contents.brief.entries.length === 0 && contents.topics.every((t) => t.entries.length === 0);

  const entryList = (entries: MemoryEntry[]) => (
    <ul className="memory-list">
      {entries.map((e) => (
        <li key={e.id} className="memory-entry">
          <p>{e.text}</p>
          {e.updatedAt !== undefined && <span className="history-meta">{formatTime(e.updatedAt)}</span>}
          {confirming === e.id ? (
            <div className="memory-actions" role="group" aria-label="Silme onayı">
              <span className="hint">Silinsin mi?</span>
              <button
                type="button"
                className="btn btn-danger"
                disabled={!usable || busy}
                onClick={() => {
                  setConfirming(null);
                  onDelete(e.id);
                }}
              >
                Evet, sil
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setConfirming(null)}>
                Vazgeç
              </button>
            </div>
          ) : (
            <div className="memory-actions">
              <button
                type="button"
                className="btn btn-ghost"
                disabled={!usable || busy}
                aria-label={`Sil: ${e.text}`}
                onClick={() => setConfirming(e.id)}
              >
                {memory.deleting === e.id ? "Siliniyor…" : "Sil"}
              </button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <Drawer title="Hafıza" onClose={onClose}>
      <button type="button" className="btn btn-ghost" disabled={!usable || busy} onClick={onRefresh}>
        Yenile
      </button>
      {!connected ? (
        <p className="hint">Bağlantı yok.</p>
      ) : !available ? (
        <p className="hint">Bu çekirdekte hafıza kapalı.</p>
      ) : (
        busy && <p className="hint" role="status">{memory.deleting ? "Siliniyor…" : "Yükleniyor…"}</p>
      )}
      {memory.status === "error" && memory.errorCode && (
        <p className="hint memory-error" role="alert">
          {memoryErrorText(memory.errorCode, memory.errorMessage)}
        </p>
      )}
      {contents && contents.warnings.length > 0 && (
        <ul className="memory-warnings" role="status">
          {contents.warnings.map((w, i) => (
            <li key={`${w.code}:${w.topic ?? ""}:${i}`}>{memoryWarningText(w, titles)}</li>
          ))}
        </ul>
      )}
      {empty && <p className="hint">Henüz hatırlanan bir şey yok.</p>}
      {contents && !empty && (
        <>
          {contents.brief.entries.length > 0 && (
            <section className="memory-section">
              <h3>
                Kısa özet <span className="history-meta">{memoryCharsText(contents.brief.chars, contents.brief.budget)}</span>
              </h3>
              <p className="hint">Her konuşmada Shadow'un aklında.</p>
              {entryList(contents.brief.entries)}
            </section>
          )}
          {contents.topics
            .filter((t) => t.entries.length > 0)
            .map((t) => (
              <section key={t.topic} className="memory-section">
                <h3>
                  {t.title || t.topic} <span className="history-meta">{memoryCharsText(t.chars)}</span>
                </h3>
                {entryList(t.entries)}
              </section>
            ))}
        </>
      )}
    </Drawer>
  );
}
