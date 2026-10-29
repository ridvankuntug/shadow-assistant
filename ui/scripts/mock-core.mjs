// Dev-only mock of the Shadow Core WebSocket protocol v1 (docs/02-core-protocol.md).
// Not used in production.
//
// Usage (from ui/):
//   node scripts/mock-core.mjs
//   MOCK_PORT=8700 MOCK_HOST=127.0.0.1 MOCK_TOKEN=dev-token node scripts/mock-core.mjs
// Optional env: MOCK_TRANSCRIPT (fixed STT text), MOCK_CONFIRM_MS (default 60000),
//               MOCK_TTS_FAIL=1 (speak and voices always fail with tts_unavailable),
//               MOCK_SERVICES_DOWN=whisper-svc,home-assistant (reported `down`, detail `unreachable`),
//               MOCK_SERVICES_LOADING=whisper-svc (reported `loading`),
//               MOCK_SERVICES_FLAP_MS=10000 (the DOWN list toggles down <-> ok every N ms and is broadcast),
//               MOCK_STT_IDLE=1 (whisper-svc reported `ok` with detail `idle`),
//               MOCK_SPEECH_STREAM=0 (behave like an older Core: no `features`, no speech_chunk),
//               MOCK_MEMORY=0 (no `memory` feature; memory_list/memory_delete get bad_request),
//               MOCK_MEMORY_SILENT=1 (memory frames are never answered, to see the UI timeout).
// With speech_stream (default) a client that sent speech_prefs gets one speech_chunk per
// sentence while the answer streams (a sine tone in audio mode, the sentence in text mode).
// A message containing "limit" is answered with `error usage_limit` (retryAt in 2 hours).
import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.MOCK_PORT ?? 8700);
const HOST = process.env.MOCK_HOST ?? "127.0.0.1";
const TOKEN = process.env.MOCK_TOKEN ?? "dev-token";
const CONFIRM_MS = Number(process.env.MOCK_CONFIRM_MS ?? 60000);
const AUTH_TIMEOUT_MS = 5000;
const SPEECH_STREAM = process.env.MOCK_SPEECH_STREAM !== "0";
const MEMORY = process.env.MOCK_MEMORY !== "0";
// Like the real Core: service tool names without the Agent SDK's mcp__<service>__ prefix.
const LOCK_TOOL = "intent__HassTurnOff";

// Shared across connections.
const history = [];
/** Senders of authenticated sockets, for `services` broadcasts. */
const authedSockets = new Set();

// ------------------------------------------------------------ service health
// Same names as services.yaml; statuses from env (see the header).
const envList = (v) => (v ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const SERVICES_DOWN = new Set(envList(process.env.MOCK_SERVICES_DOWN));
const SERVICES_LOADING = new Set(envList(process.env.MOCK_SERVICES_LOADING));
const SERVICE_NAMES = ["home-assistant", "shadow-vault", "whisper-svc", "tts-svc"];
for (const n of [...SERVICES_DOWN, ...SERVICES_LOADING]) if (!SERVICE_NAMES.includes(n)) SERVICE_NAMES.push(n);
let servicesDownNow = true;

function serviceItems() {
  const checkedAt = Date.now();
  return SERVICE_NAMES.map((name) => {
    if (SERVICES_DOWN.has(name) && servicesDownNow) return { name, status: "down", checkedAt, detail: "unreachable" };
    if (SERVICES_LOADING.has(name)) return { name, status: "loading", checkedAt };
    if (name === "whisper-svc" && process.env.MOCK_STT_IDLE === "1") return { name, status: "ok", checkedAt, detail: "idle" };
    return { name, status: "ok", checkedAt };
  });
}

const FLAP_MS = Number(process.env.MOCK_SERVICES_FLAP_MS ?? 0);
if (FLAP_MS > 0 && SERVICES_DOWN.size > 0) {
  setInterval(() => {
    servicesDownNow = !servicesDownNow;
    const frame = { type: "services", items: serviceItems() };
    console.log(`[mock-core] services: ${[...SERVICES_DOWN].join(",")} ${servicesDownNow ? "down" : "ok"}`);
    for (const ws of authedSockets) send(ws, frame);
  }, FLAP_MS).unref();
}
let confirmCounter = 0;

function addHistory(role, text) {
  history.push({ id: randomUUID(), role, text, ts: Date.now() });
}
const seedTs = Date.now() - 600000;
[
  ["user", "Salon ışığını aç"],
  ["assistant", "Salon ışığı açıldı."],
  ["user", "Hava nasıl olacak?"],
  ["assistant", "Bugün parçalı bulutlu, sıcaklık 18 derece civarında."],
].forEach(([role, text], i) => {
  history.push({ id: `seed-${i}`, role, text, ts: seedTs + i * 30000 });
});

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function sendError(ws, code, message, id) {
  send(ws, id === undefined ? { type: "error", code, message } : { type: "error", id, code, message });
}

// Lowercase, strip Turkish diacritics and punctuation, collapse whitespace.
function normalise(text) {
  return String(text)
    .replace(/İ/g, "i")
    .replace(/I/g, "i")
    .toLowerCase()
    .replace(/̇/g, "")
    .replace(/ç/g, "c")
    .replace(/ğ/g, "g")
    .replace(/ı/g, "i")
    .replace(/ö/g, "o")
    .replace(/ş/g, "s")
    .replace(/ü/g, "u")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

// 16-bit PCM mono 16 kHz WAV with a quiet sine tone and 20 ms fades.
function makeWav(textLength) {
  const rate = 16000;
  const seconds = Math.max(0.8, Math.min(6, 0.06 * textLength));
  const n = Math.floor(rate * seconds);
  const fade = Math.floor(rate * 0.02);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / fade, (n - 1 - i) / fade);
    const v = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.2 * env;
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

// Split into chunks of 2-3 words; concatenation equals the original text exactly.
function chunkText(text) {
  const words = text.match(/\S+\s*/g) ?? [];
  const chunks = [];
  for (let i = 0, k = 0; i < words.length; k++) {
    const size = k % 2 === 0 ? 2 : 3;
    chunks.push(words.slice(i, i + size).join(""));
    i += size;
  }
  return chunks;
}

function createContext(ws) {
  return { ws, authed: false, timers: new Set(), turn: null, speechPrefs: null };
}

// Sentences with their end offsets in the full text (simplified splitter, mock only).
function sentences(text) {
  const parts = text.match(/[^.!?…]+[.!?…]*\s*/g) ?? [];
  let end = 0;
  return parts.map((p) => ({ text: p.trim(), end: (end += p.length) })).filter((p) => p.text);
}

/** Per-turn speech stream: emits a chunk for every sentence the streamed text has completed. */
function createSpeech(ctx, turn, text) {
  const prefs = ctx.speechPrefs;
  if (!SPEECH_STREAM || !prefs?.enabled) return null;
  return { prefs, list: sentences(text), next: 0, seq: 0, failed: false };
}

function feedSpeech(ctx, turn, speech, streamedLength, done) {
  if (!speech || speech.failed) return;
  while (speech.next < speech.list.length && speech.list[speech.next].end <= streamedLength) {
    const sentence = speech.list[speech.next++].text;
    if (process.env.MOCK_TTS_FAIL === "1") {
      speech.failed = true;
      sendError(ctx.ws, "tts_unavailable", "Sahte TTS hatası", turn.id);
      send(ctx.ws, { type: "speech_chunk", id: turn.id, seq: speech.seq++, final: true });
      return;
    }
    const frame = { type: "speech_chunk", id: turn.id, seq: speech.seq++, final: false };
    if (speech.prefs.mode === "text") frame.text = sentence;
    else Object.assign(frame, { mime: "audio/wav", data: makeWav(sentence.length).toString("base64") });
    send(ctx.ws, frame);
  }
  if (done && speech.seq > 0) send(ctx.ws, { type: "speech_chunk", id: turn.id, seq: speech.seq++, final: true });
}

function later(ctx, ms, fn) {
  const t = setTimeout(() => {
    ctx.timers.delete(t);
    fn();
  }, ms);
  ctx.timers.add(t);
  return t;
}

function clearTimers(ctx) {
  for (const t of ctx.timers) clearTimeout(t);
  ctx.timers.clear();
}

function streamAnswer(ctx, turn, text) {
  const chunks = chunkText(text);
  const speech = createSpeech(ctx, turn, text);
  const step = (i) => {
    if (ctx.turn !== turn) return;
    if (i < chunks.length) {
      turn.streamed += chunks[i];
      send(ctx.ws, { type: "assistant_delta", id: turn.id, text: chunks[i] });
      feedSpeech(ctx, turn, speech, turn.streamed.length, false);
      later(ctx, 120, () => step(i + 1));
      return;
    }
    feedSpeech(ctx, turn, speech, text.length, true);
    send(ctx.ws, { type: "assistant_done", id: turn.id, text });
    addHistory("assistant", text);
    send(ctx.ws, { type: "state", state: "idle" });
    ctx.turn = null;
  };
  later(ctx, 120, () => step(0));
}

function resolveConfirm(ctx, approved, by) {
  const turn = ctx.turn;
  const pending = turn?.confirm;
  if (!pending) return false;
  clearTimeout(pending.timer);
  ctx.timers.delete(pending.timer);
  turn.confirm = null;
  send(ctx.ws, { type: "confirm_resolved", requestId: pending.requestId, approved, by });
  send(ctx.ws, { type: "state", state: "thinking" });
  send(ctx.ws, { type: "tool", id: turn.id, name: LOCK_TOOL, status: approved ? "done" : "denied" });
  streamAnswer(ctx, turn, approved ? "Tamam, kilidi açtım." : "Peki, kilit açılmadı.");
  return true;
}

function runTurn(ctx, id, text) {
  const turn = { id, confirm: null, streamed: "" };
  ctx.turn = turn;
  addHistory("user", text);
  send(ctx.ws, { type: "state", state: "thinking" });

  if (/kili[td]/.test(normalise(text))) {
    later(ctx, 500, () => {
      send(ctx.ws, { type: "tool", id, name: LOCK_TOOL, status: "started" });
      send(ctx.ws, { type: "state", state: "awaiting_confirm" });
      const requestId = `c${++confirmCounter}`;
      const timer = setTimeout(() => resolveConfirm(ctx, false, "timeout"), CONFIRM_MS);
      ctx.timers.add(timer);
      turn.confirm = { requestId, timer };
      send(ctx.ws, {
        type: "confirm_request",
        requestId,
        id,
        tool: LOCK_TOOL,
        summary: "Ön kapı kilidi açılacak. Onaylıyor musun?",
        expiresAt: Date.now() + CONFIRM_MS,
      });
    });
    return;
  }

  if (normalise(text).includes("limit")) {
    later(ctx, 300, () => {
      send(ctx.ws, { type: "error", id, code: "usage_limit", message: "Sahte kullanım limiti", retryAt: Date.now() + 2 * 3600_000 });
      send(ctx.ws, { type: "state", state: "idle" });
      ctx.turn = null;
    });
    return;
  }

  if (normalise(text).includes("hata")) {
    later(ctx, 300, () => {
      sendError(ctx.ws, "model_error", "Sahte model hatası", id);
      send(ctx.ws, { type: "state", state: "idle" });
      ctx.turn = null;
    });
    return;
  }

  streamAnswer(
    ctx,
    turn,
    `Bu bir deneme cevabı: "${text}". Shadow şu an sahte çekirdeğe bağlı. Cevap cümle cümle seslendirilir.`,
  );
}

function startTurnOrBusy(ctx, id, text) {
  if (ctx.turn) return sendError(ctx.ws, "busy", "Bir istek zaten işleniyor", id);
  runTurn(ctx, id, text);
}

// Whole short utterance (max 3 words) of only yes-words or only no-words; fillers allowed.
const YES = new Set(["evet", "onayla", "onayliyorum", "tamam", "olur"]);
const NO = new Set(["hayir", "iptal", "vazgec", "vazgectim"]);
const FILLERS = new Set(["lutfen", "et"]);
function voiceAnswer(text) {
  const words = normalise(text).split(" ").filter(Boolean);
  if (words.length === 0 || words.length > 3) return null;
  const core = words.filter((w) => !FILLERS.has(w));
  if (core.length === 0) return null;
  if (core.every((w) => YES.has(w))) return true;
  if (core.every((w) => NO.has(w))) return false;
  return null;
}

function handleAudio(ctx, msg) {
  const { ws } = ctx;
  const bytes = typeof msg.data === "string" ? Buffer.from(msg.data, "base64").length : 0;
  if (bytes === 0) return sendError(ws, "stt_unavailable", "Ses verisi boş", msg.id);
  later(ctx, 400, () => {
    const text = process.env.MOCK_TRANSCRIPT || `Ses alındı (${bytes} bayt)`;
    send(ws, { type: "transcript", id: msg.id, text });
    if (ctx.turn?.confirm) {
      const answer = voiceAnswer(text);
      if (answer !== null) return void resolveConfirm(ctx, answer, "voice");
    }
    startTurnOrBusy(ctx, msg.id, text);
  });
}

// ------------------------------------------------------------------- memory
// Shared across connections; deletes last until the mock restarts.
const memoryDay = Date.now() - 86400000;
const memoryStore = {
  brief: [
    { id: "m-a1b2c3", text: "Kullanıcının adı Rıdvan." },
    { id: "m-b2c3d4", text: "Kısa ve net cevapları tercih ediyor." },
  ],
  topics: [
    {
      topic: "ev",
      title: "Ev ve cihaz adları",
      entries: [
        { id: "m-7f3a9c", text: "Otomodos = oturma odası", updatedAt: memoryDay },
        { id: "m-8e4b1d", text: "Salon ışığı akşam 19:00'da açılıyor.", updatedAt: memoryDay + 3600000 },
      ],
    },
    {
      topic: "tercihler",
      title: "Tercihler",
      entries: [{ id: "m-9c5d2e", text: "Sıcaklığı 21 derecede tutmayı seviyor." }],
    },
  ],
};

function memoryFrame(id) {
  const chars = (entries) => entries.reduce((n, e) => n + e.text.length, 0);
  const briefChars = chars(memoryStore.brief);
  const topics = memoryStore.topics.map((t) => ({ ...t, chars: chars(t.entries) }));
  const warnings = [{ code: "note_over_budget", topic: "tercihler" }];
  if (briefChars > 800) warnings.unshift({ code: "brief_over_budget" });
  return { type: "memory", id, brief: { chars: briefChars, budget: 800, entries: memoryStore.brief }, topics, warnings };
}

function handleMemory(ctx, msg) {
  if (!MEMORY) return sendError(ctx.ws, "bad_request", "memory is disabled", msg.id);
  if (process.env.MOCK_MEMORY_SILENT === "1") return;
  later(ctx, 300, () => {
    if (msg.type === "memory_delete") {
      const lists = [memoryStore.brief, ...memoryStore.topics.map((t) => t.entries)];
      const list = lists.find((l) => l.some((e) => e.id === msg.entryId));
      if (!list) return sendError(ctx.ws, "bad_request", "unknown entryId", msg.id);
      list.splice(list.findIndex((e) => e.id === msg.entryId), 1);
      console.log(`[mock-core] memory_delete: ${msg.entryId}`);
    }
    send(ctx.ws, memoryFrame(msg.id));
  });
}

const MOCK_VOICES = [
  { id: "tr_TR-dfki-medium", label: "DFKI (kadın)", quality: "medium" },
  { id: "tr_TR-fahrettin-medium", label: "Fahrettin (erkek)", quality: "medium" },
];

function handleVoices(ctx, msg) {
  later(ctx, 200, () => {
    if (process.env.MOCK_TTS_FAIL === "1") {
      return sendError(ctx.ws, "tts_unavailable", "Sahte TTS hatası", msg.id);
    }
    send(ctx.ws, { type: "voices", id: msg.id, default: MOCK_VOICES[0].id, voices: MOCK_VOICES });
  });
}

function handleSpeak(ctx, msg) {
  const text = typeof msg.text === "string" ? msg.text : "";
  if (!text.trim()) return sendError(ctx.ws, "bad_request", "Metin boş", msg.id);
  console.log(`[mock-core] speak voice: ${typeof msg.voice === "string" ? msg.voice : "(default)"}`);
  later(ctx, 300, () => {
    if (process.env.MOCK_TTS_FAIL === "1") {
      return sendError(ctx.ws, "tts_unavailable", "Sahte TTS hatası", msg.id);
    }
    const data = makeWav(text.length).toString("base64");
    send(ctx.ws, { type: "speech", id: msg.id, mime: "audio/wav", data });
  });
}

// Like the real Core: a pending confirm is denied (by "button"), the partial
// text is sent as assistant_done, then idle.
function handleCancel(ctx, msg) {
  const turn = ctx.turn;
  if (!turn || turn.id !== msg.id) return;
  clearTimers(ctx);
  ctx.turn = null;
  if (turn.confirm) send(ctx.ws, { type: "confirm_resolved", requestId: turn.confirm.requestId, approved: false, by: "button" });
  send(ctx.ws, { type: "assistant_done", id: turn.id, text: turn.streamed });
  send(ctx.ws, { type: "state", state: "idle" });
}

function handleFrame(ctx, msg) {
  const { ws } = ctx;
  switch (msg.type) {
    case "ping":
      return send(ws, { type: "pong" });
    case "user_text":
      return startTurnOrBusy(ctx, msg.id, String(msg.text ?? ""));
    case "audio":
      return handleAudio(ctx, msg);
    case "confirm_response":
      if (!ctx.turn?.confirm || ctx.turn.confirm.requestId !== msg.requestId) {
        return sendError(ws, "bad_request", "Bilinmeyen requestId");
      }
      return void resolveConfirm(ctx, msg.approved === true, "button");
    case "speak":
      return handleSpeak(ctx, msg);
    case "voices":
      return handleVoices(ctx, msg);
    case "cancel":
      return handleCancel(ctx, msg);
    case "memory_list":
    case "memory_delete":
      return handleMemory(ctx, msg);
    case "speech_prefs":
      if (!SPEECH_STREAM) return sendError(ws, "bad_request", "Bilinmeyen tür: speech_prefs");
      if (typeof msg.enabled !== "boolean" || (msg.mode !== "audio" && msg.mode !== "text")) {
        return sendError(ws, "bad_request", "speech_prefs geçersiz");
      }
      ctx.speechPrefs = { enabled: msg.enabled, mode: msg.mode };
      console.log(`[mock-core] speech_prefs: ${msg.enabled ? msg.mode : "off"} voice: ${typeof msg.voice === "string" ? msg.voice : "(default)"}`);
      return;
    case "history_request": {
      const limit = Math.min(100, Math.max(1, Number(msg.limit) || 20));
      return send(ws, { type: "history", items: history.slice(-limit) });
    }
    default:
      return sendError(ws, "bad_request", `Bilinmeyen tür: ${String(msg.type)}`);
  }
}

function unauthorized(ctx) {
  sendError(ctx.ws, "unauthorized", "Geçersiz veya eksik token");
  ctx.ws.close(4401, "unauthorized");
}

function onMessage(ctx, raw) {
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    if (!ctx.authed) return unauthorized(ctx);
    return sendError(ctx.ws, "bad_request", "Geçersiz JSON");
  }
  const type = msg && typeof msg === "object" ? msg.type : undefined;
  console.log(`[mock-core] frame: ${String(type)}`);

  if (!ctx.authed) {
    if (type !== "hello" || msg.token !== TOKEN) return unauthorized(ctx);
    if (msg.protocol !== 1) {
      sendError(ctx.ws, "bad_request", "Desteklenmeyen protokol sürümü");
      return void ctx.ws.close(4400, "unsupported protocol");
    }
    ctx.authed = true;
    clearTimeout(ctx.authTimer);
    const welcome = { type: "welcome", protocol: 1, sessionId: randomUUID(), device: "browser" };
    const features = [...(SPEECH_STREAM ? ["speech_stream", "usage_limit"] : []), ...(MEMORY ? ["memory"] : [])];
    if (features.length > 0) welcome.features = features;
    send(ctx.ws, welcome);
    send(ctx.ws, { type: "state", state: "idle" });
    send(ctx.ws, { type: "services", items: serviceItems() });
    authedSockets.add(ctx.ws);
    return;
  }
  if (!msg || typeof msg !== "object") return sendError(ctx.ws, "bad_request", "Geçersiz çerçeve");
  handleFrame(ctx, msg);
}

const wss = new WebSocketServer({ port: PORT, host: HOST, path: "/ws" });

wss.on("connection", (ws) => {
  const ctx = createContext(ws);
  ctx.authTimer = setTimeout(() => ws.close(4401, "hello timeout"), AUTH_TIMEOUT_MS);
  ws.on("message", (raw) => onMessage(ctx, raw));
  ws.on("close", () => {
    authedSockets.delete(ws);
    clearTimeout(ctx.authTimer);
    clearTimers(ctx);
    ctx.turn = null;
    console.log("[mock-core] connection closed");
  });
  ws.on("error", (err) => console.log(`[mock-core] socket error: ${err.message}`));
  console.log("[mock-core] connection opened");
});

wss.on("listening", () => console.log(`[mock-core] listening on ws://${HOST}:${PORT}/ws`));
