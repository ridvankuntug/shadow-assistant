/**
 * The "Adresler" button (Android shells with `openAddresses`): in Ayarlar next to
 * "Bağlantı ayarları" and on the connect screen; absent on the web / older shells.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectScreen } from "./ConnectScreen.tsx";
import { SettingsPanel } from "./Panels.tsx";
import { ADDRESSES_HINT } from "./strings.ts";

const noop = () => {};

const settings = (onOpenAddresses?: () => void) =>
  renderToStaticMarkup(
    createElement(SettingsPanel, {
      quality: "low",
      voiceReplies: false,
      reducedMotion: false,
      coreUrl: "wss://core.example/ws",
      onQuality: noop,
      onVoiceReplies: noop,
      onChangeConnection: noop,
      onOpenAddresses,
      onClose: noop,
    }),
  );

const connect = (onOpenAddresses?: () => void) =>
  renderToStaticMarkup(
    createElement(ConnectScreen, { initialUrl: "", initialToken: "", onSubmit: noop, onOpenAddresses }),
  );

describe("Adresler button", () => {
  it("settings: shown with the capability, next to Bağlantı ayarları", () => {
    const html = settings(noop);
    expect(html).toContain("Bağlantı ayarları");
    expect(html).toContain(">Adresler</button>");
    expect(html).toContain(ADDRESSES_HINT);
    expect(html.indexOf("Bağlantı ayarları")).toBeLessThan(html.indexOf(">Adresler</button>"));
  });

  it("settings: hidden without the capability (web, older shells)", () => {
    const html = settings(undefined);
    expect(html).toContain("Bağlantı ayarları");
    expect(html).not.toContain(">Adresler</button>");
    expect(html).not.toContain(ADDRESSES_HINT);
  });

  it("connect screen: shown only with the capability", () => {
    expect(connect(noop)).toContain(">Adresler</button>");
    expect(connect(undefined)).not.toContain(">Adresler</button>");
  });
});
