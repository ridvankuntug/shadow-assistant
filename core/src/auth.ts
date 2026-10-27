/**
 * Per-device token authentication.
 *
 * Tokens come from `DEVICE_TOKEN_<NAME>` environment variables; empty values
 * are ignored. Comparison is constant-time: both sides are hashed to a fixed
 * length first so neither the token length nor the matching prefix leaks, and
 * every configured token is compared on every attempt.
 * Tokens are never logged; only the device name is.
 */
import { createHash, timingSafeEqual } from "node:crypto";

const PREFIX = "DEVICE_TOKEN_";
/** Shortest token we accept; shorter values are treated as misconfiguration. */
export const MIN_TOKEN_LENGTH = 16;

export interface DeviceTokens {
  /** device name (lower-case suffix of the env var) → sha256 digest of the token */
  readonly digests: ReadonlyMap<string, Buffer>;
  /** Names of variables that were set but rejected (too short). */
  readonly rejected: readonly string[];
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export function loadDeviceTokens(env: NodeJS.ProcessEnv = process.env): DeviceTokens {
  const digests = new Map<string, Buffer>();
  const rejected: string[] = [];
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith(PREFIX) || key.length === PREFIX.length) continue;
    const value = (raw ?? "").trim();
    if (value === "") continue;
    if (value.length < MIN_TOKEN_LENGTH) {
      rejected.push(key);
      continue;
    }
    digests.set(key.slice(PREFIX.length).toLowerCase(), digest(value));
  }
  return { digests, rejected };
}

/** Returns the device name for a valid token, or null. */
export function authenticate(tokens: DeviceTokens, presented: unknown): string | null {
  if (typeof presented !== "string" || presented.length === 0 || presented.length > 1024) return null;
  const candidate = digest(presented);
  let match: string | null = null;
  for (const [device, expected] of tokens.digests) {
    // No early exit: compare against every token.
    if (timingSafeEqual(candidate, expected) && match === null) match = device;
  }
  return match;
}
