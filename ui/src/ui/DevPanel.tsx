import { useState } from "react";
import { devItemActions, type DevView } from "../assistant/state.ts";
import type { DevAction, DevItem } from "../protocol/types.ts";
import { Drawer } from "./Panels.tsx";
import {
  DEV_ACTION_LABEL,
  devErrorText,
  devKindText,
  devOpenText,
  devPatternText,
  devRuleDetails,
  devStatusText,
  formatTime,
} from "./strings.ts";

type Props = {
  dev: DevView;
  connected: boolean;
  onRefresh: () => void;
  onAction: (itemId: string, action: DevAction) => void;
  onClose: () => void;
};

/** Rule order: what needs a decision first (candidates, then suspended rules). */
const RULE_ORDER: Record<string, number> = { candidate: 0, suspended: 1 };
const ruleRank = (i: DevItem) => RULE_ORDER[i.status] ?? 2;

const seenText = (iso: string) => {
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? "" : formatTime(ts);
};

/**
 * "Geliştirme": learned rule candidates (pattern, action, domains, number
 * range, observations — how far the rule generalizes) and dev-notes by kind,
 * with "Kuralı ekle" (asks "Bu kural etkinleşsin mi?" first), "Yok say" and
 * "Düzeltildi". Display only: never a notification or a sound. The caller
 * sends `dev_list` when the panel opens and renders it only with the Core
 * feature `dev`.
 */
export function DevPanel({ dev, connected, onRefresh, onAction, onClose }: Props) {
  /** Rule whose "Bu kural etkinleşsin mi?" question is shown. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const busy = dev.status === "loading";
  const usable = connected && !busy;
  const items = dev.items ?? [];
  const rules = items.filter((i) => i.type === "rule").sort((a, b) => ruleRank(a) - ruleRank(b));
  const notes = items.filter((i) => i.type === "note");
  const kinds = [...new Set(notes.map((n) => n.kind))];
  const hasCandidate = rules.some((r) => r.status === "candidate");

  const actionButtons = (item: DevItem) => {
    const actions = devItemActions(item, dev.canManage);
    if (actions.length === 0) return null;
    // Only while "Kuralı ekle" is still offered (a refresh may have changed the item or canManage).
    if (confirming === item.itemId && actions.includes("add_rule")) {
      return (
        <div className="memory-actions dev-confirm" role="group" aria-label="Kural ekleme onayı">
          <p className="hint">
            Bu kural etkinleşsin mi? Bu kalıba uyan cümleler artık modele sorulmadan doğrudan çalışır.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!usable}
            onClick={() => {
              setConfirming(null);
              onAction(item.itemId, "add_rule");
            }}
          >
            Evet, ekle
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setConfirming(null)}>
            Vazgeç
          </button>
        </div>
      );
    }
    return (
      <div className="memory-actions">
        {actions.map((a) => (
          <button
            key={a}
            type="button"
            className="btn btn-ghost"
            disabled={!usable}
            onClick={() => (a === "add_rule" ? setConfirming(item.itemId) : onAction(item.itemId, a))}
          >
            {dev.acting?.itemId === item.itemId && dev.acting.action === a ? "İşleniyor…" : DEV_ACTION_LABEL[a]}
          </button>
        ))}
      </div>
    );
  };

  return (
    <Drawer title="Geliştirme" onClose={onClose}>
      <button type="button" className="btn btn-ghost" disabled={!usable} onClick={onRefresh}>
        Yenile
      </button>
      {!connected ? (
        <p className="hint">Bağlantı yok.</p>
      ) : (
        busy && (
          <p className="hint" role="status">
            {dev.acting ? "İşleniyor…" : "Yükleniyor…"}
          </p>
        )
      )}
      {dev.status === "error" && dev.errorCode && (
        <p className="hint memory-error" role="alert">
          {devErrorText(dev.errorCode, dev.errorMessage)}
        </p>
      )}
      {dev.items !== null && (
        <p className="hint">
          {dev.open !== null && dev.open > 0 ? `${devOpenText(dev.open)}. ` : ""}
          Öğrenilen kurallar ve geliştirme notları; bildirim gönderilmez.
        </p>
      )}
      {dev.items !== null && hasCandidate && !dev.canManage && (
        <p className="hint">
          Bu cihaz kural ekleyemez. Çekirdekte CORE_DEV_DEVICES ayarına bu cihazın adı eklenmeli.
        </p>
      )}
      {dev.items !== null && items.length === 0 && <p className="hint">Geliştirme öğesi yok.</p>}
      {rules.length > 0 && (
        <section className="memory-section">
          <h3>Öğrenilen kurallar</h3>
          <ul className="memory-list">
            {rules.map((r) => (
              <li key={r.itemId} className="memory-entry">
                <p className="dev-pattern">
                  <strong>“{devPatternText(r.rule?.tokens ?? [])}”</strong>{" "}
                  <span className="history-meta">{devStatusText(r.status)}</span>
                </p>
                {r.rule && (
                  <ul className="dev-details">
                    {devRuleDetails(r.rule).map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
                {r.message && <p>{r.message}</p>}
                {actionButtons(r)}
              </li>
            ))}
          </ul>
        </section>
      )}
      {kinds.map((kind) => (
        <section key={kind} className="memory-section">
          <h3>{devKindText(kind)}</h3>
          <ul className="memory-list">
            {notes
              .filter((n) => n.kind === kind)
              .map((n) => (
                <li key={n.itemId} className="memory-entry">
                  <p>{n.message || devKindText(n.kind)}</p>
                  <span className="history-meta">
                    {devStatusText(n.status)} · {n.count} kez
                    {seenText(n.lastSeen) && ` · son: ${seenText(n.lastSeen)}`}
                  </span>
                  {actionButtons(n)}
                </li>
              ))}
          </ul>
        </section>
      ))}
    </Drawer>
  );
}
