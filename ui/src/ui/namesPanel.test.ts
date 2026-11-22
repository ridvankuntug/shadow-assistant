/**
 * Confirmed device names (docs/14 Decisions 7-8): the "Cihaz adları" panel
 * texts and rendering, and the confirm card's "Evet, hep bu" option.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { initialState, type NamesView, type PendingConfirm } from "../assistant/state.ts";
import type { DeviceNameItem } from "../protocol/types.ts";
import { ConfirmCard } from "./ConfirmCard.tsx";
import { NamesPanel } from "./NamesPanel.tsx";
import {
  CONFIRM_REMEMBER_LABEL,
  NAMES_EMPTY,
  NAMES_TITLE,
  confirmRememberText,
  nameRowText,
  nameStatusHint,
  nameStatusText,
  namesErrorText,
} from "./strings.ts";

const item = (o: Partial<DeviceNameItem> = {}): DeviceNameItem => ({
  id: "n-3f9a1c",
  spoken: "bahçe pompasnı",
  target: { name: "Bahçe Pompası", domain: "switch", areas: ["Bahçe"] },
  status: "active",
  missingSince: null,
  lastUsedAt: null,
  uses: 0,
  ...o,
});

const view = (o: Partial<NamesView> = {}): NamesView => ({ ...initialState.names, status: "ready", requestId: "n1", ...o });

const panel = (names: NamesView, connected = true) =>
  renderToStaticMarkup(
    createElement(NamesPanel, { names, connected, onRefresh: vi.fn(), onDelete: vi.fn(), onClose: vi.fn() }),
  );

const confirm = (o: Partial<PendingConfirm> = {}): PendingConfirm => ({
  requestId: "c1",
  turnId: "t1",
  tool: "intent__HassTurnOff",
  summary: "Bahçe Pompası kapatılsın mı? Bu cihazın adını söylemedin.",
  expiresAt: Date.now() + 60_000,
  responding: false,
  ...o,
});

const card = (c: PendingConfirm) => renderToStaticMarkup(createElement(ConfirmCard, { confirm: c, onAnswer: vi.fn() }));

/** Button labels in document order. */
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);

describe("device names texts", () => {
  it("row: spoken → target (areas); no parentheses without an area", () => {
    expect(nameRowText(item())).toBe("bahçe pompasnı → Bahçe Pompası (Bahçe)");
    expect(nameRowText(item({ target: { name: "Bahçe Pompası", domain: "switch", areas: [] } }))).toBe("bahçe pompasnı → Bahçe Pompası");
    expect(nameRowText(item({ target: { name: "Bahçe Pompası", domain: "switch", areas: ["Bahçe", "Dış"] } }))).toBe(
      "bahçe pompasnı → Bahçe Pompası (Bahçe, Dış)",
    );
  });

  it("status: Pasif, Bulunamadı (active + missingSince), nothing for a seen active one, unknown as-is", () => {
    expect(nameStatusText(item({ status: "passive", missingSince: "2026-10-01T00:00:00.000Z" }))).toBe("Pasif");
    expect(nameStatusText(item({ status: "passive" }))).toBe("Pasif");
    expect(nameStatusText(item({ missingSince: "2026-11-20T00:00:00.000Z" }))).toBe("Bulunamadı");
    expect(nameStatusText(item())).toBeNull();
    expect(nameStatusText(item({ status: "archived" }))).toBe("archived");
  });

  it("errors: local timeout/connection, bad_request, internal; otherwise the notice text", () => {
    expect(namesErrorText("timeout")).toMatch(/yanıt vermedi/);
    expect(namesErrorText("connection")).toMatch(/Bağlantı koptu/);
    expect(namesErrorText("bad_request")).toMatch(/reddetti/);
    expect(namesErrorText("internal")).toMatch(/okunamadı ya da kaydedilemedi/);
    expect(namesErrorText("weird", "boom")).toBe("Hata: boom");
  });

  it("confirm card line: “spoken” → target", () => {
    expect(confirmRememberText("bahçe pompasnı", "Bahçe Pompası")).toBe("“bahçe pompasnı” → Bahçe Pompası");
  });
});

describe("NamesPanel", () => {
  it("rows with their status labels and a Sil button each; no add or edit", () => {
    const html = panel(
      view({
        items: [
          item(),
          item({ id: "n-000002", spoken: "pompa", status: "passive", missingSince: "2026-10-01T00:00:00.000Z" }),
          item({ id: "n-000003", spoken: "sulama", missingSince: "2026-11-20T00:00:00.000Z" }),
        ],
      }),
    );
    expect(html).toContain(NAMES_TITLE);
    expect(html).toContain("bahçe pompasnı → Bahçe Pompası (Bahçe)");
    expect(html).toContain("· Pasif");
    expect(html).toContain("· Bulunamadı");
    expect(html).toContain(nameStatusHint(item({ status: "passive" })));
    expect(html).toContain(nameStatusHint(item({ missingSince: "2026-11-20T00:00:00.000Z" })));
    expect(buttons(html).filter((b) => b === "Sil")).toHaveLength(3);
    expect(html).toContain('aria-label="Sil: bahçe pompasnı → Bahçe Pompası (Bahçe)"');
    expect(html).not.toMatch(/Ekle|Düzenle/);
  });

  it("an active, seen row has no status label", () => {
    const html = panel(view({ items: [item()] }));
    expect(html).not.toContain("Pasif");
    expect(html).not.toContain("Bulunamadı");
    expect(nameStatusHint(item())).toBeUndefined();
  });

  it("empty list text; nothing listed yet shows neither rows nor the empty text", () => {
    expect(panel(view({ items: [] }))).toContain(NAMES_EMPTY);
    const loading = panel(view({ status: "loading", items: null }));
    expect(loading).not.toContain(NAMES_EMPTY);
    expect(loading).toContain("Yükleniyor…");
  });

  it("while deleting: the row says Siliniyor… and the buttons are disabled", () => {
    const html = panel(view({ status: "loading", requestId: "n2", deleting: "n-3f9a1c", items: [item()] }));
    expect(html).toContain("Siliniyor…");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Siliniyor…<\/button>/);
  });

  it("offline: Bağlantı yok and disabled buttons", () => {
    const html = panel(view({ items: [item()] }), false);
    expect(html).toContain("Bağlantı yok.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Sil<\/button>/);
  });

  it("an error is shown with its text and the last items stay", () => {
    const html = panel(view({ status: "error", errorCode: "internal", items: [item()] }));
    expect(html).toContain(namesErrorText("internal"));
    expect(html).toContain("bahçe pompasnı → Bahçe Pompası (Bahçe)");
  });
});

describe("ConfirmCard “Evet, hep bu”", () => {
  it("with remember: shows spoken → target and three answers Hayır / Evet / Evet, hep bu", () => {
    const html = card(confirm({ remember: { spoken: "bahçe pompasnı", target: "Bahçe Pompası" } }));
    expect(html).toContain("“bahçe pompasnı” → Bahçe Pompası");
    expect(buttons(html)).toEqual([CONFIRM_REMEMBER_LABEL.no, CONFIRM_REMEMBER_LABEL.once, CONFIRM_REMEMBER_LABEL.always]);
    expect(buttons(html)).toEqual(["Hayır", "Evet", "Evet, hep bu"]);
    expect(html).toContain('aria-describedby="confirm-summary confirm-remember"');
  });

  it("without remember: today's two answers, no spoken → target line", () => {
    const html = card(confirm());
    expect(buttons(html)).toEqual(["Reddet", "Onayla"]);
    expect(html).not.toContain("→");
    expect(html).not.toContain("Evet, hep bu");
  });

  it("all three answers are disabled while a button answer is in flight", () => {
    const html = card(confirm({ responding: true, remember: { spoken: "bahçe pompasnı", target: "Bahçe Pompası" } }));
    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(3);
  });
});
