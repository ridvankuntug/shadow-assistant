/**
 * router.yaml: loader, validation (zod) and pattern compiler.
 *
 * Pattern syntax (one pattern = one whole utterance, matched after Turkish
 * normalization, see turkish.ts — case, punctuation, Turkish letters and
 * filler words do not matter):
 *
 *   word        literal word ("aç" also matches "ac")
 *   word*       word prefix ("plan*" matches "planı", "planla")
 *   {a|b c|}    alternatives; an alternative may hold several words; an empty
 *               alternative makes the group optional
 *   {@name}     the alternatives listed under `groups.name` (may be mixed
 *               with literal ones: `{@open|çalıştır|}`)
 *   <ad>        the device / place name: 1..direct.max_name_words words
 *   <sayi>      a number of 1..3 digits (light-set rules: brightness 0..100;
 *               "%50" / "yüzde 50" / "50'ye" all normalize to "… 50")
 *   *           any number of words (also none)
 *
 * Rules are tried in file order; the first matching pattern wins.
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { PermissionLevel } from "./services.js";
import { cleanTurkish, fold, type PreparedText } from "./turkish.js";

export const LIVE_CONTEXT_TOOL = "homeassistant__GetLiveContext";
/** Brightness in percent (`brightness` 0..100); HA exposes it as `light__HassLightSet`. */
export const LIGHT_SET_TOOL = "light__HassLightSet";
export const SWITCH_TOOLS = ["intent__HassTurnOn", "intent__HassTurnOff"] as const;
export const DIRECT_TOOLS = [...SWITCH_TOOLS, LIGHT_SET_TOOL, LIVE_CONTEXT_TOOL] as const;
export type DirectTool = (typeof DIRECT_TOOLS)[number];
export type SensorKind = "temperature" | "humidity";

const level = z.enum(["read", "write", "confirm"]);
const nonEmpty = z.string().trim().min(1);
const kebab = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "must be lowercase kebab-case");

const messagesSchema = z
  .object({
    not_found: nonEmpty.default("Bu adla bir cihaz bulamadım."),
    ambiguous: nonEmpty.default("Hangi cihazı kastettiğinden emin olamadım."),
    unavailable: nonEmpty.default("Ev sistemine şu an ulaşamıyorum."),
    failed: nonEmpty.default("Bunu yapamadım."),
    declined: nonEmpty.default("Tamam, yapmıyorum."),
    read_only: nonEmpty.default("Şu an salt okuma modundayım, bunu yapamam."),
  })
  .strict();

const ruleSchema = z
  .object({
    id: kebab,
    tier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    patterns: z.array(nonEmpty).min(1),
    // tier 0 only
    service: nonEmpty.optional(),
    tool: z.enum(DIRECT_TOOLS).optional(),
    /** Entity domains a switch rule may touch (resolved from the live context). */
    domains: z.array(nonEmpty).min(1).optional(),
    /** Device words that may follow the name in the HA entity name ("ışık", "lamba"). */
    keywords: z.array(nonEmpty).optional(),
    sensor: z.enum(["temperature", "humidity"]).optional(),
    /** Sensor rules without `<ad>`: prefer sensors named/placed like this. */
    default_name: nonEmpty.optional(),
    /** Can only raise the services.yaml level, never lower it. */
    permission: level.optional(),
    reply: nonEmpty.optional(),
    reply_many: nonEmpty.optional(),
  })
  .strict();

export const routerFileSchema = z
  .object({
    version: z.literal(1),
    fillers: z.array(nonEmpty).default([]),
    /** Named alternative lists, used in patterns as `{@name}` (verb forms, device words …). */
    groups: z.record(kebab, z.array(nonEmpty).min(1)).default({}),
    tier1: z
      .object({
        /** Longer requests go straight to tier 2 (an escalation would cost a second call). */
        max_words: z.number().int().positive().default(30),
        services: z.array(nonEmpty).optional(),
      })
      .strict()
      .default({ max_words: 30 }),
    tier2: z.object({ services: z.array(nonEmpty).optional() }).strict().default({}),
    tier3: z.object({ services: z.array(nonEmpty).optional() }).strict().default({}),
    escalation: z.object({ enabled: z.boolean().default(true) }).strict().default({ enabled: true }),
    direct: z
      .object({
        enabled: z.boolean().default(true),
        on_tool_error: z.enum(["fallback", "reply"]).default("fallback"),
        max_name_words: z.number().int().min(1).max(8).default(4),
        /** Captured names that are never a device ("şunu", "ışığı" …): the rule does not match. */
        stop_names: z.array(nonEmpty).default([]),
        /** Words that never occur inside a name ("ve", "sonra"): a capture holding one does not match. */
        name_stop_words: z.array(nonEmpty).default([]),
        /** Groups of place names that mean the same ("salon" = "oturma odası"); tried when a name is not found. */
        area_aliases: z.array(z.array(nonEmpty).min(2)).default([]),
        max_items: z.number().int().min(1).max(10).default(4),
        messages: messagesSchema.default(messagesSchema.parse({})),
      })
      .strict()
      .default({
        enabled: true,
        on_tool_error: "fallback",
        max_name_words: 4,
        stop_names: [],
        name_stop_words: [],
        area_aliases: [],
        max_items: 4,
        messages: messagesSchema.parse({}),
      }),
    rules: z.array(ruleSchema).default([]),
  })
  .strict()
  .superRefine((cfg, ctx) => {
    const ids = new Set<string>();
    cfg.rules.forEach((r, i) => {
      const at = (key: string) => ["rules", i, key];
      if (ids.has(r.id)) ctx.addIssue({ code: "custom", path: at("id"), message: `duplicate rule id '${r.id}'` });
      ids.add(r.id);
      const directKeys = ["service", "tool", "domains", "keywords", "sensor", "default_name", "permission", "reply", "reply_many"] as const;
      if (r.tier !== 0) {
        for (const k of directKeys) {
          if (r[k] !== undefined) ctx.addIssue({ code: "custom", path: at(k), message: "only allowed on tier 0 rules" });
        }
        r.patterns.forEach((p, j) => {
          if (p.includes("<sayi>")) ctx.addIssue({ code: "custom", path: ["rules", i, "patterns", j], message: `<sayi> is only allowed with ${LIGHT_SET_TOOL}` });
        });
        return;
      }
      if (!r.service) ctx.addIssue({ code: "custom", path: at("service"), message: "required for tier 0" });
      if (!r.tool) ctx.addIssue({ code: "custom", path: at("tool"), message: `required for tier 0 (one of ${DIRECT_TOOLS.join(", ")})` });
      if (!r.reply) ctx.addIssue({ code: "custom", path: at("reply"), message: "required for tier 0" });
      const isSensor = r.tool === LIVE_CONTEXT_TOOL;
      if (isSensor && !r.sensor) ctx.addIssue({ code: "custom", path: at("sensor"), message: `required with ${LIVE_CONTEXT_TOOL}` });
      if (!isSensor) {
        for (const k of ["sensor", "default_name", "reply_many"] as const) {
          if (r[k] !== undefined) ctx.addIssue({ code: "custom", path: at(k), message: `only allowed with ${LIVE_CONTEXT_TOOL}` });
        }
        if (!r.domains) ctx.addIssue({ code: "custom", path: at("domains"), message: "required for switch rules (which entity domains may be touched)" });
      } else if (r.domains || r.keywords) {
        ctx.addIssue({ code: "custom", path: at(r.domains ? "domains" : "keywords"), message: "only allowed on switch rules" });
      }
      const isLightSet = r.tool === LIGHT_SET_TOOL;
      r.patterns.forEach((p, j) => {
        const path = ["rules", i, "patterns", j];
        if (!isSensor && !p.includes("<ad>")) ctx.addIssue({ code: "custom", path, message: "switch patterns need <ad>" });
        if (isLightSet !== p.includes("<sayi>")) {
          ctx.addIssue({ code: "custom", path, message: isLightSet ? `${LIGHT_SET_TOOL} patterns need <sayi>` : `<sayi> is only allowed with ${LIGHT_SET_TOOL}` });
        }
      });
    });
  });

export type RouterFile = z.infer<typeof routerFileSchema>;
export type RouterRule = RouterFile["rules"][number];
export type DirectMessages = RouterFile["direct"]["messages"];

export class RouterConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`router.yaml is invalid:\n  - ${problems.join("\n  - ")}`);
    this.name = "RouterConfigError";
  }
}

// ---------------------------------------------------------------- patterns

export interface CompiledPattern {
  source: string;
  regex: RegExp;
  hasName: boolean;
  hasNumber: boolean;
}

/** `groups` from router.yaml: name → alternatives (each one or more words). */
export type PatternGroups = Readonly<Record<string, readonly string[]>>;

function normWord(w: string): string {
  return fold(cleanTurkish(w));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One literal word; a trailing `*` makes it a prefix. */
function wordRe(raw: string): string {
  const prefix = raw.endsWith("*") && raw.length > 1;
  const w = normWord(prefix ? raw.slice(0, -1) : raw);
  if (w === "" || w.includes(" ")) throw new Error(`'${raw}' is not a single word after normalization`);
  return escapeRe(w) + (prefix ? "\\S*" : "");
}

/**
 * Compiles a pattern into a regex over `folded + " "`: every token consumes
 * its trailing space, so optional tokens can simply be wrapped in `(?:…)?`.
 */
export function compilePattern(source: string, maxNameWords: number, groups: PatternGroups = {}): CompiledPattern {
  const tokens = source.trim().match(/\{[^}]*\}|<[^>]*>|\S+/g) ?? [];
  if (tokens.length === 0) throw new Error("empty pattern");
  let re = "^";
  let hasName = false;
  let hasNumber = false;
  for (const tok of tokens) {
    if (tok === "*") {
      re += "(?:\\S+ )*";
    } else if (tok === "<sayi>") {
      if (hasNumber) throw new Error("only one <sayi> per pattern");
      hasNumber = true;
      re += "(?<sayi>\\d{1,3}) ";
    } else if (tok.startsWith("<")) {
      if (tok !== "<ad>") throw new Error(`unknown placeholder ${tok} (only <ad>, <sayi>)`);
      if (hasName) throw new Error("only one <ad> per pattern");
      hasName = true;
      re += `(?<ad>\\S+(?: \\S+){0,${maxNameWords - 1}}?) `;
    } else if (tok.startsWith("{")) {
      if (!tok.endsWith("}")) throw new Error(`unbalanced '{' in ${tok}`);
      const alts = tok
        .slice(1, -1)
        .split("|")
        .flatMap((a) => {
          const t = a.trim();
          if (!t.startsWith("@")) return [a];
          const group = groups[t.slice(1)];
          if (!group) throw new Error(`unknown group ${t}`);
          return [...group];
        });
      const optional = alts.some((a) => a.trim() === "");
      const parts = alts
        .filter((a) => a.trim() !== "")
        .map((a) => a.trim().split(/\s+/).map(wordRe).join(" ") + " ");
      if (parts.length === 0) throw new Error(`empty group ${tok}`);
      re += `(?:${parts.join("|")})${optional ? "?" : ""}`;
    } else if (/[{}<>|]/.test(tok)) {
      throw new Error(`stray '{', '}', '<', '>' or '|' in '${tok}'`);
    } else {
      re += `${wordRe(tok)} `;
    }
  }
  return { source, regex: new RegExp(`${re}$`, "d"), hasName, hasNumber };
}

// ---------------------------------------------------------------- compiled config

export interface DirectPlan {
  rule: string;
  service: string;
  tool: DirectTool;
  /** Captured name (display form, Turkish letters kept), if the pattern had <ad>. */
  name?: string;
  /** Light-set rules: the captured <sayi>, 0..100 (percent). */
  brightness?: number;
  /** router.yaml `direct.area_aliases`: other names tried when the spoken name is not found. */
  areaAliases: string[][];
  domains: string[];
  keywords: string[];
  sensor?: SensorKind;
  defaultName?: string;
  permission?: PermissionLevel;
  reply: string;
  replyMany?: string;
  maxItems: number;
  messages: DirectMessages;
}

export interface CompiledRule {
  rule: RouterRule;
  patterns: CompiledPattern[];
}

export interface CompiledRouterConfig {
  fillers: string[];
  tier1: { maxWords: number };
  tierServices: { 1?: string[]; 2?: string[]; 3?: string[] };
  escalation: { enabled: boolean };
  direct: {
    enabled: boolean;
    onToolError: "fallback" | "reply";
    stopNames: Set<string>;
    /** Folded `name_stop_words`. */
    nameStopWords: Set<string>;
    areaAliases: string[][];
    maxItems: number;
    messages: DirectMessages;
  };
  rules: CompiledRule[];
}

function zodProblems(err: z.ZodError): string[] {
  return err.issues.map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.message}`);
}

/** Validates a parsed YAML document and compiles its patterns. Throws RouterConfigError. */
export function compileRouterConfig(doc: unknown): CompiledRouterConfig {
  const parsed = routerFileSchema.safeParse(doc);
  if (!parsed.success) throw new RouterConfigError(zodProblems(parsed.error));
  const cfg = parsed.data;
  const problems: string[] = [];
  const rules: CompiledRule[] = cfg.rules.map((rule, i) => ({
    rule,
    patterns: rule.patterns.flatMap((p, j) => {
      try {
        return [compilePattern(p, cfg.direct.max_name_words, cfg.groups)];
      } catch (err) {
        problems.push(`rules.${i}.patterns.${j} ('${p}'): ${(err as Error).message}`);
        return [];
      }
    }),
  }));
  if (problems.length > 0) throw new RouterConfigError(problems);
  return {
    fillers: cfg.fillers,
    tier1: { maxWords: cfg.tier1.max_words },
    tierServices: { 1: cfg.tier1.services, 2: cfg.tier2.services, 3: cfg.tier3.services },
    escalation: { enabled: cfg.escalation.enabled },
    direct: {
      enabled: cfg.direct.enabled,
      onToolError: cfg.direct.on_tool_error,
      stopNames: new Set(cfg.direct.stop_names.map(normWord)),
      nameStopWords: new Set(cfg.direct.name_stop_words.map(normWord)),
      areaAliases: cfg.direct.area_aliases,
      maxItems: cfg.direct.max_items,
      messages: cfg.direct.messages,
    },
    rules,
  };
}

export function parseRouterConfig(text: string): CompiledRouterConfig {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new RouterConfigError([`YAML parse error: ${(err as Error).message}`]);
  }
  return compileRouterConfig(doc);
}

export function loadRouterFile(path: string): CompiledRouterConfig {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new RouterConfigError([`cannot read ${path}: ${(err as NodeJS.ErrnoException).code ?? "error"}`]);
  }
  return parseRouterConfig(text);
}

/** Cross-checks tier-0 rules against the enabled services; returns warnings. */
export function checkRouterServices(cfg: CompiledRouterConfig, enabledServices: readonly string[]): string[] {
  const warnings: string[] = [];
  for (const { rule } of cfg.rules) {
    if (rule.tier === 0 && rule.service && !enabledServices.includes(rule.service)) {
      warnings.push(`rule '${rule.id}': service '${rule.service}' is not enabled; the request falls back to the model`);
    }
  }
  for (const [tier, list] of Object.entries(cfg.tierServices)) {
    for (const s of list ?? []) {
      if (!enabledServices.includes(s)) warnings.push(`tier${tier}.services: '${s}' is not an enabled service`);
    }
  }
  return warnings;
}

// ---------------------------------------------------------------- matching

export type RuleMatch = { rule: string; tier: 0; plan: DirectPlan } | { rule: string; tier: 1 | 2 | 3 };

/**
 * Longest (prepared) text a tier-0 rule is tried on. The longest shipped
 * command is well under 100 characters; anything longer is not a short home
 * command, so it goes to the model — and the anchored patterns never run on
 * arbitrarily long input.
 */
export const TIER0_MAX_CHARS = 200;

export function matchRules(cfg: CompiledRouterConfig, text: PreparedText): RuleMatch | undefined {
  if (text.folded === "") return undefined;
  const subject = `${text.folded} `;
  const tier0Allowed = text.folded.length <= TIER0_MAX_CHARS;
  for (const { rule, patterns } of cfg.rules) {
    if (rule.tier === 0 && !tier0Allowed) continue;
    for (const p of patterns) {
      const m = p.regex.exec(subject);
      if (!m) continue;
      if (rule.tier !== 0) return { rule: rule.id, tier: rule.tier };
      let name: string | undefined;
      const span = m.indices?.groups?.ad;
      if (span) {
        name = text.display.slice(span[0], span[1]);
        const folded = fold(name);
        if (cfg.direct.stopNames.has(folded)) continue;
        // "ışığı kapat ve mutfağı aç": the capture spans a second clause, not a name.
        if (folded.split(" ").some((w) => cfg.direct.nameStopWords.has(w))) continue;
      }
      let brightness: number | undefined;
      const num = m.groups?.sayi;
      if (num !== undefined) {
        brightness = Number(num);
        // "150'ye" is far more often a mis-heard "%50'ye" than a request: leave it to the model.
        if (brightness > 100) continue;
      }
      return {
        rule: rule.id,
        tier: 0,
        plan: {
          rule: rule.id,
          service: rule.service as string,
          tool: rule.tool as DirectTool,
          ...(name !== undefined ? { name } : {}),
          ...(brightness !== undefined ? { brightness } : {}),
          areaAliases: cfg.direct.areaAliases,
          domains: rule.domains ?? [],
          keywords: rule.keywords ?? [],
          sensor: rule.sensor,
          defaultName: rule.default_name,
          permission: rule.permission,
          reply: rule.reply as string,
          replyMany: rule.reply_many,
          maxItems: cfg.direct.maxItems,
          messages: cfg.direct.messages,
        },
      };
    }
  }
  return undefined;
}
