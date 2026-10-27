/** Base64 helpers for audio payloads (no data: URL prefix). */

const CHUNK = 0x8000;

export function bytesToBase64(bytes: Uint8Array): string {
  // Chunked so String.fromCharCode never receives more arguments than the
  // engine's call-stack limit allows (a few seconds of audio is >100 kB).
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBytes(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** "audio/webm;codecs=opus" -> "audio/webm". */
export function baseMime(mime: string): string {
  return mime.split(";")[0].trim().toLowerCase();
}
