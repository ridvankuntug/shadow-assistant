/**
 * Shadow Assistant Core entry point: loads config, wires the Agent SDK,
 * permission gate, MCP services, speech clients and the WebSocket server.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { SdkAgentRunner, subprocessEnv } from "./agent.js";
import { loadDeviceTokens } from "./auth.js";
import { loadConfig, loadDotEnv, type CoreConfig } from "./config.js";
import { ConversationLog } from "./conversation-log.js";
import { buildHealthTargets, HealthMonitor } from "./health.js";
import { PermissionPolicy } from "./permissions.js";
import { McpDirectClient } from "./mcp-direct.js";
import { checkRouterServices } from "./router-config.js";
import { PassthroughRouter, TieredRouter, type Router } from "./router.js";
import { createCoreServer } from "./server.js";
import { Session, type Logger } from "./session.js";
import { PiperTtsClient, WhisperClient } from "./speech.js";
import { UsageLog } from "./usage-log.js";
import { createVaultMcpServer, VaultReader } from "./vault.js";

const logger: Logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
};

/** MCP servers handed to the SDK for each turn (only enabled services). */
export function buildMcpServers(cfg: CoreConfig, env: NodeJS.ProcessEnv): () => Record<string, McpServerConfig> {
  const remote: Record<string, McpServerConfig> = {};
  for (const svc of cfg.services.services) {
    if (svc.kind !== "mcp" || !svc.enabled || !svc.url) continue;
    const token = svc.tokenEnv ? env[svc.tokenEnv] : undefined;
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined;
    remote[svc.name] =
      svc.transport === "http"
        ? { type: "http", url: svc.url, headers, alwaysLoad: true, timeout: svc.timeoutMs }
        : { type: "sse", url: svc.url, headers, alwaysLoad: true, timeout: svc.timeoutMs };
  }
  const vaultSvc = cfg.services.services.find((s) => s.kind === "vault" && s.enabled);
  const reader =
    vaultSvc && cfg.vaultDir
      ? new VaultReader({ root: cfg.vaultDir, allow: vaultSvc.allow ?? [], maxBytes: vaultSvc.maxBytes })
      : undefined;
  return () => (reader && vaultSvc ? { ...remote, [vaultSvc.name]: createVaultMcpServer(reader, vaultSvc.name) } : remote);
}

export async function main(): Promise<void> {
  const envFile = loadDotEnv();
  const cfg = loadConfig();
  for (const w of cfg.services.warnings) logger.warn(`[shadow-core] services.yaml: ${w}`);

  const tokens = loadDeviceTokens();
  for (const name of tokens.rejected) logger.warn(`[shadow-core] ${name} ignored: shorter than 16 characters`);
  if (tokens.digests.size === 0) {
    throw new Error("no device tokens configured (set at least one DEVICE_TOKEN_<NAME> in .env); refusing to start");
  }

  // Vault tool is disabled without a vault dir.
  const vaultSvc = cfg.services.services.find((s) => s.kind === "vault");
  if (vaultSvc && !cfg.vaultDir) {
    vaultSvc.enabled = false;
    vaultSvc.disabledReason = "SHADOW_VAULT_DIR not set or not a directory";
  }

  const systemPrompt = readFileSync(cfg.systemPromptFile, "utf8");
  const escalationPrompt = readFileSync(join(cfg.systemPromptFile, "..", "tier1.md"), "utf8");
  const log = new ConversationLog(cfg.dataDir);
  await log.ensureDir();

  const policy = new PermissionPolicy(cfg.services.services, { readOnly: cfg.readOnly });
  const agent = new SdkAgentRunner({
    systemPrompt,
    escalationPrompt,
    mcpServers: buildMcpServers(cfg, process.env),
    cwd: join(cfg.dataDir, "agent"),
    env: subprocessEnv(process.env),
    stderr: (line) => logger.warn(`[shadow-core] sdk: ${line.trimEnd()}`),
  });
  const usageLog = new UsageLog(cfg.dataDir);
  let router: Router;
  let direct: McpDirectClient | undefined;
  if (cfg.router) {
    const enabled = cfg.services.services.filter((s) => s.enabled).map((s) => s.name);
    for (const w of checkRouterServices(cfg.router, enabled)) logger.warn(`[shadow-core] router.yaml: ${w}`);
    router = new TieredRouter({ config: cfg.router, models: cfg.models, onUsage: (u) => void usageLog.append(u) });
    direct = cfg.router.direct.enabled ? new McpDirectClient(cfg.services.services, process.env) : undefined;
  } else {
    const passthrough = new PassthroughRouter(cfg.model);
    router = { route: () => passthrough.route(), onUsage: (u) => void usageLog.append(u) };
  }
  const tierServices = cfg.router?.tierServices;
  const stt = new WhisperClient(cfg.whisper?.enabled ? cfg.whisper.url : undefined, cfg.whisper?.timeoutMs);
  const tts = new PiperTtsClient(cfg.tts?.enabled ? cfg.tts.url : undefined, cfg.tts?.timeoutMs);

  // Built after the vault check above so a missing vault dir reads as disabled.
  const monitor = new HealthMonitor(buildHealthTargets(cfg.services.services, process.env, { vaultDir: cfg.vaultDir }), {
    intervalMs: cfg.healthIntervalMs,
    timeoutMs: cfg.healthTimeoutMs,
    logger,
  });

  const server = createCoreServer({
    tokens,
    logger,
    createSession: (info, send) =>
      new Session(
        { agent, policy, router, stt, tts, log, logger, confirmTimeoutMs: cfg.confirmTimeoutMs, direct, tierServices },
        info,
        send,
      ),
    // Name, flag and status only: no URL or token leaves through /health.
    health: () => {
      const status = new Map((monitor.snapshot() ?? []).map((h) => [h.name, h.status]));
      return {
        services: cfg.services.services.map((s) => ({ name: s.name, enabled: s.enabled, status: status.get(s.name) ?? "unknown" })),
      };
    },
    serviceHealth: monitor,
  });
  const { port } = await server.listen(cfg.port, cfg.host);

  logger.info(`[shadow-core] env file: ${envFile ? "loaded" : "not found (using process environment)"}`);
  for (const s of cfg.services.services) {
    logger.info(`[shadow-core] service ${s.name} (${s.kind}): ${s.enabled ? "enabled" : `disabled${s.disabledReason ? ` — ${s.disabledReason}` : ""}`}`);
  }
  logger.info(
    `[shadow-core] router=${cfg.router ? "tiered" : "off"} models=1:${cfg.models[1]},2:${cfg.models[2]},3:${cfg.models[3]}`,
  );
  logger.info(`[shadow-core] model=${cfg.model} readOnly=${cfg.readOnly} devices=${[...tokens.digests.keys()].join(",")}`);
  logger.info(`[shadow-core] listening on ws://${cfg.host}:${port}/ws`);
  monitor.start();
  logger.info(`[shadow-core] health checks every ${cfg.healthIntervalMs} ms (timeout ${cfg.healthTimeoutMs} ms)`);

  const shutdown = () => {
    logger.info("[shadow-core] shutting down");
    void monitor
      .close()
      .then(() => server.close())
      .then(() => direct?.close())
      .then(() => usageLog.flush())
      .then(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((err: Error) => {
  console.error(`[shadow-core] fatal: ${err.message}`);
  process.exit(1);
});
