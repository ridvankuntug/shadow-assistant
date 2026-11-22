/**
 * Repeated-error stop, pure part (docs/14 Decision 10, T4.7).
 *
 * When a tool call fails twice in the same way within one turn, further calls
 * of that tool with the same argument class are denied for the rest of the
 * turn (`repeated_error`). This module has no I/O; the session holds one
 * RepeatGuard per turn (`ActiveTurn`), checks `isBlocked` before `authorize`,
 * notes each allowed call and feeds back its result.
 *
 * - Argument class: full tool name + the sorted set of top-level input keys;
 *   values are ignored (the incident's model varied the value, the shape was
 *   the repeated mistake).
 * - Same error: `isError` results with the same normalized error text.
 * - Not counted: calls that were never noted (gate denials), successful
 *   results (they do not reset the count either).
 */

/** Same-class, same-error failures in one turn that block the class. */
export const REPEAT_LIMIT = 2;
/** Normalized error text length (code points). */
export const ERROR_TEXT_MAX = 200;

/** Keys written as is; any other key (empty, punctuation, non-ASCII) is written as a JSON string. */
const PLAIN_KEY = /^[A-Za-z0-9_-]+$/;

/**
 * `tool|k1,k2` with the top-level keys sorted; `tool|` for no input or a
 * non-object input. A key outside PLAIN_KEY is JSON-quoted (`""` for an empty
 * key), so no key can make two different key sets collide: a plain key holds
 * no `"` or `,`, a JSON string is self-delimiting, and JSON.stringify never
 * throws on a string (a lone surrogate is escaped).
 */
export function argumentClass(tool: string, input: unknown): string {
  const keys = typeof input === "object" && input !== null && !Array.isArray(input) ? Object.keys(input).sort() : [];
  return `${tool}|${keys.map((k) => (PLAIN_KEY.test(k) ? k : JSON.stringify(k))).join(",")}`;
}

/**
 * NFC, `tr-TR` lower case, whitespace collapsed (and trimmed), digit runs
 * replaced by `#`, cut to ERROR_TEXT_MAX code points. Anything that is not a
 * string (no text) is `""`.
 */
export function normalizeErrorText(text: unknown): string {
  if (typeof text !== "string") return "";
  const s = text
    .normalize("NFC")
    .toLocaleLowerCase("tr-TR")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/\p{Nd}+/gu, "#");
  return Array.from(s).slice(0, ERROR_TEXT_MAX).join("");
}

/** Per-turn counter. Create one per turn; never reset within a turn. */
export class RepeatGuard {
  /** argument class → normalized error text → failures. */
  private readonly failures = new Map<string, Map<string, number>>();
  private readonly blocked = new Set<string>();
  /** toolUseId → argument class, for calls the gate allowed and whose result is pending. */
  private readonly pending = new Map<string, string>();

  constructor(private readonly limit: number = REPEAT_LIMIT) {}

  /** Whether a call of `tool` with this input shape must be denied (`repeated_error`). */
  isBlocked(tool: string, input: unknown): boolean {
    return this.blocked.has(argumentClass(tool, input));
  }

  /** Records a call the gate allowed, so its result can be counted. */
  noteAllowed(toolUseId: string, tool: string, input: unknown): void {
    this.pending.set(toolUseId, argumentClass(tool, input));
  }

  /**
   * Feeds back the result of a call. Only an `isError` result of a noted call
   * counts, once per `toolUseId`. Returns whether this result blocked its
   * class (false if it already was blocked or does not count).
   */
  recordResult(toolUseId: string, isError: boolean, errorText?: unknown): boolean {
    const cls = this.pending.get(toolUseId);
    if (cls === undefined) return false;
    this.pending.delete(toolUseId);
    if (!isError) return false;
    return this.recordError(cls, errorText);
  }

  /** Counts one failure for an argument class directly. Returns whether this failure blocked the class. */
  recordError(cls: string, errorText: unknown): boolean {
    const text = normalizeErrorText(errorText);
    let byText = this.failures.get(cls);
    if (!byText) {
      byText = new Map();
      this.failures.set(cls, byText);
    }
    const n = (byText.get(text) ?? 0) + 1;
    byText.set(text, n);
    if (n < this.limit || this.blocked.has(cls)) return false;
    this.blocked.add(cls);
    return true;
  }
}
