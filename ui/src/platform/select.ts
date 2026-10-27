/**
 * Picks the platform adapter for the current host: the Android shell injects
 * `window.ShadowAndroid`; everything else is a browser.
 */
import { createAndroidAdapter, isAndroidBridge, type AndroidWindow } from "./android.ts";
import type { PlatformAdapter } from "./types.ts";

export type AdapterChoice = {
  adapter: PlatformAdapter;
  /** Why this adapter was chosen (shown in diagnostics, useful in tests). */
  reason: "android-bridge" | "no-bridge" | "bridge-invalid";
};

export function selectAdapter(
  win: AndroidWindow,
  factories: {
    web: () => PlatformAdapter;
    android?: (win: AndroidWindow) => PlatformAdapter;
  },
): AdapterChoice {
  if (win.ShadowAndroid === undefined || win.ShadowAndroid === null) {
    return { adapter: factories.web(), reason: "no-bridge" };
  }
  if (isAndroidBridge(win.ShadowAndroid)) {
    try {
      return { adapter: (factories.android ?? createAndroidAdapter)(win), reason: "android-bridge" };
    } catch (err) {
      console.warn("[shadow] ShadowAndroid bridge rejected, falling back to web adapter:", err);
    }
  }
  return { adapter: factories.web(), reason: "bridge-invalid" };
}
