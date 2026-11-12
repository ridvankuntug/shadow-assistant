import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NotificationsView } from "../assistant/state.ts";
import { NotificationsPanel } from "./NotificationsPanel.tsx";

const view: NotificationsView = {
  status: "ready",
  requestId: null,
  acting: null,
  items: [
    {
      id: "n-1",
      source: "service",
      urgency: "normal",
      title: "Servis durdu",
      body: "",
      createdAt: "2026-11-07T18:00:00.000Z",
      updatedAt: "2026-11-07T18:00:00.000Z",
      readAt: null,
      raised: 1,
    },
  ],
  unread: 1,
  unavailable: false,
  errorCode: null,
  errorMessage: null,
  staleIds: [],
};

const render = (canSuppress: boolean) =>
  renderToStaticMarkup(
    createElement(NotificationsPanel, {
      notifications: view,
      connected: true,
      canSuppress,
      onRefresh: () => {},
      onAction: () => {},
      onClose: () => {},
    }),
  );

describe("NotificationsPanel dismiss actions (T7.w.11.8)", () => {
  it("older Core: only \"Gördüm\", no \"Tekrar gösterme\"", () => {
    const html = render(false);
    expect(html).toContain(">Gördüm</button>");
    expect(html).toContain('aria-label="Gördüm: Servis durdu"');
    expect(html).not.toContain("Tekrar gösterme");
  });

  it("with notifications_suppress: both, each with its own label and hint", () => {
    const html = render(true);
    expect(html).toContain(">Gördüm</button>");
    expect(html).toContain(">Tekrar gösterme</button>");
    expect(html).toContain('aria-label="Tekrar gösterme: Servis durdu"');
    expect(html).toMatch(/title="[^"]*bir kez daha gelebilir/);
    expect(html).toMatch(/title="[^"]*durum sürdükçe gösterilmez/);
  });
});
