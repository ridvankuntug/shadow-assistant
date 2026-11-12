import type { AppInfo } from "../platform/types.ts";

/** What the "Güncelleme ve sürüm" page shows (T16.2). */
export type VersionView =
  /** A browser: no installed app, so neither a version nor an update check. */
  | { kind: "browser" }
  | { kind: "app"; name: string; code: string; openUpdates?: () => void };

const UNKNOWN = "bilinmiyor";

export function versionView(app: AppInfo | undefined): VersionView {
  if (!app) return { kind: "browser" };
  return {
    kind: "app",
    name: app.versionName ?? UNKNOWN,
    code: app.versionCode !== undefined ? String(app.versionCode) : UNKNOWN,
    ...(app.openUpdates ? { openUpdates: app.openUpdates } : {}),
  };
}
