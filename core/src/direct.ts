/**
 * Tier 0 executor: runs a router.yaml direct plan without a model.
 *
 * Every tool call goes through `call`, which the session implements with the
 * same permission gate the model's tool calls use (read / write / confirm,
 * services.yaml rules, `confirm_inputs`, read-only mode) — tier 0 has no
 * private way around it.
 *
 * Switch rules first read the live context (a `read` tool) to resolve the
 * spoken name to exactly one exposed entity of an allowed domain, then call
 * HassTurnOn/Off with that entity's real `name` and its `domain` (so
 * `confirm_inputs: domain: [lock, …]` still applies). A name that matches
 * nothing is retried with its `direct.area_aliases` synonyms ("salon" →
 * "oturma odası"). Light-set rules resolve the same way and call
 * HassLightSet with `brightness`. Sensor rules read the live context and
 * summarise it with a template.
 *
 * Learned rules (T7.w.2) run through the same code; their plan carries a
 * `targetFilter` (safety layer 3, docs/08), and so do static turn-on / off
 * rules (only lights and `device_class: outlet` switches, T7.w.10 / T7.w.12,
 * and no deny name word) and static light-set rules (no deny name word,
 * T7.w.13): a resolved entity it refuses is not called and the turn falls back
 * to the model.
 *
 * Confirmed names (docs/14 Decision 6, T4.4b): only when the spoken name
 * matches no HA name or alias at all (HA names always win) are its stem forms
 * looked up in the confirmed-name store; the entry's fingerprint must be
 * present exactly once in the same live context, and the entity then passes
 * the same rule domains and `targetFilter` as an HA-name match. Its call
 * carries `provenance: "mapping"`; a successful call counts one use. Every
 * parsed live context is handed to the store's missing-clock sweep.
 */
import { LIGHT_SET_TOOL, LIVE_CONTEXT_TOOL, type DirectPlan } from "./router-config.js";
import type { ConfirmedName, ConfirmedNameStore } from "./confirmed-names.js";
import {
  callTarget,
  fillTemplate,
  findReadings,
  formatReading,
  LiveContextError,
  nameKeys,
  parseLiveContext,
  resolveDevice,
  type LiveEntity,
  type Resolution,
} from "./live-context.js";
import { aliasVariants } from "./turkish.js";
import type { DirectToolResult } from "./mcp-direct.js";

export type DenyReason = "read_only" | "declined" | "timeout" | "cancelled" | "builtin";

export type GatedCallResult =
  | { status: "ok"; result: DirectToolResult }
  | { status: "denied"; reason: DenyReason }
  | { status: "unavailable"; message: string };

/**
 * Where a call's target came from (docs/14 Decision 4): `user` = tier 0
 * resolved it from the spoken `<ad>` slot; `mapping` = through a confirmed
 * name (T4.4b). With a hint the write gate skips its target check (no text
 * match, no live-context read); the question lock still applies.
 */
export type TargetProvenanceHint = "user" | "mapping";

export interface GatedCallOptions {
  provenance?: TargetProvenanceHint;
}

/** Gate + call + client frames/logs for one tool call; implemented by the session. */
export type GatedCall = (tool: string, args: Record<string, unknown>, opts?: GatedCallOptions) => Promise<GatedCallResult>;

export type DirectOutcome =
  /** Answer the user with `text` (success or a short Turkish error). */
  | { kind: "reply"; text: string; status: "done" | "error" | "denied" }
  /** Hand the turn to the model; nothing was changed in the home. */
  | { kind: "fallback"; reason: string }
  /** Turn cancelled by the user: no answer. */
  | { kind: "cancelled" };

/** What tier 0 needs of the confirmed-name store (T4.4b). */
export type DirectNames = Pick<ConfirmedNameStore, "lookup" | "verify" | "recordUse" | "sweep">;

export interface DirectOptions {
  /** router.yaml `direct.on_tool_error`: may unresolved/failed requests go to the model? */
  fallbackOnError: boolean;
  /** Confirmed names (docs/14 Decision 6); absent = HA names only, no sweep. */
  names?: DirectNames;
}

export async function runDirectPlan(plan: DirectPlan, call: GatedCall, opts: DirectOptions): Promise<DirectOutcome> {
  const m = plan.messages;
  const failOr = (reason: string, text: string): DirectOutcome =>
    opts.fallbackOnError ? { kind: "fallback", reason } : { kind: "reply", text, status: "error" };
  const denied = (reason: DenyReason): DirectOutcome => {
    if (reason === "cancelled") return { kind: "cancelled" };
    return { kind: "reply", text: reason === "read_only" ? m.read_only : m.declined, status: "denied" };
  };

  // 1) live context (read)
  const ctx = await call(LIVE_CONTEXT_TOOL, {});
  if (ctx.status === "denied") return denied(ctx.reason);
  if (ctx.status === "unavailable") return { kind: "reply", text: m.unavailable, status: "error" };
  if (ctx.result.isError) return failOr("live_context_error", m.failed);
  let entities;
  try {
    entities = parseLiveContext(ctx.result.text);
  } catch (err) {
    if (err instanceof LiveContextError) return failOr("live_context_unparseable", m.failed);
    throw err;
  }
  // The missing clock of the confirmed names (an unfiltered read: no arguments). The store ignores an
  // invalid (e.g. empty) snapshot and never rejects; it runs off the turn path.
  void opts.names?.sweep(entities);

  // 2a) sensor question: answer from the context
  if (plan.tool === LIVE_CONTEXT_TOOL) {
    const kind = plan.sensor ?? "temperature";
    const readings = findReadings(entities, kind, { name: plan.name, defaultName: plan.defaultName, max: plan.maxItems });
    if (readings.length === 0) return failOr("sensor_not_found", m.not_found);
    if (readings.length === 1 || !plan.replyMany) {
      const r = readings[0] as (typeof readings)[number];
      return { kind: "reply", text: fillTemplate(plan.reply, { ad: r.label, deger: formatReading(kind, r.value) }), status: "done" };
    }
    const liste = readings.map((r) => `${r.label} ${formatReading(kind, r.value)}`).join(", ");
    return { kind: "reply", text: fillTemplate(plan.replyMany, { liste }), status: "done" };
  }

  // 2b) switch: resolve the name, then call the intent
  if (plan.name === undefined) return failOr("no_name", m.not_found);
  const res = resolvePlanTarget(entities, plan, opts.names);
  if (res.status === "none") return failOr("name_not_found", m.not_found);
  if (res.status === "ambiguous") return failOr("name_ambiguous", m.ambiguous);
  // Always the model, whatever `direct.on_tool_error` says: nothing was called, and a
  // refused target (a static switch rule's non-plug switch, a denied name on a static rule, a learned rule's denied
  // target) is one the model should handle, not one to answer "not found" for.
  if (res.status === "refused") return { kind: "fallback", reason: "target_refused" };
  if (plan.tool === LIGHT_SET_TOOL && plan.brightness === undefined) return failOr("no_brightness", m.failed);

  // The target is the entity the user's spoken name resolved to (provenance rule 1), or the
  // one the user confirmed for these words earlier (rule 2).
  const act = await call(plan.tool, directCallArgs(plan, res), { provenance: res.nameId !== undefined ? "mapping" : "user" });
  if (act.status === "denied") return denied(act.reason);
  if (act.status === "unavailable") return { kind: "reply", text: m.unavailable, status: "error" };
  if (act.result.isError) return failOr("tool_error", m.failed);
  if (res.nameId !== undefined) void opts.names?.recordUse(res.nameId);
  const vars: Record<string, string> = { ad: res.label };
  if (plan.brightness !== undefined) vars.seviye = String(plan.brightness);
  return { kind: "reply", text: fillTemplate(plan.reply, vars), status: "done" };
}

/** The arguments of a switch / light-set call for a resolved target (also replayed by the learner, learn/extract.ts). */
export function directCallArgs(plan: DirectPlan, res: Extract<Resolution, { status: "ok" }>): Record<string, unknown> {
  return {
    name: res.callName,
    ...(res.area ? { area: res.area } : {}),
    domain: [res.entity.domain],
    ...(plan.tool === LIGHT_SET_TOOL ? { brightness: plan.brightness } : {}),
  };
}

/** `nameId`: the resolution came from this confirmed name (provenance `mapping`). */
export type TargetResolution =
  | (Extract<Resolution, { status: "ok" }> & { nameId?: string })
  | Exclude<Resolution, { status: "ok" }>
  | { status: "refused" };

/**
 * `resolveWithAliases()`, then the plan's `targetFilter` (learned rules, static switch and light-set rules)
 * on the one resolved entity: a refused target is never called. Without a
 * filter this is exactly `resolveWithAliases()`.
 *
 * With `names`, a spoken name that matches nothing (`none`, after the area
 * synonyms) is looked up in the active confirmed names; an entry whose
 * fingerprint is present exactly once in `entities` yields that entity, which
 * must be of one of the rule's `domains` and pass the same `targetFilter`
 * (a confirmed name never reaches a target the rule could not reach by its HA
 * name). A missing, ambiguous or passive entry leaves the result `none`.
 */
export function resolvePlanTarget(entities: readonly LiveEntity[], plan: DirectPlan, names?: Pick<DirectNames, "lookup" | "verify">): TargetResolution {
  let res: TargetResolution = resolveWithAliases(entities, plan);
  if (res.status === "none" && names && plan.name !== undefined && !haNameAnyDomain(entities, plan)) res = confirmedTarget(entities, plan, names) ?? res;
  if (res.status === "ok" && plan.targetFilter && !plan.targetFilter(res.entity)) return { status: "refused" };
  return res;
}

/**
 * Whether the spoken name (or an area synonym) matches an HA name, alias or
 * area of any domain, not only the rule's: HA names always win (docs/14
 * Decision 6), so such words are never resolved through a confirmed name
 * (e.g. a "Perde" cover added after "perde" was confirmed for a plug).
 */
function haNameAnyDomain(entities: readonly LiveEntity[], plan: DirectPlan): boolean {
  const all = [...new Set(entities.map((e) => e.domain))];
  return resolveWithAliases(entities, { ...plan, domains: all }).status !== "none";
}

/** The confirmed-name fallback of `resolvePlanTarget`; undefined = no usable entry. */
function confirmedTarget(entities: readonly LiveEntity[], plan: DirectPlan, names: Pick<DirectNames, "lookup" | "verify">): TargetResolution | undefined {
  const entry: Readonly<ConfirmedName> | undefined = names.lookup(nameKeys(plan.name ?? ""));
  if (!entry) return undefined;
  const v = names.verify(entry, entities);
  if (v.status !== "present") return undefined;
  // The rule's domains bound a confirmed name exactly as they bound an HA name.
  if (!plan.domains.includes(v.entity.domain)) return { status: "refused" };
  const res = callTarget(entities, v.entity, v.entity.names[0] as string);
  return res.status === "ok" ? { ...res, nameId: entry.id } : res;
}

/**
 * Resolves the spoken name; only when it matches nothing at all are its
 * synonyms (`direct.area_aliases`) tried, in order — an ambiguous name stays
 * ambiguous (the model asks back), it is never "fixed" by a synonym.
 */
export function resolveWithAliases(entities: readonly LiveEntity[], plan: DirectPlan): Resolution {
  const opts = { domains: plan.domains, keywords: plan.keywords };
  const first = resolveDevice(entities, plan.name ?? "", opts);
  if (first.status !== "none" || plan.name === undefined) return first;
  for (const alt of aliasVariants(plan.name, plan.areaAliases)) {
    const res = resolveDevice(entities, alt, opts);
    if (res.status !== "none") return res;
  }
  return first;
}
