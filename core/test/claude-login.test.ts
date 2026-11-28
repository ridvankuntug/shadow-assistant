/**
 * T20: the Claude login watch (claude-login.ts). The turn-error classifier,
 * the credentials file probe (never keeps a token value), the file location
 * and when the file check is off, and the monitor's inbox item: raise while
 * down, resolve when back, startup reconcile, suppression, store retry, and
 * the turn-error state (cleared by a successful turn or a rewritten file).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  CLAUDE_LOGIN_BODY,
  CLAUDE_LOGIN_INTERVAL_MS,
  CLAUDE_LOGIN_KEY,
  CLAUDE_LOGIN_SOURCE,
  ClaudeLoginMonitor,
  credentialsFile,
  fileCheckOff,
  isLoginError,
  probeCredentials,
  type LoginNotificationPort,
} from "../src/claude-login.js";
import type { RaiseInput, RaiseResult } from "../src/notifications.js";
import type { ProducerTimers } from "../src/service-producer.js";

const base = mkdtempSync(join(tmpdir(), "shadow-claude-login-test-"));
after(() => rmSync(base, { recursive: true, force: true }));

/** A fake secret; it must never show up in a probe result or a log line. */
const SECRET = "sk-ant-ort01-SECRET-REFRESH-VALUE";
let dirs = 0;
function credDir(): string {
  const d = join(base, `c${++dirs}`);
  mkdirSync(d, { recursive: true });
  return d;
}
const writeLogin = (file: string, refreshToken: unknown = SECRET) =>
  writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-ACCESS", refreshToken, expiresAt: 1 } }));

test("isLoginError: only the SDK's authentication_failed is a login problem", () => {
  assert.equal(isLoginError("authentication_failed"), true);
  for (const other of [
    "oauth_org_not_allowed",
    "account_on_hold",
    "verification_required",
    "billing_error",
    "rate_limit",
    "overloaded",
    "invalid_request",
    "model_not_found",
    "server_error",
    "unknown",
    "max_output_tokens",
    "cloud_credential_error",
    undefined,
    "",
  ]) {
    assert.equal(isLoginError(other), false, String(other));
  }
});

test("credentialsFile: CLAUDE_CONFIG_DIR when set (trimmed), else ~/.claude", () => {
  assert.equal(credentialsFile({ CLAUDE_CONFIG_DIR: " /var/lib/x/claude " }, "/home/u"), join("/var/lib/x/claude", ".credentials.json"));
  assert.equal(credentialsFile({}, "/home/u"), join("/home/u", ".claude", ".credentials.json"));
  assert.equal(credentialsFile({ CLAUDE_CONFIG_DIR: "  " }, "/home/u"), join("/home/u", ".claude", ".credentials.json"));
});

test("fileCheckOff: an API key or OAuth token in the environment, or macOS, turns the file check off", () => {
  assert.equal(fileCheckOff({}, "linux"), undefined);
  assert.equal(fileCheckOff({ ANTHROPIC_API_KEY: "" }, "win32"), undefined);
  assert.match(fileCheckOff({ ANTHROPIC_API_KEY: "x" }, "linux") ?? "", /ANTHROPIC_API_KEY/);
  assert.match(fileCheckOff({ CLAUDE_CODE_OAUTH_TOKEN: "x" }, "linux") ?? "", /CLAUDE_CODE_OAUTH_TOKEN/);
  assert.match(fileCheckOff({}, "darwin") ?? "", /Keychain/);
});

test("probeCredentials: missing, not JSON, no / empty refresh token, ok; never returns a token value", async () => {
  const d = credDir();
  const f = join(d, ".credentials.json");
  assert.deepEqual(await probeCredentials(f), { state: "missing" });
  writeFileSync(f, "{not json");
  assert.equal((await probeCredentials(f)).state, "invalid");
  writeFileSync(f, "null");
  assert.equal((await probeCredentials(f)).state, "no_refresh_token");
  writeFileSync(f, JSON.stringify({ other: 1 }));
  assert.equal((await probeCredentials(f)).state, "no_refresh_token");
  writeLogin(f, "");
  assert.equal((await probeCredentials(f)).state, "no_refresh_token");
  writeLogin(f, 42);
  assert.equal((await probeCredentials(f)).state, "no_refresh_token");
  writeLogin(f);
  const ok = await probeCredentials(f);
  assert.equal(ok.state, "ok");
  assert.equal(typeof ok.mtimeMs, "number");
  assert.ok(!JSON.stringify(ok).includes("sk-ant"), "no token in the probe result");
  // A directory in the file's place: unreadable, not missing.
  const d2 = credDir();
  mkdirSync(join(d2, ".credentials.json"));
  assert.equal((await probeCredentials(join(d2, ".credentials.json"))).state, "unreadable");
});

class FakeCenter implements LoginNotificationPort {
  readonly raises: RaiseInput[] = [];
  readonly resolves: string[] = [];
  readonly items = new Set<string>();
  suppressedKeys: Array<{ source: string; key: string }> = [];
  failRaise = false;
  unreadable = false;
  async raise(input: RaiseInput): Promise<RaiseResult> {
    if (this.failRaise) throw new Error("disk");
    this.raises.push(input);
    if (this.suppressedKeys.some((s) => s.source === input.source && s.key === input.key)) return { ok: false, reason: "suppressed" };
    this.items.add(`${input.source}/${input.key}`);
    return { ok: true, item: {} as never, created: true };
  }
  async resolve(source: string, key: string): Promise<boolean> {
    if (this.unreadable) throw new Error("unreadable");
    this.resolves.push(`${source}/${key}`);
    this.suppressedKeys = this.suppressedKeys.filter((s) => !(s.source === source && s.key === key));
    return this.items.delete(`${source}/${key}`);
  }
  async list() {
    if (this.unreadable) throw new Error("unreadable");
    return [...this.items].map((k) => {
      const [source, key] = k.split("/");
      return { source: source!, key };
    });
  }
  async suppressed() {
    return this.suppressedKeys;
  }
}

class FakeTimers implements ProducerTimers {
  readonly pending = new Map<number, { fn: () => void; ms: number }>();
  private n = 0;
  set(fn: () => void, ms: number): unknown {
    this.pending.set(++this.n, { fn, ms });
    return this.n;
  }
  clear(handle: unknown): void {
    this.pending.delete(handle as number);
  }
  /** Delay of the one armed timer. */
  get delay(): number | undefined {
    return [...this.pending.values()].at(-1)?.ms;
  }
}

function monitor(file: string | undefined, center = new FakeCenter()) {
  const logs: string[] = [];
  const timers = new FakeTimers();
  const m = new ClaudeLoginMonitor({
    notifications: center,
    logger: { info: (s) => logs.push(s), warn: (s) => logs.push(s) },
    credentialsFile: file,
    timers,
    // A fixed clock: timer delays are exact.
    now: () => 1_700_000_000_000,
  });
  return { m, center, logs, timers };
}

const ITEM = `${CLAUDE_LOGIN_SOURCE}/${CLAUDE_LOGIN_KEY}`;

test("file missing → one normal item (renotify, Turkish text naming T11.3); repeated checks do not duplicate; the file back → resolved", async () => {
  const f = join(credDir(), ".credentials.json");
  const { m, center, logs, timers } = monitor(f);
  m.start();
  await m.idle();
  assert.equal(m.down, true);
  assert.equal(center.raises.length, 1);
  const r = center.raises[0]!;
  assert.deepEqual([r.source, r.key, r.urgency, r.renotify], [CLAUDE_LOGIN_SOURCE, CLAUDE_LOGIN_KEY, "normal", true]);
  assert.equal(r.body, CLAUDE_LOGIN_BODY);
  assert.match(r.body ?? "", /T11\.3/);
  assert.equal(timers.delay, CLAUDE_LOGIN_INTERVAL_MS, "next check after the interval");
  await m.checkNow();
  assert.equal(center.raises.length, 1, "no second raise while down");
  writeLogin(f);
  await m.checkNow();
  assert.equal(m.down, false);
  assert.deepEqual(center.resolves, [ITEM]);
  assert.equal(center.items.size, 0);
  assert.ok(logs.some((l) => /claude login: down \(credentials missing\)/.test(l)));
  assert.ok(!logs.some((l) => l.includes("sk-ant")), "no token in the log");
  await m.close();
});

test("a turn login error marks down at once though the file is fine; a successful turn marks it back", async () => {
  const f = join(credDir(), ".credentials.json");
  writeLogin(f);
  const { m, center, logs } = monitor(f);
  m.start();
  await m.idle();
  assert.equal(center.raises.length, 0);
  m.turnFailed();
  await m.idle();
  assert.equal(m.down, true);
  assert.equal(center.raises.length, 1);
  assert.ok(logs.some((l) => /down \(turn login error\)/.test(l)));
  // The file unchanged: a regular check keeps it down.
  await m.checkNow();
  assert.equal(m.down, true);
  m.turnSucceeded();
  await m.idle();
  assert.equal(m.down, false);
  assert.deepEqual(center.resolves, [ITEM]);
  await m.close();
});

test("after a turn login error, a rewritten credentials file (new login or refresh) marks the login back", async () => {
  const f = join(credDir(), ".credentials.json");
  writeLogin(f);
  utimesSync(f, new Date(1_000_000), new Date(1_000_000));
  const { m, center } = monitor(f);
  m.start();
  await m.idle();
  m.turnFailed();
  await m.idle();
  assert.equal(m.down, true);
  writeLogin(f);
  utimesSync(f, new Date(2_000_000), new Date(2_000_000));
  await m.checkNow();
  assert.equal(m.down, false);
  assert.deepEqual(center.resolves, [ITEM]);
  await m.close();
});

test("a turn error during a running probe: the older look is no reference, so a rewrite before the error does not clear it", async () => {
  let mtime = 1_000;
  let hold: Promise<void> | undefined;
  let entered: (() => void) | undefined;
  const fs = {
    stat: async () => {
      const seen = mtime;
      if (hold) {
        entered?.();
        await hold;
      }
      return { mtimeMs: seen };
    },
    readFile: async () => JSON.stringify({ claudeAiOauth: { refreshToken: SECRET } }),
  };
  const center = new FakeCenter();
  const m = new ClaudeLoginMonitor({
    notifications: center,
    logger: { info: () => {}, warn: () => {} },
    credentialsFile: "/x/.credentials.json",
    timers: new FakeTimers(),
    now: () => 1_700_000_000_000,
    fs,
  });
  m.start();
  await m.idle();
  // A regular check reads the old mtime and waits; the CLI rewrites the file; then the turn fails.
  let release!: () => void;
  hold = new Promise<void>((r) => (release = r));
  const inProbe = new Promise<void>((r) => (entered = r));
  const check = m.checkNow();
  await inProbe;
  hold = undefined;
  mtime = 2_000;
  m.turnFailed();
  release();
  await check;
  await m.idle();
  assert.equal(m.down, true, "still down: the file did not change after the error");
  await m.checkNow();
  assert.equal(m.down, true);
  assert.equal(center.resolves.length, 0);
  mtime = 3_000; // rewritten after the error
  await m.checkNow();
  assert.equal(m.down, false);
  await m.close();
});

test("file check off: only turns count (a turn error stays down until a successful turn)", async () => {
  const { m, center, timers } = monitor(undefined);
  m.start();
  await m.idle();
  assert.equal(m.down, false);
  assert.equal(timers.delay, CLAUDE_LOGIN_INTERVAL_MS);
  m.turnFailed();
  await m.idle();
  await m.checkNow();
  assert.equal(m.down, true);
  assert.equal(center.raises.length, 1);
  m.turnSucceeded();
  await m.idle();
  assert.equal(center.resolves.length, 1);
  await m.close();
});

test("startup reconcile: an existing item is adopted (not raised again) and resolved when the login works", async () => {
  const missing = join(credDir(), ".credentials.json");
  const center = new FakeCenter();
  center.items.add(ITEM);
  const a = monitor(missing, center);
  a.m.start();
  await a.m.idle();
  assert.equal(center.raises.length, 0, "a restart while down does not duplicate the item");
  await a.m.close();

  const okFile = join(credDir(), ".credentials.json");
  writeLogin(okFile);
  const b = monitor(okFile, center);
  b.m.start();
  await b.m.idle();
  assert.equal(center.raises.length, 0);
  assert.deepEqual(center.resolves, [ITEM]);
  await b.m.close();
});

test("suppressed (Tekrar gösterme): a suppressed raise counts as open, and the recovery resolves it (clearing the suppression)", async () => {
  const f = join(credDir(), ".credentials.json");
  const center = new FakeCenter();
  const { m } = monitor(f, center);
  m.start();
  await m.idle();
  // Suppressed after the raise: the next outage's raise is answered `suppressed`.
  writeLogin(f);
  await m.checkNow();
  center.suppressedKeys = [{ source: CLAUDE_LOGIN_SOURCE, key: CLAUDE_LOGIN_KEY }];
  rmSync(f);
  await m.checkNow();
  assert.equal(center.items.size, 0, "nothing shown");
  await m.checkNow();
  assert.equal(center.raises.length, 2, "not raised again while suppressed");
  writeLogin(f);
  await m.checkNow();
  assert.equal(center.resolves.length, 2);
  assert.deepEqual(center.suppressedKeys, []);
  await m.close();
});

test("startup: a suppressed key is adopted as open, so a working login resolves it", async () => {
  const f = join(credDir(), ".credentials.json");
  writeLogin(f);
  const center = new FakeCenter();
  center.suppressedKeys = [{ source: CLAUDE_LOGIN_SOURCE, key: CLAUDE_LOGIN_KEY }];
  const { m } = monitor(f, center);
  m.start();
  await m.idle();
  assert.deepEqual(center.resolves, [ITEM]);
  await m.close();
});

test("a failed raise is retried after 60 s; an unreadable inbox at startup too", async () => {
  const f = join(credDir(), ".credentials.json");
  const center = new FakeCenter();
  center.failRaise = true;
  const { m, timers } = monitor(f, center);
  m.start();
  await m.idle();
  assert.equal(timers.delay, 60_000);
  center.failRaise = false;
  await m.checkNow();
  assert.equal(center.raises.length, 1);
  assert.equal(timers.delay, CLAUDE_LOGIN_INTERVAL_MS);
  await m.close();

  const c2 = new FakeCenter();
  c2.unreadable = true;
  const b = monitor(f, c2);
  b.m.start();
  await b.m.idle();
  assert.equal(b.timers.delay, 60_000);
  assert.equal(c2.raises.length, 0, "no raise before the reconcile");
  c2.unreadable = false;
  await b.m.checkNow();
  assert.equal(c2.raises.length, 1);
  await b.m.close();
});

test("close stops the timer; checks after close do nothing", async () => {
  const { m, timers, center } = monitor(undefined);
  m.start();
  await m.idle();
  await m.close();
  assert.equal(timers.pending.size, 0);
  m.turnFailed();
  await m.checkNow();
  assert.equal(center.raises.length, 0);
});
