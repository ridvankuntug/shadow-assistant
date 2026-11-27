import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Band } from "./Band.tsx";
import { REHEARSAL_BAND, versionBaseBandText } from "./strings.ts";

describe("Band (T11.5 prova)", () => {
  it("renders the text as a status line, with no button to dismiss it", () => {
    const html = renderToStaticMarkup(createElement(Band, null, REHEARSAL_BAND));
    expect(html).toContain('role="status"');
    expect(html).toContain('class="band band-info"');
    expect(html).toContain("Prova kipi: bildirimler ve sesli acil uyarı kapalı");
    expect(html).not.toContain("<button");
  });
});

describe("version band text (T12.3)", () => {
  it("shows only the X.Y bases of both sides", () => {
    expect(versionBaseBandText("0.2.61", "0.3.4")).toBe("Sürüm uyuşmuyor: arayüz 0.2, çekirdek 0.3 — güncelleyin");
    expect(versionBaseBandText("0.2", "1.0")).toBe("Sürüm uyuşmuyor: arayüz 0.2, çekirdek 1.0 — güncelleyin");
  });

  it("an unknown or malformed version shows as ?", () => {
    expect(versionBaseBandText("0.0.0-dev", null)).toBe("Sürüm uyuşmuyor: arayüz ?, çekirdek ? — güncelleyin");
  });
});
