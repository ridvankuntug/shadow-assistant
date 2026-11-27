/**
 * CORE_VERSION (docs/13 §6.1): env override, the repo-root VERSION file, and
 * the dev fallback. Files live in a temp folder; the real VERSION is only read.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { loadDeviceTokens } from "../src/auth.js";
import { createCoreServer } from "../src/server.js";
import type { ServerFrame } from "../src/protocol.js";
import type { Session } from "../src/session.js";
import { DEV_CORE_VERSION, readCoreVersion, VERSION_FILE, versionBase, versionBaseDiffers } from "../src/version.js";

const dir = mkdtempSync(join(tmpdir(), "shadow-version-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

test("the module path reaches the repo-root VERSION file", () => {
  const base = readFileSync(VERSION_FILE, "utf8").trim();
  assert.match(base, /^\d+\.\d+$/);
  assert.equal(readCoreVersion(), base);
});

test("GET /health reports the version given to the server, else the one resolved at server creation", async () => {
  const quiet = { info: () => {}, warn: () => {} };
  const health = async (version?: string): Promise<unknown> => {
    const s = createCoreServer({
      tokens: loadDeviceTokens({}),
      logger: quiet,
      createSession: () => {
        throw new Error("must not be called");
      },
      ...(version !== undefined ? { version } : {}),
    });
    const { port } = await s.listen(0, "127.0.0.1");
    try {
      return ((await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as { version: unknown }).version;
    } finally {
      await s.close();
    }
  };
  assert.equal(await health("0.2.31"), "0.2.31");
  // Read from process.env when the server is created (after main()'s loadDotEnv), not at import.
  const before = process.env.CORE_VERSION;
  process.env.CORE_VERSION = "9.8.7";
  try {
    assert.equal(await health(), "9.8.7");
  } finally {
    if (before === undefined) delete process.env.CORE_VERSION;
    else process.env.CORE_VERSION = before;
  }
});

test("VERSION file: first line, trimmed (CRLF, BOM, trailing lines)", () => {
  assert.equal(readCoreVersion({ file: file("a", "0.2\n") }), "0.2");
  assert.equal(readCoreVersion({ file: file("b", "﻿ 1.4 \r\nnotes\n") }), "1.4");
  assert.equal(readCoreVersion({ file: file("c", "0.2.17") }), "0.2.17");
});

test("missing, empty or malformed file -> dev value", () => {
  assert.equal(readCoreVersion({ file: join(dir, "missing") }), DEV_CORE_VERSION);
  assert.equal(readCoreVersion({ file: file("d", "") }), DEV_CORE_VERSION);
  assert.equal(readCoreVersion({ file: file("e", "v0.2") }), DEV_CORE_VERSION);
  assert.equal(readCoreVersion({ file: file("f", "0.2-beta") }), DEV_CORE_VERSION);
});

test("env CORE_VERSION overrides the file; a blank or malformed value is ignored", () => {
  const f = file("g", "0.2\n");
  assert.equal(readCoreVersion({ env: { CORE_VERSION: "0.2.31" }, file: f }), "0.2.31");
  assert.equal(readCoreVersion({ env: { CORE_VERSION: " 0.3 " }, file: f }), "0.3");
  assert.equal(readCoreVersion({ env: { CORE_VERSION: "" }, file: f }), "0.2");
  assert.equal(readCoreVersion({ env: { CORE_VERSION: "latest" }, file: f }), "0.2");
  assert.equal(readCoreVersion({ env: { CORE_VERSION: "0.2.31" }, file: join(dir, "missing") }), "0.2.31");
});

test("versionBase: X.Y of X.Y / X.Y.Z, null for anything else", () => {
  assert.equal(versionBase("0.2"), "0.2");
  assert.equal(versionBase("0.2.61"), "0.2");
  assert.equal(versionBase(" 1.10.3 "), "1.10");
  assert.equal(versionBase("01.02"), "1.2");
  for (const v of [undefined, "", "0", "v0.2", "0.2-beta", "0.2.3.4", DEV_CORE_VERSION, "test"]) {
    assert.equal(versionBase(v), null, String(v));
  }
});

test("versionBaseDiffers: only two parseable versions with another X.Y; patch numbers never count", () => {
  assert.equal(versionBaseDiffers("0.2.61", "0.3.1"), true);
  assert.equal(versionBaseDiffers("0.2", "1.2"), true);
  assert.equal(versionBaseDiffers("0.2.61", "0.2.7"), false);
  assert.equal(versionBaseDiffers("0.2", "0.2.7"), false);
  assert.equal(versionBaseDiffers("0.2.61", undefined), false);
  assert.equal(versionBaseDiffers("0.2.61", "0.0.0-dev"), false);
  assert.equal(versionBaseDiffers(DEV_CORE_VERSION, "0.3.1"), false);
});

test("welcome (T12.3): carries the Core version and warns on another X.Y, never refuses", async () => {
  const token = "browser-token-0123456789abcdef";
  const s = createCoreServer({
    tokens: loadDeviceTokens({ DEVICE_TOKEN_BROWSER: token }),
    logger: { info: () => {}, warn: () => {} },
    version: "0.2.61",
    createSession: (info) => ({ info, handle: async () => {}, close: async () => {} }) as unknown as Session,
  });
  const { port } = await s.listen(0, "127.0.0.1");
  const welcome = (clientVersion?: string) =>
    new Promise<ServerFrame>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on("open", () =>
        ws.send(JSON.stringify({ type: "hello", protocol: 1, token, client: "web", ...(clientVersion !== undefined ? { clientVersion } : {}) })),
      );
      ws.on("message", (d) => {
        const f = JSON.parse(d.toString()) as ServerFrame;
        ws.close();
        resolve(f);
      });
      ws.on("error", reject);
    });
  try {
    const other = await welcome("0.3.4");
    assert.equal(other.type, "welcome");
    assert.equal(other.type === "welcome" && other.version, "0.2.61");
    assert.deepEqual(other.type === "welcome" && other.warnings, ["version_base"]);
    for (const v of ["0.2.9", "0.2", undefined, "garbage"]) {
      const w = await welcome(v);
      assert.equal(w.type, "welcome", String(v));
      assert.equal(w.type === "welcome" && w.version, "0.2.61");
      assert.equal(w.type === "welcome" && "warnings" in w, false, String(v));
    }
  } finally {
    await s.close();
  }
});
