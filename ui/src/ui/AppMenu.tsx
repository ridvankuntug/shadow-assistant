import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { menuKey } from "./menu.ts";

export type AppMenuItem = { id: string; label: string; onSelect: () => void };

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
        className="btn btn-icon menu-btn"
        aria-label="Menü"
        title="Menü"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" />
        </svg>
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
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
