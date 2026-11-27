/**
 * CORE_VERSION (docs/13 §6.1): env override, the repo-root VERSION file, and
 * the dev fallback. Files live in a temp folder; the real VERSION is only read.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { CORE_VERSION } from "../src/server.js";
import { DEV_CORE_VERSION, readCoreVersion, VERSION_FILE } from "../src/version.js";

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
  // The server constant (no CORE_VERSION in the test environment) is the same value.
  if (!process.env.CORE_VERSION) assert.equal(CORE_VERSION, base);
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
