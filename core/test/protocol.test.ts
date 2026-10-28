import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_TEXT_CHARS, parseClientFrame } from "../src/protocol.js";

const ok = (raw: unknown) => {
  const r = parseClientFrame(JSON.stringify(raw));
  assert.ok(r.ok, `expected ok for ${JSON.stringify(raw)}: ${r.ok ? "" : r.message}`);
  return r.frame;
};
const bad = (raw: unknown) => {
  const r = parseClientFrame(typeof raw === "string" ? raw : JSON.stringify(raw));
  assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(raw)}`);
  return r as { ok: false; message: string; id?: string };
};

test("valid frames parse", () => {
  assert.deepEqual(ok({ type: "hello", protocol: 1, token: "x", client: "web", clientVersion: "1" }), {
    type: "hello",
    protocol: 1,
    token: "x",
    client: "web",
    clientVersion: "1",
  });
  assert.equal(ok({ type: "user_text", id: "t1", text: "merhaba" }).type, "user_text");
  assert.equal(ok({ type: "audio", id: "t2", mime: "audio/webm;codecs=opus", data: "AAAA" }).type, "audio");
  assert.equal(ok({ type: "confirm_response", requestId: "c1", approved: false }).type, "confirm_response");
  assert.equal(ok({ type: "speak", id: "t1", text: "selam" }).type, "speak");
  assert.equal(ok({ type: "cancel", id: "t1" }).type, "cancel");
  assert.equal(ok({ type: "history_request" }).type, "history_request");
  assert.equal(ok({ type: "history_request", limit: 5 }).type, "history_request");
  assert.equal(ok({ type: "ping" }).type, "ping");
});

test("malformed frames are rejected", () => {
  bad("not json");
  bad([]);
  bad({ id: "x" });
  bad({ type: "nope" });
  bad({ type: "hello", protocol: "1", token: "x" });
  bad({ type: "hello", protocol: 1 });
  bad({ type: "user_text", id: "", text: "x" });
  bad({ type: "user_text", id: "t1", text: "   " });
  bad({ type: "user_text", id: "t1", text: "a".repeat(MAX_TEXT_CHARS + 1) });
  bad({ type: "audio", id: "t1", mime: "video/mp4", data: "AAAA" });
  bad({ type: "audio", id: "t1", mime: "audio/webm", data: "" });
  bad({ type: "confirm_response", requestId: "c1", approved: "yes" });
  bad({ type: "history_request", limit: 0 });
  bad({ type: "history_request", limit: 1.5 });
});

test("rejection carries the turn id when present", () => {
  assert.equal(bad({ type: "user_text", id: "t9" }).id, "t9");
});

test("rejection message never echoes the token", () => {
  const r = bad({ type: "hello", protocol: "x", token: "SECRET-TOKEN-VALUE" });
  assert.ok(!r.message.includes("SECRET"));
});

test("speak.voice is optional; voices request needs an id", () => {
  assert.deepEqual(ok({ type: "speak", id: "t1", text: "selam", voice: "tr_TR-fettah-medium" }), {
    type: "speak",
    id: "t1",
    text: "selam",
    voice: "tr_TR-fettah-medium",
  });
  // null / empty / over-long voice → absent (default voice), not an error.
  for (const voice of [null, "", "x".repeat(129)]) {
    assert.deepEqual(ok({ type: "speak", id: "t1", text: "selam", voice }), { type: "speak", id: "t1", text: "selam" });
  }
  assert.equal(bad({ type: "speak", id: "t1", text: "selam", voice: 5 }).id, "t1");
  bad({ type: "speak", id: "t1", text: "selam", voice: { id: "x" } });
  assert.deepEqual(ok({ type: "voices", id: "v1" }), { type: "voices", id: "v1" });
  bad({ type: "voices" });
  bad({ type: "voices", id: "" });
});
