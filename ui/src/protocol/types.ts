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
export type SpeakMessage = { type: "speak"; id: string; text: string };
export type CancelMessage = { type: "cancel"; id: string };
export type HistoryRequestMessage = { type: "history_request"; limit: number };
export type PingMessage = { type: "ping" };

export type ClientMessage =
  | HelloMessage
  | UserTextMessage
  | AudioMessage
  | ConfirmResponseMessage
  | SpeakMessage
  | CancelMessage
  | HistoryRequestMessage
  | PingMessage;

// ---------------------------------------------------------------------------
// Core -> Client

export type WelcomeMessage = {
  type: "welcome";
  protocol: number;
  sessionId: string;
  device: string;
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
export type ErrorMessage = { type: "error"; id?: string; code: string; message?: string };
export type PongMessage = { type: "pong" };

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
    case "welcome":
      return num(o, "protocol") && str(o, "sessionId") ? (o as WelcomeMessage) : null;
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
    case "error":
      return str(o, "code") && (o.id === undefined || str(o, "id")) ? (o as ErrorMessage) : null;
    case "pong":
      return { type: "pong" };
    default:
      return null;
  }
}
