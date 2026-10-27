/**
 * Minimal glob matcher used by the permission gate (tool names) and the vault
 * allowlist (relative note paths).
 *
 * Supported syntax:
 *   `*`   any run of characters except `/`
 *   `**`  any run of characters including `/` (`dir/**` also matches `dir` itself)
 *   `?`   exactly one character except `/`
 * Everything else is literal. Matching is case-sensitive unless `ignoreCase`.
 */

const cache = new Map<string, RegExp>();

function escapeRe(ch: string): string {
  return /[\\^$.|+()[\]{}]/.test(ch) ? `\\${ch}` : ch;
}

export function globToRegExp(pattern: string, ignoreCase = false): RegExp {
  const key = `${ignoreCase ? "i" : "s"}:${pattern}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        // `dir/**` → also match `dir`; `**/x` → match `x` at any depth.
        if (re.endsWith("/") && i === pattern.length - 1) {
          re = `${re.slice(0, -1)}(?:/.*)?`;
        } else if (pattern[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else {
          re += ".*";
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") {
      re += "[^/]";
    } else {
      re += escapeRe(ch);
    }
  }
  const compiled = new RegExp(`^${re}$`, ignoreCase ? "i" : "");
  cache.set(key, compiled);
  return compiled;
}

export function matchGlob(pattern: string, value: string, ignoreCase = false): boolean {
  return globToRegExp(pattern, ignoreCase).test(value);
}

export function isGlob(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("?");
}
