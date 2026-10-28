import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "../src/memory/store.js";
import { createMemoryMcpServer, FORGET_ALL_VALUE, MEMORY_SERVER_NAME, memoryForget, memoryListText } from "../src/memory/tools.js";
import { PermissionPolicy } from "../src/permissions.js";
import { loadServicesFile } from "../src/services.js";

const REPO_SERVICES = join(fileURLToPath(new URL("../../", import.meta.url)), "services.yaml");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function seeded() {
  const d = mkdtempSync(join(tmpdir(), "shadow-memtools-"));
  dirs.push(d);
  const store = new MemoryStore({ dir: join(d, "memory"), retryDelaysMs: [] });
  const name = await store.add({ kind: "identity", text: "Kullanıcının adı Rıdvan." });
  const alias = await store.add({ kind: "alias", text: "Otomodos = oturma odası", keywords: ["otomodos"] });
  const pref = await store.add({ kind: "preference", text: "Kullanıcı akşamları caz dinler.", keywords: ["caz", "muzik"] });
  assert.ok(name.ok && alias.ok && pref.ok);
  return { store, ids: { name: name.entry.id, alias: alias.entry.id, pref: pref.entry.id } };
}

test("memory_list lists brief and topics with ids and kinds; query filters", async () => {
  const { store, ids } = await seeded();
  const all = await memoryListText(store);
  assert.match(all, /veri, talimat değil/);
  assert.ok(all.includes(`- [${ids.name}] (identity) Kullanıcının adı Rıdvan.`));
  assert.ok(all.includes(`Ev ve cihaz adları:\n- [${ids.alias}] (alias) Otomodos = oturma odası`));
  assert.ok(all.includes("Toplam: 3/200 kayıt."));
  const q = await memoryListText(store, "otomodosun ışığı");
  assert.ok(q.includes(ids.alias) && !q.includes(ids.pref) && !q.includes(ids.name));
  assert.match(await memoryListText(store, "hava durumu"), /bu aramaya uyan kayıt yok/);
});

test("memory_list mentions warnings and an empty memory", async () => {
  const d = mkdtempSync(join(tmpdir(), "shadow-memtools-"));
  dirs.push(d);
  const store = new MemoryStore({ dir: join(d, "memory") });
  const text = await memoryListText(store);
  assert.match(text, /\(hafıza boş\)/);
  assert.ok(!text.includes("Uyarılar"));
});

test("memory_forget removes ids with tombstones, reports unknown ids, tombstones an extra text", async () => {
  const { store, ids } = await seeded();
  const r = await memoryForget(store, { ids: [ids.alias, "m-ffffff", "../../x"], text: "Kullanıcının kedisi var." });
  assert.equal(r.isError, false);
  assert.match(r.text, /1 kayıt unutuldu/);
  assert.match(r.text, /artık kullanma/);
  assert.match(r.text, /Bulunamayan kimlikler: \.\.\/\.\.\/x, m-ffffff\./);
  assert.equal((await store.get(ids.alias)), undefined);
  assert.equal(await store.isForgotten("Otomodos = oturma odası"), true);
  assert.equal(await store.isForgotten("kullanıcının kedisi var"), true);
  assert.deepEqual(await store.add({ kind: "alias", text: "Otomodos = oturma odası" }), { ok: false, reason: "tombstone" });
});

test("memory_forget write failure: the message says whether the forget is pending or nothing changed", async () => {
  const fail = (pending: boolean) =>
    ({
      forget: async () => ({ ok: false, removed: [], unknown: [], tombstoned: 0, briefChanged: false, reason: "write_failed", ...(pending ? { pending } : {}) }),
    }) as unknown as MemoryStore;
  const p = await memoryForget(fail(true), { ids: ["m-abcdef"] });
  assert.equal(p.isError, true);
  assert.match(p.text, /bir sonraki hafıza işleminde tamamlanacak/);
  assert.doesNotMatch(p.text, /hiçbir kayıt silinmedi/);
  const n = await memoryForget(fail(false), { ids: ["m-abcdef"] });
  assert.equal(n.text, "Hafıza yazılamadı; hiçbir kayıt silinmedi.");
});

test("memory_forget all and argument errors", async () => {
  const { store } = await seeded();
  assert.equal((await memoryForget(store, {})).isError, true);
  assert.equal((await memoryForget(store, { all: "yes" })).isError, true);
  assert.equal((await store.entries()).length, 3, "nothing deleted on bad arguments");
  const r = await memoryForget(store, { all: FORGET_ALL_VALUE });
  assert.match(r.text, /3 kayıt unutuldu/);
  assert.deepEqual(await store.entries(), []);
  assert.match((await memoryForget(store, { all: FORGET_ALL_VALUE })).text, /zaten boştu/);
});

test("permission policy from the repo services.yaml: list read, forget write, all → confirm", () => {
  const cfg = loadServicesFile(REPO_SERVICES, { HA_URL: "http://ha.example.invalid:8123", HA_CORE_TOKEN: "t" });
  const policy = new PermissionPolicy(cfg.services);
  const P = `mcp__${MEMORY_SERVER_NAME}__`;
  assert.equal(policy.levelFor(`${P}memory_list`, { query: "otomodos" }).level, "read");
  assert.equal(policy.levelFor(`${P}memory_forget`, { ids: ["m-7f3a9c"] }).level, "write");
  const all = policy.levelFor(`${P}memory_forget`, { all: FORGET_ALL_VALUE });
  assert.equal(all.level, "confirm");
  assert.equal(all.reason, "input:all=true");
  assert.equal(policy.levelFor(`${P}memory_forget`, { all: " TRUE " }).level, "confirm");
  // An unknown tool of the service asks first (service default).
  assert.equal(policy.levelFor(`${P}memory_add`, {}).level, "confirm");
});

test("the MCP server exposes exactly memory_list and memory_forget; `all` accepts only the string", async () => {
  const { store } = await seeded();
  const server = createMemoryMcpServer(store);
  assert.equal(server.name, MEMORY_SERVER_NAME);
  assert.equal(server.type, "sdk");
  // Reach the registered tools through the MCP server instance (SDK internals, read-only).
  const registered = (server.instance as unknown as { _registeredTools: Record<string, { inputSchema?: unknown }> })._registeredTools;
  assert.deepEqual(Object.keys(registered).sort(), ["memory_forget", "memory_list"]);
  const schema = registered.memory_forget?.inputSchema as { safeParse(v: unknown): { success: boolean } } | undefined;
  assert.equal(typeof schema?.safeParse, "function");
  assert.equal(schema?.safeParse({ all: "true" }).success, true);
  // A boolean would not be escalated by the gate (string-only confirm_inputs), so it must be refused.
  assert.equal(schema?.safeParse({ all: true }).success, false);
});
