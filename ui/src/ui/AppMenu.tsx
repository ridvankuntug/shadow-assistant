import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { badgeText, menuBadgeCount, menuKey } from "./menu.ts";

/**
 * One entry. `count` (e.g. new İzinler rows) is drawn next to the label and
 * added up on the "⋮" button, like the Development badge: a number only,
 * never a sound or a notification. `countLabel` says it in words for screen readers.
 */
export type AppMenuItem = { id: string; label: string; onSelect: () => void; count?: number; countLabel?: string };

/**
 * The top bar's "⋮" menu (T16.2): a button and a small list of entries. Opens
 * with the first entry focused; Escape (or Tab, or a tap outside) closes it,
 * Escape returning the focus to the button; arrow keys / Home / End move
 * between entries. Choosing an entry closes the menu first.
 */
export function AppMenu({ items }: { items: readonly AppMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const listId = useId();
  const total = menuBadgeCount(items);
  const counted = items.filter((i) => (i.count ?? 0) > 0 && i.countLabel).map((i) => i.countLabel);
  const buttonLabel = total > 0 && counted.length > 0 ? `Menü: ${counted.join(", ")}` : "Menü";

  useEffect(() => {
    if (!open) return;
    itemRefs.current[0]?.focus();
    const onPointer = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    const index = itemRefs.current.findIndex((el) => el === document.activeElement);
    const result = menuKey(e.key, index < 0 ? 0 : index, items.length);
    if (result === null) return;
    if (result === "close") {
      setOpen(false);
      // Tab moves on by itself; Escape goes back to the button.
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        buttonRef.current?.focus();
      }
      return;
    }
    e.preventDefault();
    itemRefs.current[result.focus]?.focus();
  };

  return (
    <div className="app-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={total > 0 ? "btn btn-icon menu-btn dev-badge" : "btn btn-icon menu-btn"}
        aria-label={buttonLabel}
        title={buttonLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
        </svg>
        {total > 0 && (
          <span className="dev-count" aria-hidden="true">
            {badgeText(total)}
          </span>
        )}
      </button>
      {open && (
        <ul id={listId} className="app-menu-list" role="menu" aria-label="Menü" onKeyDown={onKeyDown}>
          {items.map((item, i) => (
            <li key={item.id} role="none">
              <button
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role="menuitem"
                className="app-menu-item"
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
                {(item.count ?? 0) > 0 && (
                  <>
                    {" "}
                    <span className="dev-count" aria-hidden="true">
                      {badgeText(item.count ?? 0)}
                    </span>
                    {item.countLabel && <span className="visually-hidden">, {item.countLabel}</span>}
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
