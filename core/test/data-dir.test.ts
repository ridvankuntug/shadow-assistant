/**
 * T20.3: the data folder rule (`resolveDataDir`, docs/05 "Data folder") that
 * deploy/backup/backup-common.ps1 mirrors. These pin the Core's behaviour so
 * that existing installs keep their folder; the script side is checked by hand
 * (no PowerShell test runner in the repo).
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { after, test } from "node:test";
import { loadConfig, REPO_ROOT, resolveDataDir } from "../src/config.js";

const base = mkdtempSync(join(tmpdir(), "shadow-data-dir-test-"));
after(() => rmSync(base, { recursive: true, force: true }));

const repo = join(base, "repo");
const vault = join(repo, "vault");
const elsewhere = join(base, "elsewhere");
mkdirSync(vault, { recursive: true });
mkdirSync(join(elsewhere, "vault"), { recursive: true });

test("SHADOW_DATA_DIR absolute: used as written (trimmed), also with a trailing separator", () => {
  const abs = join(base, "data");
  assert.deepEqual(resolveDataDir({ SHADOW_DATA_DIR: abs }, repo, elsewhere), { vaultDir: undefined, dataDir: abs, dataDirSource: "SHADOW_DATA_DIR" });
  assert.equal(resolveDataDir({ SHADOW_DATA_DIR: `  ${abs}  ` }, repo, elsewhere).dataDir, abs);
  assert.equal(resolveDataDir({ SHADOW_DATA_DIR: abs + sep }, repo, elsewhere).dataDir, abs + sep);
});

test("SHADOW_DATA_DIR relative: against the repo root, not the working directory; wins over the vault", () => {
  const r = resolveDataDir({ SHADOW_DATA_DIR: "data", SHADOW_VAULT_DIR: vault }, repo, elsewhere);
  assert.equal(r.dataDir, join(repo, "data"));
  assert.equal(r.dataDirSource, "SHADOW_DATA_DIR");
  assert.equal(r.vaultDir, vault);
  assert.equal(r.dataDirWarning, undefined);
});

test("no expansion: ~ and %VAR% are relative paths under the repo root", () => {
  assert.equal(resolveDataDir({ SHADOW_DATA_DIR: "~/data" }, repo, repo).dataDir, resolve(repo, "~/data"));
  assert.equal(resolveDataDir({ SHADOW_DATA_DIR: "%USERPROFILE%/data" }, repo, repo).dataDir, resolve(repo, "%USERPROFILE%/data"));
});

test("blank SHADOW_DATA_DIR: next step (vault, else the repo default)", () => {
  const r = resolveDataDir({ SHADOW_DATA_DIR: "   ", SHADOW_VAULT_DIR: vault }, repo, repo);
  assert.deepEqual(r, { vaultDir: vault, dataDir: join(vault, ".shadow-assistant"), dataDirSource: "SHADOW_VAULT_DIR" });
  assert.deepEqual(resolveDataDir({ SHADOW_DATA_DIR: "" }, repo, repo), {
    vaultDir: undefined,
    dataDir: join(repo, ".shadow-assistant"),
    dataDirSource: "default",
  });
});

test("SHADOW_VAULT_DIR that is not an existing folder: the repo default", () => {
  const file = join(base, "a-file");
  writeFileSync(file, "x");
  for (const v of [join(base, "missing"), file]) {
    const r = resolveDataDir({ SHADOW_VAULT_DIR: v }, repo, repo);
    assert.equal(r.dataDir, join(repo, ".shadow-assistant"));
    assert.equal(r.dataDirSource, "default");
    assert.equal(r.vaultDir, undefined);
  }
});

test("nothing set: <repo>/.shadow-assistant", () => {
  assert.deepEqual(resolveDataDir({}, repo, repo), { vaultDir: undefined, dataDir: join(repo, ".shadow-assistant"), dataDirSource: "default" });
});

test("relative SHADOW_VAULT_DIR: against the working directory; warns when that is not the repo root", () => {
  const atRoot = resolveDataDir({ SHADOW_VAULT_DIR: "vault" }, repo, repo);
  assert.equal(atRoot.dataDir, join(vault, ".shadow-assistant"));
  assert.equal(atRoot.dataDirWarning, undefined);
  // The same root written differently (trailing separator) is still the repo root.
  assert.equal(resolveDataDir({ SHADOW_VAULT_DIR: "vault" }, repo + sep, repo).dataDirWarning, undefined);

  const away = resolveDataDir({ SHADOW_VAULT_DIR: "vault" }, repo, elsewhere);
  assert.equal(away.dataDir, join(elsewhere, "vault", ".shadow-assistant"));
  assert.match(away.dataDirWarning ?? "", /SHADOW_VAULT_DIR is a relative path/);
  // Also when the relative vault does not exist from there (the Core falls back to the default).
  assert.ok(resolveDataDir({ SHADOW_VAULT_DIR: "nope" }, repo, elsewhere).dataDirWarning);
  // No warning for an absolute vault or when SHADOW_DATA_DIR decides.
  assert.equal(resolveDataDir({ SHADOW_VAULT_DIR: vault }, repo, elsewhere).dataDirWarning, undefined);
  assert.equal(resolveDataDir({ SHADOW_VAULT_DIR: "vault", SHADOW_DATA_DIR: "d" }, repo, elsewhere).dataDirWarning, undefined);
});

test("without a cwd argument the vault path resolves as before T20.3 (resolve(value), the process working directory)", () => {
  const rel = relative(process.cwd(), vault);
  const r = resolveDataDir({ SHADOW_VAULT_DIR: rel }, repo);
  assert.equal(r.vaultDir, resolve(rel));
  assert.equal(r.dataDir, join(vault, ".shadow-assistant"));
});

test("Windows: drive-relative and root-relative values warn (their folder depends on the process)", { skip: process.platform !== "win32" }, () => {
  const drive = repo.slice(0, 2); // e.g. C:
  const B = String.fromCharCode(92);
  assert.match(resolveDataDir({ SHADOW_DATA_DIR: `${drive}data` }, repo, repo).dataDirWarning ?? "", /SHADOW_DATA_DIR is a drive-relative or root-relative path/);
  assert.match(resolveDataDir({ SHADOW_DATA_DIR: `${B}data` }, repo, repo).dataDirWarning ?? "", /SHADOW_DATA_DIR/);
  assert.match(resolveDataDir({ SHADOW_VAULT_DIR: `${B}vault` }, repo, repo).dataDirWarning ?? "", /SHADOW_VAULT_DIR is a drive-relative/);
  // Absolute, UNC and plain relative values do not.
  for (const v of [join(base, "data"), `${B}${B}server${B}share${B}data`, "data"]) {
    assert.equal(resolveDataDir({ SHADOW_DATA_DIR: v }, repo, repo).dataDirWarning, undefined, v);
  }
});

test("loadConfig: same folder as before (data dir, vault dir, source) for the default and an explicit value", () => {
  const services = join(base, "services.yaml");
  writeFileSync(services, "services: []\n");
  const env = (extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ SHADOW_SERVICES_FILE: services, CORE_ROUTER: "off", ...extra });
  const def = loadConfig(env({}));
  assert.equal(def.dataDir, join(REPO_ROOT, ".shadow-assistant"));
  assert.equal(def.dataDirSource, "default");
  const abs = join(base, "data");
  const explicit = loadConfig(env({ SHADOW_DATA_DIR: abs, SHADOW_VAULT_DIR: vault }));
  assert.equal(explicit.dataDir, abs);
  assert.equal(explicit.vaultDir, vault);
  assert.equal(explicit.dataDirSource, "SHADOW_DATA_DIR");
  assert.equal(explicit.dataDirWarning, undefined);
  const fromVault = loadConfig(env({ SHADOW_VAULT_DIR: vault }));
  assert.equal(fromVault.dataDir, join(vault, ".shadow-assistant"));
  assert.equal(fromVault.dataDirSource, "SHADOW_VAULT_DIR");
});
