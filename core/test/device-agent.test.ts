/** DeviceAgent tests with a fake streaming-input `Query` — no subprocess, no model call. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  USAGE_LIMIT_ERROR_PREFIXES,
  type CanUseTool,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeSdkProvider,
  DeviceAgent,
  DeviceAgentBusyError,
  DeviceAgentDeadError,
  RestartBackoff,
  USAGE_LIMIT_PREFIXES_FALLBACK,
  isUsageLimitText,
  resetsAtToMs,
  type AttemptRequest,
  type DeviceAgentOptions,
} from "../src/device-agent.js";

const msg = (m: unknown) => m as SDKMessage;
const tick = () => new Promise((r) => setImmediate(r));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Async channel feeding the fake query's output. */
class Channel {
  private items: SDKMessage[] = [];
  private waiter: ((v: IteratorResult<SDKMessage>) => void) | undefined;
  private failer: ((e: Error) => void) | undefined;
  private ended = false;
  private error: Error | undefined;
  push(m: SDKMessage): void {
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w({ value: m, done: false });
    } else this.items.push(m);
  }
  fail(e: Error): void {
    this.error = e;
    const f = this.failer;
    this.waiter = undefined;
    f?.(e);
  }
  end(): void {
    this.ended = true;
    const w = this.waiter;
    this.waiter = undefined;
    w?.({ value: undefined, done: true });
  }
  async *iterate(): AsyncGenerator<SDKMessage, void> {
    for (;;) {
      const m = this.items.shift();
      if (m) {
        yield m;
        continue;
      }
      if (this.error) throw this.error;
      if (this.ended) return;
      const r = await new Promise<IteratorResult<SDKMessage>>((resolve, reject) => {
        this.waiter = resolve;
        this.failer = reject;
      });
      if (r.done) return;
      yield r.value;
    }
  }
}

type Reply = (m: SDKUserMessage, f: FakeSdk) => void | Promise<void>;

class FakeSdk {
  readonly out = new Channel();
  readonly sent: SDKUserMessage[] = [];
  readonly setModelCalls: string[] = [];
  interrupts = 0;
  closed = false;
  options: Options | undefined;
  buildArgs: Parameters<DeviceAgentOptions["buildOptions"]>[0] | undefined;
  queries = 0;
  total = 0;
  sid = "sess-1";
  reply: Reply = (m, f) => f.answer(m, "Tamam.");
  onInterrupt: (f: FakeSdk) => void = (f) => f.result({ subtype: "error_during_execution", is_error: true, errors: ["[ede_diagnostic] interrupted"] });
  mcpStatus: { name: string; status: string }[] = [{ name: "home-assistant", status: "connected" }];
  reconnects: string[] = [];

  queryFn = ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Query => {
    this.queries++;
    this.options = options;
    void (async () => {
      for await (const m of prompt) {
        this.sent.push(m);
        await this.reply(m, this);
      }
    })();
    const gen = this.out.iterate();
    return Object.assign(gen, {
      interrupt: async () => {
        this.interrupts++;
        this.onInterrupt(this);
        return undefined;
      },
      setModel: async (model?: string) => {
        this.setModelCalls.push(model ?? "");
      },
      close: () => {
        this.closed = true;
        this.out.end();
      },
      initializationResult: async () => ({}),
      mcpServerStatus: async () => this.mcpStatus,
      reconnectMcpServer: async (name: string) => {
        this.reconnects.push(name);
      },
    }) as unknown as Query;
  };

  push(m: unknown): void {
    this.out.push(msg({ session_id: this.sid, ...(m as object) }));
  }
  delta(text: string): void {
    this.push({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
  }
  stop(reason: string): void {
    this.push({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_delta", delta: { stop_reason: reason }, usage: {} } });
    this.push({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_stop" } });
  }
  assistant(content: unknown[], extra: Record<string, unknown> = {}, model = "claude-haiku-test"): void {
    this.push({ type: "assistant", parent_tool_use_id: null, message: { model, content }, ...extra });
  }
  result(r: Record<string, unknown> = {}, cost = 0): void {
    this.total += cost;
    this.push({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "",
      duration_ms: 10,
      total_cost_usd: this.total,
      usage: { input_tokens: 5, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      ...r,
    });
  }
  /** A full answer: deltas, end_turn stop, assistant message, then the result. */
  answer(m: SDKUserMessage, text: string, cost = 0.01, model = "claude-haiku-test"): void {
    if (m.shouldQuery === false) {
      this.result({ num_turns: 0 });
      return;
    }
    this.push({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: {} } });
    this.delta(text);
    this.assistant([{ type: "text", text }], {}, model);
    this.stop("end_turn");
    this.result({ result: text }, cost);
  }
}

const allow: CanUseTool = async (_n, input) => ({ behavior: "allow", updatedInput: input });

function makeAgent(f: FakeSdk, o: Partial<DeviceAgentOptions> = {}): DeviceAgent {
  return new DeviceAgent({
    device: "test",
    model: "haiku",
    buildOptions: (p) => {
      f.buildArgs = p;
      return { model: p.model, canUseTool: p.canUseTool, ...(p.resume ? { resume: p.resume } : {}) };
    },
    queryFn: f.queryFn,
    idleMs: 0,
    ...o,
  });
}

function attempt(text: string, o: Partial<AttemptRequest> & { deltas?: string[] } = {}): AttemptRequest {
  const deltas = o.deltas ?? [];
  return { text, model: "haiku", canUseTool: allow, callbacks: { onDelta: (t) => deltas.push(t) }, ...o };
}

test("two sequential attempts share one query; cost is the diff of the cumulative total", async () => {
  const f = new FakeSdk();
  const ids: string[] = [];
  const agent = makeAgent(f, { onSessionId: (id) => ids.push(id) });
  await agent.ready();
  const d1: string[] = [];
  const r1 = await agent.runAttempt(attempt("bir", { deltas: d1 })).settled;
  const r2 = await agent.runAttempt(attempt("iki")).settled;
  assert.equal(f.queries, 1);
  assert.deepEqual(f.sent.map((m) => m.message.content), ["bir", "iki"]);
  assert.notEqual(f.sent[0]?.uuid, f.sent[1]?.uuid, "fresh uuid per message");
  assert.equal(r1.status, "ok");
  assert.equal(r1.text, "Tamam.");
  assert.deepEqual(d1, ["Tamam."]);
  assert.equal(r1.warm, true);
  assert.equal(r1.costUsd, 0.01);
  assert.ok(Math.abs((r2.costUsd ?? 0) - 0.01) < 1e-9);
  assert.equal(r2.inputTokens, 5);
  assert.equal(r1.sessionId, "sess-1");
  assert.deepEqual(ids, ["sess-1"]);
  assert.equal(agent.sessionId, "sess-1");
  agent.close();
});

test("resume: passed to the options; first costUsd omitted (no baseline), later ones diffed", async () => {
  const f = new FakeSdk();
  f.total = 1.5; // a resumed session starts from the saved total
  const agent = makeAgent(f, { resume: "old-sess" });
  assert.equal(f.buildArgs?.resume, "old-sess");
  assert.equal(f.options?.resume, "old-sess");
  assert.equal(agent.sessionId, "old-sess");
  const r1 = await agent.runAttempt(attempt("bir")).settled;
  const r2 = await agent.runAttempt(attempt("iki")).settled;
  assert.equal(r1.costUsd, undefined);
  assert.ok(Math.abs((r2.costUsd ?? 0) - 0.01) < 1e-9);
  agent.close();
});

test("model switch: setModel only on change; turn model read from assistant messages", async () => {
  const f = new FakeSdk();
  f.reply = (m, ff) => ff.answer(m, "ok", 0.01, ff.setModelCalls.at(-1) === "sonnet" ? "claude-sonnet-test" : "claude-haiku-test");
  const agent = makeAgent(f);
  const a = await agent.runAttempt(attempt("1")).settled;
  const b = await agent.runAttempt(attempt("2", { model: "sonnet" })).settled;
  const c = await agent.runAttempt(attempt("3", { model: "sonnet" })).settled;
  assert.deepEqual(f.setModelCalls, ["sonnet"]);
  assert.equal(agent.model, "sonnet");
  assert.equal(a.model, "claude-haiku-test");
  assert.equal(b.model, "claude-sonnet-test");
  assert.equal(c.model, "claude-sonnet-test");
  agent.close();
});

test("visible end at message_stop/end_turn before result; next attempt queues until result; busy before visible end", async () => {
  const f = new FakeSdk();
  let releaseResult!: () => void;
  f.reply = async (m, ff) => {
    if (ff.sent.length === 1) {
      ff.delta("Merhaba.");
      ff.stop("end_turn");
      await new Promise<void>((r) => (releaseResult = r)); // classifier tail
      ff.result({ result: "Merhaba." }, 0.02);
    } else ff.answer(m, "İkinci.");
  };
  const agent = makeAgent(f);
  const h1 = agent.runAttempt(attempt("bir"));
  assert.throws(() => agent.runAttempt(attempt("x")), DeviceAgentBusyError);
  const done1 = await h1.done;
  assert.equal(done1.status, "ok");
  assert.equal(done1.text, "Merhaba.");
  assert.equal(done1.costUsd, undefined, "usage not known yet");
  let settled = false;
  void h1.settled.then(() => (settled = true));
  const h2 = agent.runAttempt(attempt("iki")); // accepted after the visible end
  await tick();
  assert.equal(f.sent.length, 1, "second message waits for the first result");
  assert.equal(settled, false);
  releaseResult();
  const s1 = await h1.settled;
  assert.equal(s1.costUsd, 0.02);
  assert.equal(s1.status, "ok");
  assert.equal((await h2.done).text, "İkinci.");
  assert.equal(f.sent.length, 2);
  agent.close();
});

test("a tool_use stop does not end the turn visibly", async () => {
  const f = new FakeSdk();
  f.reply = (_m, ff) => {
    ff.assistant([{ type: "tool_use", id: "t1", name: "mcp__ha__Get", input: {} }]);
    ff.stop("tool_use");
    ff.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } });
    ff.delta("Işık açık.");
    ff.stop("end_turn");
    ff.result({ result: "Işık açık." });
  };
  const tools: string[] = [];
  const agent = makeAgent(f);
  const r = await agent.runAttempt(attempt("ışık?", { callbacks: { onDelta: () => {}, onToolUse: (_id, n) => tools.push(n) } })).done;
  assert.equal(r.text, "Işık açık.");
  assert.deepEqual(r.tools, ["mcp__ha__Get"]);
  assert.deepEqual(tools, ["mcp__ha__Get"]);
  agent.close();
});

test("interrupt: error_during_execution → cancelled; the next attempt works on the same query", async () => {
  const f = new FakeSdk();
  f.reply = (m, ff) => {
    if (ff.sent.length === 1) ff.delta("Uzun bir cev");
    else ff.answer(m, "Yeni.");
  };
  const agent = makeAgent(f);
  const h = agent.runAttempt(attempt("uzun"));
  await tick();
  await agent.interrupt();
  const r = await h.settled;
  assert.equal(r.status, "cancelled");
  assert.equal(r.error, undefined);
  assert.equal(r.text, "Uzun bir cev", "partial text kept");
  assert.equal(f.interrupts, 1);
  const r2 = await agent.runAttempt(attempt("sonra")).done;
  assert.equal(r2.status, "ok");
  assert.equal(f.queries, 1);
  agent.close();
});

test("the request signal interrupts; an attempt aborted while queued is never sent", async () => {
  const f = new FakeSdk();
  let release!: () => void;
  f.reply = async (m, ff) => {
    if (ff.sent.length === 1) {
      ff.delta("A.");
      ff.stop("end_turn");
      await new Promise<void>((r) => (release = r));
      ff.result();
    } else if (ff.sent.length === 2) ff.delta("B");
    else ff.answer(m, "C.");
  };
  const agent = makeAgent(f);
  const h1 = agent.runAttempt(attempt("1"));
  await h1.done;
  const queuedCtl = new AbortController();
  const h2 = agent.runAttempt(attempt("2", { signal: queuedCtl.signal }));
  queuedCtl.abort();
  assert.equal((await h2.done).status, "cancelled");
  release();
  await h1.settled;
  const ctl = new AbortController();
  const h3 = agent.runAttempt(attempt("3", { signal: ctl.signal }));
  await tick();
  await tick();
  assert.deepEqual(f.sent.map((m) => m.message.content), ["1", "3"], "the cancelled queued attempt was not sent");
  ctl.abort();
  assert.equal((await h3.settled).status, "cancelled");
  agent.close();
});

test("gate dispatcher: no attempt → deny; a call that outlives its attempt's cancel → deny", async () => {
  const f = new FakeSdk();
  let resolveGate!: () => void;
  const gateCalls: string[] = [];
  const slowGate: CanUseTool = async (name, input) => {
    gateCalls.push(name);
    await new Promise<void>((r) => (resolveGate = r)); // e.g. a 60 s confirmation
    return { behavior: "allow", updatedInput: input };
  };
  f.reply = () => {};
  const agent = makeAgent(f);
  const dispatch = f.options?.canUseTool as CanUseTool;
  const opts = { signal: new AbortController().signal, toolUseID: "t1" } as Parameters<CanUseTool>[2];
  const idle = await dispatch("mcp__ha__Turn", {}, opts);
  assert.equal(idle?.behavior, "deny");
  assert.equal(gateCalls.length, 0, "the session gate is not asked without an attempt");

  const h = agent.runAttempt(attempt("aç", { canUseTool: slowGate }));
  await tick();
  const pending = dispatch("mcp__ha__Turn", {}, opts);
  await tick();
  assert.deepEqual(gateCalls, ["mcp__ha__Turn"]);
  await agent.interrupt();
  resolveGate();
  const r = await pending;
  assert.equal(r?.behavior, "deny");
  assert.equal((await h.settled).status, "cancelled");
  agent.close();
});

test("usage limit: rejected rate_limit_event + assistant rate_limit → usage_limit with retryAt; text not emitted", async () => {
  const f = new FakeSdk();
  const limitText = "You've hit your limit · resets 5pm";
  f.reply = (_m, ff) => {
    ff.push({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_767_340_800 } });
    ff.assistant([{ type: "text", text: limitText }], { error: "rate_limit" });
    ff.result({ result: limitText, is_error: true });
  };
  const deltas: string[] = [];
  const agent = makeAgent(f);
  const r = await agent.runAttempt(attempt("selam", { deltas })).settled;
  assert.equal(r.status, "usage_limit");
  assert.equal(r.retryAt, 1_767_340_800_000);
  assert.deepEqual(deltas, []);
  agent.close();
});

test("usage limit from the result error text alone; other errors stay errors", async () => {
  const f = new FakeSdk();
  f.reply = (_m, ff) => {
    if (ff.sent.length === 1) ff.result({ subtype: "error_during_execution", is_error: true, errors: ["You've reached your usage limit"] });
    else ff.result({ subtype: "error_max_turns", is_error: true, errors: ["too many"] });
  };
  const agent = makeAgent(f);
  const a = await agent.runAttempt(attempt("1")).settled;
  assert.equal(a.status, "usage_limit");
  assert.equal(a.retryAt, undefined);
  const b = await agent.runAttempt(attempt("2")).settled;
  assert.equal(b.status, "error");
  assert.match(b.error ?? "", /error_max_turns/);
  agent.close();
});

test("usage-limit prefixes: fallback copy matches the SDK export; helpers", () => {
  assert.deepEqual([...USAGE_LIMIT_PREFIXES_FALLBACK], [...USAGE_LIMIT_ERROR_PREFIXES], "SDK list changed: update the fallback copy");
  assert.equal(isUsageLimitText("  You've hit your limit"), true);
  assert.equal(isUsageLimitText("Merhaba"), false);
  assert.equal(resetsAtToMs(1_767_340_800), 1_767_340_800_000);
  assert.equal(resetsAtToMs(1_767_340_800_000), 1_767_340_800_000);
  assert.equal(resetsAtToMs(undefined), undefined);
});

test("process death mid-attempt: dead outcome with partial text; replacement resumes; restart backoff", async () => {
  const f = new FakeSdk();
  f.sid = "sess-dead";
  f.reply = (_m, ff) => {
    ff.delta("Yarım");
    setTimeout(() => ff.out.fail(new Error("process exited with code 1")), 5);
  };
  const deaths: string[] = [];
  const agent = makeAgent(f, { onDead: (r) => deaths.push(r) });
  const r = await agent.runAttempt(attempt("x")).settled;
  assert.equal(r.status, "dead");
  assert.equal(r.text, "Yarım");
  assert.match(r.error ?? "", /process exited/);
  assert.equal(agent.isDead, true);
  assert.equal(deaths.length, 1);
  assert.throws(() => agent.runAttempt(attempt("y")), DeviceAgentDeadError);
  assert.equal(await agent.appendNote("not"), false);

  // The owner starts a replacement with resume = the last session id.
  const f2 = new FakeSdk();
  f2.sid = "sess-dead";
  const replacement = makeAgent(f2, { resume: agent.sessionId });
  assert.equal(f2.options?.resume, "sess-dead");
  assert.equal((await replacement.runAttempt(attempt("tekrar")).done).status, "ok");
  replacement.close();

  let now = 0;
  const backoff = new RestartBackoff({ now: () => now });
  assert.equal(backoff.canStart(), true);
  backoff.recordDeath();
  assert.equal(backoff.canStart(), true, "one death: restart at once");
  now = 60_000;
  backoff.recordDeath();
  assert.equal(backoff.canStart(), false, "two deaths within 5 min: back off");
  now = 60_000 + 30_000;
  assert.equal(backoff.canStart(), true);
  now = 60_000 + 6 * 60_000;
  backoff.recordDeath();
  assert.equal(backoff.canStart(), true, "older deaths fall out of the window");
});

test("pump end outside close() marks the agent dead; close() does not", async () => {
  const f = new FakeSdk();
  const deaths: string[] = [];
  const agent = makeAgent(f, { onDead: (r) => deaths.push(r) });
  f.out.end();
  await tick();
  assert.equal(agent.isDead, true);
  assert.deepEqual(deaths, ["query ended"]);

  const g = new FakeSdk();
  const closedAgent = makeAgent(g, { onDead: (r) => deaths.push(r) });
  closedAgent.close();
  await tick();
  assert.equal(g.closed, true);
  assert.equal(closedAgent.isDead, false);
  assert.equal(deaths.length, 1);
});

test("idle close: after idleMs without work; not while an attempt runs", async () => {
  const f = new FakeSdk();
  let release!: () => void;
  f.reply = async (m, ff) => {
    await new Promise<void>((r) => (release = r));
    ff.answer(m, "geç");
  };
  let idle = 0;
  const agent = makeAgent(f, { idleMs: 30, onIdleClose: () => idle++ });
  const h = agent.runAttempt(attempt("bekle"));
  await sleep(60);
  assert.equal(idle, 0, "no idle close during an attempt");
  release();
  await h.settled;
  await sleep(60);
  assert.equal(idle, 1);
  assert.equal(f.closed, true);
  assert.equal(agent.isClosed, true);
  assert.throws(() => agent.runAttempt(attempt("x")), DeviceAgentDeadError);
});

test("tool-call cap: past maxToolCalls the attempt is interrupted → tool_cap", async () => {
  const f = new FakeSdk();
  f.reply = (_m, ff) => {
    for (let i = 0; i < 3; i++) ff.assistant([{ type: "tool_use", id: `t${i}`, name: "mcp__ha__Get", input: {} }]);
  };
  const agent = makeAgent(f, { maxToolCalls: 2 });
  const r = await agent.runAttempt(attempt("döngü")).settled;
  assert.equal(r.status, "tool_cap");
  assert.match(r.error ?? "", /tool call limit/);
  assert.equal(f.interrupts, 1);
  agent.close();
});

test("turn timeout: interrupt → timeout; watchdog closes the agent when no result follows", async () => {
  const f = new FakeSdk();
  f.reply = () => {};
  const agent = makeAgent(f, { turnTimeoutMs: 20 });
  const r = await agent.runAttempt(attempt("sessiz")).settled;
  assert.equal(r.status, "timeout");
  assert.equal(r.error, "turn timeout");
  assert.equal(agent.isDead, false);
  agent.close();

  const g = new FakeSdk();
  g.reply = () => {};
  g.onInterrupt = () => {}; // no result after interrupt
  const deaths: string[] = [];
  const stuck = makeAgent(g, { interruptWatchdogMs: 20, onDead: (x) => deaths.push(x) });
  const h = stuck.runAttempt(attempt("takıldı"));
  await tick();
  await stuck.interrupt();
  const s = await h.settled;
  assert.equal(s.status, "dead");
  assert.equal(stuck.isDead, true);
  assert.deepEqual(deaths, ["no result after interrupt"]);
});

test("shouldQuery:false note: its own result is not taken as the next attempt's end", async () => {
  const f = new FakeSdk();
  let releaseNote!: () => void;
  f.reply = async (m, ff) => {
    if (m.shouldQuery === false) {
      await new Promise<void>((r) => (releaseNote = r));
      ff.result({ num_turns: 0 });
    } else ff.answer(m, "Cevap.");
  };
  const agent = makeAgent(f);
  const note = agent.appendNote("(Bilgi: …) Kullanıcı: ışığı aç / Shadow: Açtım.");
  const h = agent.runAttempt(attempt("soru"));
  await tick();
  assert.equal(f.sent.length, 1, "attempt waits for the note's result");
  assert.equal(f.sent[0]?.shouldQuery, false);
  releaseNote();
  assert.equal(await note, true);
  const r = await h.settled;
  assert.equal(r.text, "Cevap.");
  assert.equal(r.costUsd, 0.01, "the note's result did not consume the attempt's cost");
  assert.equal(f.sent[1]?.shouldQuery, undefined);
  agent.close();
});

test("stray messages with nothing in flight are ignored", async () => {
  const f = new FakeSdk();
  const agent = makeAgent(f);
  f.push({ type: "user", parent_tool_use_id: null, message: { role: "user", content: "echo" } });
  f.result();
  await tick();
  const r = await agent.runAttempt(attempt("bir")).settled;
  assert.equal(r.text, "Tamam.");
  assert.equal(r.status, "ok");
  agent.close();
});

test("MCP freshness: status checked after a long gap; reconnect when not connected", async () => {
  const f = new FakeSdk();
  let now = 1_000;
  const agent = makeAgent(f, { now: () => now, mcpFreshness: { servers: ["home-assistant"] } });
  await agent.runAttempt(attempt("1")).settled;
  assert.deepEqual(f.reconnects, []);
  f.mcpStatus = [{ name: "home-assistant", status: "failed" }];
  now += 60_000;
  await agent.runAttempt(attempt("2")).settled;
  assert.deepEqual(f.reconnects, [], "within 5 min: no check");
  now += 6 * 60_000;
  await agent.runAttempt(attempt("3")).settled;
  assert.deepEqual(f.reconnects, ["home-assistant"]);
  agent.close();
});

test("close() during an attempt resolves it as cancelled", async () => {
  const f = new FakeSdk();
  f.reply = () => {};
  const agent = makeAgent(f);
  const h = agent.runAttempt(attempt("x"));
  await tick();
  agent.close();
  assert.equal((await h.settled).status, "cancelled");
  assert.equal(f.closed, true);
});

// --- review fixes (S4 follow-up) ----------------------------------------------

test("usage-limit text streamed as deltas with end_turn: nothing forwarded, done and settled are usage_limit", async () => {
  const f = new FakeSdk();
  const limitText = "You've hit your limit · resets 5pm";
  f.reply = (_m, ff) => {
    ff.push({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: {} } });
    ff.delta("You'");
    ff.delta("ve hit your limit");
    ff.delta(" · resets 5pm");
    ff.assistant([{ type: "text", text: limitText }]);
    ff.stop("end_turn");
    ff.result({ result: limitText });
  };
  const deltas: string[] = [];
  const agent = makeAgent(f);
  const h = agent.runAttempt(attempt("selam", { deltas }));
  const done = await h.done;
  const settled = await h.settled;
  assert.equal(done.status, "usage_limit");
  assert.equal(settled.status, "usage_limit");
  assert.deepEqual(deltas, []);
  agent.close();
});

test("limit gate: a normal answer is forwarded once it diverges; an ambiguous short answer is flushed at the end", async () => {
  const f = new FakeSdk();
  f.reply = (m, ff) => {
    if (ff.sent.length === 1) {
      ff.delta("Y");
      ff.delta("arın yağmur var.");
      ff.stop("end_turn");
      ff.result({ result: "Yarın yağmur var." }, 0.01);
    } else ff.answer(m, "You");
  };
  const d1: string[] = [];
  const agent = makeAgent(f);
  const r1 = await agent.runAttempt(attempt("hava?", { deltas: d1 })).done;
  assert.equal(r1.status, "ok");
  assert.equal(d1.join(""), "Yarın yağmur var.");
  const d2: string[] = [];
  const r2 = await agent.runAttempt(attempt("x", { deltas: d2 })).done;
  assert.equal(r2.status, "ok");
  assert.deepEqual(d2, ["You"]);
  agent.close();
});

test("usage limit in the result after a visible end: settled reports usage_limit", async () => {
  const f = new FakeSdk();
  f.reply = (_m, ff) => {
    ff.delta("Tamam.");
    ff.stop("end_turn");
    ff.result({ subtype: "error_during_execution", is_error: true, errors: ["You've reached your usage limit"] });
  };
  const agent = makeAgent(f);
  const h = agent.runAttempt(attempt("x"));
  assert.equal((await h.done).status, "ok");
  assert.equal((await h.settled).status, "usage_limit");
  agent.close();
});

test("setModel that never answers: agent dies after setModelTimeoutMs and every attempt resolves", async () => {
  const f = new FakeSdk();
  const deaths: string[] = [];
  const agent = makeAgent(f, { setModelTimeoutMs: 30, onDead: (r) => deaths.push(r) });
  // Replace the fake's setModel with one that hangs.
  (agent as unknown as { q: { setModel: () => Promise<void> } }).q.setModel = () => new Promise<void>(() => {});
  const h = agent.runAttempt(attempt("x", { model: "sonnet" }));
  const r = await h.settled;
  assert.equal(r.status, "dead");
  assert.equal((await h.done).status, "dead");
  assert.match(deaths[0] ?? "", /setModel/);
  assert.equal(f.sent.length, 0, "the attempt never reached the model");
  await assert.rejects(agent.setModel("opus"), DeviceAgentDeadError);
});

test("public setModel: queued, switches once, no-op when unchanged", async () => {
  const f = new FakeSdk();
  const agent = makeAgent(f);
  await agent.setModel("haiku");
  await agent.setModel("sonnet");
  assert.deepEqual(f.setModelCalls, ["sonnet"]);
  assert.equal(agent.model, "sonnet");
  assert.equal(agent.provider, "claude-sdk");
  agent.close();
});

test("throwing callbacks: done and settled still resolve (streamed deltas, fallback text, tool events)", async () => {
  const f = new FakeSdk();
  f.reply = (m, ff) => {
    if (ff.sent.length === 1) ff.answer(m, "Tamam.");
    else if (ff.sent.length === 2) ff.result({ result: "Sadece sonuç." });
    else {
      ff.assistant([{ type: "tool_use", id: "t1", name: "mcp__ha__Get", input: {} }]);
      ff.answer(m, "Bitti.");
    }
  };
  const logs: string[] = [];
  const agent = makeAgent(f, { log: (e) => logs.push(e) });
  const boom = () => {
    throw new Error("socket gone");
  };
  const h1 = agent.runAttempt(attempt("1", { callbacks: { onDelta: boom } }));
  assert.equal((await h1.done).status, "ok");
  assert.equal((await h1.settled).text, "Tamam.");
  const h2 = agent.runAttempt(attempt("2", { callbacks: { onDelta: boom } }));
  const r2 = await h2.settled;
  assert.equal(r2.status, "ok");
  assert.equal(r2.text, "Sadece sonuç.");
  const h3 = agent.runAttempt(attempt("3", { callbacks: { onDelta: () => {}, onToolUse: boom } }));
  assert.equal((await h3.settled).status, "ok");
  assert.equal(agent.isDead, false);
  assert.ok(logs.includes("callback_failed"));
  agent.close();
});

test("cost: a zeroed error result does not lower the baseline; a real counter reset is diffed from its low point", async () => {
  const f = new FakeSdk();
  const totals = [0.05, 0, 0.07, 0.01, 0.02];
  let i = 0;
  f.reply = (_m, ff) => {
    const total = totals[i++] ?? 0;
    ff.push({
      type: "result",
      subtype: total === 0 ? "error_during_execution" : "success",
      is_error: total === 0,
      result: "ok",
      errors: ["crash"],
      duration_ms: 1,
      total_cost_usd: total,
      usage: { input_tokens: 0, output_tokens: 0 },
    });
  };
  const agent = makeAgent(f);
  const costs: (number | undefined)[] = [];
  for (let n = 0; n < totals.length; n++) costs.push((await agent.runAttempt(attempt(String(n))).settled).costUsd);
  const round = (c: number | undefined) => (c === undefined ? c : Math.round(c * 1000) / 1000);
  // 0.05 → 0.05; zeroed → none; 0.07 → 0.02 (not 0.07); 0.01 below the baseline → none (low point);
  // 0.02 again below the baseline but above the low point → a genuine reset, 0.01.
  assert.deepEqual(costs.map(round), [0.05, undefined, 0.02, undefined, 0.01]);
  agent.close();
});

test("ClaudeSdkProvider: openSession builds a DeviceAgent; oneShot returns text, structured output, limit and cancel", async () => {
  const f = new FakeSdk();
  const oneShotArgs: { maxTokens: number }[] = [];
  const results: Record<string, unknown>[] = [
    { result: "", structured_output: { ops: [] }, total_cost_usd: 0.002 },
    { subtype: "error_during_execution", is_error: true, errors: ["You've hit your limit"] },
  ];
  let call = 0;
  const oneShotQuery = ({ prompt }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }): Query => {
    const r = results[call++] ?? {};
    async function* gen(): AsyncGenerator<SDKMessage, void> {
      for await (const m of prompt) {
        assert.equal(m.message.content, "özetle");
        yield msg({ type: "assistant", parent_tool_use_id: null, message: { model: "claude-haiku-x", content: [{ type: "text", text: "{}" }] } });
        yield msg({ type: "result", subtype: "success", is_error: false, duration_ms: 1, usage: { input_tokens: 4, output_tokens: 2 }, ...r });
        return;
      }
    }
    return Object.assign(gen(), { close: () => {} }) as unknown as Query;
  };
  let mode: "session" | "oneshot" = "session";
  const provider = new ClaudeSdkProvider({
    queryFn: (a) => (mode === "session" ? f.queryFn(a) : oneShotQuery(a)),
    buildOptions: (p) => ({ model: p.model, canUseTool: p.canUseTool }),
    buildOneShotOptions: (p) => {
      oneShotArgs.push(p);
      return { model: p.model };
    },
    session: { idleMs: 0 },
  });
  assert.equal(provider.id, "claude-sdk");
  const s = provider.openSession({ device: "d1", model: "haiku" });
  assert.ok(s instanceof DeviceAgent);
  assert.equal((await s.runAttempt(attempt("x")).settled).status, "ok");
  s.close();

  mode = "oneshot";
  const ok = await provider.oneShot({ model: "haiku", prompt: "özetle", schema: { type: "object" }, maxTokens: 500 });
  assert.equal(ok.status, "ok");
  assert.deepEqual(ok.json, { ops: [] });
  assert.equal(ok.text, "{}");
  assert.equal(ok.model, "claude-haiku-x");
  assert.equal(ok.inputTokens, 4);
  assert.equal(ok.costUsd, 0.002);
  assert.equal(oneShotArgs[0]?.maxTokens, 500);
  const lim = await provider.oneShot({ model: "haiku", prompt: "özetle", maxTokens: 100 });
  assert.equal(lim.status, "usage_limit");
  const ac = new AbortController();
  ac.abort();
  assert.equal((await provider.oneShot({ model: "haiku", prompt: "özetle", maxTokens: 100, signal: ac.signal })).status, "cancelled");
});
