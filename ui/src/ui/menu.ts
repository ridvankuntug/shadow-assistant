/**
 * The top bar's "⋮" menu (T16.2): pure keyboard handling, unit-tested. More
 * items will join "Güncelleme ve sürüm" later; the handling does not care how many.
 */

/**
 * The count shown on the "⋮" button: the sum of its entries' counts (only
 * positive whole numbers count), so a new İzinler row is visible without
 * opening the menu. 0 = no count.
 */
export function menuBadgeCount(items: readonly { count?: number }[]): number {
  return items.reduce((n, i) => n + (i.count !== undefined && Number.isInteger(i.count) && i.count > 0 ? i.count : 0), 0);
}

/** The count as drawn: up to 99, then "99+". */
export function badgeText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

/** What a key does in an open menu of `count` items, the focus being on `index`. */
export type MenuKeyResult = { focus: number } | "close" | null;

export function menuKey(key: string, index: number, count: number): MenuKeyResult {
  if (key === "Escape" || key === "Tab") return "close";
  if (count <= 0) return null;
  switch (key) {
    case "ArrowDown":
      return { focus: (index + 1 + count) % count };
    case "ArrowUp":
      return { focus: (index - 1 + count) % count };
    case "Home":
      return { focus: 0 };
    case "End":
      return { focus: count - 1 };
    default:
      return null;
  }
}
