/** DeviceRegistry tests with a fake provider: no SDK, no subprocess. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ContinuityStore, continuityFilePath } from "../src/continuity.js";
import { continuityPort, DeviceRegistry, type ContinuityPointer, type ContinuityPort } from "../src/device-registry.js";
import type {
  AttemptHandle,
  ModelProvider,
  OneShotResult,
  OpenSessionOptions,
  ProviderCapabilities,
  ProviderSession,
} from "../src/model-provider.js";

const base = mkdtempSync(join(tmpdir(), "shadow-registry-test-"));
after(() => rmSync(base, { recursive: true, force: true }));

class FakeSession implements ProviderSession {
  readonly provider: string;
  model: string;
  busy = false;
  isClosed = false;
  sessionId: string | undefined;
  closeCalls = 0;
  private readyResolve!: () => void;
  private readyReject!: (e: Error) => void;
  private readonly readyP: Promise<void>;
  constructor(
    providerId: string,
    readonly opts: OpenSessionOptions,
  ) {
    this.provider = providerId;
    this.model = opts.model;
    this.sessionId = opts.resume;
    this.readyP = new Promise<void>((res, rej) => {
      this.readyResolve = res;
      this.readyReject = rej;
    });
    this.readyP.catch(() => {});
  }
  becomeReady(): void {
    this.readyResolve();
  }
  failStart(): void {
    this.isClosed = true;
    this.opts.onDead?.("init failed");
    this.readyReject(new Error("init failed"));
  }
  /** The backend reports a (new) session id. */
  seeId(id: string): void {
    this.sessionId = id;
    this.opts.onSessionId?.(id);
  }
  die(): void {
    this.isClosed = true;
    this.opts.onDead?.("crash");
  }
  idleClose(): void {
    this.isClosed = true;
    this.opts.onIdleClose?.();
  }
  ready(): Promise<void> {
    return this.readyP;
  }
  runAttempt(): AttemptHandle {
    throw new Error("not used");
  }
  notes: string[] = [];
  refuseNotes = false;
  async appendNote(text: string): Promise<boolean> {
    if (this.isClosed || this.refuseNotes) return false;
    this.notes.push(text);
    return true;
  }
  async setModel(m: string): Promise<void> {
    this.model = m;
  }
  async interrupt(): Promise<void> {}
  close(): void {
    this.closeCalls++;
    this.isClosed = true;
  }
}

class FakeProvider implements ModelProvider {
  readonly capabilities: ProviderCapabilities = { setModel: true, compact: false, notes: true, resume: true };
  readonly sessions: FakeSession[] = [];
  autoReady = true;
  throwOnOpen = false;
  constructor(readonly id = "fake") {}
  openSession(o: OpenSessionOptions): FakeSession {
    if (this.throwOnOpen) throw new Error("spawn failed");
    const s = new FakeSession(this.id, o);
    this.sessions.push(s);
    if (this.autoReady) s.becomeReady();
    return s;
  }
  async oneShot(): Promise<OneShotResult> {
    return { status: "ok", text: "", inputTokens: 0, outputTokens: 0, model: "m" };
  }
}

class MemPort implements ContinuityPort {
  stored = new Map<string, ContinuityPointer>();
  records: Array<{ device: string; pointer: ContinuityPointer; at: number }> = [];
  lookups = 0;
  flushed = 0;
  async lookup(device: string): Promise<ContinuityPointer | undefined> {
    this.lookups++;
    return this.stored.get(device);
  }
  async record(device: string, pointer: ContinuityPointer, at: number): Promise<void> {
    this.records.push({ device, pointer, at });
    this.stored.set(device, pointer);
  }
  async flush(): Promise<void> {
    this.flushed++;
  }
}

const tick = () => new Promise((r) => setImmediate(r));

test("lazy start: one session per device, shared by concurrent callers, reused while live", async () => {
  const provider = new FakeProvider();
  const reg = new DeviceRegistry({ provider, model: "haiku" });
  assert.equal(reg.live("browser"), undefined);
  const [a, b] = await Promise.all([reg.acquire("browser"), reg.acquire("browser")]);
  assert.ok(a);
  assert.equal(a, b);
  assert.equal(provider.sessions.length, 1);
  assert.equal(provider.sessions[0]?.opts.model, "haiku");
  assert.equal(provider.sessions[0]?.opts.device, "browser");
  assert.equal(await reg.acquire("browser"), a);
  assert.equal(reg.live("browser"), a);
  const other = await reg.acquire("phone");
  assert.notEqual(other, a);
  assert.equal(provider.sessions.length, 2);
});

test("prewarm starts the session in the background; prewarm off does nothing", async () => {
  const provider = new FakeProvider();
  const reg = new DeviceRegistry({ provider, model: "haiku" });
  reg.prewarm("browser");
  await tick();
  assert.equal(provider.sessions.length, 1);
  reg.prewarm("browser");
  await tick();
  assert.equal(provider.sessions.length, 1);

  const p2 = new FakeProvider();
  const off = new DeviceRegistry({ provider: p2, model: "haiku", prewarm: false });
  off.prewarm("browser");
  await tick();
  assert.equal(p2.sessions.length, 0);
});

test("start failure, open throwing or a start timeout → undefined (legacy runner for the turn)", async () => {
  const provider = new FakeProvider();
  provider.autoReady = false;
  const reg = new DeviceRegistry({ provider, model: "haiku", startTimeoutMs: 30 });
  const p = reg.acquire("browser");
  await tick();
  provider.sessions[0]?.failStart();
  assert.equal(await p, undefined);
  assert.equal(reg.live("browser"), undefined);

  // never ready → timeout, the half-started session is closed
  const t = await reg.acquire("browser");
  assert.equal(t, undefined);
  assert.equal(provider.sessions[1]?.closeCalls, 1);

  const thrower = new FakeProvider();
  thrower.throwOnOpen = true;
  const reg2 = new DeviceRegistry({ provider: thrower, model: "haiku" });
  assert.equal(await reg2.acquire("browser"), undefined);
});

test("acquire during a prewarm start waits for it: a start that then fails or times out → undefined", async () => {
  const provider = new FakeProvider();
  provider.autoReady = false;
  const reg = new DeviceRegistry({ provider, model: "haiku", startTimeoutMs: 30 });
  reg.prewarm("browser");
  await tick();
  assert.equal(provider.sessions.length, 1); // opened, not ready yet
  let settled = false;
  const p = reg.acquire("browser").then((s) => {
    settled = true;
    return s;
  });
  await tick();
  assert.equal(settled, false, "acquire must not hand out a session that is not ready");
  provider.sessions[0]?.failStart();
  assert.equal(await p, undefined);

  // the same with a start timeout
  reg.prewarm("browser");
  await tick();
  assert.equal(provider.sessions.length, 2);
  assert.equal(await reg.acquire("browser"), undefined);
  assert.equal(provider.sessions[1]?.closeCalls, 1);

  // and a prewarm start that succeeds is shared
  provider.autoReady = true;
  reg.prewarm("browser");
  const s = await reg.acquire("browser");
  assert.ok(s);
  assert.equal(provider.sessions.length, 3);
});

test("death and idle close: the replacement resumes the last session id", async () => {
  const provider = new FakeProvider();
  const reg = new DeviceRegistry({ provider, model: "haiku" });
  await reg.acquire("browser");
  const first = provider.sessions[0]!;
  assert.equal(first.opts.resume, undefined);
  first.seeId("sess-1");
  first.die();
  assert.equal(reg.live("browser"), undefined);
  await reg.acquire("browser");
  const second = provider.sessions[1]!;
  assert.equal(second.opts.resume, "sess-1");
  second.seeId("sess-2");
  second.idleClose();
  await reg.acquire("browser");
  assert.equal(provider.sessions[2]?.opts.resume, "sess-2");
});

test("restart guard: no replacement while it refuses; a refused start falls back", async () => {
  const provider = new FakeProvider();
  let allow = true;
  let deaths = 0;
  const reg = new DeviceRegistry({
    provider,
    model: "haiku",
    restartGuard: () => ({ recordDeath: () => void deaths++, canStart: () => allow }),
  });
  await reg.acquire("browser");
  provider.sessions[0]!.die();
  assert.equal(deaths, 1);
  allow = false;
  assert.equal(await reg.acquire("browser"), undefined);
  assert.equal(provider.sessions.length, 1);
  allow = true;
  assert.ok(await reg.acquire("browser"));
});

test("continuity: the first start resumes a stored pointer of this provider only, asked once", async () => {
  const port = new MemPort();
  port.stored.set("browser", { provider: "fake", sessionId: "old-1" });
  port.stored.set("phone", { provider: "other", sessionId: "x-1" });
  const provider = new FakeProvider();
  const reg = new DeviceRegistry({ provider, model: "haiku", continuity: port });
  await reg.acquire("browser");
  assert.equal(provider.sessions[0]?.opts.resume, "old-1");
  await reg.acquire("phone");
  assert.equal(provider.sessions[1]?.opts.resume, undefined, "another provider's conversation is not resumed");
  const lookups = port.lookups;
  provider.sessions[0]!.idleClose();
  await reg.acquire("browser");
  assert.equal(port.lookups, lookups, "lookup only on the first start of a device");
  assert.equal(provider.sessions[2]?.opts.resume, "old-1");
});

test("turnEnded records {provider, sessionId}; fallback turns record their own id; close flushes", async () => {
  const port = new MemPort();
  const provider = new FakeProvider();
  let now = 1_000;
  const reg = new DeviceRegistry({ provider, model: "haiku", continuity: port, now: () => now });
  const s = (await reg.acquire("browser")) as FakeSession;
  s.seeId("sess-A");
  await reg.turnEnded("browser");
  assert.deepEqual(port.records.at(-1), { device: "browser", pointer: { provider: "fake", sessionId: "sess-A" }, at: 1_000 });
  now = 2_000;
  await reg.turnEnded("browser", "legacy-B");
  assert.deepEqual(port.records.at(-1)?.pointer, { provider: "fake", sessionId: "legacy-B" });
  // no id known yet → nothing written
  await reg.turnEnded("tablet");
  assert.equal(port.records.length, 2);
  assert.equal(await reg.fallbackResume("browser"), "sess-A", "the live session's id wins");
  await reg.close();
  assert.equal(s.closeCalls, 1);
  assert.equal(port.flushed, 1);
  assert.equal(await reg.acquire("browser"), undefined, "closed registry starts nothing");
});

test("fallbackResume without a session uses the stored pointer", async () => {
  const port = new MemPort();
  port.stored.set("browser", { provider: "fake", sessionId: "old-9" });
  const reg = new DeviceRegistry({ provider: new FakeProvider(), model: "haiku", continuity: port });
  assert.equal(await reg.fallbackResume("browser"), "old-9");
});

test("continuityPort over ContinuityStore: survives a 'restart' within the window, not after it; provider kept on disk", async () => {
  const file = continuityFilePath(join(base, "data-1"));
  let now = 10_000_000;
  const mk = () => new ContinuityStore({ file, windowMin: 30, now: () => now, getSessionInfo: async () => ({ ok: true }) });
  const store1 = mk();
  const port1 = continuityPort(store1);
  await port1.record("browser", { provider: "claude-sdk", sessionId: "abc-1" }, now);
  await port1.record("phone", { provider: "other", sessionId: "zzz" }, now);
  await port1.flush();
  const onDisk = JSON.parse(readFileSync(file, "utf8")) as { version: number; devices: Record<string, { provider: string; sessionId: string }> };
  assert.equal(onDisk.version, 2);
  assert.deepEqual([onDisk.devices.browser?.provider, onDisk.devices.browser?.sessionId], ["claude-sdk", "abc-1"]);
  assert.equal(onDisk.devices.phone?.provider, "other");

  // Core restart within the window: own pointer resumed, the other provider's not.
  now += 29 * 60_000;
  const provider = new FakeProvider("claude-sdk");
  const reg = new DeviceRegistry({ provider, model: "haiku", continuity: continuityPort(mk()), now: () => now });
  await reg.acquire("browser");
  assert.equal(provider.sessions[0]?.opts.resume, "abc-1");
  await reg.acquire("phone");
  assert.equal(provider.sessions[1]?.opts.resume, undefined, "another provider's pointer is not resumed");

  // another restart after the window
  now += 31 * 60_000;
  const p2 = new FakeProvider("claude-sdk");
  const reg2 = new DeviceRegistry({ provider: p2, model: "haiku", continuity: continuityPort(mk()), now: () => now });
  await reg2.acquire("browser");
  assert.equal(p2.sessions[0]?.opts.resume, undefined);
});

test("continuity window inside one process: a replacement after the window starts a new conversation", async () => {
  let now = 1_000_000;
  const provider = new FakeProvider();
  const reg = new DeviceRegistry({ provider, model: "haiku", continuityMin: 30, now: () => now });
  const s = (await reg.acquire("browser")) as FakeSession;
  s.seeId("sess-1");
  await reg.turnEnded("browser");
  s.idleClose();
  // within the window: resumed
  now += 29 * 60_000;
  await reg.acquire("browser");
  assert.equal(provider.sessions[1]?.opts.resume, "sess-1");
  provider.sessions[1]!.idleClose();
  // past the window (measured from the last turn): new conversation, also for a legacy fallback turn
  now += 2 * 60_000;
  assert.equal(await reg.fallbackResume("browser"), undefined);
  await reg.acquire("browser");
  assert.equal(provider.sessions[2]?.opts.resume, undefined);
});

test("continuity window applies to a stored pointer too (measured from its lastTurnAt)", async () => {
  let now = 1_000_000;
  const port = new MemPort();
  port.stored.set("browser", { provider: "fake", sessionId: "old-1", lastTurnAt: now - 10 * 60_000 });
  const provider = new FakeProvider();
  const reg = new DeviceRegistry({ provider, model: "haiku", continuity: port, continuityMin: 30, now: () => now });
  await reg.acquire("browser");
  assert.equal(provider.sessions[0]?.opts.resume, "old-1");
  provider.sessions[0]!.idleClose();
  now += 21 * 60_000; // 31 min after the stored turn, no turn since
  await reg.acquire("browser");
  assert.equal(provider.sessions[1]?.opts.resume, undefined);
});

test("turn lock: one model turn per device across sockets; prewarm skips a locked device", async () => {
  const provider = new FakeProvider();
  const reg = new DeviceRegistry({ provider, model: "haiku" });
  assert.equal(reg.beginTurn("browser"), true);
  assert.equal(reg.beginTurn("browser"), false, "second socket gets busy");
  assert.equal(reg.beginTurn("phone"), true, "other devices are independent");
  reg.prewarm("browser");
  await tick();
  assert.equal(provider.sessions.length, 0, "no session resumes a conversation a legacy turn may be writing");
  reg.endTurn("browser");
  assert.equal(reg.beginTurn("browser"), true);
  reg.endTurn("browser");
  reg.prewarm("browser");
  await tick();
  assert.equal(provider.sessions.length, 1);
});

test("close() does not wait for a session that is still starting", async () => {
  const provider = new FakeProvider();
  provider.autoReady = false;
  const reg = new DeviceRegistry({ provider, model: "haiku", startTimeoutMs: 60_000 });
  const pending = reg.acquire("browser");
  await tick();
  assert.equal(provider.sessions.length, 1);
  const started = Date.now();
  await reg.close();
  assert.ok(Date.now() - started < 1_000, "close returned without the start timeout");
  assert.equal(await pending, undefined);
  assert.ok((provider.sessions[0]?.closeCalls ?? 0) >= 1);
});

// --- memory and maintenance (docs/06 M6/M7) ----------------------------------

test("systemAppend: every new session starts with the current brief; the sent set is cleared per session", async () => {
  const provider = new FakeProvider();
  let brief = "Notlar:\n- Ad: Rıdvan";
  const reg = new DeviceRegistry({ provider, model: "haiku", systemAppend: async () => brief });
  const a = await reg.acquire("browser");
  assert.equal(provider.sessions[0]?.opts.systemAppend, "Notlar:\n- Ad: Rıdvan");
  reg.sentEntries("browser").markSent([{ id: "m-aaaaaa", updatedAt: 1 }]);
  (a as FakeSession).seeId("s-1");
  (a as FakeSession).idleClose();
  brief = "";
  await reg.acquire("browser");
  assert.equal(provider.sessions[1]?.opts.systemAppend, undefined, "empty brief → no appendix");
  assert.equal(provider.sessions[1]?.opts.resume, "s-1");
  assert.equal(reg.sentEntries("browser").size, 0, "a new query sends memory again");

  // A failing brief read starts the session without it.
  const p2 = new FakeProvider();
  const reg2 = new DeviceRegistry({
    provider: p2,
    model: "haiku",
    systemAppend: async () => {
      throw new Error("disk");
    },
  });
  assert.ok(await reg2.acquire("browser"));
  assert.equal(p2.sessions[0]?.opts.systemAppend, undefined);
});

test("briefChanged: an idle session restarts at once with resume and the new brief", async () => {
  const provider = new FakeProvider();
  let brief = "B1";
  const reg = new DeviceRegistry({ provider, model: "haiku", systemAppend: async () => brief });
  const a = (await reg.acquire("browser")) as FakeSession;
  a.seeId("conv-1");
  brief = "B2";
  reg.briefChanged();
  assert.equal(a.isClosed, true);
  await tick();
  await tick();
  assert.equal(provider.sessions.length, 2, "restarted in the background (prewarm on)");
  assert.equal(provider.sessions[1]?.opts.resume, "conv-1");
  assert.equal(provider.sessions[1]?.opts.systemAppend, "B2");
  assert.equal(await reg.acquire("browser"), provider.sessions[1]);
});

test("briefChanged during a turn: the session restarts after the turn, or when the next turn acquires it", async () => {
  const provider = new FakeProvider();
  const reg = new DeviceRegistry({ provider, model: "haiku", prewarm: false, systemAppend: async () => "B" });
  const a = (await reg.acquire("browser")) as FakeSession;
  a.seeId("conv-1");
  assert.equal(reg.beginTurn("browser"), true);
  a.busy = true;
  reg.briefChanged();
  assert.equal(a.isClosed, false, "busy: not touched");
  a.busy = false;
  reg.endTurn("browser");
  await reg.turnEnded("browser"); // after settled
  assert.equal(a.isClosed, true);
  assert.equal(provider.sessions.length, 1, "prewarm off: the next turn starts it");
  const b = await reg.acquire("browser");
  assert.equal((b as FakeSession).opts.resume, "conv-1");

  // turnEnded while the lock is still held (legacy fallback): the next acquire replaces it.
  assert.equal(reg.beginTurn("browser"), true);
  reg.briefChanged();
  await reg.turnEnded("browser", "conv-1");
  assert.equal((b as FakeSession).isClosed, false);
  reg.endTurn("browser");
  const c = await reg.acquire("browser");
  assert.notEqual(c, b);
  assert.equal((b as FakeSession).isClosed, true);
});

test("hold: turns wait in acquire while maintenance runs; prewarm is skipped", async () => {
  const provider = new FakeProvider();
  const reg = new DeviceRegistry({ provider, model: "haiku" });
  const a = await reg.acquire("browser");
  let release!: () => void;
  const held = reg.hold("browser", () => new Promise<string>((r) => (release = () => r("done"))));
  assert.equal(reg.isHeld("browser"), true);
  let got: unknown = "pending";
  const turn = reg.acquire("browser").then((s) => (got = s));
  reg.prewarm("browser");
  await tick();
  assert.equal(got, "pending");
  release();
  assert.equal(await held, "done");
  await turn;
  assert.equal(got, a);
  assert.equal(reg.isHeld("browser"), false);
  assert.equal(provider.sessions.length, 1);
});

test("reseed: a new conversation without resume, seeded with the note; old closed; continuity points to it", async () => {
  const provider = new FakeProvider();
  const port = new MemPort();
  const reg = new DeviceRegistry({ provider, model: "haiku", continuity: port, systemAppend: async () => "B" });
  const old = (await reg.acquire("browser")) as FakeSession;
  old.seeId("conv-old");
  reg.sentEntries("browser").markSent([{ id: "m-aaaaaa", updatedAt: 1 }]);
  const origOpen = provider.openSession.bind(provider);
  provider.openSession = (o) => {
    const s = origOpen(o);
    s.sessionId = "conv-new";
    return s;
  };
  assert.equal(await reg.reseed("browser", "(Önceki konuşmanın özeti: x)"), true);
  const fresh = provider.sessions[1] as FakeSession;
  assert.equal(fresh.opts.resume, undefined);
  assert.equal(fresh.opts.systemAppend, "B");
  assert.deepEqual(fresh.notes, ["(Önceki konuşmanın özeti: x)"]);
  assert.equal(old.isClosed, true);
  assert.equal(reg.live("browser"), fresh);
  assert.equal(reg.sentEntries("browser").size, 0);
  assert.equal(reg.peekSeedNote("browser"), undefined, "stored as a note");
  assert.deepEqual(port.records.at(-1)?.pointer, { provider: "fake", sessionId: "conv-new" });
  // An idle close of the new session resumes the new conversation.
  fresh.idleClose();
  await reg.acquire("browser");
  assert.equal(provider.sessions[2]?.opts.resume, "conv-new");
});

test("reseed: a refused note goes in front of the next prompt; a failed start keeps the old session", async () => {
  const provider = new FakeProvider();
  const port = new MemPort();
  const reg = new DeviceRegistry({ provider, model: "haiku", startTimeoutMs: 30, continuity: port });
  const old = (await reg.acquire("browser")) as FakeSession;
  old.seeId("conv-old");
  await reg.turnEnded("browser");
  const origOpen = provider.openSession.bind(provider);
  provider.openSession = (o) => {
    const s = origOpen(o);
    s.refuseNotes = true;
    s.sessionId = "conv-new";
    return s;
  };
  assert.equal(await reg.reseed("browser", "ÖZET"), true);
  assert.equal(reg.peekSeedNote("browser"), "ÖZET");
  assert.equal(reg.peekSeedNote("browser"), "ÖZET", "kept until delivered");
  // Only in memory so far: the persisted pointer stays on the old conversation (a restart keeps its context).
  assert.deepEqual(port.records.at(-1)?.pointer, { provider: "fake", sessionId: "conv-old" });
  reg.seedDelivered("browser", "ANDERE");
  assert.equal(reg.peekSeedNote("browser"), "ÖZET", "another seed does not clear it");
  reg.seedDelivered("browser", "ÖZET");
  assert.equal(reg.peekSeedNote("browser"), undefined);
  // The turn that delivered it moves the pointer.
  await reg.turnEnded("browser");
  assert.deepEqual(port.records.at(-1)?.pointer, { provider: "fake", sessionId: "conv-new" });

  const p2 = new FakeProvider();
  const reg2 = new DeviceRegistry({ provider: p2, model: "haiku", startTimeoutMs: 30 });
  const keep = (await reg2.acquire("browser")) as FakeSession;
  keep.seeId("conv-keep");
  p2.autoReady = false;
  assert.equal(await reg2.reseed("browser", "ÖZET"), false);
  assert.equal(reg2.live("browser"), keep);
  assert.equal(keep.isClosed, false);
  assert.equal(p2.sessions[1]?.isClosed, true);
  // The half-started replacement never moved the conversation pointer.
  keep.idleClose();
  p2.autoReady = true;
  await reg2.acquire("browser");
  assert.equal(p2.sessions[2]?.opts.resume, "conv-keep");
});

test("reseed: the candidate never moves the conversation pointer, even when the old session closes meanwhile", async () => {
  const provider = new FakeProvider();
  const reg = new DeviceRegistry({ provider, model: "haiku", startTimeoutMs: 1_000 });
  const old = (await reg.acquire("browser")) as FakeSession;
  old.seeId("conv-old");
  provider.autoReady = false;
  const run = reg.reseed("browser", "ÖZET");
  await tick();
  await tick();
  const fresh = provider.sessions[1] as FakeSession;
  assert.ok(fresh, "candidate opened");
  old.idleClose();
  fresh.seeId("conv-new");
  assert.equal(await reg.fallbackResume("browser"), "conv-old");
  fresh.failStart();
  assert.equal(await run, false);
  provider.autoReady = true;
  await reg.acquire("browser");
  assert.equal(provider.sessions[2]?.opts.resume, "conv-old", "the failed candidate's empty conversation is not resumed");
});

test("brief changed while a session was starting: waiters get a replacement with the new brief (resumed)", async () => {
  const provider = new FakeProvider();
  provider.autoReady = false;
  let brief = "B1";
  const reg = new DeviceRegistry({ provider, model: "haiku", systemAppend: async () => brief });
  reg.prewarm("browser");
  await tick();
  await tick();
  assert.equal(provider.sessions.length, 1);
  const waiter = reg.acquire("browser");
  brief = "B2";
  reg.briefChanged();
  const first = provider.sessions[0] as FakeSession;
  first.seeId("conv-1");
  provider.autoReady = true;
  first.becomeReady();
  const got = await waiter;
  assert.equal(got, provider.sessions[1]);
  assert.equal(provider.sessions.length, 2, "one replacement shared by prewarm and the waiter");
  assert.equal(first.isClosed, true);
  assert.equal(provider.sessions[1]?.opts.systemAppend, "B2");
  assert.equal(provider.sessions[1]?.opts.resume, "conv-1");
  assert.equal(await reg.acquire("browser"), got);
});

test("beginActivity marks the device busy for maintenance (not exclusive); waitHold waits for a hold", async () => {
  const reg = new DeviceRegistry({ provider: new FakeProvider(), model: "haiku" });
  assert.equal(reg.isTurnBusy("browser"), false);
  const a = reg.beginActivity("browser");
  const b = reg.beginActivity("browser");
  assert.equal(reg.isTurnBusy("browser"), true);
  assert.equal(reg.beginTurn("browser"), true, "the turn lock is independent");
  reg.endTurn("browser");
  a();
  a();
  assert.equal(reg.isTurnBusy("browser"), true, "release is idempotent; b still runs");
  b();
  assert.equal(reg.isTurnBusy("browser"), false);

  await reg.waitHold("browser"); // no hold: at once
  let release!: () => void;
  const held = reg.hold("browser", () => new Promise<void>((r) => (release = r)));
  let waited = false;
  const w = reg.waitHold("browser").then(() => (waited = true));
  await tick();
  assert.equal(waited, false);
  release();
  await held;
  await w;
  assert.equal(waited, true);
});
