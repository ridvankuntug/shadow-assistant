/**
 * Session memory wiring (docs/06 M6/M7): the `<hafiza>` block in the turn
 * envelope (once per conversation), the brief for legacy turns, the
 * `memory_list`/`memory_delete` frames, maintenance notifications and the
 * reseed note. Fake provider session and registry; a real MemoryStore in a
 * temp folder. No SDK, no model call.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { AgentRunner, TurnCallbacks, TurnRequest, TurnResult } from "../src/agent.js";
import { ConversationLog } from "../src/conversation-log.js";
import { SentEntries } from "../src/memory/match.js";
import { MemoryStore } from "../src/memory/store.js";
import {
  SessionClosedError,
  type AttemptHandle,
  type AttemptOutcome,
  type AttemptRequest,
  type AttemptStatus,
  type ProviderCapabilities,
  type ProviderSession,
} from "../src/model-provider.js";
import { PermissionPolicy } from "../src/permissions.js";
import type { ServerFrame } from "../src/protocol.js";
import type { Router } from "../src/router.js";
import { parseServices } from "../src/services.js";
import { Session, type SessionMaintenance, type SessionMemory, type SessionRegistry } from "../src/session.js";

const base = mkdtempSync(join(tmpdir(), "shadow-session-memory-test-"));
const open: Session[] = [];
after(async () => {
  await Promise.all(open.map((s) => s.close("test_end")));
  rmSync(base, { recursive: true, force: true });
});

const services = parseServices(
  ["services:", "  - name: home-assistant", "    kind: mcp", "    url: http://localhost:1/sse", "    permission: confirm"].join("\n"),
  {},
).services;

class FakeLive implements ProviderSession {
  readonly provider = "fake";
  sessionId: string | undefined = "sess-1";
  model = "m1";
  busy = false;
  isClosed = false;
  attempts: AttemptRequest[] = [];
  /** The next attempt is accepted but ends unsent (cancelled while queued). */
  unsentNext = false;
  constructor(private readonly o: { status?: AttemptStatus; retryAt?: number; inputTokens?: number } = {}) {}
  ready(): Promise<void> {
    return Promise.resolve();
  }
  runAttempt(req: AttemptRequest): AttemptHandle {
    this.attempts.push(req);
    if (this.unsentNext) {
      this.unsentNext = false;
      const cancelled: AttemptOutcome = {
        text: "",
        inputTokens: 0,
        outputTokens: 0,
        durationMs: 0,
        status: "cancelled",
        model: req.model,
        warm: true,
        queryAgeMs: 1,
        doneMs: 0,
      };
      const settled = Promise.resolve(cancelled);
      return { done: settled, settled, sent: Promise.resolve(false) };
    }
    const out: AttemptOutcome = {
      text: "Tamam.",
      inputTokens: this.o.inputTokens ?? 11,
      outputTokens: 2,
      durationMs: 5,
      status: this.o.status ?? "ok",
      model: req.model,
      ...(this.o.retryAt !== undefined ? { retryAt: this.o.retryAt } : {}),
      warm: true,
      queryAgeMs: 1,
      doneMs: 1,
    };
    const done = Promise.resolve().then(() => {
      if (out.status === "ok") req.callbacks.onDelta("Tamam.");
      return out;
    });
    return { done, settled: done, sent: Promise.resolve(true) };
  }
  async appendNote(): Promise<boolean> {
    return true;
  }
  async setModel(m: string): Promise<void> {
    this.model = m;
  }
  async interrupt(): Promise<void> {}
  close(): void {
    this.isClosed = true;
  }
}

class FakeRegistry implements SessionRegistry {
  capabilities: ProviderCapabilities = { setModel: true, compact: false, notes: true, resume: true };
  readonly sent = new SentEntries();
  seed: string | undefined;
  held = false;
  constructor(public session: FakeLive | undefined) {}
  async acquire(): Promise<ProviderSession | undefined> {
    return this.session;
  }
  live(): ProviderSession | undefined {
    return this.session;
  }
  prewarm(): void {}
  beginTurn(): boolean {
    return true;
  }
  endTurn(): void {}
  async fallbackResume(): Promise<string | undefined> {
    return "resume-x";
  }
  ended = 0;
  async turnEnded(): Promise<void> {
    this.ended++;
  }
  sentEntries(): SentEntries {
    return this.sent;
  }
  peekSeedNote(): string | undefined {
    return this.seed;
  }
  seedDelivered(_device: string, seed: string): void {
    if (this.seed === seed) this.seed = undefined;
  }
  isHeld(): boolean {
    return this.held;
  }
}

class MockAgent implements AgentRunner {
  calls: TurnRequest[] = [];
  async runTurn(req: TurnRequest, cb: TurnCallbacks): Promise<TurnResult> {
    this.calls.push(req);
    cb.onDelta("Eski yol.");
    return { text: "Eski yol.", inputTokens: 1, outputTokens: 1, durationMs: 5, sessionId: "legacy-1" };
  }
}

class Notes implements SessionMaintenance {
  events: string[] = [];
  model: Array<{ device: string; o?: { contextTokens?: number; usageLimited?: boolean; retryAt?: number } }> = [];
  turnStarted(device: string): void {
    this.events.push(`start:${device}`);
  }
  turnEnded(device: string): void {
    this.events.push(`end:${device}`);
  }
  modelTurnEnded(device: string, o?: { contextTokens?: number; usageLimited?: boolean; retryAt?: number }): void {
    this.model.push({ device, ...(o ? { o } : {}) });
  }
}

const tier2: Router = { route: () => ({ model: "m2", tier: 2 }) };

let n = 0;
async function harness(o: { registry?: FakeRegistry | null; memory?: boolean | SessionMemory; router?: Router } = {}) {
  const dir = join(base, `case-${++n}`);
  const store = new MemoryStore({ dir: join(dir, "memory"), retryDelaysMs: [] });
  const frames: ServerFrame[] = [];
  const agent = new MockAgent();
  const maintenance = new Notes();
  const registry = o.registry === null ? undefined : (o.registry ?? new FakeRegistry(new FakeLive()));
  const session = new Session(
    {
      agent,
      ...(registry ? { registry } : {}),
      policy: new PermissionPolicy(services, {}),
      router: o.router ?? tier2,
      stt: { transcribe: async () => ({ text: "" }) },
      tts: { synthesize: async () => ({ mime: "audio/wav", data: Buffer.from("") }), voices: async () => ({ default: "v", voices: ["v"] }) },
      log: new ConversationLog(dir),
      logger: { info: () => {}, warn: () => {} },
      ...(o.memory === false ? {} : { memory: typeof o.memory === "object" ? o.memory : store }),
      maintenance,
    },
    { sessionId: `s${n}`, device: "browser" },
    (f) => frames.push(f),
  );
  open.push(session);
  return {
    session,
    store,
    frames,
    agent,
    registry,
    maintenance,
    say: (text: string, id = "t1") => session.handle({ type: "user_text", id, text }),
    of: <T extends ServerFrame["type"]>(type: T) => frames.filter((f) => f.type === type) as Extract<ServerFrame, { type: T }>[],
  };
}

const settle = () => new Promise((r) => setImmediate(r));

test("persistent turn: relevant notes go in a <hafiza> block once per conversation; the brief does not", async () => {
  const live = new FakeLive();
  const registry = new FakeRegistry(live);
  const h = await harness({ registry });
  await h.store.add({ kind: "identity", text: "Kullanıcının adı Rıdvan." });
  await h.store.add({ kind: "alias", text: "Otomodos = oturma odası", keywords: ["otomodos"] });
  await h.store.add({ kind: "preference", text: "Kullanıcı mutfakta caz dinlemeyi sever.", keywords: ["mutfak"] });

  await h.say("Otomodos'un ışığını yüzde 40 yap", "t1");
  const first = live.attempts[0]?.text ?? "";
  assert.match(first, /<hafiza>\n- Otomodos = oturma odası\n<\/hafiza>\nOtomodos'un ışığını yüzde 40 yap$/);
  assert.doesNotMatch(first, /Rıdvan|mutfak/);

  await h.say("Otomodos ışığını kapat", "t2");
  assert.equal(live.attempts[1]?.text, "Otomodos ışığını kapat", "already sent in this conversation");

  // A cleared set (new query / compaction) sends it again.
  registry.sent.clear();
  await h.say("Otomodos ışığını aç", "t3");
  assert.match(live.attempts[2]?.text ?? "", /<hafiza>/);
});

test("no matching entry, memory off, or tier 0: no block", async () => {
  const live = new FakeLive();
  const h = await harness({ registry: new FakeRegistry(live), memory: false });
  await h.say("Otomodos ışığını aç");
  assert.equal(live.attempts[0]?.text, "Otomodos ışığını aç");

  const live2 = new FakeLive();
  const h2 = await harness({ registry: new FakeRegistry(live2) });
  await h2.store.add({ kind: "alias", text: "Otomodos = oturma odası", keywords: ["otomodos"] });
  await h2.say("Hava nasıl?");
  assert.equal(live2.attempts[0]?.text, "Hava nasıl?");
});

test("legacy runner (no registry): brief and relevant notes in the block, once per conversation", async () => {
  const h = await harness({ registry: null });
  await h.store.add({ kind: "identity", text: "Kullanıcının adı Rıdvan." });
  await h.store.add({ kind: "alias", text: "Otomodos = oturma odası", keywords: ["otomodos"] });
  await h.say("Otomodos ışığını aç", "t1");
  assert.equal(
    h.agent.calls[0]?.prompt,
    "<hafiza>\n- Kullanıcının adı Rıdvan.\n- Otomodos = oturma odası\n</hafiza>\nOtomodos ışığını aç",
  );
  await h.say("Otomodos ışığını kapat", "t2");
  assert.equal(h.agent.calls[1]?.prompt, "Otomodos ışığını kapat");
  assert.deepEqual(h.maintenance.model, [{ device: "browser" }, { device: "browser" }]);
});

test("the attempt is not taken (session closed): entries are not marked sent and go to the legacy turn", async () => {
  const live = new FakeLive();
  live.runAttempt = () => {
    throw new SessionClosedError("gone");
  };
  const registry = new FakeRegistry(live);
  const h = await harness({ registry });
  await h.store.add({ kind: "alias", text: "Otomodos = oturma odası", keywords: ["otomodos"] });
  await h.say("Otomodos ışığını aç");
  assert.match(h.agent.calls[0]?.prompt ?? "", /<hafiza>\n- Otomodos = oturma odası/);
  assert.equal(registry.sent.size, 1);
});

test("maintenance hears turn start/end and the model turn's context size; a usage limit is passed on", async () => {
  const live = new FakeLive({ inputTokens: 51_000 });
  const h = await harness({ registry: new FakeRegistry(live) });
  await h.say("anlat");
  await settle();
  await settle();
  assert.deepEqual(h.maintenance.events, ["start:browser", "end:browser"]);
  assert.deepEqual(h.maintenance.model, [{ device: "browser", o: { contextTokens: 51_000 } }]);

  const limited = new FakeLive({ status: "usage_limit", retryAt: 123 });
  const h2 = await harness({ registry: new FakeRegistry(limited) });
  await h2.say("anlat");
  await settle();
  await settle();
  assert.deepEqual(h2.maintenance.model[0]?.o, { contextTokens: 11, usageLimited: true, retryAt: 123 });
});

test("a reseed note not stored in the session goes in front of the next prompt, once", async () => {
  const live = new FakeLive();
  const registry = new FakeRegistry(live);
  registry.seed = "(Önceki konuşmanın özeti: Kullanıcı mutfak ışığını sordu.)";
  const h = await harness({ registry });
  await h.say("devam et", "t1");
  assert.equal(live.attempts[0]?.text, "<bilgi>\n(Önceki konuşmanın özeti: Kullanıcı mutfak ışığını sordu.)\n</bilgi>\ndevam et");
  await h.say("tamam", "t2");
  assert.equal(live.attempts[1]?.text, "tamam");
});

test("a turn cancelled while memory is read sends no attempt; the reseed note stays for the next turn", async () => {
  const live = new FakeLive();
  const registry = new FakeRegistry(live);
  registry.seed = "(Önceki konuşmanın özeti: X.)";
  let entered!: () => void;
  const inEntries = new Promise<void>((r) => (entered = r));
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let first = true;
  const memory = {
    entries: async () => {
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return [];
    },
    snapshot: async () => {
      throw new Error("unused");
    },
    forget: async () => {
      throw new Error("unused");
    },
  } as unknown as SessionMemory;
  const h = await harness({ registry, memory });
  const turn = h.say("devam et", "t1");
  await inEntries;
  await h.session.handle({ type: "cancel", id: "t1" });
  open();
  await turn;
  assert.equal(live.attempts.length, 0, "no attempt after the cancel");
  assert.equal(h.of("assistant_done")[0]?.text, "");
  assert.equal(registry.seed, "(Önceki konuşmanın özeti: X.)", "the seed is kept");
  await h.say("tamam", "t2");
  assert.equal(live.attempts[0]?.text, "<bilgi>\n(Önceki konuşmanın özeti: X.)\n</bilgi>\ntamam");
  assert.equal(registry.seed, undefined, "delivered once the attempt was taken");
});

test("an attempt accepted but never sent keeps the seed and the entries for the next turn; continuity does not move", async () => {
  const live = new FakeLive();
  const registry = new FakeRegistry(live);
  registry.seed = "(Önceki konuşmanın özeti: X.)";
  const h = await harness({ registry });
  await h.store.add({ kind: "alias", text: "Otomodos = oturma odası", keywords: ["otomodos"] });
  live.unsentNext = true;
  await h.say("Otomodos ışığını aç", "t1");
  await settle();
  assert.equal(live.attempts.length, 1);
  assert.equal(registry.seed, "(Önceki konuşmanın özeti: X.)", "the seed is kept");
  assert.equal(registry.sent.size, 0, "entries are not marked sent");
  assert.equal(registry.ended, 0, "no continuity update");
  assert.deepEqual(h.maintenance.model, [], "no model turn counted");
  await h.say("Otomodos ışığını kapat", "t2");
  await settle();
  assert.match(live.attempts[1]?.text ?? "", /^<bilgi>\n\(Önceki konuşmanın özeti: X\.\)\n<\/bilgi>/);
  assert.match(live.attempts[1]?.text ?? "", /<hafiza>\n- Otomodos = oturma odası/);
  assert.equal(registry.seed, undefined, "delivered once the prompt was sent");
  assert.equal(registry.sent.size, 1);
  assert.equal(registry.ended, 1);
});

test("legacy fallback: a turn cancelled while memory is read makes no call, keeps the seed and does not move continuity", async () => {
  const registry = new FakeRegistry(undefined);
  registry.seed = "(Önceki konuşmanın özeti: Y.)";
  let entered!: () => void;
  const inEntries = new Promise<void>((r) => (entered = r));
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let first = true;
  const memory = {
    entries: async () => {
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return [];
    },
    snapshot: async () => {
      throw new Error("unused");
    },
    forget: async () => {
      throw new Error("unused");
    },
  } as unknown as SessionMemory;
  const h = await harness({ registry, memory });
  const turn = h.say("devam et", "t1");
  await inEntries;
  await h.session.handle({ type: "cancel", id: "t1" });
  open();
  await turn;
  assert.equal(h.agent.calls.length, 0, "no model call after the cancel");
  assert.equal(h.of("assistant_done")[0]?.text, "");
  assert.equal(registry.seed, "(Önceki konuşmanın özeti: Y.)", "the seed is kept");
  assert.equal(registry.ended, 0, "no continuity update");
  assert.deepEqual(h.maintenance.model, [], "no model turn counted");
  await h.say("tamam", "t2");
  assert.match(h.agent.calls[0]?.prompt ?? "", /^<bilgi>\n\(Önceki konuşmanın özeti: Y\.\)\n<\/bilgi>/);
  assert.equal(registry.seed, undefined);
  assert.equal(registry.ended, 1);
});

test("memory_list answers with a memory frame; memory_delete tombstones and answers with a fresh one", async () => {
  const h = await harness();
  const brief = await h.store.add({ kind: "identity", text: "Kullanıcının adı Rıdvan." });
  const alias = await h.store.add({ kind: "alias", text: "Otomodos = oturma odası", keywords: ["otomodos"] });
  assert.ok(brief.ok && alias.ok);

  await h.session.handle({ type: "memory_list", id: "m1" });
  const list = h.of("memory")[0];
  assert.ok(list);
  assert.equal(list.id, "m1");
  assert.deepEqual(list.brief.entries, [{ id: brief.entry.id, text: "Kullanıcının adı Rıdvan." }]);
  const ev = list.topics.find((t) => t.topic === "ev");
  assert.equal(ev?.entries[0]?.id, alias.entry.id);
  assert.equal(typeof ev?.entries[0]?.updatedAt, "number");
  assert.equal(JSON.stringify(list).includes("keywords"), false, "no keywords or provenance leave the Core");

  await h.session.handle({ type: "memory_delete", id: "m2", entryId: alias.entry.id });
  const fresh = h.of("memory")[1];
  assert.equal(fresh?.id, "m2");
  assert.equal(fresh?.topics.find((t) => t.topic === "ev")?.entries.length, 0);
  assert.equal(await h.store.isForgotten("Otomodos = oturma odası"), true, "tombstoned like memory_forget");

  // Unknown, malformed or already deleted ids are bad_request (with the request id).
  await h.session.handle({ type: "memory_delete", id: "m3", entryId: alias.entry.id });
  await h.session.handle({ type: "memory_delete", id: "m4", entryId: "../brief" });
  const errors = h.of("error");
  assert.deepEqual(
    errors.map((e) => [e.id, e.code]),
    [
      ["m3", "bad_request"],
      ["m4", "bad_request"],
    ],
  );
});

test("memory frames with memory disabled: bad_request", async () => {
  const h = await harness({ memory: false });
  await h.session.handle({ type: "memory_list", id: "m1" });
  await h.session.handle({ type: "memory_delete", id: "m2", entryId: "m-abcdef" });
  assert.deepEqual(
    h.of("error").map((e) => [e.id, e.code, e.message]),
    [
      ["m1", "bad_request", "memory is disabled"],
      ["m2", "bad_request", "memory is disabled"],
    ],
  );
  assert.equal(h.of("memory").length, 0);
});
