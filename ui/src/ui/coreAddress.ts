/**
 * The Core address the connect screen starts with when none is stored
 * (docs/13 §4.1, T11.6). A stored address always wins (App passes it as
 * `initialUrl`); this is only the prefilled value, the user can change it.
 */
import type { ClientKind } from "../protocol/types.ts";

/** Today's default: the Core on the same PC (tray UiServer, `npm run dev`, Android before it is set up). */
export const DEFAULT_CORE_URL = "ws://localhost:8700/ws";

/** The Android shell's own asset origin (WebViewAssetLoader.DEFAULT_DOMAIN): https, but not a Core. */
const ANDROID_ASSET_HOST = "appassets.androidplatform.net";

/**
 * `wss://<same host>/ws` when the page is a browser page served over HTTPS
 * (the Pi Core's TLS listener serves the UI and `/ws` on the same origin);
 * otherwise DEFAULT_CORE_URL. The Android WebView (its own https asset origin)
 * and every http page (the tray's http://localhost, the dev server) keep the
 * old default.
 */
export function defaultCoreUrl(clientKind: ClientKind, location: Pick<Location, "protocol" | "host" | "hostname"> | undefined): string {
  if (clientKind !== "web" || !location) return DEFAULT_CORE_URL;
  if (location.protocol !== "https:" || !location.host) return DEFAULT_CORE_URL;
  if (location.hostname.toLowerCase() === ANDROID_ASSET_HOST) return DEFAULT_CORE_URL;
  return `wss://${location.host}/ws`;
}
