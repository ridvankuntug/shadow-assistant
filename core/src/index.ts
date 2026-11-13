/**
 * Shadow Assistant Core entry point: loads config, wires the Agent SDK,
 * permission gate, MCP services, speech clients and the WebSocket server.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getSessionInfo, query } from "@anthropic-ai/claude-agent-sdk";
import { SdkAgentRunner, subprocessEnv } from "./agent.js";
import { loadDeviceTokens } from "./auth.js";
import { loadConfig, loadDotEnv, loadPronunciationsFile, type CoreConfig } from "./config.js";
import { ContinuityStore, continuityFilePath } from "./continuity.js";
import { ConversationLog } from "./conversation-log.js";
import { DevNotes, TurnNotes } from "./dev-notes.js";
import { ClaudeSdkProvider, RestartBackoff } from "./device-agent.js";
import { DEVICE_SERVICE_NAME, DeviceStateStore, deviceStateService, isUsableDeviceName } from "./device-state.js";
import { continuityPort, DeviceRegistry } from "./device-registry.js";
import { BackupProducer, backupStatusPath } from "./backup-producer.js";
import { ServiceProducer } from "./service-producer.js";
import { AuthGate } from "./auth-gate.js";
import { createHaAlerts } from "./ha-producer.js";
import { buildHealthTargets, HealthMonitor, publicServiceHealth } from "./health.js";
import { learnPolicy, learnTargetFilter } from "./learn/extract.js";
import { LEARNED_RULES_DIR, LearnedRuleStore } from "./learn/store.js";
import { MemoryExtractor } from "./memory/extractor.js";
import { DeviceMaintenance, formatBrief } from "./memory/lifecycle.js";
import { MemoryStore } from "./memory/store.js";
import { memoryTools } from "./memory/tools.js";
import { createGatewaySdkServers } from "./gateway-sdk.js";
import { DEFAULT_DIRECT_TIMEOUT_MS, McpDirectClient, type RemoteMcpClient } from "./mcp-direct.js";
import { McpGateway, serviceSecrets, type GatewaySource } from "./mcp-gateway.js";
import { formatQuietHours, NOTIFICATIONS_DIR, NotificationStore } from "./notifications.js";
import { SuppressionStore } from "./notification-suppressions.js";
import { HaUrgencyStore, haUrgencyFeedback } from "./ha-urgency.js";
import { buildOneShotOptions } from "./one-shot.js";
import { PermissionPolicy } from "./permissions.js";
import { checkRouterServices } from "./router-config.js";
import { PassthroughRouter, TieredRouter, type Router, type TieredRouterOptions } from "./router.js";
import type { ProtocolFeature } from "./protocol.js";
import { createCoreServer } from "./server.js";
import { DevelopmentTab, NotificationCenter, Session, type Logger, type SessionLearning } from "./session.js";
import { onShutdownSignal, runShutdown, SHUTDOWN_SIGNALS } from "./shutdown.js";
import { PiperTtsClient, WhisperClient } from "./speech.js";
import { UsageLog } from "./usage-log.js";
import { VaultReader, vaultTools } from "./vault.js";

const logger: Logger = {
  info: (m) => console.log(m),
  warn: (m) => console.warn(m),
};

/**
 * Tool sources of the Core MCP gateway (T7.y), in services.yaml order: enabled
 * remote MCP services (mirrored over `client`, the connection tier 0 shares),
 * the vault and, with a memory store, the memory tools.
 */
export function buildGatewaySources(
  cfg: CoreConfig,
  client: RemoteMcpClient,
  memory?: MemoryStore,
  env: NodeJS.ProcessEnv = process.env,
): GatewaySource[] {
  const out: GatewaySource[] = [];
  for (const svc of cfg.services.services) {
    if (!svc.enabled) continue;
    if (svc.kind === "mcp" && svc.url) {
      out.push({
        kind: "remote",
        service: svc.name,
        client,
        timeoutMs: svc.timeoutMs ?? DEFAULT_DIRECT_TIMEOUT_MS,
        // Same URL and token the client connects with; kept in memory only, to mask them in error texts.
        secrets: serviceSecrets(svc.url, svc.tokenEnv ? env[svc.tokenEnv] : undefined),
      });
    } else if (svc.kind === "vault" && cfg.vaultDir) {
      const reader = new VaultReader({ root: cfg.vaultDir, allow: svc.allow ?? [], maxBytes: svc.maxBytes });
      out.push({ kind: "local", service: svc.name, tools: vaultTools(reader) });
    } else if (svc.kind === "memory" && memory) {
      out.push({ kind: "local", service: svc.name, tools: memoryTools(memory) });
    }
  }
  return out;
}

/** Longest wait of a model session start for the remote services' first tool list (instructions). */
export const GATEWAY_SESSION_WAIT_MS = 3_000;

/**
 * SDK-side per-call limit for gateway tools. Everything a call can wait on
 * runs inside it, in the worst case one after the other: a list refresh for a
 * tool the cache lacks (one service timeout), the confirmation, a reconnect
 * and the call itself (one service timeout each), plus 10 s slack. The
 * gateway also refuses to forward a call approved too late for this limit
 * (`McpGateway.call`), so a timed-out call never runs on the service.
 */
export function gatewayCallTimeoutMs(cfg: CoreConfig): number {
  const slowest = Math.max(
    DEFAULT_DIRECT_TIMEOUT_MS,
    ...cfg.services.services.filter((s) => s.kind === "mcp" && s.enabled).map((s) => s.timeoutMs ?? DEFAULT_DIRECT_TIMEOUT_MS),
  );
  return slowest + cfg.confirmTimeoutMs + 2 * slowest + 10_000;
}

export async function main(): Promise<void> {
  const envFile = loadDotEnv();
  const cfg = loadConfig();
  for (const w of cfg.services.warnings) logger.warn(`[shadow-core] services.yaml: ${w}`);

  const tokens = loadDeviceTokens();
  for (const name of tokens.rejected) logger.warn(`[shadow-core] ${name} ignored: shorter than 16 characters`);
  for (const device of tokens.digests.keys()) {
    if (!isUsableDeviceName(device)) {
      logger.warn(`[shadow-core] device '${device}': name not usable as a file name (a-z, 0-9, '_', '-'); its POST /device/state gets 500`);
    }
  }
  if (tokens.digests.size === 0) {
    throw new Error("no device tokens configured (set at least one DEVICE_TOKEN_<NAME> in .env); refusing to start");
  }

  // Vault tool is disabled without a vault dir.
  const vaultSvc = cfg.services.services.find((s) => s.kind === "vault");
  if (vaultSvc && !cfg.vaultDir) {
    vaultSvc.enabled = false;
    vaultSvc.disabledReason = "SHADOW_VAULT_DIR not set or not a directory";
  }

  // Memory (docs/06): CORE_MEMORY=off turns off the store, its tools, the brief and the frames.
  const memorySvc = cfg.services.services.find((s) => s.kind === "memory");
  if (memorySvc && !cfg.memory.enabled) {
    memorySvc.enabled = false;
    memorySvc.disabledReason = "CORE_MEMORY=off";
  }
  const memoryDir = join(cfg.dataDir, "memory");
  // Assigned below; the store's change callback restarts idle sessions when the brief changed.
  let registry: DeviceRegistry | undefined;
  const memory = cfg.memory.enabled
    ? new MemoryStore({
        dir: memoryDir,
        logger,
        onChange: (c) => {
          if (c.briefChanged) registry?.briefChanged();
        },
      })
    : undefined;

  const systemPrompt = readFileSync(cfg.systemPromptFile, "utf8");
  const escalationPrompt = readFileSync(join(cfg.systemPromptFile, "..", "tier1.md"), "utf8");
  const log = new ConversationLog(cfg.dataDir);
  await log.ensureDir();

  // Phone-reported device state (T11): written by POST /device/state, read by the case_battery tool.
  const deviceState = new DeviceStateStore({
    dir: join(cfg.dataDir, "device-state"),
    log: (level, m) => (level === "warn" ? logger.warn(m) : logger.info(m)),
  });
  const deviceService = deviceStateService(cfg.services.services, deviceState);
  if (!deviceService) logger.warn(`[shadow-core] services.yaml declares '${DEVICE_SERVICE_NAME}'; the built-in case_battery tool is off`);
  const policy = new PermissionPolicy(
    deviceService ? [...cfg.services.services, deviceService.def] : cfg.services.services,
    { readOnly: cfg.readOnly },
  );
  // One MCP client per remote service, shared by tier 0 and the gateway (one SSE connection).
  const mcpClient = new McpDirectClient(cfg.services.services, process.env);
  // Dev-notes (tools.json, turns.json) and the Development tab over them (docs/08 T7.w.3/T7.w.4).
  // Every writer tells the tab, which recounts the badge (coalesced) and broadcasts `dev_count`.
  // Assigned once the learned-rule store exists (below).
  let devTab: DevelopmentTab | undefined = undefined;
  const devNotesDir = join(cfg.dataDir, "dev-notes");
  const toolNotes = new DevNotes({ dir: devNotesDir, log: (m) => logger.warn(m) });
  const turnNotes = new TurnNotes({ dir: devNotesDir, log: (m) => logger.warn(m) });
  const recordTurnNote: Pick<TurnNotes, "record"> = {
    record: (input) => turnNotes.record(input).finally(() => devTab?.changed()),
  };
  const gateway = new McpGateway({
    sources: [...buildGatewaySources(cfg, mcpClient, memory), ...(deviceService ? [deviceService.source] : [])],
    classifier: policy,
    devNotes: {
      recordCatalog: (service, tools, exactRules) => toolNotes.recordCatalog(service, tools, exactRules).finally(() => devTab?.changed()),
    },
    turnNotes: recordTurnNote,
    log: (level, m) => (level === "warn" ? logger.warn(m) : logger.info(m)),
  });
  const gatewayTimeoutMs = gatewayCallTimeoutMs(cfg);
  const agentCwd = join(cfg.dataDir, "agent");
  const agentEnv = subprocessEnv(process.env);
  const agent = new SdkAgentRunner({
    systemPrompt,
    escalationPrompt,
    mcpServers: (gate) =>
      createGatewaySdkServers(gateway, gate, {
        timeoutMs: gatewayTimeoutMs,
        log: (level, m) => (level === "warn" ? logger.warn(m) : logger.info(m)),
      }),
    cwd: agentCwd,
    env: agentEnv,
    stderr: (line) => logger.warn(`[shadow-core] sdk: ${line.trimEnd()}`),
  });

  // The model provider: live sessions (persistent mode) and one-shot background calls (memory).
  // No MCP freshness check: the CLI only has in-process gateway servers; the
  // remote connection is the Core's own and reconnects on demand (mcp-direct.ts).
  const provider = new ClaudeSdkProvider({
    queryFn: query,
    buildOptions: (p) => agent.buildPersistentOptions(p),
    buildOneShotOptions: buildOneShotOptions(agentCwd, agentEnv),
    session: {
      idleMs: cfg.agent.idleMin * 60_000,
      turnTimeoutMs: cfg.agent.turnTimeoutMs,
      log: (event, detail) => {
        if (event === "dead" || event === "send_failed" || event === "settle_failed") {
          logger.warn(`[shadow-core] agent ${event}: ${JSON.stringify(detail ?? {})}`);
        }
      },
    },
  });

  // Persistent per-device model sessions (docs/07 A1) with continuity (A4).
  // CORE_AGENT_PERSISTENT=off: no registry, every turn on the legacy runner.
  if (cfg.agent.persistent) {
    const store = new ContinuityStore({
      file: continuityFilePath(cfg.dataDir),
      windowMin: cfg.agent.continuityMin,
      // Only Claude SDK transcripts can be checked here; another provider's pointer is kept as is.
      getSessionInfo: (id, owner) => (owner === provider.id ? getSessionInfo(id, { dir: agentCwd }) : Promise.resolve(true)),
      log: (level, m) => (level === "warn" ? logger.warn(`[shadow-core] ${m}`) : logger.info(`[shadow-core] ${m}`)),
    });
    registry = new DeviceRegistry({
      provider,
      model: cfg.router ? cfg.models[1] : cfg.model,
      continuity: continuityPort(store),
      continuityMin: cfg.agent.continuityMin,
      restartGuard: () => new RestartBackoff(),
      prewarm: cfg.agent.prewarm,
      // Read before every session start (prewarm included; tier 0 never waits on it):
      // a short wait for the remote services' first list, so the session's MCP
      // servers carry their instructions (HA's Assist prompt). A service that is
      // down costs at most GATEWAY_SESSION_WAIT_MS; its instructions then reach
      // the next session started after it answered.
      systemAppend: async () => {
        await gateway.whenListed(GATEWAY_SESSION_WAIT_MS);
        return memory ? formatBrief(await memory.briefForPrompt()) : "";
      },
      log: (level, m) => (level === "warn" ? logger.warn(m) : logger.info(m)),
    });
    if (cfg.router && Object.values(cfg.router.tierServices).some((v) => v !== undefined)) {
      logger.warn(
        "[shadow-core] router.yaml tierN.services: in persistent mode every service is loaded and the gate denies the others (no token saving)",
      );
    }
  }
  const usageLog = new UsageLog(cfg.dataDir);

  // Background extraction and compaction (docs/06), through the provider interface only.
  const background = new AbortController();
  let extractor: MemoryExtractor | undefined;
  if (memory) {
    extractor = new MemoryExtractor({
      store: memory,
      provider,
      dataDir: cfg.dataDir,
      model: cfg.memory.model,
      maxRunsPerDay: cfg.memory.maxRunsDay,
      everyTurns: cfg.memory.everyTurns,
      usage: usageLog,
      logger,
      signal: background.signal,
    });
    await extractor.init();
  }
  const maintenance =
    registry || extractor
      ? new DeviceMaintenance({
          registry,
          extractor,
          provider,
          summaryModel: cfg.memory.model,
          compactAtTokens: cfg.memory.compactAtTokens,
          idleExtractMs: cfg.memory.idleMin * 60_000,
          dataDir: cfg.dataDir,
          usage: usageLog,
          log: (level, m) => (level === "warn" ? logger.warn(m) : logger.info(m)),
        })
      : undefined;
  maintenance?.startup([...tokens.digests.keys()]);
  let router: Router;
  let direct: McpDirectClient | undefined;
  // Learned tier-0 rules (docs/08 T7.w.2): only with the tiered router, direct calls and router.yaml `learning.enabled`.
  let learnedRules: LearnedRuleStore | undefined;
  let learning: SessionLearning | undefined;
  if (cfg.router) {
    const enabled = cfg.services.services.filter((s) => s.enabled).map((s) => s.name);
    for (const w of checkRouterServices(cfg.router, enabled)) logger.warn(`[shadow-core] router.yaml: ${w}`);
    let learned: TieredRouterOptions["learned"];
    if (cfg.router.direct.enabled && cfg.router.learning.enabled) {
      const store = new LearnedRuleStore({ dir: join(cfg.dataDir, LEARNED_RULES_DIR), config: cfg.router, log: (m) => logger.warn(m) });
      await store.load();
      const policy = learnPolicy(cfg.router, cfg.services.services);
      learned = { rules: () => store.snapshot(), targetFilter: learnTargetFilter(policy) };
      // A new candidate or a suspension changes the Development badge.
      learning = {
        store: {
          observe: (x) => store.observe(x).finally(() => devTab?.changed()),
          recordOutcome: (id, outcome, reason) => store.recordOutcome(id, outcome, reason).finally(() => devTab?.changed()),
        },
        policy,
        minObservations: cfg.router.learning.minObservations,
      };
      learnedRules = store;
    }
    router = new TieredRouter({ config: cfg.router, models: cfg.models, onUsage: (u) => void usageLog.append(u), learned });
    direct = cfg.router.direct.enabled ? mcpClient : undefined;
  } else {
    const passthrough = new PassthroughRouter(cfg.model);
    router = { route: () => passthrough.route(), onUsage: (u) => void usageLog.append(u) };
  }
  // "Kuralı ekle" only for CORE_DEV_DEVICES; unset = nobody (fail closed, docs/08 decision 3).
  for (const d of cfg.devDevices) {
    if (!tokens.digests.has(d)) logger.warn(`[shadow-core] CORE_DEV_DEVICES: '${d}' has no DEVICE_TOKEN_<NAME>; ignored in practice`);
  }
  // Learned urgency of HA alerts (docs/09, T7.w.11.10): type key, counter, approved level; next to the inbox.
  const haUrgency = new HaUrgencyStore({
    dir: join(cfg.dataDir, NOTIFICATIONS_DIR),
    log: (m) => logger.warn(m),
    onChange: () => devTab?.changed(),
  });
  devTab = new DevelopmentTab({ rules: learnedRules, toolNotes, turnNotes, haUrgency, managers: cfg.devDevices, logger });
  await devTab.view(); // the first badge count, for /health `inbox`
  // The home's notification inbox (docs/08 T7.w.5); producers call notificationCenter.raise()/resolve() (docs/09).
  const notificationStore = new NotificationStore({ dir: join(cfg.dataDir, NOTIFICATIONS_DIR), log: (m) => logger.warn(m) });
  // Quiet hours (docs/09, T7.w.11.9): no urgent speech in this window (Core host local time).
  if (cfg.quietHoursWarning) logger.warn(`[shadow-core] ${cfg.quietHoursWarning}`);
  logger.info(`[shadow-core] quiet hours for urgent speech: ${cfg.quietHours ? formatQuietHours(cfg.quietHours) : "off"}`);
  // "Tekrar gösterme" records next to the inbox (docs/09, T7.w.11.7): source + key only.
  const notificationSuppressions = new SuppressionStore({ dir: join(cfg.dataDir, NOTIFICATIONS_DIR), log: (m) => logger.warn(m) });
  const notificationCenter = new NotificationCenter({
    store: notificationStore,
    logger,
    quietHours: cfg.quietHours,
    suppressions: notificationSuppressions,
    urgencyFeedback: haUrgencyFeedback(haUrgency),
  });
  await notificationCenter.refresh(); // the first unread count, for /health `inbox`
  // Backup producer (docs/09 (a)): reads <data dir>/backup/status.json written by backup-data.ps1.
  // Startup adoption reads the store directly (the center's list drops the dedupe key).
  const backupProducer = new BackupProducer({
    statusFile: backupStatusPath(cfg.dataDir),
    notifications: {
      raise: (input) => notificationCenter.raise(input),
      resolve: (source, key) => notificationCenter.resolve(source, key),
      list: () => notificationStore.list(),
      suppressed: () => notificationCenter.suppressed(),
    },
    logger,
  });
  const tierServices = cfg.router?.tierServices;
  const stt = new WhisperClient(cfg.whisper?.enabled ? cfg.whisper.url : undefined, cfg.whisper?.timeoutMs);
  const tts = new PiperTtsClient(cfg.tts?.enabled ? cfg.tts.url : undefined, cfg.tts?.timeoutMs);
  const lexicon = loadPronunciationsFile(cfg.pronunciationsFile);
  for (const w of lexicon.warnings) logger.warn(`[shadow-core] pronunciations.yaml: ${w}`);
  const pronunciations = lexicon.lexicon;

  // One hold-off for a rejected HA_CORE_TOKEN (T20.1), shared by the HA health check and the HA WebSocket
  // client: HA counts each rejected token as a failed login (ip_ban), so neither retries it every round.
  const haAuthGate = new AuthGate();
  // Built after the vault check above so a missing vault dir reads as disabled.
  const monitor = new HealthMonitor(buildHealthTargets(cfg.services.services, process.env, {
      vaultDir: cfg.vaultDir,
      ...(memory ? { memoryDir } : {}),
      authGates: new Map([["HA_CORE_TOKEN", haAuthGate]]),
    }), {
    intervalMs: cfg.healthIntervalMs,
    timeoutMs: cfg.healthTimeoutMs,
    logger,
  });
  // Service producer (docs/09 (b)): notifications from the monitor's shown status; adoption reads the store directly.
  const serviceProducer = new ServiceProducer({
    monitor,
    notifications: {
      raise: (input) => notificationCenter.raise(input),
      resolve: (source, key) => notificationCenter.resolve(source, key),
      list: () => notificationStore.list(),
      suppressed: () => notificationCenter.suppressed(),
    },
    logger,
  });
  // HA alerts producer (docs/09 (c)): HA's persistent notifications over a read-only WebSocket client;
  // off (one info line) without HA_URL / HA_CORE_TOKEN. Adoption reads the store directly.
  const haAlerts = createHaAlerts({
    env: process.env,
    notifications: {
      raise: (input) => notificationCenter.raise(input),
      resolve: (source, key) => notificationCenter.resolve(source, key),
      list: () => notificationStore.list(),
      suppressed: () => notificationCenter.suppressed(),
    },
    logger,
    urgency: haUrgency,
    authGate: haAuthGate,
  });

  const server = createCoreServer({
    tokens,
    logger,
    createSession: (info, send) =>
      new Session(
        {
          agent,
          registry,
          policy,
          router,
          stt,
          tts,
          log,
          logger,
          confirmTimeoutMs: cfg.confirmTimeoutMs,
          direct,
          tierServices,
          pronunciations,
          memory,
          maintenance,
          learning,
          turnNotes: recordTurnNote,
          dev: devTab,
          notifications: notificationCenter,
        },
        info,
        send,
      ),
    // Name, flag, status and short detail code only: no URL or token leaves through /health.
    health: () => ({ services: publicServiceHealth(cfg.services.services, monitor.snapshot()) }),
    // Loopback requests only (the tray): the Development badge count and unread notifications, no titles.
    // `notificationsUnavailable`: the file could not be read, `notifications` is then not a real count (T7.w.12).
    inbox: () => ({ dev: devTab?.open ?? 0, ...notificationCenter.healthInbox() }),
    devCount: devTab,
    features: ["speech_stream", "usage_limit", ...(memory ? (["memory"] as ProtocolFeature[]) : []), "dev", "notifications", "notifications_suppress", "ha_urgency_feedback"],
    serviceHealth: monitor,
    deviceState,
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
  logger.info(
    `[shadow-core] agent=${cfg.agent.persistent ? `persistent (idle ${cfg.agent.idleMin} min, continuity ${cfg.agent.continuityMin} min, prewarm ${cfg.agent.prewarm ? "on" : "off"})` : "per-turn (legacy)"}`,
  );
  logger.info(
    `[shadow-core] pronunciations: ${lexicon.found ? `${pronunciations.entries.length} entries` : "file not found (none)"}`,
  );
  logger.info(
    `[shadow-core] memory: ${memory ? `on (model ${cfg.memory.model}, idle ${cfg.memory.idleMin} min, every ${cfg.memory.everyTurns} turns)` : "off"}; compaction: ${cfg.memory.compactAtTokens > 0 && registry ? `at ${cfg.memory.compactAtTokens} tokens` : "off"}`,
  );
  logger.info(`[shadow-core] learning: ${learnedRules ? `on (${learnedRules.snapshot().length} active learned rules)` : "off"}`);
  logger.info(
    `[shadow-core] development tab: ${devTab.open ?? 0} open; "Kuralı ekle" ${cfg.devDevices.length > 0 ? `for ${cfg.devDevices.join(",")}` : "off (CORE_DEV_DEVICES not set)"}`,
  );
  logger.info(`[shadow-core] listening on ws://${cfg.host}:${port}/ws`);
  monitor.start();
  backupProducer.start();
  serviceProducer.start();
  haAlerts?.start();
  // List the remote services once now, so the first session gets their tools and instructions.
  void gateway.warm();
  logger.info(`[shadow-core] mcp gateway: ${gateway.services.join(", ") || "no services"}`);
  logger.info(`[shadow-core] health checks every ${cfg.healthIntervalMs} ms (timeout ${cfg.healthTimeoutMs} ms)`);

  // SIGBREAK is Windows Ctrl+Break; onShutdownSignal runs the shutdown only once.
  // runShutdown: the closes in order (new work stops first) within
  // SHUTDOWN_CLOSE_BUDGET_MS, then every flush at once (even after a hanging
  // close), each failure logged; forced exit after SHUTDOWN_TIMEOUT_MS (T7.w.10h).
  onShutdownSignal(process, SHUTDOWN_SIGNALS, (signal) => {
    logger.info(`[shadow-core] shutting down (${signal})`);
    void runShutdown(
      {
        close: [
          { name: "maintenance", run: () => maintenance?.close() },
          { name: "background", run: () => background.abort() },
          { name: "health monitor", run: () => monitor.close() },
          { name: "backup producer", run: () => backupProducer.close() },
          { name: "service producer", run: () => serviceProducer.close() },
          { name: "ha alerts", run: () => haAlerts?.close() },
          // Closes every socket; each session flushes its conversation log lines.
          { name: "server", run: () => server.close() },
          // Closes the model sessions and flushes the continuity pointers.
          { name: "device registry", run: () => registry?.close() },
          { name: "mcp gateway", run: () => gateway.close() },
          { name: "mcp client", run: () => mcpClient.close() },
          { name: "development tab", run: () => devTab?.close() },
          // The retry read of an unreadable notifications file (T7.w.13); the flush below still runs.
          { name: "notification center", run: () => notificationCenter.close() },
        ],
        flush: [
          { name: "usage log", run: () => usageLog.flush() },
          { name: "learned rules", run: () => learnedRules?.flush() },
          // Coalesced turn notes not yet on disk.
          { name: "turn notes", run: () => turnNotes.flush() },
          // After the inbox changes in flight: coalesced or failed notification writes.
          { name: "notifications", run: () => notificationCenter.flush() },
          { name: "ha urgency", run: () => haUrgency.flush() },
        ],
      },
      { log: (m) => logger.warn(m), exit: (code) => process.exit(code) },
    );
  });
}

main().catch((err: Error) => {
  console.error(`[shadow-core] fatal: ${err.message}`);
  process.exit(1);
});
