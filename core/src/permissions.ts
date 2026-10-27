/**
 * Permission gate: maps every tool call the model attempts to a level from
 * services.yaml and decides allow / log / ask-the-user / deny.
 *
 *   read     → allowed
 *   write    → allowed and recorded (conversation log + process log)
 *   confirm  → paused until the user approves (button or voice); timeout = deny
 *   built-in → always denied (the model only gets MCP tools)
 *   unknown  → confirm (safe default)
 *
 * Tool-name globs match case-insensitively so `*Lock*` also catches `lock__…`.
 */
import { randomUUID } from "node:crypto";
import { isGlob, matchGlob } from "./glob.js";
import type { PermissionLevel, ServiceDef } from "./services.js";
import type { ConfirmResolvedBy } from "./protocol.js";

export const DEFAULT_CONFIRM_TIMEOUT_MS = 60_000;

export interface ToolIdentity {
  /** Name as the SDK reports it, e.g. `mcp__home-assistant__intent__HassTurnOff`. */
  full: string;
  /** Configured service the tool belongs to, if any. */
  service?: string;
  /** Tool name inside the service, e.g. `intent__HassTurnOff`. */
  tool: string;
  /** True for anything that is not an `mcp__` tool (Bash, Read, WebFetch, …). */
  builtin: boolean;
}

export interface LevelDecision {
  identity: ToolIdentity;
  /** `deny` is only produced for built-in tools. */
  level: PermissionLevel | "deny";
  /** Short machine-readable reason, recorded in logs. */
  reason: string;
}

/**
 * Splits an SDK tool name into service + tool. The SDK names MCP tools
 * `mcp__<server>__<tool>`; HA's own tool names contain `__` as well
 * (`homeassistant__GetLiveContext`), so we match the configured service name
 * as a prefix instead of splitting on every `__`.
 */
export function identifyTool(full: string, serviceNames: readonly string[]): ToolIdentity {
  if (!full.startsWith("mcp__")) return { full, tool: full, builtin: true };
  const rest = full.slice("mcp__".length);
  // Longest match first so `foo-bar` wins over `foo`.
  const sorted = [...serviceNames].sort((a, b) => b.length - a.length);
  for (const name of sorted) {
    if (rest.startsWith(`${name}__`)) {
      return { full, service: name, tool: rest.slice(name.length + 2), builtin: false };
    }
  }
  const sep = rest.indexOf("__");
  return { full, tool: sep >= 0 ? rest.slice(sep + 2) : rest, builtin: false };
}

export interface PolicyOptions {
  /**
   * Smoke-test safety switch: everything that is not `read` is denied
   * without asking. Set via CORE_READ_ONLY=1.
   */
  readOnly?: boolean;
}

export class PermissionPolicy {
  private readonly byName: Map<string, ServiceDef>;

  constructor(
    services: readonly ServiceDef[],
    readonly options: PolicyOptions = {},
  ) {
    this.byName = new Map(services.filter((s) => s.enabled).map((s) => [s.name, s]));
  }

  get serviceNames(): string[] {
    return [...this.byName.keys()];
  }

  levelFor(fullName: string, input: Record<string, unknown> = {}): LevelDecision {
    const identity = identifyTool(fullName, this.serviceNames);
    if (identity.builtin) return { identity, level: "deny", reason: "builtin_tool" };
    const svc = identity.service ? this.byName.get(identity.service) : undefined;
    if (!svc) return { identity, level: "confirm", reason: "unknown_service" };

    // 1) exact rule, 2) first matching glob in file order, 3) service default.
    let level: PermissionLevel = svc.permission;
    let reason = "service_default";
    const exact = svc.tools.find((r) => !isGlob(r.pattern) && r.pattern === identity.tool);
    const glob = exact ? undefined : svc.tools.find((r) => isGlob(r.pattern) && matchGlob(r.pattern, identity.tool, true));
    const rule = exact ?? glob;
    if (rule) {
      level = rule.level;
      reason = `rule:${rule.pattern}`;
    }

    // 4) risky argument values escalate to confirm (never lower).
    if (level !== "confirm") {
      const hit = matchConfirmInputs(svc.confirmInputs, input);
      if (hit) return { identity, level: "confirm", reason: `input:${hit}` };
    }
    return { identity, level, reason };
  }
}

function matchConfirmInputs(rules: Record<string, string[]>, input: Record<string, unknown>): string | undefined {
  for (const [arg, values] of Object.entries(rules)) {
    const v = input[arg];
    const candidates = Array.isArray(v) ? v : [v];
    for (const c of candidates) {
      if (typeof c === "string" && values.includes(c.trim().toLowerCase())) return `${arg}=${c}`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------- voice answers

const YES_WORDS = new Set(["evet", "onayla", "onayliyorum", "tamam", "olur"]);
const NO_WORDS = new Set(["hayir", "iptal", "vazgec", "vazgectim"]);
const FILLER_WORDS = new Set(["lutfen", "et"]);
const MAX_ANSWER_WORDS = 3;

/** Lower-cases (Turkish rules), strips diacritics and punctuation. */
export function normalizeTurkish(text: string): string {
  return text
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Interprets a short transcript as a confirm answer. Only a whole short
 * utterance made of yes-words (or no-words) counts; anything mixed or longer
 * returns null so it is not mistaken for an answer.
 */
export function parseVoiceAnswer(text: string): boolean | null {
  const words = normalizeTurkish(text).split(" ").filter(Boolean);
  if (words.length === 0 || words.length > MAX_ANSWER_WORDS) return null;
  let yes = 0;
  let no = 0;
  for (const w of words) {
    if (YES_WORDS.has(w)) yes++;
    else if (NO_WORDS.has(w)) no++;
    else if (!FILLER_WORDS.has(w)) return null;
  }
  if (yes > 0 && no === 0) return true;
  if (no > 0 && yes === 0) return false;
  return null;
}

// ---------------------------------------------------------------- confirm broker

/**
 * `cancel` is internal (turn cancelled / socket closed). On the wire it is
 * reported as `by: "button"` (a client action) with `approved: false`, because
 * the v1 contract only knows button | voice | timeout.
 */
export type ConfirmResolution = { approved: boolean; by: ConfirmResolvedBy | "cancel" };

export interface ConfirmRequest {
  requestId: string;
  turnId: string;
  tool: string;
  summary: string;
  expiresAt: number;
}

interface Pending {
  request: ConfirmRequest;
  resolve: (r: ConfirmResolution) => void;
  timer: NodeJS.Timeout;
}

/**
 * Holds pending confirmations for one session. The first resolution wins
 * (button, voice, timeout or cancel); later ones are ignored and `resolve`
 * returns false, so `confirm_resolved` is emitted exactly once.
 */
export class ConfirmBroker {
  private readonly pending = new Map<string, Pending>();

  constructor(
    private readonly timeoutMs: number = DEFAULT_CONFIRM_TIMEOUT_MS,
    private readonly onResolved: (req: ConfirmRequest, res: ConfirmResolution) => void = () => {},
    private readonly now: () => number = Date.now,
  ) {}

  open(turnId: string, tool: string, summary: string): { request: ConfirmRequest; result: Promise<ConfirmResolution> } {
    const request: ConfirmRequest = {
      requestId: `c-${randomUUID()}`,
      turnId,
      tool,
      summary,
      expiresAt: this.now() + this.timeoutMs,
    };
    let resolveFn!: (r: ConfirmResolution) => void;
    const result = new Promise<ConfirmResolution>((res) => (resolveFn = res));
    const timer = setTimeout(() => this.resolve(request.requestId, false, "timeout"), this.timeoutMs);
    timer.unref?.();
    this.pending.set(request.requestId, { request, resolve: resolveFn, timer });
    return { request, result };
  }

  /** Returns true if this call resolved the request (first wins). */
  resolve(requestId: string, approved: boolean, by: ConfirmResolution["by"]): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    clearTimeout(p.timer);
    // An answer arriving after expiresAt (timer delayed by a busy event loop)
    // counts as a timeout. A timeout or cancel can never approve.
    const effective: ConfirmResolution["by"] = by !== "cancel" && this.now() >= p.request.expiresAt ? "timeout" : by;
    const res: ConfirmResolution = {
      approved: effective === "timeout" || effective === "cancel" ? false : approved,
      by: effective,
    };
    this.onResolved(p.request, res);
    p.resolve(res);
    return true;
  }

  isPending(requestId: string): boolean {
    return this.pending.has(requestId);
  }

  /** The oldest pending request — the one a voice answer applies to. */
  oldest(): ConfirmRequest | undefined {
    const first = this.pending.values().next();
    return first.done ? undefined : first.value.request;
  }

  get size(): number {
    return this.pending.size;
  }

  /** Denies every pending request (turn cancelled / socket closed). */
  cancelAll(turnId?: string): void {
    for (const p of [...this.pending.values()]) {
      if (turnId === undefined || p.request.turnId === turnId) this.resolve(p.request.requestId, false, "cancel");
    }
  }
}

// ---------------------------------------------------------------- summary

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Human-readable Turkish description of a tool call for the confirm dialog. */
export function summarizeToolCall(identity: ToolIdentity, input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined || v === null || v === "") continue;
    const val = Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v);
    parts.push(`${k}: ${clip(val, 60)}`);
    if (parts.length >= 5) break;
  }
  const where = identity.service ? `${identity.service} / ` : "";
  const args = parts.length > 0 ? ` (${parts.join("; ")})` : "";
  return clip(`${where}${identity.tool} çalıştırılsın mı?${args}`, 300);
}
