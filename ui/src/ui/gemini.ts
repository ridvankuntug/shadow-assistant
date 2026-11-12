import type { PlatformAdapter } from "../platform/types.ts";

/**
 * Keeps the Gemini button in step with the host (T16.3): availability is asked
 * again each time the app comes back to the foreground (Gemini may have been
 * installed or removed meanwhile), and once more after a failed open, which
 * also shows a hint (`onFailed`). Nothing to watch without a Gemini hand-off.
 * Returns an unsubscribe function.
 */
export function watchGemini(
  adapter: Pick<PlatformAdapter, "gemini" | "isVisible" | "onVisibilityChange">,
  onAvailable: (available: boolean) => void,
  onFailed: () => void,
): () => void {
  const gemini = adapter.gemini;
  if (!gemini) return () => {};
  // Android reports a return twice (the shell's event and document visibility): ask once per return.
  let wasVisible = adapter.isVisible();
  const offVisibility = adapter.onVisibilityChange((visible) => {
    if (visible && !wasVisible) onAvailable(gemini.available());
    wasVisible = visible;
  });
  const offFailed = gemini.onFailed(() => {
    onFailed();
    onAvailable(gemini.available());
  });
  return () => {
    offVisibility();
    offFailed();
  };
}
