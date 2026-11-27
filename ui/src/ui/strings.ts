/** User-facing Turkish strings. */
import type { Notice, Phase } from "../assistant/state.ts";
import type { ConnectionStatus } from "../protocol/client.ts";
import type { DevAction, DevRuleInfo, DeviceNameItem, MemoryWarning, NotificationAction } from "../protocol/types.ts";
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

/** The stage label while the Core is not connected and nothing runs locally. */
const OFFLINE_STAGE_LABEL: Record<Exclude<ConnectionStatus, "connected">, string> = {
  connecting: "Bağlanıyor…",
  authenticating: "Bağlanıyor…",
  reconnecting: "Bağlanılamadı",
  unauthorized: "Bağlanılamadı",
  incompatible: "Sürüm uyumsuz",
  closed: "Bağlı değil",
};

/**
 * The stage's main status line. "Hazır" only with a connected Core: while
 * disconnected an idle stage shows the connection state instead (the talk and
 * send buttons are disabled then, so "ready" would be wrong). A phase that is
 * running (e.g. a reply still playing) keeps its own label.
 */
export function stageLabel(phase: Phase, status: ConnectionStatus): string {
  return stageOffline(phase, status) ? OFFLINE_STAGE_LABEL[status] : PHASE_LABEL[phase];
}

/** True when [stageLabel] shows the connection state rather than a phase (styled muted). */
export function stageOffline(phase: Phase, status: ConnectionStatus): status is Exclude<ConnectionStatus, "connected"> {
  return phase === "idle" && status !== "connected";
}

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
  gemini_failed: "Gemini açılamadı: cihazda Gemini uygulaması ya da bir tarayıcı bulunamadı.",
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

// ---------------------------------------------------------------- memory panel

/**
 * A memory warning for the panel. `topic` (or the older `code:<topic>` form)
 * is shown with its title when `titles` knows it; unknown codes as free text.
 */
export function memoryWarningText(w: MemoryWarning, titles: Record<string, string> = {}): string {
  const [code, inlineTopic] = w.code.split(":", 2);
  const topic = w.topic ?? inlineTopic;
  const name = topic ? `“${titles[topic] ?? topic}”` : "Bir";
  switch (code) {
    case "brief_over_budget":
      return "Kısa özet önerilen boyutu aştı.";
    case "brief_truncated":
      return "Kısa özet çok uzun; Shadow yalnızca baş kısmını kullanıyor.";
    case "note_over_budget":
      return `${name} notu önerilen boyutu aştı.`;
    case "note_full":
      return `${name} notu dolu; bu konuya yeni bilgi eklenmiyor.`;
    case "memory_full":
      return "Hafıza dolu; yeni bilgi eklenmiyor. Gereksiz kayıtları silebilirsin.";
    default:
      return topic && !inlineTopic ? `Uyarı: ${w.code} (${topic})` : `Uyarı: ${w.code}`;
  }
}

/** Why the last memory request failed (`timeout` / `connection` are local codes). */
export function memoryErrorText(code: string, message?: string | null): string {
  switch (code) {
    case "timeout":
      return "Çekirdek hafıza isteğine yanıt vermedi.";
    case "connection":
      return "Bağlantı koptu; hafıza alınamadı.";
    case "bad_request":
      return "Çekirdek isteği reddetti: kayıt artık yok ya da hafıza kapalı. Listeyi yenile.";
    default:
      return noticeText(code, message ?? undefined);
  }
}

/** "412 / 800 karakter" */
export function memoryCharsText(chars: number, budget?: number): string {
  return budget ? `${chars} / ${budget} karakter` : `${chars} karakter`;
}

// ------------------------------------------------------- development panel

export const DEV_ACTION_LABEL: Record<DevAction, string> = {
  add_rule: "Kuralı ekle",
  ignore: "Yok say",
  fixed: "Düzeltildi",
  remove_rule: "Kaldır",
  accept: "Kabul",
};

/** Button label for an action on an item: `add_rule` on a suspended rule is "Yeniden aç". */
export function devActionLabel(action: DevAction, status: string): string {
  return action === "add_rule" && status === "suspended" ? "Yeniden aç" : DEV_ACTION_LABEL[action];
}

/** The question asked before an action that changes how the home is controlled; null = no question. */
export function devConfirmText(action: DevAction, status: string): { question: string; yes: string; label: string } | null {
  if (action === "add_rule" && status === "suspended") {
    return {
      question: "Bu kural yeniden etkinleşsin mi? Hata sayacı sıfırlanır; bu kalıba uyan cümleler yine modele sorulmadan doğrudan çalışır.",
      yes: "Evet, yeniden aç",
      label: "Kuralı yeniden açma onayı",
    };
  }
  if (action === "add_rule") {
    return {
      question: "Bu kural etkinleşsin mi? Bu kalıba uyan cümleler artık modele sorulmadan doğrudan çalışır.",
      yes: "Evet, ekle",
      label: "Kural ekleme onayı",
    };
  }
  if (action === "remove_rule") {
    return {
      question: "Bu kural kaldırılsın mı? Bu kalıba uyan cümleler yine modele sorulur ve bu kalıp bir daha önerilmez.",
      yes: "Evet, kaldır",
      label: "Kural kaldırma onayı",
    };
  }
  return null;
}

const DEV_STATUS: Record<string, string> = {
  candidate: "aday",
  active: "etkin",
  suspended: "askıya alındı",
  rejected: "reddedildi",
  open: "açık",
  ignored: "yok sayıldı",
  fixed: "düzeltildi",
};

/** Item status in Turkish; unknown values as-is (docs/02 *Development*). */
export function devStatusText(status: string): string {
  return DEV_STATUS[status] ?? status;
}

const DEV_KIND: Record<string, string> = {
  learned_rule: "Öğrenilen kural",
  new_tool: "Yeni araç",
  tool_added: "Araç eklendi",
  tool_removed: "Araç kaldırıldı",
  rule_unmatched: "Kurala uymayan araç",
  missing_capability: "Eksik yetenek",
  wandering: "Uzayan tur",
  tool_error: "Araç hatası",
  rule_suspended: "Askıya alınan kural",
  ha_urgency: "Ev uyarısı aciliyet önerisi",
};

/** Note kind heading; unknown kinds as-is. */
export function devKindText(kind: string): string {
  return DEV_KIND[kind] ?? kind;
}

const DEV_TOOL: Record<string, string> = {
  intent__HassTurnOn: "aç",
  intent__HassTurnOff: "kapat",
  light__HassLightSet: "parlaklık ayarla",
};

/** What a learned rule does, as a Turkish label; unknown tools by name. */
export function devToolText(tool: string): string {
  return DEV_TOOL[tool] ?? tool;
}

const DEV_DOMAIN: Record<string, string> = {
  light: "ışık",
  switch: "priz / anahtar",
  media_player: "medya oynatıcı",
};

/** "ışık, medya oynatıcı"; unknown domains as-is. */
export function devDomainsText(domains: readonly string[]): string {
  return domains.map((d) => DEV_DOMAIN[d] ?? d).join(", ");
}

const DEV_SLOT: Record<string, string> = { "<ad>": "‹cihaz›", "<sayi>": "‹sayı›" };

/** The rule pattern with its slots: `[<ad>, yüzde, <sayi>, yap]` → "‹cihaz› yüzde ‹sayı› yap". */
export function devPatternText(tokens: readonly string[]): string {
  return tokens.map((t) => DEV_SLOT[t] ?? t).join(" ");
}

/** How far a rule generalizes, shown before "Kuralı ekle". */
export function devRuleDetails(rule: DevRuleInfo): string[] {
  const lines = [`Eylem: ${devToolText(rule.tool)}`];
  if (rule.domains.length > 0) lines.push(`Cihaz türü: ${devDomainsText(rule.domains)}`);
  if (rule.numberRange) lines.push(`Sayı aralığı: ${rule.numberRange.min}–${rule.numberRange.max}`);
  lines.push(`${rule.observations} kez görüldü`);
  return lines;
}

/** Badge / button label: "3 açık öğe". */
export function devOpenText(open: number): string {
  return `${open} açık öğe`;
}

/** Why the last Development request failed (`timeout` / `connection` are local codes). */
export function devErrorText(code: string, message?: string | null): string {
  switch (code) {
    case "timeout":
      return "Çekirdek geliştirme isteğine yanıt vermedi.";
    case "connection":
      return "Bağlantı koptu; geliştirme listesi alınamadı.";
    case "unknown_item":
      return "Bu öğe artık listede yok. Listeyi yenile.";
    case "not_allowed":
      return "Bu işlem bu öğe için geçerli değil ya da bu cihazın yetkisi yok.";
    case "bad_request":
      return "Çekirdek isteği reddetti. Listeyi yenile.";
    default:
      return noticeText(code, message ?? undefined);
  }
}

// ------------------------------------------------------- notification inbox

export const NOTIFICATION_ACTION_LABEL: Record<NotificationAction, string> = {
  read: "Okundu",
  unread: "Okunmadı",
  delete: "Gördüm",
  suppress: "Tekrar gösterme",
  urgent_yes: "Bu acildi",
  urgent_no: "Acil değildi",
};

/** Shown on an item after its urgency signal was sent (the Core suggests a change after three). */
export const NOTIFICATION_FEEDBACK_SENT: Record<"urgent_yes" | "urgent_no", string> = {
  urgent_yes: "Kaydedildi: acildi. Üç kez aynı yönde olunca Geliştirme'de öneri çıkar.",
  urgent_no: "Kaydedildi: acil değildi. Üç kez aynı yönde olunca Geliştirme'de öneri çıkar.",
};

/**
 * Short hints of the two ways to clear an inbox item (button tooltip and the
 * confirm question): "Gördüm" records nothing, so a lasting condition may come
 * back once after a Core restart; "Tekrar gösterme" keeps it hidden while it lasts.
 */
export const NOTIFICATION_DISMISS_HINT: Record<"delete" | "suppress", string> = {
  delete: "Tüm cihazlardan kalkar. Durum sürüyorsa Core yeniden başlayınca bir kez daha gelebilir.",
  suppress: "Tüm cihazlardan kalkar ve durum sürdükçe gösterilmez. Durum düzelip yeniden olursa tekrar gelir.",
};

const NOTIFICATION_SOURCE: Record<string, string> = {
  service: "Servis",
  backup: "Yedekleme",
  ha: "Ev",
  "device-state": "Cihaz durumu",
  test: "Deneme",
};

/** Producer name in Turkish; unknown sources as-is (docs/02 *Notifications*). */
export function notificationSourceText(source: string): string {
  return NOTIFICATION_SOURCE[source] ?? source;
}

/** Badge / heading label: "3 okunmamış bildirim". */
export function notificationsUnreadText(unread: number): string {
  return `${unread} okunmamış bildirim`;
}

/** Why the last inbox request failed (`timeout` / `connection` are local codes). */
export function notificationsErrorText(code: string, message?: string | null): string {
  switch (code) {
    case "timeout":
      return "Çekirdek bildirim isteğine yanıt vermedi.";
    case "connection":
      return "Bağlantı koptu; bildirimler alınamadı.";
    case "unknown_item":
      return "Bu bildirim artık yok. Listeyi yenile.";
    case "bad_request":
      return "Çekirdek isteği reddetti. Listeyi yenile.";
    case "notifications_unavailable":
      return "Bildirimler okunamadı.";
    default:
      return noticeText(code, message ?? undefined);
  }
}

// ------------------------------------------------------- PC permission page ("İzinler", docs/11 D3)

export const PC_PERMISSIONS_TITLE = "İzinler";

/** The verb shown after the target ("Steam · aç"). The Core sends only the target name, so no case suffix is ever built. */
const PC_ACTION_VERB: Record<string, string> = {
  open_app: "aç",
  close_app: "kapat",
  force_close_app: "zorla kapat",
  open_site: "aç",
  web_search: "ara",
  media_search: "ara",
  volume: "değiştir",
  media: "oynat / duraklat",
  lock: "kilitle",
  sleep: "uyut",
  shutdown: "kapat",
  restart: "yeniden başlat",
  play_game: "başlat",
};

/** Row label: "‹target› · ‹verb›"; an unknown action shows the target with the action as-is. */
export function pcPermissionLabel(label: string, action: string): string {
  return `${label} · ${PC_ACTION_VERB[action] ?? action}`;
}

/** "3 kez istendi" */
export function pcPermissionRequestsText(requests: number): string {
  return `${requests} kez istendi`;
}

/** The İzinler count in words, for screen readers: "2 yeni izin satırı". */
export function pcPermissionsUnseenText(unseen: number): string {
  return `${unseen} yeni izin satırı`;
}

export const PC_PERMISSIONS_GROUP = { fresh: "Yeni", on: "Açık", off: "Kapalı" } as const;

export const PC_PERMISSIONS_INTRO =
  "Shadow'un bilgisayarda yapabilecekleri. Her şey kapalı başlar; izinli olmayan bir komut istendiğinde satır kapalı olarak buraya eklenir. Anahtarları yalnız buradan sen değiştirirsin; ses ya da model değiştiremez.";

export const PC_PERMISSIONS_EMPTY = "Henüz izin satırı yok.";

export const PC_PERMISSIONS_CANNOT_MANAGE =
  "Bu cihaz izinleri değiştiremez. Çekirdekte CORE_PC_PERMISSION_DEVICES ayarına bu cihazın adı eklenmeli.";

export const PC_PERMISSIONS_UNAVAILABLE =
  "İzin listesi okunamadı; bilgisayar komutları kapalı. Dosya elle geri yüklenip Çekirdek yeniden başlatılmalı.";

/** Shown under a risky row that is on (shut down, restart, sleep, force-close). */
export const PC_PERMISSION_RISKY_NOTE = "Açık olsa da her seferinde onay sorulur.";

/** Why the last request of the page failed (`timeout` / `connection` are local codes). */
export function pcPermissionsErrorText(code: string, message?: string | null): string {
  switch (code) {
    case "timeout":
      return "Çekirdek izin isteğine yanıt vermedi.";
    case "connection":
      return "Bağlantı koptu; izin listesi alınamadı.";
    case "unknown_item":
      return "Bu satır artık listede yok. Listeyi yenile.";
    case "not_allowed":
      return "Bu cihaz izinleri değiştiremez.";
    case "pc_permissions_unavailable":
      return PC_PERMISSIONS_UNAVAILABLE;
    case "bad_request":
      return "Çekirdek isteği reddetti. Listeyi yenile.";
    default:
      return noticeText(code, message ?? undefined);
  }
}

/** Shown with the "Adresler" button (settings and the connect screen, Android shells only). */
export const ADDRESSES_HINT = "Ev adresleri ve bilgisayarı uyandırma bu cihazın Adresler penceresinde.";

// ------------------------------------------- confirm card "Evet, hep bu" (docs/14 Decision 7)

/** The three answers of a card that offers `remember`. */
export const CONFIRM_REMEMBER_LABEL = { no: "Hayır", once: "Evet", always: "Evet, hep bu" } as const;

/** What the user said and which device it means: "“bahçe pompasnı” → Bahçe Pompası". */
export function confirmRememberText(spoken: string, target: string): string {
  return `“${spoken}” → ${target}`;
}

export const CONFIRM_REMEMBER_HINT =
  "“Evet” yalnız bu seferlik. “Evet, hep bu”: bu söz bu cihaz için kaydedilir, bir dahaki sefere sorulmaz.";

export const CONFIRM_REMEMBER_VOICE_HINT = "Sesle de cevap verebilirsin: “evet”, “evet hep bu” ya da “hayır”.";

// ------------------------------------------------ device names panel ("Cihaz adları", docs/14 Decision 8)

export const NAMES_TITLE = "Cihaz adları";

export const NAMES_INTRO =
  "Onay kartında “Evet, hep bu” dediğin cihaz adları. Shadow bu sözleri sormadan aynı cihaza bağlar. Yanlış ya da gereksiz olanları silebilirsin.";

/** Fixed texts of the panel (buttons, states, the delete question). */
export const NAMES_UI = {
  refresh: "Yenile",
  offline: "Bağlantı yok.",
  loading: "Yükleniyor…",
  deleting: "Siliniyor…",
  remove: "Sil",
  ask: "Silinsin mi?",
  yes: "Evet, sil",
  cancel: "Vazgeç",
  askGroup: "Silme onayı",
} as const;

/** Screen-reader label of a row's Sil button. */
export function nameDeleteLabel(rowText: string): string {
  return `Sil: ${rowText}`;
}

export const NAMES_EMPTY = "Henüz kayıtlı cihaz adı yok. Onay kartında “Evet, hep bu” dediğinde buraya eklenir.";

/** "bahçe pompasnı → Bahçe Pompası (Bahçe)"; no parentheses without an area. */
export function nameRowText(item: Pick<DeviceNameItem, "spoken" | "target">): string {
  const areas = item.target.areas.filter((a) => a.trim());
  return `${item.spoken} → ${item.target.name}${areas.length > 0 ? ` (${areas.join(", ")})` : ""}`;
}

/**
 * The status label of a row: "Pasif" for a passive entry, "Bulunamadı" for an
 * active one missing from the live context, nothing for an active one that is
 * seen; an unknown status is shown as-is.
 */
export function nameStatusText(item: Pick<DeviceNameItem, "status" | "missingSince">): string | null {
  if (item.status === "passive") return "Pasif";
  if (item.status === "active") return item.missingSince ? "Bulunamadı" : null;
  return item.status || null;
}

/** Shown under a row with a status label: what the status means. */
export function nameStatusHint(item: Pick<DeviceNameItem, "status" | "missingSince">): string | undefined {
  if (item.status === "passive") return "30 gündür bulunamadı; artık kullanılmıyor. Silebilir ya da onay kartında yeniden “Evet, hep bu” diyebilirsin.";
  if (item.status === "active" && item.missingSince) return "Cihaz şu an evde görünmüyor; dönene kadar bu ad kullanılmıyor.";
  return undefined;
}

/** Why the last request of the panel failed (`timeout` / `connection` are local codes). */
export function namesErrorText(code: string, message?: string | null): string {
  switch (code) {
    case "timeout":
      return "Çekirdek cihaz adları isteğine yanıt vermedi.";
    case "connection":
      return "Bağlantı koptu; cihaz adları alınamadı.";
    case "bad_request":
      return "Çekirdek isteği reddetti: cihaz adları kapalı olabilir. Listeyi yenile.";
    case "internal":
      return "Cihaz adları okunamadı ya da kaydedilemedi. Biraz sonra yeniden dene.";
    default:
      return noticeText(code, message ?? undefined);
  }
}

// ------------------------------------------------ rehearsal band (T11.5, docs/02 "Features" `rehearsal`)

export const REHEARSAL_BAND = "Prova kipi: bildirimler ve sesli acil uyarı kapalı";

// ------------------------------------------------ version band (T12.3, docs/13 §6.1 M3 `version_base`)

/** `X.Y` of `X.Y` / `X.Y.Z`; anything else is shown as "?" (only the bases differ, patches are never compared). */
function shownBase(version: string | null): string {
  const m = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version?.trim() ?? "");
  return m ? `${Number(m[1])}.${Number(m[2])}` : "?";
}

export function versionBaseBandText(uiVersion: string, coreVersion: string | null): string {
  return `Sürüm uyuşmuyor: arayüz ${shownBase(uiVersion)}, çekirdek ${shownBase(coreVersion)} — güncelleyin`;
}
