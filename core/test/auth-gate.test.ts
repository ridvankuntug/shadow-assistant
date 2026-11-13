/**
 * T20.1: the shared hold-off for a rejected token (auth-gate.ts).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTH_HOLD_MAX_MS, AUTH_HOLD_START_MS, AuthGate, authHoldMs } from "../src/auth-gate.js";

const MIN = 60_000;

test("authHoldMs: 15 min doubling, capped at 6 h", () => {
  assert.equal(AUTH_HOLD_START_MS, 15 * MIN);
  assert.equal(AUTH_HOLD_MAX_MS, 360 * MIN);
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 100].map(authHoldMs), [15, 30, 60, 120, 240, 360, 360, 360].map((m) => m * MIN));
  assert.equal(authHoldMs(0), 15 * MIN, "below 1 counts as the first hold");
});

test("accepted state: every attempt goes; a rejection holds every caller off until the hold ends", () => {
  const clock = { now: 0 };
  const gate = new AuthGate(() => clock.now);
  assert.equal(gate.rejected, false);
  assert.equal(gate.tryAttempt(), true);
  assert.equal(gate.tryAttempt(), true);
  assert.equal(gate.waitMs(), 0);

  gate.rejectedNow();
  assert.equal(gate.rejected, true);
  assert.equal(gate.waitMs(), 15 * MIN);
  assert.equal(gate.tryAttempt(), false);
  clock.now += 15 * MIN - 1;
  assert.equal(gate.tryAttempt(), false, "not before the hold ends");
  assert.equal(gate.waitMs(), 1);
  clock.now += 1;
  assert.equal(gate.tryAttempt(), true, "one probe");
  assert.equal(gate.tryAttempt(), false, "only one caller gets the probe");
  assert.equal(gate.waitMs(), 15 * MIN, "the others wait the same hold again");
});

test("a rejected probe doubles the hold; a second caller's rejection inside the first hold does not", () => {
  const clock = { now: 0 };
  const gate = new AuthGate(() => clock.now);
  // Health check and WebSocket client both started before either knew.
  gate.rejectedNow();
  clock.now += 1_000;
  gate.rejectedNow();
  assert.equal(gate.waitMs(), 15 * MIN - 1_000, "not lengthened by the concurrent rejection");

  clock.now = 15 * MIN;
  assert.equal(gate.tryAttempt(), true);
  gate.rejectedNow();
  assert.equal(gate.waitMs(), 30 * MIN, "second rejection in a row");
  clock.now += 30 * MIN;
  assert.equal(gate.tryAttempt(), true);
  gate.rejectedNow();
  assert.equal(gate.waitMs(), 60 * MIN);

  // A probe without an answer about the token (timeout) keeps the current hold length.
  clock.now += 60 * MIN;
  assert.equal(gate.tryAttempt(), true);
  assert.equal(gate.waitMs(), 60 * MIN);
  clock.now += 60 * MIN;
  assert.equal(gate.tryAttempt(), true);
  gate.rejectedNow();
  assert.equal(gate.waitMs(), 120 * MIN);
});

test("accepted() ends the hold at once and tells listeners only when there was one", () => {
  const clock = { now: 0 };
  const gate = new AuthGate(() => clock.now);
  let told = 0;
  const stop = gate.onAccepted(() => told++);
  gate.onAccepted(() => {
    throw new Error("listener bug");
  });
  gate.accepted();
  assert.equal(told, 0, "no hold, nothing to tell");
  gate.rejectedNow();
  gate.accepted();
  assert.equal(told, 1);
  assert.equal(gate.rejected, false);
  assert.equal(gate.tryAttempt(), true);
  gate.rejectedNow();
  assert.equal(gate.waitMs(), 15 * MIN, "the hold starts over after an acceptance");
  stop();
  gate.accepted();
  assert.equal(told, 1, "unsubscribed");
});
