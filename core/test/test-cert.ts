/**
 * TEST ONLY: a throwaway self-signed X.509 certificate (EC P-256,
 * subjectAltName IP:127.0.0.1 and DNS:localhost by default) built at test time, so no key
 * is committed and no `openssl` binary is needed. node:crypto signs but does
 * not build certificates, hence the small DER encoder below (just the fields
 * a v3 certificate needs).
 */
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";

function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n < 0x100) return Buffer.from([0x81, n]);
  return Buffer.from([0x82, n >> 8, n & 0xff]);
}
function tlv(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
}
const seq = (...c: Buffer[]) => tlv(0x30, ...c);
function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const bytes = [40 * (parts[0] ?? 0) + (parts[1] ?? 0)];
  for (const p of parts.slice(2)) {
    const enc = [p & 0x7f];
    for (let v = p >> 7; v > 0; v >>= 7) enc.unshift((v & 0x7f) | 0x80);
    bytes.push(...enc);
  }
  return tlv(0x06, Buffer.from(bytes));
}
function utcTime(d: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, "0");
  const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, "ascii"));
}
const name = (cn: string) => seq(tlv(0x31, seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(cn, "utf8")))));

export interface TestCert {
  certPem: string;
  keyPem: string;
  key: KeyObject;
}

export interface TestCertOptions {
  notBefore?: Date;
  notAfter?: Date;
  /** subjectAltName IPv4 address; default 127.0.0.1. */
  ip?: [number, number, number, number];
  /** subjectAltName DNS name; default localhost. */
  dns?: string;
}

/** A fresh self-signed certificate + key (TEST ONLY). */
export function makeTestCert(opts: TestCertOptions = {}): TestCert {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const serial = randomBytes(8);
  // Positive and minimal DER: first byte 0x01..0x7f (never a redundant leading zero).
  serial[0] = ((serial[0] ?? 0) & 0x7f) | 0x01;
  const san = seq(tlv(0x87, Buffer.from(opts.ip ?? [127, 0, 0, 1])), tlv(0x82, Buffer.from(opts.dns ?? "localhost", "ascii")));
  const ski = createHash("sha1").update(spki).digest();
  const extensions = tlv(
    0xa3,
    seq(
      // basicConstraints CA:TRUE (critical): the test client trusts this certificate as its own root.
      seq(oid("2.5.29.19"), tlv(0x01, Buffer.from([0xff])), tlv(0x04, seq(tlv(0x01, Buffer.from([0xff]))))),
      seq(oid("2.5.29.17"), tlv(0x04, san)),
      seq(oid("2.5.29.14"), tlv(0x04, tlv(0x04, ski))),
    ),
  );
  const now = Date.now();
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    ecdsaSha256,
    name("shadow-test"),
    seq(utcTime(opts.notBefore ?? new Date(now - 3600_000)), utcTime(opts.notAfter ?? new Date(now + 365 * 86400_000))),
    name("shadow-test"),
    spki,
    extensions,
  );
  const sig = sign("sha256", tbs, { key: privateKey, dsaEncoding: "der" });
  const der = seq(tbs, ecdsaSha256, tlv(0x03, Buffer.from([0]), sig));
  const b64 = der.toString("base64").replace(/(.{64})/g, "$1\n").trimEnd();
  return {
    certPem: `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`,
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    key: privateKey,
  };
}
