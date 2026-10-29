import { useEffect, useRef, type ReactNode } from "react";
import type { HistoryItem } from "../protocol/types.ts";
import { QUALITIES, type Quality } from "../scene/quality.ts";
import { QUALITY_LABEL, formatTime } from "./strings.ts";

/** Slide-in side panel (modal on phones, docked look on wide screens). */
export function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <h2>{title}</h2>
          <button ref={closeRef} type="button" className="btn btn-icon" aria-label="Kapat" onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19l5.6-5.6 5.6 5.6 1.4-1.4-5.6-5.6L19 6.4 17.6 5 12 10.6z" />
            </svg>
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

export function HistoryPanel({
  items,
  loaded,
  connected,
  onRefresh,
  onClose,
}: {
  items: HistoryItem[];
  loaded: boolean;
  connected: boolean;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const sorted = [...items].sort((a, b) => b.ts - a.ts);
  return (
    <Drawer title="Son konuşmalar" onClose={onClose}>
      <button type="button" className="btn btn-ghost" disabled={!connected} onClick={onRefresh}>
        Yenile
      </button>
      {!loaded ? (
        <p className="hint">{connected ? "Yükleniyor…" : "Bağlantı yok."}</p>
      ) : sorted.length === 0 ? (
        <p className="hint">Henüz kayıtlı konuşma yok.</p>
      ) : (
        <ol className="history">
          {sorted.map((item) => (
            <li key={`${item.id}:${item.role}`} className={`history-item history-${item.role}`}>
              <span className="history-meta">
                {item.role === "user" ? "Sen" : "Shadow"} · {formatTime(item.ts)}
              </span>
              <p>{item.text}</p>
            </li>
          ))}
        </ol>
      )}
    </Drawer>
  );
}

export function SettingsPanel({
  quality,
  voiceReplies,
  reducedMotion,
  coreUrl,
  voicePicker,
  onOpenMemory,
  onQuality,
  onVoiceReplies,
  onChangeConnection,
  onClose,
}: {
  quality: Quality;
  voiceReplies: boolean;
  reducedMotion: boolean;
  coreUrl: string;
  /** "Ses" picker; absent where replies are spoken natively (Android). */
  voicePicker?: ReactNode;
  /** Opens the "Hafıza" panel; absent (section hidden) without the Core feature `memory`. */
  onOpenMemory?: () => void;
  onQuality: (q: Quality) => void;
  onVoiceReplies: (v: boolean) => void;
  onChangeConnection: () => void;
  onClose: () => void;
}) {
  return (
    <Drawer title="Ayarlar" onClose={onClose}>
      <fieldset className="field">
        <legend>Görsel kalite</legend>
        <div className="segmented" role="radiogroup" aria-label="Görsel kalite">
          {QUALITIES.map((q) => (
            <button
              key={q}
              type="button"
              role="radio"
              aria-checked={quality === q}
              className={`segment${quality === q ? " segment-on" : ""}`}
              onClick={() => onQuality(q)}
            >
              {QUALITY_LABEL[q]}
            </button>
          ))}
        </div>
        <p className="hint">
          Düşük kalite pil ve ısı için telefonda varsayılandır.
          {reducedMotion && " Sistemde azaltılmış hareket açık; animasyonlar yavaşlatıldı."}
        </p>
      </fieldset>
      <label className="switch">
        <input type="checkbox" checked={voiceReplies} onChange={(e) => onVoiceReplies(e.target.checked)} />
        <span>Cevapları sesli oku</span>
      </label>
      {voicePicker}
      {onOpenMemory && (
        <div className="field">
          <span className="field-label">Hafıza</span>
          <p className="hint">Shadow'un konuşmalardan hatırladıkları. Yanlış ya da gereksiz olanları silebilirsin.</p>
          <button type="button" className="btn btn-ghost" onClick={onOpenMemory}>
            Hafızayı göster
          </button>
        </div>
      )}
      <div className="field">
        <p className="hint">Çekirdek: {coreUrl || "ayarlanmadı"}</p>
        <button type="button" className="btn btn-ghost" onClick={onChangeConnection}>
          Bağlantı ayarları
        </button>
      </div>
    </Drawer>
  );
}
