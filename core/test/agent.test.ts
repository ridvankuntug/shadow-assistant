/** Agent SDK bridge tests — no subprocess, no model call. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { CanUseTool, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { DENIED_BUILTIN_TOOLS, SdkAgentRunner, subprocessEnv, TurnStream } from "../src/agent.js";
import { buildTurnEnvelope, DIRECT_NOTES_END, DIRECT_NOTES_START, TIER1_MARKER, wrapDirectNotes } from "../src/turn-envelope.js";

const base = mkdtempSync(join(tmpdir(), "shadow-agent-test-"));
after(() => rmSync(base, { recursive: true, force: true }));

const msg = (m: unknown) => m as SDKMessage;
const textDelta = (text: string) =>
  msg({ type: "stream_event", parent_tool_use_id: null, session_id: "s1", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
const blockStart = () =>
  msg({ type: "stream_event", parent_tool_use_id: null, session_id: "s1", event: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } });

test("buildOptions locks the model down to MCP tools only", () => {
  const runner = new SdkAgentRunner({ systemPrompt: "sys", mcpServers: () => ({}), cwd: join(base, "cwd") });
  const opts = runner.buildOptions(
    { prompt: "x", model: "haiku", signal: new AbortController().signal, canUseTool: async () => ({ behavior: "deny", message: "" }) },
    new AbortController(),
  );
  assert.deepEqual(opts.tools, []);
  assert.deepEqual(opts.settingSources, []);
  assert.equal(opts.strictMcpConfig, true);
  assert.equal(opts.permissionMode, "default");
  assert.equal(opts.allowedTools, undefined, "nothing may bypass canUseTool");
  for (const t of ["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch"]) assert.ok(opts.disallowedTools?.includes(t), t);
  assert.ok(DENIED_BUILTIN_TOOLS.length > 10);
  assert.equal(opts.model, "haiku");
  assert.deepEqual(opts.systemPrompt, { type: "custom", prompt: "sys", snapshot: false });
  assert.equal(opts.includePartialMessages, true);
  assert.equal(opts.forkSession, undefined);
});

test("buildOptions: tier-1 escalation prompt, fork only when resuming, MCP server filter", () => {
  const runner = new SdkAgentRunner({
    systemPrompt: "sys",
    escalationPrompt: "esc",
    mcpServers: () => ({ a: { type: "sse", url: "http://localhost:1/a" }, b: { type: "sse", url: "http://localhost:1/b" } }),
    cwd: join(base, "cwd"),
  });
  const req = { prompt: "x", model: "haiku", signal: new AbortController().signal, canUseTool: async () => ({ behavior: "deny" as const, message: "" }) };
  const esc = runner.buildOptions({ ...req, escalatable: true, forkSession: true, resume: "s1", mcpServerNames: ["b"] }, new AbortController());
  assert.deepEqual(esc.systemPrompt, { type: "custom", prompt: "sys\n\nesc", snapshot: false });
  assert.equal(esc.forkSession, true);
  assert.equal(esc.resume, "s1");
  assert.deepEqual(Object.keys(esc.mcpServers ?? {}), ["b"]);
  const fresh = runner.buildOptions({ ...req, forkSession: true }, new AbortController());
  assert.equal(fresh.forkSession, undefined, "nothing to fork without resume");
  assert.deepEqual(Object.keys(fresh.mcpServers ?? {}), ["a", "b"]);
});

test("subprocessEnv strips device tokens, HA token and empty API key", () => {
  const env = subprocessEnv({
    PATH: "p",
    DEVICE_TOKEN_BROWSER: "secret",
    HA_CORE_TOKEN: "secret",
    ANTHROPIC_API_KEY: "",
    HA_URL: "http://x",
  });
  assert.equal(env.PATH, "p");
  assert.equal(env.DEVICE_TOKEN_BROWSER, undefined);
  assert.equal(env.HA_CORE_TOKEN, undefined);
  assert.equal("ANTHROPIC_API_KEY" in env, false);
  assert.equal(subprocessEnv({ ANTHROPIC_API_KEY: "k" }).ANTHROPIC_API_KEY, "k");
});

test("TurnStream folds deltas, tool events and usage", () => {
  const deltas: string[] = [];
  const tools: string[] = [];
  const s = new TurnStream({
    onDelta: (t) => deltas.push(t),
    onToolUse: (id, name) => tools.push(`use:${id}:${name}`),
    onToolResult: (id, name, err) => tools.push(`result:${id}:${name}:${err}`),
  });
  s.consume(blockStart());
  s.consume(textDelta("Bakıyorum."));
  s.consume(msg({ type: "assistant", parent_tool_use_id: null, session_id: "s1", message: { content: [{ type: "tool_use", id: "tu1", name: "mcp__home-assistant__homeassistant__GetLiveContext", input: {} }] } }));
  s.consume(msg({ type: "user", parent_tool_use_id: null, session_id: "s1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } }));
  // a sub-agent frame is ignored
  s.consume(msg({ type: "stream_event", parent_tool_use_id: "tu9", session_id: "s1", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "IGNORED" } } }));
  s.consume(blockStart());
  s.consume(textDelta("Salon 21 derece."));
  s.consume(msg({ type: "result", subtype: "success", is_error: false, result: "Salon 21 derece.", session_id: "s1", duration_ms: 1234, total_cost_usd: 0.001, usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, output_tokens: 7 } }));
  const r = s.result(9999);
  assert.equal(r.text, "Bakıyorum.\nSalon 21 derece.");
  assert.deepEqual(deltas, ["Bakıyorum.", "\n", "Salon 21 derece."]);
  assert.deepEqual(tools, [
    "use:tu1:mcp__home-assistant__homeassistant__GetLiveContext",
    "result:tu1:mcp__home-assistant__homeassistant__GetLiveContext:false",
  ]);
  assert.equal(r.sessionId, "s1");
  assert.equal(r.inputTokens, 100);
  assert.equal(r.cacheReadTokens, 90);
  assert.equal(r.cacheWriteTokens, 0);
  assert.deepEqual(r.tools, ["mcp__home-assistant__homeassistant__GetLiveContext"]);
  assert.equal(r.outputTokens, 7);
  assert.equal(r.durationMs, 1234);
  assert.equal(r.costUsd, 0.001);
  assert.equal(r.error, undefined);
});

test("TurnStream: no partials → final text; error results surface", () => {
  const deltas: string[] = [];
  const s = new TurnStream({ onDelta: (t) => deltas.push(t) });
  s.consume(msg({ type: "result", subtype: "success", is_error: false, result: "Merhaba!", session_id: "s2", duration_ms: 5, usage: { input_tokens: 1, output_tokens: 1 } }));
  assert.equal(s.result(0).text, "Merhaba!");
  assert.deepEqual(deltas, ["Merhaba!"]);

  const e = new TurnStream({ onDelta: () => {} });
  e.consume(msg({ type: "result", subtype: "error_max_turns", is_error: true, errors: ["too many"], session_id: "s3", duration_ms: 5, usage: { input_tokens: 1, output_tokens: 1 } }));
  assert.match(e.result(0).error ?? "", /error_max_turns: too many/);

  const a = new TurnStream({ onDelta: () => {} });
  a.consume(msg({ type: "assistant", parent_tool_use_id: null, session_id: "s4", error: "authentication_failed", message: { content: [] } }));
  assert.match(a.result(0).error ?? "", /authentication_failed/);
});

test("persistent options: one static prompt with tier1.md, all MCP servers, no tier/fork inputs", () => {
  const runner = new SdkAgentRunner({
    systemPrompt: "sys",
    escalationPrompt: "esc",
    mcpServers: () => ({ a: { type: "sse", url: "http://localhost:1/a" }, b: { type: "sse", url: "http://localhost:1/b" } }),
    cwd: join(base, "cwd"),
  });
  const gate: CanUseTool = async () => ({ behavior: "deny", message: "" });
  const ac = new AbortController();
  const a = runner.buildPersistentOptions({ model: "haiku", canUseTool: gate, abortController: ac });
  const b = runner.buildPersistentOptions({ model: "haiku", canUseTool: gate, abortController: ac });
  assert.deepEqual({ ...a, env: undefined }, { ...b, env: undefined }, "nothing per-turn in the options");
  assert.deepEqual(a.systemPrompt, { type: "custom", prompt: "sys\n\nesc", snapshot: false });
  assert.deepEqual(Object.keys(a.mcpServers ?? {}), ["a", "b"]);
  assert.equal(a.forkSession, undefined);
  assert.equal("resume" in a, false);
  assert.equal(a.canUseTool, gate);
  assert.equal(a.abortController, ac);
  assert.equal(a.maxTurns, 12);
  assert.deepEqual(a.tools, []);
  assert.deepEqual(a.settingSources, []);
  assert.equal(a.strictMcpConfig, true);
  assert.equal(a.includePartialMessages, true);
  assert.equal(a.allowedTools, undefined);
  const resumed = runner.buildPersistentOptions({ model: "haiku", resume: "s9", canUseTool: gate, abortController: ac, memoryBrief: "mem" });
  assert.equal(resumed.resume, "s9");
  assert.deepEqual(resumed.systemPrompt, { type: "custom", prompt: "sys\n\nesc\n\nmem", snapshot: false });
});

test("turn envelope: tier-1 marker line, optional memory block, user text", () => {
  assert.equal(buildTurnEnvelope({ text: "merhaba" }), "merhaba");
  assert.equal(buildTurnEnvelope({ text: "merhaba", escalatable: true }), `${TIER1_MARKER}\nmerhaba`);
  assert.equal(buildTurnEnvelope({ text: "merhaba", escalatable: true, memoryBlock: " <hafıza> \n" }), `${TIER1_MARKER}\n<hafıza>\nmerhaba`);
  assert.equal(TIER1_MARKER, "[mod:hizli]");
});

test("prompts: tier1.md is conditional on the marker; system.md hides control lines", () => {
  const dir = join(import.meta.dirname, "..", "prompts");
  const tier1 = readFileSync(join(dir, "tier1.md"), "utf8");
  assert.ok(tier1.includes(`\`${TIER1_MARKER}\``), "tier1.md names the marker");
  assert.ok(tier1.includes("[[ESCALATE]]"));
  assert.ok(readFileSync(join(dir, "system.md"), "utf8").includes(TIER1_MARKER));
});

test("prompts: greetings are never escalated; vague requests get a question; no 'emin değilsen' escalation", () => {
  const tier1 = readFileSync(join(import.meta.dirname, "..", "prompts", "tier1.md"), "utf8");
  assert.match(tier1, /Selamlaşma[^\n]*asla yükseltme/);
  assert.match(tier1, /belirsiz[^\n]*kısa bir soruyla netleştir/);
  assert.doesNotMatch(tier1, /emin değilsen/i);
});

test("direct notes: delimited records before the request; system.md names both delimiters", () => {
  assert.equal(wrapDirectNotes([]), "");
  assert.equal(wrapDirectNotes(["Kullanıcı: ışığı aç\nShadow: Açtım.", " "]), `${DIRECT_NOTES_START}\nKullanıcı: ışığı aç\nShadow: Açtım.\n${DIRECT_NOTES_END}`);
  assert.equal(
    buildTurnEnvelope({ text: "hava nasıl?", escalatable: true, notes: ["Kullanıcı: a\nShadow: b"] }),
    `${TIER1_MARKER}\n${DIRECT_NOTES_START}\nKullanıcı: a\nShadow: b\n${DIRECT_NOTES_END}\nhava nasıl?`,
  );
  const system = readFileSync(join(import.meta.dirname, "..", "prompts", "system.md"), "utf8");
  assert.ok(system.includes(DIRECT_NOTES_START) && system.includes(DIRECT_NOTES_END));
  assert.match(system, /sonra gelen kullanıcı isteğini her zamanki gibi cevapla/);
});

test("subprocessEnv: CORE_AGENT_SKIP_TURN_SUMMARY=1 switches the CLI turn summary off (opt-in)", () => {
  assert.equal(subprocessEnv({}).CLAUDE_CODE_CLASSIFIER_SUMMARY, undefined);
  assert.equal(subprocessEnv({ CORE_AGENT_SKIP_TURN_SUMMARY: "0" }).CLAUDE_CODE_CLASSIFIER_SUMMARY, undefined);
  assert.equal(subprocessEnv({ CORE_AGENT_SKIP_TURN_SUMMARY: "1" }).CLAUDE_CODE_CLASSIFIER_SUMMARY, "0");
});

test("TurnStream.result({fallbackText:false}) does not emit the final text", () => {
  const deltas: string[] = [];
  const s = new TurnStream({ onDelta: (t) => deltas.push(t) });
  s.consume(msg({ type: "result", subtype: "success", is_error: false, result: "Merhaba!", session_id: "s2", duration_ms: 5, usage: { input_tokens: 1, output_tokens: 1 } }));
  assert.equal(s.result(0, { fallbackText: false }).text, "");
  assert.deepEqual(deltas, []);
});

test("session.ts never loads the provider SDK: its value-import graph does not reach agent.ts or the SDK", () => {
  const src = join(import.meta.dirname, "..", "src");
  const seen = new Set<string>();
  const reached: string[] = [];
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const code = readFileSync(join(src, file), "utf8");
    // Every import/export-from statement that is not type-only (those are erased).
    for (const m of code.matchAll(/^(?:import|export)\s+(type\s)?[^;]*?\sfrom\s+"([^"]+)";/gms)) {
      if (m[1]) continue;
      const spec = m[2]!;
      if (spec.startsWith("./")) visit(spec.slice(2).replace(/\.js$/, ".ts"));
      else reached.push(`${file} -> ${spec}`);
    }
  };
  visit("session.ts");
  assert.ok(!seen.has("agent.ts"), `agent.ts is value-imported (${[...seen].join(", ")})`);
  assert.ok(!reached.some((r) => r.includes("@anthropic-ai/")), reached.join("\n"));
  assert.ok(seen.has("turn-envelope.ts"));
});
