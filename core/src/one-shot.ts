/**
 * Options of the one-shot background model calls (memory extraction and
 * lifecycle summaries; docs/06): no tools, no MCP, nothing from ~/.claude, no
 * persisted session, one turn. Kept out of index.ts (which starts the Core on
 * import) so the lock-down can be tested (docs/08 §T7.w.6).
 */
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { DENIED_BUILTIN_TOOLS } from "./agent.js";

export function buildOneShotOptions(
  cwd: string,
  env: NodeJS.ProcessEnv,
): (p: { model: string; system?: string; abortController: AbortController }) => Omit<Options, "prompt"> {
  return (p) => ({
    model: p.model,
    ...(p.system !== undefined ? { systemPrompt: { type: "custom", prompt: p.system, snapshot: false } } : {}),
    tools: [],
    disallowedTools: DENIED_BUILTIN_TOOLS,
    settingSources: [],
    strictMcpConfig: true,
    mcpServers: {},
    permissionMode: "default",
    canUseTool: async () => ({ behavior: "deny", message: "No tools in background calls." }),
    abortController: p.abortController,
    persistSession: false,
    cwd,
    maxTurns: 1,
    env,
  });
}
