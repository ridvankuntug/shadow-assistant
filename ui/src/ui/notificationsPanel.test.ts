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

describe("NotificationsPanel urgency feedback (T7.w.11.10)", () => {
  const haView: NotificationsView = {
    ...view,
    items: [
      { ...view.items![0]!, id: "n-ha", source: "ha", title: "Giriş denemesi" },
      { ...view.items![0]!, id: "n-svc", source: "service", title: "Servis durdu" },
    ],
  };
  const renderHa = (canFeedback: boolean | undefined) =>
    renderToStaticMarkup(
      createElement(NotificationsPanel, {
        notifications: haView,
        connected: true,
        canSuppress: true,
        ...(canFeedback === undefined ? {} : { canFeedback }),
        onRefresh: () => {},
        onAction: () => {},
        onClose: () => {},
      }),
    );

  it("with ha_urgency_feedback: \"Bu acildi\" / \"Acil değildi\" only on the Home Assistant item", () => {
    const html = renderHa(true);
    expect(html).toContain('aria-label="Bu acildi: Giriş denemesi"');
    expect(html).toContain('aria-label="Acil değildi: Giriş denemesi"');
    expect(html).not.toContain("Bu acildi: Servis durdu");
    expect(html).not.toContain("Acil değildi: Servis durdu");
    expect(html.match(/>Bu acildi<\/button>/g)).toHaveLength(1);
  });

  it("\"Kaydedildi\" only for the signal the Core accepted (view.feedback)", () => {
    const html = (feedback: NotificationsView["feedback"]) =>
      renderToStaticMarkup(
        createElement(NotificationsPanel, {
          notifications: { ...haView, feedback },
          connected: true,
          canSuppress: false,
          canFeedback: true,
          onRefresh: () => {},
          onAction: () => {},
          onClose: () => {},
        }),
      );
    expect(html(null)).not.toContain("Kaydedildi");
    const sent = html({ notificationId: "n-ha", action: "urgent_no" });
    expect(sent).toContain("Kaydedildi: acil değildi");
    expect(sent).toContain('aria-pressed="true" aria-label="Acil değildi: Giriş denemesi"');
  });

  it("without the feature (older Core, or prop absent): no feedback buttons", () => {
    expect(renderHa(false)).not.toContain("Bu acildi");
    expect(renderHa(undefined)).not.toContain("Acil değildi");
  });
});
