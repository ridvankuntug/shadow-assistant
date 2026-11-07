import { useState } from "react";
import { notificationToggleAction, type NotificationsView } from "../assistant/state.ts";
import type { NotificationAction, NotificationInfo } from "../protocol/types.ts";
import { Drawer } from "./Panels.tsx";
import {
  NOTIFICATION_ACTION_LABEL,
  formatTime,
  notificationSourceText,
  notificationsErrorText,
  notificationsUnreadText,
} from "./strings.ts";

type Props = {
  notifications: NotificationsView;
  connected: boolean;
  onRefresh: () => void;
  onAction: (notificationId: string, action: NotificationAction) => void;
  onClose: () => void;
};

const timeText = (iso: string) => {
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? "" : formatTime(ts);
};

/**
 * "Bildirimler": the shared inbox of the home, most recently updated first.
 * Per item "Okundu" / "Okunmadı" and "Sil" (asks "Bu bildirim silinsin mi?"
 * first; an item is only ever deleted by the user). Opening the panel or
 * hearing an item spoken does not mark it read. The caller sends
 * `notifications_list` when the panel opens and renders it only with the Core
 * feature `notifications`.
 */
export function NotificationsPanel({ notifications, connected, onRefresh, onAction, onClose }: Props) {
  /** Item whose "Bu bildirim silinsin mi?" question is shown. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const busy = notifications.status === "loading";
  const usable = connected && !busy;
  const items = notifications.items ?? [];
  const acting = notifications.acting;

  const label = (item: NotificationInfo, action: NotificationAction) =>
    acting?.notificationId === item.id && acting.action === action ? "İşleniyor…" : NOTIFICATION_ACTION_LABEL[action];

  const actionButtons = (item: NotificationInfo) => {
    if (confirming === item.id) {
      return (
        <div className="memory-actions dev-confirm" role="group" aria-label="Silme onayı">
          <p className="hint">Bu bildirim silinsin mi? Tüm cihazlardan kalkar.</p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!usable}
            onClick={() => {
              setConfirming(null);
              onAction(item.id, "delete");
            }}
          >
            Evet, sil
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
        <button type="button" className="btn btn-ghost" disabled={!usable} onClick={() => onAction(item.id, toggle)}>
          {label(item, toggle)}
        </button>
        <button type="button" className="btn btn-ghost" disabled={!usable} onClick={() => setConfirming(item.id)}>
          {label(item, "delete")}
        </button>
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
      {notifications.status === "error" && notifications.errorCode && (
        <p className="hint memory-error" role="alert">
          {notificationsErrorText(notifications.errorCode, notifications.errorMessage)}
        </p>
      )}
      {notifications.items !== null && notifications.unread !== null && notifications.unread > 0 && (
        <p className="hint">{notificationsUnreadText(notifications.unread)}.</p>
      )}
      {notifications.items !== null && items.length === 0 && <p className="hint">Bildirim yok.</p>}
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
