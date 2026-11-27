/**
 * T11.2: secrets from systemd's $CREDENTIALS_DIRECTORY (credentials.ts). Opt-in
 * (no dir = the env object itself, unchanged), naming (variable name, optional
 * `shadow-core.` prefix), one trailing newline trimmed, refusals (env + credential,
 * double delivery, empty, multi-line, oversized, unreadable) without the value in
 * the message, process.env untouched, and the child env dropping the credentials path.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { subprocessEnv } from "../src/agent.js";
import { loadDeviceTokens } from "../src/auth.js";
import { CredentialsError, loadCredentials, MAX_CREDENTIAL_BYTES } from "../src/credentials.js";

const root = mkdtempSync(join(tmpdir(), "shadow-credentials-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const SECRET = "s3cret-value-0123456789abcdef";
let n = 0;
function credDir(files: Record<string, string | Buffer>): string {
  const dir = join(root, `c${n++}`);
  mkdirSync(dir);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

function refuses(fn: () => unknown, re: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof CredentialsError, String(err));
    assert.match(err.message, re);
    assert.ok(!err.message.includes(SECRET), "the value must never be in the message");
    return true;
  });
}

test("no CREDENTIALS_DIRECTORY (unset or blank): the env object itself, nothing loaded", () => {
  const env = { DEVICE_TOKEN_PHONE: SECRET };
  const r = loadCredentials(env);
  assert.equal(r.env, env);
  assert.deepEqual(r.loaded, []);
  assert.equal(r.dir, undefined);
  assert.equal(loadCredentials({ CREDENTIALS_DIRECTORY: "  " }).dir, undefined);
});

test("credential IDs are variable names, with or without the shadow-core. prefix; one trailing newline is trimmed", () => {
  const dir = credDir({
    DEVICE_TOKEN_PHONE: `${SECRET}\n`,
    "shadow-core.DEVICE_TOKEN_BROWSER": `${SECRET}-b\r\n`,
    HA_CORE_TOKEN: `${SECRET}-ha`,
    CORE_AGENT_TOKEN: `${SECRET}-agent\n`,
  });
  const env = { CREDENTIALS_DIRECTORY: dir, HA_URL: "http://ha" };
  const r = loadCredentials(env);
  assert.deepEqual(r.loaded, ["CORE_AGENT_TOKEN", "DEVICE_TOKEN_BROWSER", "DEVICE_TOKEN_PHONE", "HA_CORE_TOKEN"]);
  assert.equal(r.env.DEVICE_TOKEN_PHONE, SECRET);
  assert.equal(r.env.DEVICE_TOKEN_BROWSER, `${SECRET}-b`);
  assert.equal(r.env.HA_CORE_TOKEN, `${SECRET}-ha`);
  assert.equal(r.env.CORE_AGENT_TOKEN, `${SECRET}-agent`);
  assert.equal(r.env.HA_URL, "http://ha", "non-secret settings stay");
  assert.equal(r.dir, dir);
  assert.notEqual(r.env, env, "a copy: the input env is not changed");
  assert.equal("DEVICE_TOKEN_PHONE" in env, false);
  // Device tokens are found exactly like env variables.
  assert.deepEqual([...loadDeviceTokens(r.env).digests.keys()].sort(), ["browser", "phone"]);
});

test("only one trailing newline is removed; inner spaces are kept", () => {
  const dir = credDir({ HA_CORE_TOKEN: ` ${SECRET} \n` });
  assert.equal(loadCredentials({ CREDENTIALS_DIRECTORY: dir }).env.HA_CORE_TOKEN, ` ${SECRET} `);
});

test("IDs that are not variable names and sub-directories are ignored and reported by name", () => {
  const dir = credDir({ "tls-server.key": "k", "shadow-core.vault-deploy-key": "k", lower_case: "x", DEVICE_TOKEN_PHONE: SECRET });
  mkdirSync(join(dir, "SUBDIR"));
  const r = loadCredentials({ CREDENTIALS_DIRECTORY: dir });
  assert.deepEqual(r.loaded, ["DEVICE_TOKEN_PHONE"]);
  assert.deepEqual(r.ignored, ["SUBDIR", "lower_case", "shadow-core.vault-deploy-key", "tls-server.key"]);
  assert.equal(r.env["tls-server.key"], undefined);
});

test("a secret set both in the environment and as a credential refuses the start; a blank env value does not count", () => {
  const dir = credDir({ HA_CORE_TOKEN: SECRET });
  refuses(() => loadCredentials({ CREDENTIALS_DIRECTORY: dir, HA_CORE_TOKEN: "other-value" }), /HA_CORE_TOKEN is set both in the environment and as a credential/);
  const r = loadCredentials({ CREDENTIALS_DIRECTORY: dir, HA_CORE_TOKEN: "  " });
  assert.equal(r.env.HA_CORE_TOKEN, SECRET);
  const prefixed = credDir({ "shadow-core.DEVICE_TOKEN_PHONE": SECRET });
  refuses(() => loadCredentials({ CREDENTIALS_DIRECTORY: prefixed, DEVICE_TOKEN_PHONE: SECRET }), /DEVICE_TOKEN_PHONE is set both/);
});

test("the same variable delivered with and without the prefix refuses the start", () => {
  const dir = credDir({ DEVICE_TOKEN_PHONE: SECRET, "shadow-core.DEVICE_TOKEN_PHONE": SECRET });
  refuses(() => loadCredentials({ CREDENTIALS_DIRECTORY: dir }), /DEVICE_TOKEN_PHONE is delivered twice/);
});

test("empty, multi-line and oversized values refuse the start", () => {
  refuses(() => loadCredentials({ CREDENTIALS_DIRECTORY: credDir({ HA_CORE_TOKEN: "" }) }), /HA_CORE_TOKEN is empty/);
  refuses(() => loadCredentials({ CREDENTIALS_DIRECTORY: credDir({ HA_CORE_TOKEN: "\n" }) }), /is empty/);
  refuses(() => loadCredentials({ CREDENTIALS_DIRECTORY: credDir({ HA_CORE_TOKEN: " \t\n" }) }), /is empty/);
  refuses(() => loadCredentials({ CREDENTIALS_DIRECTORY: credDir({ HA_CORE_TOKEN: `${SECRET}\n\n` }) }), /more than one line/);
  refuses(() => loadCredentials({ CREDENTIALS_DIRECTORY: credDir({ HA_CORE_TOKEN: `${SECRET}\nsecond` }) }), /more than one line/);
  refuses(() => loadCredentials({ CREDENTIALS_DIRECTORY: credDir({ HA_CORE_TOKEN: `${SECRET}\r` }) }), /more than one line/);
  const big = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1, "a");
  refuses(() => loadCredentials({ CREDENTIALS_DIRECTORY: credDir({ HA_CORE_TOKEN: big }) }), /larger than 4096 bytes/);
  const atLimit = Buffer.alloc(MAX_CREDENTIAL_BYTES, "a");
  assert.equal(loadCredentials({ CREDENTIALS_DIRECTORY: credDir({ HA_CORE_TOKEN: atLimit }) }).env.HA_CORE_TOKEN?.length, MAX_CREDENTIAL_BYTES);
});

test("a missing credentials dir or an unreadable file refuses the start with a clear message", () => {
  refuses(() => loadCredentials({ CREDENTIALS_DIRECTORY: join(root, "missing") }), /cannot read CREDENTIALS_DIRECTORY \(ENOENT\)/);
  const failing = {
    readdir: () => [{ name: "HA_CORE_TOKEN", isFile: true }],
    readFile: () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    },
  };
  refuses(() => loadCredentials({ CREDENTIALS_DIRECTORY: "/run/credentials/x" }, failing), /cannot read credential HA_CORE_TOKEN \(EACCES\)/);
});

test("process.env is never written", () => {
  const dir = credDir({ DEVICE_TOKEN_T11_2_PROBE: SECRET });
  process.env.CREDENTIALS_DIRECTORY = dir;
  try {
    const r = loadCredentials();
    assert.equal(r.env.DEVICE_TOKEN_T11_2_PROBE, SECRET);
    assert.notEqual(r.env, process.env);
    assert.equal(process.env.DEVICE_TOKEN_T11_2_PROBE, undefined);
  } finally {
    delete process.env.CREDENTIALS_DIRECTORY;
  }
});

test("subprocessEnv drops CREDENTIALS_DIRECTORY and the agent token besides device and HA tokens", () => {
  const out = subprocessEnv({ PATH: "p", CREDENTIALS_DIRECTORY: "/run/credentials/shadow-core.service", CORE_AGENT_TOKEN: SECRET, DEVICE_TOKEN_PHONE: SECRET, HA_CORE_TOKEN: SECRET });
  assert.equal(out.PATH, "p");
  for (const k of ["CREDENTIALS_DIRECTORY", "CORE_AGENT_TOKEN", "DEVICE_TOKEN_PHONE", "HA_CORE_TOKEN"]) assert.equal(k in out, false, k);
});

// POSIX only: on Windows chmod cannot take read access away.
test("an unreadable credential file (real fs) refuses the start", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
  const dir = credDir({ HA_CORE_TOKEN: SECRET });
  chmodSync(join(dir, "HA_CORE_TOKEN"), 0o000);
  refuses(() => loadCredentials({ CREDENTIALS_DIRECTORY: dir }), /cannot read credential HA_CORE_TOKEN \(EACCES\)/);
});
