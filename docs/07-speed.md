# 07 - Turn latency: persistent agent session, streamed speech, continuity

Status: design (T7.6, T7.7, T7.9 in [`01-v1-plan.md`](01-v1-plan.md)). T7.8 (the
tier-0 Turkish router fix) is done separately and is not designed here.
Memory (T10) builds on this document: see [`06-memory.md`](06-memory.md).

## Problem

A simple typed turn takes 6 to 8 s wall time, but the SDK `result.duration_ms` is
1 to 2 s. STT takes about 0.9 s and Piper about 0.4 s. About 4.5 s per turn is
overhead from calling `query()` fresh on every turn
([`agent.ts`](../core/src/agent.ts) `SdkAgentRunner.runTurn`):

- a new Claude Code process starts (module load, config, auth);
- the Home Assistant MCP server is connected over SSE again (`alwaysLoad: true`
  blocks the first request until it is connected);
- the session transcript is loaded from disk (`resume`), and tier-1 turns also
  fork it (`forkSession`).

Speech adds more: the UI sends `speak` only after `assistant_done`, so the
first word is heard only after the whole answer is generated and then
synthesized in one piece.

Target: a warm, simple text turn (tier 1, no tool) at **p50 ≤ 2.5 s** wall time,
measured as described in [Measurement](#measurement). This target covers warm
turns. It does not cover the first turn after a cold start or an escalated turn.

## Scope

| In | Out |
|---|---|
| A1: one long-lived SDK query per device (streaming input) | Tier-0 router Turkish fix (T7.8, another developer) |
| A2: sentence-by-sentence speech for Core TTS and Android native TTS | Wake word, STT speed |
| A4: same device continues its conversation within N minutes, also after a Core restart | Keeping a turn running after its socket closes (see [Decisions for the user](#kullanıcı-kararı-gerekebilir-decisions-for-the-user)) |
| Measurement method and bench script | Memory, compaction (see 06) |

## SDK capabilities relied on

Installed: `@anthropic-ai/claude-agent-sdk` 0.3.311 (`core/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`).

| Need | SDK API |
|---|---|
| Long-lived session | `query({ prompt: AsyncIterable<SDKUserMessage>, options })` (streaming input). The `Query` control methods below are "only available in streaming input mode". |
| Tier switch | `Query.setModel(model?)` — "Change the model used for subsequent responses." |
| Barge-in | `Query.interrupt()` — stops the current run and keeps the process. |
| Shutdown / idle close | `Query.close()` — ends the process, MCP transports and pending requests. |
| MCP health | `Query.mcpServerStatus()`, `Query.reconnectMcpServer(name)` |
| Context size | `Query.getContextUsage({ detail: "summary" })` (used by 06 compaction) |
| Append without a reply | `SDKUserMessage.shouldQuery: false` — "appended to the transcript without triggering an assistant turn. It will be merged into the next user message that does query." |
| Turn boundary | one `result` message (`SDKResultSuccess` / `SDKResultError`) per sent user message, also for `shouldQuery: false` (spike Q2, Q7). The answer itself ends earlier, at the top-level `message_stop` after `stop_reason: "end_turn"` (spike Q12). |
| Usage | `result.usage` is per turn in streaming-input sessions; `total_cost_usd` and `modelUsage` are **cumulative** per `query()` call, across models (and a resumed session starts from the saved total). |
| Usage limit | `SDKRateLimitEvent` (`rate_limit_info.status: "allowed" \| "allowed_warning" \| "rejected"`, `resetsAt`), `SDKAssistantMessageError` `"rate_limit"`, exported `USAGE_LIMIT_ERROR_PREFIXES` (`@alpha`) |
| Session check | `getSessionInfo(sessionId, options)` |
| System prompt | `systemPrompt: { type: "custom", prompt, snapshot: false }` renders the prompt passed at **query start** on every request. It is not a live setter: a running query keeps the prompt it was started with. |
| Cold-start helpers | `startup()` (single-use `WarmQuery`), `prewarm()` (`@alpha`, spare process + `claim()`) — evaluated in the spike, not required by the design |

Things the type declarations do not settle are listed in [Spike](#s1-spike-questions)
and must be verified before the wiring task starts.

## A1. Persistent per-device agent session

### Decision

One long-lived streaming-input `query()` per **device** (the `DEVICE_TOKEN_<NAME>`
name), owned by a new `DeviceAgent`, not by the WebSocket `Session`. Tiers switch
with `setModel()` on the same query. The tier-1 escalation paragraph moves from a
per-tier system prompt into one static system prompt and is enabled per turn by
a marker line in the user message. Escalation continues in the same session, with
no fork.

### Alternatives considered

| Option | Verdict |
|---|---|
| **(a) One query per device + `setModel()` per turn** | **Chosen.** One process, one MCP connection, one history. The cost: tier-1 escalation no longer forks and discards the Haiku attempt; the attempt (user text + `[[ESCALATE]]`) stays in the history. That is a few tokens. |
| (b) One warm query per tier per device | Rejected. Three processes (about 250 MB each) per device, and three diverging histories: a Sonnet turn is invisible to the Haiku process. Syncing them needs extra machinery. |
| (c) Persistent for tiers 1-2, fresh `query()` for tier 3 | Rejected. A fresh query that resumes the same session while the live process also writes it gives two writers on one transcript. `setModel("opus")` is simpler. |
| `prewarm()` spare + `claim()` per turn | Rejected as the main mechanism: a claim starts a new session each time, it is `@alpha`, and options such as `mcpServers`/`canUseTool` are fixed at prewarm. It may still help the very first cold start (spike). |

### Components

```
server.ts ── Session (per socket) ──┐
                                    ├─ DeviceRegistry (per Core) ── ProviderSession (per device) ── ModelProvider
server.ts ── Session (per socket) ──┘         │                      = DeviceAgent                  = ClaudeSdkProvider
                                              │                      (query() + Claude Code process, HA MCP SSE stays connected)
                                              └─ ContinuityStore (A4, sessions/devices.json: { provider, sessionId })
```

- **Provider interface** (`core/src/model-provider.ts`). Every model call goes
  through the Core, and the Core talks to a model only through this interface,
  so the provider can be swapped (a fallback provider is T7.z). `ModelProvider`
  has `id`, `capabilities { setModel, compact, notes, resume }`,
  `openSession({ device, model, resume?, onSessionId?, onDead?, onIdleClose? })`
  → `ProviderSession`, and `oneShot({ model, system?, prompt, schema?, maxTokens,
  signal })` for background passes (memory extraction, Core-side summary, 06).
  `ProviderSession` has `provider`, `sessionId`, `model`, `busy`, `ready()`,
  `runAttempt`, `appendNote`, `setModel`, `interrupt`, optional `compact()`
  (only with the capability) and `close()`. Attempt request/outcome
  (`AttemptStatus` incl. `usage_limit` + `retryAt`, token and cost fields) and
  the permission callback are provider-neutral types. The registry, `Session`,
  continuity (A4) and memory (06) code use only these types; sentence streaming
  (A2), continuity, extraction and compaction live in the Core above the
  interface. The tool permission gate stays as it is: `Session.gate()` is passed
  per attempt as a neutral `PermissionCallback`, which each provider adapts.
- **`ClaudeSdkProvider`** (`core/src/device-agent.ts`) is the Claude Agent SDK
  implementation: `openSession` creates a `DeviceAgent`; `oneShot` runs a
  separate one-shot `query()` (options from an injected builder: no tools, no
  MCP, no persisted session); `compact` is off until `/compact` on a live
  streaming query is verified.
- **`DeviceAgent`** (`core/src/device-agent.ts`, the `ProviderSession`) owns one `Query`:
  - an input queue (an `AsyncIterable<SDKUserMessage>` that never ends while the
    agent lives) and one output pump that reads the `Query` for its whole life;
  - `runAttempt({ text, model, canUseTool, callbacks, signal })` sends one user
    message (with a fresh `uuid`) and returns two promises: `done` (the visible
    end, see *Turn boundaries*) and `settled` (the next `result`), instead of
    waiting for the iterator to end as `runTurn` does. Only **one attempt before
    its visible end** is allowed per device (`DeviceAgentBusyError`);
    `appendNote(text)` sends a `shouldQuery: false` message;
  - calls `setModel(model)` before the attempt when the model differs from the
    current one;
  - `interrupt()` for barge-in, `close()` for idle close and shutdown;
  - an idle timer, a dead flag and usage diffing (below).
- **`DeviceRegistry`** (new `core/src/device-registry.ts`) maps device →
  `ProviderSession` (via `ModelProvider.openSession`). It creates sessions lazily, prewarms on `hello`, closes idle ones and
  starts replacements after a crash.
- **`Session`** (per socket) keeps what it does today: routing, tier 0, permission
  gate, confirmations, buffering of tier-1 text, conversation log. Instead of
  `deps.agent.runTurn(...)` it calls `registry.get(device).runAttempt(...)`.
- **`SdkAgentRunner`** (fresh `query()` per turn) stays as the legacy path for
  `CORE_AGENT_PERSISTENT=off` and as a one-turn fallback when a `DeviceAgent`
  cannot start (see *Failures*).

### Query options (fixed for the life of the query)

Same as `SdkAgentRunner.buildOptions` today, except:

| Option | Value | Why |
|---|---|---|
| `prompt` | the agent's input queue | streaming-input mode |
| `model` | tier-1 model | the most common tier; others via `setModel` |
| `systemPrompt` | `{type:"custom", prompt: system.md + tier1.md + memory brief (06), snapshot:false}` | one static prompt for all tiers, so each model has one cache prefix |
| `mcpServers` | all enabled services | stable tool list for the whole session |
| `canUseTool` | one dispatcher per agent (below) | fixed at query start |
| `resume` | session id from the continuity store (A4), if valid | |
| `forkSession` | never | |
| `maxTurns` | `12` | counts per user message in streaming-input mode (spike Q4), so today's meaning is kept |
| `env` | `subprocessEnv(process.env)` | with `CORE_AGENT_SKIP_TURN_SUMMARY=1`: also `CLAUDE_CODE_CLASSIFIER_SUMMARY=0` (see *Turn boundaries*) |
| `abortController` | owned by the agent | only `close()` paths abort |

### Tier switching and escalation

Per user turn (tiers 1-3; tier 0 is unchanged and does not touch the agent):

1. The router decides on the original user text, as today.
2. `Session` builds the **turn envelope**, a plain user message:

   ```
   [mod:hizli]            ← only for escalatable tier-1 turns
   <memory block, 06>     ← only when memory selected entries
   <user text>
   ```

3. `DeviceAgent.runAttempt` awaits `setModel(tierModel)` if needed, installs the
   turn's sink and gate context, sends the envelope and resolves `done` at the
   visible end (`settled` at `result`).
4. Tier-1 text stays **buffered** in `Session.callModel` exactly as today. The
   marker `[[ESCALATE]]` is never shown or spoken.
5. On escalation: `setModel(tier2Model)` and a second attempt with
   `ESCALATION_CONTINUE` as text (today this is used only when Haiku ran tools).
   The tier-2 model sees the original request, the Haiku marker and any tool
   results in the same session. No fork, no resume.

`core/prompts/tier1.md` is reworded to be conditional: "If the latest user
message starts with the line `[mod:hizli]`, the following rule applies to that
message only: …". The prompt then reads the same for every tier and model, which
keeps prompt caching per model. Switching models does not share the cache: the
first turn on a model after a switch writes that model's cache, and returning
to a model within the cache TTL reads it again. That was already true with
fresh queries.

`router.yaml` `tierN.services` (not configured today): in persistent mode the
query loads all services, and the per-agent gate **denies** tools of a service
that is not in the current tier's list ("not available in this mode"). The
execution limit is kept. The token saving is lost; it remains only with
`CORE_AGENT_PERSISTENT=off`. The Core logs a startup warning when the key is set.

### Permission gate (`canUseTool`)

`canUseTool` is fixed when the query starts, but `Session.gate(turn)` is a
per-turn closure today. The agent therefore passes one dispatcher:

- When the dispatcher is invoked, it captures the **current attempt**
  (`{turn, session}` installed by `runAttempt`) and keeps that reference across
  its awaits (the confirmation can take up to 60 s).
- It calls the same `Session.authorize(...)` as today. Levels, `confirm_inputs`,
  read-only mode, logging and `confirm_request`/`confirm_resolved` frames do not
  change.
- When there is no current attempt, or the captured attempt is cancelled or
  finished, the dispatcher answers `deny` ("Turn was cancelled.") without
  asking.

### Turn boundaries, cancel, timeouts

- **Boundary (spike Q2, Q7, Q12):** every sent user message, also a
  `shouldQuery: false` note, yields exactly one `result`. Messages are sent
  strictly one at a time: the next one only after the previous `result`, so a
  `result` always belongs to the single message in flight and nothing is folded
  into a running turn. Messages that arrive with nothing in flight (a stray
  `user` echo after a `result`) are ignored. `TurnStream` (agent.ts) is reused
  per attempt; the pump routes every message between send and `result` to it.
- **Visible end vs `result` (spike Q12):** from the second message of a session
  on, the CLI runs an end-of-turn summary classifier for about 2 to 2.5 s between
  the last `message_stop` and `result`. Therefore an attempt has two ends:
  - `done`: the top-level `message_stop` whose `message_delta` carried
    `stop_reason: "end_turn"` (or the `result`, if that comes first, e.g. on an
    error or cancel). `Session` sends `assistant_done` here. A `tool_use` stop
    does not end the turn.
  - `settled`: the `result`. Usage, `costUsd` and `sdkDurationMs` are final only
    here; `Session` records usage when it arrives.
  - A new attempt may be submitted after `done`. It is queued and sent after the
    previous `result` (`busy` is only reported before `done`). Escalation uses
    the same path: the tier-2 attempt waits for the tier-1 `result`.
  - Opt-in `CORE_AGENT_SKIP_TURN_SUMMARY=1` sets `CLAUDE_CODE_CLASSIFIER_SUMMARY=0`
    in the subprocess environment, which shortens the gap itself (spike: `result`
    at about 0.7 s). The variable is undocumented in the CLI and may change or
    disappear with an SDK update, so it is off by default; the bench catches a
    regression. The legacy runner (`CORE_AGENT_PERSISTENT=off`) still ends a turn
    at the end of the iterator and pays the gap on resumed sessions.
- **Cancel (barge-in):** `Session` cancels confirmations as today
  (`broker.cancelAll`), then `DeviceAgent.interrupt()` (or aborts the attempt's
  `signal`) → `Query.interrupt()`. The `result` follows within about 10 ms as
  `subtype: "error_during_execution"` (spike Q5); after a host-side stop it maps
  to status `cancelled` (no `model_error`, no usage-limit check). The next
  attempt is not sent until the interrupted one has drained. An attempt that is
  cancelled while still queued is never sent. A cancel after `done` does nothing
  (the answer is already out). The client already waits for `state: idle` before
  its next turn ([03 §How the app uses it](03-platform-adapter.md#how-the-app-uses-it)).
  An interrupted write is **never replayed**.
- **Socket close:** same as today: it cancels the running turn and denies pending
  confirmations. The `DeviceAgent` stays alive until its idle timeout, so a
  reconnect is fast.
- **Turn timeout (new):** `CORE_TURN_TIMEOUT_MS` (default 120000), from send. On
  expiry the agent calls `interrupt()`, the attempt ends with status `timeout`
  and the session sends `error model_error`. This also guards against a CLI that
  waits silently for a usage-limit reset. After `done` the timer is restarted
  once for the tail up to `result`, so a stuck `result` cannot block the queue.
- **Interrupt watchdog:** if no `result` follows an `interrupt()` within 5 s, the
  agent is closed and marked dead. It never fired in the spike; it stays as a
  safety net. A `shouldQuery: false` note without a `result` within 10 s is
  handled the same way.
- **Tool loop guard:** `maxTurns: 12` counts per user message (spike Q4), so it
  stays the main limit. A host-side cap of 12 top-level tool calls per attempt,
  counted from `tool_use` blocks, stays as defence in depth (one model turn can
  call several tools); past it the agent calls `interrupt()` and the attempt ends
  with status `tool_cap`.

### Idle close, prewarm, process death

- **Prewarm:** when a device authenticates (`hello`), `Session` calls
  `registry.prewarm(device)`, which starts the query (with `resume` from A4)
  unless one is already running. When the user speaks, the process and the HA
  MCP connection are usually already up (process + MCP connect take about 3.5 to
  4 s, spike Q1). Readiness is `Query.initializationResult()` resolved
  (`DeviceAgent.ready()`); `system/init` is not a readiness signal, because it is
  sent only with the first user message and then again on every turn.
  `startup()`/`prewarm()` are not used. `CORE_AGENT_PREWARM=off` disables this.
- **Idle close:** after `CORE_AGENT_IDLE_MIN` minutes (default 10) without an
  attempt, and only when no attempt or confirmation is pending, the agent calls
  `close()`. The next turn starts a new query with `resume` (cold path, but the
  conversation continues, see A4). Each warm agent holds roughly 250 MB.
- **MCP freshness:** before an attempt, if the last attempt was more than 5 minutes
  ago, the agent calls `mcpServerStatus()` (a local control call, about 3 ms;
  after 15 idle minutes HA was still `connected` in the spike, Q11). If Home
  Assistant is not `connected`, it calls `reconnectMcpServer("home-assistant")`,
  bounded by the service timeout. A failed reconnect does not block the turn: the
  model sees the tool error, as today.
- **Process death:** if the pump ends or throws outside `close()`, the agent is
  marked dead. The running attempt resolves with status `dead` (`model_error`;
  partial text is kept as today) and queued work is dropped. The next turn creates
  a new agent with `resume` = the dead agent's last `sessionId` (the session id
  stays the same across `resume`, spike Q8). A dead agent is never restarted in a
  loop: `RestartBackoff` (device-agent.ts) blocks replacements for 30 s after two
  deaths within 5 minutes; in that window turns use the legacy runner.

### Usage records and the conversation log

- `inputTokens`, `outputTokens` and cache tokens come from the per-turn
  `result.usage`, so `TurnStream` stays as it is. They are known at `settled`,
  not at `done` (see *Turn boundaries*).
- `costUsd` is the difference between this `result.total_cost_usd` and the
  previous `result` of the same query (the results of `shouldQuery: false` notes
  move the baseline too; their cost does not change). A fresh query starts from
  0. The first result after a `resume` has no baseline (it already contains
  earlier turns), so `costUsd` is left out for that turn; so is a result whose
  total is lower than the baseline (a crash result may carry zeroed totals). The
  token fields are still exact.
- The model of a turn is read from its top-level `assistant` messages
  (`message.model`), falling back to the requested model. `modelUsage` is
  cumulative across models in one query (spike Q3) and is not used per turn.
- Tier-0 exchanges: today `Session.directNotes` (in memory, per socket) is put in
  front of the next model prompt. Records are always wrapped in `<bilgi>` …
  `</bilgi>` lines (agent.ts `wrapDirectNotes`, or `buildTurnEnvelope({ notes })`)
  so that a question in the same message is still answered (`system.md`); S6
  replaces the `DIRECT_NOTES_HEADER` prefix in `Session.withDirectNotes()` with
  this. In persistent mode the exchange is sent as a `shouldQuery: false` user
  message (the wrapped "Kullanıcı: … / Shadow: …" record) through
  `ProviderSession.appendNote` when `capabilities.notes`. It
  then lives in the SDK transcript, survives reconnects and needs no buffer
  (spike Q7: the content reaches the next turn, also after a resume). The note
  gets its own `result` (`success`, `num_turns: 0`, about 70 ms); it is queued
  like an attempt, and the next attempt is sent only after that `result`.
  `system.md` tells the model not to answer these notes.
- New conversation-log kind `timing` (per model turn):
  `{kind:"timing", id, tier, warm, queryAgeMs, routeMs, firstDeltaMs, doneMs, sdkDurationMs, firstSpeechMs?}`.
  All values are ms from receiving the frame (for voice: from the transcript).
  `warm` is true when the query was already running before the turn.
  Readers ignore unknown kinds, so the log format stays compatible.

### Usage limit

The subscription's usage limit has to reach the user as a clear message, not a
generic failure:

- Detection, in this order: a `result` error or assistant text that starts with one
  of `USAGE_LIMIT_ERROR_PREFIXES`; `SDKAssistantMessageError` `"rate_limit"`
  together with a recent `rate_limit_event` with `status: "rejected"`. A
  `rate_limit_event` with status `allowed_warning` is only logged.
- Effect: attempt status `usage_limit`; the limit text is not emitted as answer
  text. `error` frame with the new code `usage_limit` and optional `retryAt`
  (epoch ms, from `rate_limit_info.resetsAt`, which the CLI reports in epoch
  seconds; values below 1e12 are multiplied by 1000). No escalation, no
  agent restart, no retry. The memory extraction pass (06) is suspended until
  `retryAt` (or one hour if unknown).
- Clients must already treat unknown codes as generic errors
  ([02 §Errors](02-core-protocol.md#errors)), so this is backward compatible. The
  UI shows a Turkish text ("Kullanım limitine ulaşıldı; HH:MM'de sıfırlanır.").
- Because `USAGE_LIMIT_ERROR_PREFIXES` is `@alpha`, the Core keeps a fallback copy
  of the prefixes and a unit test that fails when the SDK export changes.

### Several sockets for one device

A token is a device. Two browser tabs with the browser token share one
conversation and one `DeviceAgent`. One attempt runs per device: a turn from
the second socket during a running turn gets `error busy` (today: one turn per
socket). The frames of a turn go to the socket that started it.

### Configuration (new environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `CORE_AGENT_PERSISTENT` | `on` | `off`: fresh `query()` per turn (current behaviour) |
| `CORE_AGENT_IDLE_MIN` | `10` | close a device's process after this many idle minutes |
| `CORE_AGENT_PREWARM` | `on` | start the device's query on `hello` |
| `CORE_TURN_TIMEOUT_MS` | `120000` | host-side limit per model turn |
| `CORE_AGENT_SKIP_TURN_SUMMARY` | off | `1`: `CLAUDE_CODE_CLASSIFIER_SUMMARY=0` for the SDK subprocess (undocumented CLI variable, see *Turn boundaries*); read by `subprocessEnv` |
| `CORE_CONTINUITY_MIN` | `30` | A4 window |

## A2. Sentence-by-sentence speech

### Decision

The **Core** splits the answer into sentences while it streams, applies the
pronunciation lexicon, and sends ordered speech chunks to clients that opt in.
Web clients get audio from tts-svc. The Android shell gets the lexicon-applied
sentence text for its native TTS. Old clients and the `speak` frame (voice
preview, legacy path) are unchanged.

| Option | Verdict |
|---|---|
| **Core-driven chunks** | **Chosen.** The Core already owns the lexicon, `clipForTts`, cancellation and the hiding of the escalation marker. It synthesizes sentence 1 while the model is still writing sentence 2, and one implementation serves every client. |
| Client-driven (UI splits deltas, one `speak` per sentence) | Rejected. It is a smaller first change, but the segmentation and the lexicon would move into or be duplicated in the UI. It adds a client→Core round trip per sentence, and the parallel `speak` calls would need reordering on the client. |

Tier-1 answers are buffered (escalation), so they arrive as one delta after
Haiku finishes. For them chunking only cuts synthesis time: the first sentence
is synthesized and played while the rest is synthesized. Tier 2/3 and tier-0
answers benefit fully.

### Protocol (backward compatible, protocol stays 1)

- `welcome` gets an optional `features: string[]`, e.g.
  `["speech_stream","memory","usage_limit"]`. Old clients ignore unknown fields.
  A new client that sees no `speech_stream` feature (old Core) keeps
  speak-after-done.
- New client frame `speech_prefs` (opt-in; can be sent again at any time):
  `{"type":"speech_prefs","enabled":true,"mode":"audio"|"text","voice"?:"tr_TR-dfki-medium"}`.
  `enabled:false` stops chunking (the voice-replies switch is off). `voice` follows
  `speak.voice` rules (absent/unknown = default). Before the first `speech_prefs`
  the Core sends no chunks, so old clients see no change.
- New server frame `speech_chunk`:
  `{"type":"speech_chunk","id":"t1","seq":0,"final":false,"mime":"audio/wav","data":"<base64>"}`
  in `audio` mode, `{"type":"speech_chunk","id":"t1","seq":0,"final":false,"text":"…"}`
  in `text` mode. `seq` starts at 0 per turn and has no gaps. The last frame of a
  turn has `final:true` (it may carry no `data`/`text` when it only marks the
  end). After a `cancel` of the turn, no further chunks are sent and no `final`
  is required; clients drop chunks of cancelled turns.
- A synthesis failure sends one `error tts_unavailable` with the turn `id`,
  stops synthesis for that turn and sends `{"type":"speech_chunk","id":"t1","seq":n,"final":true}`.
- Turns with an empty answer send nothing.

### Core

- `core/src/sentence-splitter.ts` (pure): it is fed deltas and emits finished
  chunks, and `flush()` at the end.
  - Boundary: `.`, `!`, `?`, `…` followed by whitespace, and newlines. Not a
    boundary: decimals (`21.5`, `21,5`), ordinals before a lowercase word
    (`3. kat`), a short abbreviation list (`Dr.`, `Sn.`, `vb.`, `vs.`, `örn.`,
    `No.`, `Prof.`, `Doç.`, `Av.`, `bkz.`), a dot run (`...`) that is not followed
    by whitespace.
  - The first chunk is emitted as soon as it has a boundary and at least 2 words.
    Later sentences shorter than 25 characters are merged into the next one.
    Chunks longer than 300 characters are cut at the last comma or space.
  - It never sees `[[ESCALATE]]`: it is fed from the same `live()` path as
    `assistant_delta` (after tier-1 buffering).
- `core/src/speech-stream.ts`: one per turn when the session has
  `speech_prefs.enabled`.
  - Chunk text → `pronunciations.apply` → `clipForTts` → in `audio` mode
    `tts.synthesize(…, signal, voice)`, in `text` mode the text itself.
  - Synthesis is sequential with **one chunk of lookahead** (at most two tts-svc
    requests in flight). Frames are sent strictly in `seq` order.
  - The turn's abort signal (and the session's side signal) aborts synthesis.
  - `firstSpeechMs` is written to the `timing` log entry.
- Typed and spoken turns are both spoken, as today (the UI decides through
  `enabled`).

### UI

- `controller.ts`: after `welcome` with `speech_stream`, send `speech_prefs`
  (mode `audio` for `tts.mode === "core"`, `text` for `"native"`; voice from
  Settings). Send it again when voice replies or the voice change.
- With streaming on, `assistant_done` no longer triggers `speakReply`, to avoid
  speaking twice. The `speak` frame stays for the voice preview ("Dene") and for
  an old Core.
- A playback queue per turn: chunks are played one after another through
  `adapter.playback.play(clip)` (core mode) or `adapter.tts.speak(text)` (native
  mode). Each call waits for the previous one to resolve. The phase is
  `speaking` from the first chunk until the queue is empty after `final`.
  Barge-in / `stop()` / `stopSpeaking()` stop the current clip and clear the
  queue. Chunks of cancelled turns are dropped (`isCancelled`, as today).
- The platform adapter interface does not change. The Android bridge already
  speaks one text per `tts.speak` call. [03](03-platform-adapter.md) gets the
  queue rule under *How the app uses it*.

## A4. Continuity across reconnects and Core restarts

### Decision

The Core keeps a small map device → last SDK session id in the data dir. A
device that connects within `CORE_CONTINUITY_MIN` (default 30) minutes of its
last model turn resumes that session, also after a Core restart. The map is
only a pointer: the conversation itself is the SDK transcript, which Claude Code
stores under the SDK `cwd` (`<SHADOW_DATA_DIR>/agent`, kept stable).

### File

`<SHADOW_DATA_DIR>/sessions/devices.json`:

```json
{
  "version": 2,
  "devices": {
    "browser": { "provider": "claude-sdk", "sessionId": "7c0e…", "lastTurnAt": 1767340800000, "updatedAt": 1767340801000 }
  }
}
```

- `provider`: the `ModelProvider.id` the conversation belongs to. A device
  whose stored pointer belongs to another provider starts a new conversation
  (the pointer is not resumed).
- `sessionId`: the last session id seen in that device's session. It is always
  taken from the messages, never assumed, because a resume may yield a new id.
- Version 1 files (`sdkSessionId`, no `provider`) are still read; their entries
  belong to `claude-sdk`. The next write is version 2.
- `lastTurnAt`: end of the last model turn (epoch ms). Tier-0 turns do not count.
- No text, no tokens, no client data. Device names and UUIDs only.

### Rules

- **Lookup** (when an agent starts): entry missing → new conversation. If
  `now - lastTurnAt > CORE_CONTINUITY_MIN` → new conversation and the entry is
  removed. The same window applies inside a running Core: a replacement session
  or a legacy fallback turn more than `CORE_CONTINUITY_MIN` after the device's
  last model turn starts a new conversation. Otherwise, for `claude-sdk`
  pointers, `getSessionInfo(sessionId, { dir: <agent cwd> })` (the
  spike confirms the option name): when it returns nothing (the transcript was
  deleted or cleaned up) → new conversation, logged as `continuity: missing`.
- **Write:** after each model turn, and only if the pointer or `lastTurnAt`
  changed. Writes are serialized in-process (one writer: the Core). They are
  atomic: write `devices.json.tmp-<pid>-<rand>`, `fsync`, rename over the target.
  On Windows, retry the rename up to 3 times with backoff on `EPERM`/`EBUSY`/`EACCES`
  (antivirus, sync clients). The shared helper `core/src/atomic-file.ts` is also
  used by memory (06).
- **Expiry:** expired entries are pruned on load and on every write.
- **Corruption:** invalid JSON, wrong shape or an unknown `version` → the file is
  renamed to `devices.json.corrupt-<ts>` (the newest 3 are kept), the Core
  starts with an empty map and logs one warning. Corruption never blocks start-up
  or a turn.
- **Shutdown:** the writer flushes on shutdown (`index.ts` shutdown chain).
- **Privacy:** the file holds no content. It sits in the self-ignoring data dir
  and goes into the encrypted backup ([05 §Backups](05-deploy.md#4-backups)).
  The transcripts themselves are written by Claude Code under the user profile
  (`~/.claude/projects/<encoded agent cwd>/`), as they are today. They are not in
  the data dir and not in the backup; Claude Code's default cleanup removes them
  after about 30 days. See [Decisions for the user](#kullanıcı-kararı-gerekebilir-decisions-for-the-user).
- **Not exactly-once:** continuity restores context, not side effects. If the
  Core crashes after a tool ran but before the answer, the next turn does not
  re-run anything by itself. The model only sees what the transcript recorded.

## Measurement

### Bench client

`core/scripts/bench-turn.ts` (new; `npm run bench -w core`) connects to `/ws` with
`BENCH_TOKEN` (use a dedicated `DEVICE_TOKEN_BENCH`, so the bench has its own
conversation and agent). It sends `user_text` turns one after another and
records, per turn, measured on the client:

- `t_first`: send → first `assistant_delta`;
- `t_done`: send → `assistant_done`;
- `t_speech`: send → first `speech_chunk` (after A2; it sends `speech_prefs`
  audio first) or → `speech` after its own `speak` (before A2).

It prints p50/p95 per scenario and writes a JSON result to
`<SHADOW_DATA_DIR>/bench/` (not committed).

### Scenarios

| # | Scenario | Text | Expected tier |
|---|---|---|---|
| 1 | simple text, warm | `Merhaba, bugün nasılsın?` | 1, no tool |
| 2 | HA read via model, warm | `Oturma odasındaki ışık açık mı?` | 1, `GetLiveContext` |
| 3 | first turn after `hello` | scenario 1 right after connecting | 1 (prewarm effect) |
| 4 | first turn after a Core restart | scenario 1 within 30 min | 1 (A4 resume) |
| 5 | voice end to end (manual) | push-to-talk "Merhaba" | audio → first sound, from the `timing` log |

Runs: 1 warm-up turn, then 10 turns per scenario (scenarios 3-4: 5 runs each).
The router decides the tier; check the `route` log entries to make sure no
scenario falls into tier 0.

### Procedure

1. **Before:** run the bench on the commit before S6 lands. Record the numbers in
   *Results* below.
2. **After:** the same run with S6 (and later S10).
3. Cross-check with the server side: the `timing` log entries (after S6) split
   each turn into routing, time to first delta, SDK duration and speech.

Acceptance: scenario 1 warm p50 ≤ 2.5 s `t_done`. Scenario 2 p50 should be at
most about 1 s above scenario 1. Scenarios 3 and 4 are reported, without a
target.

### Results

`t_done` (s, client-measured):

| Scenario | Before p50 / p95 | After p50 / p95 |
|---|---|---|
| 1 | 7.32 / 9.34 | 3.34 / 4.14 (back to back); 1.64 / 1.70 with `CORE_AGENT_SKIP_TURN_SUMMARY=1` |
| 2 | 9.04 / 9.39 | 5.36 / 7.38 (back to back) |
| 3 | 6.80 / 8.83 | – |
| 4 | 5.98 / 9.74 | – |

**Before (baseline), 2026-10-28**, code before S6 (the fresh-`query()`-per-turn
runner; the T7.8 router change was in the working tree but does not touch tier
1-3). A separate Core from source on its own port and data dir, `CORE_READ_ONLY=1`,
`DEVICE_TOKEN_BENCH`; `npm run bench` (in `core/`) with 5 runs per scenario (not 10, to
save subscription usage) after one warm-up turn. Every turn was routed to tier 1
(Haiku, rule `default`), none escalated, none fell into tier 0. Scenario 2 called
`GetLiveContext` (read-only) each time.

| Scenario | t_first p50 / p95 | t_done p50 / p95 | t_speech p50 / p95 | SDK `duration_ms` (log) |
|---|---|---|---|---|
| 1 simple text, warm | 7.32 / 9.34 | 7.32 / 9.34 | 7.87 / 9.61 | 1.3 to 5.0 s |
| 2 HA read, warm | 9.04 / 9.38 | 9.04 / 9.39 | 9.75 / 9.82 | 3.5 to 5.1 s |
| 3 first turn after `hello` | 6.80 / 8.83 | 6.80 / 8.83 | 7.29 / 9.34 | 1.2 to 4.4 s |
| 4 first turn after a Core restart | 5.98 / 9.74 | 5.98 / 9.74 | 6.36 / 10.07 | 0.8 to 5.5 s |

- `t_first` equals `t_done` because tier-1 text is buffered (escalation) and
  arrives as one delta.
- `t_speech` is the pre-A2 path: `speak` with the whole answer after
  `assistant_done`; synthesis of these short answers adds 0.3 to 0.6 s.
- Before A4, scenarios 3 and 4 start a new conversation (no `resume`), so they
  are not slower than the warm scenarios; scenario 1 resumes a growing session.
- Extra data point (not a baseline row): scenario 1 with
  `CLAUDE_CODE_CLASSIFIER_SUMMARY=0` in the SDK subprocess environment gave
  p50 6.39 s / p95 7.84 s (5 runs), see [Spike results](#spike-results) Q12.

**After S6/S8/S10 (first run), 2026-10-28**, persistent mode (default
settings), same setup as the baseline (separate Core from source, own port and
data dir, `CORE_READ_ONLY=1`, `DEVICE_TOKEN_BENCH`, 5 runs per scenario after
one warm-up turn, the bench sends `speech_prefs` audio). Every turn was routed
to tier 1 (Haiku, rule `default`); **no greeting was escalated** (no `route`
entry with `escalated`). Scenario 2 called `GetLiveContext` each time.

| Scenario | t_first p50 / p95 | t_done p50 / p95 | t_speech p50 / p95 | `timing` log (server) |
|---|---|---|---|---|
| 1 simple text, warm | 3.34 / 4.14 | 3.34 / 4.14 | 3.45 / 4.45 | `doneMs` 1.8 to 4.1 s, `sdkDurationMs` 3.7 to 5.0 s, `warm: true` |
| 1 with `CORE_AGENT_SKIP_TURN_SUMMARY=1` | 1.64 / 1.70 | 1.64 / 1.70 | 1.97 / 2.05 | – |
| 2 HA read, warm | 5.36 / 7.37 | 5.36 / 7.38 | 5.58 / 7.60 | `doneMs` 3.7 to 7.4 s |

- Analysis of the gap in scenario 1 with default settings: the bench sends the
  next turn right after `assistant_done`. That turn is queued until the
  previous turn's `result`, which comes about 2 s later (the CLI's end-of-turn
  summary classifier, spike Q12). The first measured run, whose previous turn
  was the first message of the session (no classifier), took 1.81 s; with the
  classifier switched off, all runs took 1.6 to 1.7 s. A user who pauses more
  than about 2 s between turns does not wait for the tail, so a real warm turn
  is expected at about 1.6 to 1.9 s. A bench with a pause between turns (S12)
  should confirm this.
- Cold start of a device session (prewarm on `hello`): ready in 2.3 to 2.4 s;
  the warm-up turn right after connecting took 5.8 s.
- Continuity (S8, manual): a code word given in one turn; the Core was killed
  and started again on the same data dir; the first session was `resumed`
  and the model answered the code word. Expiry after the window is covered by
  `device-registry.test.ts` (real `ContinuityStore`), not checked by hand.

## Failure modes

| Failure | Behaviour |
|---|---|
| Agent process fails to start | This turn runs on the legacy runner (`resume` of the last session id); the registry tries again on the next turn (backoff after repeated deaths) |
| Process dies mid-turn | `model_error`, partial text kept; nothing is replayed; next turn resumes |
| HA SSE dropped while idle | `reconnectMcpServer` before the turn; otherwise a tool error the model reports |
| `interrupt()` gives no `result` within 5 s | the agent is closed and marked dead; next turn resumes |
| Usage limit | `error usage_limit` (+`retryAt`); no escalation, no restart |
| `devices.json` corrupt or unwritable | warning; new conversation; turns are unaffected |
| tts-svc fails mid-answer | one `error tts_unavailable`, `final` chunk; text answer complete |

## Kullanıcı kararı gerekebilir (decisions for the user)

Each item has a default so that implementation can go ahead.

1. **Escalation keeps the Haiku attempt in the history** (no fork). It costs a few
   tokens per escalation. Default: accept.
2. **Idle close after 10 min, continuity window 30 min.** A warm device process
   uses about 250 MB of RAM. Default: 10 / 30.
3. **One conversation per device token:** two tabs with the same token share the
   conversation, and a turn from the second gets `busy` while the first runs.
   Default: accept (separate tokens for separate conversations).
4. **Closing the socket still cancels the running turn** and denies its
   confirmations, as today. Keeping turns alive across reconnects is a separate
   feature. Default: unchanged.
5. **SDK transcripts stay under `~/.claude/projects`**, outside the data dir and
   the backup (about 30 days of retention). Default: unchanged.
6. **`tierN.services` becomes an execution limit, not a token saving**, in
   persistent mode. Default: accept (the key is unused today).

## Implementation tasks

Boxes: `[ ]` not started, `[~]` started, `[x]` done. **Files** lists everything a
task may touch. Two tasks that share a file are never run in parallel; the
**After** column enforces this. **Data** marks tasks that write persistent data.

| Task | Files | After | Data |
|---|---|---|---|
| S1 | `core/scripts/spike-agent-sdk.ts` (new), this doc §Spike results | – | SDK transcripts (spike cwd only) |
| S2 | `core/scripts/bench-turn.ts` (new), `core/package.json` | – | `bench/` results |
| S3 | `core/src/atomic-file.ts` (new), `core/test/atomic-file.test.ts` (new) | – | helper for persistent data |
| P1 | `core/src/protocol.ts`, `core/test/protocol.test.ts`, `ui/src/protocol/types.ts`, `ui/src/protocol/protocol.test.ts`, `docs/02-core-protocol.md` | – | – |
| S4 | `core/src/device-agent.ts` (new), `core/test/device-agent.test.ts` (new) | S1 | – |
| S5 | `core/src/agent.ts`, `core/test/agent*.test.ts`, `core/prompts/tier1.md`, `core/prompts/system.md` | S1 | – |
| S6 | `core/src/device-registry.ts` (new), `core/src/session.ts`, `core/src/index.ts`, `core/src/config.ts`, `core/src/server.ts`, `core/src/conversation-log.ts`, `core/test/session*.test.ts`, `docs/04-router.md`, `.env.example` | S2 (baseline), S4, S5, P1 | SDK transcripts |
| S7 | `core/src/continuity.ts` (new), `core/test/continuity.test.ts` (new) | S3 | `sessions/devices.json` |
| S8 | `core/src/device-registry.ts`, `core/test/device-registry.test.ts` | S6, S7 | `sessions/devices.json` |
| S9 | `core/src/sentence-splitter.ts` (new), `core/src/speech-stream.ts` (new), their tests (new) | – | – |
| S10 | `core/src/session.ts`, `core/test/session*.test.ts` | S6, S9, P1 | – |
| S11 | `ui/src/assistant/controller.ts`, `ui/src/assistant/state.ts`, `ui/src/assistant/*.test.ts`, `ui/src/ui/strings.ts`, `docs/03-platform-adapter.md` | P1 | – |
| S12 | this doc §Results, `docs/01-v1-plan.md` boxes | S8, S10, S11 | – |

Parallel lanes: {S1, S2, S3, P1, S9, S11} can start at once. S4 and S5 run in
parallel after S1. S7 needs only S3. S6, S8 and S10 are serialized on
`session.ts`/`device-registry.ts`.

- [x] **S1 — SDK spike.** A throwaway script against the real CLI (own `cwd`) that answers the questions in [S1 spike questions](#s1-spike-questions); results go into §Spike results. Acceptance: every question answered with an observed result; the design is updated where an answer contradicts it. — answers recorded; design sections updated (Turn boundaries, Cancel, timeouts, tool-call cap, prewarm readiness, usage records, usage limit), see §Spike results → Design impact.
- [x] **S2 — Bench client and baseline.** As in [Measurement](#measurement). Acceptance: before numbers for scenarios 1-4 are recorded in §Results. — baseline 2026-10-28, 5 runs per scenario.
- [ ] **S3 — Atomic file helper.** `writeFileAtomic(path, data)` (temp + fsync + rename, Windows retry), `readJsonOrQuarantine(path, validate)` (returns `undefined` and renames corrupt files, keeps 3). Acceptance: unit tests for a crash between write and rename (the old file stays intact), a corrupt file being quarantined, and the retry path (mocked `EPERM`).
- [ ] **P1 — Protocol additions (shared with 06).** Types, parsing and docs for: `welcome.features`; client `speech_prefs`, `memory_list`, `memory_delete`; server `speech_chunk`, `memory`; error codes `usage_limit` (+ optional `retryAt`). Frame shapes for memory: [06 §Protocol](06-memory.md#protocol). Acceptance: parser tests for every new frame (valid, invalid, unknown fields ignored); docs/02 tables updated; old frames unchanged.
- [x] **S4 — DeviceAgent.** Input queue, output pump, `runAttempt` resolving at `result`, `setModel` only on change, `interrupt` with drain, the 5 s interrupt watchdog, idle timer, dead detection, `costUsd` diffing, usage-limit detection (with the fallback prefix copy), tool-call cap, gate dispatcher with attempt capture. Tested with a fake `Query` (an async generator plus spies for the control methods). Acceptance: tests for two sequential attempts on one query, a model switch, interrupt then next attempt, death mid-attempt, a stale gate call denied, usage-limit mapping and the cost diff. — done 2026-10-28: `core/src/device-agent.ts` (`DeviceAgent`, `RestartBackoff`), 20 tests in `core/test/device-agent.test.ts` (fake `Query`), also visible end before `result`, `shouldQuery:false` notes, idle close, turn timeout, watchdog, MCP freshness; one Haiku smoke run. Independent review/test pending (team lead). Follow-up 2026-10-28 (provider interface + review fixes): `core/src/model-provider.ts` (neutral `ModelProvider`/`ProviderSession`), `ClaudeSdkProvider` with `oneShot`, `DeviceAgent implements ProviderSession` (+ `setModel()`); limit text streamed as deltas is held back and ends as `usage_limit` (also after a visible end); `setModel` bounded by `setModelTimeoutMs` (die on expiry); throwing callbacks cannot leave an attempt pending; a zeroed result no longer lowers the cost baseline; 28 tests.
- [x] **S5 — Static prompt and options.** `tier1.md` conditional on `[mod:hizli]`; one system prompt for all tiers; `buildOptions` for the persistent mode (streaming prompt, no per-turn `resume`/`forkSession`, gate dispatcher); `SdkAgentRunner` kept for the legacy mode. Acceptance: existing agent tests pass; a new test checks that the options of the persistent mode do not depend on the tier. — done 2026-10-28: `buildPersistentOptions`, `persistentSystemPrompt`, `buildTurnEnvelope`/`TIER1_MARKER`, `CORE_AGENT_SKIP_TURN_SUMMARY` in `subprocessEnv`; the legacy runner prefixes escalatable prompts with the marker so the conditional `tier1.md` keeps working before S6. Watch in S6: in the one smoke run Haiku answered a marked `Merhaba, bugün nasılsın?` (fresh session) with `[[ESCALATE]]`; check the escalation rate with the bench. Follow-up 2026-10-28: `tier1.md` rewritten (greetings, small talk and thanks are never escalated; only clearly multi-step/multi-device/plan/comparison/long-explanation requests; vague requests get a short question; no "emin değilsen"); tier-0 records are delimited (`DIRECT_NOTES_START/END`, `wrapDirectNotes`, `buildTurnEnvelope({ notes })`) and `system.md` says to answer the request after `</bilgi>`. S6 must switch `Session.withDirectNotes()` (and `appendNote` texts) to `wrapDirectNotes`.
- [~] **S6 — Registry and session wiring.** `DeviceRegistry` (lazy create, prewarm on hello, idle close, crash backoff, legacy fallback); `Session` uses it; escalation in-session; tier-0 exchanges as `shouldQuery:false` (or `directNotes` moved to the agent, per S1); per-tier service gate; `usage_limit` error frames; `timing` log kind; config variables; `docs/04-router.md` escalation and caching sections rewritten; `.env.example`. Acceptance: all session tests pass with a mocked registry; manual check of scenario 1 at p50 ≤ 2.5 s; cancel, confirm (button and voice) and escalation work end to end; `CORE_AGENT_PERSISTENT=off` behaves exactly as before. — implemented 2026-10-28: `core/src/device-registry.ts` (`DeviceRegistry`: lazy start shared by concurrent callers, prewarm on `hello`, ready timeout 30 s → legacy runner for that turn, idle/death replacement resuming the last id, per-device `RestartBackoff`; depends only on `model-provider.ts`); `Session` runs tiers 1-3 as attempts (`buildTurnEnvelope` with `[mod:hizli]`, escalation in-session with `ESCALATION_CONTINUE`, usage at `settled`, `busy` from another socket of the device, `error usage_limit` + `retryAt` with no answer text logged or shown); tier-0 records wrapped with `wrapDirectNotes` (also in legacy mode) and sent by `appendNote` when a session runs, else buffered; per-tier service gate (`tier_service`); `timing` log kind; `welcome.features` = `speech_stream`, `usage_limit`; config `CORE_AGENT_PERSISTENT/PREWARM/IDLE_MIN`, `CORE_TURN_TIMEOUT_MS`, `CORE_CONTINUITY_MIN`; legacy path unchanged without a registry (all old session/tier tests pass; only the tier-0 note format assertion in `tiers.test.ts` changed). Tests: `session-persistent.test.ts` (15). Open: independent review/test; manual end-to-end check of cancel, confirm (button/voice) and escalation; scenario 1 p50 is 3.34 s back to back, 1.64 s without the summary tail (see §Results analysis).
- [ ] **S7 — Continuity store.** `devices.json` load/lookup/write/expiry/quarantine on top of S3. Acceptance: unit tests for expiry, corruption, an unknown version, serialized writes, and the missing-transcript check (injected `getSessionInfo`).
- [x] **S8 — Continuity wiring.** The registry resumes from the store when it starts an agent, updates the store after each model turn and flushes on shutdown. Acceptance: manual: a turn, Core restart, reconnect within 30 min, and the model remembers the previous turn; after 30 min it does not. — done 2026-10-28: the registry asks the continuity port once per device and Core start, resumes only a pointer of its own provider, records `{provider, sessionId}` after every model turn (also legacy fallback turns) and flushes on shutdown (`index.ts` chain: server → registry → …). `continuityPort()` adapts the S7 store; its file has no provider field yet, so pointers are read as the current provider's (exact with one provider; a `provider` field in `continuity.ts` is a follow-up for a second provider). Manual restart check passed (see §Results); 9 tests in `device-registry.test.ts`. Independent review/test pending.
- [ ] **S9 — Sentence splitter and speech stream.** As in [A2 Core](#core). Acceptance: table tests with Turkish text (decimals, ordinals, abbreviations, punctuation split across deltas, a long sentence without punctuation); speech-stream tests for ordering with lookahead, cancel during synthesis, tts failure → one error + `final`, and the lexicon applied in both modes.
- [~] **S10 — Speech stream wiring.** `Session` handles `speech_prefs` and feeds the stream from the live text path (after tier-1 buffering and tier 0); `firstSpeechMs` goes into the `timing` log. Acceptance: session tests where an opted-in client gets `speech_chunk` frames in order and an old client gets none; scenario 5 shows the first sound before `assistant_done` for a multi-sentence tier-2 answer. — implemented 2026-10-28: `speech_prefs` stored per socket (latest wins, `enabled:false` stops); one `SpeechStream` per turn fed from the same live path as `assistant_delta` (after tier-1 buffering, tier 0 included), audio via tts-svc with voice/lexicon/clip, text mode for native TTS; a `cancel` (also after the visible end) stops it; `firstSpeechMs` in `timing`; `speak` unchanged. Session tests: chunks in order with `final`, no chunks for an old client or `enabled:false`, text mode, marker never spoken, cancel. Open: scenario 5 (manual, needs S11 UI) and independent review/test.
- [ ] **S11 — UI streaming playback and usage-limit text.** As in [A2 UI](#ui); Turkish text for `usage_limit`. Acceptance: controller tests: chunks played in order, barge-in clears the queue, no double speech after `assistant_done`, fallback to `speak` against a Core without `speech_stream`, native mode speaks the chunk texts.
- [ ] **S12 — After measurement.** The bench again; fill in §Results; tick the plan boxes. Acceptance: scenario 1 warm p50 ≤ 2.5 s, or a written analysis of the remaining gap.

### S1 spike questions

1. Streaming input: does the process start and connect the HA MCP server when
   `query()` is called (before the first message)? Compare with `startup()`.
2. Two user messages on one query: is there exactly one `result` per message, and
   does `session_id` stay the same?
3. `setModel()` between two messages: does the second turn use the new model
   (`modelUsage` keys), and how much does the call itself take?
4. `maxTurns`: does it count per user message or per query? (Send 13 short
   messages with `maxTurns: 12`.)
5. `interrupt()` during streaming text and during a pending `canUseTool`: is
   there a `result`, how long does it take, and does the next message work?
6. `canUseTool` across turns: is the same callback used for every turn, and is
   its `signal` aborted on interrupt?
7. `shouldQuery: false`: does the message reach the next turn's context without a
   reply?
8. `resume` of a session written by a persistent query, after `close()`: is the
   full context there? Does `session_id` change?
9. `getSessionInfo(id, …)`: which option points it at our `cwd`'s project
   folder?
10. `/compact` sent as a user message: is it supported in this mode (listed in
    `supportedCommands()`), does it emit `compact_boundary`, and how long does it
    take on a 30k-token session? (Needed by 06.)
11. HA SSE after 15 idle minutes: what does `mcpServerStatus()` report, and does a
    tool call still work?
12. A warm simple turn: wall time and `duration_ms`.

### Spike results

Run 2026-10-28 with `core/scripts/spike-agent-sdk.ts` (`npm run spike:sdk -- <phases>` in `core/`)
against SDK 0.3.311 and its bundled CLI, Haiku, own temp `cwd`, the real Home
Assistant MCP server over SSE (`alwaysLoad: true`, as the Core builds it). The
permission callback allowed only `GetLiveContext`. About 35 short model turns
in total (one ~73k-token message for Q10); no usage limit was hit
(`rate_limit_event` stayed `allowed` / `allowed_warning`).

| # | Answer | Evidence |
|---|---|---|
| 1 | **Yes.** `query()` with a streaming prompt starts the process at once and connects MCP before any user message: `initializationResult()` resolved 2.4 s after the call (3.7 s after `query()`), then `mcpServerStatus()` returned `home-assistant: connected` (6 ms). The `system/init` **message** is not sent until the first user message, and is sent again at the start of **every** turn (it is not a once-per-query event). `startup()` resolved after 3.8 s; the first turn on it had its first delta at 0.68 s and its result at 1.1 s. Starting the streaming `query()` early (prewarm on `hello`) gives the same effect, so `startup()` is not needed. | phases `main`, `startup` |
| 2 | **Yes.** Exactly one `result` per user message (11 messages incl. model switches and two interrupts), and `session_id` never changed. Note: also a `shouldQuery: false` message gets its own `result` (Q7). Between attempts the pump can see stray messages (a `user` message after a `result` was seen twice); they must be ignored. | `main` |
| 3 | **Yes.** `setModel("sonnet")` resolves in 3 to 5 ms; the next turn's `assistant.message.model` is the Sonnet model and the next `system/init` reports it. `modelUsage` is cumulative, so it then has both keys; the per-turn model must be read from the `assistant` messages, not from `modelUsage`. `setModel` with the current model is a 3 ms no-op. | `main` |
| 4 | **Per user message.** With `maxTurns: 2`, three messages in one query all ended `success` with `num_turns: 1`. `maxTurns: 12` keeps today's meaning; the host-side tool-call cap is not needed as a replacement (it may stay as defence in depth). | `maxturns` |
| 5 | **Result arrives, fast.** During streaming text: `interrupt()` resolved in 4 ms with `{still_queued: []}`, the `result` followed 10 ms after the call, as **`subtype: "error_during_execution"`, `is_error: true`** (with an internal `[ede_diagnostic] …` error string). During a pending `canUseTool`: the callback's `signal` was aborted at once, the same error result came 9 ms after `interrupt()`. In both cases the next message worked normally on the same query. The 5 s watchdog never fired. | `main` |
| 6 | **Yes.** The one `canUseTool` given at query start is called for tools in every later turn (called in two different turns). Each call gets its own `signal`, and it is aborted on `interrupt()`. The dispatcher-with-captured-attempt design works. | `main` |
| 7 | **Usable, with one difference.** The message is added without a model call and its content reached the next turn (the model recalled a code word given only in it, also after a resume). But it **does** produce a `result` of its own: `success`, `num_turns: 0`, `total_cost_usd` unchanged, no `assistant` message, ~70 ms. | `main`, `noquery` |
| 8 | **Yes.** After `close()`, a new query with `resume` had the full context (recalled the code word), and the `session_id` stayed the **same**. | `resume` |
| 9 | `getSessionInfo(id, { dir: <agent cwd> })` finds it (5 ms; `cwd` in the result matches). Without options it also finds it (searches all projects); with another `dir` and for an unknown id it returns `undefined`. Option name: `dir`. | `getinfo` |
| 10 | **Supported.** `compact` is in `supportedCommands()` and in `system/init.slash_commands`. Sending `/compact` as a user message emits `system/compact_boundary` (`trigger: "manual"`, `pre_tokens`, `post_tokens`, `duration_ms`) followed by a `result` (`success`, `num_turns: 0`), and the next turn works. Measured on a **73k-token** session (the filler was larger than planned): 6.4 s, 72.8k → 1.0k tokens. A 30k session should be faster. `getContextUsage({detail:"summary"})` reports the categories before/after. | `compact` |
| 11 | After 15 idle minutes `mcpServerStatus()` still reported `connected`, and a `GetLiveContext` call worked. The 5-minute freshness check stays as designed (cheap, 3 ms). | `idle` |
| 12 | **Warm turn in one query, with defaults: first delta 1.3 to 1.7 s, `result` 3.7 to 4.5 s, `duration_ms` ≈ the same.** From the second message of a session on, the CLI runs an end-of-turn LLM classifier and emits `system/post_turn_summary` right before `result`; this adds about **2 to 2.5 s between `message_stop` and `result`**. With `CLAUDE_CODE_CLASSIFIER_SUMMARY=0` in the subprocess environment (an undocumented CLI variable, found in the bundled CLI; it switches the summary to a heuristic), the same warm turns took **first delta 0.5 to 0.7 s, `result` 0.67 to 0.69 s**. | `trace` with and without the variable |

#### Design impact (where a fallback or change is needed)

- **Turn end vs `result` (Q12): changed.** Waiting for `result` costs ~2 s per
  warm turn with default settings; this alone would miss the 2.5 s target. Options
  were (a) `CLAUDE_CODE_CLASSIFIER_SUMMARY=0` in `subprocessEnv` (undocumented,
  may change with a CLI update) and (b) ending the user-facing turn at the
  top-level `message_stop` with `stop_reason: "end_turn"`, keeping `result` as the
  internal attempt boundary. **Decision (team lead): (b) by default, (a) as opt-in**
  `CORE_AGENT_SKIP_TURN_SUMMARY=1`. Implemented in S4/S5, see
  [Turn boundaries](#turn-boundaries-cancel-timeouts). The legacy runner pays the
  same delay on resumed sessions. S4/S5 smoke test (Haiku, two turns, no MCP):
  `done` at 1.5 s, `settled` at 4.1 to 4.3 s.
- **Interrupt result (Q5):** the `result` after our own `interrupt()` is
  `error_during_execution`. `DeviceAgent` must map it to "cancelled" (no
  `model_error`, no usage-limit check). The interrupt-and-drain plan works as
  designed; the 5 s watchdog stays as a safety net.
- **`shouldQuery: false` (Q7):** usable, so `directNotes` is not needed. But it
  yields its own `result`: `DeviceAgent` must count one `result` per sent message
  (including non-querying ones) and must not take that `result` as the end of a
  following attempt. Simplest: send the note as its own queued item and wait for
  its `result` before sending the next attempt.
- **`maxTurns` (Q4):** no fallback needed; keep `maxTurns: 12`.
- **`system/init` (Q1):** repeats per turn; do not use it as "query started".
  Readiness for prewarm = `initializationResult()` resolved.
- **Per-turn model (Q3):** `modelUsage` is cumulative across models; take the
  model of a turn from its `assistant` messages (or the requested tier model).
- **Cold start (Q1):** process + MCP connect take about 3.5 to 4 s; prewarm on
  `hello` hides this. `startup()`/`prewarm()` are not needed.
- No fallback needed for Q2, Q6, Q8, Q9 (`dir`), Q10, Q11.
