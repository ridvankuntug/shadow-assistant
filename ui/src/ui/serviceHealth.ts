/**
 * Service health indicator logic (pure, tested): which services to surface
 * and how to describe them in Turkish. The indicator is silent while every
 * service is `ok`; `disabled` services are off on purpose and stay silent too.
 */
import type { ServiceHealth } from "../protocol/types.ts";

const SERVICE_LABEL: Record<string, string> = {
  "whisper-svc": "Ses tanıma",
  "tts-svc": "Ses çıkışı",
  "home-assistant": "Ev bağlantısı",
  "shadow-vault": "Notlar",
};

/** Human label; an unknown service is shown by its services.yaml name. */
export function serviceLabel(name: string): string {
  return SERVICE_LABEL[name] ?? name;
}

const DETAIL_TEXT: Record<string, string> = {
  timeout: "yanıt vermiyor (zaman aşımı)",
  unreachable: "ulaşılamıyor",
  unauthorized: "erişim anahtarı reddedildi",
  error: "hata bildiriyor",
  bad_response: "beklenmeyen yanıt",
  not_found: "klasör bulunamadı",
};

/** Short reason for one item; unknown detail codes are shown as-is. */
export function serviceReason(item: ServiceHealth): string {
  if (item.status === "loading") return "hazırlanıyor";
  if (item.status === "ok") return "çalışıyor";
  if (item.status === "disabled") return "kapalı";
  const d = item.detail;
  if (!d) return "çalışmıyor";
  if (DETAIL_TEXT[d]) return DETAIL_TEXT[d];
  const http = /^http_(\d{3})$/.exec(d);
  if (http) return `çalışmıyor (HTTP ${http[1]})`;
  return `çalışmıyor (${d})`;
}

export type ServiceIssues = {
  /** `down` first, then `loading`; each group keeps the Core's order. */
  items: ServiceHealth[];
  /** Worst status among them; drives the indicator colour. */
  level: "down" | "loading";
};

/** Services worth showing, or null when the indicator should stay hidden. */
export function serviceIssues(services: readonly ServiceHealth[]): ServiceIssues | null {
  const down = services.filter((s) => s.status === "down");
  const loading = services.filter((s) => s.status === "loading");
  if (down.length === 0 && loading.length === 0) return null;
  return { items: [...down, ...loading], level: down.length > 0 ? "down" : "loading" };
}

/** One-line summary for the indicator's accessible name. */
export function issuesSummary(issues: ServiceIssues): string {
  return issues.items.map((s) => `${serviceLabel(s.name)}: ${serviceReason(s)}`).join("; ");
}
