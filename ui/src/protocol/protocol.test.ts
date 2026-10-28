import { describe, expect, it } from "vitest";
import {
  BACKOFF_MAX_MS,
  CLOSE_PROTOCOL,
  CLOSE_UNAUTHORIZED,
  CoreClient,
  PING_INTERVAL_MS,
  PONG_TIMEOUT_MS,
  WELCOME_TIMEOUT_MS,
  backoffDelay,
  normalizeCoreUrl,
  type SocketLike,
  type StatusEvent,
  type Timers,
} from "./client.ts";
import { parseServerMessage, type ServerMessage } from "./types.ts";

// ---------------------------------------------------------------------------
// parseServerMessage

const VALID: ServerMessage[] = [
  { type: "welcome", protocol: 1, sessionId: "s1", device: "browser" },
  { type: "state", state: "idle" },
  { type: "state", state: "thinking" },
  { type: "state", state: "awaiting_confirm" },
  { type: "transcript", id: "t2", text: "merhaba" },
  { type: "assistant_delta", id: "t1", text: "Mer" },
  { type: "assistant_done", id: "t1", text: "Merhaba" },
  { type: "tool", id: "t1", name: "light.turn_on", status: "started" },
  { type: "tool", id: "t1", name: "light.turn_on", status: "done" },
  { type: "tool", id: "t1", name: "lock.unlock", status: "denied" },
  { type: "tool", id: "t1", name: "x", status: "error" },
  { type: "confirm_request", requestId: "c1", id: "t1", tool: "lock.unlock", summary: "Kapı açılsın mı?", expiresAt: 1 },
  { type: "confirm_resolved", requestId: "c1", approved: true, by: "button" },
  { type: "confirm_resolved", requestId: "c1", approved: false, by: "voice" },
  { type: "confirm_resolved", requestId: "c1", approved: false, by: "timeout" },
  { type: "speech", id: "t1", mime: "audio/wav", data: "UklGRg==" },
  { type: "history", items: [{ id: "h1", role: "user", text: "a", ts: 1 }] },
  { type: "error", code: "unauthorized" },
  { type: "error", id: "t1", code: "stt_unavailable", message: "down" },
  {
    type: "services",
    items: [
      { name: "whisper-svc", status: "down", checkedAt: 1, detail: "timeout" },
      { name: "tts-svc", status: "ok", checkedAt: 1 },
    ],
  },
  {
    type: "voices",
    id: "v1",
    default: "tr_TR-dfki-medium",
    voices: [
      { id: "tr_TR-dfki-medium", label: "DFKI", quality: "medium" },
      { id: "tr_TR-other", label: "Diğer" },
    ],
  },
  { type: "voices", id: "v2", default: "x", voices: [] },
  { type: "pong" },
  { type: "welcome", protocol: 1, sessionId: "s1", device: "browser", features: ["speech_stream", "memory", "usage_limit"] },
  { type: "welcome", protocol: 1, sessionId: "s1", device: "browser", features: [] },
  { type: "speech_chunk", id: "t1", seq: 0, final: false, mime: "audio/wav", data: "UklGRg==" },
  { type: "speech_chunk", id: "t1", seq: 1, final: false, text: "Salon ışığı açıldı." },
  { type: "speech_chunk", id: "t1", seq: 2, final: true },
  { type: "speech_chunk", id: "t1", seq: 3, final: true, text: "Son cümle." },
  { type: "error", id: "t1", code: "usage_limit", message: "limit", retryAt: 1767340800000 },
  { type: "error", id: "t1", code: "usage_limit", message: "limit" },
  {
    type: "memory",
    id: "m1",
    brief: { chars: 412, budget: 800, entries: [{ id: "m-a1b2c3", text: "Kullanıcının adı Rıdvan." }] },
    topics: [
      {
        topic: "ev",
        title: "Ev ve cihaz adları",
        chars: 96,
        entries: [{ id: "m-7f3a9c", text: "Otomodos = oturma odası", updatedAt: 1767340800000 }],
      },
    ],
    warnings: [{ code: "note_over_budget", topic: "tercihler" }, { code: "memory_full" }],
  },
  { type: "memory", id: "m2", brief: { chars: 0, budget: 800, entries: [] }, topics: [], warnings: [] },
];

describe("parseServerMessage", () => {
  it.each(VALID.map((m) => [m.type, m] as const))("accepts %s", (_type, msg) => {
    expect(parseServerMessage(JSON.stringify(msg))).toEqual(msg);
  });

  it.each([
    ["not json", "{"],
    ["array", "[]"],
    ["no type", "{}"],
    ["unknown type", '{"type":"future_thing"}'],
    ["bad state", '{"type":"state","state":"speaking"}'],
    ["delta without id", '{"type":"assistant_delta","text":"x"}'],
    ["bad tool status", '{"type":"tool","id":"t","name":"n","status":"maybe"}'],
    ["confirm without expiresAt", '{"type":"confirm_request","requestId":"c","id":"t","tool":"x","summary":"s"}'],
    ["resolved bad by", '{"type":"confirm_resolved","requestId":"c","approved":true,"by":"magic"}'],
    ["history not array", '{"type":"history","items":{}}'],
    ["error id not string", '{"type":"error","id":5,"code":"x"}'],
    ["services not array", '{"type":"services","items":{}}'],
    ["voices without id", '{"type":"voices","default":"a","voices":[]}'],
    ["voices without default", '{"type":"voices","id":"v","voices":[]}'],
    ["voices not array", '{"type":"voices","id":"v","default":"a","voices":{}}'],
    ["chunk without id", '{"type":"speech_chunk","seq":0,"final":false,"text":"a"}'],
    ["chunk without seq", '{"type":"speech_chunk","id":"t","final":false,"text":"a"}'],
    ["chunk negative seq", '{"type":"speech_chunk","id":"t","seq":-1,"final":false,"text":"a"}'],
    ["chunk fractional seq", '{"type":"speech_chunk","id":"t","seq":1.5,"final":false,"text":"a"}'],
    ["chunk without final", '{"type":"speech_chunk","id":"t","seq":0,"text":"a"}'],
    ["chunk final not boolean", '{"type":"speech_chunk","id":"t","seq":0,"final":"yes","text":"a"}'],
    ["chunk data without mime", '{"type":"speech_chunk","id":"t","seq":0,"final":false,"data":"AAAA"}'],
    ["chunk data not string", '{"type":"speech_chunk","id":"t","seq":0,"final":false,"mime":"audio/wav","data":5}'],
    ["chunk text not string", '{"type":"speech_chunk","id":"t","seq":0,"final":false,"text":{}}'],
    ["memory without id", '{"type":"memory","brief":{"chars":0,"budget":1,"entries":[]},"topics":[],"warnings":[]}'],
    ["memory without brief", '{"type":"memory","id":"m","topics":[],"warnings":[]}'],
    ["memory brief without budget", '{"type":"memory","id":"m","brief":{"chars":0,"entries":[]}}'],
    ["memory brief entries not array", '{"type":"memory","id":"m","brief":{"chars":0,"budget":1,"entries":{}}}'],
  ])("rejects %s", (_name, raw) => {
    expect(parseServerMessage(raw)).toBeNull();
  });

  it("drops malformed history items but keeps valid ones", () => {
    const msg = parseServerMessage(
      JSON.stringify({ type: "history", items: [{ id: "a", role: "user", text: "x", ts: 1 }, { id: "b", role: "bot" }] }),
    );
    expect(msg).toEqual({ type: "history", items: [{ id: "a", role: "user", text: "x", ts: 1 }] });
  });

  it("services: drops malformed items, maps unknown status to down, cuts long text", () => {
    const msg = parseServerMessage(
      JSON.stringify({
        type: "services",
        items: [
          { name: "a", status: "ok", checkedAt: 1, extra: "dropped" },
          { name: "b", status: "rebooting", checkedAt: 2 },
          { name: "c", status: "ok" },
          { name: "d", status: "down", checkedAt: 3, detail: 5 },
          { name: "e", status: "down", checkedAt: 4, detail: "x".repeat(200) },
        ],
      }),
    );
    expect(msg).toEqual({
      type: "services",
      items: [
        { name: "a", status: "ok", checkedAt: 1 },
        { name: "b", status: "down", checkedAt: 2 },
        { name: "e", status: "down", checkedAt: 4, detail: "x".repeat(64) },
      ],
    });
  });
});

describe("parseServerMessage voices", () => {
  it("drops malformed voices, falls back to the id as label, drops duplicates and cuts long text", () => {
    const msg = parseServerMessage(
      JSON.stringify({
        type: "voices",
        id: "v1",
        default: "a",
        voices: [
          { id: "a", label: "  A ses  ", quality: "medium", extra: 1 },
          { id: "b" },
          { id: "c", label: "", quality: 3 },
          { label: "no id" },
          { id: "" },
          "x",
          { id: "a", label: "duplicate" },
          { id: "d", label: "L".repeat(200) },
        ],
      }),
    );
    expect(msg).toEqual({
      type: "voices",
      id: "v1",
      default: "a",
      voices: [
        { id: "a", label: "A ses", quality: "medium" },
        { id: "b", label: "b" },
        { id: "c", label: "c" },
        { id: "d", label: "L".repeat(80) },
      ],
    });
  });
});

describe("parseServerMessage protocol additions (speech_stream, memory, usage_limit)", () => {
  it("welcome: keeps only string features, ignores a malformed features field and unknown fields", () => {
    expect(
      parseServerMessage(
        JSON.stringify({ type: "welcome", protocol: 1, sessionId: "s", device: "d", features: ["speech_stream", 5, null, "x"] }),
      ),
    ).toEqual({ type: "welcome", protocol: 1, sessionId: "s", device: "d", features: ["speech_stream", "x"] });
    const noFeatures = parseServerMessage(
      JSON.stringify({ type: "welcome", protocol: 1, sessionId: "s", device: "d", features: "speech_stream" }),
    );
    expect(noFeatures).toEqual({ type: "welcome", protocol: 1, sessionId: "s", device: "d" });
    expect(noFeatures && "features" in noFeatures).toBe(false);
    // An old Core's welcome is unchanged.
    expect(parseServerMessage(JSON.stringify({ type: "welcome", protocol: 1, sessionId: "s", device: "d" }))).toEqual({
      type: "welcome",
      protocol: 1,
      sessionId: "s",
      device: "d",
    });
  });

  it("error: a malformed retryAt is dropped, the error still counts", () => {
    for (const retryAt of ["soon", null, Number.NaN]) {
      const msg = parseServerMessage(JSON.stringify({ type: "error", id: "t1", code: "usage_limit", retryAt }));
      expect(msg).toEqual({ type: "error", id: "t1", code: "usage_limit" });
      expect(msg && "retryAt" in msg).toBe(false);
    }
  });

  it("speech_chunk: keeps only known fields; empty payload strings count as absent", () => {
    expect(
      parseServerMessage(
        JSON.stringify({ type: "speech_chunk", id: "t1", seq: 0, final: false, mime: "audio/wav", data: "AAAA", extra: 1 }),
      ),
    ).toEqual({ type: "speech_chunk", id: "t1", seq: 0, final: false, mime: "audio/wav", data: "AAAA" });
    expect(
      parseServerMessage(JSON.stringify({ type: "speech_chunk", id: "t1", seq: 4, final: true, data: "", text: "" })),
    ).toEqual({ type: "speech_chunk", id: "t1", seq: 4, final: true });
    // A mime without data is ignored (nothing to play).
    expect(
      parseServerMessage(JSON.stringify({ type: "speech_chunk", id: "t1", seq: 1, final: false, mime: "audio/wav" })),
    ).toEqual({ type: "speech_chunk", id: "t1", seq: 1, final: false });
  });

  it("memory: drops malformed entries, topics and warnings; missing lists are empty; title falls back to the topic", () => {
    const msg = parseServerMessage(
      JSON.stringify({
        type: "memory",
        id: "m1",
        extra: true,
        brief: {
          chars: 10,
          budget: 800,
          entries: [{ id: "a", text: "x", updatedAt: "yesterday", extra: 1 }, { id: "", text: "y" }, { text: "z" }, "w"],
        },
        topics: [
          { topic: "ev", chars: 3, entries: [{ id: "b", text: "t", updatedAt: 5 }] },
          { topic: "bad", chars: 1, entries: "no" },
          { title: "no topic", chars: 1, entries: [] },
          { topic: "nochars", entries: [] },
        ],
        warnings: [{ code: "note_full", topic: "ev" }, { code: "memory_full", topic: 3 }, { topic: "x" }],
      }),
    );
    expect(msg).toEqual({
      type: "memory",
      id: "m1",
      brief: { chars: 10, budget: 800, entries: [{ id: "a", text: "x" }] },
      topics: [{ topic: "ev", title: "ev", chars: 3, entries: [{ id: "b", text: "t", updatedAt: 5 }] }],
      warnings: [{ code: "note_full", topic: "ev" }, { code: "memory_full" }],
    });
    expect(
      parseServerMessage(JSON.stringify({ type: "memory", id: "m2", brief: { chars: 0, budget: 800, entries: [] } })),
    ).toEqual({ type: "memory", id: "m2", brief: { chars: 0, budget: 800, entries: [] }, topics: [], warnings: [] });
  });
});

// ---------------------------------------------------------------------------
// normalizeCoreUrl / backoff

describe("normalizeCoreUrl", () => {
  it.each([
    ["localhost:8700", "ws://localhost:8700/ws"],
    ["ws://localhost:8700/ws", "ws://localhost:8700/ws"],
    ["  ws://localhost:8700  ", "ws://localhost:8700/ws"],
    ["http://localhost:8700", "ws://localhost:8700/ws"],
    ["https://core.example/ws", "wss://core.example/ws"],
    ["wss://core.example/custom", "wss://core.example/custom"],
  ])("%s -> %s", (input, out) => {
    expect(normalizeCoreUrl(input)).toBe(out);
  });

  it.each(["", "   ", "ftp://x", "ws://user:pw@host/ws", "ws://"])("rejects %j", (input) => {
    expect(normalizeCoreUrl(input)).toBeNull();
  });
});

describe("backoffDelay", () => {
  it("grows exponentially, is capped and jittered", () => {
    expect(backoffDelay(1, () => 1)).toBe(1000);
    expect(backoffDelay(2, () => 1)).toBe(2000);
    expect(backoffDelay(3, () => 0)).toBe(2000);
    expect(backoffDelay(50, () => 1)).toBe(BACKOFF_MAX_MS);
  });
});

// ---------------------------------------------------------------------------
// CoreClient with a fake socket and manual timers

class FakeSocket implements SocketLike {
  readyState = 0;
  sent: unknown[] = [];
  closed: { code?: number } | null = null;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number) {
    this.closed = { code };
    this.readyState = 3;
  }
  // test helpers
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  serverClose(code: number) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

class ManualTimers implements Timers {
  now = 0;
  private seq = 0;
  private tasks = new Map<number, { at: number; fn: () => void; every?: number }>();
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.now + ms, fn });
    return id;
  };
  setInterval = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.tasks.set(id, { at: this.now + ms, fn, every: ms });
    return id;
  };
  clearTimeout = (h: unknown) => void this.tasks.delete(h as number);
  clearInterval = (h: unknown) => void this.tasks.delete(h as number);
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.tasks.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, task] = due;
      this.now = task.at;
      if (task.every) task.at += task.every;
      else this.tasks.delete(id);
      task.fn();
    }
    this.now = end;
  }
  get pending() {
    return this.tasks.size;
  }
}

function setup() {
  const sockets: FakeSocket[] = [];
  const statuses: StatusEvent[] = [];
  const messages: ServerMessage[] = [];
  const timers = new ManualTimers();
  const client = new CoreClient({
    url: "ws://localhost:8700/ws",
    token: "secret",
    client: "web",
    clientVersion: "0.0.0",
    onMessage: (m) => messages.push(m),
    onStatus: (s) => statuses.push(s),
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    timers,
    random: () => 1,
  });
  const last = () => sockets[sockets.length - 1];
  const status = () => statuses[statuses.length - 1]?.status;
  return { client, sockets, statuses, messages, timers, last, status };
}

describe("CoreClient", () => {
  it("sends hello with the token as the first frame and becomes connected on welcome", () => {
    const t = setup();
    t.client.start();
    expect(t.status()).toBe("connecting");
    expect(t.last().url).toBe("ws://localhost:8700/ws");
    t.last().open();
    expect(t.last().sent[0]).toEqual({ type: "hello", protocol: 1, token: "secret", client: "web", clientVersion: "0.0.0" });
    expect(t.status()).toBe("authenticating");
    t.last().receive({ type: "welcome", protocol: 1, sessionId: "s", device: "browser" });
    expect(t.status()).toBe("connected");
    expect(t.messages[0].type).toBe("welcome");
  });

  it("does not put the token in the URL", () => {
    const t = setup();
    t.client.start();
    expect(t.last().url).not.toContain("secret");
  });

  it("refuses to send before welcome", () => {
    const t = setup();
    t.client.start();
    t.last().open();
    expect(t.client.send({ type: "ping" })).toBe(false);
    expect(t.last().sent).toHaveLength(1); // only hello
  });

  it("stops on 4401 / unauthorized without reconnecting", () => {
    const t = setup();
    t.client.start();
    t.last().open();
    t.last().receive({ type: "error", code: "unauthorized" });
    t.last().serverClose(CLOSE_UNAUTHORIZED);
    expect(t.status()).toBe("unauthorized");
    t.timers.advance(60_000);
    expect(t.sockets).toHaveLength(1);
  });

  it("stops on 4400 (unsupported protocol) without reconnecting", () => {
    const t = setup();
    t.client.start();
    t.last().open();
    t.last().receive({ type: "error", code: "bad_request", message: "unsupported protocol" });
    t.last().serverClose(CLOSE_PROTOCOL);
    expect(t.status()).toBe("incompatible");
    t.timers.advance(60_000);
    expect(t.sockets).toHaveLength(1);
  });

  it("treats a bare 4401 close as unauthorized", () => {
    const t = setup();
    t.client.start();
    t.last().open();
    t.last().serverClose(CLOSE_UNAUTHORIZED);
    expect(t.status()).toBe("unauthorized");
  });

  it("reconnects with backoff after an unexpected close", () => {
    const t = setup();
    t.client.start();
    t.last().open();
    t.last().receive({ type: "welcome", protocol: 1, sessionId: "s", device: "browser" });
    t.last().serverClose(1006);
    expect(t.status()).toBe("reconnecting");
    expect(t.statuses[t.statuses.length - 1].retryInMs).toBe(1000);
    t.timers.advance(999);
    expect(t.sockets).toHaveLength(1);
    t.timers.advance(1);
    expect(t.sockets).toHaveLength(2);
    // second failure doubles the delay
    t.last().serverClose(1006);
    expect(t.statuses[t.statuses.length - 1].retryInMs).toBe(2000);
  });

  it("reconnectNow skips the remaining delay", () => {
    const t = setup();
    t.client.start();
    t.last().serverClose(1006);
    t.client.reconnectNow();
    expect(t.sockets).toHaveLength(2);
  });

  it("closes a socket that never sends welcome", () => {
    const t = setup();
    t.client.start();
    t.last().open();
    t.timers.advance(WELCOME_TIMEOUT_MS);
    expect(t.last().closed).not.toBeNull();
  });

  it("pings while connected and drops a connection that stops answering", () => {
    const t = setup();
    t.client.start();
    t.last().open();
    t.last().receive({ type: "welcome", protocol: 1, sessionId: "s", device: "browser" });
    t.timers.advance(PING_INTERVAL_MS);
    expect(t.last().sent[t.last().sent.length - 1]).toEqual({ type: "ping" });
    t.last().receive({ type: "pong" });
    expect(t.messages.some((m) => m.type === "pong")).toBe(false);
    t.timers.advance(PONG_TIMEOUT_MS);
    expect(t.last().closed).toBeNull();
    t.timers.advance(PING_INTERVAL_MS - PONG_TIMEOUT_MS + PONG_TIMEOUT_MS);
    expect(t.last().closed?.code).toBe(4000);
  });

  it("stop() closes the socket and clears every timer", () => {
    const t = setup();
    t.client.start();
    t.last().open();
    t.last().receive({ type: "welcome", protocol: 1, sessionId: "s", device: "browser" });
    t.client.stop();
    expect(t.status()).toBe("closed");
    expect(t.last().closed?.code).toBe(1000);
    expect(t.timers.pending).toBe(0);
  });

  it("ignores frames from a replaced socket", () => {
    const t = setup();
    t.client.start();
    const first = t.last();
    first.serverClose(1006);
    t.client.reconnectNow();
    first.receive({ type: "state", state: "thinking" });
    expect(t.messages).toHaveLength(0);
  });
});
