import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { onShutdownSignal, SHUTDOWN_SIGNALS } from "../src/shutdown.js";

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
