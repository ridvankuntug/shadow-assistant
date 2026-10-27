import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { VaultAccessError, VaultReader } from "../src/vault.js";

let root: string;
let outside: string;
let reader: VaultReader;

function trySymlink(target: string, path: string, type: "file" | "junction"): boolean {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch {
    return false; // no symlink privilege (Windows without developer mode)
  }
}

before(() => {
  const base = mkdtempSync(join(tmpdir(), "shadow-vault-test-"));
  root = join(base, "vault");
  outside = join(base, "outside");
  for (const d of ["knowledge/sub", "Private", "knowledge/private", "daily", ".obsidian", "knowledge/.hidden"]) {
    mkdirSync(join(root, d), { recursive: true });
  }
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "knowledge/a.md"), "# A\nmerhaba");
  writeFileSync(join(root, "knowledge/sub/b.md"), "B");
  writeFileSync(join(root, "knowledge/big.md"), "x".repeat(5000));
  writeFileSync(join(root, "knowledge/c.txt"), "not md");
  writeFileSync(join(root, "knowledge/private/p.md"), "nested private");
  writeFileSync(join(root, "knowledge/.hidden/h.md"), "hidden");
  writeFileSync(join(root, "Private/secret.md"), "secret");
  writeFileSync(join(root, "daily/2026-01-01.md"), "daily");
  writeFileSync(join(outside, "x.md"), "outside");
  reader = new VaultReader({ root, allow: ["knowledge/**"], maxBytes: 1000 });
});

after(() => rmSync(join(root, ".."), { recursive: true, force: true }));

const denied = async (p: string, re?: RegExp) => {
  await assert.rejects(reader.read(p), (err: unknown) => {
    assert.ok(err instanceof VaultAccessError, `expected VaultAccessError for ${p}`);
    if (re) assert.match(err.message, re);
    return true;
  });
};

test("reads allowed notes", async () => {
  const r = await reader.read("knowledge/a.md");
  assert.equal(r.path, "knowledge/a.md");
  assert.equal(r.text, "# A\nmerhaba");
  assert.equal(r.truncated, false);
  assert.equal((await reader.read("./knowledge\\sub\\b.md")).text, "B");
});

test("size limit truncates", async () => {
  const r = await reader.read("knowledge/big.md");
  assert.equal(r.truncated, true);
  assert.equal(r.text.length, 1000);
  assert.equal(r.size, 5000);
});

test("Private is always refused, at any depth and case", async () => {
  await denied("Private/secret.md", /Private/);
  await denied("private/secret.md", /Private/);
  await denied("knowledge/private/p.md", /Private/);
  const wide = new VaultReader({ root, allow: ["**"] });
  await assert.rejects(wide.read("Private/secret.md"), VaultAccessError);
});

test("traversal, absolute paths, hidden folders, non-md and non-allowed are refused", async () => {
  await denied("knowledge/../Private/secret.md");
  await denied("../outside/x.md");
  await denied("knowledge/../../outside/x.md");
  await denied(join(root, "knowledge/a.md"));
  await denied("/etc/passwd");
  await denied("C:/Windows/win.ini");
  await denied("knowledge/.hidden/h.md", /hidden/);
  await denied(".obsidian/app.md", /hidden/);
  await denied("knowledge/c.txt", /\.md/);
  await denied("daily/2026-01-01.md", /allowed/);
  await denied("knowledge/missing.md", /not found/);
  await denied("");
  await denied("knowledge/a.md\0");
  await denied("knowledge/c.txt:x.md", /invalid character/); // NTFS alternate data stream
  await denied("knowledge/a.md:x.md", /invalid character/);
  await denied("\\\\server\\share\\x.md");
});

test("symlink escapes are refused", async (t) => {
  const linkedDir = join(root, "knowledge", "link-out");
  const linkedPrivate = join(root, "knowledge", "link-private");
  const okDir = trySymlink(outside, linkedDir, "junction");
  const okPriv = trySymlink(join(root, "Private"), linkedPrivate, "junction");
  if (!okDir && !okPriv) {
    t.skip("symlinks/junctions not available");
    return;
  }
  if (okDir) await denied("knowledge/link-out/x.md", /escapes/);
  if (okPriv) await denied("knowledge/link-private/secret.md", /Private/);
  const listed = await reader.list();
  assert.ok(!listed.notes.some((n) => n.includes("link-")));
});

test("list returns only allowed notes", async () => {
  const { notes, truncated } = await reader.list();
  assert.equal(truncated, false);
  assert.deepEqual(notes, ["knowledge/a.md", "knowledge/big.md", "knowledge/sub/b.md"]);
  assert.deepEqual((await reader.list("knowledge/sub")).notes, ["knowledge/sub/b.md"]);
  await assert.rejects(reader.list("Private"), VaultAccessError);
  await assert.rejects(reader.list("../outside"), VaultAccessError);
});

test("list does not follow a symlinked/junctioned start folder", async (t) => {
  const toPrivate = join(root, "via-private");
  const toOutside = join(root, "via-outside");
  const a = trySymlink(join(root, "Private"), toPrivate, "junction");
  const b = trySymlink(outside, toOutside, "junction");
  if (!a && !b) {
    t.skip("symlinks/junctions not available");
    return;
  }
  const r = new VaultReader({ root, allow: ["via-private/**", "via-outside/**"] });
  assert.deepEqual((await r.list()).notes, []);
  if (a) await assert.rejects(r.read("via-private/secret.md"), VaultAccessError);
  if (b) await assert.rejects(r.read("via-outside/x.md"), VaultAccessError);
});
