/**
 * Secrets from systemd credentials (docs/13 §7.1, T11.2).
 *
 * Opt-in: only when `CREDENTIALS_DIRECTORY` is set (systemd sets it for a unit
 * with `LoadCredential=` / `ImportCredential=`). Without it the Core reads its
 * secrets from the environment / `.env` exactly as before (Windows PC Core).
 *
 * Naming: a credential's ID is the environment variable it stands for
 * (`DEVICE_TOKEN_PHONE`, `HA_CORE_TOKEN`, `CORE_AGENT_TOKEN`, any services.yaml
 * `token_env`), optionally with the prefix `shadow-core.` (the ID
 * `ImportCredential=shadow-core.*` produces), which is stripped. So the reader
 * is generic: a new secret needs a credential file, no new parsing.
 *
 * Rules:
 * - IDs that are not upper-case variable names after the prefix (e.g. a TLS key
 *   or a deploy key, read by their own code) are ignored and reported by name.
 * - One trailing newline (`\n` or `\r\n`) is removed. An empty value, a value
 *   with another line break, or a file over MAX_CREDENTIAL_BYTES refuses the start.
 * - A name set (non-blank) both in the environment and as a credential, or
 *   delivered twice (with and without the prefix), refuses the start: one
 *   source per secret, never a silent winner.
 * - Values are never logged and never copied into `process.env`; the caller
 *   gets a separate env object for the Core's own consumers, while child
 *   processes keep getting `subprocessEnv(process.env)` (agent.ts), which also
 *   drops `CREDENTIALS_DIRECTORY`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CREDENTIAL_PREFIX = "shadow-core.";
/** Same cap as wake-svc's token file: a token is far shorter. */
export const MAX_CREDENTIAL_BYTES = 4096;
const NAME_RE = /^[A-Z][A-Z0-9_]*$/;

export class CredentialsError extends Error {}

export interface CredentialsFs {
  readdir: (dir: string) => { name: string; isFile: boolean }[];
  readFile: (path: string) => Buffer;
}

const realFs: CredentialsFs = {
  readdir: (dir) => readdirSync(dir, { withFileTypes: true }).map((d) => ({ name: d.name, isFile: d.isFile() })),
  readFile: (path) => readFileSync(path),
};

export interface LoadedCredentials {
  /** The env for the Core's own consumers: `env` itself without a credentials dir, else a copy plus the secrets. */
  env: NodeJS.ProcessEnv;
  /** Variable names taken from credentials, sorted (never values). */
  loaded: string[];
  /** Credential IDs that are not variable names (left to their own readers), sorted. */
  ignored: string[];
  /** The credentials dir, when one was used. */
  dir?: string;
}

function errMessage(err: unknown): string {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code ?? (err as Error)?.message ?? String(err);
}

/** Value of one credential file: one trailing newline removed; anything odd throws (without the value). */
export function credentialValue(id: string, raw: Buffer): string {
  if (raw.length > MAX_CREDENTIAL_BYTES) {
    throw new CredentialsError(`credential ${id} is larger than ${MAX_CREDENTIAL_BYTES} bytes; refusing to start`);
  }
  let value = raw.toString("utf8");
  if (value.endsWith("\r\n")) value = value.slice(0, -2);
  else if (value.endsWith("\n")) value = value.slice(0, -1);
  if (/[\r\n]/.test(value)) throw new CredentialsError(`credential ${id} has more than one line; refusing to start`);
  if (value.trim() === "") throw new CredentialsError(`credential ${id} is empty; refusing to start`);
  return value;
}

export function loadCredentials(env: NodeJS.ProcessEnv = process.env, fs: CredentialsFs = realFs): LoadedCredentials {
  const dir = env.CREDENTIALS_DIRECTORY?.trim();
  if (!dir) return { env, loaded: [], ignored: [] };

  let entries: { name: string; isFile: boolean }[];
  try {
    entries = fs.readdir(dir);
  } catch (err) {
    throw new CredentialsError(`cannot read CREDENTIALS_DIRECTORY (${errMessage(err)}); refusing to start`);
  }

  const secrets = new Map<string, string>();
  /** variable name -> credential ID it came from, to report a double delivery. */
  const source = new Map<string, string>();
  const ignored: string[] = [];
  for (const entry of entries) {
    // systemd puts plain files there; anything else is not ours.
    if (!entry.isFile) {
      ignored.push(entry.name);
      continue;
    }
    const name = entry.name.startsWith(CREDENTIAL_PREFIX) ? entry.name.slice(CREDENTIAL_PREFIX.length) : entry.name;
    if (!NAME_RE.test(name)) {
      ignored.push(entry.name);
      continue;
    }
    const earlier = source.get(name);
    if (earlier !== undefined) {
      throw new CredentialsError(`credential ${name} is delivered twice (${earlier}, ${entry.name}); refusing to start`);
    }
    const preset = env[name];
    if (preset !== undefined && preset.trim() !== "") {
      throw new CredentialsError(
        `${name} is set both in the environment and as a credential; remove it from the environment (env file / .env); refusing to start`,
      );
    }
    let raw: Buffer;
    try {
      raw = fs.readFile(join(dir, entry.name));
    } catch (err) {
      throw new CredentialsError(`cannot read credential ${entry.name} (${errMessage(err)}); refusing to start`);
    }
    secrets.set(name, credentialValue(entry.name, raw));
    source.set(name, entry.name);
  }

  const out: NodeJS.ProcessEnv = { ...env };
  for (const [k, v] of secrets) out[k] = v;
  return { env: out, loaded: [...secrets.keys()].sort(), ignored: ignored.sort(), dir };
}
