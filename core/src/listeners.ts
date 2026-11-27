/**
 * Listener settings beyond `CORE_HOST`/`CORE_PORT` (docs/13 §4.2, T11.6):
 * extra plain addresses and the optional TLS listener with the UI files.
 * Everything here is opt-in: with none of these variables (and no `tls-key`
 * credential) the Core binds `CORE_HOST:CORE_PORT` only, exactly as before.
 *
 * - `CORE_EXTRA_HOSTS`: comma list of further IP addresses the plain listener
 *   binds on `CORE_PORT` (the Pi: `127.0.0.1` next to its LAN address).
 * - `CORE_TLS_HOST`, `CORE_TLS_PORT`: the TLS listener's IP address and port.
 * - `CORE_TLS_CERT_FILE`: PEM certificate (chain) of that address.
 * - The private key (PEM): the systemd credential `tls-key` (also accepted as
 *   `shadow-core.tls-key`), or `CORE_TLS_KEY_FILE` (development/tests); exactly
 *   one of the two.
 * - `CORE_UI_DIR`: the built UI; default `<release root>/ui/dist`.
 *
 * Refused at start (ListenerConfigError, message never holds key material):
 * a partial TLS setting, a host that is not an IP address, a wildcard address
 * (`0.0.0.0`, `::`) for the TLS host or an extra host, a wildcard `CORE_HOST`
 * together with the TLS listener or extra hosts (docs/13 §4.2: nothing listens
 * on all interfaces on the Pi), a missing/unreadable/invalid certificate or
 * key, or a key that does not match the certificate. A wildcard `CORE_HOST`
 * alone stays allowed (the PC Core uses it for the phone at home).
 */
import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import { createSecureContext } from "node:tls";

/** Credential ID of the TLS private key (the file is multi-line PEM, so credentials.ts leaves it alone). */
export const TLS_KEY_CREDENTIAL = "tls-key";
/** The same ID as `ImportCredential=shadow-core.*` would deliver it. */
export const TLS_KEY_CREDENTIAL_PREFIXED = `shadow-core.${TLS_KEY_CREDENTIAL}`;
/** A P-256 certificate chain or key is a few KiB at most. */
export const MAX_TLS_FILE_BYTES = 64 * 1024;
export const TLS_MIN_VERSION = "TLSv1.2" as const;
/** A certificate expiring sooner than this is reported at start (renewal runs 30 days before expiry). */
export const CERT_EXPIRY_WARN_MS = 14 * 24 * 60 * 60 * 1000;

export class ListenerConfigError extends Error {}

export interface TlsListenerConfig {
  host: string;
  port: number;
  cert: Buffer;
  key: Buffer;
  /** Where the key came from, for the start log: `credential tls-key` or `CORE_TLS_KEY_FILE`. */
  keySource: string;
  uiDir: string;
}

export interface ListenerConfig {
  /** Extra plain bind addresses (CORE_HOST itself is not in the list). */
  extraHosts: string[];
  tls?: TlsListenerConfig;
  /** Start-log warnings (certificate expiry, address not in the certificate). */
  warnings: string[];
  /** Credential IDs this module read (left out of credentials.ts's "not read" log line). */
  consumedCredentials: string[];
}

export interface ListenerFs {
  /** File contents; throws an errno error (ENOENT for a missing file). */
  readFile: (path: string) => Buffer;
}

const realFs: ListenerFs = { readFile: (p) => readFileSync(p) };

export interface ListenerConfigOptions {
  /** CORE_HOST as loadConfig resolved it. */
  host: string;
  /** CORE_PORT as loadConfig resolved it. */
  port: number;
  /** $CREDENTIALS_DIRECTORY, when systemd set it. */
  credentialsDir?: string;
  /** Release root (two levels above core/dist): the default UI folder is `<root>/ui/dist`. */
  repoRoot: string;
  fs?: ListenerFs;
  now?: () => number;
}

/** `0.0.0.0`, `::` (any spelling) or the IPv4-mapped `::ffff:0.0.0.0`. */
export function isWildcardAddress(host: string): boolean {
  const h = host.trim();
  if (h === "0.0.0.0") return true;
  if (isIP(h) !== 6) return false;
  const norm = new URL(`http://[${h}]/`).hostname;
  return norm === "[::]" || norm === "[::ffff:0:0]";
}

/** The browser origin of `https://<host>:<port>` (IPv6 in brackets, default port 443 dropped, host lower case). */
export function tlsOrigin(host: string, port: number): string {
  return new URL(`https://${isIP(host) === 6 ? `[${host}]` : host}:${port}/`).origin;
}

/**
 * The Origin rule of the TLS listener's `/ws` (docs/13 §4.1): no `Origin`
 * header (non-browser clients), or one exactly equal to the listener's own
 * origin after normalising scheme, host case and default port. Anything else,
 * including `null`, a different scheme/host/port, a path or credentials in the
 * value, or two Origin headers joined by Node, is refused.
 */
export function originAllowed(header: string | string[] | undefined, own: string): boolean {
  if (header === undefined) return true;
  if (Array.isArray(header) || header.trim() === "") return false;
  const raw = header.trim();
  // A bare serialized origin only (scheme://host[:port]), checked on the raw value: URL parsing
  // would normalise a path such as "/x/.." away. No path (not even "/"), query, fragment, userinfo.
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^/?#@\\\s]+$/i.test(raw)) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return u.origin === own;
}

function set(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

function errCode(err: unknown): string {
  return (err as NodeJS.ErrnoException)?.code ?? "error";
}

function readLimited(fs: ListenerFs, path: string, what: string): Buffer {
  let buf: Buffer;
  try {
    buf = fs.readFile(path);
  } catch (err) {
    throw new ListenerConfigError(`cannot read ${what} (${errCode(err)}); refusing to start`);
  }
  if (buf.length === 0) throw new ListenerConfigError(`${what} is empty; refusing to start`);
  if (buf.length > MAX_TLS_FILE_BYTES) {
    throw new ListenerConfigError(`${what} is larger than ${MAX_TLS_FILE_BYTES} bytes; refusing to start`);
  }
  return buf;
}

/** The key credential's file name in the credentials dir, if present; both spellings at once refuse the start. */
function findKeyCredential(fs: ListenerFs, dir: string | undefined): { id: string; key: Buffer } | undefined {
  if (!dir) return undefined;
  const found: { id: string; key: Buffer }[] = [];
  for (const id of [TLS_KEY_CREDENTIAL, TLS_KEY_CREDENTIAL_PREFIXED]) {
    let buf: Buffer;
    try {
      buf = fs.readFile(join(dir, id));
    } catch (err) {
      if (errCode(err) === "ENOENT") continue;
      throw new ListenerConfigError(`cannot read credential ${id} (${errCode(err)}); refusing to start`);
    }
    found.push({ id, key: buf });
  }
  if (found.length > 1) {
    throw new ListenerConfigError(
      `credential ${TLS_KEY_CREDENTIAL} is delivered twice (${TLS_KEY_CREDENTIAL}, ${TLS_KEY_CREDENTIAL_PREFIXED}); refusing to start`,
    );
  }
  const one = found[0];
  if (!one) return undefined;
  if (one.key.length === 0) throw new ListenerConfigError(`credential ${one.id} is empty; refusing to start`);
  if (one.key.length > MAX_TLS_FILE_BYTES) {
    throw new ListenerConfigError(`credential ${one.id} is larger than ${MAX_TLS_FILE_BYTES} bytes; refusing to start`);
  }
  return one;
}

function parsePort(raw: string): number {
  if (!/^\d+$/.test(raw)) throw new ListenerConfigError("CORE_TLS_PORT must be a port number (1-65535); refusing to start");
  const n = Number(raw);
  if (n < 1 || n > 65535) throw new ListenerConfigError("CORE_TLS_PORT must be a port number (1-65535); refusing to start");
  return n;
}

function parseExtraHosts(raw: string | undefined, coreHost: string): string[] {
  if (raw === undefined) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const h = part.trim();
    if (!h) continue;
    if (!isIP(h)) throw new ListenerConfigError(`CORE_EXTRA_HOSTS: '${h}' is not an IP address; refusing to start`);
    if (isWildcardAddress(h)) {
      throw new ListenerConfigError("CORE_EXTRA_HOSTS must not contain 0.0.0.0 or :: (nothing listens on all interfaces); refusing to start");
    }
    if (h === coreHost || out.includes(h)) {
      throw new ListenerConfigError(`CORE_EXTRA_HOSTS: '${h}' is listed twice (CORE_HOST included); refusing to start`);
    }
    out.push(h);
  }
  return out;
}

/** Reads and checks the listener settings; throws ListenerConfigError with a message safe to log. */
export function loadListenerConfig(env: NodeJS.ProcessEnv, opts: ListenerConfigOptions): ListenerConfig {
  const fs = opts.fs ?? realFs;
  const now = opts.now ?? Date.now;
  const warnings: string[] = [];

  const extraHosts = parseExtraHosts(set(env.CORE_EXTRA_HOSTS), opts.host);
  if (extraHosts.length > 0 && isWildcardAddress(opts.host)) {
    throw new ListenerConfigError("CORE_EXTRA_HOSTS needs a specific CORE_HOST, not 0.0.0.0 or ::; refusing to start");
  }

  const tlsHost = set(env.CORE_TLS_HOST);
  const tlsPort = set(env.CORE_TLS_PORT);
  const certFile = set(env.CORE_TLS_CERT_FILE);
  const keyFile = set(env.CORE_TLS_KEY_FILE);
  const uiDirRaw = set(env.CORE_UI_DIR);
  const keyCred = findKeyCredential(fs, opts.credentialsDir);

  const anyTls = tlsHost ?? tlsPort ?? certFile ?? keyFile ?? uiDirRaw ?? keyCred;
  if (anyTls === undefined) return { extraHosts, warnings, consumedCredentials: [] };

  const missing = [
    ...(tlsHost ? [] : ["CORE_TLS_HOST"]),
    ...(tlsPort ? [] : ["CORE_TLS_PORT"]),
    ...(certFile ? [] : ["CORE_TLS_CERT_FILE"]),
    ...(keyFile || keyCred ? [] : [`the key (credential ${TLS_KEY_CREDENTIAL} or CORE_TLS_KEY_FILE)`]),
  ];
  if (missing.length > 0) {
    throw new ListenerConfigError(`TLS listener partly configured; missing: ${missing.join(", ")}; refusing to start`);
  }
  if (keyFile && keyCred) {
    throw new ListenerConfigError(
      `the TLS key is given twice (credential ${keyCred.id} and CORE_TLS_KEY_FILE); remove CORE_TLS_KEY_FILE; refusing to start`,
    );
  }
  const host = tlsHost as string;
  if (!isIP(host)) throw new ListenerConfigError("CORE_TLS_HOST must be an IP address; refusing to start");
  if (isWildcardAddress(host)) {
    throw new ListenerConfigError("CORE_TLS_HOST must not be 0.0.0.0 or :: (nothing listens on all interfaces); refusing to start");
  }
  if (isWildcardAddress(opts.host)) {
    throw new ListenerConfigError(
      "CORE_HOST must be a specific address (not 0.0.0.0 or ::) when the TLS listener is on; add 127.0.0.1 through CORE_EXTRA_HOSTS; refusing to start",
    );
  }
  const port = parsePort(tlsPort as string);
  if (port === opts.port && (host === opts.host || extraHosts.includes(host))) {
    throw new ListenerConfigError("CORE_TLS_PORT is the plain listener's port on the same address; refusing to start");
  }

  const cert = readLimited(fs, certFile as string, "CORE_TLS_CERT_FILE");
  const key = keyCred ? keyCred.key : readLimited(fs, keyFile as string, "CORE_TLS_KEY_FILE");
  const keySource = keyCred ? `credential ${keyCred.id}` : "CORE_TLS_KEY_FILE";

  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(cert);
  } catch {
    throw new ListenerConfigError("CORE_TLS_CERT_FILE is not a PEM certificate; refusing to start");
  }
  let matches: boolean;
  try {
    matches = x509.checkPrivateKey(createPrivateKey(key));
  } catch {
    // No OpenSSL text here: it could quote a part of the input.
    throw new ListenerConfigError(`the TLS key (${keySource}) is not an unencrypted PEM private key; refusing to start`);
  }
  if (!matches) {
    throw new ListenerConfigError(`the TLS key (${keySource}) does not belong to CORE_TLS_CERT_FILE; refusing to start`);
  }
  try {
    createSecureContext({ cert, key, minVersion: TLS_MIN_VERSION });
  } catch {
    throw new ListenerConfigError("the TLS certificate and key are not usable by Node's TLS; refusing to start");
  }

  const notAfter = Date.parse(x509.validTo);
  const notBefore = Date.parse(x509.validFrom);
  if (now() > notAfter) warnings.push(`TLS certificate expired on ${x509.validTo}; browsers refuse the UI until it is renewed`);
  else if (notAfter - now() < CERT_EXPIRY_WARN_MS) warnings.push(`TLS certificate expires on ${x509.validTo}`);
  if (now() < notBefore) warnings.push(`TLS certificate is not valid before ${x509.validFrom}`);
  if (x509.checkIP(host) === undefined) {
    warnings.push("TLS certificate does not name CORE_TLS_HOST (subjectAltName IP); browsers will refuse it");
  }

  const uiDir = uiDirRaw ? (isAbsolute(uiDirRaw) ? uiDirRaw : resolve(opts.repoRoot, uiDirRaw)) : join(opts.repoRoot, "ui", "dist");
  return {
    extraHosts,
    tls: { host, port, cert, key, keySource, uiDir },
    warnings,
    consumedCredentials: keyCred ? [keyCred.id] : [],
  };
}
