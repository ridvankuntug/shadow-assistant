/**
 * Default Core address (T11.6): the page's own origin when a browser loads the
 * UI over HTTPS (the Pi's TLS listener); today's default everywhere else.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ConnectScreen } from "./ConnectScreen.tsx";
import { DEFAULT_CORE_URL, defaultCoreUrl } from "./coreAddress.ts";

const loc = (href: string) => {
  const u = new URL(href);
  return { protocol: u.protocol, host: u.host, hostname: u.hostname };
};

describe("defaultCoreUrl", () => {
  it("browser page over https: wss to the same host and port", () => {
    expect(defaultCoreUrl("web", loc("https://192.0.2.10:8743/"))).toBe("wss://192.0.2.10:8743/ws");
    expect(defaultCoreUrl("web", loc("https://192.0.2.10/index.html?x=1#notifications"))).toBe("wss://192.0.2.10/ws");
    expect(defaultCoreUrl("web", loc("https://[fd00::a]:8743/"))).toBe("wss://[fd00::a]:8743/ws");
  });

  it("http pages keep today's default (tray UiServer, dev server)", () => {
    expect(defaultCoreUrl("web", loc("http://localhost:8703/"))).toBe(DEFAULT_CORE_URL);
    expect(defaultCoreUrl("web", loc("http://127.0.0.1:5173/"))).toBe(DEFAULT_CORE_URL);
    expect(DEFAULT_CORE_URL).toBe("ws://localhost:8700/ws");
  });

  it("the Android WebView keeps today's default, also with the web adapter fallback", () => {
    expect(defaultCoreUrl("android", loc("https://appassets.androidplatform.net/assets/ui/index.html"))).toBe(DEFAULT_CORE_URL);
    expect(defaultCoreUrl("web", loc("https://appassets.androidplatform.net/assets/ui/index.html"))).toBe(DEFAULT_CORE_URL);
    expect(defaultCoreUrl("android", loc("https://192.0.2.10:8743/"))).toBe(DEFAULT_CORE_URL);
  });

  it("no location or another scheme: today's default", () => {
    expect(defaultCoreUrl("web", undefined)).toBe(DEFAULT_CORE_URL);
    expect(defaultCoreUrl("web", loc("file:///C:/ui/index.html"))).toBe(DEFAULT_CORE_URL);
  });
});

describe("ConnectScreen address field", () => {
  const render = (initialUrl: string, defaultUrl?: string) =>
    renderToStaticMarkup(
      createElement(ConnectScreen, { initialUrl, initialToken: "", defaultUrl, onSubmit: () => {} }),
    );

  it("prefills the given default when nothing is stored", () => {
    const html = render("", "wss://192.0.2.10:8743/ws");
    expect(html).toContain('value="wss://192.0.2.10:8743/ws"');
    expect(html).toContain('placeholder="wss://192.0.2.10:8743/ws"');
  });

  it("a stored address wins over the default", () => {
    expect(render("ws://192.0.2.20:8700/ws", "wss://192.0.2.10:8743/ws")).toContain('value="ws://192.0.2.20:8700/ws"');
  });

  it("without a default: today's ws://localhost:8700/ws", () => {
    expect(render("")).toContain(`value="${DEFAULT_CORE_URL}"`);
  });
});
