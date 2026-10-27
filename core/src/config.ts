/**
 * Runtime configuration: repo-root `.env` + environment + services.yaml.
 * No personal path or address is ever hard-coded; everything comes from env.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIRM_TIMEOUT_MS } from "./permissions.js";
import { findService, loadServicesFile, type ServiceDef, type ServicesConfig } from "./services.js";

/** Repo root: `core/src/..` or `core/dist/..` → two levels up from this module. */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** Core package root (holds prompts/). */
export const CORE_ROOT = fileURLToPath(new URL("../", import.meta.url));

export interface CoreConfig {
  host: string;
  port: number;
  model: string;
  readOnly: boolean;
  confirmTimeoutMs: number;
  vaultDir?: string;
  dataDir: string;
  services: ServicesConfig;
  whisper?: ServiceDef;
  tts?: ServiceDef;
  systemPromptFile: string;
}

/**
 * Loads `.env` (SHADOW_ENV_FILE or repo root) into process.env. Variables that
 * are already set in the real environment win over the file.
 */
export function loadDotEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env.SHADOW_ENV_FILE || join(REPO_ROOT, ".env");
  if (!existsSync(file)) return undefined;
  process.loadEnvFile(file);
  return file;
}

function flag(v: string | undefined): boolean {
  return v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());
}

function positiveInt(name: string, v: string | undefined, def: number): number {
  if (v === undefined || v.trim() === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CoreConfig {
  const port = positiveInt("CORE_PORT", env.CORE_PORT, 8700);
  if (port > 65535) throw new Error("CORE_PORT must be <= 65535");

  let vaultDir: string | undefined;
  if (env.SHADOW_VAULT_DIR && env.SHADOW_VAULT_DIR.trim() !== "") {
    const v = resolve(env.SHADOW_VAULT_DIR.trim());
    if (existsSync(v) && statSync(v).isDirectory()) vaultDir = v;
  }
  const dataRaw = env.SHADOW_DATA_DIR?.trim();
  const dataDir = dataRaw
    ? isAbsolute(dataRaw)
      ? dataRaw
      : resolve(REPO_ROOT, dataRaw)
    : join(vaultDir ?? REPO_ROOT, ".shadow-assistant");

  const servicesFile = env.SHADOW_SERVICES_FILE || join(REPO_ROOT, "services.yaml");
  const services = loadServicesFile(servicesFile, env);

  return {
    host: env.CORE_HOST?.trim() || "127.0.0.1",
    port,
    model: env.CORE_MODEL?.trim() || "sonnet",
    readOnly: flag(env.CORE_READ_ONLY),
    confirmTimeoutMs: positiveInt("CORE_CONFIRM_TIMEOUT_MS", env.CORE_CONFIRM_TIMEOUT_MS, DEFAULT_CONFIRM_TIMEOUT_MS),
    vaultDir,
    dataDir,
    services,
    whisper: findService(services, "whisper-svc"),
    tts: findService(services, "tts-svc"),
    systemPromptFile: join(CORE_ROOT, "prompts", "system.md"),
  };
}
