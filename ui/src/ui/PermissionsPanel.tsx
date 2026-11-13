import { useState, type CSSProperties } from "react";
import { isRiskyPcAction, pcPermissionGroups, type PcPermissionsView } from "../assistant/state.ts";
import type { PcPermissionRow } from "../protocol/types.ts";
import { Drawer } from "./Panels.tsx";
import {
  formatTime,
  PC_PERMISSION_RISKY_NOTE,
  PC_PERMISSIONS_CANNOT_MANAGE,
  PC_PERMISSIONS_EMPTY,
  PC_PERMISSIONS_GROUP,
  PC_PERMISSIONS_INTRO,
  PC_PERMISSIONS_TITLE,
  PC_PERMISSIONS_UNAVAILABLE,
  pcPermissionLabel,
  pcPermissionRequestsText,
  pcPermissionsErrorText,
} from "./strings.ts";

type Props = {
  permissions: PcPermissionsView;
  connected: boolean;
  onRefresh: () => void;
  onSwitch: (rowId: string, enabled: boolean) => void;
  onClose: () => void;
};

const LABEL_STYLE: CSSProperties = { minWidth: 0, overflowWrap: "anywhere" };

const timeText = (iso: string) => {
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? "" : formatTime(ts);
};

/**
 * "İzinler" (docs/11 D3 UI): one row per PC action + target with one switch,
 * grouped "Yeni" (not yet seen when the page opened), "Açık", "Kapalı". The
 * switch sends an explicit value; it is disabled while this device may not
 * switch (`canManage: false`, with the CORE_PC_PERMISSION_DEVICES hint), while
 * the Core cannot read its list, offline or while a request is in flight.
 * Display only otherwise: no sound, no notification, no delete (v1). The caller
 * opens / closes the page through the controller (list, then
 * `pc_permissions_seen`) and renders it only with the Core feature `pc_permissions`.
 */
export function PermissionsPanel({ permissions: p, connected, onRefresh, onSwitch, onClose }: Props) {
  // Rows that were new while the page is open stay under "Yeni" after the Core marked them seen.
  const [freshIds, setFreshIds] = useState<ReadonlySet<string>>(() => new Set());
  const [seenRows, setSeenRows] = useState<PcPermissionRow[] | null>(null);
  if (p.rows !== seenRows) {
    // Adjusted during render (no effect needed): add the unseen rows of a new list.
    setSeenRows(p.rows);
    const fresh = (p.rows ?? []).filter((r) => !r.seen).map((r) => r.rowId);
    if (fresh.some((id) => !freshIds.has(id))) setFreshIds(new Set([...freshIds, ...fresh]));
  }

  const busy = p.status === "loading";
  const unavailable = p.available === false;
  const canSwitch = connected && !busy && p.canManage && p.available === true;
  const rows = p.rows ?? [];
  const groups = pcPermissionGroups(rows, freshIds);

  const section = (title: string, list: PcPermissionRow[]) =>
    list.length > 0 && (
      <section className="memory-section">
        <h3>{title}</h3>
        <ul className="memory-list">
          {list.map((r) => {
            const label = pcPermissionLabel(r.label, r.action);
            const last = timeText(r.lastRequestedAt);
            // The switch being sent shows its new value until the Core answers.
            const pending = p.acting !== null && p.acting !== "seen" && p.acting.rowId === r.rowId ? p.acting : null;
            return (
              <li key={r.rowId} className="memory-entry">
                <label className="switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={pending ? pending.enabled : r.enabled}
                    disabled={!canSwitch}
                    onChange={(e) => onSwitch(r.rowId, e.target.checked)}
                  />
                  {/* Long names (a site, an app) wrap instead of widening the page on a 360 px phone. */}
                  <span style={LABEL_STYLE}>{label}</span>
                </label>
                <span className="history-meta">
                  {pcPermissionRequestsText(r.requests)}
                  {last && ` · son istek: ${last}`}
                  {pending && " · İşleniyor…"}
                </span>
                {isRiskyPcAction(r.action) && r.enabled && <p className="hint">{PC_PERMISSION_RISKY_NOTE}</p>}
              </li>
            );
          })}
        </ul>
      </section>
    );

  return (
    <Drawer title={PC_PERMISSIONS_TITLE} onClose={onClose}>
      <button type="button" className="btn btn-ghost" disabled={!connected || busy} onClick={onRefresh}>
        Yenile
      </button>
      {!connected ? (
        <p className="hint">Bağlantı yok.</p>
      ) : (
        busy && (
          <p className="hint" role="status">
            {p.acting !== null && p.acting !== "seen" ? "İşleniyor…" : "Yükleniyor…"}
          </p>
        )
      )}
      {p.status === "error" && p.errorCode && p.errorCode !== "pc_permissions_unavailable" && (
        <p className="hint memory-error" role="alert">
          {pcPermissionsErrorText(p.errorCode, p.errorMessage)}
        </p>
      )}
      {(unavailable || p.errorCode === "pc_permissions_unavailable") && (
        <p className="hint memory-error" role="alert">
          {PC_PERMISSIONS_UNAVAILABLE}
        </p>
      )}
      {p.rows !== null && !unavailable && <p className="hint">{PC_PERMISSIONS_INTRO}</p>}
      {p.rows !== null && !unavailable && rows.length > 0 && !p.canManage && <p className="hint">{PC_PERMISSIONS_CANNOT_MANAGE}</p>}
      {p.rows !== null && !unavailable && rows.length === 0 && <p className="hint">{PC_PERMISSIONS_EMPTY}</p>}
      {section(PC_PERMISSIONS_GROUP.fresh, groups.fresh)}
      {section(PC_PERMISSIONS_GROUP.on, groups.on)}
      {section(PC_PERMISSIONS_GROUP.off, groups.off)}
    </Drawer>
  );
}
