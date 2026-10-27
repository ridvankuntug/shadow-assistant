import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { matchGlob } from "../src/glob.js";
import {
  ConfirmBroker,
  identifyTool,
  normalizeTurkish,
  parseVoiceAnswer,
  PermissionPolicy,
  summarizeToolCall,
  type ConfirmResolution,
} from "../src/permissions.js";
import { loadServicesFile, parseServices } from "../src/services.js";

const HA = "mcp__home-assistant__";

test("glob matcher", () => {
  assert.ok(matchGlob("intent__Hass*", "intent__HassTurnOff"));
  assert.ok(!matchGlob("intent__Hass*", "xintent__HassTurnOff"));
  assert.ok(matchGlob("a?c", "abc"));
  assert.ok(!matchGlob("a*", "a/b"));
  assert.ok(matchGlob("knowledge/**", "knowledge/x/y.md"));
  assert.ok(matchGlob("knowledge/**", "knowledge"));
  assert.ok(matchGlob("**/x.md", "x.md"));
  assert.ok(matchGlob("**/x.md", "a/b/x.md"));
  assert.ok(matchGlob("a.b", "a.b"));
  assert.ok(!matchGlob("a.b", "axb"));
  assert.ok(matchGlob("*Lock*", "lock__HassLock", true));
});

test("identifyTool maps SDK names to service + HA tool", () => {
  assert.deepEqual(identifyTool(`${HA}homeassistant__GetLiveContext`, ["home-assistant", "home"]), {
    full: `${HA}homeassistant__GetLiveContext`,
    service: "home-assistant",
    tool: "homeassistant__GetLiveContext",
    builtin: false,
  });
  assert.equal(identifyTool("Bash", ["home-assistant"]).builtin, true);
  const unknown = identifyTool("mcp__other__thing__X", ["home-assistant"]);
  assert.equal(unknown.service, undefined);
  assert.equal(unknown.builtin, false);
});

const policy = () =>
  new PermissionPolicy(
    parseServices(
      [
        "services:",
        "  - name: home-assistant",
        "    kind: mcp",
        "    url: http://localhost:1/sse",
        "    permission: confirm",
        "    tools:",
        '      "homeassistant__GetLiveContext": read',
        '      "intent__Hass*": write',
        '      "intent__HassTurnOff": confirm',
        '      "*Lock*": confirm',
        "    confirm_inputs:",
        "      domain: [lock]",
        "      device_class: [garage]",
        "  - name: off",
        "    kind: mcp",
        "    url: http://localhost:1/sse",
        "    permission: read",
        "    enabled: false",
      ].join("\n"),
      {},
    ).services,
  );

test("levels: exact beats glob, glob beats default, default, unknown, builtin", () => {
  const p = policy();
  assert.equal(p.levelFor(`${HA}homeassistant__GetLiveContext`).level, "read");
  assert.equal(p.levelFor(`${HA}intent__HassTurnOn`).level, "write");
  assert.equal(p.levelFor(`${HA}intent__HassTurnOff`).level, "confirm"); // exact wins over earlier glob
  assert.equal(p.levelFor(`${HA}lock__HassLock`).level, "confirm"); // case-insensitive glob
  assert.equal(p.levelFor(`${HA}todo__get_items`).level, "confirm"); // service default
  assert.equal(p.levelFor("mcp__mystery__do_it").level, "confirm"); // unknown service
  assert.equal(p.levelFor("mcp__off__x").level, "confirm"); // disabled service = unknown
  assert.equal(p.levelFor("Bash").level, "deny");
  assert.equal(p.levelFor("WebFetch").level, "deny");
});

test("confirm_inputs escalates risky arguments, never lowers", () => {
  const p = policy();
  assert.equal(p.levelFor(`${HA}intent__HassTurnOn`, { name: "x", domain: ["light"] }).level, "write");
  const d = p.levelFor(`${HA}intent__HassTurnOn`, { domain: ["light", "LOCK"] });
  assert.equal(d.level, "confirm");
  assert.match(d.reason, /^input:domain=/);
  assert.equal(p.levelFor(`${HA}intent__HassTurnOn`, { device_class: "garage" }).level, "confirm");
  assert.equal(p.levelFor(`${HA}homeassistant__GetLiveContext`, { domain: "lock" }).level, "confirm");
});

test("repo services.yaml: example risky rules", () => {
  const repo = join(fileURLToPath(new URL("../../", import.meta.url)), "services.yaml");
  const cfg = loadServicesFile(repo, { HA_URL: "http://homeassistant.local:8123", HA_CORE_TOKEN: "t" });
  const p = new PermissionPolicy(cfg.services);
  assert.equal(p.levelFor(`${HA}homeassistant__GetLiveContext`).level, "read");
  assert.equal(p.levelFor(`${HA}intent__HassTurnOff`, { name: "lamba" }).level, "write");
  assert.equal(p.levelFor(`${HA}intent__HassTurnOff`, { domain: ["lock"] }).level, "confirm");
  assert.equal(p.levelFor(`${HA}intent__HassTurnOn`, { device_class: ["garage"] }).level, "confirm");
  assert.equal(p.levelFor(`${HA}lock__HassUnlock`).level, "confirm");
  assert.equal(p.levelFor(`${HA}alarm_control_panel__HassAlarmArm`).level, "confirm");
  assert.equal(p.levelFor(`${HA}script__1234`).level, "confirm");
  assert.equal(p.levelFor(`${HA}something__New`).level, "confirm");
  assert.equal(p.levelFor("mcp__shadow-vault__read_note").level, "read");
});

test("voice answers: whole short utterance, diacritic/case-insensitive", () => {
  for (const yes of ["evet", "Evet.", "EVET!", "onayla", "tamam", "olur", "evet lütfen", "Tamam, onayla"]) {
    assert.equal(parseVoiceAnswer(yes), true, yes);
  }
  for (const no of ["hayır", "HAYIR", "hayir", "iptal", "iptal et", "vazgeç", "Vazgec!"]) {
    assert.equal(parseVoiceAnswer(no), false, no);
  }
  for (const other of ["", "evet ama hayır", "ışığı aç", "evet evet evet evet", "tamam salonu da kapat", "lütfen"]) {
    assert.equal(parseVoiceAnswer(other), null, other);
  }
  assert.equal(normalizeTurkish("  IŞIK  Açık? "), "isik acik");
});

test("ConfirmBroker: first resolution wins, emitted once", async () => {
  const seen: ConfirmResolution[] = [];
  const b = new ConfirmBroker(10_000, (_r, res) => seen.push(res));
  const { request, result } = b.open("t1", "tool", "s");
  assert.equal(b.oldest()?.requestId, request.requestId);
  assert.equal(b.resolve(request.requestId, true, "voice"), true);
  assert.equal(b.resolve(request.requestId, false, "button"), false);
  assert.deepEqual(await result, { approved: true, by: "voice" });
  assert.deepEqual(seen, [{ approved: true, by: "voice" }]);
  assert.equal(b.size, 0);
});

test("ConfirmBroker: timeout denies", async () => {
  const b = new ConfirmBroker(20);
  const { request, result } = b.open("t1", "tool", "s");
  assert.ok(request.expiresAt > Date.now());
  assert.deepEqual(await result, { approved: false, by: "timeout" });
  assert.equal(b.resolve(request.requestId, true, "button"), false);
});

test("ConfirmBroker: cancel can never approve; cancelAll by turn", async () => {
  const b = new ConfirmBroker(10_000);
  const a = b.open("t1", "x", "s");
  const c = b.open("t2", "x", "s");
  b.cancelAll("t1");
  assert.deepEqual(await a.result, { approved: false, by: "cancel" });
  assert.equal(b.size, 1);
  assert.equal(b.resolve(c.request.requestId, true, "cancel"), true);
  assert.deepEqual(await c.result, { approved: false, by: "cancel" });
});

test("summary is Turkish, bounded and names the tool", () => {
  const s = summarizeToolCall(identifyTool(`${HA}intent__HassTurnOff`, ["home-assistant"]), {
    name: "x".repeat(500),
    domain: ["light"],
  });
  assert.match(s, /intent__HassTurnOff çalıştırılsın mı\?/);
  assert.ok(s.length <= 300);
});

test("ConfirmBroker: an answer after expiresAt counts as timeout", async () => {
  let now = 1_000;
  const seen: ConfirmResolution[] = [];
  const b = new ConfirmBroker(60_000, (_r, res) => seen.push(res), () => now);
  const { request, result } = b.open("t1", "tool", "s");
  now = request.expiresAt; // timer has not fired yet (busy event loop)
  assert.equal(b.resolve(request.requestId, true, "button"), true);
  assert.deepEqual(await result, { approved: false, by: "timeout" });
  assert.deepEqual(seen, [{ approved: false, by: "timeout" }]);
  const second = b.open("t1", "tool", "s");
  now = second.request.expiresAt - 1;
  b.resolve(second.request.requestId, true, "voice");
  assert.deepEqual(await second.result, { approved: true, by: "voice" });
});
