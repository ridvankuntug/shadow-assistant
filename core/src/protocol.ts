/**
 * Core WebSocket protocol v1 — the single source of the frame types.
 *
 * Documented in docs/02-core-protocol.md. Every frame is a JSON text message
 * with a `type` field. Keep this module dependency-free so it can be copied or
 * imported by clients.
 */

export const PROTOCOL_VERSION = 1;

/** WebSocket close code used for missing/invalid authentication. */
export const CLOSE_UNAUTHORIZED = 4401;
/** WebSocket close code used when the client violates the protocol before auth. */
export const CLOSE_PROTOCOL_ERROR = 4400;

/** Max accepted size of a single client frame (base64 audio included). */
export const MAX_FRAME_BYTES = 36 * 1024 * 1024;
/** Max length of a user_text / speak text. */
export const MAX_TEXT_CHARS = 4000;
/** Max length of a client-generated id. */
export const MAX_ID_CHARS = 128;
/** Max length of a `speak.voice` id; longer values are ignored (default voice). */
export const MAX_VOICE_ID_CHARS = 128;

// ---------------------------------------------------------------- client → core

export interface HelloFrame {
  type: "hello";
  protocol: number;
  token: string;
  client?: string;
  clientVersion?: string;
}

export interface UserTextFrame {
  type: "user_text";
  id: string;
  text: string;
}

export interface AudioFrame {
  type: "audio";
  id: string;
  mime: string;
  /** base64 encoded audio bytes (one complete utterance). */
  data: string;
}

export interface ConfirmResponseFrame {
  type: "confirm_response";
  requestId: string;
  approved: boolean;
}

export interface SpeakFrame {
  type: "speak";
  id: string;
  text: string;
  /** tts-svc voice id from a `voices` reply; absent or unknown → default voice. */
  voice?: string;
}

/** Asks for the selectable tts-svc voices; answered by `voices` or `error tts_unavailable`. */
export interface VoicesRequestFrame {
  type: "voices";
  id: string;
}

export interface CancelFrame {
  type: "cancel";
  id: string;
}

export interface HistoryRequestFrame {
  type: "history_request";
  limit?: number;
}

export interface PingFrame {
  type: "ping";
}

/** How a client wants streamed speech (`speech_chunk`) for its turns. */
export type SpeechMode = "audio" | "text";

/**
 * Opt-in to sentence-by-sentence speech (feature `speech_stream`). Can be sent
 * again at any time; the latest one applies. Before the first one the Core
 * sends no `speech_chunk` frames.
 */
export interface SpeechPrefsFrame {
  type: "speech_prefs";
  /** false: no chunks (voice replies switched off). */
  enabled: boolean;
  /** `audio`: tts-svc clips (web); `text`: lexicon-applied sentence text (native TTS). */
  mode: SpeechMode;
  /** Same rules as `speak.voice`: absent or unknown → default voice. */
  voice?: string;
}

/** Asks for the memory contents (feature `memory`); answered by `memory` or `error`. */
export interface MemoryListFrame {
  type: "memory_list";
  id: string;
}

/** Deletes one memory entry (brief or note); answered by a fresh `memory` frame or `error`. */
export interface MemoryDeleteFrame {
  type: "memory_delete";
  id: string;
  entryId: string;
}

export type ClientFrame =
  | HelloFrame
  | UserTextFrame
  | AudioFrame
  | ConfirmResponseFrame
  | SpeakFrame
  | VoicesRequestFrame
  | CancelFrame
  | HistoryRequestFrame
  | PingFrame
  | SpeechPrefsFrame
  | MemoryListFrame
  | MemoryDeleteFrame;

// ---------------------------------------------------------------- core → client

export type ServerState = "idle" | "thinking" | "awaiting_confirm";
export type ToolStatus = "started" | "done" | "denied" | "error";
export type ConfirmResolvedBy = "button" | "voice" | "timeout";
export type ErrorCode =
  | "unauthorized"
  | "bad_request"
  | "stt_unavailable"
  | "tts_unavailable"
  | "model_error"
  | "busy"
  | "usage_limit"
  | "internal";

/**
 * Optional capabilities a Core lists in `welcome.features`. Clients must
 * ignore names they do not know; a missing name means the feature is off.
 */
export type ProtocolFeature = "speech_stream" | "memory" | "usage_limit";

export interface HistoryItem {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
}

/** Health of one services.yaml entry, as seen by the Core's health monitor. */
export type ServiceHealthStatus = "ok" | "loading" | "down" | "disabled";

export interface ServiceHealth {
  /** services.yaml name, e.g. `whisper-svc`, `home-assistant`. */
  name: string;
  status: ServiceHealthStatus;
  /** Epoch ms of the last check (for `disabled`: when the snapshot was taken). */
  checkedAt: number;
  /**
   * Short machine-readable reason, never a URL, host or token:
   * `timeout`, `unreachable`, `unauthorized`, `error`, `bad_response`,
   * `http_<status>`, `not_found`, `not_configured`, `off`, `idle` (status `ok`:
   * model unloaded, reloads on the next request).
   */
  detail?: string;
}

/** One entry of a `voices` reply. */
export interface VoiceInfo {
  /** tts-svc voice id, e.g. `tr_TR-dfki-medium`; send it back as `speak.voice`. */
  id: string;
  /** Human-readable (Turkish) name, e.g. `DFKI (orta kalite)`. */
  label: string;
  /** Piper quality (`x_low` | `low` | `medium` | `high`); absent for ids not in Piper's naming scheme. */
  quality?: string;
}

/**
 * One streamed piece of a turn's spoken answer. `seq` starts at 0 per turn and
 * has no gaps; the last frame has `final: true` and may carry no payload.
 * `audio` mode: `mime` + `data` (base64); `text` mode: `text`.
 */
export interface SpeechChunkFrame {
  type: "speech_chunk";
  id: string;
  seq: number;
  final: boolean;
  mime?: string;
  data?: string;
  text?: string;
}

export interface MemoryEntry {
  /** Stable entry id, e.g. `m-7f3a9c`; send it back as `memory_delete.entryId`. */
  id: string;
  text: string;
  /** Epoch ms of the last change (topic notes). */
  updatedAt?: number;
}

export interface MemoryTopic {
  topic: string;
  title: string;
  chars: number;
  entries: MemoryEntry[];
}

/** `code`: `note_over_budget` | `note_full` | `memory_full` (clients show unknown codes as-is). */
export interface MemoryWarning {
  code: string;
  topic?: string;
}

export interface MemoryFrame {
  type: "memory";
  /** The `memory_list` / `memory_delete` request id. */
  id: string;
  brief: { chars: number; budget: number; entries: MemoryEntry[] };
  topics: MemoryTopic[];
  warnings: MemoryWarning[];
}

export type ServerFrame =
  | {
      type: "welcome";
      protocol: number;
      sessionId: string;
      device: string;
      /** Optional capabilities; absent on older Cores (= none). */
      features?: ProtocolFeature[];
    }
  | { type: "state"; state: ServerState }
  | { type: "transcript"; id: string; text: string }
  | { type: "assistant_delta"; id: string; text: string }
  | { type: "assistant_done"; id: string; text: string }
  | { type: "tool"; id: string; name: string; status: ToolStatus }
  | {
      type: "confirm_request";
      requestId: string;
      id: string;
      tool: string;
      summary: string;
      expiresAt: number;
    }
  | { type: "confirm_resolved"; requestId: string; approved: boolean; by: ConfirmResolvedBy }
  | { type: "speech"; id: string; mime: string; data: string }
  | { type: "history"; items: HistoryItem[] }
  | SpeechChunkFrame
  | MemoryFrame
  /** `retryAt` (epoch ms): only on `usage_limit`, when the reset time is known. */
  | { type: "error"; id?: string; code: ErrorCode; message: string; retryAt?: number }
  | { type: "services"; items: ServiceHealth[] }
  | { type: "voices"; id: string; default: string; voices: VoiceInfo[] }
  | { type: "pong" };

// ---------------------------------------------------------------- validation

export type ParseResult =
  | { ok: true; frame: ClientFrame }
  | { ok: false; message: string; id?: string };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isId(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_ID_CHARS;
}

function isText(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0 && v.length <= MAX_TEXT_CHARS;
}

function optStr(v: unknown, max = 64): boolean {
  return v === undefined || (typeof v === "string" && v.length <= max);
}

/**
 * Parses and validates one raw client frame. Unknown fields are ignored;
 * unknown `type`s and malformed frames are rejected with a message suitable
 * for a `bad_request` error (never echoes the token).
 */
export function parseClientFrame(raw: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, message: "frame is not valid JSON" };
  }
  if (!isObj(data) || typeof data.type !== "string") {
    return { ok: false, message: "frame must be an object with a string `type`" };
  }
  const id = isId(data.id) ? data.id : undefined;
  const bad = (message: string): ParseResult => ({ ok: false, message, id });

  switch (data.type) {
    case "hello":
      if (typeof data.protocol !== "number") return bad("hello.protocol must be a number");
      if (typeof data.token !== "string") return bad("hello.token must be a string");
      if (!optStr(data.client) || !optStr(data.clientVersion)) return bad("hello.client/clientVersion invalid");
      return {
        ok: true,
        frame: {
          type: "hello",
          protocol: data.protocol,
          token: data.token,
          client: data.client as string | undefined,
          clientVersion: data.clientVersion as string | undefined,
        },
      };
    case "user_text":
      if (!isId(data.id)) return bad("user_text.id must be a non-empty string");
      if (!isText(data.text)) return bad(`user_text.text must be 1..${MAX_TEXT_CHARS} chars`);
      return { ok: true, frame: { type: "user_text", id: data.id, text: data.text } };
    case "audio":
      if (!isId(data.id)) return bad("audio.id must be a non-empty string");
      if (typeof data.mime !== "string" || !/^audio\/[\w.+-]+(;.*)?$/i.test(data.mime)) {
        return bad("audio.mime must be an audio/* mime type");
      }
      if (typeof data.data !== "string" || data.data.length === 0) return bad("audio.data must be base64");
      return { ok: true, frame: { type: "audio", id: data.id, mime: data.mime, data: data.data } };
    case "confirm_response":
      if (!isId(data.requestId)) return bad("confirm_response.requestId must be a string");
      if (typeof data.approved !== "boolean") return bad("confirm_response.approved must be a boolean");
      return {
        ok: true,
        frame: { type: "confirm_response", requestId: data.requestId, approved: data.approved },
      };
    case "speak": {
      if (!isId(data.id)) return bad("speak.id must be a non-empty string");
      if (!isText(data.text)) return bad(`speak.text must be 1..${MAX_TEXT_CHARS} chars`);
      const voice = data.voice;
      if (voice !== undefined && voice !== null && typeof voice !== "string") return bad("speak.voice must be a string");
      // Empty or over-long ids cannot name a voice: treated as absent (default voice), not as an error.
      const usable = typeof voice === "string" && voice.length > 0 && voice.length <= MAX_VOICE_ID_CHARS;
      return {
        ok: true,
        frame: usable ? { type: "speak", id: data.id, text: data.text, voice } : { type: "speak", id: data.id, text: data.text },
      };
    }
    case "voices":
      if (!isId(data.id)) return bad("voices.id must be a non-empty string");
      return { ok: true, frame: { type: "voices", id: data.id } };
    case "cancel":
      if (!isId(data.id)) return bad("cancel.id must be a non-empty string");
      return { ok: true, frame: { type: "cancel", id: data.id } };
    case "history_request": {
      const limit = data.limit;
      if (limit !== undefined && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1)) {
        return bad("history_request.limit must be a positive integer");
      }
      return { ok: true, frame: { type: "history_request", limit: limit as number | undefined } };
    }
    case "ping":
      return { ok: true, frame: { type: "ping" } };
    case "speech_prefs": {
      if (typeof data.enabled !== "boolean") return bad("speech_prefs.enabled must be a boolean");
      if (data.mode !== "audio" && data.mode !== "text") return bad('speech_prefs.mode must be "audio" or "text"');
      const voice = data.voice;
      if (voice !== undefined && voice !== null && typeof voice !== "string") return bad("speech_prefs.voice must be a string");
      // Same rule as speak.voice: unusable ids mean the default voice.
      const usable = typeof voice === "string" && voice.length > 0 && voice.length <= MAX_VOICE_ID_CHARS;
      const frame: SpeechPrefsFrame = { type: "speech_prefs", enabled: data.enabled, mode: data.mode };
      if (usable) frame.voice = voice;
      return { ok: true, frame };
    }
    case "memory_list":
      if (!isId(data.id)) return bad("memory_list.id must be a non-empty string");
      return { ok: true, frame: { type: "memory_list", id: data.id } };
    case "memory_delete":
      if (!isId(data.id)) return bad("memory_delete.id must be a non-empty string");
      if (!isId(data.entryId)) return bad("memory_delete.entryId must be a non-empty string");
      return { ok: true, frame: { type: "memory_delete", id: data.id, entryId: data.entryId } };
    default:
      return bad(`unknown frame type`);
  }
}
