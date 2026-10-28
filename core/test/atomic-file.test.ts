import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  QUARANTINE_KEEP,
  readJsonOrQuarantine,
  writeFileAtomic,
  type AtomicFs,
  type QuarantineInfo,
} from "../src/atomic-file.js";

const root = mkdtempSync(join(tmpdir(), "shadow-atomic-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function freshDir(): string {
  const d = join(root, `case-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
}

const NO_DELAY = [0, 0, 0];

/** Real fs with per-method overrides. */
function fsWith(overrides: Partial<AtomicFs>): AtomicFs {
  return {
    mkdir: (p, o) => nodeFs.mkdir(p, o),
    open: (p, f, m) => nodeFs.open(p, f, m),
    rename: (a, b) => nodeFs.rename(a, b),
    unlink: (p) => nodeFs.unlink(p),
    readFile: (p, e) => nodeFs.readFile(p, e),
    readdir: (p) => nodeFs.readdir(p),
    ...overrides,
  };
}

function codeError(code: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

const isObj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

test("writeFileAtomic creates the parent directory and writes the content", async () => {
  const dir = freshDir();
  const file = join(dir, "sub", "a.json");
  await writeFileAtomic(file, '{"x":1}');
  assert.equal(readFileSync(file, "utf8"), '{"x":1}');
  assert.deepEqual(readdirSync(join(dir, "sub")), ["a.json"], "no temp file left behind");
});

test("writeFileAtomic replaces an existing file and accepts bytes", async () => {
  const dir = freshDir();
  const file = join(dir, "a.json");
  writeFileSync(file, "old");
  await writeFileAtomic(file, new TextEncoder().encode("new"));
  assert.equal(readFileSync(file, "utf8"), "new");
  assert.deepEqual(readdirSync(dir), ["a.json"]);
});

test("crash between write and rename: old file intact, temp removed, error rethrown", async () => {
  const dir = freshDir();
  const file = join(dir, "a.json");
  writeFileSync(file, "old");
  let tmpSeen: string | undefined;
  const fs = fsWith({
    rename: async (from) => {
      tmpSeen = from;
      // The temp file is complete at this point.
      assert.equal(readFileSync(from, "utf8"), "new");
      throw codeError("EIO");
    },
  });
  await assert.rejects(writeFileAtomic(file, "new", { fs, retryDelaysMs: NO_DELAY }), /EIO/);
  assert.equal(readFileSync(file, "utf8"), "old");
  assert.ok(tmpSeen?.startsWith(`${file}.tmp-${process.pid}-`), "temp name pattern");
  assert.deepEqual(readdirSync(dir), ["a.json"]);
});

test("a stale temp file from an earlier crash does not affect reads", async () => {
  const dir = freshDir();
  const file = join(dir, "a.json");
  writeFileSync(file, '{"v":1}');
  writeFileSync(`${file}.tmp-999-deadbeef`, '{"v":2'); // half-written temp of a crashed process
  const v = await readJsonOrQuarantine(file, isObj);
  assert.deepEqual(v, { v: 1 });
});

test("failure while writing the temp file: old file intact, temp removed", async () => {
  const dir = freshDir();
  const file = join(dir, "a.json");
  writeFileSync(file, "old");
  const fs = fsWith({
    open: async (p, f, m) => {
      const h = await nodeFs.open(p, f, m);
      return {
        writeFile: async () => {
          throw codeError("ENOSPC");
        },
        sync: () => h.sync(),
        close: () => h.close(),
      };
    },
  });
  await assert.rejects(writeFileAtomic(file, "new", { fs }), /ENOSPC/);
  assert.equal(readFileSync(file, "utf8"), "old");
  assert.deepEqual(readdirSync(dir), ["a.json"]);
});

test("rename retried on EPERM/EBUSY/EACCES, then succeeds", async () => {
  const dir = freshDir();
  const file = join(dir, "a.json");
  writeFileSync(file, "old");
  const codes = ["EPERM", "EBUSY", "EACCES"];
  let calls = 0;
  const fs = fsWith({
    rename: async (a, b) => {
      calls++;
      const code = codes.shift();
      if (code) throw codeError(code);
      await nodeFs.rename(a, b);
    },
  });
  await writeFileAtomic(file, "new", { fs, retryDelaysMs: NO_DELAY });
  assert.equal(calls, 4);
  assert.equal(readFileSync(file, "utf8"), "new");
  assert.deepEqual(readdirSync(dir), ["a.json"]);
});

test("rename gives up after 3 retries; old file intact", async () => {
  const dir = freshDir();
  const file = join(dir, "a.json");
  writeFileSync(file, "old");
  let calls = 0;
  const fs = fsWith({
    rename: async () => {
      calls++;
      throw codeError("EPERM");
    },
  });
  await assert.rejects(writeFileAtomic(file, "new", { fs, retryDelaysMs: NO_DELAY }), /EPERM/);
  assert.equal(calls, 4, "1 attempt + 3 retries");
  assert.equal(readFileSync(file, "utf8"), "old");
  assert.deepEqual(readdirSync(dir), ["a.json"]);
});

test("rename is not retried on other errors", async () => {
  const dir = freshDir();
  const file = join(dir, "a.json");
  let calls = 0;
  const fs = fsWith({
    rename: async () => {
      calls++;
      throw codeError("EXDEV");
    },
  });
  await assert.rejects(writeFileAtomic(file, "new", { fs, retryDelaysMs: NO_DELAY }), /EXDEV/);
  assert.equal(calls, 1);
});

test("readJsonOrQuarantine: missing file → undefined, nothing created", async () => {
  const dir = freshDir();
  let called = false;
  const v = await readJsonOrQuarantine(join(dir, "none.json"), isObj, { onQuarantine: () => (called = true) });
  assert.equal(v, undefined);
  assert.equal(called, false);
  assert.deepEqual(readdirSync(dir), []);
});

test("readJsonOrQuarantine: valid file returns the validated value; a BOM is accepted", async () => {
  const dir = freshDir();
  const file = join(dir, "a.json");
  writeFileSync(file, '﻿{"a":2}');
  assert.deepEqual(await readJsonOrQuarantine(file, isObj), { a: 2 });
  assert.ok(existsSync(file));
});

test("readJsonOrQuarantine: invalid JSON is quarantined without its content in the report", async () => {
  const dir = freshDir();
  const file = join(dir, "a.json");
  writeFileSync(file, '{"secret":"hunter2"');
  const infos: QuarantineInfo[] = [];
  const v = await readJsonOrQuarantine(file, isObj, { now: () => 1000, onQuarantine: (i) => infos.push(i) });
  assert.equal(v, undefined);
  assert.equal(existsSync(file), false);
  assert.equal(readFileSync(`${file}.corrupt-1000`, "utf8"), '{"secret":"hunter2"');
  assert.equal(infos.length, 1);
  assert.equal(infos[0]!.reason, "invalid_json");
  assert.equal(infos[0]!.movedTo, `${file}.corrupt-1000`);
  assert.ok(!JSON.stringify(infos).includes("hunter2"));
});

test("readJsonOrQuarantine: wrong shape (validate → undefined or throws) is quarantined", async () => {
  const dir = freshDir();
  const file = join(dir, "a.json");
  writeFileSync(file, "[1,2]");
  const infos: QuarantineInfo[] = [];
  assert.equal(await readJsonOrQuarantine(file, isObj, { now: () => 5, onQuarantine: (i) => infos.push(i) }), undefined);
  assert.equal(infos[0]!.reason, "invalid_shape");
  writeFileSync(file, "{}");
  const thrower = () => {
    throw new Error("bad");
  };
  assert.equal(await readJsonOrQuarantine(file, thrower, { now: () => 6, onQuarantine: (i) => infos.push(i) }), undefined);
  assert.equal(infos[1]!.reason, "invalid_shape");
  assert.deepEqual(readdirSync(dir).sort(), ["a.json.corrupt-5", "a.json.corrupt-6"]);
});

test("an empty file counts as corrupt", async () => {
  const dir = freshDir();
  const file = join(dir, "a.json");
  writeFileSync(file, "");
  assert.equal(await readJsonOrQuarantine(file, isObj, { now: () => 7 }), undefined);
  assert.deepEqual(readdirSync(dir), ["a.json.corrupt-7"]);
});

test("only the newest 3 quarantined copies are kept; other files untouched", async () => {
  const dir = freshDir();
  const file = join(dir, "a.json");
  writeFileSync(join(dir, "b.json.corrupt-1"), "x"); // another file's copy
  writeFileSync(join(dir, "a.json.corrupt-notes"), "x"); // not a timestamp suffix
  for (const ts of [100, 200, 300, 400, 50]) {
    writeFileSync(file, "not json");
    await readJsonOrQuarantine(file, isObj, { now: () => ts });
  }
  const copies = readdirSync(dir).filter((f) => /^a\.json\.corrupt-\d+$/.test(f)).sort();
  assert.equal(copies.length, QUARANTINE_KEEP);
  assert.deepEqual(copies, ["a.json.corrupt-200", "a.json.corrupt-300", "a.json.corrupt-400"]);
  assert.ok(existsSync(join(dir, "b.json.corrupt-1")));
  assert.ok(existsSync(join(dir, "a.json.corrupt-notes")));
});

test("quarantine rename retried on EBUSY; a failed rename is reported and the read still returns undefined", async () => {
  const dir = freshDir();
  const file = join(dir, "a.json");
  writeFileSync(file, "garbage");
  let busy = 1;
  const fs1 = fsWith({
    rename: async (a, b) => {
      if (busy-- > 0) throw codeError("EBUSY");
      await nodeFs.rename(a, b);
    },
  });
  const infos: QuarantineInfo[] = [];
  await readJsonOrQuarantine(file, isObj, { fs: fs1, now: () => 9, retryDelaysMs: NO_DELAY, onQuarantine: (i) => infos.push(i) });
  assert.equal(infos[0]!.movedTo, `${file}.corrupt-9`);

  writeFileSync(file, "garbage");
  const fs2 = fsWith({ rename: async () => Promise.reject(codeError("EPERM")) });
  const v = await readJsonOrQuarantine(file, isObj, { fs: fs2, retryDelaysMs: NO_DELAY, onQuarantine: (i) => infos.push(i) });
  assert.equal(v, undefined);
  assert.equal(infos[1]!.movedTo, undefined);
  assert.equal(infos[1]!.renameError, "EPERM");
});

test("read errors other than ENOENT are thrown, the file is not moved", async () => {
  const dir = freshDir();
  const file = join(dir, "a.json");
  writeFileSync(file, "{}");
  const fs = fsWith({ readFile: async () => Promise.reject(codeError("EACCES")) });
  await assert.rejects(readJsonOrQuarantine(file, isObj, { fs }), /EACCES/);
  assert.ok(existsSync(file));
});

test("concurrent atomic writes to one file never leave a torn file", async () => {
  const dir = freshDir();
  const file = join(dir, "a.json");
  const values = Array.from({ length: 20 }, (_, i) => JSON.stringify({ i, pad: "x".repeat(5000) }));
  // Windows may report EPERM when two renames target one file at the same time;
  // retries absorb that. Callers serialize writes anyway (continuity, memory).
  await Promise.allSettled(values.map((v) => writeFileAtomic(file, v, { retryDelaysMs: [5, 10, 20, 40, 80] })));
  const final = readFileSync(file, "utf8");
  assert.ok(values.includes(final), "content is one complete write");
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.includes(".tmp-")),
    [],
    "no temp files left",
  );
});

test("a quarantine waiting to retry never moves a valid file written meanwhile", async () => {
  const dir = freshDir();
  const file = join(dir, "a.json");
  writeFileSync(file, "garbage");
  let writer: Promise<void> | undefined;
  let writerDone = false;
  let first = true;
  const fs = fsWith({
    rename: async (a, b) => {
      if (first && a === file) {
        first = false;
        // While the quarantine rename is busy, another caller writes a valid file.
        writer = writeFileAtomic(file, '{"fresh":true}', { retryDelaysMs: NO_DELAY }).then(() => {
          writerDone = true;
        });
        // Give an unlocked writer every chance to finish before the retry.
        for (let i = 0; i < 20 && !writerDone; i++) await new Promise((r) => setTimeout(r, 5));
        throw codeError("EBUSY");
      }
      await nodeFs.rename(a, b);
    },
  });
  const infos: QuarantineInfo[] = [];
  const v = await readJsonOrQuarantine(file, isObj, { fs, now: () => 7, retryDelaysMs: NO_DELAY, onQuarantine: (i) => infos.push(i) });
  assert.equal(v, undefined);
  assert.equal(writerDone, false, "the write waited for the quarantine");
  await writer;
  assert.equal(readFileSync(file, "utf8"), '{"fresh":true}', "the new file stays in place");
  assert.equal(readFileSync(`${file}.corrupt-7`, "utf8"), "garbage", "only the invalid file was quarantined");
  assert.equal(infos[0]!.movedTo, `${file}.corrupt-7`);
});

test("reads wait for a write to the same path and see the new content", async () => {
  const dir = freshDir();
  const file = join(dir, "a.json");
  writeFileSync(file, '{"v":1}');
  const w = writeFileAtomic(file, '{"v":2}');
  const r = readJsonOrQuarantine(file, isObj);
  await w;
  assert.deepEqual(await r, { v: 2 });
});
