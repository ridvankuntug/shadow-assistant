import { describe, expect, it } from "vitest";
import type { ServiceHealth } from "../protocol/types.ts";
import { issuesSummary, serviceIssues, serviceLabel, serviceReason, sttBlocked, sttStatus } from "./serviceHealth.ts";
import { sttNote } from "./strings.ts";

const item = (name: string, status: ServiceHealth["status"], detail?: string): ServiceHealth =>
  detail === undefined ? { name, status, checkedAt: 1 } : { name, status, checkedAt: 1, detail };

describe("serviceLabel", () => {
  it("uses Turkish labels for known services and the name otherwise", () => {
    expect(serviceLabel("whisper-svc")).toBe("Ses tanıma");
    expect(serviceLabel("tts-svc")).toBe("Ses çıkışı");
    expect(serviceLabel("home-assistant")).toBe("Ev bağlantısı");
    expect(serviceLabel("weather-svc")).toBe("weather-svc");
  });
});

describe("serviceIssues", () => {
  it("is silent when the list is empty, all ok, or only disabled", () => {
    expect(serviceIssues([])).toBeNull();
    expect(serviceIssues([item("whisper-svc", "ok"), item("tts-svc", "ok")])).toBeNull();
    expect(serviceIssues([item("whisper-svc", "ok"), item("home-assistant", "disabled", "not_configured")])).toBeNull();
  });

  it("shows down before loading and reports the worst level", () => {
    const issues = serviceIssues([
      item("whisper-svc", "loading"),
      item("tts-svc", "ok"),
      item("home-assistant", "down", "unauthorized"),
    ]);
    expect(issues?.level).toBe("down");
    expect(issues?.items.map((i) => i.name)).toEqual(["home-assistant", "whisper-svc"]);
    expect(serviceIssues([item("whisper-svc", "loading")])?.level).toBe("loading");
  });
});

describe("serviceReason", () => {
  it("maps known detail codes, HTTP statuses and unknown codes", () => {
    expect(serviceReason(item("x", "down", "timeout"))).toBe("yanıt vermiyor (zaman aşımı)");
    expect(serviceReason(item("x", "down", "unreachable"))).toBe("ulaşılamıyor");
    expect(serviceReason(item("x", "down", "unauthorized"))).toBe("erişim anahtarı reddedildi");
    expect(serviceReason(item("x", "down", "http_502"))).toBe("çalışmıyor (HTTP 502)");
    expect(serviceReason(item("x", "down", "weird"))).toBe("çalışmıyor (weird)");
    expect(serviceReason(item("x", "down"))).toBe("çalışmıyor");
    expect(serviceReason(item("x", "loading"))).toBe("hazırlanıyor");
  });

  it("summary names each problem service", () => {
    const issues = serviceIssues([item("whisper-svc", "down", "timeout"), item("tts-svc", "loading")]);
    expect(issues && issuesSummary(issues)).toBe(
      "Ses tanıma: yanıt vermiyor (zaman aşımı); Ses çıkışı: hazırlanıyor",
    );
  });
});

describe("sttStatus (mic availability)", () => {
  it("is unknown before the first services frame or when whisper-svc is not listed", () => {
    expect(sttStatus([])).toBe("unknown");
    expect(sttStatus([item("tts-svc", "down")])).toBe("unknown");
    expect(sttBlocked("unknown")).toBe(false);
    expect(sttNote("unknown")).toBeNull();
  });

  it("ok keeps the mic usable without a note", () => {
    expect(sttStatus([item("whisper-svc", "ok")])).toBe("ready");
    expect(sttStatus([item("whisper-svc", "ok", "warm")])).toBe("ready");
    expect(sttBlocked("ready")).toBe(false);
    expect(sttNote("ready")).toBeNull();
  });

  it("ok + idle (model unloaded) keeps the mic usable with a soft hint", () => {
    const s = sttStatus([item("tts-svc", "down"), item("whisper-svc", "ok", "idle")]);
    expect(s).toBe("idle");
    expect(sttBlocked(s)).toBe(false);
    expect(sttNote(s)).toEqual({ text: expect.stringContaining("birkaç saniye"), soft: true });
  });

  it("down, disabled (e.g. stopped by the host) and loading block the mic with a note", () => {
    for (const st of [
      sttStatus([item("whisper-svc", "down", "unreachable")]),
      sttStatus([item("whisper-svc", "down", "timeout")]),
      sttStatus([item("whisper-svc", "down", "http_500")]),
      sttStatus([item("whisper-svc", "down")]),
      sttStatus([item("whisper-svc", "disabled", "off")]),
      sttStatus([item("whisper-svc", "disabled", "error")]), // only down+error is retryable
    ]) {
      expect(st).toBe("off");
      expect(sttBlocked(st)).toBe(true);
      expect(sttNote(st)).toEqual({ text: "Ses tanıma şu an kapalı — yazarak devam edebilirsin.", soft: false });
    }
    const loading = sttStatus([item("whisper-svc", "loading")]);
    expect(loading).toBe("loading");
    expect(sttBlocked(loading)).toBe(true);
    expect(sttNote(loading)?.soft).toBe(false);
  });

  it("down + error (model load failed, service reachable) keeps the mic usable so the user can retry", () => {
    const s = sttStatus([item("whisper-svc", "down", "error")]);
    expect(s).toBe("failed");
    expect(sttBlocked(s)).toBe(false);
    expect(sttNote(s)).toEqual({
      text: "Ses tanıma modeli yüklenemedi — tekrar denemek için basabilirsin.",
      soft: false,
    });
  });
});
