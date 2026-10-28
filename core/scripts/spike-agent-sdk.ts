/**
 * S1 spike (docs/07-speed.md §S1 spike questions): a throwaway probe of the
 * Agent SDK streaming-input mode against the real Claude Code CLI.
 *
 *   SPIKE_CWD=<empty dir> npx tsx scripts/spike-agent-sdk.ts main resume getinfo maxturns compact startup idle
 *
 * - Uses the machine's Claude Code login (subscription usage): every phase
 *   sends only a few short Haiku turns. `compact` sends one ~30k-token message.
 * - SPIKE_CWD is the SDK cwd (its transcripts go to ~/.claude/projects/<encoded cwd>);
 *   it defaults to <os tmp>/shadow-agent-spike, never the Core data dir.
 * - Home Assistant is connected like the Core does (services.yaml + .env), but
 *   the permission callback only ever allows `GetLiveContext` (read-only).
 * - Prints one JSON line per observation; nothing else is written.
 */
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  getSessionInfo,
  query,
  startup,
  type CanUseTool,
  type McpServerConfig,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { DENIED_BUILTIN_TOOLS, subprocessEnv } from "../src/agent.js";
import { loadConfig, loadDotEnv } from "../src/config.js";

const CWD = resolve(process.env.SPIKE_CWD || join(tmpdir(), "shadow-agent-spike"));
const MODEL = process.env.SPIKE_MODEL || "haiku";
const IDLE_MIN = Number(process.env.SPIKE_IDLE_MIN || 15);
const TRACE = process.env.SPIKE_TRACE === "1";
const SYSTEM = "Sen kısa cevap veren bir test asistanısın. Türkçe, en fazla bir cümle yaz.";

function log(event: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Home Assistant MCP config exactly as the Core builds it (SSE, alwaysLoad). */
function haServer(): Record<string, McpServerConfig> {
  loadDotEnv();
  const cfg = loadConfig();
  const svc = cfg.services.services.find((s) => s.name === "home-assistant" && s.enabled && s.url);
  if (!svc || !svc.url) return {};
  const token = svc.tokenEnv ? process.env[svc.tokenEnv] : undefined;
  const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
  return {
    [svc.name]:
      svc.transport === "http"
        ? { type: "http", url: svc.url, headers, alwaysLoad: true, timeout: svc.timeoutMs }
        : { type: "sse", url: svc.url, headers, alwaysLoad: true, timeout: svc.timeoutMs },
  };
}

/** Never-ending input queue: the streaming prompt of one query. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake: (() => void) | undefined;
  private closed = false;
  push(text: string, extra: Partial<SDKUserMessage> = {}): void {
    this.items.push({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      ...extra,
    } as SDKUserMessage);
    this.wake?.();
  }
  end(): void {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    for (;;) {
      while (this.items.length) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((r) => (this.wake = r));
      this.wake = undefined;
    }
  }
}

interface TurnObs {
  results: number;
  subtype?: string;
  isError?: boolean;
  sessionIds: Set<string>;
  firstDeltaMs?: number;
  resultMs?: number;
  /** Epoch ms of the `result`. */
  resultAt?: number;
  durationMs?: number;
  numTurns?: number;
  text: string;
  models: Set<string>;
  modelUsageKeys?: string[];
  costUsd?: number;
  tools: string[];
  errors: string[];
  resultText?: string;
  compactBoundary?: unknown;
}

/** One query + an output pump that folds messages into the current turn. */
class Probe {
  readonly input = new InputQueue();
  readonly q: Query;
  readonly started = Date.now();
  sessionId: string | undefined;
  initAtMs: number | undefined;
  initMcp: unknown;
  private cur: TurnObs | undefined;
  private curStart = 0;
  private onResult: ((o: TurnObs) => void) | undefined;
  private onFirstDelta: (() => void) | undefined;
  private strayResults = 0;
  pumpDone: Promise<void>;
  pumpError: string | undefined;

  constructor(opts: Partial<Options>, canUseTool?: CanUseTool) {
    const abortController = new AbortController();
    const options: Options = {
      model: MODEL,
      systemPrompt: { type: "custom", prompt: SYSTEM, snapshot: false },
      tools: [],
      disallowedTools: DENIED_BUILTIN_TOOLS,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: haServer(),
      canUseTool: canUseTool ?? (async () => ({ behavior: "deny", message: "spike: denied" })),
      permissionMode: "default",
      includePartialMessages: true,
      abortController,
      cwd: CWD,
      maxTurns: 12,
      env: subprocessEnv(process.env),
      stderr: (line) => log("stderr", { line: line.trimEnd().slice(0, 300) }),
      ...opts,
    };
    this.q = query({ prompt: this.input, options });
    this.pumpDone = this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const msg of this.q) this.consume(msg);
    } catch (err) {
      this.pumpError = (err as Error).message;
      log("pump_error", { message: this.pumpError });
    }
  }

  private consume(msg: SDKMessage): void {
    if (TRACE && this.cur) {
      const m = msg as { type: string; subtype?: string; event?: { type: string; delta?: { type: string; stop_reason?: string } } };
      log("trace", {
        ms: Date.now() - this.curStart,
        type: m.type,
        subtype: m.subtype,
        ev: m.event?.type,
        delta: m.event?.delta?.type ?? m.event?.delta?.stop_reason,
        ...(m.subtype === "post_turn_summary" ? { keys: Object.keys(msg) } : {}),
      });
    }
    if ("session_id" in msg && typeof msg.session_id === "string") this.sessionId = msg.session_id;
    const o = this.cur;
    if (o && "session_id" in msg && typeof msg.session_id === "string") o.sessionIds.add(msg.session_id);
    if (msg.type === "system" && msg.subtype === "init") {
      this.initAtMs = Date.now() - this.started;
      this.initMcp = msg.mcp_servers;
      log("system_init", {
        sinceQueryMs: this.initAtMs,
        model: msg.model,
        mcp: msg.mcp_servers,
        hasCompact: msg.slash_commands.includes("compact"),
      });
      return;
    }
    if (msg.type === "system" && msg.subtype === "compact_boundary") {
      log("compact_boundary", { meta: msg.compact_metadata, sinceTurnMs: Date.now() - this.curStart });
      if (o) o.compactBoundary = msg.compact_metadata;
      return;
    }
    if (msg.type === "system") {
      log("system", { subtype: msg.subtype });
      return;
    }
    if (msg.type === "rate_limit_event") {
      log("rate_limit_event", { info: msg.rate_limit_info });
      return;
    }
    if (!o) {
      if (msg.type === "result") this.strayResults++;
      log("message_outside_turn", { type: msg.type, subtype: "subtype" in msg ? msg.subtype : undefined });
      return;
    }
    if (msg.type === "stream_event" && !msg.parent_tool_use_id) {
      const ev = msg.event;
      if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
        if (o.firstDeltaMs === undefined) {
          o.firstDeltaMs = Date.now() - this.curStart;
          this.onFirstDelta?.();
        }
        o.text += ev.delta.text;
      }
    } else if (msg.type === "assistant") {
      o.models.add(msg.message.model);
      if (msg.error) o.errors.push(`assistant:${msg.error}`);
      for (const b of msg.message.content) if (b.type === "tool_use") o.tools.push(b.name);
    } else if (msg.type === "result") {
      o.results++;
      o.resultAt = Date.now();
      o.resultMs = o.resultAt - this.curStart;
      o.subtype = msg.subtype;
      o.isError = msg.is_error;
      o.durationMs = msg.duration_ms;
      o.numTurns = msg.num_turns;
      o.modelUsageKeys = Object.keys(msg.modelUsage ?? {});
      o.costUsd = msg.total_cost_usd;
      if (msg.subtype === "success") o.resultText = msg.result;
      else o.errors.push(...(msg.errors ?? []));
      this.onResult?.(o);
    }
  }

  /** Sends one user message and resolves at its `result` (or after `timeoutMs`). */
  async turn(
    label: string,
    text: string,
    opts: { timeoutMs?: number; onFirstDelta?: () => void; extra?: Partial<SDKUserMessage> } = {},
  ): Promise<TurnObs> {
    const o: TurnObs = { results: 0, sessionIds: new Set(), text: "", models: new Set(), tools: [], errors: [] };
    this.cur = o;
    this.curStart = Date.now();
    this.onFirstDelta = opts.onFirstDelta;
    const done = new Promise<TurnObs>((r) => (this.onResult = r));
    this.input.push(text, opts.extra);
    const timeout = sleep(opts.timeoutMs ?? 120_000).then(() => undefined);
    const got = await Promise.race([done, timeout]);
    // Linger briefly to catch a second `result` for the same message.
    await sleep(1500);
    this.cur = undefined;
    this.onResult = undefined;
    this.onFirstDelta = undefined;
    log("turn", {
      label,
      timedOut: got === undefined,
      results: o.results,
      subtype: o.subtype,
      isError: o.isError,
      sessionIds: [...o.sessionIds],
      firstDeltaMs: o.firstDeltaMs,
      resultMs: o.resultMs,
      durationMs: o.durationMs,
      numTurns: o.numTurns,
      models: [...o.models],
      modelUsageKeys: o.modelUsageKeys,
      costUsd: o.costUsd,
      tools: o.tools,
      errors: o.errors,
      text: o.text.slice(0, 160),
    });
    return o;
  }

  /** Waits for `ms` and reports whether anything (a reply) arrived meanwhile. */
  async quiet(label: string, ms: number): Promise<void> {
    const o: TurnObs = { results: 0, sessionIds: new Set(), text: "", models: new Set(), tools: [], errors: [] };
    this.cur = o;
    this.curStart = Date.now();
    await sleep(ms);
    this.cur = undefined;
    log("quiet", { label, ms, results: o.results, text: o.text.slice(0, 160), stray: this.strayResults });
  }

  async close(): Promise<void> {
    this.input.end();
    this.q.close();
    await Promise.race([this.pumpDone, sleep(10_000)]);
  }
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t = Date.now();
  try {
    const v = await fn();
    log("call", { label, ms: Date.now() - t, value: v === undefined ? "undefined" : v });
    return v;
  } catch (err) {
    log("call", { label, ms: Date.now() - t, error: (err as Error).message });
    throw err;
  }
}

const READ_TOOL = /GetLiveContext$/;
const CODE_WORD = "ZEYTINYAPRAGI";
let mainSessionId: string | undefined;

/** Q1, Q2, Q3, Q5, Q6, Q7, Q12. */
async function phaseMain(): Promise<void> {
  const gateCalls: { n: number; turn: string; tool: string; aborted: boolean[] }[] = [];
  let gateTurn = "";
  let hang = false;
  let interruptOnGate: (() => void) | undefined;
  const gate: CanUseTool = async (toolName, _input, { signal }) => {
    const rec = { n: gateCalls.length + 1, turn: gateTurn, tool: toolName, aborted: [signal.aborted] };
    gateCalls.push(rec);
    log("gate", { ...rec });
    if (hang) {
      interruptOnGate?.();
      await new Promise<void>((r) => {
        if (signal.aborted) return r();
        signal.addEventListener("abort", () => r(), { once: true });
        setTimeout(r, 15_000);
      });
      rec.aborted.push(signal.aborted);
      log("gate_released", { n: rec.n, signalAborted: signal.aborted });
      return { behavior: "deny", message: "Turn was cancelled." };
    }
    return READ_TOOL.test(toolName)
      ? { behavior: "allow", updatedInput: _input }
      : { behavior: "deny", message: "spike: only GetLiveContext is allowed" };
  };

  const p = new Probe({}, gate);
  // Q1: before any user message.
  await timed("initializationResult (before first message)", async () => {
    const r = await p.q.initializationResult();
    return { models: r.models?.length, commands: r.commands?.some((c) => c.name === "compact") };
  });
  await timed("mcpServerStatus (before first message)", () => p.q.mcpServerStatus().then((s) => s.map((x) => `${x.name}:${x.status}`)));
  log("q1", { initSeenBeforeFirstMessage: p.initAtMs !== undefined, initAtMs: p.initAtMs, sinceQueryMs: Date.now() - p.started });
  await timed("supportedCommands", () => p.q.supportedCommands().then((c) => c.map((x) => x.name)));

  // Q2 + Q12: three plain turns.
  gateTurn = "plain";
  await p.turn("plain-1", "Merhaba, bugün nasılsın?");
  await p.turn("plain-2", "Bir renk söyle.");
  await p.turn("plain-3", "Bir meyve söyle.");

  // Q3: setModel between messages.
  await timed("setModel(sonnet)", () => p.q.setModel("sonnet"));
  await p.turn("after-setModel-sonnet", "Bir sayı söyle.");
  await timed("setModel(haiku)", () => p.q.setModel(MODEL));
  await timed("setModel(haiku) again (no change)", () => p.q.setModel(MODEL));
  await p.turn("after-setModel-haiku", "Bir hayvan söyle.");

  // Q7: shouldQuery:false.
  p.input.push(`Not: gizli kelime ${CODE_WORD}. Bunu sadece hatırla.`, { shouldQuery: false });
  await p.quiet("shouldQuery-false", 5000);
  await p.turn("ask-code-word", "Az önce sana verdiğim gizli kelime neydi? Sadece kelimeyi yaz.");

  // Q5a: interrupt during streaming text.
  let interruptedAt = 0;
  const textTurn = await p.turn("interrupt-text", "1'den 300'e kadar sayıları virgülle ayırarak yaz.", {
    onFirstDelta: () => {
      interruptedAt = Date.now();
      void timed("interrupt() during text", () => p.q.interrupt()).then(() =>
        log("q5a", { interruptToResolveMs: Date.now() - interruptedAt }),
      );
    },
  });
  log("q5a_result", { interruptToResultMs: interruptedAt && textTurn.resultAt ? textTurn.resultAt - interruptedAt : undefined });
  await p.turn("after-interrupt-text", "Tek kelime: tamam mı?");

  // Q5b + Q6: interrupt during a pending canUseTool.
  gateTurn = "tool-hang";
  hang = true;
  let interruptAt = 0;
  interruptOnGate = () => {
    setTimeout(() => {
      interruptAt = Date.now();
      void timed("interrupt() during canUseTool", () => p.q.interrupt());
    }, 500);
  };
  const hung = await p.turn("interrupt-gate", "GetLiveContext aracını çağır ve oturma odası ışığının durumunu söyle.");
  log("q5b", { interruptToResultMs: interruptAt && hung.resultAt ? hung.resultAt - interruptAt : undefined });
  hang = false;
  interruptOnGate = undefined;
  await p.turn("after-interrupt-gate", "Tek kelime: hazır mısın?");

  // Q6: the same callback serves a later turn; GetLiveContext is read-only.
  gateTurn = "tool-allowed";
  await p.turn("tool-allowed", "GetLiveContext aracını çağır ve oturma odası ışığının durumunu tek cümleyle söyle.");
  log("q6", { gateCalls });
  await timed("getContextUsage", () =>
    p.q.getContextUsage({ detail: "summary" } as never).then((u) => JSON.stringify(u).slice(0, 300)),
  );
  mainSessionId = p.sessionId;
  log("main_session", { sessionId: mainSessionId });
  const tClose = Date.now();
  await p.close();
  log("close", { ms: Date.now() - tClose, pumpError: p.pumpError });
}

/** Q8: resume a session written by a persistent query after close(). */
async function phaseResume(): Promise<void> {
  const id = mainSessionId ?? process.env.SPIKE_SESSION_ID;
  if (!id) return log("resume_skipped", { reason: "no session id" });
  const p = new Probe({ resume: id });
  const o = await p.turn("resume-ask-code-word", "Daha önce sana verdiğim gizli kelime neydi? Sadece kelimeyi yaz.");
  log("q8", { resumedFrom: id, newSessionIds: [...o.sessionIds], sameId: o.sessionIds.has(id), remembered: o.text.includes(CODE_WORD) });
  mainSessionId = p.sessionId ?? id;
  await p.close();
}

/** Q9: which `dir` finds the transcript. */
async function phaseGetInfo(): Promise<void> {
  const id = mainSessionId ?? process.env.SPIKE_SESSION_ID;
  if (!id) return log("getinfo_skipped", { reason: "no session id" });
  for (const [label, opts] of [
    ["dir=cwd", { dir: CWD }],
    ["no options", undefined],
    ["dir=other", { dir: tmpdir() }],
  ] as const) {
    const info = await timed(`getSessionInfo ${label}`, () =>
      getSessionInfo(id, opts).then((i) => (i ? { found: true, keys: Object.keys(i), cwd: i.cwd === CWD } : { found: false })),
    );
    void info;
  }
  await timed("getSessionInfo unknown id, dir=cwd", () =>
    getSessionInfo(crypto.randomUUID(), { dir: CWD }).then((i) => (i ? "found" : "undefined")),
  );
}

/** Q4: maxTurns per user message or per query (maxTurns 2, three plain messages). */
async function phaseMaxTurns(): Promise<void> {
  const p = new Probe({ maxTurns: 2, mcpServers: {} });
  for (let i = 1; i <= 3; i++) await p.turn(`maxTurns2-msg${i}`, `Sadece ${i} sayısını yaz.`);
  await p.close();
}

/** Q10: /compact in streaming mode on a ~30k-token session. */
async function phaseCompact(): Promise<void> {
  const p = new Probe({ mcpServers: {} });
  const line = "Bu satır yalnızca bağlamı doldurmak için yazılmış bir dolgu cümlesidir, bir şey yapma. ";
  const filler = Array.from({ length: 1400 }, (_, i) => `${i}. ${line}`).join("\n");
  await p.turn("compact-fill", `${filler}\n\nYukarıdaki metni okudun mu? Sadece "evet" yaz.`, { timeoutMs: 180_000 });
  await timed("getContextUsage before compact", () =>
    p.q.getContextUsage({ detail: "summary" } as never).then((u) => JSON.stringify(u).slice(0, 300)),
  );
  await p.turn("compact", "/compact", { timeoutMs: 300_000 });
  await timed("getContextUsage after compact", () =>
    p.q.getContextUsage({ detail: "summary" } as never).then((u) => JSON.stringify(u).slice(0, 300)),
  );
  await p.turn("after-compact", "Tek kelime: hazır mısın?");
  await p.close();
}

/** Q1 comparison: startup() then a first turn. */
async function phaseStartup(): Promise<void> {
  const t0 = Date.now();
  const warm = await startup({
    options: {
      model: MODEL,
      systemPrompt: { type: "custom", prompt: SYSTEM, snapshot: false },
      tools: [],
      disallowedTools: DENIED_BUILTIN_TOOLS,
      settingSources: [],
      strictMcpConfig: true,
      mcpServers: haServer(),
      canUseTool: async () => ({ behavior: "deny", message: "spike" }),
      includePartialMessages: true,
      cwd: CWD,
      env: subprocessEnv(process.env),
    },
  });
  log("startup_resolved", { ms: Date.now() - t0 });
  const t1 = Date.now();
  const q = warm.query("Merhaba, bugün nasılsın?");
  let first: number | undefined;
  for await (const msg of q) {
    if (msg.type === "stream_event" && first === undefined && msg.event.type === "content_block_delta") first = Date.now() - t1;
    if (msg.type === "result") {
      log("startup_turn", { firstDeltaMs: first, resultMs: Date.now() - t1, durationMs: msg.duration_ms });
      break;
    }
  }
  q.close();
}

/** Q11: HA SSE after an idle period. */
async function phaseIdle(): Promise<void> {
  const p = new Probe({}, async (name, input) =>
    READ_TOOL.test(name) ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "spike" },
  );
  await p.turn("idle-before", "Merhaba.");
  await timed("mcpServerStatus before idle", () => p.q.mcpServerStatus().then((s) => s.map((x) => `${x.name}:${x.status}`)));
  log("idle_wait", { minutes: IDLE_MIN });
  await sleep(IDLE_MIN * 60_000);
  await timed("mcpServerStatus after idle", () => p.q.mcpServerStatus().then((s) => s.map((x) => `${x.name}:${x.status}`)));
  await p.turn("idle-tool", "GetLiveContext aracını çağır ve oturma odası ışığının durumunu tek cümleyle söyle.");
  await p.close();
}

/** Per-message timeline of three plain turns (where does the time after the text go?). */
async function phaseTrace(): Promise<void> {
  const p = new Probe({ mcpServers: {} });
  await p.turn("trace-1", "Merhaba, bugün nasılsın?");
  await p.turn("trace-2", "Bir renk söyle.");
  await p.turn("trace-3", "Bir meyve söyle.");
  await p.close();
}

/** Q7 detail: what a `shouldQuery: false` message yields (it does produce a `result`). */
async function phaseNoQuery(): Promise<void> {
  const p = new Probe({ mcpServers: {} });
  const o = await p.turn("noquery", `Not: gizli kelime ${CODE_WORD}. Bunu sadece hatırla.`, {
    extra: { shouldQuery: false },
    timeoutMs: 15_000,
  });
  log("q7_noquery", { results: o.results, subtype: o.subtype, numTurns: o.numTurns, models: [...o.models], text: o.text });
  await p.turn("noquery-ask", "Az önce sana verdiğim gizli kelime neydi? Sadece kelimeyi yaz.");
  await p.close();
}

const PHASES: Record<string, () => Promise<void>> = {
  trace: phaseTrace,
  noquery: phaseNoQuery,
  main: phaseMain,
  resume: phaseResume,
  getinfo: phaseGetInfo,
  maxturns: phaseMaxTurns,
  compact: phaseCompact,
  startup: phaseStartup,
  idle: phaseIdle,
};

async function run(): Promise<void> {
  mkdirSync(CWD, { recursive: true });
  const names = process.argv.slice(2);
  log("spike_start", { model: MODEL, phases: names, cwdIsTemp: CWD.startsWith(tmpdir()) });
  for (const name of names) {
    const fn = PHASES[name];
    if (!fn) throw new Error(`unknown phase ${name}; known: ${Object.keys(PHASES).join(", ")}`);
    log("phase", { name });
    await fn();
  }
  log("spike_end");
}

run().then(
  () => process.exit(0),
  (err: Error) => {
    log("fatal", { message: err.message });
    process.exit(1);
  },
);
