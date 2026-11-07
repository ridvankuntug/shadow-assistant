/**
 * Pattern learning, pure part (T7.w.2b, docs/08 §Extraction algorithm).
 *
 * Turns one model turn that made exactly one simple Home Assistant call into
 * a learned-pattern observation, or into a reject reason. Nothing here does
 * I/O: the session hands in the calls the gate saw, the text the router
 * matched on and a fresh live context; the store (store.ts) counts the result.
 *
 * The core idea is a dry run: a span of the utterance only becomes `<ad>`
 * when the existing tier-0 executor (direct.ts), replayed on this utterance,
 * would have made exactly the call the model made; of the spans that survive
 * steps 3-5 the widest is `<ad>` when it holds all the others, else
 * `name_ambiguous`. Cross-check (T7.w.9): the
 * span resolves to exactly one live-context entity and that entity is the
 * one the model's call targeted (the call itself must identify exactly one).
 * Everything else is default deny:
 *   layer 1  tool ceiling (LEARNABLE_TOOLS on LEARNABLE_SERVICE, router.yaml narrows)
 *   layer 2  domain ceiling (LEARNABLE_DOMAINS, NEVER_LEARNABLE_DOMAINS first;
 *            brightness on lights only)
 *   layer 3  target check: a switch only with device_class outlet, never a
 *            device_class from services.yaml confirm_inputs, never a target
 *            whose name / alias / area starts with a deny word
 *   layer 4  the gate: the action ran at level `write` (checked here at learn
 *            time; at run time the learned plan goes through Session.authorize()).
 *
 * Only token words, tool, domain and device words leave this module; names,
 * numbers and arguments are never part of a result.
 */
import { directCallArgs, resolveWithAliases } from "../direct.js";
import type { LiveEntity } from "../live-context.js";
import {
  compileLearnedRule,
  isLearnableDomain,
  LEARNABLE_SERVICE,
  learnableDomainsFor,
  LEARNED_WORD,
  LIGHT_SET_TOOL,
  LIVE_CONTEXT_TOOL,
  matchLearnedRules,
  NAME_SLOT,
  NEVER_LEARNABLE_DOMAINS,
  NUMBER_SLOT,
  TIER0_MAX_CHARS,
  type CompiledRouterConfig,
  type DirectPlan,
  type LearnableTool,
  type MatchText,
} from "../router-config.js";
import type { PermissionLevel, ServiceDef } from "../services.js";
import { cleanTurkish, fold, stemCandidates } from "../turkish.js";

/** One tool call of the turn as the gate saw it (arguments stay in memory for the turn only). */
export interface ObservedCall {
  /** Configured service, if the name identified one. */
  service?: string;
  /** Service-relative tool name. */
  tool: string;
  args: Record<string, unknown>;
  /** Level the gate applied (`deny` = built-in tool). */
  level: PermissionLevel | "deny";
  allowed: boolean;
  /** The tool result's `isError`; undefined when no result was seen. */
  isError?: boolean;
}

export interface ObservedTurn {
  /** The router sent the turn to the model because no rule matched (`source: "default"`). */
  routedByDefault: boolean;
  /** Ended `done`: not cancelled, no timeout, no usage limit, no error. */
  completed: boolean;
  /** CORE_READ_ONLY. */
  readOnly: boolean;
  /** The text the router matched on (see router.ts). */
  text: MatchText;
  /** Every gated call of the turn, across all attempts (an escalated turn has two). */
  calls: readonly ObservedCall[];
}

export type RejectReason =
  | "not_default"
  | "not_done"
  | "read_only"
  | "empty_text"
  | "too_long"
  | "denied"
  | "no_action"
  | "extra_calls"
  | "not_write"
  | "no_result"
  | "tool_error"
  | "tool_not_learnable"
  | "unexplained_arg"
  | "area_target"
  | "no_name"
  | "bad_domain"
  | "domain_not_learnable"
  | "target_refused"
  | "model_target_unresolved"
  | "name_not_in_text"
  | "name_ambiguous"
  | "number_not_in_text"
  | "stray_number"
  | "bad_word"
  | "name_word_in_pattern"
  | "round_trip";

/** What the extractor needs to know about the configuration. */
export interface LearnPolicy {
  config: CompiledRouterConfig;
  /** Lower-cased `confirm_inputs.device_class` values of every enabled service. */
  confirmDeviceClasses: ReadonlySet<string>;
}

/** Builds the policy from router.yaml and services.yaml. */
export function learnPolicy(config: CompiledRouterConfig, services: readonly ServiceDef[]): LearnPolicy {
  const classes = new Set<string>();
  for (const s of services) {
    if (!s.enabled) continue;
    for (const c of s.confirmInputs.device_class ?? []) classes.add(c.trim().toLowerCase());
  }
  return { config, confirmDeviceClasses: classes };
}

/** How a learned rule fills the call's arguments. */
export interface Binding {
  name: "ad";
  brightness?: "sayi";
}

/** A pattern learned from one turn; the store counts these. */
export interface Extracted {
  tokens: string[];
  service: string;
  tool: LearnableTool;
  /** The one target domain (signature part). */
  domains: [string];
  /** Device words the dry run used; stored so a later router.yaml change cannot widen the rule. */
  keywords: string[];
  binding: Binding;
  /** service + tool + target domain + binding; entity and number are not part of it. */
  signature: string;
}

export type Result<T> = { ok: true; value: T } | { ok: false; reason: RejectReason };
const reject = (reason: RejectReason): { ok: false; reason: RejectReason } => ({ ok: false, reason });

const key = (s: string) => fold(cleanTurkish(s));

/**
 * Eligibility of a whole turn (docs/08 §Which turns are observed). Returns
 * the one action call. Cheap: run before the live context is read.
 */
export function checkTurn(turn: ObservedTurn, policy: LearnPolicy): Result<ObservedCall> {
  if (!turn.routedByDefault) return reject("not_default");
  if (!turn.completed) return reject("not_done");
  if (turn.readOnly) return reject("read_only");
  if (turn.text.folded === "") return reject("empty_text");
  if (turn.text.folded.length > TIER0_MAX_CHARS) return reject("too_long");
  if (turn.calls.some((c) => !c.allowed)) return reject("denied");
  const actions: ObservedCall[] = [];
  for (const c of turn.calls) {
    const isRead = c.service === LEARNABLE_SERVICE && c.tool === LIVE_CONTEXT_TOOL && c.level === "read";
    if (!isRead) actions.push(c);
  }
  if (actions.length === 0) return reject("no_action");
  // "One simple call": any other call — a second write, a memory or vault tool — disqualifies.
  if (actions.length > 1) return reject("extra_calls");
  const action = actions[0] as ObservedCall;
  if (action.level !== "write") return reject("not_write");
  if (action.isError === undefined) return reject("no_result");
  if (action.isError) return reject("tool_error");
  if (action.service !== LEARNABLE_SERVICE || !policy.config.learning.tools.has(action.tool)) return reject("tool_not_learnable");
  return { ok: true, value: action };
}

/**
 * Safety layers 2 and 3 for one live-context entity; the same function is the
 * run-time `targetFilter` of every learned plan.
 */
export function learnTargetFilter(policy: LearnPolicy): (entity: LiveEntity) => boolean {
  const learning = policy.config.learning;
  const deny = [...learning.denyNameWords];
  return (entity) => {
    const domain = entity.domain;
    if (NEVER_LEARNABLE_DOMAINS.has(domain) || !isLearnableDomain(domain) || !learning.domains.has(domain)) return false;
    const raw = entity.attributes.device_class;
    const deviceClass = typeof raw === "string" ? raw.trim().toLowerCase() : undefined;
    // A switch can drive a door relay: only positive evidence of a plug counts.
    if (domain === "switch" && deviceClass !== "outlet") return false;
    if (raw !== undefined && deviceClass === undefined) return false;
    if (deviceClass !== undefined && policy.confirmDeviceClasses.has(deviceClass)) return false;
    // Substring match: suffixed and compound forms too ("Garaj Kapısı" → "kapisi",
    // "Bahçekapısı" → "bahcekapisi"). Refusing too much is the safe side.
    const words = [...entity.names, ...entity.areas].flatMap((n) => key(n).split(" "));
    return !words.some((w) => w !== "" && deny.some((d) => w.includes(d)));
  };
}

const ALLOWED_KEYS = new Set(["name", "area", "domain"]);

/** Step 1 (explain every argument): the target and the number the model asked for, or a reason. */
function readArgs(
  tool: LearnableTool,
  args: Record<string, unknown>,
  policy: LearnPolicy,
): Result<{ name: string; area?: string; domain: string; brightness?: number }> {
  for (const k of Object.keys(args)) {
    if (!ALLOWED_KEYS.has(k) && !(k === "brightness" && tool === LIGHT_SET_TOOL)) return reject("unexplained_arg");
  }
  const { name, area, domain, brightness } = args;
  if (name === undefined) return reject(area !== undefined ? "area_target" : "no_name");
  if (typeof name !== "string" || name.trim() === "") return reject("unexplained_arg");
  if (area !== undefined && (typeof area !== "string" || area.trim() === "")) return reject("unexplained_arg");
  // The executor always passes exactly one domain; a call without one (or with several) is not the call it would make.
  const domains = typeof domain === "string" ? [domain] : Array.isArray(domain) ? domain : undefined;
  if (!domains || domains.length === 0 || !domains.every((d): d is string => typeof d === "string")) return reject("bad_domain");
  const set = new Set(domains.map((d) => d.trim().toLowerCase()));
  if (set.size !== 1) return reject("bad_domain");
  const target = [...set][0] as string;
  if (!learnableDomainsFor(tool, policy.config.learning.domains).includes(target)) return reject("domain_not_learnable");
  let level: number | undefined;
  if (tool === LIGHT_SET_TOOL) {
    if (typeof brightness !== "number" || !Number.isInteger(brightness) || brightness < 0 || brightness > 100) return reject("unexplained_arg");
    level = brightness;
  }
  return { ok: true, value: { name, ...(typeof area === "string" ? { area } : {}), domain: target, ...(level !== undefined ? { brightness: level } : {}) } };
}

/** The outcome signature (docs/08 §"Same outcome"): service + tool + target domain + argument binding. */
export function signatureOf(r: { service: string; tool: string; domains: readonly string[]; binding: Binding }): string {
  return [r.service, r.tool, r.domains.join(","), `name=${r.binding.name}`, ...(r.binding.brightness ? [`brightness=${r.binding.brightness}`] : [])].join("|");
}

/**
 * Steps 1-5 for the action of an eligible turn. `entities`: a live context
 * read after the turn (the learner's own read). Returns the pattern, or why
 * none was learned.
 */
export function extractPattern(text: MatchText, action: ObservedCall, entities: readonly LiveEntity[], policy: LearnPolicy): Result<Extracted> {
  const cfg = policy.config;
  if (action.service !== LEARNABLE_SERVICE || !cfg.learning.tools.has(action.tool)) return reject("tool_not_learnable");
  const tool = action.tool as LearnableTool;
  const parsed = readArgs(tool, action.args, policy);
  if (!parsed.ok) return parsed;
  const want = parsed.value;
  // Cross-check (T7.w.9): the entity the model's call targeted; every `<ad>` span must resolve to this one.
  const target = modelTarget(entities, want);
  if (!target) return reject("model_target_unresolved");

  // Step 2: the name slot, by dry-running the executor on every span.
  const words = text.display.split(" ");
  const offsets: number[] = [];
  let at = 0;
  for (const w of words) {
    offsets.push(at);
    at += w.length + 1;
  }
  const domains = learnableDomainsFor(tool, cfg.learning.domains);
  const keywords = [...new Set(domains.flatMap((d) => cfg.learning.keywords[d] ?? []))];
  const filter = learnTargetFilter(policy);
  const nameWords = homeNameWords(entities, cfg);
  const plan = (name: string): DirectPlan => ({
    rule: "learned:dry-run",
    service: LEARNABLE_SERVICE,
    tool,
    name,
    ...(want.brightness !== undefined ? { brightness: want.brightness } : {}),
    areaAliases: cfg.direct.areaAliases,
    domains,
    keywords,
    reply: "",
    maxItems: cfg.direct.maxItems,
    messages: cfg.direct.messages,
  });
  const good: Array<{ start: number; end: number; name: string; entity: LiveEntity }> = [];
  let refused = false;
  for (let i = 0; i < words.length; i++) {
    for (let j = i + 1; j <= Math.min(words.length, i + cfg.direct.maxNameWords); j++) {
      const s = offsets[i] as number;
      const e = (offsets[j - 1] as number) + (words[j - 1] as string).length;
      const name = text.original ? text.original(s, e) : text.display.slice(s, e);
      const folded = fold(name);
      if (folded === "" || cfg.direct.stopNames.has(folded)) continue;
      if (folded.split(" ").some((w) => cfg.direct.nameStopWords.has(w))) continue;
      const p = plan(name);
      const res = resolveWithAliases(entities, p);
      if (res.status !== "ok") continue;
      const args = directCallArgs(p, res);
      const sameName = key(String(args.name)) === key(want.name);
      const sameArea = args.area === undefined ? want.area === undefined : want.area !== undefined && key(String(args.area)) === key(want.area);
      if (!sameName || !sameArea || res.entity.domain !== want.domain || res.entity !== target) continue;
      if (!filter(res.entity)) {
        refused = true;
        continue;
      }
      good.push({ start: i, end: j, name, entity: res.entity });
    }
  }
  if (good.length === 0) return reject(refused ? "target_refused" : "name_not_in_text");
  // A span that cannot become a whole pattern (steps 3-5) is not a candidate:
  // for "lamba 2 … yüzde 40 …" the span "lamba" leaves a stray "2", so only
  // "lamba 2" counts — the digit of a name is never taken for a level.
  const done: Array<{ start: number; end: number; value: Extracted }> = [];
  let firstFailure: RejectReason | undefined;
  for (const span of good) {
    const r = completePattern(text, words, span, tool, want, keywords, entities, policy, filter, nameWords, target);
    if (r.ok) done.push({ start: span.start, end: span.end, value: r.value });
    else firstFailure ??= r.reason;
  }
  if (done.length === 0) return reject(good.length > 1 ? "name_ambiguous" : (firstFailure as RejectReason));
  // Every surviving span names the model's target (cross-check). Spans nested
  // in one another differ only in whether a device word is inside the slot
  // ("tavan" + "lambasını" vs "tavan lambasını"): the longest one is `<ad>`,
  // as the executor reads the whole name. Spans side by side stay ambiguous.
  const widest = done.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
  if (done.some((d) => d.start < widest.start || d.end > widest.end)) return reject("name_ambiguous");
  return { ok: true, value: widest.value };
}

/**
 * The one live-context entity the model's call names (T7.w.9): the call's
 * domain, a name or alias equal to its `name` and, when the call carries an
 * `area`, an area equal to it. Zero or several such entities → undefined: the
 * call does not identify one entity, so nothing is learned from it.
 */
function modelTarget(entities: readonly LiveEntity[], want: { name: string; area?: string; domain: string }): LiveEntity | undefined {
  const name = key(want.name);
  const area = want.area === undefined ? undefined : key(want.area);
  const hits = entities.filter(
    (e) => e.domain === want.domain && e.names.some((n) => key(n) === name) && (area === undefined || e.areas.some((a) => key(a) === area)),
  );
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * Folded word with the consonants Turkish softens before a vowel suffix
 * merged (k/ğ, t/d, p/b; ç/c already fold to c): "mutfağımızdaki" and
 * "mutfak" share a prefix. Applied to every position, so it can only merge
 * more words, never fewer (fail closed).
 */
const unsoften = (folded: string) => folded.replace(/g/g, "k").replace(/d/g, "t").replace(/b/g, "p");

/**
 * Folded words of every entity name, alias and area in the live context and
 * of every `direct.area_aliases` place name ("oturma odası" can be a room
 * name the live context does not spell). A literal pattern word that is one
 * of these (any case-suffix form) would put a room or device name into
 * rules.json ("salon tavan lambasını aç" with the target "Tavan Lambası"), so
 * such a pattern is refused.
 *
 * Name words first (T7.w.9): a literal that looks like a device word plus a
 * suffix gets no exemption of its own — "prizma" and "lambada" have that form
 * yet can be home names. Only a name word that *is* a configured device word
 * (`learning.keywords`, any domain, e.g. "lamba" in "Salon Lamba", "lambası"
 * in "Tavan Lambası") is left out, because it names nothing: the generic
 * words of the committed router.yaml are not the home's names.
 */
function homeNameWords(entities: readonly LiveEntity[], cfg: CompiledRouterConfig): ReadonlySet<string> {
  const deviceWords = new Set(Object.values(cfg.learning.keywords).flat().map(key));
  const words = new Set<string>();
  const add = (n: string) => {
    for (const w of key(n).split(" ")) if (w !== "" && !/^\d+$/.test(w) && !deviceWords.has(w)) words.add(w);
  };
  for (const e of entities) for (const n of [...e.names, ...e.areas]) add(n);
  for (const group of cfg.direct.areaAliases) for (const n of group) add(n);
  return words;
}

/** Shortest name word compared as a prefix ("oda" in "odamızdaki"); shorter ones only by stem. */
const MIN_PREFIX = 3;

function isHomeNameWord(word: string, home: ReadonlySet<string>): boolean {
  const soft = unsoften(key(word));
  // Stems before folding: the softened-consonant table works on Turkish letters ("mutfağı" → "mutfak").
  if (stemCandidates(cleanTurkish(word)).some((c) => home.has(fold(c)))) return true;
  // Suffixes stemCandidates does not strip ("kahvesi", "salonumuzun",
  // "odamızdaki", "mutfağımızdaki", "lambaderin"): a name word of 3+ letters
  // the word starts with, softening folded on both sides.
  for (const w of home) if (w.length >= MIN_PREFIX && soft.startsWith(unsoften(w))) return true;
  return false;
}

/** Steps 3-5 for one name span. */
function completePattern(
  text: MatchText,
  words: readonly string[],
  span: { start: number; end: number; name: string; entity: LiveEntity },
  tool: LearnableTool,
  want: { domain: string; brightness?: number },
  keywords: string[],
  entities: readonly LiveEntity[],
  policy: LearnPolicy,
  filter: (entity: LiveEntity) => boolean,
  home: ReadonlySet<string>,
  target: LiveEntity,
): Result<Extracted> {
  const cfg = policy.config;
  // Step 3: the number slot, outside the name.
  const digitAt: number[] = [];
  words.forEach((w, k) => {
    if ((k < span.start || k >= span.end) && /^\d+$/.test(w)) digitAt.push(k);
  });
  let numberAt: number | undefined;
  if (want.brightness !== undefined) {
    const hits = digitAt.filter((k) => (words[k] as string).length <= 3 && Number(words[k]) === want.brightness);
    if (hits.length === 0) return reject("number_not_in_text");
    numberAt = hits[0] as number;
  }
  if (digitAt.some((k) => k !== numberAt)) return reject("stray_number");

  // Step 4: literal words.
  const tokens: string[] = [];
  for (let k = 0; k < words.length; k++) {
    if (k === span.start) tokens.push(NAME_SLOT);
    if (k >= span.start && k < span.end) continue;
    if (k === numberAt) {
      tokens.push(NUMBER_SLOT);
      continue;
    }
    const w = words[k] as string;
    if (!LEARNED_WORD.test(w)) return reject("bad_word");
    if (isHomeNameWord(w, home)) return reject("name_word_in_pattern");
    tokens.push(w);
  }

  const binding: Binding = { name: "ad", ...(want.brightness !== undefined ? { brightness: "sayi" as const } : {}) };
  const value: Extracted = {
    tokens,
    service: LEARNABLE_SERVICE,
    tool,
    domains: [want.domain],
    keywords,
    binding,
    signature: signatureOf({ service: LEARNABLE_SERVICE, tool, domains: [want.domain], binding }),
  };

  // Step 5: round trip with the learned-rule matcher, then the stored rule's own dry run.
  let hit;
  try {
    const rule = compileLearnedRule({ id: "lr-roundtrip", tokens, service: LEARNABLE_SERVICE, tool, domains: value.domains, keywords }, cfg.direct.maxNameWords);
    hit = matchLearnedRules(cfg, [rule], text, filter);
  } catch {
    return reject("round_trip");
  }
  if (!hit || hit.plan.name !== span.name || hit.plan.brightness !== want.brightness) return reject("round_trip");
  const replay = resolveWithAliases(entities, hit.plan);
  if (replay.status !== "ok" || replay.entity !== span.entity || replay.entity !== target || !filter(replay.entity)) return reject("round_trip");
  return { ok: true, value };
}
