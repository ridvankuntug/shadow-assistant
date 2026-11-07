/**
 * The tray opens the UI at `#dev` / `#notifications` (docs/08 §T7.w.4,
 * §T7.w.5). A consumed hash is dropped so the tray can target the same panel
 * again in this tab (a `hashchange` only fires when the hash changes).
 */
export type TrayPanel = "dev" | "notifications";

const TRAY_HASH: Record<TrayPanel, string> = { dev: "#dev", notifications: "#notifications" };

/** The part of `window` this module uses (a fake in tests). */
export type HashWindow = {
  location: { hash: string; pathname: string; search: string };
  history: { replaceState(data: unknown, unused: string, url: string): void };
  addEventListener(type: "hashchange", listener: () => void): void;
  removeEventListener(type: "hashchange", listener: () => void): void;
};

/** The panel a hash asks for, or null. */
export function trayTarget(hash: string): TrayPanel | null {
  if (hash === TRAY_HASH.dev) return "dev";
  if (hash === TRAY_HASH.notifications) return "notifications";
  return null;
}

/** Drops the hash when it asks for `panel` (which is open now). Returns whether it did. */
export function clearTrayHash(win: HashWindow, panel: string): boolean {
  if (trayTarget(win.location.hash) !== panel) return false;
  win.history.replaceState(null, "", win.location.pathname + win.location.search);
  return true;
}

/**
 * Reports each tray hash to `onWant`. When the panel it asks for is already
 * open, the hash is dropped right away: opening an open panel changes no
 * state, so nothing else would clear it. Returns an unsubscribe function.
 */
export function watchTrayHash(win: HashWindow, openPanel: () => string, onWant: (panel: TrayPanel) => void): () => void {
  const onHash = () => {
    const target = trayTarget(win.location.hash);
    if (target === null) return;
    if (openPanel() === target) clearTrayHash(win, target);
    onWant(target);
  };
  win.addEventListener("hashchange", onHash);
  return () => win.removeEventListener("hashchange", onHash);
}
