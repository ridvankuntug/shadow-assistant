/** Repeated-error stop, pure part (docs/14 Decision 10, T4.7). */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { argumentClass, ERROR_TEXT_MAX, normalizeErrorText, RepeatGuard } from "../src/repeat-guard.js";

const LIVE = "homeassistant__GetLiveContext";

describe("argumentClass", () => {
  test("tool name + sorted top-level keys, values ignored", () => {
    assert.equal(argumentClass(LIVE, { name: "Bahçe Pompası" }), `${LIVE}|name`);
    assert.equal(argumentClass(LIVE, { name: "x" }), argumentClass(LIVE, { name: "y" }));
    assert.equal(argumentClass("t", { b: 1, a: { deep: 1 } }), "t|a,b");
    assert.equal(argumentClass("t", { a: 1, b: 2 }), argumentClass("t", { b: 3, a: 4 }));
  });

  test("no input, null, arrays and primitives are the empty set", () => {
    assert.equal(argumentClass(LIVE, undefined), `${LIVE}|`);
    assert.equal(argumentClass(LIVE, {}), `${LIVE}|`);
    assert.equal(argumentClass(LIVE, null), `${LIVE}|`);
    assert.equal(argumentClass(LIVE, ["name"]), `${LIVE}|`);
    assert.equal(argumentClass(LIVE, "name"), `${LIVE}|`);
  });

  test("other tool or other key set is another class", () => {
    assert.notEqual(argumentClass("a", { name: 1 }), argumentClass("b", { name: 1 }));
    assert.notEqual(argumentClass("a", { name: 1 }), argumentClass("a", { name: 1, area: 2 }));
  });

  test("keys holding separators cannot collide with other shapes", () => {
    assert.notEqual(argumentClass("t", { "a,b": 1 }), argumentClass("t", { a: 1, b: 2 }));
    assert.notEqual(argumentClass("t", { "x|y": 1 }), argumentClass("t|x", { y: 1 }));
    assert.notEqual(argumentClass("t", { 'a",b': 1 }), argumentClass("t", { '"a': 1, b: 2 }));
  });

  test("an empty key is not the empty set; odd keys never throw", () => {
    const lone = String.fromCharCode(0xd800);
    const other = String.fromCharCode(0xdc00);
    assert.notEqual(argumentClass("t", { "": 1 }), argumentClass("t", {}));
    assert.doesNotThrow(() => argumentClass("t", { [lone]: 1 }));
    assert.notEqual(argumentClass("t", { [lone]: 1 }), argumentClass("t", { [other]: 1 }));
  });
});

describe("normalizeErrorText", () => {
  test("NFC, tr-TR lower case, whitespace collapsed, digit runs → #", () => {
    assert.equal(normalizeErrorText("  Entity  ID 12345\n not\tFOUND (code 7) "), "entity ıd # not found (code #)");
    assert.equal(normalizeErrorText("İSİM BULUNAMADI"), "isim bulunamadı");
    assert.equal(normalizeErrorText("café"), normalizeErrorText("café"));
  });

  test("ids and numbers do not make identical failures differ", () => {
    assert.equal(normalizeErrorText("timeout after 3000 ms (req 41)"), normalizeErrorText("Timeout after 5000 ms (req 42)"));
  });

  test("no text is the empty string", () => {
    assert.equal(normalizeErrorText(undefined), "");
    assert.equal(normalizeErrorText(null), "");
    assert.equal(normalizeErrorText(42), "");
    assert.equal(normalizeErrorText("   "), "");
  });

  test("cut to ERROR_TEXT_MAX code points without splitting a surrogate pair", () => {
    const long = "x".repeat(ERROR_TEXT_MAX - 1) + "😀" + "tail";
    const out = normalizeErrorText(long);
    assert.equal(Array.from(out).length, ERROR_TEXT_MAX);
    assert.ok(out.endsWith("😀"));
    assert.equal(normalizeErrorText("a".repeat(500)).length, ERROR_TEXT_MAX);
  });
});

describe("RepeatGuard", () => {
  test("two identical failures of one class block it; a third call is denied", () => {
    const g = new RepeatGuard();
    g.noteAllowed("u1", LIVE, { name: "A" });
    assert.equal(g.recordResult("u1", true, "Unexpected key: name"), false);
    assert.equal(g.isBlocked(LIVE, { name: "B" }), false);
    g.noteAllowed("u2", LIVE, { name: "B" });
    assert.equal(g.recordResult("u2", true, "unexpected   key: NAME"), true);
    assert.equal(g.isBlocked(LIVE, { name: "C" }), true);
    // Other argument class and other tool are not blocked.
    assert.equal(g.isBlocked(LIVE, {}), false);
    assert.equal(g.isBlocked(LIVE, { name: "C", area: "x" }), false);
    assert.equal(g.isBlocked("intent__HassTurnOff", { name: "C" }), false);
  });

  test("different error texts do not block", () => {
    const g = new RepeatGuard();
    g.noteAllowed("u1", "intent__HassTurnOn", { name: "A" });
    g.recordResult("u1", true, "name not found");
    g.noteAllowed("u2", "intent__HassTurnOn", { name: "B" });
    g.recordResult("u2", true, "device unavailable");
    assert.equal(g.isBlocked("intent__HassTurnOn", { name: "C" }), false);
  });

  test("successful results neither count nor reset", () => {
    const g = new RepeatGuard();
    g.noteAllowed("u1", "t", { a: 1 });
    g.recordResult("u1", true, "boom");
    g.noteAllowed("u2", "t", { a: 2 });
    assert.equal(g.recordResult("u2", false, "boom"), false);
    assert.equal(g.isBlocked("t", { a: 3 }), false);
    g.noteAllowed("u3", "t", { a: 3 });
    assert.equal(g.recordResult("u3", true, "boom"), true);
    assert.equal(g.isBlocked("t", { a: 4 }), true);
  });

  test("results of calls never noted (gate denials) and repeated results of one call do not count", () => {
    const g = new RepeatGuard();
    assert.equal(g.recordResult("denied", true, "boom"), false);
    assert.equal(g.recordResult("denied", true, "boom"), false);
    g.noteAllowed("u1", "t", {});
    g.recordResult("u1", true, "boom");
    assert.equal(g.recordResult("u1", true, "boom"), false);
    assert.equal(g.isBlocked("t", {}), false);
  });

  test("no error text counts as the same empty text", () => {
    const g = new RepeatGuard();
    g.noteAllowed("u1", "t", {});
    g.recordResult("u1", true);
    g.noteAllowed("u2", "t", {});
    assert.equal(g.recordResult("u2", true, "  "), true);
    assert.equal(g.isBlocked("t", undefined), true);
  });

  test("a blocked class reports blocking only once", () => {
    const g = new RepeatGuard();
    const cls = argumentClass("t", { a: 1 });
    assert.equal(g.recordError(cls, "x"), false);
    assert.equal(g.recordError(cls, "x"), true);
    assert.equal(g.recordError(cls, "x"), false);
    assert.equal(g.isBlocked("t", { a: 0 }), true);
  });

  test("each guard is one turn: a new guard starts empty", () => {
    const g = new RepeatGuard();
    const cls = argumentClass("t", {});
    g.recordError(cls, "x");
    g.recordError(cls, "x");
    assert.equal(g.isBlocked("t", {}), true);
    assert.equal(new RepeatGuard().isBlocked("t", {}), false);
  });
});
