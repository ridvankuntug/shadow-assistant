/**
 * Top bar overflow guard (T16.3). On a 360 px phone the brand, the connection
 * status and every icon (service health, development, inbox, history,
 * settings, Gemini, menu) do not fit: with this many icons the bar is
 * "crowded" and, up to 480 px wide (index.css), the brand text is hidden.
 * The connection status shrinks to its dot by itself (it ellipsizes).
 *
 * Widths behind the threshold (index.css): an icon is 40 px on phones, a
 * badge with a count up to ~50 px ("99+"); the brand is ~85 px with its gap.
 * Five icons (worst case two with counts, ~220 px) still fit beside the brand
 * at 360 px; from six on they do not. Between 421 and 480 px the icons are
 * 44 px and the brand ~100 px: seven icons with the brand need ~460 px, so
 * the guard reaches to 480 px; without the brand they need ~350 px.
 */
export const CROWDED_FROM = 6;

export type TopbarIcons = {
  services: boolean;
  dev: boolean;
  notifications: boolean;
  gemini: boolean;
};

/** History, settings and the menu are always there. */
const ALWAYS = 3;

export function topbarIconCount(icons: TopbarIcons): number {
  return ALWAYS + [icons.services, icons.dev, icons.notifications, icons.gemini].filter(Boolean).length;
}

export function topbarCrowded(icons: TopbarIcons): boolean {
  return topbarIconCount(icons) >= CROWDED_FROM;
}
