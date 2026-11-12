import { describe, expect, it } from "vitest";
import { menuKey } from "./menu.ts";

describe("menuKey", () => {
  it("Escape and Tab close the menu", () => {
    expect(menuKey("Escape", 0, 1)).toBe("close");
    expect(menuKey("Tab", 2, 3)).toBe("close");
    expect(menuKey("Escape", 0, 0)).toBe("close");
  });

  it("arrows wrap around; Home/End go to the ends", () => {
    expect(menuKey("ArrowDown", 0, 3)).toEqual({ focus: 1 });
    expect(menuKey("ArrowDown", 2, 3)).toEqual({ focus: 0 });
    expect(menuKey("ArrowUp", 0, 3)).toEqual({ focus: 2 });
    expect(menuKey("Home", 2, 3)).toEqual({ focus: 0 });
    expect(menuKey("End", 0, 3)).toEqual({ focus: 2 });
    // A single entry (today's menu) stays on it.
    expect(menuKey("ArrowDown", 0, 1)).toEqual({ focus: 0 });
    expect(menuKey("ArrowUp", 0, 1)).toEqual({ focus: 0 });
  });

  it("other keys (Enter/Space activate the button natively) and an empty menu do nothing", () => {
    expect(menuKey("Enter", 0, 1)).toBeNull();
    expect(menuKey("a", 0, 1)).toBeNull();
    expect(menuKey("ArrowDown", 0, 0)).toBeNull();
  });
});
