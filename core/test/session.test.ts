/**
 * Session flow tests. The Agent SDK, Home Assistant, whisper-svc and tts-svc
 * are all mocked: the mock agent calls the permission gate exactly like the
 * SDK would (`canUseTool(name, input, { signal, toolUseID })`).
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRunner, TurnCallbacks, TurnRequest, TurnResult } from "../src/agent.js";
import { ConversationLog } from "../src/conversation-log.js";
import { PermissionPolicy } from "../src/permissions.js";
import type { ClientFrame, ServerFrame } from "../src/protocol.js";
import type { UsageRecord } from "../src/router.js";
import { parseServices } from "../src/services.js";
import { Session } from "../src/session.js";
import { SpeechServiceError, type SttClient, type TtsClient } from "../src/speech.js";

const base = mkdtempSync(join(tmpdir(), "shadow-session-test-"));
const open: Session[] = [];
after(async () => {
  // Flush every session's log before the temp dir is removed.
  await Promise.all(open.map((s) => s.close("test_end")));
  rmSync(base, { recursive: true, force: true });
});

const HA = "mcp__home-assistant__";
const services = parseServices(
  [
    "services:",
    "  - name: home-assistant",
    "    kind: mcp",
    "    url: http://localhost:1/sse",
    "    permission: confirm",
    "    tools:",
    '      "homeassistant__GetLiveContext": read',
    '      "intent__HassTurnOn": write',
    '      "lock__*": confirm',
  ].join("\n"),
  {},
).services;

type Script = (req: TurnRequest, cb: TurnCallbacks) => Promise<Partial<TurnResult> | void>;

class MockAgent implements AgentRunner {
  calls: TurnRequest[] = [];
  constructor(private script: Script) {}
  async runTurn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult> {
    this.calls.push(req);
    const r = (await this.script(req, cb)) ?? {};
    return { text: "", inputTokens: 3, outputTokens: 2, durationMs: 7, sessionId: "sdk-1", ...r };
  }
}

/** Calls the gate like the SDK does. */
function useTool(req: TurnRequest, name: string, input: Record<string, unknown> = {}): Promise<PermissionResult> {
  return Promise.resolve(
    req.canUseTool(name, input, { signal: req.signal, toolUseID: `tu-${name}` } as Parameters<
      TurnRequest["canUseTool"]
    >[2]),
  ) as Promise<PermissionResult>;
}

interface Harness {
  session: Session;
  frames: ServerFrame[];
  agent: MockAgent;
  usage: UsageRecord[];
  log: ConversationLog;
  send(f: ClientFrame): Promise<void>;
  waitFor(pred: (f: ServerFrame) => boolean, ms?: number): Promise<ServerFrame>;
  of<T extends ServerFrame["type"]>(type: T): Extract<ServerFrame, { type: T }>[];
}

let counter = 0;
function harness(
  script: Script,
  opts: { readOnly?: boolean; stt?: SttClient; tts?: TtsClient; confirmTimeoutMs?: number } = {},
): Harness {
  const frames: ServerFrame[] = [];
  const waiters: Array<() => void> = [];
  const agent = new MockAgent(script);
  const usage: UsageRecord[] = [];
  const log = new ConversationLog(join(base, `data-${++counter}`));
  const session = new Session(
    {
      agent,
      policy: new PermissionPolicy(services, { readOnly: opts.readOnly }),
      router: { route: () => ({ model: "test-model" }), onUsage: (u) => usage.push(u) },
      stt: opts.stt ?? { transcribe: async () => ({ text: "" }) },
      tts: opts.tts ?? { synthesize: async () => ({ mime: "audio/wav", data: Buffer.from("RIFF") }) },
      log,
      logger: { info: () => {}, warn: () => {} },
      confirmTimeoutMs: opts.confirmTimeoutMs ?? 5_000,
    },
    { sessionId: `s${counter}`, device: "browser" },
    (f) => {
      frames.push(f);
      waiters.splice(0).forEach((w) => w());
    },
  );
  open.push(session);
  return {
    session,
    frames,
    agent,
    usage,
    log,
    send: (f) => session.handle(f),
    waitFor: (pred, ms = 2000) =>
      new Promise((res, rej) => {
        const check = () => {
          const f = frames.find(pred);
          if (f) res(f);
          else waiters.push(check);
        };
        setTimeout(() => rej(new Error("timeout waiting for frame")), ms).unref();
        check();
      }),
    of: (type) => frames.filter((f) => f.type === type) as never,
  };
}

const sessionLines = (h: Harness) => {
  const root = join(h.log.dataDir, "conversations");
  const day = readdirSync(root)[0] as string;
  const file = readdirSync(join(root, day))[0] as string;
  return readFileSync(join(root, day, file), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
};

test("text turn streams deltas, done, state idle; usage recorded", async () => {
  const h = harness(async (_req, cb) => {
    cb.onDelta("Mer");
    cb.onDelta("haba");
    return { text: "Merhaba" };
  });
  await h.send({ type: "user_text", id: "t1", text: "selam" });
  assert.deepEqual(
    h.frames.map((f) => f.type),
    ["state", "assistant_delta", "assistant_delta", "assistant_done", "state"],
  );
  assert.deepEqual(h.of("assistant_done")[0], { type: "assistant_done", id: "t1", text: "Merhaba" });
  assert.equal(h.of("state")[0]?.state, "thinking");
  assert.equal(h.of("state")[1]?.state, "idle");
  assert.equal(h.agent.calls[0]?.model, "test-model");
  assert.deepEqual(h.usage[0], { turnId: "t1", model: "test-model", inputTokens: 3, outputTokens: 2, durationMs: 7, costUsd: undefined });

  // Second turn resumes the SDK session for conversation context.
  await h.send({ type: "user_text", id: "t2", text: "tekrar" });
  assert.equal(h.agent.calls[1]?.resume, "sdk-1");
  await h.session.close("test");
  const kinds = sessionLines(h).map((l) => l.kind);
  assert.deepEqual(kinds.slice(0, 4), ["session_start", "user", "assistant", "usage"]);
  assert.equal(kinds.at(-1), "session_end");
});

test("read tool is allowed; write allowed and recorded; builtin denied", async () => {
  const results: PermissionResult[] = [];
  const h = harness(async (req, cb) => {
    results.push(await useTool(req, `${HA}homeassistant__GetLiveContext`));
    cb.onToolResult?.("tu", `${HA}homeassistant__GetLiveContext`, false);
    results.push(await useTool(req, `${HA}intent__HassTurnOn`, { name: "lamba" }));
    results.push(await useTool(req, "Bash", { command: "rm -rf /" }));
    return { text: "tamam" };
  });
  await h.send({ type: "user_text", id: "t1", text: "x" });
  assert.deepEqual(results.map((r) => r.behavior), ["allow", "allow", "deny"]);
  assert.deepEqual(
    h.of("tool").map((f) => `${f.name}:${f.status}`),
    ["homeassistant__GetLiveContext:started", "homeassistant__GetLiveContext:done", "intent__HassTurnOn:started", "Bash:denied"],
  );
  await h.session.close("test");
  const perms = sessionLines(h).filter((l) => l.kind === "permission");
  assert.deepEqual(
    perms.map((p) => `${p.level}:${p.decision}`),
    ["read:allow", "write:allow", "deny:deny"],
  );
  const write = sessionLines(h).find((l) => l.kind === "tool_call" && l.level === "write");
  assert.deepEqual(write?.input, { name: "lamba" });
});

test("read-only mode denies write and confirm without asking", async () => {
  const results: PermissionResult[] = [];
  const h = harness(
    async (req) => {
      results.push(await useTool(req, `${HA}homeassistant__GetLiveContext`));
      results.push(await useTool(req, `${HA}intent__HassTurnOn`));
      results.push(await useTool(req, `${HA}lock__HassUnlock`));
    },
    { readOnly: true },
  );
  await h.send({ type: "user_text", id: "t1", text: "x" });
  assert.deepEqual(results.map((r) => r.behavior), ["allow", "deny", "deny"]);
  assert.equal(h.of("confirm_request").length, 0);
});

/** Starts a turn that hits a confirm tool and reports the gate result. */
function confirmTurn(toolName = `${HA}lock__HassUnlock`) {
  let gateResult: Promise<PermissionResult> | undefined;
  const script: Script = async (req) => {
    gateResult = useTool(req, toolName, { name: "kapı" });
    const r = await gateResult;
    return { text: r.behavior === "allow" ? "açıldı" : "açmadım" };
  };
  return { script, result: () => gateResult as Promise<PermissionResult> };
}

test("confirm approved by button", async () => {
  const c = confirmTurn();
  const h = harness(c.script);
  const turn = h.send({ type: "user_text", id: "t1", text: "kapıyı aç" });
  const req = (await h.waitFor((f) => f.type === "confirm_request")) as Extract<ServerFrame, { type: "confirm_request" }>;
  assert.equal(req.id, "t1");
  assert.equal(req.tool, "lock__HassUnlock");
  assert.match(req.summary, /çalıştırılsın mı/);
  assert.ok(req.expiresAt > Date.now());
  assert.ok(h.of("state").some((s) => s.state === "awaiting_confirm"));
  await h.send({ type: "confirm_response", requestId: req.requestId, approved: true });
  await turn;
  assert.equal((await c.result()).behavior, "allow");
  assert.deepEqual(h.of("confirm_resolved"), [{ type: "confirm_resolved", requestId: req.requestId, approved: true, by: "button" }]);
  const states = h.of("state").map((s) => s.state);
  assert.deepEqual(states, ["thinking", "awaiting_confirm", "thinking", "idle"]);
});

test("confirm denied by button", async () => {
  const c = confirmTurn();
  const h = harness(c.script);
  const turn = h.send({ type: "user_text", id: "t1", text: "kapıyı aç" });
  const req = (await h.waitFor((f) => f.type === "confirm_request")) as Extract<ServerFrame, { type: "confirm_request" }>;
  await h.send({ type: "confirm_response", requestId: req.requestId, approved: false });
  await turn;
  assert.equal((await c.result()).behavior, "deny");
  assert.ok(h.of("tool").some((t) => t.status === "denied"));
});

test("unknown tool → confirm", async () => {
  const c = confirmTurn("mcp__mystery__do_something");
  const h = harness(c.script);
  const turn = h.send({ type: "user_text", id: "t1", text: "x" });
  const req = (await h.waitFor((f) => f.type === "confirm_request")) as Extract<ServerFrame, { type: "confirm_request" }>;
  await h.send({ type: "confirm_response", requestId: req.requestId, approved: false });
  await turn;
});

test("confirm answered by voice (evet / hayır)", async () => {
  for (const [spoken, expected] of [
    ["Evet.", "allow"],
    ["hayır", "deny"],
  ] as const) {
    const c = confirmTurn();
    const h = harness(c.script, { stt: { transcribe: async () => ({ text: spoken }) } });
    const turn = h.send({ type: "user_text", id: "t1", text: "kapıyı aç" });
    const req = (await h.waitFor((f) => f.type === "confirm_request")) as Extract<ServerFrame, { type: "confirm_request" }>;
    await h.send({ type: "audio", id: "t2", mime: "audio/webm", data: Buffer.from("fake").toString("base64") });
    await turn;
    assert.equal((await c.result()).behavior, expected, spoken);
    assert.deepEqual(h.of("transcript")[0], { type: "transcript", id: "t2", text: spoken });
    const resolved = h.of("confirm_resolved");
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]?.by, "voice");
    assert.equal(resolved[0]?.requestId, req.requestId);
    assert.equal(h.agent.calls.length, 1, "voice answer must not start a new turn");
  }
});

test("non-answer speech while awaiting confirm → busy, confirm stays pending", async () => {
  const c = confirmTurn();
  const h = harness(c.script, { stt: { transcribe: async () => ({ text: "salondaki ışığı da kapat" }) } });
  const turn = h.send({ type: "user_text", id: "t1", text: "kapıyı aç" });
  const req = (await h.waitFor((f) => f.type === "confirm_request")) as Extract<ServerFrame, { type: "confirm_request" }>;
  await h.send({ type: "audio", id: "t2", mime: "audio/webm", data: "ZmFrZQ==" });
  assert.equal(h.of("error").at(-1)?.code, "busy");
  assert.equal(h.of("confirm_resolved").length, 0);
  await h.send({ type: "confirm_response", requestId: req.requestId, approved: false });
  await turn;
});

test("confirm times out → denied by timeout", async () => {
  const c = confirmTurn();
  const h = harness(c.script, { confirmTimeoutMs: 30 });
  await h.send({ type: "user_text", id: "t1", text: "kapıyı aç" });
  assert.equal((await c.result()).behavior, "deny");
  assert.equal(h.of("confirm_resolved")[0]?.by, "timeout");
  assert.equal(h.of("confirm_resolved")[0]?.approved, false);
});

test("button vs voice race: first wins, resolved once", async () => {
  const c = confirmTurn();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const h = harness(c.script, {
    stt: {
      transcribe: async () => {
        await gate; // voice arrives after the button
        return { text: "evet" };
      },
    },
  });
  const turn = h.send({ type: "user_text", id: "t1", text: "kapıyı aç" });
  const req = (await h.waitFor((f) => f.type === "confirm_request")) as Extract<ServerFrame, { type: "confirm_request" }>;
  const voice = h.send({ type: "audio", id: "t2", mime: "audio/webm", data: "ZmFrZQ==" });
  await h.send({ type: "confirm_response", requestId: req.requestId, approved: false });
  release();
  await voice;
  await turn;
  assert.equal((await c.result()).behavior, "deny");
  assert.deepEqual(h.of("confirm_resolved").map((r) => r.by), ["button"]);
  // A late duplicate button press is ignored too.
  await h.send({ type: "confirm_response", requestId: req.requestId, approved: true });
  assert.equal(h.of("confirm_resolved").length, 1);
});

test("busy while a turn runs; cancel aborts and denies pending confirm", async () => {
  const c = confirmTurn();
  const h = harness(c.script);
  const turn = h.send({ type: "user_text", id: "t1", text: "kapıyı aç" });
  await h.waitFor((f) => f.type === "confirm_request");
  await h.send({ type: "user_text", id: "t2", text: "başka" });
  assert.deepEqual(h.of("error").at(-1), { type: "error", id: "t2", code: "busy", message: "a turn is already running" });
  await h.send({ type: "cancel", id: "t1" });
  await turn;
  assert.equal((await c.result()).behavior, "deny");
  // cancel is reported as a client action on the wire; the log keeps "cancel".
  assert.deepEqual(
    h.of("confirm_resolved").map((r) => `${r.by}:${r.approved}`),
    ["button:false"],
  );
  await h.session.close("test");
  assert.ok(sessionLines(h).some((l) => l.kind === "permission" && l.by === "cancel" && l.decision === "deny"));
  assert.equal(h.agent.calls[0]?.signal.aborted, true);
  assert.equal(h.of("state").at(-1)?.state, "idle");
});

test("model error → error model_error, back to idle", async () => {
  const h = harness(async () => ({ error: "authentication_failed" }));
  await h.send({ type: "user_text", id: "t1", text: "x" });
  assert.equal(h.of("error")[0]?.code, "model_error");
  assert.equal(h.of("state").at(-1)?.state, "idle");
  const h2 = harness(async () => {
    throw new Error("boom");
  });
  await h2.send({ type: "user_text", id: "t1", text: "x" });
  assert.equal(h2.of("error")[0]?.code, "model_error");
});

test("audio turn: transcript then handled like user_text", async () => {
  const h = harness(async (req, cb) => {
    cb.onDelta(`echo:${req.prompt}`);
  }, { stt: { transcribe: async () => ({ text: "evde sıcaklık kaç" }) } });
  await h.send({ type: "audio", id: "t1", mime: "audio/webm", data: "ZmFrZQ==" });
  assert.deepEqual(h.of("transcript")[0], { type: "transcript", id: "t1", text: "evde sıcaklık kaç" });
  assert.equal(h.of("assistant_done")[0]?.text, "echo:evde sıcaklık kaç");
});

test("stt unavailable / bad audio / empty transcript", async () => {
  const h = harness(async () => {}, {
    stt: {
      transcribe: async () => {
        throw new SpeechServiceError("stt_unavailable", "whisper-svc: service unreachable");
      },
    },
  });
  await h.send({ type: "audio", id: "t1", mime: "audio/webm", data: "ZmFrZQ==" });
  assert.equal(h.of("error")[0]?.code, "stt_unavailable");
  await h.send({ type: "audio", id: "t2", mime: "audio/webm", data: "not base64!" });
  assert.equal(h.of("error")[1]?.code, "bad_request");
  const h2 = harness(async () => {});
  await h2.send({ type: "audio", id: "t1", mime: "audio/webm", data: "ZmFrZQ==" });
  assert.equal(h2.of("error")[0]?.code, "bad_request");
  assert.equal(h2.agent.calls.length, 0);
});

test("speak → speech or tts_unavailable", async () => {
  const h = harness(async () => {});
  await h.send({ type: "speak", id: "t1", text: "merhaba" });
  assert.deepEqual(h.of("speech")[0], { type: "speech", id: "t1", mime: "audio/wav", data: Buffer.from("RIFF").toString("base64") });
  const h2 = harness(async () => {}, {
    tts: {
      synthesize: async () => {
        throw new SpeechServiceError("tts_unavailable", "tts-svc: service unreachable");
      },
    },
  });
  await h2.send({ type: "speak", id: "t1", text: "merhaba" });
  assert.equal(h2.of("error")[0]?.code, "tts_unavailable");
});

test("history and ping", async () => {
  const h = harness(async (_r, cb) => cb.onDelta("cevap"));
  await h.send({ type: "user_text", id: "t1", text: "soru" });
  await h.send({ type: "history_request", limit: 10 });
  const hist = h.of("history")[0];
  assert.deepEqual(hist?.items.map((i) => `${i.role}:${i.text}`), ["user:soru", "assistant:cevap"]);
  await h.send({ type: "ping" });
  assert.equal(h.frames.at(-1)?.type, "pong");
});

test("close denies pending confirms and aborts the turn", async () => {
  const c = confirmTurn();
  const h = harness(c.script);
  const turn = h.send({ type: "user_text", id: "t1", text: "kapıyı aç" });
  await h.waitFor((f) => f.type === "confirm_request");
  await h.session.close("socket_closed");
  await turn;
  assert.equal((await c.result()).behavior, "deny");
});

/** A controllable fake whisper: each transcribe() waits for release(text). */
function heldStt() {
  const queue: Array<(text: string) => void> = [];
  let signal: AbortSignal | undefined;
  const stt: SttClient = {
    transcribe: (_a, _m, s) =>
      new Promise((res, rej) => {
        signal = s;
        s?.addEventListener("abort", () => rej(new Error("aborted")), { once: true });
        queue.push((text) => res({ text }));
      }),
  };
  return { stt, release: (text: string) => queue.shift()?.(text), signal: () => signal, waiting: () => queue.length };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

test("voice answer is bound to the confirm open when spoken, not a later one", async () => {
  const held = heldStt();
  const results: PermissionResult[] = [];
  const h = harness(
    async (req) => {
      results.push(await useTool(req, `${HA}lock__HassUnlock`, { name: "A" }));
      results.push(await useTool(req, `${HA}lock__HassLock`, { name: "B" }));
    },
    { stt: held.stt },
  );
  const turn = h.send({ type: "user_text", id: "t1", text: "x" });
  const reqA = (await h.waitFor((f) => f.type === "confirm_request")) as Extract<ServerFrame, { type: "confirm_request" }>;
  const voice = h.send({ type: "audio", id: "t2", mime: "audio/webm", data: "ZmFrZQ==" });
  await tick();
  // A is answered by the button while whisper is still working; B opens.
  await h.send({ type: "confirm_response", requestId: reqA.requestId, approved: false });
  const reqB = (await h.waitFor(
    (f) => f.type === "confirm_request" && f.requestId !== reqA.requestId,
  )) as Extract<ServerFrame, { type: "confirm_request" }>;
  held.release("evet");
  await voice;
  assert.equal(h.of("confirm_resolved").length, 1, "the late 'evet' must not resolve B");
  await h.send({ type: "confirm_response", requestId: reqB.requestId, approved: false });
  await turn;
  assert.deepEqual(results.map((r) => r.behavior), ["deny", "deny"]);
  assert.deepEqual(h.of("confirm_resolved").map((r) => r.by), ["button", "button"]);
  assert.equal(h.agent.calls.length, 1);
});

test("cancel during transcription: no transcript, no turn", async () => {
  const held = heldStt();
  const h = harness(async () => ({ text: "should not run" }), { stt: held.stt });
  const voice = h.send({ type: "audio", id: "t1", mime: "audio/webm", data: "ZmFrZQ==" });
  await tick();
  await h.send({ type: "cancel", id: "t1" });
  await voice;
  assert.equal(held.signal()?.aborted, true, "whisper request is aborted");
  held.release("ışığı kapat");
  await tick();
  assert.equal(h.agent.calls.length, 0);
  assert.equal(h.of("transcript").length, 0);
  assert.equal(h.of("error").length, 0);
});

test("close waits for the aborted turn and writes session_end last", async () => {
  const c = confirmTurn();
  const h = harness(c.script);
  const turn = h.send({ type: "user_text", id: "t1", text: "kapıyı aç" });
  await h.waitFor((f) => f.type === "confirm_request");
  await h.session.close("socket_closed");
  await turn;
  const kinds = sessionLines(h).map((l) => l.kind);
  assert.equal(kinds.at(-1), "session_end");
  assert.ok(kinds.includes("usage"));
});

test("frames arriving after close() start no turn and write nothing after session_end", async () => {
  const held = heldStt();
  const h = harness(async () => ({ text: "should not run" }), { stt: held.stt });
  await h.session.close("socket_closed");
  await h.send({ type: "user_text", id: "late1", text: "ışığı kapat" });
  await h.send({ type: "audio", id: "late2", mime: "audio/webm", data: "ZmFrZQ==" });
  await tick();
  assert.equal(h.agent.calls.length, 0);
  assert.equal(held.waiting(), 0, "no transcription is started after close");
  assert.equal(h.frames.length, 0);
  const kinds = sessionLines(h).map((l) => l.kind);
  assert.deepEqual(kinds, ["session_start", "session_end"]);
});

test("close() while transcribing: the utterance never becomes a turn", async () => {
  const held = heldStt();
  const h = harness(async () => ({ text: "should not run" }), { stt: held.stt });
  const voice = h.send({ type: "audio", id: "t1", mime: "audio/webm", data: "ZmFrZQ==" });
  await tick();
  await h.session.close("socket_closed");
  held.release("ışığı kapat");
  await voice;
  assert.equal(h.agent.calls.length, 0);
  assert.equal(sessionLines(h).map((l) => l.kind).at(-1), "session_end");
});
