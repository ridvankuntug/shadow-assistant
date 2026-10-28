/**
 * Core WebSocket protocol v1 — message shapes (see docs/02-core-protocol.md).
 *
 * Every frame is a JSON text frame with a `type` field. `id` is a
 * client-generated turn id.
 */

export const PROTOCOL_VERSION = 1;

export type ClientKind = "web" | "android";

export type ServerState = "idle" | "thinking" | "awaiting_confirm";

// ---------------------------------------------------------------------------
// Client -> Core

export type HelloMessage = {
  type: "hello";
  protocol: number;
  token: string;
  client: ClientKind;
  clientVersion: string;
};
export type UserTextMessage = { type: "user_text"; id: string; text: string };
export type AudioMessage = { type: "audio"; id: string; mime: string; data: string };
export type ConfirmResponseMessage = {
  type: "confirm_response";
  requestId: string;
  approved: boolean;
};
/** `voice`: a tts-svc voice id from `voices`; absent or unknown -> the Core's default voice. */
export type SpeakMessage = { type: "speak"; id: string; text: string; voice?: string };
/** Asks for the tts-svc voice list (answered by `voices` or `error tts_unavailable`). */
export type VoicesRequestMessage = { type: "voices"; id: string };
export type CancelMessage = { type: "cancel"; id: string };
export type HistoryRequestMessage = { type: "history_request"; limit: number };
export type PingMessage = { type: "ping" };
/** How streamed speech is delivered: tts-svc clips (`audio`) or sentence text for native TTS (`text`). */
export type SpeechMode = "audio" | "text";
/**
 * Opt-in to `speech_chunk` frames (only to a Core with the `speech_stream`
 * feature). `voice` as in `speak`; only meaningful in `audio` mode.
 */
export type SpeechPrefsMessage = { type: "speech_prefs"; enabled: boolean; mode: SpeechMode; voice?: string };
/** Asks for the memory contents (Core feature `memory`). */
export type MemoryListMessage = { type: "memory_list"; id: string };
/** Deletes one memory entry; answered by a fresh `memory` frame. */
export type MemoryDeleteMessage = { type: "memory_delete"; id: string; entryId: string };

export type ClientMessage =
  | HelloMessage
  | UserTextMessage
  | AudioMessage
  | ConfirmResponseMessage
  | SpeakMessage
  | VoicesRequestMessage
  | CancelMessage
  | HistoryRequestMessage
  | PingMessage
  | SpeechPrefsMessage
  | MemoryListMessage
  | MemoryDeleteMessage;

// ---------------------------------------------------------------------------
// Core -> Client

/** Optional Core capabilities this client uses (`welcome.features`). */
export type CoreFeature = "speech_stream" | "memory" | "usage_limit";
export type WelcomeMessage = {
  type: "welcome";
  protocol: number;
  sessionId: string;
  device: string;
  /** Absent on older Cores (= no optional features). Only string entries are kept; unknown names are unused. */
  features?: string[];
};
export type StateMessage = { type: "state"; state: ServerState };
export type TranscriptMessage = { type: "transcript"; id: string; text: string };
export type AssistantDeltaMessage = { type: "assistant_delta"; id: string; text: string };
export type AssistantDoneMessage = { type: "assistant_done"; id: string; text: string };
export type ToolStatus = "started" | "done" | "denied" | "error";
export type ToolMessage = { type: "tool"; id: string; name: string; status: ToolStatus };
export type ConfirmRequestMessage = {
  type: "confirm_request";
  requestId: string;
  id: string;
  tool: string;
  summary: string;
  expiresAt: number;
};
export type ConfirmResolvedBy = "button" | "voice" | "timeout";
export type ConfirmResolvedMessage = {
  type: "confirm_resolved";
  requestId: string;
  approved: boolean;
  by: ConfirmResolvedBy;
};
export type SpeechMessage = { type: "speech"; id: string; mime: string; data: string };
export type HistoryItem = {
  id: string;
  role: "user" | "assistant";
  text: string;
  ts: number;
};
export type HistoryMessage = { type: "history"; items: HistoryItem[] };
/** `retryAt` (epoch ms): when a `usage_limit` resets, if the Core knows it. */
export type ErrorMessage = { type: "error"; id?: string; code: string; message?: string; retryAt?: number };
export type PongMessage = { type: "pong" };
/** Health of one Core service (docs/02-core-protocol.md, "Service health"). */
export type ServiceHealthStatus = "ok" | "loading" | "down" | "disabled";
export type ServiceHealth = {
  name: string;
  status: ServiceHealthStatus;
  checkedAt: number;
  /** Short code (`timeout`, `unreachable`, …); unknown codes are shown as-is. */
  detail?: string;
};
export type ServicesMessage = { type: "services"; items: ServiceHealth[] };
/** One tts-svc voice. `quality` is free text (e.g. `medium`) and optional. */
export type Voice = { id: string; label: string; quality?: string };
export type VoicesMessage = { type: "voices"; id: string; default: string; voices: Voice[] };
/**
 * One sentence of a turn's spoken answer (feature `speech_stream`). `seq`
 * starts at 0 per turn; `final` marks the last frame, which may carry no
 * payload. Audio mode: `mime` + `data`; text mode: `text`.
 */
export type SpeechChunkMessage = {
  type: "speech_chunk";
  id: string;
  seq: number;
  final: boolean;
  mime?: string;
  data?: string;
  text?: string;
};
export type MemoryEntry = { id: string; text: string; updatedAt?: number };
export type MemoryTopic = { topic: string; title: string; chars: number; entries: MemoryEntry[] };
/** `code`: `note_over_budget` | `note_full` | `memory_full`; unknown codes are shown as-is. */
export type MemoryWarning = { code: string; topic?: string };
export type MemoryMessage = {
  type: "memory";
  id: string;
  brief: { chars: number; budget: number; entries: MemoryEntry[] };
  topics: MemoryTopic[];
  warnings: MemoryWarning[];
};

export type ServerMessage =
  | WelcomeMessage
  | StateMessage
  | TranscriptMessage
  | AssistantDeltaMessage
  | AssistantDoneMessage
  | ToolMessage
  | ConfirmRequestMessage
  | ConfirmResolvedMessage
  | SpeechMessage
  | HistoryMessage
  | ErrorMessage
  | ServicesMessage
  | VoicesMessage
  | SpeechChunkMessage
  | MemoryMessage
  | PongMessage;

// ---------------------------------------------------------------------------
// Validation. The Core is trusted but it is a separate program written in
// parallel, so every inbound frame is checked before it reaches the reducer:
// a malformed frame is dropped instead of crashing the UI.

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (o: Obj, k: string) => typeof o[k] === "string";
const num = (o: Obj, k: string) => typeof o[k] === "number" && Number.isFinite(o[k]);
const bool = (o: Obj, k: string) => typeof o[k] === "boolean";
const oneOf = (o: Obj, k: string, values: readonly string[]) =>
  typeof o[k] === "string" && values.includes(o[k] as string);

const SERVER_STATES = ["idle", "thinking", "awaiting_confirm"] as const;
const TOOL_STATUSES = ["started", "done", "denied", "error"] as const;
const RESOLVED_BY = ["button", "voice", "timeout"] as const;
const SERVICE_STATUSES = ["ok", "loading", "down", "disabled"] as const;

function isHistoryItem(v: unknown): v is HistoryItem {
  return (
    isObj(v) &&
    str(v, "id") &&
    oneOf(v, "role", ["user", "assistant"]) &&
    str(v, "text") &&
    num(v, "ts")
  );
}

/**
 * One `services` item, or null when malformed. A status this client does not
 * know is treated as `down` (the protocol says: not ok); an over-long detail
 * is cut so it cannot flood the UI.
 */
function toServiceHealth(v: unknown): ServiceHealth | null {
  if (!isObj(v) || !str(v, "name") || !str(v, "status") || !num(v, "checkedAt")) return null;
  if (v.detail !== undefined && !str(v, "detail")) return null;
  const status = oneOf(v, "status", SERVICE_STATUSES) ? (v.status as ServiceHealthStatus) : "down";
  const item: ServiceHealth = { name: (v.name as string).slice(0, 64), status, checkedAt: v.checkedAt as number };
  if (typeof v.detail === "string" && v.detail) item.detail = v.detail.slice(0, 64);
  return item;
}

/**
 * One `voices` item, or null when malformed. A missing/empty label falls back
 * to the id; strings are cut so a bad list cannot flood the picker.
 */
function toVoice(v: unknown): Voice | null {
  if (!isObj(v) || !str(v, "id") || !(v.id as string)) return null;
  const id = (v.id as string).slice(0, 128);
  const label = typeof v.label === "string" && v.label.trim() ? v.label.trim().slice(0, 80) : id;
  const voice: Voice = { id, label };
  if (typeof v.quality === "string" && v.quality) voice.quality = v.quality.slice(0, 32);
  return voice;
}

/** Valid voices, first occurrence of each id kept, at most 200. */
function uniqueVoices(items: unknown[]): Voice[] {
  const seen = new Set<string>();
  const out: Voice[] = [];
  for (const raw of items) {
    const v = toVoice(raw);
    if (!v || seen.has(v.id)) continue;
    seen.add(v.id);
    out.push(v);
    if (out.length >= 200) break;
  }
  return out;
}

const isSeq = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * A `speech_chunk` with only its known fields, or null when malformed. A
 * payload of the wrong type rejects the frame; empty strings count as absent.
 * Audio data needs a mime type.
 */
function toSpeechChunk(o: Obj): SpeechChunkMessage | null {
  if (!str(o, "id") || !isSeq(o.seq) || !bool(o, "final")) return null;
  for (const k of ["mime", "data", "text"]) if (o[k] !== undefined && !str(o, k)) return null;
  const chunk: SpeechChunkMessage = { type: "speech_chunk", id: o.id as string, seq: o.seq, final: o.final as boolean };
  if (o.data) {
    if (!o.mime) return null;
    chunk.mime = o.mime as string;
    chunk.data = o.data as string;
  }
  if (o.text) chunk.text = o.text as string;
  return chunk;
}

function toMemoryEntry(v: unknown): MemoryEntry | null {
  if (!isObj(v) || !str(v, "id") || !v.id || !str(v, "text")) return null;
  const entry: MemoryEntry = { id: v.id as string, text: v.text as string };
  if (num(v, "updatedAt")) entry.updatedAt = v.updatedAt as number;
  return entry;
}

const memoryEntries = (v: unknown): MemoryEntry[] | null =>
  Array.isArray(v) ? v.map(toMemoryEntry).filter((e): e is MemoryEntry => e !== null) : null;

function toMemoryTopic(v: unknown): MemoryTopic | null {
  if (!isObj(v) || !str(v, "topic") || !num(v, "chars")) return null;
  const entries = memoryEntries(v.entries);
  if (!entries) return null;
  const topic = v.topic as string;
  const title = typeof v.title === "string" && v.title.trim() ? v.title : topic;
  return { topic, title, chars: v.chars as number, entries };
}

function toMemoryWarning(v: unknown): MemoryWarning | null {
  if (!isObj(v) || !str(v, "code")) return null;
  const w: MemoryWarning = { code: v.code as string };
  if (str(v, "topic")) w.topic = v.topic as string;
  return w;
}

/**
 * A `memory` frame with only its known fields, or null when the id or the
 * brief is malformed. Malformed entries, topics and warnings are dropped; a
 * missing `topics`/`warnings` array counts as empty.
 */
function toMemory(o: Obj): MemoryMessage | null {
  const brief = o.brief;
  if (!str(o, "id") || !isObj(brief) || !num(brief, "chars") || !num(brief, "budget")) return null;
  const briefEntries = memoryEntries(brief.entries);
  if (!briefEntries) return null;
  const topics = Array.isArray(o.topics) ? o.topics.map(toMemoryTopic).filter((t): t is MemoryTopic => t !== null) : [];
  const warnings = Array.isArray(o.warnings)
    ? o.warnings.map(toMemoryWarning).filter((w): w is MemoryWarning => w !== null)
    : [];
  return {
    type: "memory",
    id: o.id as string,
    brief: { chars: brief.chars as number, budget: brief.budget as number, entries: briefEntries },
    topics,
    warnings,
  };
}

/**
 * Parses one raw text frame. Returns null for anything that is not a valid,
 * known v1 server message (unknown types are ignored for forward
 * compatibility).
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(o) || typeof o.type !== "string") return null;
  switch (o.type) {
    case "welcome": {
      if (!num(o, "protocol") || !str(o, "sessionId")) return null;
      // A malformed `features` must not cost the connection: it means "none".
      const { features, ...rest } = o;
      const welcome = rest as WelcomeMessage;
      if (Array.isArray(features)) welcome.features = features.filter((f): f is string => typeof f === "string");
      return welcome;
    }
    case "state":
      return oneOf(o, "state", SERVER_STATES) ? (o as StateMessage) : null;
    case "transcript":
    case "assistant_delta":
    case "assistant_done":
      return str(o, "id") && str(o, "text") ? (o as ServerMessage) : null;
    case "tool":
      return str(o, "id") && str(o, "name") && oneOf(o, "status", TOOL_STATUSES)
        ? (o as ToolMessage)
        : null;
    case "confirm_request":
      return str(o, "requestId") && str(o, "id") && str(o, "tool") && str(o, "summary") && num(o, "expiresAt")
        ? (o as ConfirmRequestMessage)
        : null;
    case "confirm_resolved":
      return str(o, "requestId") && bool(o, "approved") && oneOf(o, "by", RESOLVED_BY)
        ? (o as ConfirmResolvedMessage)
        : null;
    case "speech":
      return str(o, "id") && str(o, "mime") && str(o, "data") ? (o as SpeechMessage) : null;
    case "history":
      return Array.isArray(o.items)
        ? { type: "history", items: o.items.filter(isHistoryItem) }
        : null;
    case "services":
      return Array.isArray(o.items)
        ? { type: "services", items: o.items.map(toServiceHealth).filter((i): i is ServiceHealth => i !== null) }
        : null;
    case "voices":
      return str(o, "id") && str(o, "default") && Array.isArray(o.voices)
        ? {
            type: "voices",
            id: o.id as string,
            default: o.default as string,
            voices: uniqueVoices(o.voices),
          }
        : null;
    case "error": {
      if (!str(o, "code") || (o.id !== undefined && !str(o, "id"))) return null;
      // A malformed `retryAt` is dropped; the error itself still counts.
      const { retryAt, ...rest } = o;
      const error = rest as ErrorMessage;
      if (typeof retryAt === "number" && Number.isFinite(retryAt)) error.retryAt = retryAt;
      return error;
    }
    case "speech_chunk":
      return toSpeechChunk(o);
    case "memory":
      return toMemory(o);
    case "pong":
      return { type: "pong" };
    default:
      return null;
  }
}
