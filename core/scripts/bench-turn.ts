/**
 * Turn latency bench (docs/07-speed.md §Measurement).
 *
 *   BENCH_TOKEN=<DEVICE_TOKEN_BENCH value> npm run bench   (in core/)
 *
 * Connects to the Core's /ws as one device and sends `user_text` turns one after
 * another. Per turn, measured on this client from sending `user_text`:
 *   - t_first:  first `assistant_delta`
 *   - t_done:   `assistant_done`
 *   - t_speech: first `speech_chunk` (Core with the `speech_stream` feature, after
 *               `speech_prefs` audio), else `speech` after its own `speak`
 *               sent at `assistant_done` (the pre-A2 client behaviour).
 * Prints p50/p95 per scenario and writes a JSON result (timings only, no
 * answer text) to BENCH_OUT_DIR or <SHADOW_DATA_DIR>/bench/.
 *
 * Environment (the repo-root .env is loaded; real environment variables win):
 *   BENCH_TOKEN        device token (default: DEVICE_TOKEN_BENCH)
 *   BENCH_URL          ws URL (default ws://127.0.0.1:<CORE_PORT|8700>/ws)
 *   BENCH_SCENARIOS    comma list of 1-4 (default 1,2,3)
 *   BENCH_RUNS         runs per scenario (default 10; scenarios 3-4 default 5)
 *   BENCH_SPEECH       off: do not measure t_speech
 *   BENCH_OUT_DIR      where the JSON result goes
 *
 * Scenario 4 (first turn after a Core restart) cannot restart the Core itself:
 * before each run it waits until /health has gone down and come back up, so
 * restart the Core by hand (or from a script) when it says so.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import WebSocket from "ws";
import { loadConfig, loadDotEnv } from "../src/config.js";

const TEXT_SIMPLE = "Merhaba, bugün nasılsın?";
const TEXT_HA_READ = "Oturma odasındaki ışık açık mı?";
const TURN_TIMEOUT_MS = 120_000;
const RESTART_WAIT_MS = 5 * 60_000;

interface Scenario {
  n: 1 | 2 | 3 | 4;
  name: string;
  text: string;
  /** New connection before every run (3) or a Core restart before every run (4). */
  fresh: "none" | "reconnect" | "restart";
}

const SCENARIOS: Record<number, Scenario> = {
  1: { n: 1, name: "simple text, warm", text: TEXT_SIMPLE, fresh: "none" },
  2: { n: 2, name: "HA read via model, warm", text: TEXT_HA_READ, fresh: "none" },
  3: { n: 3, name: "first turn after hello", text: TEXT_SIMPLE, fresh: "reconnect" },
  4: { n: 4, name: "first turn after a Core restart", text: TEXT_SIMPLE, fresh: "restart" },
};

interface TurnTiming {
  scenario: number;
  run: number;
  tFirst?: number;
  tDone?: number;
  tSpeech?: number;
  answerChars?: number;
  /** Turn-ending error (or timeout); the run counts as failed. */
  error?: string;
  /** `tts_unavailable` during streamed speech: the text turn goes on, only speech failed. */
  ttsError?: string;
}

/** Errors that do not end the turn (speech_stream: a `final` chunk follows, then `assistant_done`). */
const isTtsError = (f: Frame) => f.type === "error" && f.code === "tts_unavailable";

type Frame = { type: string; id?: string; [k: string]: unknown };

/** One authenticated socket with a frame waiter. */
class Conn {
  private waiters: { match: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  private listeners: ((f: Frame) => void)[] = [];
  features: string[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on("message", (raw) => {
      let f: Frame;
      try {
        f = JSON.parse(String(raw)) as Frame;
      } catch {
        return;
      }
      for (const l of this.listeners) l(f);
      this.waiters = this.waiters.filter((w) => {
        if (!w.match(f)) return true;
        w.resolve(f);
        return false;
      });
    });
  }

  static async open(url: string, token: string): Promise<Conn> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const c = new Conn(ws);
    const welcome = c.next((f) => f.type === "welcome" || f.type === "error", 15_000);
    c.send({ type: "hello", protocol: 1, token, client: "bench", clientVersion: "1" });
    const w = await welcome;
    if (w.type !== "welcome") throw new Error(`hello rejected: ${String(w.code)}`);
    c.features = Array.isArray(w.features) ? (w.features as string[]) : [];
    return c;
  }

  send(frame: Record<string, unknown>): void {
    this.ws.send(JSON.stringify(frame));
  }

  on(l: (f: Frame) => void): () => void {
    this.listeners.push(l);
    return () => (this.listeners = this.listeners.filter((x) => x !== l));
  }

  next(match: (f: Frame) => boolean, timeoutMs: number): Promise<Frame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.resolve !== done);
        reject(new Error("timeout"));
      }, timeoutMs);
      const done = (f: Frame) => {
        clearTimeout(timer);
        resolve(f);
      };
      this.waiters.push({ match, resolve: done });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      this.ws.once("close", () => resolve());
      this.ws.close();
    });
  }
}

let idSeq = 0;
const newId = () => `bench-${Date.now().toString(36)}-${++idSeq}`;

/** One turn: send, time the frames, wait for `state: idle` before returning. */
async function runTurn(c: Conn, s: Scenario, run: number, speech: boolean): Promise<TurnTiming> {
  const id = newId();
  const t: TurnTiming = { scenario: s.n, run };
  const streamSpeech = speech && c.features.includes("speech_stream");
  let t0 = 0;
  // Frames can arrive in one burst (assistant_done + state idle), so idle is caught by the listener.
  let sawBusy = false;
  let markIdle: () => void = () => {};
  const idle = new Promise<void>((r) => (markIdle = r));
  const off = c.on((f) => {
    const now = performance.now() - t0;
    if (f.type === "state") {
      if (f.state !== "idle") sawBusy = true;
      else if (sawBusy) markIdle();
    }
    if (f.id === id && f.type === "assistant_delta" && t.tFirst === undefined) t.tFirst = now;
    if (f.id === id && f.type === "speech_chunk" && t.tSpeech === undefined) t.tSpeech = now;
    if (f.id === id && f.type === "error") {
      if (isTtsError(f)) t.ttsError ??= String(f.code);
      else t.error ??= String(f.code);
    }
  });
  const done = c.next((f) => f.id === id && f.type === "assistant_done", TURN_TIMEOUT_MS).catch(() => undefined);
  const failed = c.next((f) => f.id === id && f.type === "error" && !isTtsError(f), TURN_TIMEOUT_MS).catch(() => undefined);
  t0 = performance.now();
  c.send({ type: "user_text", id, text: s.text });
  const end = await Promise.race([done, failed]);
  if (end?.type === "assistant_done") {
    t.tDone = performance.now() - t0;
    const text = String(end.text ?? "");
    t.answerChars = text.length;
    if (speech && !streamSpeech && text.trim() !== "") {
      // Pre-A2 client: speak the whole answer after assistant_done.
      const sid = `${id}-s`;
      const got = c.next((f) => f.id === sid && (f.type === "speech" || f.type === "error"), 60_000).catch(() => undefined);
      c.send({ type: "speak", id: sid, text });
      const sp = await got;
      if (sp?.type === "speech") t.tSpeech = performance.now() - t0;
      // The text turn is done; only speech failed.
      else t.ttsError ??= sp ? `speak:${String(sp.code)}` : "speak:timeout";
    }
  } else if (!end) {
    t.error ??= "timeout";
  }
  if (streamSpeech && t.tSpeech === undefined && !t.error) {
    await c.next((f) => f.id === id && f.type === "speech_chunk" && f.final === true, 30_000).catch(() => undefined);
  }
  await Promise.race([idle, new Promise((r) => setTimeout(r, 15_000))]);
  off();
  return t;
}

async function health(httpBase: string): Promise<boolean> {
  try {
    const res = await fetch(`${httpBase}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Waits until the Core went down and came back (scenario 4). */
async function waitForRestart(httpBase: string): Promise<void> {
  const deadline = Date.now() + RESTART_WAIT_MS;
  console.log("  restart the Core now (waiting for /health to go down and up)…");
  while ((await health(httpBase)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  while (!(await health(httpBase)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  if (Date.now() >= deadline) throw new Error("the Core did not restart in time");
}

function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  // Nearest rank: the smallest value with at least p% of the samples at or below it.
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

function stats(values: (number | undefined)[]): { n: number; p50?: number; p95?: number } {
  const v = values.filter((x): x is number => x !== undefined).map((x) => Math.round(x));
  return { n: v.length, p50: percentile(v, 50), p95: percentile(v, 95) };
}

const fmt = (ms: number | undefined) => (ms === undefined ? "–" : `${(ms / 1000).toFixed(2)} s`);

async function main(): Promise<void> {
  loadDotEnv();
  const token = process.env.BENCH_TOKEN || process.env.DEVICE_TOKEN_BENCH;
  if (!token) throw new Error("set BENCH_TOKEN (or DEVICE_TOKEN_BENCH)");
  const url = process.env.BENCH_URL || `ws://127.0.0.1:${process.env.CORE_PORT || 8700}/ws`;
  const httpBase = url.replace(/^ws/, "http").replace(/\/ws$/, "");
  const wanted = (process.env.BENCH_SCENARIOS || "1,2,3").split(",").map((x) => Number(x.trim()));
  const runsEnv = process.env.BENCH_RUNS ? Number(process.env.BENCH_RUNS) : undefined;
  const speech = !/^(0|off|false|no)$/i.test(process.env.BENCH_SPEECH ?? "");
  const outDir = process.env.BENCH_OUT_DIR || join(loadConfig().dataDir, "bench");

  const timings: TurnTiming[] = [];
  let warm: Conn | undefined;
  let features: string[] = [];
  const startedAt = new Date().toISOString();

  for (const n of wanted) {
    const s = SCENARIOS[n];
    if (!s) throw new Error(`unknown scenario ${n}`);
    const runs = runsEnv ?? (s.fresh === "none" ? 10 : 5);
    console.log(`scenario ${n} (${s.name}): ${runs} runs`);
    for (let run = 1; run <= runs; run++) {
      let c: Conn;
      if (s.fresh === "none") {
        if (!warm) {
          warm = await Conn.open(url, token);
          features = warm.features;
          if (speech && warm.features.includes("speech_stream")) warm.send({ type: "speech_prefs", enabled: true, mode: "audio" });
          const w = await runTurn(warm, SCENARIOS[1]!, 0, speech);
          console.log(`  warm-up: done ${fmt(w.tDone)}${w.error ? ` error=${w.error}` : ""}`);
        }
        c = warm;
      } else {
        if (warm) {
          await warm.close();
          warm = undefined;
        }
        if (s.fresh === "restart") await waitForRestart(httpBase);
        c = await Conn.open(url, token);
        features = c.features;
        if (speech && c.features.includes("speech_stream")) c.send({ type: "speech_prefs", enabled: true, mode: "audio" });
      }
      const t = await runTurn(c, s, run, speech);
      timings.push(t);
      console.log(
        `  run ${run}: first ${fmt(t.tFirst)}  done ${fmt(t.tDone)}  speech ${fmt(t.tSpeech)}${t.error ? `  error=${t.error}` : ""}${t.ttsError ? `  tts=${t.ttsError}` : ""}`,
      );
      if (s.fresh !== "none") await c.close();
    }
  }
  await warm?.close();

  const summary = wanted.map((n) => {
    const rows = timings.filter((t) => t.scenario === n);
    return {
      scenario: n,
      name: SCENARIOS[n]!.name,
      runs: rows.length,
      errors: rows.filter((t) => t.error).length,
      ttsErrors: rows.filter((t) => t.ttsError).length,
      tFirst: stats(rows.map((t) => t.tFirst)),
      tDone: stats(rows.map((t) => t.tDone)),
      tSpeech: stats(rows.map((t) => t.tSpeech)),
    };
  });

  console.log("\nscenario | runs | err | tts err | t_first p50/p95 | t_done p50/p95 | t_speech p50/p95");
  for (const r of summary) {
    console.log(
      `${r.scenario} | ${r.runs} | ${r.errors} | ${r.ttsErrors} | ${fmt(r.tFirst.p50)} / ${fmt(r.tFirst.p95)} | ${fmt(r.tDone.p50)} / ${fmt(r.tDone.p95)} | ${fmt(r.tSpeech.p50)} / ${fmt(r.tSpeech.p95)}`,
    );
  }

  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `bench-${startedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(file, `${JSON.stringify({ startedAt, features, speechMode: speech ? (features.includes("speech_stream") ? "speech_chunk" : "speak") : "off", summary, timings }, null, 2)}\n`);
  console.log(`\nresult: ${file}`);
}

main().then(
  () => process.exit(0),
  (err: Error) => {
    console.error(`bench failed: ${err.message}`);
    process.exit(1);
  },
);
