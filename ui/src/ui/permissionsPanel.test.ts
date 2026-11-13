/**
 * The "İzinler" page (T17.2, docs/11 D3 UI): frame parsing, the reducer, the
 * groups, the Turkish texts, the "⋮" count and the rendered page (switches
 * disabled without `canManage`, the risky-row note, the unavailable state).
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  initialState,
  isRiskyPcAction,
  pcPermissionGroups,
  pcPermissionsAvailable,
  pcPermissionsBadgeCount,
  reducer,
  type AssistantState,
  type PcPermissionsView,
} from "../assistant/state.ts";
import { parseServerMessage, type PcPermissionRow } from "../protocol/types.ts";
import { badgeText, menuBadgeCount } from "./menu.ts";
import { PermissionsPanel } from "./PermissionsPanel.tsx";
import {
  PC_PERMISSION_RISKY_NOTE,
  PC_PERMISSIONS_CANNOT_MANAGE,
  PC_PERMISSIONS_UNAVAILABLE,
  pcPermissionLabel,
  pcPermissionRequestsText,
  pcPermissionsErrorText,
} from "./strings.ts";

const row = (o: Partial<PcPermissionRow> = {}): PcPermissionRow => ({
  rowId: "p-0123456789abcdef",
  action: "open_app",
  kind: "app",
  label: "Steam",
  enabled: false,
  seen: false,
  requests: 2,
  createdAt: "2026-11-14T18:00:00.000Z",
  lastRequestedAt: "2026-11-14T18:05:00.000Z",
  ...o,
});

// ------------------------------------------------------------------ parsing

describe("parseServerMessage: pc_permissions / pc_permissions_count", () => {
  it("keeps valid rows with known fields only; drops malformed rows; needs the frame's flags", () => {
    const raw = {
      type: "pc_permissions",
      id: "p1",
      unseen: 1,
      canManage: false,
      available: true,
      extra: "x",
      rows: [
        { ...row(), aliases: ["steam"], targetId: "secret", changedAt: "2026-11-14T18:06:00.000Z" },
        { ...row(), enabled: "yes" },
        { ...row(), requests: -1 },
        { rowId: "", action: "open_app" },
        "junk",
      ],
    };
    const m = parseServerMessage(JSON.stringify(raw));
    expect(m).toEqual({
      type: "pc_permissions",
      id: "p1",
      unseen: 1,
      canManage: false,
      available: true,
      rows: [{ ...row(), changedAt: "2026-11-14T18:06:00.000Z" }],
    });
    for (const broken of [
      { ...raw, available: undefined },
      { ...raw, canManage: "true" },
      { ...raw, unseen: -1 },
      { ...raw, rows: {} },
      { ...raw, id: 5 },
    ]) {
      expect(parseServerMessage(JSON.stringify(broken))).toBeNull();
    }
    expect(parseServerMessage(JSON.stringify({ type: "pc_permissions_count", unseen: 3 }))).toEqual({ type: "pc_permissions_count", unseen: 3 });
    expect(parseServerMessage(JSON.stringify({ type: "pc_permissions_count", unseen: 1.5 }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "pc_permissions_count" }))).toBeNull();
  });
});

// ------------------------------------------------------------------ reducer

const connected = (features: string[] = ["pc_permissions"]): AssistantState => {
  let s = reducer(initialState, { type: "status", ev: { status: "connected", attempt: 0 } });
  s = reducer(s, { type: "server", msg: { type: "welcome", protocol: 1, sessionId: "s", device: "browser", features } });
  return s;
};

describe("reducer: İzinler", () => {
  it("only the answer to the latest request fills the page; the count follows broadcasts; welcome resets", () => {
    let s = connected();
    expect(pcPermissionsAvailable(s)).toBe(true);
    s = reducer(s, { type: "pc_permissions_requested", id: "a" });
    s = reducer(s, { type: "pc_permissions_requested", id: "b" });
    expect(s.pcPermissions.staleIds).toEqual(["a"]);
    const answer = (id: string) => ({ type: "pc_permissions" as const, id, rows: [row()], unseen: 1, canManage: true, available: true });
    s = reducer(s, { type: "server", msg: answer("a") });
    expect(s.pcPermissions.rows).toBeNull();
    s = reducer(s, { type: "server", msg: answer("b") });
    expect(s.pcPermissions).toMatchObject({ status: "ready", unseen: 1, canManage: true, available: true });
    expect(pcPermissionsBadgeCount(s)).toBe(1);
    s = reducer(s, { type: "server", msg: { type: "pc_permissions_count", unseen: 3 } });
    expect(pcPermissionsBadgeCount(s)).toBe(3);
    // A late error of the replaced request is dropped, not a chat notice.
    s = reducer(s, { type: "server", msg: { type: "error", id: "a", code: "internal" } });
    expect(s.notice).toBeNull();
    s = reducer(s, { type: "server", msg: { type: "welcome", protocol: 1, sessionId: "s2", device: "browser", features: ["pc_permissions"] } });
    expect(s.pcPermissions).toEqual(initialState.pcPermissions);
  });

  it("an error of the request stays on the page and keeps the rows; a lost connection fails a request in flight", () => {
    let s = connected();
    s = reducer(s, { type: "pc_permissions_requested", id: "a" });
    s = reducer(s, { type: "server", msg: { type: "pc_permissions", id: "a", rows: [row()], unseen: 1, canManage: true, available: true } });
    s = reducer(s, { type: "pc_permissions_requested", id: "b", acting: { rowId: row().rowId, enabled: true } });
    s = reducer(s, { type: "server", msg: { type: "error", id: "b", code: "not_allowed", message: "x" } });
    expect(s.pcPermissions).toMatchObject({ status: "error", errorCode: "not_allowed", acting: null });
    expect(s.pcPermissions.rows).toHaveLength(1);
    expect(s.notice).toBeNull();
    s = reducer(s, { type: "pc_permissions_requested", id: "c" });
    s = reducer(s, { type: "status", ev: { status: "reconnecting", attempt: 1 } });
    expect(s.pcPermissions.errorCode).toBe("connection");
    expect(pcPermissionsBadgeCount(s)).toBe(0);
  });

  it("without the feature nothing is offered and no count shows", () => {
    const s = reducer(connected(["dev"]), { type: "server", msg: { type: "pc_permissions_count", unseen: 2 } });
    expect(pcPermissionsAvailable(s)).toBe(false);
    expect(pcPermissionsBadgeCount(s)).toBe(0);
  });
});

describe("pcPermissionGroups", () => {
  it('"Yeni" (unseen, or new when the page opened) first, then "Açık", then "Kapalı"; order kept', () => {
    const rows = [
      row({ rowId: "p-1", seen: false }),
      row({ rowId: "p-2", seen: true, enabled: true }),
      row({ rowId: "p-3", seen: true, enabled: false }),
      row({ rowId: "p-4", seen: true, enabled: false }),
      row({ rowId: "p-5", seen: true, enabled: true }),
    ];
    const g = pcPermissionGroups(rows, new Set(["p-4"]));
    expect(g.fresh.map((r) => r.rowId)).toEqual(["p-1", "p-4"]);
    expect(g.on.map((r) => r.rowId)).toEqual(["p-2", "p-5"]);
    expect(g.off.map((r) => r.rowId)).toEqual(["p-3"]);
    expect(pcPermissionGroups([]).fresh).toEqual([]);
  });

  it("risky actions: shut down, restart, sleep, force-close", () => {
    for (const a of ["shutdown", "restart", "sleep", "force_close_app"]) expect(isRiskyPcAction(a)).toBe(true);
    for (const a of ["open_app", "close_app", "volume", "lock", "unknown"]) expect(isRiskyPcAction(a)).toBe(false);
  });
});

// ------------------------------------------------------------------ texts and the menu count

describe("İzinler texts and the ⋮ count", () => {
  it("label is ‹target› · ‹verb›; unknown actions shown as-is", () => {
    expect(pcPermissionLabel("Steam", "open_app")).toBe("Steam · aç");
    expect(pcPermissionLabel("Ses düzeyi", "volume")).toBe("Ses düzeyi · değiştir");
    expect(pcPermissionLabel("Bilgisayar", "shutdown")).toBe("Bilgisayar · kapat");
    expect(pcPermissionLabel("YouTube Music", "media_search")).toBe("YouTube Music · ara");
    expect(pcPermissionLabel("X", "new_action")).toBe("X · new_action");
    expect(pcPermissionRequestsText(3)).toBe("3 kez istendi");
    expect(pcPermissionsErrorText("not_allowed")).toBe("Bu cihaz izinleri değiştiremez.");
    expect(pcPermissionsErrorText("pc_permissions_unavailable")).toBe(PC_PERMISSIONS_UNAVAILABLE);
  });

  it("menuBadgeCount adds the positive counts; badgeText caps at 99+", () => {
    expect(menuBadgeCount([{ count: 2 }, {}, { count: 0 }, { count: 3 }, { count: -1 }, { count: 1.5 }])).toBe(5);
    expect(menuBadgeCount([])).toBe(0);
    expect(badgeText(7)).toBe("7");
    expect(badgeText(100)).toBe("99+");
  });
});

// ------------------------------------------------------------------ the page

const view = (o: Partial<PcPermissionsView> = {}): PcPermissionsView => ({
  ...initialState.pcPermissions,
  status: "ready",
  requestId: "p1",
  rows: [row(), row({ rowId: "p-1111111111111111", action: "shutdown", kind: "system", label: "Bilgisayar", enabled: true, seen: true })],
  unseen: 1,
  canManage: true,
  available: true,
  ...o,
});

const render = (p: PcPermissionsView, isConnected = true) =>
  renderToStaticMarkup(
    createElement(PermissionsPanel, { permissions: p, connected: isConnected, onRefresh: () => {}, onSwitch: () => {}, onClose: () => {} }),
  );

describe("PermissionsPanel", () => {
  it("groups, labels, counts and one switch per row; the risky note on a risky row that is on", () => {
    const html = render(view());
    expect(html).toContain("İzinler");
    expect(html.indexOf("Yeni")).toBeLessThan(html.indexOf("Açık"));
    expect(html).toContain("Steam · aç");
    expect(html).toContain("Bilgisayar · kapat");
    expect(html).toContain("2 kez istendi");
    expect(html).toContain(PC_PERMISSION_RISKY_NOTE);
    expect(html.match(/role="switch"/g)).toHaveLength(2);
    expect(html).not.toContain("disabled");
    expect(html).not.toContain(PC_PERMISSIONS_CANNOT_MANAGE);
  });

  it("canManage false: switches disabled with the CORE_PC_PERMISSION_DEVICES hint", () => {
    const html = render(view({ canManage: false }));
    expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain(PC_PERMISSIONS_CANNOT_MANAGE);
  });

  it("unavailable list: the problem is shown, no rows and no switches", () => {
    const html = render(view({ rows: [], unseen: 0, available: false }));
    expect(html).toContain(PC_PERMISSIONS_UNAVAILABLE);
    expect(html).not.toContain('role="switch"');
  });

  it("offline: switches disabled; empty list says so", () => {
    expect(render(view(), false).match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(3);
    expect(render(view({ rows: [], unseen: 0 }))).toContain("Henüz izin satırı yok.");
  });
});
