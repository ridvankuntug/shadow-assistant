import { describe, expect, it } from "vitest";
import { CROWDED_FROM, topbarCrowded, topbarIconCount } from "./topbar.ts";

const none = { services: false, dev: false, notifications: false, gemini: false };

describe("topbar overflow guard", () => {
  it("history, settings and the menu are always counted", () => {
    expect(topbarIconCount(none)).toBe(3);
    expect(topbarCrowded(none)).toBe(false);
  });

  it("five icons still fit beside the brand; six do not", () => {
    expect(topbarCrowded({ ...none, dev: true, notifications: true })).toBe(false);
    expect(topbarIconCount({ ...none, dev: true, notifications: true, gemini: true })).toBe(CROWDED_FROM);
    expect(topbarCrowded({ ...none, dev: true, notifications: true, gemini: true })).toBe(true);
  });

  it("every badge on plus Gemini and the menu is crowded", () => {
    const all = { services: true, dev: true, notifications: true, gemini: true };
    expect(topbarIconCount(all)).toBe(7);
    expect(topbarCrowded(all)).toBe(true);
  });
});
