/**
 * Runtime configuration: repo-root `.env` + environment + services.yaml.
 * No personal path or address is ever hard-coded; everything comes from env.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_HEALTH_INTERVAL_MS, DEFAULT_HEALTH_TIMEOUT_MS } from "./health.js";
import { DEFAULT_CONFIRM_TIMEOUT_MS } from "./permissions.js";
import { EMPTY_LEXICON, parsePronunciations, type Lexicon } from "./pronunciation.js";
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
  /** Service health polling: CORE_HEALTH_INTERVAL_MS (default 30 s) / CORE_HEALTH_TIMEOUT_MS (default 3 s). */
  healthIntervalMs: number;
  healthTimeoutMs: number;
  vaultDir?: string;
  dataDir: string;
  services: ServicesConfig;
  whisper?: ServiceDef;
  tts?: ServiceDef;
  systemPromptFile: string;
  /** TTS pronunciation lexicon: SHADOW_PRONUNCIATIONS_FILE or repo-root pronunciations.yaml. */
  pronunciationsFile: string;
  /** Model sessions (docs/07 A1/A4); see .env.example. */
  agent: AgentConfig;
}

export interface AgentConfig {
  /** CORE_AGENT_PERSISTENT (default on); off = a fresh query per turn (behaviour before 07). */
  persistent: boolean;
  /** CORE_AGENT_PREWARM (default on): start the device's session on `hello`. */
  prewarm: boolean;
  /** CORE_AGENT_IDLE_MIN (default 10): close a device's session after this many idle minutes. */
  idleMin: number;
  /** CORE_TURN_TIMEOUT_MS (default 120000): host-side limit per model attempt. */
  turnTimeoutMs: number;
  /** CORE_CONTINUITY_MIN (default 30): a device continues its conversation within this many minutes, also after a restart. */
  continuityMin: number;
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

/** Default on; `0|off|false|no` turns it off. */
function onByDefault(v: string | undefined): boolean {
  return !/^(0|off|false|no)$/i.test(v?.trim() ?? "");
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
    healthIntervalMs: positiveInt("CORE_HEALTH_INTERVAL_MS", env.CORE_HEALTH_INTERVAL_MS, DEFAULT_HEALTH_INTERVAL_MS),
    healthTimeoutMs: positiveInt("CORE_HEALTH_TIMEOUT_MS", env.CORE_HEALTH_TIMEOUT_MS, DEFAULT_HEALTH_TIMEOUT_MS),
    vaultDir,
    dataDir,
    services,
    whisper: findService(services, "whisper-svc"),
    tts: findService(services, "tts-svc"),
    systemPromptFile: join(CORE_ROOT, "prompts", "system.md"),
    pronunciationsFile: env.SHADOW_PRONUNCIATIONS_FILE || join(REPO_ROOT, "pronunciations.yaml"),
    agent: {
      persistent: onByDefault(env.CORE_AGENT_PERSISTENT),
      prewarm: onByDefault(env.CORE_AGENT_PREWARM),
      idleMin: positiveInt("CORE_AGENT_IDLE_MIN", env.CORE_AGENT_IDLE_MIN, 10),
      turnTimeoutMs: positiveInt("CORE_TURN_TIMEOUT_MS", env.CORE_TURN_TIMEOUT_MS, 120_000),
      continuityMin: positiveInt("CORE_CONTINUITY_MIN", env.CORE_CONTINUITY_MIN, 30),
    },
  };
}

/**
 * Loads the TTS pronunciation lexicon. Never throws: a missing file is an
 * empty lexicon (no warning); an unreadable or invalid file is an empty
 * lexicon plus a warning; bad single entries are dropped with a warning.
 */
export function loadPronunciationsFile(path: string): { lexicon: Lexicon; warnings: string[]; found: boolean } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { lexicon: EMPTY_LEXICON, warnings: [], found: false };
    return { lexicon: EMPTY_LEXICON, warnings: [`cannot read ${path}: ${code ?? "error"}; lexicon disabled`], found: false };
  }
  try {
    return { ...parsePronunciations(text), found: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "invalid file";
    return { lexicon: EMPTY_LEXICON, warnings: [`${msg}; lexicon disabled`], found: true };
  }
}
