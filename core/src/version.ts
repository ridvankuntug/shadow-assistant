/**
 * The Core's version, reported by `GET /health` (docs/13 §6.1).
 *
 * The base `X.Y` comes only from the repo-root `VERSION` file. Release packages
 * (T12.1, .github/workflows/core.yml) hold `X.Y.<n>` in their `VERSION`, so a
 * packaged Core reports that; a checkout reports the base `X.Y`. `CORE_VERSION` in the environment
 * overrides the file (same format), so a build or a test can set it without
 * touching the file. A missing or malformed source falls back to
 * DEV_CORE_VERSION, which no release ever uses.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Repo-root `VERSION`: `core/src/..` or `core/dist/..` → two levels up from this module. */
export const VERSION_FILE = fileURLToPath(new URL("../../VERSION", import.meta.url));

/** Reported when neither the environment nor the VERSION file gives a usable version. */
export const DEV_CORE_VERSION = "0.0.0-dev";

/** `X.Y` (the VERSION file) or `X.Y.Z` (a release build). */
const VERSION_RE = /^\d+\.\d+(?:\.\d+)?$/;

export interface CoreVersionSource {
  env?: Readonly<Record<string, string | undefined>>;
  /** Path of the VERSION file (default VERSION_FILE). */
  file?: string;
}

/** The version to report: env `CORE_VERSION`, else the VERSION file's first line, else DEV_CORE_VERSION. */
export function readCoreVersion(src: CoreVersionSource = {}): string {
  const fromEnv = src.env?.CORE_VERSION?.trim();
  if (fromEnv && VERSION_RE.test(fromEnv)) return fromEnv;
  try {
    const first = readFileSync(src.file ?? VERSION_FILE, "utf8").split(/\r?\n/, 1)[0]?.trim() ?? "";
    if (VERSION_RE.test(first)) return first;
  } catch {
    // Missing or unreadable file: the dev value below.
  }
  return DEV_CORE_VERSION;
}

/** `X.Y` of a release version (`X.Y` or `X.Y.Z`); null when it is not one (e.g. DEV_CORE_VERSION, a free-form string). */
export function versionBase(version: string | undefined): string | null {
  const m = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(version?.trim() ?? "");
  return m ? `${Number(m[1])}.${Number(m[2])}` : null;
}

/**
 * The M3 base check (docs/13 §6.1): true only when both versions parse and
 * their `X.Y` differ. Patch numbers are never compared; a missing or
 * unparseable side gives no warning, and a version difference never refuses.
 */
export function versionBaseDiffers(core: string | undefined, client: string | undefined): boolean {
  const a = versionBase(core);
  const b = versionBase(client);
  return a !== null && b !== null && a !== b;
}
