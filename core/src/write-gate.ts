/**
 * Write gate decision logic (docs/14, Decisions 2-4). Pure: no I/O, no clock,
 * no state. `Session.authorize` (T4.3b) supplies the turn text, the window of
 * the last user utterances, an optional live-context snapshot and the active
 * confirmed names, and turns the answers below into a raised level.
 *
 *   isQuestionTurn     the question lock (Decision 3): is this turn's raw text
 *                      a question? A question turn raises every target-checked
 *                      write to `confirm`.
 *   targetProvenance   the target check (Decision 4 rules 3-5, Decision 2 broad
 *                      calls): did the user name the target of this call?
 *                      Unknown raises a `write` to `confirm`.
 *
 * Both only ever feed a raise; neither lowers a level nor denies by itself.
 */
import { resolveDevice, type LiveEntity } from "./live-context.js";
import { cleanTurkish, fold, stemCandidates } from "./turkish.js";

// ---------------------------------------------------------------- shared text helpers

const key = (s: string) => fold(cleanTurkish(s));

/** Display words (Turkish letters kept) of a raw text. */
const displayWords = (text: string) => cleanTurkish(text).split(" ").filter(Boolean);

/**
 * Suffixes the gate strips in addition to `stemCandidates` (tier 0 keeps its
 * own list unchanged): dative ("listesine", "lambaya", "salona") and ablative
 * ("salondan", "odasından"). Gate-local on purpose (docs/14 T4.3a): a wrong
 * stem only fails to equal a target word, and a stem that does equal one came
 * from the user's own word.
 */
const GATE_SUFFIXES = [/[ae]$/u, /[yn][ae]$/u, /[dt][ae]n$/u, /n[dt][ae]n$/u];
/** Final consonant softened before a vowel suffix (same map as `stemCandidates`). */
const UNSOFTEN: Record<string, string> = { ğ: "k", b: "p", c: "ç", d: "t" };
/** Shortest stem a second stripping step may produce (keeps short false hits out). */
const SECOND_STEM_MIN = 3;

/** One stripping step: `stemCandidates` plus the gate-local suffixes (display form). */
function stripOnce(word: string): string[] {
  const out = stemCandidates(word);
  if (word.length > 3) {
    for (const suffix of GATE_SUFFIXES) {
      if (!suffix.test(word)) continue;
      const stem = word.replace(suffix, "");
      if (stem.length < 2) continue;
      out.push(stem);
      const hard = UNSOFTEN[stem.slice(-1)];
      if (hard) out.push(stem.slice(0, -1) + hard);
    }
  }
  return out;
}

const formsCache = new Map<string, ReadonlySet<string>>();

/**
 * Folded forms one spoken word may stand for: the word itself and up to two
 * stripping steps, so a possessive + case form reaches the root
 * ("ışığını" → "ışığı" → "ışık", "pompasını" → "pompası"). Input is a display
 * word (Turkish letters kept: the softening rules need "ğ").
 */
export function gateWordForms(word: string): ReadonlySet<string> {
  const hit = formsCache.get(word);
  if (hit) return hit;
  const out = new Set<string>([fold(word)]);
  for (const c of stripOnce(word)) {
    out.add(fold(c));
    if (c === word) continue;
    for (const c2 of stripOnce(c)) if (c2.length >= SECOND_STEM_MIN) out.add(fold(c2));
  }
  if (formsCache.size > 5000) formsCache.clear();
  formsCache.set(word, out);
  return out;
}

/** One user utterance prepared for matching: display words and their forms. */
interface Utterance {
  words: string[];
  forms: ReadonlySet<string>[];
}

function prepare(text: string): Utterance {
  const words = displayWords(text);
  return { words, forms: words.map(gateWordForms) };
}

/**
 * Start indexes at which `target` (folded words) equals a contiguous run of
 * the utterance, each utterance word compared through its stem forms. Whole
 * words only: no substrings, no partial runs ("pompa" never covers
 * "bahce pompasi").
 */
function runStarts(u: Utterance, target: readonly string[]): number[] {
  const out: number[] = [];
  if (target.length === 0) return out;
  for (let i = 0; i + target.length <= u.forms.length; i++) {
    if (target.every((t, j) => (u.forms[i + j] as ReadonlySet<string>).has(t))) out.push(i);
  }
  return out;
}

/** Rule 3: the folded value equals a word run of one utterance in the window. */
function textMatch(window: readonly Utterance[], value: string): boolean {
  const target = key(value).split(" ").filter(Boolean);
  return target.length > 0 && window.some((u) => runStarts(u, target).length > 0);
}

// ---------------------------------------------------------------- question lock (Decision 3)

/** Question words (folded, whole word). `say` is left out on purpose (docs/14). */
const QUESTION_WORDS = new Set(["ne", "neler", "nedir", "kac", "nerede"]);
/** Question word stems (folded, word start): "hangi", "hangileri", "hangisi"; "listele", "listeler misin". */
const QUESTION_PREFIXES = ["hangi", "listele"];
/** `var mı` / `yok mu`: these words before a particle always ask. */
const EXISTENCE_WORDS = new Set(["var", "yok"]);
/**
 * The question particle mi/mı/mu/mü as its own word, folded, with person and
 * tense endings: "mı", "misin", "mısınız", "mudur", "miyim", "miydi", "miymiş".
 */
const PARTICLE = /^m[iu](?:s[iu]n(?:[iu]z)?|y[iu][mz]|d[iu]r(?:l[ae]r)?|yd[iu](?:[mkn]|n[iu]z|l[ae]r)?|ym[iu]s(?:[iu][mz]|s[iu]n(?:[iu]z)?|l[ae]r)?)?$/u;
/**
 * A polite-request verb before the particle (folded): aorist
 * "…ar/…er/…ır/…ir/…ur/…ür" ("kapatır mısın", "açar mısın", "kısar mısınız"),
 * which includes "…abilir/…ebilir" ("kapatabilir misin").
 */
const POLITE_VERB = /(?:ar|er|ir|ur)$/u;
/**
 * A polite request is addressed to the assistant: the particle carries the
 * second person ("mısın", "mısınız"). Adjectives end like an aorist too
 * ("hazır mı", "kapalılar mı"); with a bare or third-person particle they stay
 * questions, so the exception only ever covers "<aorist> m…sın(ız)".
 */
const SECOND_PERSON_PARTICLE = /^m[iu]s[iu]n(?:[iu]z)?$/u;
/** A trailing question mark, allowing closing quotes/brackets and spaces after it. */
const TRAILING_QUESTION = /\?[\s"'”’»)\]]*$/u;

/**
 * Decision 3: is this turn's raw user text (before `prepareText` drops the
 * punctuation) a question? Locked when it holds a question word, a `var mı` /
 * `yok mu`, or a question particle that does not follow a polite-request verb;
 * a trailing `?` locks too unless the polite request is what the `?` closes
 * (its particle is the last word: "kapatır mısın?", not "açar mısın, salon açık?").
 *
 * Deterministic and incomplete by design: it only ever raises a write to a
 * confirm card; the provenance check is the second line for what it misses.
 */
export function isQuestionTurn(rawText: string): boolean {
  const words = key(rawText).split(" ").filter(Boolean);
  let politeAtEnd = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    if (QUESTION_WORDS.has(w) || QUESTION_PREFIXES.some((p) => w.startsWith(p))) return true;
    if (!PARTICLE.test(w)) continue;
    const prev = i > 0 ? (words[i - 1] as string) : "";
    if (EXISTENCE_WORDS.has(prev)) return true;
    if (prev !== "" && POLITE_VERB.test(prev) && SECOND_PERSON_PARTICLE.test(w)) {
      politeAtEnd = i === words.length - 1;
      continue;
    }
    return true;
  }
  return !politeAtEnd && TRAILING_QUESTION.test(rawText);
}

// ---------------------------------------------------------------- target provenance (Decision 4)

/** Last user utterances that count as the user's words (docs/14 user decision 6). */
export const PROVENANCE_WINDOW = 3;

/** Whole-set words of a broad call (Decision 2), folded; compared through stem forms ("hepsini"). */
const WHOLE_SET_WORDS = ["tum", "butun", "hepsi", "her"];

/** HA intent targeting fields the check looks at (Decision 2). */
const TARGET_ARGS = ["name", "area", "floor"] as const;

/**
 * What the gate needs of a confirmed name (docs/14 Decision 6). The T4.4a store
 * entry (`ConfirmedName`) fits this shape structurally; the caller passes the
 * active entries (an entry with `status` other than `"active"` is skipped).
 */
export interface GateConfirmedName {
  /** Folded stem forms of the spoken words (match keys). */
  keys: readonly string[];
  /** Fingerprint: canonical name (first of `names`), domain, areas. */
  target: { name: string; domain: string; areas: readonly string[] };
  status?: string;
}

export interface ProvenanceOptions {
  /**
   * Device words per domain (router.yaml `learning.keywords`, e.g.
   * `light: [ışık, lamba, …]`). Used by the broad-call rule and the
   * area + keyword match of rule 4. A domain with no words never makes a
   * broad call known.
   */
  domainWords?: Readonly<Record<string, readonly string[]>>;
}

export type ProvenanceVia = "text" | "alias" | "confirmed_name" | "broad";

export type Provenance =
  /** The user named the target (`via`: the rule that decided the name, or the broad rule). */
  | { status: "known"; via: ProvenanceVia }
  /** No target argument at all (e.g. `intent__HassCancelAllTimers`): only the question lock applies. */
  | { status: "no_target" }
  /**
   * Not shown to be the user's: raise to `confirm`. `needsSnapshot` is true
   * when no snapshot was given and rules 4/5 could still decide (a `name`
   * target): the caller may read the live context once and ask again.
   */
  | { status: "unknown"; needsSnapshot: boolean };

/** Present = the key is set to anything but `undefined`. A non-string or blank value is never matched. */
const present = (input: Record<string, unknown>, k: string) => input[k] !== undefined;
const textValue = (v: unknown): string | undefined => (typeof v === "string" && key(v) !== "" ? v : undefined);

/** `domain` of an HA intent call: one string or a list. Undefined when absent or malformed. */
function domainsOf(v: unknown): string[] | undefined {
  const list = typeof v === "string" ? [v] : Array.isArray(v) ? v : undefined;
  if (!list || list.length === 0 || !list.every((d) => typeof d === "string" && d.trim() !== "")) return undefined;
  return (list as string[]).map((d) => d.trim());
}

/** One utterance holds a word of `words` (folded), compared through the utterance's stem forms. */
function hasWord(u: Utterance, words: ReadonlySet<string>): boolean {
  return u.forms.some((f) => [...f].some((x) => words.has(x)));
}

/**
 * Decision 2 broad call (no name/area/floor, only `domain`): known when one
 * utterance holds a whole-set word and, for every called domain, one of its
 * device words ("hangi ışıklar açık, hepsini kapat").
 */
function broadKnown(window: readonly Utterance[], domains: readonly string[], opts: ProvenanceOptions): boolean {
  const wordsByDomain = domains.map((d) => new Set((opts.domainWords?.[d] ?? []).map(key)));
  if (wordsByDomain.some((s) => s.size === 0)) return false;
  const wholeSet = new Set(WHOLE_SET_WORDS);
  return window.some((u) => hasWord(u, wholeSet) && wordsByDomain.every((s) => hasWord(u, s)));
}

const sameKeys = (a: readonly string[], b: readonly string[]) => {
  const x = a.map(key).sort();
  const y = b.map(key).sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/** Entities the call's `name` can reach in HA: that name/alias, narrowed by `area` and `domain` when given. */
function callOwners(snapshot: readonly LiveEntity[], name: string, area: string | undefined, domains: string[] | undefined): LiveEntity[] {
  const n = key(name);
  return snapshot.filter(
    (e) =>
      e.names.some((x) => key(x) === n) &&
      (area === undefined || e.areas.some((a) => key(a) === key(area))) &&
      (domains === undefined || domains.includes(e.domain)),
  );
}

/** Longest word run tried as a spoken name in rule 4 (router.yaml `direct.max_name_words` is in this range). */
const MAX_RUN_WORDS = 6;

/**
 * What the "whole name phrase" checks need for one called entity: tier 0's
 * resolver over every domain of the snapshot, the device words of the
 * entity's domain and of the other domains, and the longest phrase to look at.
 */
interface EntityView {
  entity: LiveEntity;
  /** Device words of the entity's domain, folded. */
  kw: ReadonlySet<string>;
  /**
   * `resolveDevice` over every domain of the snapshot: a word run that is
   * another device's name (a switch "Salon" next to a light "Salon Işık")
   * never counts for this one.
   */
  resolve: (spoken: string) => ReturnType<typeof resolveDevice>;
  /** Device words of the other domains ("priz" next to a light's name), folded. */
  foreign: ReadonlySet<string>;
  /**
   * Longest phrase checked around a match: the longest snapshot name, so a
   * long device name ("Salon Lambası Philips Hue Beyaz Ambiyans 2") is never
   * cut short.
   */
  maxRun: number;
}

function entityView(snapshot: readonly LiveEntity[], entity: LiveEntity, opts: ProvenanceOptions): EntityView {
  const keywords = opts.domainWords?.[entity.domain] ?? [];
  const kw = new Set(keywords.map(key));
  const allDomains = [...new Set(snapshot.map((e) => e.domain))];
  const foreign = new Set(
    Object.entries(opts.domainWords ?? {})
      .filter(([d]) => d !== entity.domain)
      .flatMap(([, ws]) => ws.map(key))
      .filter((w) => !kw.has(w)),
  );
  const maxRun = Math.max(MAX_RUN_WORDS, ...snapshot.flatMap((e) => e.names.map((x) => key(x).split(" ").filter(Boolean).length)));
  return { entity, kw, resolve: (spoken) => resolveDevice(snapshot, spoken, { domains: allDomains, keywords }), foreign, maxRun };
}

/**
 * Whether a longer word run around `[i, j)` of `u` names something else: a
 * run that strictly contains it or, with `adjacent`, starts right after /
 * ends right before it (`maxRun` words at most), resolves to another device
 * or to several ("salon lambası 2", "mutfak | kahve makinesini"). Runs that
 * resolve to nothing or to this entity again are fine ("salon lambasını |
 * kapat"). `self` is the set of entities that count as "this one" (rule 3:
 * every entity the call's name reaches).
 */
function longerRunNamesOther(v: EntityView, u: Utterance, i: number, j: number, adjacent: boolean, self: ReadonlySet<LiveEntity> = new Set([v.entity])): boolean {
  const n = u.words.length;
  for (let a = Math.max(0, i - v.maxRun); a <= j; a++) {
    for (let b = a + 1; b <= Math.min(n, a + v.maxRun); b++) {
      const contains = a <= i && b >= j && (a < i || b > j);
      if (!contains && (!adjacent || (b !== i && a !== j))) continue;
      const r = v.resolve(u.words.slice(a, b).join(" "));
      if (r.status === "ambiguous" || (r.status === "ok" && !self.has(r.entity))) return true;
    }
  }
  return false;
}

/**
 * The run `[i, j)` of `u` is the user's whole name phrase for this entity (docs/14 T4.3a,
 * team-lead decision (a)): no longer phrase around it names something else. Rejected when
 *  - a containing or adjacent run names another device or several (`longerRunNamesOther`), or
 *  - a word a containing run could add is a device word of another domain
 *    ("mutfak prizini", "mutfak akıllı prizini").
 * In doubt this says no: the result is only an extra confirm card.
 */
function standsAlone(v: EntityView, u: Utterance, i: number, j: number): boolean {
  if (longerRunNamesOther(v, u, i, j, true)) return false;
  const n = u.words.length;
  const reach = v.maxRun - (j - i);
  for (let k = Math.max(0, i - reach); k < Math.min(n, j + reach); k++) {
    if (k >= i && k < j) continue;
    if ([...(u.forms[k] as ReadonlySet<string>)].some((f) => v.foreign.has(f))) return false;
  }
  return true;
}

/**
 * Rule 3 against the live list (docs/14 decision 10, T4.9): when the call's
 * `name` reaches one entity or several (its owners), a text match counts only
 * where
 *  - the user's matched words themselves do not resolve to a device outside
 *    the owners (stemming: "salondaki lambayı" matches "Salon Lamba", yet it
 *    is the name of the light "Salondaki Lamba"), and
 *  - no longer run of the user's words around it (a strictly containing one)
 *    is the name of a device outside the owners or of several ("salon lambası
 *    2" said, "Salon Lambası" called).
 * Adjacent phrases and other-domain words are not looked at here: a command
 * naming two devices ("salon lambasını ve mutfak ışığını kapat") stays known.
 * A name that reaches no entity is left to HA and to the name-only check
 * (`nameOnlyTarget`): the text match stands.
 */
function textMatchFits(
  window: readonly Utterance[],
  snapshot: readonly LiveEntity[],
  name: string,
  area: string | undefined,
  domains: string[] | undefined,
  opts: ProvenanceOptions,
): boolean {
  const owners = callOwners(snapshot, name, area, domains);
  if (owners.length === 0) return true;
  const self = new Set(owners);
  const v = entityView(snapshot, owners[0] as LiveEntity, opts);
  const target = key(name).split(" ").filter(Boolean);
  const fits = (u: Utterance, s: number): boolean => {
    const said = v.resolve(u.words.slice(s, s + target.length).join(" "));
    if (said.status === "ok" && !self.has(said.entity)) return false;
    return !longerRunNamesOther(v, u, s, s + target.length, false, self);
  };
  return window.some((u) => runStarts(u, target).some((s) => fits(u, s)));
}

/**
 * Whether rule 3's answer for this call's `name` may change with a snapshot
 * (T4.9): the name is matched by text, and every matching run has a word
 * next to it (an utterance that is only the name, e.g. the answer to a choice
 * question, cannot be part of a longer name). The caller reads the live
 * context only when this is true; without a snapshot `targetProvenance`
 * keeps the plain text answer.
 */
export function nameMatchNeedsSnapshot(input: Readonly<Record<string, unknown>>, utterances: readonly string[]): boolean {
  const name = textValue(input.name);
  if (name === undefined) return false;
  const target = key(name).split(" ").filter(Boolean);
  const window = utterances.slice(-PROVENANCE_WINDOW).map(prepare);
  const starts = window.flatMap((u) => runStarts(u, target).map((s) => ({ u, s })));
  return starts.length > 0 && starts.every(({ u, s }) => s > 0 || s + target.length < u.words.length);
}

/**
 * Rule 4: the call's `name` is one exposed entity's name (narrowed by `area`
 * and `domain` when given), and the user named that same entity by any of its
 * names/aliases, or by its area followed by a device word, as tier 0's
 * `resolveDevice` would (exactly one best hit), and those words are the whole
 * name phrase the user said (`standsAlone`).
 */
function aliasKnown(
  window: readonly Utterance[],
  snapshot: readonly LiveEntity[],
  name: string,
  area: string | undefined,
  domains: string[] | undefined,
  opts: ProvenanceOptions,
): boolean {
  const owners = callOwners(snapshot, name, area, domains);
  if (owners.length !== 1) return false;
  const entity = owners[0] as LiveEntity;
  const v = entityView(snapshot, entity, opts);
  const { kw, resolve } = v;
  const resolvesHere = (spoken: string) => {
    const r = resolve(spoken);
    return r.status === "ok" && r.entity === entity;
  };
  // A name/alias the user said (rule 3 forms) that tier 0 resolves to this entity alone, and
  // the user's own words for it do not resolve to a different device or to several
  // ("salondaki lamba" may stem to the alias "Salon Lamba" yet be the name of another lamp).
  for (const alias of entity.names) {
    if (!resolvesHere(cleanTurkish(alias))) continue;
    const words = key(alias).split(" ").filter(Boolean);
    for (const u of window) {
      for (const start of runStarts(u, words)) {
        const said = resolve(u.words.slice(start, start + words.length).join(" "));
        if ((said.status === "none" || (said.status === "ok" && said.entity === entity)) && standsAlone(v, u, start, start + words.length)) return true;
      }
    }
  }
  // Name prefix + device words ("yatak odası" → "Yatak Odası Işık"), or area + device word
  // ("salon ışığı" → the only light in Salon): a word run resolved by `resolveDevice`.
  const names = entity.names.map(key);
  for (const u of window) {
    for (let i = 0; i < u.words.length; i++) {
      for (let len = 1; len <= MAX_RUN_WORDS && i + len <= u.words.length; len++) {
        const spoken = u.words.slice(i, i + len).join(" ");
        if (!resolvesHere(spoken) || !standsAlone(v, u, i, i + len)) continue;
        const cands = stemCandidates(spoken).map(key);
        // Same test as `resolveDevice` scores 3 and 2: a name equals the run, or starts with it and
        // continues with device words / numbers only. Anything else was an area hit (score 1).
        const byName = cands.some((c) =>
          names.some((x) => x === c || (x.startsWith(`${c} `) && x.slice(c.length + 1).split(" ").every((w) => kw.has(w) || /^\d+$/.test(w)))),
        );
        if (byName) return true;
        // Area hit: the user must have said a device word right after the area.
        const next = u.forms[i + len];
        if (next && [...next].some((f) => kw.has(f))) return true;
      }
    }
  }
  return false;
}

/**
 * Rule 5: an utterance holds the key of a confirmed name whose fingerprint
 * matches the call (name; area and domain when given) and is present in the
 * snapshot as exactly one entity, which is also the only entity the call can
 * reach.
 */
function confirmedNameKnown(
  window: readonly Utterance[],
  snapshot: readonly LiveEntity[],
  names: readonly GateConfirmedName[],
  name: string,
  area: string | undefined,
  domains: string[] | undefined,
): boolean {
  for (const entry of names) {
    if (entry.status !== undefined && entry.status !== "active") continue;
    const t = entry.target;
    if (key(t.name) !== key(name)) continue;
    if (area !== undefined && !t.areas.some((a) => key(a) === key(area))) continue;
    if (domains !== undefined && !domains.includes(t.domain)) continue;
    const said = entry.keys.some((k) => {
      const words = k.split(" ").filter(Boolean);
      return window.some((u) => runStarts(u, words).length > 0);
    });
    if (!said) continue;
    // Present: exactly one entity with the fingerprint (Decision 6) ...
    const matches = snapshot.filter((e) => e.domain === t.domain && key(e.names[0] ?? "") === key(t.name) && sameKeys(e.areas, t.areas));
    if (matches.length !== 1) continue;
    // ... and the call reaches that entity only (a same-named device elsewhere needs `area`).
    const owners = callOwners(snapshot, name, area, domains);
    if (owners.length === 1 && owners[0] === matches[0]) return true;
  }
  return false;
}

/**
 * Decision 4: did the user name the target of this write call?
 *
 * @param input       the tool call input (HA intent arguments).
 * @param utterances  user utterances of the session, oldest first, the current
 *                    turn last, as raw or display text (not folded: the
 *                    softening rules need Turkish letters). Only the last
 *                    `PROVENANCE_WINDOW` count; assistant text must never be
 *                    passed.
 * @param snapshot    parsed `GetLiveContext` entities, when at hand (rules 4, 5;
 *                    with it a rule-3 `name` match must also fit the user's
 *                    whole name phrase, T4.9 / `nameMatchNeedsSnapshot`).
 * @param names       active confirmed names (rule 5).
 *
 * Every target argument present (`name`, `area`, `floor`) must be known:
 * by rule 3 (text match), or for `name` (and an `area` consistent with the
 * same entity) by rule 4 (alias) or rule 5 (confirmed name). A call with only
 * `domain` / `device_class` is a broad call (Decision 2); a call with none of
 * these has no target.
 */
export function targetProvenance(
  input: Readonly<Record<string, unknown>>,
  utterances: readonly string[],
  snapshot?: readonly LiveEntity[],
  names?: readonly GateConfirmedName[],
  opts: ProvenanceOptions = {},
): Provenance {
  const window = utterances.slice(-PROVENANCE_WINDOW).map(prepare);
  const hasTarget = TARGET_ARGS.some((k) => present(input, k));
  const domains = domainsOf(input.domain);

  if (!hasTarget) {
    if (present(input, "domain") || present(input, "device_class")) {
      return domains && broadKnown(window, domains, opts) ? { status: "known", via: "broad" } : { status: "unknown", needsSnapshot: false };
    }
    return { status: "no_target" };
  }

  const name = textValue(input.name);
  const area = textValue(input.area);
  const floor = textValue(input.floor);
  // A target argument that is set but not a usable string is never known.
  if (TARGET_ARGS.some((k) => present(input, k) && textValue(input[k]) === undefined)) return { status: "unknown", needsSnapshot: false };
  if (present(input, "domain") && !domains) return { status: "unknown", needsSnapshot: false };

  if (floor !== undefined && !textMatch(window, floor)) return { status: "unknown", needsSnapshot: false };
  // With a snapshot, a name match must also fit the user's whole name phrase (T4.9).
  const nameText = name === undefined || (textMatch(window, name) && (!snapshot || textMatchFits(window, snapshot, name, area, domains, opts)));
  const areaText = area === undefined || textMatch(window, area);
  if (nameText && areaText) return { status: "known", via: "text" };
  // Rules 4 and 5 identify an entity by its name; without one, nothing else can help.
  if (name === undefined) return { status: "unknown", needsSnapshot: false };
  if (!snapshot) return { status: "unknown", needsSnapshot: true };
  if (aliasKnown(window, snapshot, name, area, domains, opts)) return { status: "known", via: "alias" };
  if (names && confirmedNameKnown(window, snapshot, names, name, area, domains)) return { status: "known", via: "confirmed_name" };
  return { status: "unknown", needsSnapshot: false };
}

// ---------------------------------------------------------------- name-only targets (docs/14 decision 9)

/**
 * A call that names its target by `name` alone: no `domain`, no
 * `device_class` (`confirm_inputs` cannot see what kind of device it is).
 */
export function isNameOnlyCall(input: Readonly<Record<string, unknown>>): boolean {
  return present(input, "name") && !present(input, "domain") && !present(input, "device_class");
}

/** `ok`: one entity, not sensitive; `sensitive`: some entity the call can reach is; `unresolved`: none or several. */
export type NameOnlyTarget = "ok" | "sensitive" | "unresolved";

/**
 * Decision 9 (T4.8): the entities a name-only call reaches in the live
 * snapshot (its name or alias, narrowed by `area` when given), checked with
 * `isSensitive` (the caller's `confirm_inputs` and tier-0 rules). Any
 * reachable entity being sensitive wins; otherwise the call must reach
 * exactly one entity. A `name` that is not a usable string is `unresolved`.
 */
export function nameOnlyTarget(
  input: Readonly<Record<string, unknown>>,
  snapshot: readonly LiveEntity[],
  isSensitive: (entity: LiveEntity) => boolean,
): NameOnlyTarget {
  const name = textValue(input.name);
  const area = present(input, "area") ? textValue(input.area) : undefined;
  if (name === undefined || (present(input, "area") && area === undefined)) return "unresolved";
  const owners = callOwners(snapshot, name, area, undefined);
  if (owners.some(isSensitive)) return "sensitive";
  return owners.length === 1 ? "ok" : "unresolved";
}
