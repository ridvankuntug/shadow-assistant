/**
 * The top bar's "⋮" menu (T16.2): pure keyboard handling, unit-tested. More
 * items will join "Güncelleme ve sürüm" later; the handling does not care how many.
 */

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
