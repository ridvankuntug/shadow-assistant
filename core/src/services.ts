/**
 * services.yaml loader: `${ENV}` interpolation, `enabled` flag and validation.
 *
 * The file is committed and must never contain personal values; everything
 * environment-specific comes in through `${VAR}` / `${VAR:-default}`.
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

export type PermissionLevel = "read" | "write" | "confirm";
export const PERMISSION_LEVELS: readonly PermissionLevel[] = ["read", "write", "confirm"];

export type ServiceKind = "mcp" | "http" | "vault";
export type McpTransport = "sse" | "http";

export interface ToolRule {
  /** Exact tool name or glob (see glob.ts), without the `mcp__<service>__` prefix. */
  pattern: string;
  level: PermissionLevel;
}

export interface ServiceDef {
  name: string;
  kind: ServiceKind;
  /** Effective flag: false if disabled in the file or if a required env var is missing. */
  enabled: boolean;
  /** Why the service is disabled (only set when the file says enabled but it cannot be used). */
  disabledReason?: string;
  url?: string;
  transport?: McpTransport;
  /** Name of the env var holding the bearer token (the token itself is never stored here). */
  tokenEnv?: string;
  health?: string;
  timeoutMs?: number;
  /** Default level for this service's tools. */
  permission: PermissionLevel;
  /** Per-tool overrides in file order; exact matches win over globs (see permissions.ts). */
  tools: ToolRule[];
  /**
   * Escalate a call to `confirm` when an input argument has one of these
   * values (case-insensitive; string or array arguments), e.g.
   * `{ domain: ["lock"], device_class: ["garage"] }`. Never lowers a level.
   */
  confirmInputs: Record<string, string[]>;
  /** vault only: allowlist of relative note globs. */
  allow?: string[];
  /** vault only: max bytes returned per note. */
  maxBytes?: number;
}

export interface ServicesConfig {
  services: ServiceDef[];
  warnings: string[];
}

export class ServicesConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`services.yaml is invalid:\n  - ${problems.join("\n  - ")}`);
    this.name = "ServicesConfigError";
  }
}

const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/**
 * Replaces `${VAR}` and `${VAR:-default}`. An unset or empty variable without
 * default is reported in `missing` and replaced by an empty string.
 */
export function interpolate(
  value: string,
  env: NodeJS.ProcessEnv,
): { value: string; missing: string[] } {
  const missing: string[] = [];
  const out = value.replace(VAR_RE, (_m, name: string, def: string | undefined) => {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
    if (def !== undefined) return def;
    missing.push(name);
    return "";
  });
  return { value: out, missing };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KNOWN_KEYS = new Set([
  "name",
  "kind",
  "transport",
  "url",
  "token_env",
  "enabled",
  "permission",
  "tools",
  "health",
  "timeout_ms",
  "allow",
  "max_bytes",
  "confirm_inputs",
]);

export function parseServices(text: string, env: NodeJS.ProcessEnv = process.env): ServicesConfig {
  const problems: string[] = [];
  const warnings: string[] = [];
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new ServicesConfigError([`YAML parse error: ${(err as Error).message}`]);
  }
  if (!isObj(doc) || !Array.isArray(doc.services)) {
    throw new ServicesConfigError(["top-level `services:` list is required"]);
  }

  const services: ServiceDef[] = [];
  const seen = new Set<string>();

  doc.services.forEach((raw: unknown, idx: number) => {
    const where = `services[${idx}]`;
    if (!isObj(raw)) {
      problems.push(`${where} must be a mapping`);
      return;
    }
    const name = raw.name;
    if (typeof name !== "string" || !NAME_RE.test(name)) {
      problems.push(`${where}.name must be lowercase kebab-case (a-z, 0-9, single '-')`);
      return;
    }
    const at = `service '${name}'`;
    if (seen.has(name)) problems.push(`${at}: duplicate name`);
    seen.add(name);

    for (const key of Object.keys(raw)) {
      if (!KNOWN_KEYS.has(key)) warnings.push(`${at}: unknown key '${key}' ignored`);
    }

    const kind = raw.kind;
    if (kind !== "mcp" && kind !== "http" && kind !== "vault") {
      problems.push(`${at}: kind must be one of mcp | http | vault`);
      return;
    }

    let enabled = raw.enabled === undefined ? true : raw.enabled;
    if (typeof enabled !== "boolean") {
      problems.push(`${at}: enabled must be true/false`);
      enabled = false;
    }

    const permission = raw.permission === undefined ? "confirm" : raw.permission;
    if (!PERMISSION_LEVELS.includes(permission as PermissionLevel)) {
      problems.push(`${at}: permission must be read | write | confirm`);
    }

    const tools: ToolRule[] = [];
    if (raw.tools !== undefined) {
      if (!isObj(raw.tools)) {
        problems.push(`${at}: tools must be a mapping of tool name/glob → level`);
      } else {
        for (const [pattern, level] of Object.entries(raw.tools)) {
          if (!PERMISSION_LEVELS.includes(level as PermissionLevel)) {
            problems.push(`${at}: tools['${pattern}'] must be read | write | confirm`);
          } else {
            tools.push({ pattern, level: level as PermissionLevel });
          }
        }
      }
    }

    const confirmInputs: Record<string, string[]> = {};
    if (raw.confirm_inputs !== undefined) {
      if (!isObj(raw.confirm_inputs)) {
        problems.push(`${at}: confirm_inputs must be a mapping of argument name → list of values`);
      } else {
        for (const [arg, values] of Object.entries(raw.confirm_inputs)) {
          if (!Array.isArray(values) || !values.every((v) => typeof v === "string" && v.length > 0)) {
            problems.push(`${at}: confirm_inputs['${arg}'] must be a list of strings`);
          } else {
            confirmInputs[arg] = (values as string[]).map((v) => v.toLowerCase());
          }
        }
      }
    }

    const def: ServiceDef = {
      name,
      kind,
      enabled: enabled as boolean,
      permission: (PERMISSION_LEVELS.includes(permission as PermissionLevel)
        ? permission
        : "confirm") as PermissionLevel,
      tools,
      confirmInputs,
    };

    const missing: string[] = [];
    if (raw.url !== undefined) {
      if (typeof raw.url !== "string") {
        problems.push(`${at}: url must be a string`);
      } else {
        const r = interpolate(raw.url, env);
        missing.push(...r.missing);
        def.url = r.value.replace(/\/+$/, "");
        if (r.missing.length === 0) {
          try {
            const u = new URL(def.url);
            if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
          } catch {
            problems.push(`${at}: url is not a valid http(s) URL after interpolation`);
          }
        }
      }
    }
    if (raw.token_env !== undefined) {
      if (typeof raw.token_env !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.token_env)) {
        problems.push(`${at}: token_env must be an environment variable name`);
      } else {
        def.tokenEnv = raw.token_env;
        if (!env[raw.token_env]) missing.push(raw.token_env);
      }
    }
    if (raw.health !== undefined) {
      if (typeof raw.health !== "string" || !raw.health.startsWith("/")) {
        problems.push(`${at}: health must be a path starting with '/'`);
      } else def.health = raw.health;
    }
    if (raw.timeout_ms !== undefined) {
      if (typeof raw.timeout_ms !== "number" || raw.timeout_ms <= 0) {
        problems.push(`${at}: timeout_ms must be a positive number`);
      } else def.timeoutMs = raw.timeout_ms;
    }

    if (kind === "mcp") {
      const transport = raw.transport ?? "sse";
      if (transport !== "sse" && transport !== "http") {
        problems.push(`${at}: transport must be sse | http`);
      } else def.transport = transport;
      if (raw.url === undefined) problems.push(`${at}: url is required for kind mcp`);
    } else if (kind === "http") {
      if (raw.url === undefined) problems.push(`${at}: url is required for kind http`);
    } else {
      // vault
      const allow = raw.allow ?? [];
      if (!Array.isArray(allow) || !allow.every((a) => typeof a === "string" && a.length > 0)) {
        problems.push(`${at}: allow must be a list of glob strings`);
      } else {
        for (const a of allow as string[]) {
          if (a.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(a) || a.includes("\\")) {
            problems.push(`${at}: allow entry '${a}' must be a relative forward-slash glob without '..'`);
          }
        }
        def.allow = allow as string[];
      }
      const maxBytes = raw.max_bytes ?? 65536;
      if (typeof maxBytes !== "number" || maxBytes <= 0) {
        problems.push(`${at}: max_bytes must be a positive number`);
      } else def.maxBytes = maxBytes;
    }

    if (def.enabled && missing.length > 0) {
      def.enabled = false;
      def.disabledReason = `missing environment variable(s): ${[...new Set(missing)].join(", ")}`;
      warnings.push(`${at} disabled: ${def.disabledReason}`);
    }
    services.push(def);
  });

  if (problems.length > 0) throw new ServicesConfigError(problems);
  return { services, warnings };
}

export function loadServicesFile(path: string, env: NodeJS.ProcessEnv = process.env): ServicesConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ServicesConfigError([`cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? "error"}`]);
  }
  return parseServices(text, env);
}

export function findService(cfg: ServicesConfig, name: string): ServiceDef | undefined {
  return cfg.services.find((s) => s.name === name);
}
