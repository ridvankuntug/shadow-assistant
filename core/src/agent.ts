/**
 * Claude Agent SDK bridge.
 *
 * Security posture (T2.1):
 *   - `tools: []` removes every built-in tool (Bash, Read, Write, Edit,
 *     WebFetch, …) from the model's context; `disallowedTools` repeats the
 *     common ones as defence in depth, and the permission gate denies any
 *     non-MCP tool that still shows up.
 *   - `settingSources: []` + `strictMcpConfig: true`: nothing from the user's
 *     ~/.claude (settings, CLAUDE.md, MCP servers, plugins) is loaded.
 *   - Auth: the SDK uses the machine's Claude Code login; ANTHROPIC_API_KEY is
 *     only used if the operator sets it.
 */
import { mkdirSync } from "node:fs";
import {
  query,
  type CanUseTool,
  type McpServerConfig,
  type Options,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

export interface TurnRequest {
  prompt: string;
  model: string;
  /** SDK session id of the previous turn, to keep conversation context. */
  resume?: string;
  signal: AbortSignal;
  canUseTool: CanUseTool;
  /**
   * Tier 1: append the escalation instructions (prompts/tier1.md) to the
   * system prompt so the model can hand the turn to the stronger tier.
   */
  escalatable?: boolean;
  /** With `resume`: continue in a forked copy, leaving the resumed session untouched (tier 1 attempts). */
  forkSession?: boolean;
  /** Only these MCP servers are loaded for the turn (undefined = all enabled). */
  mcpServerNames?: readonly string[];
}

export interface TurnCallbacks {
  onDelta(text: string): void;
  onToolUse?(toolUseId: string, name: string): void;
  onToolResult?(toolUseId: string, name: string | undefined, isError: boolean): void;
}

export interface TurnResult {
  /** Full assistant text as streamed to the client. */
  text: string;
  sessionId?: string;
  /** Total input tokens, cache reads and writes included. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Full SDK names of the tools the model called, in call order. */
  tools?: string[];
  durationMs: number;
  costUsd?: number;
  /** Set when the turn ended on an error (model/auth/API); text may be partial. */
  error?: string;
}

/**
 * The session talks to this interface only, so unit tests can mock the model.
 * Implementations must deliver all answer text through `onDelta`: the session
 * builds the final text from it (`TurnResult.text` is informational).
 */
export interface AgentRunner {
  runTurn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult>;
}

/** Built-in tool names denied explicitly (in addition to `tools: []`). */
export const DENIED_BUILTIN_TOOLS = [
  "Bash",
  "BashOutput",
  "KillShell",
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "TodoWrite",
  "Skill",
  "SlashCommand",
  "ExitPlanMode",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
];

/**
 * First line of an escalatable tier-1 user message. `prompts/tier1.md` is
 * written conditionally on it, so one static system prompt serves every tier
 * (persistent mode) and the escalation rule applies only to marked messages.
 */
export const TIER1_MARKER = "[mod:hizli]";

/**
 * Delimiters of the tier-0 exchange records the model did not see
 * (`system.md`: never answer what is between them; answer the request after
 * them). They keep the records apart from a question in the same message.
 */
export const DIRECT_NOTES_START = "<bilgi>";
export const DIRECT_NOTES_END = "</bilgi>";

/** Wraps tier-0 exchange records (`Kullanıcı: … / Shadow: …`) in the delimiters; "" when there are none. */
export function wrapDirectNotes(notes: readonly string[]): string {
  const body = notes.map((n) => n.trim()).filter((n) => n !== "");
  if (body.length === 0) return "";
  return [DIRECT_NOTES_START, ...body, DIRECT_NOTES_END].join("\n");
}

/**
 * The user message of one model turn ("turn envelope", docs/07 §Tier switching):
 * the tier-1 marker line (escalatable turns only), delimited tier-0 records,
 * an optional memory block (docs/06), then the user's text.
 */
export function buildTurnEnvelope(e: { text: string; escalatable?: boolean; notes?: readonly string[]; memoryBlock?: string }): string {
  const parts: string[] = [];
  if (e.escalatable) parts.push(TIER1_MARKER);
  const notes = wrapDirectNotes(e.notes ?? []);
  if (notes) parts.push(notes);
  if (e.memoryBlock?.trim()) parts.push(e.memoryBlock.trim());
  parts.push(e.text);
  return parts.join("\n");
}

export interface SdkAgentOptions {
  systemPrompt: string;
  /**
   * prompts/tier1.md. Legacy mode: appended to the system prompt for
   * escalatable (tier 1) turns. Persistent mode: always part of the one static
   * system prompt (the rule is conditional on `TIER1_MARKER`).
   */
  escalationPrompt?: string;
  /** Built per turn: in-process MCP server instances cannot be shared between queries. */
  mcpServers: () => Record<string, McpServerConfig>;
  /** Working directory of the SDK subprocess (keeps its session files apart). */
  cwd: string;
  maxTurns?: number;
  /** Environment for the subprocess; secrets the model process must not see are removed. */
  env?: NodeJS.ProcessEnv;
  stderr?: (line: string) => void;
}

/** Fixed per persistent query: no per-turn tier, resume or fork (docs/07 §Query options). */
export interface PersistentOptionsRequest {
  /** Initial model (tier 1); other tiers switch with `Query.setModel()`. */
  model: string;
  /** Session id to continue (A4 continuity), if any. */
  resume?: string;
  /** The DeviceAgent's gate dispatcher; fixed for the life of the query. */
  canUseTool: CanUseTool;
  /** Owned by the DeviceAgent; aborted only on close. */
  abortController: AbortController;
  /** Memory brief (docs/06), appended to the static system prompt when present. */
  memoryBrief?: string;
}

/**
 * Environment for the SDK subprocess: drop device tokens, HA token and empty API keys.
 *
 * `CORE_AGENT_SKIP_TURN_SUMMARY=1` (opt-in) sets `CLAUDE_CODE_CLASSIFIER_SUMMARY=0`:
 * the CLI then skips the end-of-turn LLM summary classifier that delays `result`
 * by ~2 to 2.5 s on warm turns (docs/07 §Spike results Q12). The variable is
 * undocumented in the CLI and may change or disappear with an SDK update; the
 * bench is the regression check. Off by default.
 */
export function subprocessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("DEVICE_TOKEN_") || k === "HA_CORE_TOKEN") continue;
    if (k === "ANTHROPIC_API_KEY" && !v) continue;
    out[k] = v;
  }
  if (env.CORE_AGENT_SKIP_TURN_SUMMARY === "1") out.CLAUDE_CODE_CLASSIFIER_SUMMARY = "0";
  out.CLAUDE_AGENT_SDK_CLIENT_APP = "shadow-assistant-core/0.1";
  return out;
}

/**
 * Legacy mode (`CORE_AGENT_PERSISTENT=off`, and the one-turn fallback when a
 * DeviceAgent cannot start): a fresh `query()` per turn. `buildPersistentOptions`
 * provides the options of the persistent per-device query (docs/07 §A1).
 */
export class SdkAgentRunner implements AgentRunner {
  constructor(private readonly opts: SdkAgentOptions) {
    mkdirSync(opts.cwd, { recursive: true });
  }

  buildOptions(req: TurnRequest, abortController: AbortController): Options {
    const prompt =
      req.escalatable && this.opts.escalationPrompt
        ? `${this.opts.systemPrompt}\n\n${this.opts.escalationPrompt}`
        : this.opts.systemPrompt;
    let mcpServers = this.opts.mcpServers();
    if (req.mcpServerNames) {
      const keep = new Set(req.mcpServerNames);
      mcpServers = Object.fromEntries(Object.entries(mcpServers).filter(([name]) => keep.has(name)));
    }
    return {
      model: req.model,
      // Static per tier (byte-identical every turn) so the API prompt cache hits.
      // `snapshot: false`: a resumed session must get this turn's prompt, not the
      // one recorded when the session started on another tier.
      systemPrompt: { type: "custom", prompt, snapshot: false },
      tools: [],
      disallowedTools: DENIED_BUILTIN_TOOLS,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers,
      canUseTool: req.canUseTool,
      permissionMode: "default",
      includePartialMessages: true,
      abortController,
      resume: req.resume,
      ...(req.resume && req.forkSession ? { forkSession: true } : {}),
      cwd: this.opts.cwd,
      maxTurns: this.opts.maxTurns ?? 12,
      env: this.opts.env ?? subprocessEnv(process.env),
      stderr: this.opts.stderr,
    };
  }

  /** One static system prompt for all tiers (same bytes every turn, so each model keeps its cache prefix). */
  persistentSystemPrompt(memoryBrief?: string): string {
    const parts = [this.opts.systemPrompt];
    if (this.opts.escalationPrompt) parts.push(this.opts.escalationPrompt);
    if (memoryBrief?.trim()) parts.push(memoryBrief.trim());
    return parts.join("\n\n");
  }

  /** Options of a persistent streaming-input query; independent of the tier by design. */
  buildPersistentOptions(p: PersistentOptionsRequest): Omit<Options, "prompt"> {
    return {
      model: p.model,
      systemPrompt: { type: "custom", prompt: this.persistentSystemPrompt(p.memoryBrief), snapshot: false },
      tools: [],
      disallowedTools: DENIED_BUILTIN_TOOLS,
      settingSources: [],
      strictMcpConfig: true,
      // All enabled services: the tool list stays stable for the whole session;
      // per-tier service limits are enforced by the gate (docs/07 §Tier switching).
      mcpServers: this.opts.mcpServers(),
      canUseTool: p.canUseTool,
      permissionMode: "default",
      includePartialMessages: true,
      abortController: p.abortController,
      ...(p.resume ? { resume: p.resume } : {}),
      cwd: this.opts.cwd,
      // Counts per user message in streaming-input mode (spike Q4).
      maxTurns: this.opts.maxTurns ?? 12,
      env: this.opts.env ?? subprocessEnv(process.env),
      stderr: this.opts.stderr,
    };
  }

  async runTurn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult> {
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    if (req.signal.aborted) abortController.abort();
    req.signal.addEventListener("abort", onAbort, { once: true });
    const started = Date.now();
    const stream = new TurnStream(cb);
    try {
      // tier1.md is conditional on the marker line, so escalatable turns carry it.
      const prompt = req.escalatable && this.opts.escalationPrompt ? buildTurnEnvelope({ text: req.prompt, escalatable: true }) : req.prompt;
      const q = query({ prompt, options: this.buildOptions(req, abortController) });
      for await (const msg of q) stream.consume(msg);
    } catch (err) {
      if (!req.signal.aborted) stream.fail((err as Error).message || "agent error");
    } finally {
      req.signal.removeEventListener("abort", onAbort);
    }
    return stream.result(Date.now() - started);
  }
}

/**
 * Folds the SDK message stream of one turn into client callbacks + a result.
 * Exported for unit tests (fed with synthetic SDK messages).
 */
export class TurnStream {
  private text = "";
  private blockHasText = false;
  private readonly toolNames = new Map<string, string>();
  private sessionId: string | undefined;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private readonly tools: string[] = [];
  private costUsd: number | undefined;
  private durationMs: number | undefined;
  private error: string | undefined;
  private finalText: string | undefined;

  constructor(private readonly cb: TurnCallbacks) {}

  private emit(chunk: string): void {
    if (!chunk) return;
    this.text += chunk;
    this.cb.onDelta(chunk);
  }

  consume(msg: SDKMessage): void {
    if ("session_id" in msg && typeof msg.session_id === "string") this.sessionId = msg.session_id;
    switch (msg.type) {
      case "stream_event": {
        if (msg.parent_tool_use_id) return;
        const ev = msg.event;
        if (ev.type === "content_block_start") {
          this.blockHasText = false;
        } else if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
          // Separate text blocks of consecutive assistant messages (before/after a tool call).
          if (!this.blockHasText && this.text !== "" && !/\s$/.test(this.text)) this.emit("\n");
          this.blockHasText = true;
          this.emit(ev.delta.text);
        }
        return;
      }
      case "assistant": {
        if (msg.parent_tool_use_id) return;
        if (msg.error) this.error = `assistant error: ${msg.error}`;
        for (const block of msg.message.content) {
          if (block.type === "tool_use") {
            this.toolNames.set(block.id, block.name);
            this.tools.push(block.name);
            this.cb.onToolUse?.(block.id, block.name);
          }
        }
        return;
      }
      case "user": {
        if (msg.parent_tool_use_id) return;
        const content = msg.message.content;
        if (!Array.isArray(content)) return;
        for (const block of content) {
          if (typeof block === "object" && block !== null && block.type === "tool_result") {
            this.cb.onToolResult?.(block.tool_use_id, this.toolNames.get(block.tool_use_id), block.is_error === true);
          }
        }
        return;
      }
      case "result": {
        const u = msg.usage as unknown as Record<string, number | undefined>;
        this.cacheReadTokens = u.cache_read_input_tokens ?? 0;
        this.cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
        this.inputTokens = (u.input_tokens ?? 0) + this.cacheWriteTokens + this.cacheReadTokens;
        this.outputTokens = u.output_tokens ?? 0;
        this.costUsd = msg.total_cost_usd;
        this.durationMs = msg.duration_ms;
        if (msg.subtype === "success" && !msg.is_error) {
          this.finalText = msg.result;
        } else {
          const detail = msg.subtype === "success" ? msg.result : (msg.errors ?? []).join("; ");
          this.error = `${msg.subtype}${detail ? `: ${detail}` : ""}`;
        }
        return;
      }
      default:
        return;
    }
  }

  fail(message: string): void {
    this.error ??= message;
  }

  /** Text streamed so far (the DeviceAgent reads it at the visible turn end). */
  get streamedText(): string {
    return this.text;
  }

  /**
   * `fallbackText: false` skips emitting the final `result` text when nothing
   * was streamed (used when the turn already ended visibly, or for a usage-limit
   * message that is reported as an error frame instead).
   */
  result(elapsedMs: number, o: { fallbackText?: boolean } = {}): TurnResult {
    // Without partial messages (or if streaming produced nothing) fall back to the final text.
    if (o.fallbackText !== false && this.text === "" && this.finalText) this.emit(this.finalText);
    return {
      text: this.text,
      sessionId: this.sessionId,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      tools: [...this.tools],
      durationMs: this.durationMs ?? elapsedMs,
      costUsd: this.costUsd,
      error: this.error,
    };
  }
}
