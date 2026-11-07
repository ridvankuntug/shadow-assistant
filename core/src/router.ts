/**
 * Model routing (T7): decides, per user turn, which execution tier handles it.
 *
 *   tier 0  no model: a router.yaml pattern maps the text straight to a Home
 *           Assistant MCP tool (see direct.ts); falls back to tier 1 if allowed
 *   tier 1  cheap model (Haiku): short answers / a single tool; may hand the
 *           turn to tier 2 with a structured escalation marker
 *   tier 2  default model (Sonnet)
 *   tier 3  Opus: only for explicit planning / deep-analysis requests (rules)
 *
 * The session executes the decision; the router only classifies text, so it is
 * pure and cheap (no I/O, no model call). Design: docs/04-router.md.
 *
 * Learned tier-0 rules (T7.w.2, docs/08) are tried only after every
 * router.yaml rule missed, from an in-memory snapshot of the active rules
 * (swapped by the store when it changes), so routing stays synchronous.
 */
import type { LiveEntity } from "./live-context.js";
import { prepareNumbers } from "./numbers.js";
import {
  matchLearnedRules,
  matchRules,
  type CompiledLearnedRule,
  type CompiledRouterConfig,
  type DirectPlan,
  type MatchText,
} from "./router-config.js";
import { prepareText } from "./turkish.js";

export type Tier = 0 | 1 | 2 | 3;

/**
 * Tier 1 writes this (and nothing else) when the request needs the stronger
 * model; see prompts/tier1.md. Never shown to the user.
 */
export const ESCALATION_MARKER = "[[ESCALATE]]";
export type ModelTier = 1 | 2 | 3;

export interface RouteInput {
  text: string;
  source: "text" | "voice";
  device: string;
}

/**
 * Why the decision was made: a router.yaml rule, an active learned rule, no
 * rule (the model by default), or no rule and a long text.
 */
export type RouteSource = "static" | "learned" | "default" | "long_input";

export interface RouteDecision {
  /** Model for the turn. For tier 0 this is the fallback model (tier 1). */
  model: string;
  /** Absent = legacy router: treated as tier 2 without escalation. */
  tier?: Tier;
  /** Tier 0 only: what to call without a model. */
  direct?: DirectPlan;
  /** Tier 0 only: whether a failed/unresolved direct call may fall back to the model. */
  fallbackOnError?: boolean;
  /** Tier 1 only: model to hand the turn to when the tier-1 model escalates. */
  escalateTo?: { tier: ModelTier; model: string };
  /** Id of the router.yaml rule that decided (for logs); `learned:<id>` for a learned rule. */
  rule?: string;
  /** Absent = a router without sources (PassthroughRouter): never learned from. */
  source?: RouteSource;
  /** `source: "learned"`: the rule's store id, for outcome reporting. */
  learnedId?: string;
  /**
   * `source: "default"` only: the text the router matched on (number words as
   * digits when there were any). The learner must build its pattern from
   * exactly this text, so the pattern matches the utterance it came from.
   */
  text?: MatchText;
}

/** One model call (or one tier-0 turn) — written to the usage JSONL (usage-log.ts). */
export interface UsageRecord {
  turnId: string;
  sessionId?: string;
  tier?: Tier;
  /** `none` for tier 0. */
  model: string;
  /** Total input tokens, cache reads and writes included (same meaning as before T7). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs: number;
  /** Estimated cost reported by the Agent SDK, if any. */
  costUsd?: number;
  /** Services whose tools were used in this call. */
  services?: string[];
  /** Service-relative tool names used in this call, in call order (duplicates kept). */
  tools?: string[];
  /** done | escalated | fallback | error | denied (tier 0: permission/confirmation refused) | cancelled */
  outcome?: UsageOutcome;
}

export type UsageOutcome = "done" | "escalated" | "fallback" | "error" | "denied" | "cancelled";

export interface Router {
  route(input: RouteInput): RouteDecision | Promise<RouteDecision>;
  onUsage?(usage: UsageRecord): void;
}

/** Pre-T7 behaviour (CORE_ROUTER=off): every turn on one model, no tiers. */
export class PassthroughRouter implements Router {
  constructor(private readonly model: string) {}

  route(): RouteDecision {
    return { model: this.model, tier: 2 };
  }
}

export interface TierModels {
  1: string;
  2: string;
  3: string;
}

export interface TieredRouterOptions {
  config: CompiledRouterConfig;
  models: TierModels;
  /** Usage sink (the usage JSONL writer). */
  onUsage?: (usage: UsageRecord) => void;
  /**
   * Active learned rules (learn/store.ts snapshot, read on every route) and
   * the run-time target check (learn/extract.ts). Absent = no learned rules.
   */
  learned?: {
    rules: () => readonly CompiledLearnedRule[];
    targetFilter: (entity: LiveEntity) => boolean;
  };
}

export class TieredRouter implements Router {
  constructor(private readonly opts: TieredRouterOptions) {}

  route(input: RouteInput): RouteDecision {
    const cfg = this.opts.config;
    const models = this.opts.models;
    const tier1: RouteDecision = {
      model: models[1],
      tier: 1,
      ...(cfg.escalation.enabled ? { escalateTo: { tier: 2 as ModelTier, model: models[2] } } : {}),
    };
    const prepared = prepareText(input.text, cfg.fillers);
    // Number words ("yüzde elli", "yüzlü yap") are tried only when the text as
    // said matches nothing: a request that matched before T7.w.1 is routed the
    // same way; a name holding a number word ("oda iki") is captured as said in both passes.
    // The converted form is used for matching only; input.text (shown, logged,
    // sent to the model) is untouched.
    let hit = matchRules(cfg, prepared);
    // Second pass with number words as digits (T7.w.1); skipped when nothing changed.
    const numeric = hit ? undefined : prepareNumbers(prepared);
    if (!hit && numeric) hit = matchRules(cfg, numeric);
    if (hit) {
      if (hit.tier === 0) {
        if (cfg.direct.enabled) {
          return {
            model: models[1],
            tier: 0,
            direct: hit.plan,
            fallbackOnError: cfg.direct.onToolError === "fallback",
            escalateTo: tier1.escalateTo,
            rule: hit.rule,
            source: "static",
          };
        }
        // Direct calls disabled: the model handles the request.
        return { ...tier1, rule: hit.rule, source: "static" };
      }
      if (hit.tier === 1) return { ...tier1, rule: hit.rule, source: "static" };
      return { model: models[hit.tier], tier: hit.tier, rule: hit.rule, source: "static" };
    }
    // The one text learned rules match on and learn from.
    const text: MatchText = numeric ?? prepared;
    // Learned rules: after every static rule; they always fall back to the model when they fail.
    const learned = this.opts.learned;
    if (learned && cfg.direct.enabled && cfg.learning.enabled) {
      const lhit = matchLearnedRules(cfg, learned.rules(), text, learned.targetFilter);
      if (lhit) {
        return {
          model: models[1],
          tier: 0,
          direct: lhit.plan,
          fallbackOnError: true,
          escalateTo: tier1.escalateTo,
          rule: lhit.plan.rule,
          source: "learned",
          learnedId: lhit.rule.def.id,
        };
      }
    }
    // No rule: long requests skip the cheap model (an escalation would cost a second call).
    const words = prepared.display === "" ? 0 : prepared.display.split(" ").length;
    if (words > cfg.tier1.maxWords) return { model: models[2], tier: 2, rule: "long_input", source: "long_input" };
    return { ...tier1, rule: "default", source: "default", text };
  }

  onUsage(usage: UsageRecord): void {
    this.opts.onUsage?.(usage);
  }
}
