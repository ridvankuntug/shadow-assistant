import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { interpolate, loadServicesFile, parseServices, ServicesConfigError } from "../src/services.js";

const REPO_SERVICES = join(fileURLToPath(new URL("../../", import.meta.url)), "services.yaml");

test("interpolate handles ${VAR}, defaults and missing vars", () => {
  assert.deepEqual(interpolate("${A}/x", { A: "http://h" }), { value: "http://h/x", missing: [] });
  assert.deepEqual(interpolate("${B:-http://d}", {}), { value: "http://d", missing: [] });
  assert.deepEqual(interpolate("${B:-http://d}", { B: "" }), { value: "http://d", missing: [] });
  assert.deepEqual(interpolate("${C}/y", {}), { value: "/y", missing: ["C"] });
});

test("repo services.yaml is valid and has no hard-coded hosts", () => {
  const env = { HA_URL: "http://homeassistant.local:8123", HA_CORE_TOKEN: "t" };
  const cfg = loadServicesFile(REPO_SERVICES, env);
  const ha = cfg.services.find((s) => s.name === "home-assistant");
  assert.ok(ha);
  assert.equal(ha.enabled, true);
  assert.equal(ha.transport, "sse");
  assert.equal(ha.url, "http://homeassistant.local:8123/mcp_server/sse");
  assert.equal(ha.tokenEnv, "HA_CORE_TOKEN");
  assert.ok(!ha.url.includes("/api/mcp"));
  assert.equal(cfg.services.find((s) => s.name === "whisper-svc")?.url, "http://127.0.0.1:8701");
  assert.equal(cfg.services.find((s) => s.name === "tts-svc")?.url, "http://127.0.0.1:8702");
  const vault = cfg.services.find((s) => s.kind === "vault");
  assert.ok(vault?.allow && vault.allow.length > 0);
});

test("missing env disables the service instead of failing", () => {
  const cfg = loadServicesFile(REPO_SERVICES, {});
  const ha = cfg.services.find((s) => s.name === "home-assistant");
  assert.equal(ha?.enabled, false);
  assert.match(ha?.disabledReason ?? "", /HA_URL/);
  assert.match(ha?.disabledReason ?? "", /HA_CORE_TOKEN/);
  assert.ok(cfg.warnings.some((w) => w.includes("home-assistant")));
});

test("enabled: false is respected", () => {
  const cfg = parseServices(
    `services:\n  - name: x\n    kind: http\n    url: http://localhost:1\n    enabled: false\n`,
    {},
  );
  assert.equal(cfg.services[0]?.enabled, false);
  assert.equal(cfg.services[0]?.disabledReason, undefined);
});

test("defaults: permission confirm, transport sse", () => {
  const cfg = parseServices(`services:\n  - name: m\n    kind: mcp\n    url: http://localhost:1/sse\n`, {});
  assert.equal(cfg.services[0]?.permission, "confirm");
  assert.equal(cfg.services[0]?.transport, "sse");
});

test("tools and confirm_inputs are parsed", () => {
  const cfg = parseServices(
    [
      "services:",
      "  - name: m",
      "    kind: mcp",
      "    url: http://localhost:1/sse",
      "    permission: read",
      "    tools:",
      '      "a__B": write',
      '      "x*": confirm',
      "    confirm_inputs:",
      "      domain: [Lock]",
    ].join("\n"),
    {},
  );
  const s = cfg.services[0];
  assert.deepEqual(s?.tools, [
    { pattern: "a__B", level: "write" },
    { pattern: "x*", level: "confirm" },
  ]);
  assert.deepEqual(s?.confirmInputs, { domain: ["lock"] });
});

test("validation collects problems", () => {
  const bad = [
    "services:",
    "  - name: Bad_Name",
    "    kind: mcp",
    "  - name: ok",
    "    kind: weird",
    "  - name: m",
    "    kind: mcp",
    "    permission: admin",
    "    transport: ws",
    "    tools:",
    '      "x": nope',
    "  - name: m",
    "    kind: http",
    "  - name: v",
    "    kind: vault",
    "    allow: ['../etc/**']",
    "  - name: u",
    "    kind: http",
    "    url: ftp://x",
  ].join("\n");
  assert.throws(
    () => parseServices(bad, {}),
    (err: unknown) => {
      assert.ok(err instanceof ServicesConfigError);
      const all = err.problems.join("\n");
      for (const needle of ["kebab-case", "kind must be", "permission must be", "transport must be", "tools['x']", "duplicate", "url is required for kind http", "'..'", "valid http(s) URL"]) {
        assert.ok(all.includes(needle), `missing problem: ${needle}\n${all}`);
      }
      return true;
    },
  );
});

test("top-level shape is required", () => {
  assert.throws(() => parseServices("foo: 1", {}), ServicesConfigError);
  assert.throws(() => parseServices("services: [", {}), ServicesConfigError);
  assert.throws(() => loadServicesFile("does-not-exist.yaml", {}), ServicesConfigError);
});
