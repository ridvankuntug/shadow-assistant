/**
 * T7.w.11.9: quiet hours for urgent speech — the CORE_QUIET_HOURS parser, the
 * window check (local time, start inclusive, end exclusive, across midnight)
 * and the config wiring. The center's behaviour is in session-notifications.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { loadConfig, parseQuietHours } from "../src/config.js";
import { DEFAULT_QUIET_HOURS, formatQuietHours, inQuietHours } from "../src/notifications.js";

const dir = mkdtempSync(join(tmpdir(), "shadow-quiet-hours-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

const at = (h: number, m: number) => new Date(2026, 0, 15, h, m);

test("default window 00:00-09:00: 23:59 and 09:00 are not quiet, 00:00 and 08:59 are", () => {
  assert.equal(inQuietHours(DEFAULT_QUIET_HOURS, at(23, 59)), false);
  assert.equal(inQuietHours(DEFAULT_QUIET_HOURS, at(0, 0)), true);
  assert.equal(inQuietHours(DEFAULT_QUIET_HOURS, at(8, 59)), true);
  assert.equal(inQuietHours(DEFAULT_QUIET_HOURS, new Date(2026, 0, 15, 8, 59, 59, 999)), true);
  assert.equal(inQuietHours(DEFAULT_QUIET_HOURS, at(9, 0)), false);
  assert.equal(inQuietHours(DEFAULT_QUIET_HOURS, at(12, 0)), false);
});

test("a window across midnight and no window", () => {
  const q = { startMin: 22 * 60, endMin: 7 * 60 };
  assert.deepEqual([at(21, 59), at(22, 0), at(0, 0), at(6, 59), at(7, 0)].map((d) => inQuietHours(q, d)), [false, true, true, true, false]);
  assert.equal(inQuietHours(null, at(3, 0)), false);
  assert.equal(inQuietHours(undefined, at(3, 0)), false);
  assert.equal(inQuietHours(DEFAULT_QUIET_HOURS, new Date(Number.NaN)), false);
});

test("parseQuietHours: unset / blank = default, off = none, valid windows, invalid = default with a warning", () => {
  assert.deepEqual(parseQuietHours(undefined), { quietHours: DEFAULT_QUIET_HOURS });
  assert.deepEqual(parseQuietHours("  "), { quietHours: DEFAULT_QUIET_HOURS });
  for (const off of ["off", "OFF", "0", "false", "no", "none"]) assert.deepEqual(parseQuietHours(off), { quietHours: null }, off);
  assert.deepEqual(parseQuietHours("00:00-09:00"), { quietHours: { startMin: 0, endMin: 540 } });
  assert.deepEqual(parseQuietHours(" 22:30 - 7:15 "), { quietHours: { startMin: 1350, endMin: 435 } });
  assert.deepEqual(parseQuietHours("23:59-00:00"), { quietHours: { startMin: 1439, endMin: 0 } });
  for (const bad of ["9", "00:00", "24:00-09:00", "00:60-09:00", "08:00-08:00", "0:0-9:0", "00:00-09:00x", "on", "-01:00-09:00"]) {
    const r = parseQuietHours(bad);
    assert.deepEqual(r.quietHours, DEFAULT_QUIET_HOURS, bad);
    assert.match(r.warning ?? "", /CORE_QUIET_HOURS/, bad);
  }
  assert.equal(formatQuietHours({ startMin: 1350, endMin: 435 }), "22:30-07:15");
  assert.equal(formatQuietHours(DEFAULT_QUIET_HOURS), "00:00-09:00");
});

test("loadConfig: CORE_QUIET_HOURS reaches the config (default, a window, off, an invalid value)", () => {
  const services = join(dir, "services.yaml");
  writeFileSync(services, "services: []\n");
  const env = (v?: string): NodeJS.ProcessEnv => ({
    SHADOW_SERVICES_FILE: services,
    SHADOW_DATA_DIR: dir,
    CORE_ROUTER: "off",
    ...(v === undefined ? {} : { CORE_QUIET_HOURS: v }),
  });
  const def = loadConfig(env());
  assert.deepEqual(def.quietHours, DEFAULT_QUIET_HOURS);
  assert.equal(def.quietHoursWarning, undefined);
  assert.deepEqual(loadConfig(env("22:00-07:00")).quietHours, { startMin: 1320, endMin: 420 });
  assert.equal(loadConfig(env("off")).quietHours, null);
  const bad = loadConfig(env("nonsense"));
  assert.deepEqual(bad.quietHours, DEFAULT_QUIET_HOURS);
  assert.ok(bad.quietHoursWarning);
});
