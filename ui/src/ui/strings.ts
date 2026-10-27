/** User-facing Turkish strings. */
import type { Phase } from "../assistant/state.ts";
import type { ConnectionStatus } from "../protocol/client.ts";
import type { Quality } from "../scene/quality.ts";

export const PHASE_LABEL: Record<Phase, string> = {
  idle: "Hazır",
  listening: "Dinliyorum",
  thinking: "Düşünüyorum",
  speaking: "Konuşuyorum",
  awaiting_confirm: "Onay bekliyor",
};

export const CONNECTION_LABEL: Record<ConnectionStatus, string> = {
  connecting: "Bağlanıyor…",
  authenticating: "Kimlik doğrulanıyor…",
  connected: "Bağlı",
  reconnecting: "Bağlantı koptu",
  unauthorized: "Cihaz anahtarı reddedildi",
  incompatible: "Sürüm uyumsuz",
  closed: "Bağlı değil",
};

export const QUALITY_LABEL: Record<Quality, string> = {
  high: "Yüksek",
  medium: "Orta",
  low: "Düşük",
};

const NOTICE_TEXT: Record<string, string> = {
  unauthorized: "Cihaz anahtarı geçersiz. Bağlantı ayarlarını kontrol et.",
  bad_request: "Çekirdek isteği anlamadı.",
  stt_unavailable: "Ses tanıma servisine ulaşılamıyor. Yazarak devam edebilirsin.",
  tts_unavailable: "Seslendirme servisine ulaşılamıyor; cevap yalnızca yazılı.",
  model_error: "Model bir hata verdi. Tekrar dener misin?",
  busy: "Shadow şu an başka bir isteği işliyor.",
  internal: "Çekirdekte beklenmeyen bir hata oluştu.",
  incompatible: "Çekirdek bu arayüzün protokol sürümünü desteklemiyor. Arayüzü ya da çekirdeği güncelle.",
  confirm_pending: "Önce onay kartını yanıtla: düğmeyle ya da sesle (“evet” / “hayır”).",
  not_an_answer: "Onay için yalnızca “evet” ya da “hayır” de; istersen düğmeleri kullan.",
  not_connected: "Çekirdeğe bağlı değil.",
  too_short: "Konuşmak için düğmeye basılı tut ya da bir kez dokunup konuş, sonra tekrar dokun.",
  mic_permission_denied: "Mikrofon izni verilmedi. Tarayıcı ayarlarından izin ver.",
  mic_not_supported: "Bu ortamda mikrofon kullanılamıyor (tarayıcıda https ya da localhost gerekir).",
  mic_busy: "Mikrofon başka bir uygulama tarafından kullanılıyor.",
  mic_timeout: "Mikrofon yanıt vermedi.",
  mic_capture_aborted: "Uygulama arka plana geçtiği için kayıt durduruldu; ses gönderilmedi.",
  mic_unknown: "Mikrofon kaydı başarısız oldu.",
  playback_failed: "Ses çalınamadı.",
  tts_failed: "Cevap seslendirilemedi.",
};

export function noticeText(code: string, message?: string): string {
  return NOTICE_TEXT[code] ?? (message ? `Hata: ${message}` : `Beklenmeyen hata (${code}).`);
}

export function toolStatusText(status: "started" | "done" | "denied" | "error"): string {
  switch (status) {
    case "started":
      return "çalışıyor";
    case "done":
      return "tamam";
    case "denied":
      return "reddedildi";
    case "error":
      return "hata";
  }
}

export function resolvedText(approved: boolean, by: "button" | "voice" | "timeout"): string {
  if (by === "timeout") return "Onay süresi doldu; işlem yapılmadı.";
  const how = by === "voice" ? "sesle" : "düğmeyle";
  return approved ? `Onaylandı (${how}).` : `Reddedildi (${how}).`;
}

export function formatTime(ts: number): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("tr-TR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
