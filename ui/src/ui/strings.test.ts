import { describe, expect, it } from "vitest";
import {
  DEV_ACTION_LABEL,
  devDomainsText,
  devErrorText,
  devKindText,
  devPatternText,
  devRuleDetails,
  devStatusText,
  devToolText,
  memoryCharsText,
  memoryErrorText,
  memoryWarningText,
} from "./strings.ts";

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

describe("development panel texts", () => {
  it("rule pattern with Turkish slots, action label and details", () => {
    expect(devPatternText(["<ad>", "yüzde", "<sayi>", "yap"])).toBe("‹cihaz› yüzde ‹sayı› yap");
    expect(devToolText("light__HassLightSet")).toBe("parlaklık ayarla");
    expect(devToolText("intent__HassTurnOff")).toBe("kapat");
    expect(devToolText("x__Other")).toBe("x__Other");
    expect(devDomainsText(["light", "media_player", "fan"])).toBe("ışık, medya oynatıcı, fan");
    expect(
      devRuleDetails({ tokens: ["<ad>"], tool: "light__HassLightSet", domains: ["light"], numberRange: { min: 20, max: 80 }, observations: 3 }),
    ).toEqual(["Eylem: parlaklık ayarla", "Cihaz türü: ışık", "Sayı aralığı: 20–80", "3 kez görüldü"]);
    expect(devRuleDetails({ tokens: ["<ad>"], tool: "intent__HassTurnOn", domains: [], observations: 1 })).toEqual([
      "Eylem: aç",
      "1 kez görüldü",
    ]);
  });

  it("statuses and kinds in Turkish; unknown values as-is", () => {
    expect(devStatusText("candidate")).toBe("aday");
    expect(devStatusText("brand_new")).toBe("brand_new");
    expect(devKindText("missing_capability")).toBe("Eksik yetenek");
    expect(devKindText("future_kind")).toBe("future_kind");
    expect(DEV_ACTION_LABEL).toEqual({ add_rule: "Kuralı ekle", ignore: "Yok say", fixed: "Düzeltildi" });
  });

  it("errors: local timeout/connection, unknown_item, not_allowed, otherwise the notice text", () => {
    expect(devErrorText("timeout")).toMatch(/yanıt vermedi/);
    expect(devErrorText("connection")).toMatch(/Bağlantı koptu/);
    expect(devErrorText("unknown_item")).toMatch(/Listeyi yenile/);
    expect(devErrorText("not_allowed")).toMatch(/yetkisi yok/);
    expect(devErrorText("internal")).toBe("Çekirdekte beklenmeyen bir hata oluştu.");
    expect(devErrorText("weird", "boom")).toBe("Hata: boom");
  });
});
