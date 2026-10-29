import { describe, expect, it } from "vitest";
import { memoryCharsText, memoryErrorText, memoryWarningText } from "./strings.ts";

describe("memory panel texts", () => {
  it("known warnings in Turkish, with the topic title when known", () => {
    const titles = { tercihler: "Tercihler" };
    expect(memoryWarningText({ code: "note_over_budget", topic: "tercihler" }, titles)).toBe("“Tercihler” notu önerilen boyutu aştı.");
    expect(memoryWarningText({ code: "note_full", topic: "ev" }, titles)).toBe("“ev” notu dolu; bu konuya yeni bilgi eklenmiyor.");
    expect(memoryWarningText({ code: "note_full:tercihler" }, titles)).toContain("“Tercihler” notu dolu");
    expect(memoryWarningText({ code: "memory_full" })).toMatch(/^Hafıza dolu/);
    expect(memoryWarningText({ code: "brief_over_budget" })).toMatch(/^Kısa özet/);
  });

  it("unknown warning codes as free text", () => {
    expect(memoryWarningText({ code: "disk_slow" })).toBe("Uyarı: disk_slow");
    expect(memoryWarningText({ code: "odd", topic: "ev" })).toBe("Uyarı: odd (ev)");
  });

  it("errors: local timeout/connection, bad_request, otherwise the notice text", () => {
    expect(memoryErrorText("timeout")).toMatch(/yanıt vermedi/);
    expect(memoryErrorText("connection")).toMatch(/Bağlantı koptu/);
    expect(memoryErrorText("bad_request", "unknown entryId")).toMatch(/Listeyi yenile/);
    expect(memoryErrorText("internal")).toBe("Çekirdekte beklenmeyen bir hata oluştu.");
    expect(memoryErrorText("weird", "boom")).toBe("Hata: boom");
  });

  it("character counts", () => {
    expect(memoryCharsText(412, 800)).toBe("412 / 800 karakter");
    expect(memoryCharsText(96)).toBe("96 karakter");
  });
});
