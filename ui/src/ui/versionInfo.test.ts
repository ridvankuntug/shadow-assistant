import { describe, expect, it, vi } from "vitest";
import { versionView } from "./versionInfo.ts";

describe("versionView", () => {
  it("a browser has no installed app", () => {
    expect(versionView(undefined)).toEqual({ kind: "browser" });
  });

  it("the Android app: name, code and the update check", () => {
    const openUpdates = vi.fn();
    expect(versionView({ versionName: "0.1.57", versionCode: 57, openUpdates })).toEqual({
      kind: "app",
      name: "0.1.57",
      code: "57",
      openUpdates,
    });
  });

  it("an older shell: unknown parts say so, no update check", () => {
    expect(versionView({ versionName: "0.1.0" })).toEqual({ kind: "app", name: "0.1.0", code: "bilinmiyor" });
    expect(versionView({})).toEqual({ kind: "app", name: "bilinmiyor", code: "bilinmiyor" });
  });
});
