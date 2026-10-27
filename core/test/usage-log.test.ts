import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { UsageRecord } from "../src/router.js";
import { UsageLog } from "../src/usage-log.js";

const base = mkdtempSync(join(tmpdir(), "shadow-usage-test-"));
after(() => rmSync(base, { recursive: true, force: true }));

const rec = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  turnId: "t1",
  model: "model-a",
  inputTokens: 10,
  outputTokens: 2,
  durationMs: 5,
  ...over,
});

const readLines = (file: string): Record<string, unknown>[] =>
  readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

test("writes a whitelisted line to the day file", async () => {
  const dir = join(base, "d1");
  const now = new Date(2026, 0, 2, 10, 0, 0);
  const log = new UsageLog(dir, () => now);
  await log.append(
    rec({
      sessionId: "sess-1",
      tier: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      costUsd: 0.01,
      services: ["svc"],
      tools: ["a", "a"],
      outcome: "done",
    }),
  );
  const file = join(dir, "usage", "2026-01-02.jsonl");
  const [line] = readLines(file);
  assert.deepEqual(line, {
    ts: now.getTime(),
    sessionId: "sess-1",
    turnId: "t1",
    tier: 2,
    model: "model-a",
    inputTokens: 10,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    costUsd: 0.01,
    durationMs: 5,
    services: ["svc"],
    tools: ["a", "a"],
    outcome: "done",
  });
});

test("creates a self-ignoring usage folder", async () => {
  const dir = join(base, "d2");
  await new UsageLog(dir).append(rec());
  const lines = readFileSync(join(dir, "usage", ".gitignore"), "utf8").split("\n");
  assert.equal(lines.filter((l) => l.trim() === "*").length, 1);
});

test("does not overwrite an existing .gitignore", async () => {
  const dir = join(base, "d3");
  mkdirSync(join(dir, "usage"), { recursive: true });
  writeFileSync(join(dir, "usage", ".gitignore"), "custom\n");
  await new UsageLog(dir).append(rec());
  assert.equal(readFileSync(join(dir, "usage", ".gitignore"), "utf8"), "custom\n");
});

test("tier-0 record round-trips", async () => {
  const dir = join(base, "d4");
  const now = new Date(2026, 0, 2, 10, 0, 0);
  const log = new UsageLog(dir, () => now);
  await log.append(
    rec({ model: "none", tier: 0, inputTokens: 0, outputTokens: 0, durationMs: 0, tools: ["intent__HassTurnOn"], services: ["home-assistant"] }),
  );
  const [line] = readLines(join(dir, "usage", "2026-01-02.jsonl"));
  assert.equal(line?.model, "none");
  assert.equal(line?.tier, 0);
  assert.equal(line?.inputTokens, 0);
  assert.deepEqual(line?.tools, ["intent__HassTurnOn"]);
  assert.deepEqual(line?.services, ["home-assistant"]);
});

test("unknown extra properties are not written", async () => {
  const dir = join(base, "d5");
  const log = new UsageLog(dir, () => new Date(2026, 0, 2));
  await log.append({ ...rec(), token: "secret-value", headers: { authorization: "secret-value" } } as never);
  const text = readFileSync(join(dir, "usage", "2026-01-02.jsonl"), "utf8");
  assert.ok(!text.includes("secret-value"));
  assert.ok(!text.includes("headers"));
});

test("serializes multiple appends in order", async () => {
  const dir = join(base, "d6");
  const log = new UsageLog(dir, () => new Date(2026, 0, 2));
  void log.append(rec({ turnId: "a" }));
  void log.append(rec({ turnId: "b" }));
  void log.append(rec({ turnId: "c" }));
  await log.flush();
  assert.deepEqual(readLines(join(dir, "usage", "2026-01-02.jsonl")).map((l) => l.turnId), ["a", "b", "c"]);
});

test("day rollover writes a new file", async () => {
  const dir = join(base, "d7");
  let now = new Date(2026, 0, 2, 23, 59, 0);
  const log = new UsageLog(dir, () => now);
  await log.append(rec({ turnId: "a" }));
  now = new Date(2026, 0, 3, 0, 1, 0);
  await log.append(rec({ turnId: "b" }));
  const files = readdirSync(join(dir, "usage")).filter((f) => f.endsWith(".jsonl")).sort();
  assert.deepEqual(files, ["2026-01-02.jsonl", "2026-01-03.jsonl"]);
});

test("write failure is warned, not thrown", async () => {
  const file = join(base, "regular-file");
  writeFileSync(file, "x");
  const warnings: string[] = [];
  const log = new UsageLog(join(file, "sub"), () => new Date(2026, 0, 2), (m) => warnings.push(m));
  await log.append(rec());
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0]?.includes("usage log write failed"));
});

test("non-finite numbers are sanitized", async () => {
  const dir = join(base, "d9");
  const log = new UsageLog(dir, () => new Date(2026, 0, 2));
  await log.append(rec({ inputTokens: Number.NaN, outputTokens: Number.POSITIVE_INFINITY, durationMs: Number.NaN, costUsd: Number.NaN }));
  const [line] = readLines(join(dir, "usage", "2026-01-02.jsonl"));
  assert.equal(line?.inputTokens, 0);
  assert.equal(line?.outputTokens, 0);
  assert.equal(line?.durationMs, 0);
  assert.ok(!("costUsd" in (line ?? {})));
});
