import { useState } from "react";
import { notificationToggleAction, type NotificationsView } from "../assistant/state.ts";
import type { NotificationAction, NotificationInfo } from "../protocol/types.ts";
import { Drawer } from "./Panels.tsx";
import {
  NOTIFICATION_ACTION_LABEL,
  NOTIFICATION_DISMISS_HINT,
  formatTime,
  notificationSourceText,
  notificationsErrorText,
  notificationsUnreadText,
} from "./strings.ts";

type Props = {
  notifications: NotificationsView;
  connected: boolean;
  /** The Core has `notifications_suppress`: offer "Tekrar gösterme" next to "Gördüm". */
  canSuppress: boolean;
  onRefresh: () => void;
  onAction: (notificationId: string, action: NotificationAction) => void;
  onClose: () => void;
};

/** The two actions that clear an item. */
type Dismiss = "delete" | "suppress";

const CONFIRM_TEXT: Record<Dismiss, { question: string; yes: string }> = {
  delete: { question: "Bu bildirim kaldırılsın mı?", yes: "Evet, kaldır" },
  suppress: { question: "Bu bildirim bir daha gösterilmesin mi?", yes: "Evet, gösterme" },
};

const timeText = (iso: string) => {
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? "" : formatTime(ts);
};

/**
 * "Bildirimler": the shared inbox of the home, most recently updated first.
 * Per item "Okundu" / "Okunmadı", "Gördüm" (`delete`) and, with the Core
 * feature `notifications_suppress`, "Tekrar gösterme" (`suppress`). Both
 * clearing actions ask first, with a short hint of what they mean (an item is
 * only ever removed by the user). Opening the panel or
 * hearing an item spoken does not mark it read. The caller sends
 * `notifications_list` when the panel opens and renders it only with the Core
 * feature `notifications`.
 */
export function NotificationsPanel({ notifications, connected, canSuppress, onRefresh, onAction, onClose }: Props) {
  /** Item and clearing action whose confirm question is shown. */
  const [confirming, setConfirming] = useState<{ id: string; action: Dismiss } | null>(null);
  const busy = notifications.status === "loading";
  const usable = connected && !busy;
  const items = notifications.items ?? [];
  const acting = notifications.acting;

  const label = (item: NotificationInfo, action: NotificationAction) =>
    acting?.notificationId === item.id && acting.action === action ? "İşleniyor…" : NOTIFICATION_ACTION_LABEL[action];

  const actionButtons = (item: NotificationInfo) => {
    // A "Tekrar gösterme" question is dropped if the Core (after a reconnect) no longer offers it.
    if (confirming?.id === item.id && (confirming.action === "delete" || canSuppress)) {
      const dismiss = confirming.action;
      const text = CONFIRM_TEXT[dismiss];
      return (
        <div className="memory-actions dev-confirm" role="group" aria-label={`${NOTIFICATION_ACTION_LABEL[dismiss]} onayı`}>
          <p className="hint">
            {text.question} {NOTIFICATION_DISMISS_HINT[dismiss]}
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!usable}
            onClick={() => {
              setConfirming(null);
              onAction(item.id, dismiss);
            }}
          >
            {text.yes}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setConfirming(null)}>
            Vazgeç
          </button>
        </div>
      );
    }
    const toggle = notificationToggleAction(item);
    return (
      <div className="memory-actions">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!usable}
          aria-label={`${label(item, toggle)}: ${item.title}`}
          onClick={() => onAction(item.id, toggle)}
        >
          {label(item, toggle)}
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!usable}
          title={NOTIFICATION_DISMISS_HINT.delete}
          aria-label={`${label(item, "delete")}: ${item.title}`}
          onClick={() => setConfirming({ id: item.id, action: "delete" })}
        >
          {label(item, "delete")}
        </button>
        {canSuppress && (
          <button
            type="button"
            className="btn btn-ghost"
            disabled={!usable}
            title={NOTIFICATION_DISMISS_HINT.suppress}
            aria-label={`${label(item, "suppress")}: ${item.title}`}
            onClick={() => setConfirming({ id: item.id, action: "suppress" })}
          >
            {label(item, "suppress")}
          </button>
        )}
      </div>
    );
  };

  return (
    <Drawer title="Bildirimler" onClose={onClose}>
      <button type="button" className="btn btn-ghost" disabled={!usable} onClick={onRefresh}>
        Yenile
      </button>
      {!connected ? (
        <p className="hint">Bağlantı yok.</p>
      ) : (
        busy && (
          <p className="hint" role="status">
            {acting ? "İşleniyor…" : "Yükleniyor…"}
          </p>
        )
      )}
      {/* The Core cannot read its notifications file: the inbox is unknown, never shown as empty. */}
      {notifications.unavailable && (
        <p className="hint memory-error" role="alert">
          {notificationsErrorText("notifications_unavailable")}
        </p>
      )}
      {notifications.status === "error" && notifications.errorCode && notifications.errorCode !== "notifications_unavailable" && (
        <p className="hint memory-error" role="alert">
          {notificationsErrorText(notifications.errorCode, notifications.errorMessage)}
        </p>
      )}
      {notifications.items !== null && notifications.unread !== null && notifications.unread > 0 && (
        <p className="hint">{notificationsUnreadText(notifications.unread)}.</p>
      )}
      {notifications.items !== null && items.length === 0 && !notifications.unavailable && <p className="hint">Bildirim yok.</p>}
      {items.length > 0 && (
        <ul className="memory-list">
          {items.map((n) => (
            <li key={n.id} className={`memory-entry notification-entry${n.readAt === null ? " notification-unread" : ""}`}>
              <p className="notification-title">
                <strong>{n.title}</strong>
                {n.urgency === "urgent" && <span className="notification-urgent">Acil</span>}
                {n.readAt === null && <span className="visually-hidden"> (okunmadı)</span>}
              </p>
              {n.body && <p>{n.body}</p>}
              <span className="history-meta">
                {notificationSourceText(n.source)}
                {timeText(n.updatedAt) && ` · ${timeText(n.updatedAt)}`}
                {n.raised > 1 && ` · ${n.raised} kez`}
              </span>
              {actionButtons(n)}
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}
