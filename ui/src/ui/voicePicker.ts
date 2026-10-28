/**
 * Voice picker logic (pure, tested): what the "Ses" select shows for the
 * Core's voice list and the voice stored on this device.
 */
import type { VoiceCatalog, VoicePreview } from "../assistant/state.ts";
import type { Voice } from "../protocol/types.ts";

/** Select value for "no choice": `speak` goes without `voice` (Core default). */
export const DEFAULT_VOICE_VALUE = "";

/**
 * The selected option. A stored voice the Core no longer lists shows as the
 * default — which is also what the Core uses for an unknown voice.
 */
export function pickerValue(catalog: VoiceCatalog, chosen: string | null): string {
  if (!chosen) return DEFAULT_VOICE_VALUE;
  if (catalog.status === "ready" && !catalog.voices.some((v) => v.id === chosen)) return DEFAULT_VOICE_VALUE;
  return chosen;
}

const QUALITY_TEXT: Record<string, string> = {
  x_low: "çok düşük kalite",
  low: "düşük kalite",
  medium: "orta kalite",
  high: "yüksek kalite",
};

/** Option text: the label, plus the quality when the Core sent one. */
export function voiceOptionLabel(v: Voice): string {
  if (!v.quality) return v.label;
  return `${v.label} (${QUALITY_TEXT[v.quality] ?? v.quality})`;
}

/** Text of the "no choice" option, naming the Core's default when known. */
export function defaultOptionLabel(catalog: VoiceCatalog): string {
  const id = catalog.defaultVoice;
  if (!id) return "Varsayılan";
  const v = catalog.voices.find((x) => x.id === id);
  return `Varsayılan (${v ? v.label : id})`;
}

/** Short line under the select for the list state (null = nothing to say). */
export function catalogNote(catalog: VoiceCatalog, chosen: string | null, connected: boolean): string | null {
  if (!connected) return "Ses listesi için çekirdeğe bağlı olmalısın.";
  switch (catalog.status) {
    case "idle":
    case "loading":
      return "Sesler yükleniyor…";
    case "unavailable":
      return chosen
        ? "Ses listesi şu an alınamıyor; kayıtlı seçimin korunuyor."
        : "Ses listesi şu an alınamıyor; varsayılan ses kullanılıyor.";
    case "ready":
      return catalog.voices.length === 0 ? "Çekirdek hiç ses bildirmedi; varsayılan ses kullanılıyor." : null;
  }
}

/** State of the "Dene" sample for the line next to the button. */
export function previewNote(preview: VoicePreview | null, awaitingSpeech: string | null, playing: string | null): string | null {
  if (!preview) return null;
  if (preview.failed) return "Örnek seslendirilemedi.";
  if (awaitingSpeech === preview.id) return "Örnek hazırlanıyor…";
  if (playing === preview.id) return "Örnek çalıyor…";
  return null;
}
