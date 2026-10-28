import type { VoiceCatalog, VoicePreview } from "../assistant/state.ts";
import { DEFAULT_VOICE_VALUE, catalogNote, defaultOptionLabel, pickerValue, previewNote, voiceOptionLabel } from "./voicePicker.ts";

type Props = {
  catalog: VoiceCatalog;
  /** Voice stored on this device; null = the Core's default. */
  chosen: string | null;
  connected: boolean;
  /** A sample may be played now (no turn in flight). */
  canPreview: boolean;
  preview: VoicePreview | null;
  awaitingSpeech: string | null;
  playing: string | null;
  onChange: (voice: string | null) => void;
  onPreview: (voice: string | null) => void;
  onRetry: () => void;
};

/**
 * "Ses" setting (core TTS mode only): which tts-svc voice speaks the replies
 * on this device, with a "Dene" sample.
 */
export function VoicePicker({ catalog, chosen, connected, canPreview, preview, awaitingSpeech, playing, onChange, onPreview, onRetry }: Props) {
  const ready = connected && catalog.status === "ready";
  const value = pickerValue(catalog, chosen);
  const note = catalogNote(catalog, chosen, connected);
  const sample = previewNote(preview, awaitingSpeech, playing);
  const sampleBusy = preview !== null && !preview.failed && (awaitingSpeech === preview.id || playing === preview.id);

  return (
    <div className="field">
      <label htmlFor="voice-select" className="field-label">
        Ses
      </label>
      <div className="voice-row">
        <select
          id="voice-select"
          className="select"
          value={value}
          disabled={!ready}
          onChange={(e) => onChange(e.target.value === DEFAULT_VOICE_VALUE ? null : e.target.value)}
        >
          <option value={DEFAULT_VOICE_VALUE}>{defaultOptionLabel(catalog)}</option>
          {ready &&
            catalog.voices.map((v) => (
              <option key={v.id} value={v.id}>
                {voiceOptionLabel(v)}
              </option>
            ))}
        </select>
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!ready || !canPreview || sampleBusy}
          onClick={() => onPreview(value === DEFAULT_VOICE_VALUE ? null : value)}
        >
          Dene
        </button>
      </div>
      {note && (
        <p className="hint">
          {note}
          {connected && catalog.status === "unavailable" && (
            <>
              {" "}
              <button type="button" className="link-btn" onClick={onRetry}>
                Yeniden dene
              </button>
            </>
          )}
        </p>
      )}
      {sample && (
        <p className="hint" role="status">
          {sample}
        </p>
      )}
    </div>
  );
}
