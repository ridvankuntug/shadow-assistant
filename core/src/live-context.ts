/**
 * Home Assistant `GetLiveContext` result parsing for tier 0 (no model).
 *
 * HA returns a JSON text `{"result": "Live Context: …\n- names: …\n  domain: …"}`
 * whose `result` is a header line followed by a YAML list of exposed entities
 * (`names` = name and aliases joined by ", ", `domain`, `state`, optional
 * `areas`, optional `attributes`). Anything that does not look like that is
 * reported as unparseable and the caller falls back to the model.
 */
import { parse as parseYaml } from "yaml";
import type { SensorKind } from "./router-config.js";
import { cleanTurkish, fold, stemCandidates } from "./turkish.js";

export interface LiveEntity {
  /** Entity name first, then aliases (as HA lists them). */
  names: string[];
  domain: string;
  state: string;
  areas: string[];
  attributes: Record<string, unknown>;
}

export class LiveContextError extends Error {}

function splitList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim());
  if (typeof v !== "string") return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseLiveContext(text: string): LiveEntity[] {
  let body = text;
  try {
    const j = JSON.parse(text) as unknown;
    if (typeof j === "object" && j !== null && typeof (j as { result?: unknown }).result === "string") {
      body = (j as { result: string }).result;
    }
  } catch {
    // plain text result
  }
  const start = body.search(/^- /m);
  if (start < 0) throw new LiveContextError("no entity list in live context");
  let doc: unknown;
  try {
    doc = parseYaml(body.slice(start));
  } catch (err) {
    throw new LiveContextError(`live context is not YAML: ${(err as Error).message}`);
  }
  if (!Array.isArray(doc)) throw new LiveContextError("live context is not a list");
  const out: LiveEntity[] = [];
  for (const raw of doc) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const names = splitList(r.names);
    if (names.length === 0 || typeof r.domain !== "string") continue;
    out.push({
      names,
      domain: r.domain,
      state: r.state === undefined || r.state === null ? "" : String(r.state),
      areas: splitList(r.areas),
      attributes: typeof r.attributes === "object" && r.attributes !== null ? (r.attributes as Record<string, unknown>) : {},
    });
  }
  return out;
}

const key = (s: string) => fold(cleanTurkish(s));

// ---------------------------------------------------------------- device resolution

export type Resolution =
  | { status: "ok"; entity: LiveEntity; callName: string; label: string; area?: string }
  | { status: "none" }
  | { status: "ambiguous"; count: number };

export interface ResolveOptions {
  domains: readonly string[];
  /** Device words that may follow the name ("ışık", "lamba"); digits may follow too. */
  keywords: readonly string[];
}

/**
 * Finds the single entity a spoken name refers to. Scores per entity:
 *   3  a name/alias equals the spoken name (any suffix-stripped form)
 *   2  a name starts with it and continues only with keywords/numbers
 *      ("yatak odası" → "Yatak Odası Işık", "Oturma Odası Işık 1")
 *   1  keyword rules only: the entity's area equals the spoken name and the
 *      entity is a light or carries a keyword in its name
 * The best score must be held by exactly one entity, otherwise the request is
 * ambiguous (the model is better at asking back).
 */
export function resolveDevice(entities: readonly LiveEntity[], spoken: string, opts: ResolveOptions): Resolution {
  const cands = stemCandidates(spoken).map((display) => ({ display, folded: key(display) }));
  const domains = new Set(opts.domains);
  const kw = new Set(opts.keywords.map(key));
  let best = 0;
  let hits: Array<{ entity: LiveEntity; label: string }> = [];
  for (const e of entities) {
    if (!domains.has(e.domain)) continue;
    let score = 0;
    let label = "";
    for (const c of cands) {
      for (const n of e.names.map(key)) {
        if (n === c.folded) {
          if (score < 3) [score, label] = [3, c.display];
        } else if (kw.size > 0 && n.startsWith(`${c.folded} `)) {
          const rest = n.slice(c.folded.length + 1).split(" ");
          if (rest.every((w) => kw.has(w) || /^\d+$/.test(w)) && score < 2) [score, label] = [2, c.display];
        }
      }
      if (kw.size > 0 && score < 1 && e.areas.some((a) => key(a) === c.folded)) {
        const named = e.names.some((n) => key(n).split(" ").some((w) => kw.has(w)));
        if (e.domain === "light" || named) [score, label] = [1, c.display];
      }
    }
    if (score === 0) continue;
    if (score > best) {
      best = score;
      hits = [{ entity: e, label }];
    } else if (score === best) {
      hits.push({ entity: e, label });
    }
  }
  if (hits.length === 0) return { status: "none" };
  if (hits.length > 1) return { status: "ambiguous", count: hits.length };
  const { entity, label } = hits[0] as { entity: LiveEntity; label: string };
  // HA resolves `name` among all exposed entities: when another entity of the
  // same domain shares the name, narrow the call by area or give up.
  const callName = entity.names[0] as string;
  const sameName = entities.filter((o) => o !== entity && o.domain === entity.domain && o.names.some((n) => key(n) === key(callName)));
  if (sameName.length > 0) {
    const area = entity.areas[0];
    if (!area || sameName.some((o) => o.areas[0] !== undefined && key(o.areas[0]) === key(area))) return { status: "ambiguous", count: sameName.length + 1 };
    return { status: "ok", entity, callName, label, area };
  }
  return { status: "ok", entity, callName, label };
}

// ---------------------------------------------------------------- sensors

export interface SensorReading {
  label: string;
  value: number;
}

const KIND_WORDS: Record<SensorKind, string[]> = {
  temperature: ["sicaklik", "sicakligi", "temperature", "temp", "environment"],
  humidity: ["nem", "nemi", "humidity", "relative", "environment"],
};
const CLIMATE_ATTR: Record<SensorKind, string> = { temperature: "current_temperature", humidity: "current_humidity" };

function readingOf(e: LiveEntity, kind: SensorKind): number | undefined {
  const raw = e.attributes.device_class === kind ? e.state : e.domain === "climate" ? e.attributes[CLIMATE_ATTR[kind]] : undefined;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** Spoken label of a sensor: its area, else its name without the measurement words. */
function sensorLabel(e: LiveEntity, kind: SensorKind): string {
  if (e.areas[0]) return e.areas[0];
  const drop = new Set(KIND_WORDS[kind]);
  const words = (e.names[0] as string).split(/\s+/).filter((w) => !drop.has(key(w)));
  return words.join(" ") || (e.names[0] as string);
}

/**
 * Readings of one kind. With a spoken name only sensors whose area, label or
 * name words match it; with only `defaultName` the matching ones if any, else
 * all. Same-label readings are merged (first wins); at most `max` items.
 */
export function findReadings(
  entities: readonly LiveEntity[],
  kind: SensorKind,
  opts: { name?: string; defaultName?: string; max: number },
): SensorReading[] {
  const all: Array<{ e: LiveEntity; label: string; value: number }> = [];
  for (const e of entities) {
    const value = readingOf(e, kind);
    if (value !== undefined) all.push({ e, label: sensorLabel(e, kind), value });
  }
  const matching = (spoken: string) => {
    const cands = stemCandidates(cleanTurkish(spoken)).map(key);
    return all.filter(({ e, label }) =>
      cands.some((c) => {
        const words = c.split(" ");
        return (
          key(label) === c ||
          e.areas.some((a) => key(a) === c) ||
          e.names.some((n) => {
            const nw = key(n).split(" ");
            return words.every((w) => nw.includes(w));
          })
        );
      }),
    );
  };
  let picked = all;
  if (opts.name !== undefined) picked = matching(opts.name);
  else if (opts.defaultName !== undefined) {
    const m = matching(opts.defaultName);
    if (m.length > 0) picked = m;
  }
  const seen = new Set<string>();
  const out: SensorReading[] = [];
  for (const p of picked) {
    const k = key(p.label);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ label: p.label, value: p.value });
    if (out.length >= opts.max) break;
  }
  return out;
}

/** "24,1 derece" / "yüzde 65" — words instead of unit symbols (spoken output). */
export function formatReading(kind: SensorKind, value: number): string {
  const v = String(Math.round(value * 10) / 10).replace(".", ",");
  return kind === "temperature" ? `${v} derece` : `yüzde ${v}`;
}

/** Upper-cases the first letter with Turkish rules (sentence start). */
export function capitalize(s: string): string {
  return s === "" ? s : s.charAt(0).toLocaleUpperCase("tr-TR") + s.slice(1);
}

/** Fills `{ad}`, `{deger}`, `{liste}` placeholders; unknown ones stay as written. */
export function fillTemplate(template: string, vars: Record<string, string>): string {
  const out = template.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m);
  return capitalize(out.trim());
}
