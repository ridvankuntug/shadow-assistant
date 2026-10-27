import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ConversationLog, dayStamp } from "../src/conversation-log.js";

const base = mkdtempSync(join(tmpdir(), "shadow-log-test-"));
after(() => rmSync(base, { recursive: true, force: true }));

test("creates a self-ignoring data dir", async () => {
  const dir = join(base, "vault", ".shadow-assistant");
  await new ConversationLog(dir).ensureDir();
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8").split("\n").filter((l) => l.trim() === "*").length, 1);
});

test("does not overwrite an existing .gitignore", async () => {
  const dir = join(base, "custom");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".gitignore"), "custom\n");
  await new ConversationLog(dir).ensureDir();
  assert.equal(readFileSync(join(dir, ".gitignore"), "utf8"), "custom\n");
});

test("writes ordered JSONL per session and day", async () => {
  const dir = join(base, "d1");
  const fixed = new Date(2026, 9, 27, 12, 0, 0);
  const log = new ConversationLog(dir, () => fixed);
  const s = log.session("sess-1");
  assert.equal(s.file, join(dir, "conversations", "2026-10-27", "sess-1.jsonl"));
  void s.append({ kind: "session_start", device: "browser" });
  void s.append({ kind: "user", id: "t1", text: "merhaba", source: "text" });
  void s.append({ kind: "tool_call", id: "t1", tool: "mcp__x__y", level: "write", reason: "rule:y", input: { a: 1 } });
  void s.append({ kind: "permission", id: "t1", tool: "mcp__x__y", decision: "allow", level: "write" });
  void s.append({ kind: "assistant", id: "t1", text: "selam" });
  await s.append({ kind: "usage", id: "t1", model: "haiku", inputTokens: 10, outputTokens: 2, durationMs: 5 });
  const lines = readFileSync(s.file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(
    lines.map((l) => l.kind),
    ["session_start", "user", "tool_call", "permission", "assistant", "usage"],
  );
  assert.ok(lines.every((l) => l.sessionId === "sess-1" && typeof l.ts === "number"));
});

test("history returns recent user/assistant items across sessions, oldest first", async () => {
  const dir = join(base, "d2");
  let t = new Date(2026, 9, 26, 10, 0, 0).getTime();
  const log = new ConversationLog(dir, () => new Date((t += 1000)));
  const a = log.session("a");
  await a.append({ kind: "user", id: "1", text: "u1", source: "text" });
  await a.append({ kind: "assistant", id: "1", text: "a1" });
  await a.append({ kind: "usage", id: "1", model: "m", inputTokens: 1, outputTokens: 1, durationMs: 1 });
  t = new Date(2026, 9, 27, 10, 0, 0).getTime();
  const b = log.session("b");
  await b.append({ kind: "user", id: "2", text: "u2", source: "voice" });
  await b.append({ kind: "assistant", id: "2", text: "a2" });
  // torn line must be skipped
  writeFileSync(b.file, readFileSync(b.file, "utf8") + '{"kind":"user","te');
  const h = await log.history(3);
  assert.deepEqual(
    h.map((i) => `${i.role}:${i.text}`),
    ["assistant:a1", "user:u2", "assistant:a2"],
  );
  assert.deepEqual(await new ConversationLog(join(base, "empty")).history(5), []);
});

test("rejects unsafe session ids", () => {
  assert.throws(() => new ConversationLog(base).session("../x"));
});

test("dayStamp is local YYYY-MM-DD", () => {
  assert.equal(dayStamp(new Date(2026, 0, 5)), "2026-01-05");
});

test("history includes a session that spans midnight (written in the older day folder)", async () => {
  const dir = join(base, "d3");
  let t = new Date(2026, 9, 26, 23, 59, 0).getTime();
  const log = new ConversationLog(dir, () => new Date((t += 1000)));
  const late = log.session("late"); // started on the 26th
  t = new Date(2026, 9, 27, 9, 0, 0).getTime();
  const early = log.session("early"); // started on the 27th
  await early.append({ kind: "user", id: "e", text: "sabah", source: "text" });
  t = new Date(2026, 9, 27, 10, 0, 0).getTime();
  await late.append({ kind: "user", id: "l", text: "gece yarısından sonra", source: "text" });
  const h = await log.history(1);
  assert.deepEqual(h.map((i) => i.text), ["gece yarısından sonra"]);
});
