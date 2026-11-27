/**
 * Static files of the built UI (`ui/dist`) on the Core's TLS listener
 * (docs/13 §4.1, T11.6). Same rules as the tray's `UiServer` on the PC
 * (deploy/windows/tray/src/ShadowTray/UiServer.cs): GET/HEAD only,
 * `X-Content-Type-Options: nosniff`, no directory listing, `index.html` for a
 * path ending in `/`, no dot files, unknown file types not served, no SPA
 * fallback; `index.html` is revalidated on every load (it names the hashed
 * asset files), the assets are cached for an hour.
 *
 * Path safety: the request path is percent-decoded once and split on `/`;
 * a segment that is empty (`//`), `.`/`..` or starts with a dot, or that holds
 * `\`, `:` or NUL, is not served. The file found is then resolved with
 * `realpath` and must lie inside the resolved UI folder, so a symlink cannot
 * lead out of it. The folder is resolved per request: a missing folder gives
 * 404 (the Core still serves `/ws`), and a release switch (`current` symlink)
 * is picked up without a restart.
 */
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, sep } from "node:path";

/**
 * Sent with every static answer (also 404/405). Only headers that cannot
 * break the UI: no `Content-Security-Policy` beyond `frame-ancestors` (a
 * script/style policy would need the build's inline parts checked first).
 */
export const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
};

/** Content types by extension; any other extension is not served (as UiServer's StaticFiles). */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};

export type StaticHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

function answer(res: ServerResponse, status: number, headers: Record<string, string> = {}): void {
  const body = status === 404 ? "not found" : status === 405 ? "method not allowed" : "bad request";
  res.writeHead(status, { ...STATIC_SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(body);
}

/**
 * The relative path segments a request path maps to, or a status for a path
 * that is never served (400 malformed, 404 not allowed). A path ending in `/`
 * gets `index.html`.
 */
export function staticSegments(url: string): string[] | 400 | 404 {
  // Origin-form only ("/..."); absolute-form or "*" targets are not files.
  if (!url.startsWith("/")) return 400;
  const rawPath = url.split("?")[0] ?? "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return 400;
  }
  const segments = decoded.slice(1).split("/");
  if (segments[segments.length - 1] === "") segments[segments.length - 1] = "index.html";
  for (const s of segments) {
    if (s === "" || s.startsWith(".") || /[\\:\0]/.test(s)) return 404;
  }
  return segments;
}

/** Serves files below `root` (see the module comment). Never throws: every failure is an answer or a dropped socket. */
export function createStaticHandler(root: string): StaticHandler {
  return async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      answer(res, 405, { Allow: "GET, HEAD" });
      return;
    }
    const segments = staticSegments(req.url ?? "/");
    if (typeof segments === "number") {
      answer(res, segments);
      return;
    }
    const type = CONTENT_TYPES[extname(segments[segments.length - 1] ?? "").toLowerCase()];
    if (!type) {
      answer(res, 404);
      return;
    }
    let file: string;
    let size: number;
    try {
      const base = await realpath(root);
      file = await realpath(join(base, ...segments));
      // Inside the folder after every symlink is resolved (realpath of both sides).
      if (!file.startsWith(base.endsWith(sep) ? base : base + sep)) {
        answer(res, 404);
        return;
      }
      const st = await stat(file);
      if (!st.isFile()) {
        answer(res, 404);
        return;
      }
      size = st.size;
    } catch {
      // ENOENT, ENOTDIR, EACCES, ELOOP...: the same answer, no detail.
      answer(res, 404);
      return;
    }
    const isIndex = segments[segments.length - 1] === "index.html";
    res.writeHead(200, {
      ...STATIC_SECURITY_HEADERS,
      "Content-Type": type,
      "Content-Length": String(size),
      "Cache-Control": isIndex ? "no-cache" : "public, max-age=3600",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const stream = createReadStream(file);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
  };
}
