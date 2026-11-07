import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import {
  onShutdownSignal,
  runShutdown,
  SHUTDOWN_CLOSE_BUDGET_MS,
  SHUTDOWN_SIGNALS,
  SHUTDOWN_TIMEOUT_MS,
  type ShutdownDeps,
} from "../src/shutdown.js";

test("SIGINT, SIGTERM and SIGBREAK all trigger the shutdown", () => {
  assert.deepEqual([...SHUTDOWN_SIGNALS], ["SIGINT", "SIGTERM", "SIGBREAK"]);
  for (const sig of SHUTDOWN_SIGNALS) {
    const src = new EventEmitter();
    const calls: string[] = [];
    onShutdownSignal(src, SHUTDOWN_SIGNALS, (s) => calls.push(s));
    src.emit(sig);
    assert.deepEqual(calls, [sig]);
  }
});

test("the shutdown runs once when several signals arrive", () => {
  const src = new EventEmitter();
  const calls: string[] = [];
  onShutdownSignal(src, SHUTDOWN_SIGNALS, (s) => calls.push(s));
  src.emit("SIGBREAK");
  src.emit("SIGINT");
  src.emit("SIGTERM");
  src.emit("SIGBREAK");
  assert.deepEqual(calls, ["SIGBREAK"]);
});

test("a repeated signal is left to the default handler (listener removed)", () => {
  const src = new EventEmitter();
  onShutdownSignal(src, SHUTDOWN_SIGNALS, () => {});
  src.emit("SIGINT");
  assert.equal(src.listenerCount("SIGINT"), 0);
  assert.equal(src.listenerCount("SIGTERM"), 1);
});

interface FakeTimer {
  ms: number;
  fire: () => void;
  cancelled: boolean;
}

/** Shutdown deps with fake timers the test fires by hand: `budget` (set first) and `timer` (the forced exit). */
function fakeDeps() {
  const logs: string[] = [];
  const exits: number[] = [];
  const timers: FakeTimer[] = [];
  const deps: ShutdownDeps = {
    log: (m) => logs.push(m),
    exit: (code) => exits.push(code),
    setTimer: (fn, ms) => {
      const t: FakeTimer = { ms, fire: fn, cancelled: false };
      timers.push(t);
      return () => (t.cancelled = true);
    },
  };
  const at = (i: number): FakeTimer => {
    const t = timers[i];
    assert.ok(t, `timer ${i} was not set`);
    return t;
  };
  return {
    deps,
    logs,
    exits,
    get budget() {
      return at(0);
    },
    get timer() {
      return at(1);
    },
  };
}

const tick = () => new Promise((r) => setImmediate(r));
const hang = () => new Promise<void>(() => {});

test("runShutdown: closes in order, then every flush even when one fails; each failure logged; exit(0) once", async () => {
  const f = fakeDeps();
  const { logs, exits } = f;
  const order: string[] = [];
  await runShutdown(
    {
      close: [
        { name: "server", run: async () => void order.push("server") },
        {
          name: "registry",
          run: async () => {
            order.push("registry");
            throw Object.assign(new Error("secret /path"), { code: "EBUSY" });
          },
        },
        { name: "gateway", run: () => void order.push("gateway") },
      ],
      flush: [
        {
          name: "usage log",
          run: () => {
            order.push("usage");
            throw new TypeError("sync throw");
          },
        },
        { name: "learned rules", run: () => Promise.reject(new Error("disk full")) },
        { name: "notifications", run: async () => void order.push("notifications") },
        { name: "absent store", run: () => undefined },
      ],
    },
    f.deps,
  );
  assert.deepEqual(order, ["server", "registry", "gateway", "usage", "notifications"]);
  assert.deepEqual(logs, [
    "[shadow-core] shutdown: registry failed: EBUSY",
    "[shadow-core] shutdown: usage log failed: TypeError",
    "[shadow-core] shutdown: learned rules failed: Error",
  ]);
  // No error message text in the log (it may hold a path).
  assert.ok(logs.every((l) => !l.includes("/path") && !l.includes("disk full")));
  assert.deepEqual(exits, [0]);
  assert.equal(SHUTDOWN_TIMEOUT_MS, 5_000);
  assert.equal(SHUTDOWN_CLOSE_BUDGET_MS, 3_000);
  assert.equal(f.budget.ms, SHUTDOWN_CLOSE_BUDGET_MS);
  assert.equal(f.timer.ms, SHUTDOWN_TIMEOUT_MS);
  assert.equal(f.budget.cancelled, true);
  assert.equal(f.timer.cancelled, true);
  // Late timer callbacks neither log nor exit again.
  f.budget.fire();
  f.timer.fire();
  assert.deepEqual(exits, [0]);
  assert.equal(logs.length, 3);
});

test("runShutdown: flushes run together (a slow flush does not hold back the others)", async () => {
  const { deps, exits } = fakeDeps();
  const started: string[] = [];
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const done = runShutdown(
    {
      close: [],
      flush: [
        { name: "slow", run: () => (started.push("slow"), slow) },
        { name: "fast", run: () => void started.push("fast") },
      ],
    },
    deps,
  );
  await tick();
  assert.deepEqual(started, ["slow", "fast"]);
  assert.deepEqual(exits, []);
  release();
  await done;
  assert.deepEqual(exits, [0]);
});

test("runShutdown: a close step that hangs uses up the close budget; it is logged, later closes are skipped, the flushes still run", async () => {
  const f = fakeDeps();
  const { logs, exits } = f;
  const ran: string[] = [];
  const done = runShutdown(
    {
      close: [
        { name: "maintenance", run: () => void ran.push("maintenance") },
        { name: "server", run: hang },
        { name: "registry", run: () => void ran.push("registry") },
        { name: "gateway", run: () => void ran.push("gateway") },
      ],
      flush: [
        { name: "usage log", run: async () => void ran.push("usage log") },
        { name: "notifications", run: async () => void ran.push("notifications") },
      ],
    },
    { ...f.deps, closeBudgetMs: 1200, timeoutMs: 3400 },
  );
  await tick();
  assert.equal(f.budget.ms, 1200);
  assert.equal(f.timer.ms, 3400);
  assert.deepEqual(ran, ["maintenance"]);
  assert.deepEqual(exits, []);
  f.budget.fire();
  await done;
  assert.deepEqual(logs, ["[shadow-core] shutdown: close still running after 1200 ms (server); skipped: registry, gateway; flushing"]);
  assert.deepEqual(ran, ["maintenance", "usage log", "notifications"]);
  assert.deepEqual(exits, [0]);
  assert.equal(f.timer.cancelled, true);
  // A late forced-exit callback does not exit again.
  f.timer.fire();
  assert.deepEqual(exits, [0]);
});

test("runShutdown: total limit: a hanging close and a hanging flush; the flushes start at the budget, the exit comes once at the timeout", async () => {
  const f = fakeDeps();
  const { logs, exits } = f;
  const ran: string[] = [];
  void runShutdown(
    {
      close: [{ name: "server", run: hang }],
      flush: [
        { name: "turn notes", run: hang },
        { name: "notifications", run: async () => void ran.push("notifications") },
      ],
    },
    f.deps,
  );
  await tick();
  f.budget.fire();
  await tick();
  // The good flush finished; the hanging one keeps the shutdown waiting.
  assert.deepEqual(ran, ["notifications"]);
  assert.deepEqual(exits, []);
  f.timer.fire();
  assert.deepEqual(exits, [0]);
  assert.deepEqual(logs, [
    "[shadow-core] shutdown: close still running after 3000 ms (server); flushing",
    "[shadow-core] shutdown: still running after 5000 ms (server, turn notes); exiting",
  ]);
  f.timer.fire();
  assert.deepEqual(exits, [0]);
});

test("runShutdown: a slow flush that finishes after the forced exit does not call exit a second time", async () => {
  const f = fakeDeps();
  let finishFlush!: () => void;
  const slow = new Promise<void>((resolve) => (finishFlush = resolve));
  const done = runShutdown({ close: [], flush: [{ name: "turn notes", run: () => slow }] }, f.deps);
  await tick();
  f.timer.fire();
  assert.deepEqual(f.exits, [0]);
  finishFlush();
  await done;
  assert.deepEqual(f.exits, [0]);
});

test("runShutdown: a timeout before the close budget exits once and ends the run (budget cancelled, no flush)", async () => {
  const f = fakeDeps();
  const ran: string[] = [];
  const done = runShutdown(
    { close: [{ name: "server", run: hang }], flush: [{ name: "notifications", run: () => void ran.push("notifications") }] },
    { ...f.deps, closeBudgetMs: 9_000, timeoutMs: 1234 },
  );
  await tick();
  f.timer.fire();
  await done;
  assert.deepEqual(f.exits, [0]);
  assert.deepEqual(f.logs, ["[shadow-core] shutdown: still running after 1234 ms (server); exiting"]);
  assert.equal(f.budget.cancelled, true);
  assert.deepEqual(ran, []);
});

test("runShutdown: the real timers: a hanging close still lets the flushes run, then the forced exit (short limits)", async () => {
  const exits: number[] = [];
  const ran: string[] = [];
  void runShutdown(
    {
      close: [{ name: "stuck", run: hang }],
      flush: [
        { name: "notifications", run: () => void ran.push("notifications") },
        { name: "stuck flush", run: hang },
      ],
    },
    { log: () => {}, exit: (c) => exits.push(c), closeBudgetMs: 5, timeoutMs: 20 },
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(ran, ["notifications"]);
  assert.deepEqual(exits, [0]);
});
