import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "node:test";
import {
  isWildcardAddress,
  ListenerConfigError,
  loadListenerConfig,
  MAX_TLS_FILE_BYTES,
  originAllowed,
  TLS_KEY_CREDENTIAL,
  TLS_KEY_CREDENTIAL_PREFIXED,
  tlsOrigin,
  tlsOrigins,
  validTlsHostname,
  type ListenerFs,
} from "../src/listeners.js";
import { makeTestCert } from "./test-cert.js";

const cert = makeTestCert();
const other = makeTestCert();
const CREDS = "/creds";
const ROOT = resolve("/release");

/** In-memory files; a missing path throws ENOENT like readFileSync. */
function memFs(files: Record<string, string | Buffer>): ListenerFs {
  return {
    readFile: (p) => {
      const v = files[p];
      if (v === undefined) throw Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });
      return Buffer.isBuffer(v) ? v : Buffer.from(v);
    },
  };
}

const base = { host: "127.0.0.1", port: 8700, repoRoot: ROOT };
const tlsEnv = { CORE_TLS_HOST: "127.0.0.1", CORE_TLS_PORT: "8743", CORE_TLS_CERT_FILE: "/tls/core.crt", CORE_TLS_KEY_FILE: "/tls/core.key" };
const files = { "/tls/core.crt": cert.certPem, "/tls/core.key": cert.keyPem };

function refuses(fn: () => unknown, re: RegExp): void {
  assert.throws(fn, (err: unknown) => err instanceof ListenerConfigError && re.test(err.message));
}

test("no new variable: only CORE_HOST, nothing else (today's behaviour)", () => {
  const c = loadListenerConfig({}, { ...base, fs: memFs({}) });
  assert.deepEqual(c, { extraHosts: [], warnings: [], consumedCredentials: [] });
  // The PC Core's wildcard CORE_HOST alone stays allowed.
  const w = loadListenerConfig({}, { ...base, host: "0.0.0.0", fs: memFs({}) });
  assert.equal(w.tls, undefined);
  // A credentials dir without the TLS key changes nothing either.
  assert.equal(loadListenerConfig({}, { ...base, credentialsDir: CREDS, fs: memFs({}) }).tls, undefined);
});

test("CORE_EXTRA_HOSTS: IP list, no wildcard, no duplicates, needs a specific CORE_HOST", () => {
  const c = loadListenerConfig({ CORE_EXTRA_HOSTS: " 127.0.0.1 , ::1 ," }, { ...base, host: "192.0.2.10", fs: memFs({}) });
  assert.deepEqual(c.extraHosts, ["127.0.0.1", "::1"]);
  refuses(() => loadListenerConfig({ CORE_EXTRA_HOSTS: "0.0.0.0" }, { ...base, fs: memFs({}) }), /must not contain 0\.0\.0\.0/);
  refuses(() => loadListenerConfig({ CORE_EXTRA_HOSTS: "::" }, { ...base, fs: memFs({}) }), /must not contain/);
  refuses(() => loadListenerConfig({ CORE_EXTRA_HOSTS: "0:0::0" }, { ...base, fs: memFs({}) }), /must not contain/);
  refuses(() => loadListenerConfig({ CORE_EXTRA_HOSTS: "localhost" }, { ...base, fs: memFs({}) }), /not an IP address/);
  refuses(() => loadListenerConfig({ CORE_EXTRA_HOSTS: "127.0.0.1" }, { ...base, fs: memFs({}) }), /listed twice/);
  refuses(() => loadListenerConfig({ CORE_EXTRA_HOSTS: "::1,::1" }, { ...base, fs: memFs({}) }), /listed twice/);
  refuses(() => loadListenerConfig({ CORE_EXTRA_HOSTS: "127.0.0.1" }, { ...base, host: "0.0.0.0", fs: memFs({}) }), /specific CORE_HOST/);
  assert.deepEqual(loadListenerConfig({ CORE_EXTRA_HOSTS: " , " }, { ...base, fs: memFs({}) }).extraHosts, []);
});

test("wildcard detection", () => {
  for (const h of ["0.0.0.0", "::", "0:0:0:0:0:0:0:0", "::ffff:0.0.0.0"]) assert.equal(isWildcardAddress(h), true, h);
  for (const h of ["127.0.0.1", "::1", "192.0.2.1", "localhost", ""]) assert.equal(isWildcardAddress(h), false, h);
});

test("TLS: complete setting with a key file", () => {
  const c = loadListenerConfig(tlsEnv, { ...base, fs: memFs(files) });
  assert.equal(c.tls?.host, "127.0.0.1");
  assert.equal(c.tls?.port, 8743);
  assert.equal(c.tls?.keySource, "CORE_TLS_KEY_FILE");
  assert.equal(c.tls?.uiDir, join(ROOT, "ui", "dist"));
  assert.equal(c.tls?.key.toString(), cert.keyPem);
  assert.deepEqual(c.warnings, []);
  assert.deepEqual(c.consumedCredentials, []);
});

test("TLS: the key from the credential tls-key (or shadow-core.tls-key), never both", () => {
  const env = { ...tlsEnv, CORE_TLS_KEY_FILE: undefined };
  for (const id of [TLS_KEY_CREDENTIAL, TLS_KEY_CREDENTIAL_PREFIXED]) {
    const c = loadListenerConfig(env, { ...base, credentialsDir: CREDS, fs: memFs({ ...files, [join(CREDS, id)]: cert.keyPem }) });
    assert.equal(c.tls?.keySource, `credential ${id}`);
    assert.deepEqual(c.consumedCredentials, [id]);
  }
  refuses(
    () =>
      loadListenerConfig(env, {
        ...base,
        credentialsDir: CREDS,
        fs: memFs({ ...files, [join(CREDS, TLS_KEY_CREDENTIAL)]: cert.keyPem, [join(CREDS, TLS_KEY_CREDENTIAL_PREFIXED)]: cert.keyPem }),
      }),
    /delivered twice/,
  );
  refuses(
    () => loadListenerConfig(tlsEnv, { ...base, credentialsDir: CREDS, fs: memFs({ ...files, [join(CREDS, TLS_KEY_CREDENTIAL)]: cert.keyPem }) }),
    /given twice/,
  );
});

test("TLS: partial settings refuse the start and name what is missing", () => {
  refuses(() => loadListenerConfig({ CORE_TLS_HOST: "127.0.0.1" }, { ...base, fs: memFs(files) }), /missing: CORE_TLS_PORT, CORE_TLS_CERT_FILE, the key/);
  refuses(() => loadListenerConfig({ ...tlsEnv, CORE_TLS_HOST: " " }, { ...base, fs: memFs(files) }), /missing: CORE_TLS_HOST/);
  refuses(() => loadListenerConfig({ CORE_UI_DIR: "/ui" }, { ...base, fs: memFs(files) }), /partly configured/);
  // A delivered key credential alone also counts as a partial setting.
  refuses(
    () => loadListenerConfig({}, { ...base, credentialsDir: CREDS, fs: memFs({ [join(CREDS, TLS_KEY_CREDENTIAL)]: cert.keyPem }) }),
    /missing: CORE_TLS_HOST, CORE_TLS_PORT, CORE_TLS_CERT_FILE; refusing/,
  );
});

test("TLS: host and port rules", () => {
  const load = (env: Record<string, string>, host = "127.0.0.1") =>
    loadListenerConfig({ ...tlsEnv, ...env }, { ...base, host, fs: memFs(files) });
  refuses(() => load({ CORE_TLS_HOST: "0.0.0.0" }), /CORE_TLS_HOST must not be 0\.0\.0\.0/);
  refuses(() => load({ CORE_TLS_HOST: "::" }), /CORE_TLS_HOST must not be/);
  refuses(() => load({ CORE_TLS_HOST: "localhost" }), /must be an IP address/);
  refuses(() => load({}, "0.0.0.0"), /CORE_HOST must be a specific address/);
  for (const p of ["0", "65536", "abc", "-1", "84.3"]) refuses(() => load({ CORE_TLS_PORT: p }), /CORE_TLS_PORT must be a port number/);
  refuses(() => load({ CORE_TLS_PORT: "8700" }), /plain listener's port on the same address/);
  // Same port on another address is fine.
  assert.equal(load({ CORE_TLS_PORT: "8700" }, "192.0.2.10").tls?.port, 8700);
});

test("TLS: certificate and key problems refuse the start without key material in the message", () => {
  const msgs: string[] = [];
  const capture = (fn: () => unknown) => {
    try {
      fn();
      assert.fail("expected a refusal");
    } catch (err) {
      assert.ok(err instanceof ListenerConfigError, String(err));
      msgs.push(err.message);
    }
  };
  capture(() => loadListenerConfig(tlsEnv, { ...base, fs: memFs({ "/tls/core.key": cert.keyPem }) }));
  assert.match(msgs.at(-1) ?? "", /cannot read CORE_TLS_CERT_FILE \(ENOENT\)/);
  capture(() => loadListenerConfig(tlsEnv, { ...base, fs: memFs({ "/tls/core.crt": cert.certPem }) }));
  assert.match(msgs.at(-1) ?? "", /cannot read CORE_TLS_KEY_FILE \(ENOENT\)/);
  capture(() => loadListenerConfig(tlsEnv, { ...base, fs: memFs({ ...files, "/tls/core.crt": "" }) }));
  assert.match(msgs.at(-1) ?? "", /CORE_TLS_CERT_FILE is empty/);
  capture(() => loadListenerConfig(tlsEnv, { ...base, fs: memFs({ ...files, "/tls/core.key": Buffer.alloc(MAX_TLS_FILE_BYTES + 1, 0x41) }) }));
  assert.match(msgs.at(-1) ?? "", /larger than/);
  capture(() => loadListenerConfig(tlsEnv, { ...base, fs: memFs({ ...files, "/tls/core.crt": "not a cert" }) }));
  assert.match(msgs.at(-1) ?? "", /not a PEM certificate/);
  // The certificate given as the key: not a private key.
  capture(() => loadListenerConfig(tlsEnv, { ...base, fs: memFs({ ...files, "/tls/core.key": cert.certPem }) }));
  assert.match(msgs.at(-1) ?? "", /not an unencrypted PEM private key/);
  const encrypted = cert.key.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "test-only" }) as string;
  capture(() => loadListenerConfig(tlsEnv, { ...base, fs: memFs({ ...files, "/tls/core.key": encrypted }) }));
  assert.match(msgs.at(-1) ?? "", /not an unencrypted PEM private key/);
  capture(() => loadListenerConfig(tlsEnv, { ...base, fs: memFs({ ...files, "/tls/core.key": other.keyPem }) }));
  assert.match(msgs.at(-1) ?? "", /does not belong to CORE_TLS_CERT_FILE/);
  const keyBody = cert.keyPem.split("\n")[1] ?? "";
  const otherBody = other.keyPem.split("\n")[1] ?? "";
  for (const m of msgs) {
    assert.ok(!m.includes("PRIVATE KEY") && !m.includes(keyBody) && !m.includes(otherBody), m);
  }
});

test("TLS: warnings for an expiring or expired certificate and a missing address", () => {
  const day = 86400_000;
  const soon = makeTestCert({ notAfter: new Date(Date.now() + 3 * day) });
  const w1 = loadListenerConfig(tlsEnv, { ...base, fs: memFs({ "/tls/core.crt": soon.certPem, "/tls/core.key": soon.keyPem }) });
  assert.equal(w1.warnings.length, 1);
  assert.match(w1.warnings[0] ?? "", /expires on/);
  const old = makeTestCert({ notBefore: new Date(Date.now() - 10 * day), notAfter: new Date(Date.now() - day) });
  const w2 = loadListenerConfig(tlsEnv, { ...base, fs: memFs({ "/tls/core.crt": old.certPem, "/tls/core.key": old.keyPem }) });
  assert.match(w2.warnings.join("|"), /expired on/);
  const elsewhere = makeTestCert({ ip: [192, 0, 2, 1] });
  const w3 = loadListenerConfig(tlsEnv, { ...base, fs: memFs({ "/tls/core.crt": elsewhere.certPem, "/tls/core.key": elsewhere.keyPem }) });
  assert.match(w3.warnings.join("|"), /does not name CORE_TLS_HOST/);
});

test("CORE_TLS_HOSTNAME: strict DNS name rule", () => {
  const good = ["shadow.lan", "pi-1.home.lan", "1a.lan", "a.b1", "x.y.z", "xn--bcher-kva.lan", `${"a".repeat(63)}.lan`];
  for (const n of good) assert.equal(validTlsHostname(n), true, n);
  const bad = [
    "",
    "shadow",
    "Shadow.lan",
    "SHADOW.LAN",
    "*.shadow.lan",
    "shadow.lan.",
    ".shadow.lan",
    "a..lan",
    "-a.lan",
    "a-.lan",
    "a_b.lan",
    "a b.lan",
    "shadow.lan:8743",
    "shadow.lan,other.lan",
    "https://shadow.lan",
    "192.0.2.10",
    "1.2.3",
    "a.123",
    "pi.0x1",
    "1.2.3.0x4",
    "a.0x",
    "a.1b",
    "::1",
    "[::1]",
    "şadow.lan",
    `${"a".repeat(64)}.lan`,
    `${"a.".repeat(126)}lan`,
  ];
  for (const n of bad) assert.equal(validTlsHostname(n), false, n);
});

test("CORE_TLS_HOSTNAME: loaded with the TLS settings, checked against the certificate", () => {
  // Without it nothing changes (IP only).
  assert.equal(loadListenerConfig(tlsEnv, { ...base, fs: memFs(files) }).tls?.hostname, undefined);
  const named = makeTestCert({ dns: "shadow.lan" });
  const nf = { "/tls/core.crt": named.certPem, "/tls/core.key": named.keyPem };
  const c = loadListenerConfig({ ...tlsEnv, CORE_TLS_HOSTNAME: " shadow.lan " }, { ...base, fs: memFs(nf) });
  assert.equal(c.tls?.hostname, "shadow.lan");
  assert.deepEqual(c.warnings, []);
  // The certificate names another DNS name (localhost) only: warning, still starts.
  const w = loadListenerConfig({ ...tlsEnv, CORE_TLS_HOSTNAME: "shadow.lan" }, { ...base, fs: memFs(files) });
  assert.match(w.warnings.join("|"), /does not name CORE_TLS_HOSTNAME/);
  // A subdomain of the certificate's name is not a match either.
  const sub = loadListenerConfig({ ...tlsEnv, CORE_TLS_HOSTNAME: "x.shadow.lan" }, { ...base, fs: memFs(nf) });
  assert.match(sub.warnings.join("|"), /does not name CORE_TLS_HOSTNAME/);
  // Invalid names refuse the start; the value is not echoed.
  for (const n of ["Evil.LAN", "*.evil.lan", "evilname", "192.0.2.10", "evil.lan."]) {
    assert.throws(
      () => loadListenerConfig({ ...tlsEnv, CORE_TLS_HOSTNAME: n }, { ...base, fs: memFs(nf) }),
      (err: unknown) => err instanceof ListenerConfigError && /CORE_TLS_HOSTNAME must be/.test(err.message) && !err.message.includes(n),
      n,
    );
  }
  // On its own it is a partial TLS setting.
  refuses(
    () => loadListenerConfig({ CORE_TLS_HOSTNAME: "shadow.lan" }, { ...base, fs: memFs({}) }),
    /partly configured; missing: CORE_TLS_HOST, CORE_TLS_PORT, CORE_TLS_CERT_FILE, the key/,
  );
});

test("TLS: CORE_UI_DIR absolute or relative to the release root", () => {
  const abs = join(ROOT, "elsewhere", "ui");
  assert.equal(loadListenerConfig({ ...tlsEnv, CORE_UI_DIR: abs }, { ...base, fs: memFs(files) }).tls?.uiDir, abs);
  assert.equal(loadListenerConfig({ ...tlsEnv, CORE_UI_DIR: "web" }, { ...base, fs: memFs(files) }).tls?.uiDir, join(ROOT, "web"));
});

test("tlsOrigin normalises default port, host case and IPv6", () => {
  assert.equal(tlsOrigin("127.0.0.1", 8743), "https://127.0.0.1:8743");
  assert.equal(tlsOrigin("127.0.0.1", 443), "https://127.0.0.1");
  assert.equal(tlsOrigin("::1", 8743), "https://[::1]:8743");
  assert.equal(tlsOrigin("0:0:0:0:0:0:0:1", 8743), "https://[::1]:8743");
});

test("tlsOrigins: the IP's origin, plus the host name's when set", () => {
  assert.deepEqual(tlsOrigins("192.0.2.10", 8743), ["https://192.0.2.10:8743"]);
  assert.deepEqual(tlsOrigins("192.0.2.10", 8743, "shadow.lan"), ["https://192.0.2.10:8743", "https://shadow.lan:8743"]);
  assert.deepEqual(tlsOrigins("192.0.2.10", 443, "shadow.lan"), ["https://192.0.2.10", "https://shadow.lan"]);
});

test("originAllowed with a host name: the IP's and the name's origin, nothing else", () => {
  const own = tlsOrigins("192.0.2.10", 8743, "shadow.lan");
  const yes = [undefined, "https://192.0.2.10:8743", "https://shadow.lan:8743", "https://SHADOW.LAN:8743", "HTTPS://Shadow.Lan:8743", " https://shadow.lan:8743 "];
  for (const o of yes) assert.equal(originAllowed(o, own), true, String(o));
  const no = [
    "",
    "null",
    "http://shadow.lan:8743",
    "https://shadow.lan",
    "https://shadow.lan:8700",
    "https://x.shadow.lan:8743",
    "https://shadow.lan.:8743",
    "https://other.lan:8743",
    "https://shadow.lan.evil.example:8743",
    "https://user@shadow.lan:8743",
    "https://shadow.lan:8743/",
    "https://shadow.lan:8743/x/..",
    "https://shadow.lan:8743?x=1",
    "https://192.0.2.11:8743",
    "https://shadow.lan:8743, https://192.0.2.10:8743",
  ];
  for (const o of no) assert.equal(originAllowed(o, own), false, o);
  assert.equal(originAllowed(["https://shadow.lan:8743"], own), false);
  const own443 = tlsOrigins("192.0.2.10", 443, "shadow.lan");
  assert.equal(originAllowed("https://shadow.lan", own443), true);
  assert.equal(originAllowed("https://shadow.lan:443", own443), true);
  assert.equal(originAllowed("https://shadow.lan:8743", own443), false);
  // Without the name (IP only) the name's origin is refused.
  assert.equal(originAllowed("https://shadow.lan:8743", tlsOrigins("192.0.2.10", 8743)), false);
});

test("originAllowed: accept/refuse matrix", () => {
  const own = tlsOrigin("192.0.2.10", 8743);
  const yes = [undefined, "https://192.0.2.10:8743", " https://192.0.2.10:8743 ", "HTTPS://192.0.2.10:8743"];
  for (const o of yes) assert.equal(originAllowed(o, own), true, String(o));
  const no = [
    "",
    "null",
    "http://192.0.2.10:8743",
    "https://192.0.2.10",
    "https://192.0.2.10:8700",
    "https://192.0.2.11:8743",
    "https://evil.example",
    "https://192.0.2.10:8743.evil.example",
    "https://user@192.0.2.10:8743",
    "https://192.0.2.10:8743/path",
    "https://192.0.2.10:8743/",
    "https://192.0.2.10:8743/x/..",
    "https://192.0.2.10:8743/%2e%2e",
    "https://192.0.2.10:8743#",
    "https://192.0.2.10:8743\\",
    "https://192.0.2.10:8743?x=1",
    "https://192.0.2.10:8743, https://192.0.2.10:8743",
    "file://",
    "garbage",
  ];
  for (const o of no) assert.equal(originAllowed(o, own), false, o);
  assert.equal(originAllowed(["https://192.0.2.10:8743"], own), false);
  // Default port: an origin on 443 is sent without a port and matches.
  const own443 = tlsOrigin("192.0.2.10", 443);
  assert.equal(originAllowed("https://192.0.2.10", own443), true);
  assert.equal(originAllowed("https://192.0.2.10:443", own443), true);
  // IPv6 spelling and case.
  const own6 = tlsOrigin("fd00::a", 8743);
  assert.equal(originAllowed("https://[FD00:0:0:0:0:0:0:A]:8743", own6), true);
  assert.equal(originAllowed("https://[fd00::b]:8743", own6), false);
});
