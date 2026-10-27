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
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  costUsd?: number;
  /** Set when the turn ended on an error (model/auth/API); text may be partial. */
  error?: string;
}

/** The session talks to this interface only, so unit tests can mock the model. */
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

export interface SdkAgentOptions {
  systemPrompt: string;
  /** Built per turn: in-process MCP server instances cannot be shared between queries. */
  mcpServers: () => Record<string, McpServerConfig>;
  /** Working directory of the SDK subprocess (keeps its session files apart). */
  cwd: string;
  maxTurns?: number;
  /** Environment for the subprocess; secrets the model process must not see are removed. */
  env?: NodeJS.ProcessEnv;
  stderr?: (line: string) => void;
}

/** Environment for the SDK subprocess: drop device tokens, HA token and empty API keys. */
export function subprocessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith("DEVICE_TOKEN_") || k === "HA_CORE_TOKEN") continue;
    if (k === "ANTHROPIC_API_KEY" && !v) continue;
    out[k] = v;
  }
  out.CLAUDE_AGENT_SDK_CLIENT_APP = "shadow-assistant-core/0.1";
  return out;
}

export class SdkAgentRunner implements AgentRunner {
  constructor(private readonly opts: SdkAgentOptions) {
    mkdirSync(opts.cwd, { recursive: true });
  }

  buildOptions(req: TurnRequest, abortController: AbortController): Options {
    return {
      model: req.model,
      systemPrompt: this.opts.systemPrompt,
      tools: [],
      disallowedTools: DENIED_BUILTIN_TOOLS,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: this.opts.mcpServers(),
      canUseTool: req.canUseTool,
      permissionMode: "default",
      includePartialMessages: true,
      abortController,
      resume: req.resume,
      cwd: this.opts.cwd,
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
      const q = query({ prompt: req.prompt, options: this.buildOptions(req, abortController) });
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
        this.inputTokens =
          (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
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

  result(elapsedMs: number): TurnResult {
    // Without partial messages (or if streaming produced nothing) fall back to the final text.
    if (this.text === "" && this.finalText) this.emit(this.finalText);
    return {
      text: this.text,
      sessionId: this.sessionId,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      durationMs: this.durationMs ?? elapsedMs,
      costUsd: this.costUsd,
      error: this.error,
    };
  }
}
