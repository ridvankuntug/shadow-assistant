import { describe, expect, it, vi } from "vitest";
import type { GeminiHandoff } from "../platform/types.ts";
import { watchGemini } from "./gemini.ts";

function host(gemini?: GeminiHandoff, visible = true) {
  const listeners = new Set<(v: boolean) => void>();
  return {
    adapter: {
      gemini,
      isVisible: () => visible,
      onVisibilityChange(l: (v: boolean) => void) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
    emit: (v: boolean) => {
      for (const l of [...listeners]) l(v);
    },
    count: () => listeners.size,
  };
}

function fakeGemini(available: () => boolean) {
  const failed = new Set<() => void>();
  const g: GeminiHandoff = {
    available: vi.fn(available),
    open: vi.fn(),
    onFailed(l) {
      failed.add(l);
      return () => failed.delete(l);
    },
  };
  return { g, fail: () => [...failed].forEach((l) => l()), failCount: () => failed.size };
}

describe("watchGemini", () => {
  it("does nothing without a Gemini hand-off (browser)", () => {
    const h = host(undefined);
    const off = watchGemini(h.adapter, vi.fn(), vi.fn());
    expect(h.count()).toBe(0);
    off();
  });

  it("asks again once per return to the foreground (the shell reports a return twice)", () => {
    let can = false;
    const { g } = fakeGemini(() => can);
    const h = host(g);
    const seen: boolean[] = [];
    watchGemini(h.adapter, (a) => seen.push(a), vi.fn());
    h.emit(false);
    can = true;
    h.emit(true);
    h.emit(true); // document visibility after the shell's event
    expect(seen).toEqual([true]);
    expect(g.available).toHaveBeenCalledTimes(1);
  });

  it("starting hidden: the first return asks", () => {
    const { g } = fakeGemini(() => true);
    const h = host(g, false);
    const onAvailable = vi.fn();
    watchGemini(h.adapter, onAvailable, vi.fn());
    h.emit(true);
    expect(onAvailable).toHaveBeenCalledWith(true);
  });

  it("a failed open shows the hint and asks again", () => {
    const { g, fail } = fakeGemini(() => false);
    const h = host(g);
    const onAvailable = vi.fn();
    const onFailed = vi.fn();
    watchGemini(h.adapter, onAvailable, onFailed);
    fail();
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onAvailable).toHaveBeenCalledWith(false);
  });

  it("unsubscribes from both", () => {
    const f = fakeGemini(() => true);
    const h = host(f.g);
    const off = watchGemini(h.adapter, vi.fn(), vi.fn());
    expect(h.count()).toBe(1);
    expect(f.failCount()).toBe(1);
    off();
    expect(h.count()).toBe(0);
    expect(f.failCount()).toBe(0);
  });
});
