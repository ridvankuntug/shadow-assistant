/**
 * Runtime configuration: repo-root `.env` + environment + services.yaml.
 * No personal path or address is ever hard-coded; everything comes from env.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIRM_TIMEOUT_MS } from "./permissions.js";
import { loadRouterFile, type CompiledRouterConfig } from "./router-config.js";
import type { TierModels } from "./router.js";
import { findService, loadServicesFile, type ServiceDef, type ServicesConfig } from "./services.js";

/** Repo root: `core/src/..` or `core/dist/..` → two levels up from this module. */
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
/** Core package root (holds prompts/). */
export const CORE_ROOT = fileURLToPath(new URL("../", import.meta.url));

export interface CoreConfig {
  host: string;
  port: number;
  /** Tier 2 model (CORE_MODEL_TIER2, else the pre-T7 CORE_MODEL, else sonnet). */
  model: string;
  /** Models per tier: CORE_MODEL_TIER1/2/3 (defaults haiku / CORE_MODEL or sonnet / opus). */
  models: TierModels;
  /** CORE_ROUTER=off: every turn on `model`, no tier 0, no escalation (pre-T7 behaviour). */
  routerEnabled: boolean;
  /** router.yaml (undefined when the router is off). */
  router?: CompiledRouterConfig;
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

  const routerEnabled = !/^(0|off|false|no)$/i.test(env.CORE_ROUTER?.trim() ?? "");
  const routerFile = env.SHADOW_ROUTER_FILE || join(REPO_ROOT, "router.yaml");
  const router = routerEnabled ? loadRouterFile(routerFile) : undefined;
  const model = env.CORE_MODEL_TIER2?.trim() || env.CORE_MODEL?.trim() || "sonnet";
  const models: TierModels = {
    1: env.CORE_MODEL_TIER1?.trim() || "haiku",
    2: model,
    3: env.CORE_MODEL_TIER3?.trim() || "opus",
  };

  return {
    host: env.CORE_HOST?.trim() || "127.0.0.1",
    port,
    model,
    models,
    routerEnabled,
    router,
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
