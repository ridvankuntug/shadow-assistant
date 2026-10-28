import { describe, expect, it } from "vitest";
import type { ServiceHealth } from "../protocol/types.ts";
import { issuesSummary, serviceIssues, serviceLabel, serviceReason } from "./serviceHealth.ts";

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
