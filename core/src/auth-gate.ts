/**
 * Credential hold-off after a rejected token (T20.1, docs/09 (b)/(c)).
 *
 * Home Assistant counts every rejected credential (an HTTP 401, a WebSocket
 * `auth_invalid`) as a failed login of the sender's IP; with `ip_ban` and a
 * `login_attempts_threshold` set, enough of them ban the Core's IP. A token
 * that HA rejected once is not retried every health round or every reconnect:
 * every caller that sends the same token shares one gate.
 *
 * - Accepted state (start, or after `accepted()`): every attempt may go.
 * - After `rejectedNow()`: no attempt for AUTH_HOLD_START_MS, doubling per
 *   further rejection up to AUTH_HOLD_MAX_MS. When the hold is over,
 *   `tryAttempt()` grants **one** probe for all callers and holds the others
 *   off for the same hold again (a probe that ends without an answer about the
 *   token, e.g. a timeout, waits that long too).
 * - A rejection while a hold runs and no probe was granted (two callers that
 *   started before the first rejection was known) does not lengthen the hold.
 * - `accepted()` (HA took the token) ends the hold at once; listeners are told,
 *   so a caller waiting for the hold can retry right away.
 *
 * The token itself comes from `.env` and is read once at startup: a fixed
 * token takes effect with a Core restart, which also starts a fresh gate. The
 * sparse probes only cover causes on HA's side (a re-activated user, a
 * restored backup, a ban lifted, a proxy that refused for a while).
 */

export const AUTH_HOLD_START_MS = 15 * 60_000;
export const AUTH_HOLD_MAX_MS = 6 * 60 * 60_000;

/** Hold after the `n`-th rejection in a row (1-based): 15 min, 30 min, 1 h … capped at 6 h. */
export function authHoldMs(n: number): number {
  const k = Math.max(1, Math.floor(n));
  return Math.min(AUTH_HOLD_MAX_MS, AUTH_HOLD_START_MS * 2 ** Math.min(k - 1, 16));
}

export class AuthGate {
  /** Rejections in a row since the last acceptance (0 = accepted state). */
  private rejections = 0;
  private holdUntil = 0;
  /** A probe was granted during the current hold and has not been rejected yet. */
  private probing = false;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The token was rejected and has not been accepted since. */
  get rejected(): boolean {
    return this.rejections > 0;
  }

  /** Milliseconds until an attempt may be made (0 = now). */
  waitMs(): number {
    return this.rejections === 0 ? 0 : Math.max(0, this.holdUntil - this.now());
  }

  /**
   * May a credentialed request go now? Always in the accepted state. In the
   * rejected state only once the hold is over, and then only one caller: the
   * hold starts again for the others.
   */
  tryAttempt(): boolean {
    if (this.rejections === 0) return true;
    const now = this.now();
    if (now < this.holdUntil) return false;
    this.holdUntil = now + authHoldMs(this.rejections);
    this.probing = true;
    return true;
  }

  /** HA rejected the token (401/403, `auth_invalid`). */
  rejectedNow(): void {
    const now = this.now();
    // A second caller that started before the first rejection was known: already counted.
    if (this.rejections > 0 && !this.probing && now < this.holdUntil) return;
    this.rejections++;
    this.probing = false;
    this.holdUntil = now + authHoldMs(this.rejections);
  }

  /** HA accepted the token: the hold ends; listeners are told when there was one. */
  accepted(): void {
    const was = this.rejections > 0;
    this.rejections = 0;
    this.holdUntil = 0;
    this.probing = false;
    if (!was) return;
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        // a listener bug must not break the caller
      }
    }
  }

  /** Called after a hold ended by `accepted()`. */
  onAccepted(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
