import { describe, expect, it } from "vitest";
import { initialState, type VoiceCatalog } from "../assistant/state.ts";
import { DEFAULT_VOICE_VALUE, catalogNote, defaultOptionLabel, pickerValue, previewNote, voiceOptionLabel } from "./voicePicker.ts";

const ready: VoiceCatalog = {
  status: "ready",
  requestId: "v1",
  defaultVoice: "tr_TR-dfki-medium",
  voices: [
    { id: "tr_TR-dfki-medium", label: "DFKI", quality: "medium" },
    { id: "tr_TR-b", label: "B" },
  ],
};
const unavailable: VoiceCatalog = { ...initialState.voices, status: "unavailable", requestId: "v1" };

describe("pickerValue", () => {
  it("shows the default when nothing is chosen", () => {
    expect(pickerValue(ready, null)).toBe(DEFAULT_VOICE_VALUE);
  });
  it("shows a listed choice", () => {
    expect(pickerValue(ready, "tr_TR-b")).toBe("tr_TR-b");
  });
  it("shows a choice the Core no longer lists as the default", () => {
    expect(pickerValue(ready, "gone")).toBe(DEFAULT_VOICE_VALUE);
  });
  it("keeps the stored choice while the list is not known", () => {
    expect(pickerValue(unavailable, "tr_TR-b")).toBe("tr_TR-b");
  });
});

describe("labels", () => {
  it("adds the quality in Turkish, unknown quality as-is", () => {
    expect(voiceOptionLabel({ id: "a", label: "A", quality: "medium" })).toBe("A (orta kalite)");
    expect(voiceOptionLabel({ id: "a", label: "A", quality: "studio" })).toBe("A (studio)");
    expect(voiceOptionLabel({ id: "a", label: "A" })).toBe("A");
  });
  it("names the Core default in the default option", () => {
    expect(defaultOptionLabel(ready)).toBe("Varsayılan (DFKI)");
    expect(defaultOptionLabel({ ...ready, defaultVoice: "unlisted" })).toBe("Varsayılan (unlisted)");
    expect(defaultOptionLabel(initialState.voices)).toBe("Varsayılan");
  });
});

describe("catalogNote", () => {
  it("explains loading, offline and unavailable lists", () => {
    expect(catalogNote(ready, null, false)).toMatch(/bağlı/);
    expect(catalogNote({ ...ready, status: "loading" }, null, true)).toMatch(/yükleniyor/);
    expect(catalogNote(unavailable, null, true)).toMatch(/varsayılan ses kullanılıyor/);
    expect(catalogNote(unavailable, "tr_TR-b", true)).toMatch(/seçimin korunuyor/);
  });
  it("is silent for a ready, non-empty list", () => {
    expect(catalogNote(ready, null, true)).toBeNull();
    expect(catalogNote({ ...ready, voices: [] }, null, true)).toMatch(/varsayılan/);
  });
});

describe("previewNote", () => {
  it("follows the sample from request to playback to failure", () => {
    expect(previewNote(null, null, null)).toBeNull();
    expect(previewNote({ id: "p", failed: false }, "p", null)).toMatch(/hazırlanıyor/);
    expect(previewNote({ id: "p", failed: false }, null, "p")).toMatch(/çalıyor/);
    expect(previewNote({ id: "p", failed: false }, null, null)).toBeNull();
    expect(previewNote({ id: "p", failed: true }, null, null)).toMatch(/seslendirilemedi/);
  });
});
