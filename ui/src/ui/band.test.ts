import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Band } from "./Band.tsx";
import { REHEARSAL_BAND } from "./strings.ts";

describe("Band (T11.5 prova)", () => {
  it("renders the text as a status line, with no button to dismiss it", () => {
    const html = renderToStaticMarkup(createElement(Band, null, REHEARSAL_BAND));
    expect(html).toContain('role="status"');
    expect(html).toContain('class="band band-info"');
    expect(html).toContain("Prova kipi: bildirimler ve sesli acil uyarı kapalı");
    expect(html).not.toContain("<button");
  });
});
