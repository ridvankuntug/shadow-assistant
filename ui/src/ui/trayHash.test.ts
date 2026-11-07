import { describe, expect, it } from "vitest";
import { clearTrayHash, trayTarget, watchTrayHash, type HashWindow } from "./trayHash.ts";

/** A window whose hash the test sets; `navigate` fires hashchange like a browser. */
function fakeWindow(hash = "") {
  const listeners = new Set<() => void>();
  const replaced: string[] = [];
  const win: HashWindow = {
    location: { hash, pathname: "/app", search: "?x=1" },
    history: {
      replaceState(_data, _unused, url) {
        replaced.push(url);
        win.location.hash = "";
      },
    },
    addEventListener: (_type, l) => void listeners.add(l),
    removeEventListener: (_type, l) => void listeners.delete(l),
  };
  return {
    win,
    replaced,
    listeners,
    navigate(h: string) {
      win.location.hash = h;
      for (const l of [...listeners]) l();
    },
  };
}

describe("tray hash (#dev / #notifications)", () => {
  it("maps only the two tray hashes", () => {
    expect(trayTarget("#dev")).toBe("dev");
    expect(trayTarget("#notifications")).toBe("notifications");
    expect(trayTarget("")).toBeNull();
    expect(trayTarget("#memory")).toBeNull();
  });

  it("clearTrayHash drops the hash only when it asks for the given panel", () => {
    const f = fakeWindow("#dev");
    expect(clearTrayHash(f.win, "notifications")).toBe(false);
    expect(clearTrayHash(f.win, "none")).toBe(false);
    expect(f.replaced).toEqual([]);
    expect(clearTrayHash(f.win, "dev")).toBe(true);
    expect(f.replaced).toEqual(["/app?x=1"]);
    expect(f.win.location.hash).toBe("");
  });

  it("a hash for a closed panel is reported and left for the opening panel to clear", () => {
    const f = fakeWindow();
    const wanted: string[] = [];
    watchTrayHash(f.win, () => "none", (p) => wanted.push(p));
    f.navigate("#notifications");
    expect(wanted).toEqual(["notifications"]);
    expect(f.replaced).toEqual([]);
  });

  it("a hash for the panel already open is dropped right away (each time)", () => {
    const f = fakeWindow();
    let open = "dev";
    const wanted: string[] = [];
    watchTrayHash(f.win, () => open, (p) => wanted.push(p));
    f.navigate("#dev");
    expect(f.replaced).toHaveLength(1);
    f.navigate("#dev"); // the tray again, same panel still open
    expect(f.replaced).toHaveLength(2);
    open = "notifications";
    f.navigate("#notifications");
    expect(f.replaced).toHaveLength(3);
    expect(f.win.location.hash).toBe("");
    expect(wanted).toEqual(["dev", "dev", "notifications"]);
  });

  it("other hashes are ignored; unsubscribing stops listening", () => {
    const f = fakeWindow();
    const wanted: string[] = [];
    const stop = watchTrayHash(f.win, () => "dev", (p) => wanted.push(p));
    f.navigate("#other");
    expect(wanted).toEqual([]);
    expect(f.replaced).toEqual([]);
    stop();
    expect(f.listeners.size).toBe(0);
  });
});
