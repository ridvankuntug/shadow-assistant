/** User-facing Turkish strings. */
import type { Notice, Phase } from "../assistant/state.ts";
import type { ConnectionStatus } from "../protocol/client.ts";
import type { Quality } from "../scene/quality.ts";
import type { SttStatus } from "./serviceHealth.ts";

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
  usage_limit: "Kullanım limitine ulaşıldı.",
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

/**
 * Note under the mic button for the speech-to-text health (null = none).
 * `off`/`loading` come with a disabled mic; `failed` keeps the mic usable so
 * the user can retry the model load; `idle` is only a soft hint.
 */
export function sttNote(status: SttStatus): { text: string; soft: boolean } | null {
  switch (status) {
    case "off":
      return { text: "Ses tanıma şu an kapalı — yazarak devam edebilirsin.", soft: false };
    case "loading":
      return { text: "Ses tanıma hazırlanıyor — şimdilik yazarak devam edebilirsin.", soft: false };
    case "failed":
      return { text: "Ses tanıma modeli yüklenemedi — tekrar denemek için basabilirsin.", soft: false };
    case "idle":
      return { text: "İlk sesli mesajın çözülmesi birkaç saniye sürebilir.", soft: true };
    default:
      return null;
  }
}

/**
 * `retryAt`: only used for `usage_limit` (the reset time, epoch ms); `now` is
 * for tests.
 */
export function noticeText(code: string, message?: string, retryAt?: number, now = Date.now()): string {
  if (code === "usage_limit") return usageLimitText(retryAt, now);
  return NOTICE_TEXT[code] ?? (message ? `Hata: ${message}` : `Beklenmeyen hata (${code}).`);
}

/** The text of a notice card, with everything the notice carries (e.g. a usage_limit reset time). */
export function noticeMessage(notice: Notice, now = Date.now()): string {
  return noticeText(notice.code, notice.message, notice.retryAt, now);
}

// Locative suffix (-da/-de/-ta/-te) after a clock time, from the last number
// word as it is read aloud: "14:30" -> otuz -> 'da, "14:00" -> dört -> 'te.
const UNIT_SUFFIX = ["da", "de", "de", "te", "te", "te", "da", "de", "de", "da"]; // sıfır, bir … dokuz
const TENS_SUFFIX = ["", "da", "de", "da", "ta", "de"]; // on, yirmi, otuz, kırk, elli

/** `'da` / `'de` / `'ta` / `'te` for a time `hour:minute` (hour 0-23, minute 0-59). */
export function timeLocativeSuffix(hour: number, minute: number): string {
  const n = minute === 0 ? hour : minute;
  if (n === 0) return "'da";
  return `'${n % 10 !== 0 ? UNIT_SUFFIX[n % 10] : TENS_SUFFIX[Math.floor(n / 10) % 10]}`;
}

/**
 * "Kullanım limitine ulaşıldı; 14:30'da sıfırlanır." The date is added when the
 * reset is not today; without a usable future `retryAt` only the first part.
 */
export function usageLimitText(retryAt: number | undefined, now = Date.now()): string {
  const base = NOTICE_TEXT.usage_limit;
  if (retryAt === undefined || !Number.isFinite(retryAt) || retryAt <= now) return base;
  const d = new Date(retryAt);
  if (Number.isNaN(d.getTime())) return base;
  const h = d.getHours();
  const m = d.getMinutes();
  const hhmm = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const when = sameDay ? hhmm : `${d.toLocaleDateString("tr-TR", { day: "numeric", month: "long" })} ${hhmm}`;
  return `${base.slice(0, -1)}; ${when}${timeLocativeSuffix(h, m)} sıfırlanır.`;
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
