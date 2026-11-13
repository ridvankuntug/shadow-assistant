import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DevView } from "../assistant/state.ts";
import { DevPanel } from "./DevPanel.tsx";

const dev: DevView = {
  status: "ready",
  requestId: null,
  acting: null,
  items: [
    {
      itemId: "h-1",
      type: "note",
      kind: "ha_urgency",
      status: "open",
      message: "HA uyarı türü “pn:backup_failed” acil sayılsın mı?",
      count: 3,
      firstSeen: "2026-11-07T18:00:00.000Z",
      lastSeen: "2026-11-08T07:30:00.000Z",
    },
  ],
  open: 1,
  canManage: false,
  errorCode: null,
  errorMessage: null,
  staleIds: [],
};

describe("DevPanel HA urgency suggestion (T7.w.11.10)", () => {
  it("shows the question with Kabul and Yok say (no CORE_DEV_DEVICES needed)", () => {
    const html = renderToStaticMarkup(
      createElement(DevPanel, { dev, connected: true, onRefresh: () => {}, onAction: () => {}, onClose: () => {} }),
    );
    expect(html).toContain("acil sayılsın mı?");
    expect(html).toContain(">Kabul</button>");
    expect(html).toContain(">Yok say</button>");
    expect(html).not.toContain(">Düzeltildi</button>");
    expect(html).toContain("Ev uyarısı aciliyet önerisi");
    expect(html).not.toContain("Bu cihaz kural ekleyemez");
  });
});
