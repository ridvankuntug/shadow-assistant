/**
 * Claude login watch (T20, decision K6): tells the user, while an app is open,
 * that the Core's Claude login must be renewed. No push (FCM): the warning is
 * an inbox item and, on a failed turn, a chat error.
 *
 * Two signals, neither spends model tokens:
 *
 * - **Turn errors.** The CLI reports a rejected login (not logged in, expired
 *   or revoked token, invalid credentials) as a synthetic assistant message
 *   whose structured `error` field is `authentication_failed`
 *   (`SDKAssistantMessageError`). `isLoginError` classifies it; agent.ts sets
 *   `TurnResult.errorKind = "login"` and the session calls `turnFailed()`.
 *   Rate limits, overload, network and API errors carry other values and are
 *   not login problems. A later successful turn calls `turnSucceeded()`.
 *   Background one-shot calls (memory; device-agent.ts `ClaudeSdkProvider.oneShot`)
 *   report the same way, without a chat message.
 * - **Regular check** every `CLAUDE_LOGIN_INTERVAL_MS`: the CLI's
 *   `.credentials.json` in `CLAUDE_CONFIG_DIR` (default `~/.claude`) is
 *   missing, unreadable, not JSON, or holds no refresh token → login down.
 *   The CLI refreshes the access token itself, so an expired access token is
 *   not a problem; only the refresh token matters. A revoked token cannot be
 *   seen offline: that case comes from a turn error. After a turn error the
 *   login counts as back when a turn succeeds, or when the credentials file
 *   was rewritten since the error (its mtime changed: a new `/login`, or a
 *   successful token refresh by the CLI).
 *
 * The file check is off where the file is not the login: `ANTHROPIC_API_KEY`
 * or `CLAUDE_CODE_OAUTH_TOKEN` set, or macOS (Keychain). Turn errors still count.
 *
 * Inbox: one keyed item (source `claude-login`, key `login`, normal) while
 * down; resolved when the login works again. Startup reconcile adopts an
 * existing item, so a restart does not duplicate it; a suppressed key
 * ("Tekrar gösterme") counts as open, so the recovery still resolves it (which
 * clears the suppression). A failed store call is retried after RETRY_MS.
 * State is in memory: a turn-error "down" does not survive a restart (the
 * adopted item is resolved if the file check passes; the next failing turn
 * raises it again).
 *
 * Token values are never logged, stored or kept: the file is parsed, the
 * refresh token's presence is checked, and the parsed object is dropped.
 */
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { NotificationItem, RaiseInput, RaiseResult } from "./notifications.js";
import type { ProducerTimers } from "./service-producer.js";
import type { Logger } from "./session.js";

export const CLAUDE_LOGIN_SOURCE = "claude-login";
export const CLAUDE_LOGIN_KEY = "login";
/** The file check reads one small local file; minutes are enough (a turn error marks it down at once). */
export const CLAUDE_LOGIN_INTERVAL_MS = 5 * 60_000;
/** Retry delay after a failed store call or an unreadable inbox at startup. */
const RETRY_MS = 60_000;

export const CLAUDE_LOGIN_TITLE = "Claude oturumu yenilenmeli";
export const CLAUDE_LOGIN_BODY =
  "Çekirdeğin Claude girişi yok, süresi dolmuş ya da geçersiz; model şu an cevap veremiyor. " +
  "Pi'de kurulum belgesindeki (docs/05, \"Claude login\") T11.3 adımıyla yeniden giriş yap. " +
  "Oturum düzelince bu bildirim kendiliğinden kapanır.";
/** The chat error text of a turn that failed on the login (code `model_login`). */
export const CLAUDE_LOGIN_TURN_MESSAGE =
  "Claude oturumu kapalı ya da süresi dolmuş; bu isteğe cevap verilemedi. " +
  "Pi'deki Claude girişinin yenilenmesi gerekiyor (kurulum belgesi, T11.3 adımı).";

/**
 * True when the SDK's structured assistant error means the login itself was
 * rejected. Only `authentication_failed`: the CLI uses it for "not logged in",
 * an expired or revoked OAuth token and invalid credentials. Account states
 * that a new login does not fix (`oauth_org_not_allowed`, `account_on_hold`,
 * `verification_required`, `billing_error`) and transient errors
 * (`rate_limit`, `overloaded`, `server_error`, …) are not login problems.
 */
export function isLoginError(error: string | undefined): boolean {
  return error === "authentication_failed";
}

/** The CLI's login file: `$CLAUDE_CONFIG_DIR/.credentials.json`, else `~/.claude/.credentials.json`. */
export function credentialsFile(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  return join(dir ? dir : join(home, ".claude"), ".credentials.json");
}

/** Why the file check is off (the file is not the login), or undefined when it runs. */
export function fileCheckOff(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string | undefined {
  if (env.ANTHROPIC_API_KEY?.trim()) return "ANTHROPIC_API_KEY is set";
  if (env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) return "CLAUDE_CODE_OAUTH_TOKEN is set";
  if (platform === "darwin") return "macOS keeps the login in the Keychain";
  return undefined;
}

export type CredentialsState = "ok" | "missing" | "unreadable" | "invalid" | "no_refresh_token";

export interface CredentialsProbe {
  state: CredentialsState;
  /** The file's mtime when it could be stat'ed (detects a rewrite after a turn error). */
  mtimeMs?: number;
}

export interface CredentialsFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  stat(path: string): Promise<{ mtimeMs: number }>;
}

const nodeFs: CredentialsFs = { readFile: (p, e) => readFile(p, e), stat: (p) => stat(p) };

/** Checks the login file without keeping or returning any token value. */
export async function probeCredentials(file: string, fs: CredentialsFs = nodeFs): Promise<CredentialsProbe> {
  let mtimeMs: number | undefined;
  let text: string;
  try {
    mtimeMs = (await fs.stat(file)).mtimeMs;
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === "ENOENT" || code === "ENOTDIR" ? { state: "missing" } : { state: "unreadable", ...(mtimeMs !== undefined ? { mtimeMs } : {}) };
  }
  let present: boolean;
  try {
    const oauth = (JSON.parse(text) as { claudeAiOauth?: { refreshToken?: unknown } } | null)?.claudeAiOauth;
    present = typeof oauth?.refreshToken === "string" && oauth.refreshToken.length > 0;
  } catch {
    return { state: "invalid", mtimeMs };
  }
  return { state: present ? "ok" : "no_refresh_token", mtimeMs };
}

/** What the watch needs from NotificationCenter (raise / resolve) and the store (startup adoption). */
export interface LoginNotificationPort {
  raise(input: RaiseInput): Promise<RaiseResult>;
  /** Rejects when the inbox cannot be read; retried later. */
  resolve(source: string, key: string): Promise<boolean>;
  /** Every item (any source); rejects when the inbox cannot be read. */
  list(): Promise<ReadonlyArray<Pick<NotificationItem, "source" | "key">>>;
  /** Suppressed keys; absent = none. Rejects when unreadable (re-read after RETRY_MS). */
  suppressed?(): Promise<ReadonlyArray<{ source: string; key: string }>>;
}

/** The reporting side: session.ts `SessionDeps.modelLogin` and device-agent.ts `ClaudeSdkProviderOptions.modelLogin`. */
export interface ModelLoginWatch {
  /** A model turn failed because the login was rejected. */
  turnFailed(): void;
  /** A model turn ended normally (the login works). */
  turnSucceeded(): void;
}

export interface ClaudeLoginMonitorOptions {
  notifications: LoginNotificationPort;
  logger: Logger;
  /** The login file; undefined = no file check (see `fileCheckOff`). */
  credentialsFile: string | undefined;
  intervalMs?: number;
  now?: () => number;
  /** Test hooks. */
  timers?: ProducerTimers;
  fs?: CredentialsFs;
}

const defaultTimers: ProducerTimers = {
  set(fn, ms) {
    const t = setTimeout(fn, ms);
    // The HTTP server keeps the process alive; the check alone must not.
    t.unref?.();
    return t;
  },
  clear(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export class ClaudeLoginMonitor implements ModelLoginWatch {
  readonly intervalMs: number;
  private readonly now: () => number;
  private readonly timers: ProducerTimers;
  /** A turn failed on the login and nothing since showed it works again. */
  private turnDown = false;
  /** The file's mtime seen first after the turn error (null: no file then); undefined = not yet seen. */
  private turnMtime: number | null | undefined;
  /** Counts `turnFailed()` calls: a probe started before the latest one cannot be its reference. */
  private turnGen = 0;
  /** The item is in the inbox (or suppressed): the recovery must resolve it. */
  private open = false;
  /** Last logged state, for one log line per change. */
  private lastReason: string | undefined;
  private adopted = false;
  private loggedAdoptFailure = false;
  private suppressedAdopted = false;
  private loggedSuppressedFailure = false;
  private timer: unknown;
  private running: Promise<void> | null = null;
  private again = false;
  private started = false;
  private closed = false;

  constructor(private readonly o: ClaudeLoginMonitorOptions) {
    this.intervalMs = o.intervalMs ?? CLAUDE_LOGIN_INTERVAL_MS;
    this.now = o.now ?? Date.now;
    this.timers = o.timers ?? defaultTimers;
  }

  /** Whether the login counts as down after the last check (test hook). */
  get down(): boolean {
    return this.lastReason !== undefined && this.lastReason !== "ok";
  }

  /** Startup adoption, the first check, then one check per interval. */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    void this.checkNow();
  }

  turnFailed(): void {
    this.turnDown = true;
    this.turnGen++;
    this.turnMtime = undefined; // the next check records the file as it is now
    if (this.started) void this.checkNow();
  }

  turnSucceeded(): void {
    if (!this.turnDown) return;
    this.turnDown = false;
    this.turnMtime = undefined;
    if (this.started) void this.checkNow();
  }

  /** Checks now; while one runs, it runs once more afterwards. Never rejects. */
  checkNow(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        let next = this.now() + this.intervalMs;
        try {
          const retry = await this.round();
          if (retry !== undefined) next = Math.min(next, retry);
        } catch (err) {
          this.o.logger.warn(`[shadow-core] claude login: check failed (${(err as Error)?.name ?? "error"})`);
          next = this.now() + RETRY_MS;
        }
        this.arm(next);
      } while (this.again && !this.closed);
      this.running = null;
    })();
    return this.running;
  }

  /** Resolves when no check is running (test hook). */
  async idle(): Promise<void> {
    while (this.running) await this.running;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.disarm();
    await this.running;
  }

  /** One check; returns an earlier deadline when a store call must be retried. */
  private async round(): Promise<number | undefined> {
    if (!this.adopted && !(await this.adopt())) return this.now() + RETRY_MS;
    let retry: number | undefined;
    if (!this.suppressedAdopted && !(await this.adoptSuppressed())) retry = this.now() + RETRY_MS;

    const gen = this.turnGen;
    const probe = this.o.credentialsFile !== undefined ? await probeCredentials(this.o.credentialsFile, this.o.fs) : undefined;
    if (this.turnDown && probe) {
      const mtime = probe.mtimeMs ?? null;
      // A turn error that arrived while this probe ran: the file may have changed before it,
      // so this (older) look is no reference; the rerun (`again`) records one.
      if (this.turnMtime === undefined) {
        if (gen === this.turnGen) this.turnMtime = mtime;
      }
      else if (probe.state === "ok" && mtime !== this.turnMtime) {
        // Rewritten since the error: a new login or a successful refresh by the CLI.
        this.turnDown = false;
        this.turnMtime = undefined;
        this.o.logger.info("[shadow-core] claude login: credentials file rewritten since the login error");
      }
    }
    const reason = probe && probe.state !== "ok" ? `credentials ${probe.state}` : this.turnDown ? "turn login error" : "ok";
    if (reason !== this.lastReason) {
      if (reason === "ok") this.o.logger.info("[shadow-core] claude login: ok");
      else this.o.logger.warn(`[shadow-core] claude login: down (${reason})`);
      this.lastReason = reason;
    }
    const storeRetry = reason === "ok" ? await this.resolve() : await this.raise();
    return storeRetry === undefined ? retry : retry === undefined ? storeRetry : Math.min(retry, storeRetry);
  }

  /** Startup reconcile: an existing item counts as open. False when the inbox could not be read. */
  private async adopt(): Promise<boolean> {
    let items: Awaited<ReturnType<LoginNotificationPort["list"]>>;
    try {
      items = await this.o.notifications.list();
    } catch {
      if (!this.loggedAdoptFailure) {
        this.loggedAdoptFailure = true;
        this.o.logger.warn("[shadow-core] claude login: notifications unreadable; startup reconcile retried later");
      }
      return false;
    }
    if (items.some((i) => i.source === CLAUDE_LOGIN_SOURCE && i.key === CLAUDE_LOGIN_KEY)) this.open = true;
    this.adopted = true;
    return true;
  }

  /** A suppressed key counts as open (its recovery resolves it, clearing the suppression). */
  private async adoptSuppressed(): Promise<boolean> {
    let suppressed: Awaited<ReturnType<NonNullable<LoginNotificationPort["suppressed"]>>>;
    try {
      suppressed = (await this.o.notifications.suppressed?.()) ?? [];
    } catch {
      if (!this.loggedSuppressedFailure) {
        this.loggedSuppressedFailure = true;
        this.o.logger.warn("[shadow-core] claude login: suppression list (suppressed.json) unreadable; re-read later");
      }
      return false;
    }
    if (suppressed.some((s) => s.source === CLAUDE_LOGIN_SOURCE && s.key === CLAUDE_LOGIN_KEY)) this.open = true;
    this.suppressedAdopted = true;
    return true;
  }

  /** Raises the item once per outage (fixed text: nothing to update). Returns a retry deadline on failure. */
  private async raise(): Promise<number | undefined> {
    if (this.open) return undefined;
    let r: RaiseResult;
    try {
      r = await this.o.notifications.raise({
        source: CLAUDE_LOGIN_SOURCE,
        key: CLAUDE_LOGIN_KEY,
        urgency: "normal",
        title: CLAUDE_LOGIN_TITLE,
        body: CLAUDE_LOGIN_BODY,
        renotify: true,
      });
    } catch {
      return this.now() + RETRY_MS;
    }
    if (!r.ok && r.reason !== "suppressed") {
      if (r.reason !== "unavailable") this.o.logger.warn(`[shadow-core] claude login: raise refused (${r.reason})`);
      return this.now() + RETRY_MS;
    }
    this.open = true;
    this.o.logger.info(`[shadow-core] claude login: notification ${r.ok ? "raised" : "suppressed by the user; not shown until it resolves"}`);
    return undefined;
  }

  private async resolve(): Promise<number | undefined> {
    if (!this.open) return undefined;
    try {
      await this.o.notifications.resolve(CLAUDE_LOGIN_SOURCE, CLAUDE_LOGIN_KEY);
    } catch {
      return this.now() + RETRY_MS;
    }
    this.open = false;
    this.o.logger.info("[shadow-core] claude login: notification resolved");
    return undefined;
  }

  private arm(at: number): void {
    this.disarm();
    if (this.closed) return;
    this.timer = this.timers.set(() => {
      this.timer = undefined;
      void this.checkNow();
    }, Math.max(0, at - this.now()));
  }

  private disarm(): void {
    if (this.timer !== undefined) this.timers.clear(this.timer);
    this.timer = undefined;
  }
}
