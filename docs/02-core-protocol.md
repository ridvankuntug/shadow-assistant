# Core WebSocket protocol v1

The Core exposes one WebSocket endpoint that every client (web UI, Android
shell) uses. TypeScript types for all frames live in a single module:
[`core/src/protocol.ts`](../core/src/protocol.ts).

- Endpoint: `ws://<core-host>:<CORE_PORT>/ws` (default port `8700`, default bind `127.0.0.1`).
- Health: `GET http://<core-host>:<CORE_PORT>/health` →
  `200 {"status":"ok","service":"core","version":"…","services":[{"name":"…","enabled":true,"status":"down","detail"?:"timeout"}]}`
  (`status` and `detail` as in *Service health*; `status` is `unknown` before the first check round and
  `detail` is present only when the check set one. No URLs, tokens or error messages.)
- Every frame is a JSON **text** frame with a `type` field. Binary frames are rejected.
- `id` is a client-generated turn id (string, 1–128 chars). The Core echoes it on
  every frame that belongs to that turn.
- Max frame size: 36 MB (base64 audio included). Max `text` length: 4000 chars.

## Authentication

1. The first client frame **must** be `hello`, sent within **5 s** of connecting.
2. The token goes in the `hello` frame, never in the URL.
3. On success the Core replies `welcome` followed by `state: idle` and, once the
   first health round has finished, `services` (see *Service health*).
4. On a missing/late/invalid hello or a wrong token the Core sends
   `{"type":"error","code":"unauthorized","message":"…"}` and closes with code **4401**.
5. An unsupported `protocol` number gets `error bad_request` and close code **4400**.

Device tokens come from `DEVICE_TOKEN_<NAME>` environment variables (one per
device, at least 16 characters; empty values are ignored). The device name is
the lower-cased `<NAME>` (e.g. `browser`, `android`). Tokens are compared in
constant time and are never logged. Without any configured token the Core
refuses to start.

## Client → Core

| Frame | Meaning |
|---|---|
| `{"type":"hello","protocol":1,"token":"…","client":"web"\|"android","clientVersion":"…"}` | Authenticate (first frame only). |
| `{"type":"user_text","id":"t1","text":"…"}` | Start a turn with typed text. |
| `{"type":"audio","id":"t2","mime":"audio/webm","data":"<base64>"}` | One complete utterance (push-to-talk). See *Voice input*. |
| `{"type":"confirm_response","requestId":"c1","approved":true}` | Answer a confirmation with the on-screen button. |
| `{"type":"speak","id":"t1","text":"…","voice"?:"tr_TR-dfki-medium"}` | Ask the Core to synthesize speech via tts-svc (web adapter). `voice` is optional; see *Voices*. The text is spoken through the *Pronunciation lexicon*. |
| `{"type":"voices","id":"v1"}` | List the selectable tts-svc voices; answered by `voices` or `error tts_unavailable` (with the same `id`). See *Voices*. |
| `{"type":"cancel","id":"t1"}` | Barge-in: stop turn `t1`. |
| `{"type":"history_request","limit":20}` | Recent conversation items (default 20, max 100). |
| `{"type":"ping"}` | Keep-alive; answered with `pong`. |
| `{"type":"speech_prefs","enabled":true,"mode":"audio"\|"text","voice"?:"tr_TR-dfki-medium"}` | Opt in to streamed speech for this socket's turns (feature `speech_stream`). See *Streamed speech*. |
| `{"type":"memory_list","id":"m1"}` | Ask for the memory contents (feature `memory`). See *Memory*. |
| `{"type":"memory_delete","id":"m2","entryId":"m-7f3a9c"}` | Delete one memory entry (feature `memory`). See *Memory*. |

## Core → Client

| Frame | Meaning |
|---|---|
| `{"type":"welcome","protocol":1,"sessionId":"…","device":"browser","features"?:["speech_stream","memory","usage_limit"]}` | Authenticated. `features`: see *Features*. |
| `{"type":"state","state":"idle"\|"thinking"\|"awaiting_confirm"}` | Server-side state. `listening` and `speaking` are client-local states. |
| `{"type":"transcript","id":"t2","text":"…"}` | Result of speech-to-text for an `audio` frame. |
| `{"type":"assistant_delta","id":"t1","text":"<chunk>"}` | Streaming answer chunk. |
| `{"type":"assistant_done","id":"t1","text":"<full text>"}` | Answer finished (also sent after `cancel`, with the partial text). |
| `{"type":"tool","id":"t1","name":"<tool>","status":"started"\|"done"\|"denied"\|"error"}` | Tool activity. |
| `{"type":"confirm_request","requestId":"c1","id":"t1","tool":"<tool>","summary":"…","expiresAt":<epoch ms>}` | The turn is paused until the user confirms. |
| `{"type":"confirm_resolved","requestId":"c1","approved":true\|false,"by":"button"\|"voice"\|"timeout"}` | Sent exactly once per `confirm_request`. |
| `{"type":"speech","id":"t1","mime":"audio/wav","data":"<base64>"}` | Synthesized audio for a `speak` request. |
| `{"type":"speech_chunk","id":"t1","seq":0,"final":false,"mime"?:"audio/wav","data"?:"<base64>","text"?:"…"}` | One sentence of a turn's spoken answer, only after `speech_prefs` with `enabled:true`. See *Streamed speech*. |
| `{"type":"memory","id":"m1","brief":{…},"topics":[…],"warnings":[…]}` | Reply to `memory_list` / `memory_delete`. See *Memory*. |
| `{"type":"voices","id":"v1","default":"tr_TR-dfki-medium","voices":[{"id":"tr_TR-dfki-medium","label":"DFKI (orta kalite)","quality":"medium"}]}` | Reply to a `voices` request. Added in protocol 1 without a version bump. |
| `{"type":"history","items":[{"id":"…","role":"user"\|"assistant","text":"…","ts":<epoch ms>}]}` | Oldest first. |
| `{"type":"error","id"?:"t1","code":"…","message":"…","retryAt"?:<epoch ms>}` | See *Errors*. `retryAt` only with `usage_limit`. |
| `{"type":"services","items":[{"name":"whisper-svc","status":"ok"\|"loading"\|"down"\|"disabled","checkedAt":<epoch ms>,"detail"?:"timeout"}]}` | Service health; see *Service health*. Added in protocol 1 without a version bump. |
| `{"type":"pong"}` | Reply to `ping`. |

Clients must ignore frame types they do not know (that is how `services` and
`voices` were added without a version bump). They must also ignore unknown
fields of known frames.

### Features

`welcome.features` (optional, array of strings) lists optional capabilities of
this Core. A missing array means none. Clients ignore names they do not know.
The protocol number stays 1.

| Feature | Meaning |
|---|---|
| `speech_stream` | The Core understands `speech_prefs` and sends `speech_chunk` frames to clients that opted in. Without it a client speaks the answer itself after `assistant_done` (`speak`). |
| `memory` | Memory is enabled: `memory_list` / `memory_delete` are answered. Without it clients hide the memory settings. |
| `usage_limit` | The Core reports a reached subscription usage limit as `error usage_limit` (+ `retryAt`). |

Old clients ignore `features`. A Core sends `speech_chunk` only after the
client's first `speech_prefs`, so clients that never send it see no change.

Tool names in `tool` and `confirm_request` frames are the service's own tool
names (e.g. `homeassistant__GetLiveContext`, `intent__HassTurnOff`), without the
Agent SDK's `mcp__<service>__` prefix.

### Errors

| `code` | When |
|---|---|
| `unauthorized` | Bad/missing hello or token (socket is closed with 4401). |
| `bad_request` | Malformed frame, invalid base64/empty audio, audio > 25 MB, no speech recognized, speech service rejected the input, unsupported protocol. |
| `stt_unavailable` | whisper-svc not configured, unreachable, loading (503) or timed out. |
| `tts_unavailable` | tts-svc not configured, unreachable, loading or timed out; also a selected voice that is still being downloaded/loaded (retry shortly) or failed to load, and a `voices` request while tts-svc is not ready. |
| `model_error` | The model turn failed (auth, API, max turns, …). The client should show a short failure message; partial text may follow as `assistant_done`. |
| `busy` | A turn is already running (one turn per session at a time). |
| `usage_limit` | The subscription's usage limit is reached. Optional `retryAt` (epoch ms) is when it resets. The turn is not retried or escalated. The client should show the reset time when it is known. |
| `internal` | Unexpected server error. |

Clients must treat unknown `code` values as generic errors.

## Streamed speech

With the feature `speech_stream`, the Core splits the answer into sentences while
it streams, applies the *Pronunciation lexicon* and sends ordered
`speech_chunk` frames to clients that opted in. Design:
[`docs/07-speed.md` §A2](07-speed.md#a2-sentence-by-sentence-speech).

`speech_prefs` (client → Core) can be sent at any time; the latest one applies
to later chunks:

| Field | Type | Meaning |
|---|---|---|
| `enabled` | boolean, required | `false`: no chunks (voice replies are off). |
| `mode` | `"audio"` \| `"text"`, required | `audio`: tts-svc clips (web). `text`: the lexicon-applied sentence text, for a client that speaks with on-device TTS (Android). |
| `voice` | string, optional | As `speak.voice`: absent, `null`, empty, over-long or unknown ids use the default voice. A non-string `voice` is a `bad_request`. Used in `audio` mode. |

Before the first `speech_prefs` the Core sends no chunks.

`speech_chunk` (Core → client):

```json
{"type":"speech_chunk","id":"t1","seq":0,"final":false,"mime":"audio/wav","data":"<base64>"}
{"type":"speech_chunk","id":"t1","seq":1,"final":false,"text":"Salon ışığı açıldı."}
{"type":"speech_chunk","id":"t1","seq":2,"final":true}
```

- `audio` mode carries `mime` + `data`, `text` mode carries `text`.
- `seq` starts at 0 per turn and has no gaps; frames are sent in `seq` order.
- The last frame of a turn has `final: true`. It may carry no `data`/`text`
  when it only marks the end.
- After a `cancel` of the turn no further chunks are sent, and no `final` is
  required. Clients drop chunks of turns they cancelled.
- A synthesis failure sends one `error tts_unavailable` with the turn `id`,
  stops synthesis for that turn and sends a payload-less `final` chunk. The text
  answer is still complete.
- A turn with an empty answer sends no chunks.
- With streaming on, a client does not send `speak` for the answer (it would be
  spoken twice). `speak` stays for voice previews and for Cores without the
  feature.

## Memory

With the feature `memory`. Design: [`docs/06-memory.md`](06-memory.md).

```json
{"type":"memory","id":"m1",
 "brief":{"chars":412,"budget":800,"entries":[{"id":"m-a1b2c3","text":"Kullanıcının adı Rıdvan."}]},
 "topics":[{"topic":"ev","title":"Ev ve cihaz adları","chars":96,
            "entries":[{"id":"m-7f3a9c","text":"Otomodos = oturma odası","updatedAt":1767340800000}]}],
 "warnings":[{"code":"note_over_budget","topic":"tercihler"}]}
```

- `memory_list` is answered with `memory` (same `id`).
- `memory_delete` deletes one entry (brief or note); the fact is tombstoned so
  it is not learned again. It is answered with a fresh `memory` frame (same
  `id`). An unknown (or already deleted) `entryId` gets `error bad_request`
  (with `id`); a write failure gets `error internal` (with `id`).
- With memory disabled (`CORE_MEMORY=off`) both requests get `error bad_request`
  ("memory is disabled").
- `entries[].updatedAt` (epoch ms) is optional. `warnings[].code` is one of
  `note_over_budget`, `note_full` (both with `topic`) and `memory_full`; clients
  show unknown codes as free text.
- Memory frames go only to the requesting socket.

## Voices

`{"type":"voices","id":"v1"}` returns the voices tts-svc can speak with:

```json
{"type":"voices","id":"v1","default":"tr_TR-dfki-medium",
 "voices":[{"id":"tr_TR-dfki-medium","label":"DFKI (orta kalite)","quality":"medium"},
           {"id":"tr_TR-fahrettin-medium","label":"Fahrettin (orta kalite)","quality":"medium"},
           {"id":"tr_TR-fettah-medium","label":"Fettah (orta kalite)","quality":"medium"}]}
```

- `default` is tts-svc's default voice (`TTS_VOICE`); it is always the first entry of `voices`.
- `voices` lists loaded voices and voices tts-svc can download on first use
  (tts-svc `/health` `available`). `label` is a human-readable Turkish name built
  from the id; `quality` is Piper's quality (`x_low`, `low`, `medium`, `high`) and
  is absent for ids outside Piper's `<lang>-<name>-<quality>` scheme.
- The list comes from tts-svc's `GET /health` and is cached for 30 s. If tts-svc is
  not configured, unreachable or not ready, the reply is
  `{"type":"error","id":"v1","code":"tts_unavailable","message":"…"}`.

`speak.voice` selects a voice by `id`. It is optional: absent, `null`, empty or
unknown ids (not in the current list) use the default voice — never an error. A
non-string `voice` is a `bad_request`. The choice is per `speak` frame; the Core
stores no per-client voice.

The first `speak` with a voice that tts-svc has not loaded yet makes tts-svc
download (~63 MB, SHA-256 verified) and load it. tts-svc waits up to
`TTS_VOICE_LOAD_WAIT_S` (default 20 s, below the Core's 30 s tts-svc timeout)
and then answers "still loading"; the Core reports that as
`error tts_unavailable` ("… still loading voice …; try again shortly") while the
download continues, so a later `speak` succeeds. A voice already on disk loads
in a few seconds and normally succeeds on the first request. Clients may fall
back to the default voice (omit `voice`) when this happens.

## Pronunciation lexicon

Before synthesis the Core passes `speak.text` through a pronunciation lexicon,
so the Turkish voices say e.g. "Shadow" as "Şadov". Only the text sent to
tts-svc changes; the client's displayed text, transcripts and conversation
records keep the original. The lexicon is the repo-root `pronunciations.yaml`
(path override: `SHADOW_PRONUNCIATIONS_FILE`), a flat `word or phrase: spelling`
mapping read once at Core start. A missing file means no rewriting; an invalid
file is ignored with a warning (the Core still starts).

Matching: whole words only (Unicode letters, digits and `_` are word
characters, so `Shadowlar` is untouched unless listed itself); case-insensitive
including Turkish I/ı/İ/i, the replacement inserted as written (`SHADOW` →
`Şadov`); a suffix after `'` or `’` is kept (`Shadow'u` → `Şadov'u`); multi-word
keys allowed, longest key first. The matching code (`core/src/pronunciation.ts`)
has no I/O, so the same entries could later be offered to clients that speak
with on-device TTS; today Core-side `speak` and `speech_chunk` use it.

## Service health

The Core checks every `services.yaml` entry every `CORE_HEALTH_INTERVAL_MS`
(default 30000), each check bounded by `CORE_HEALTH_TIMEOUT_MS` (default 3000).
Polling runs continuously, whether or not a client is connected; a round starts
only after the previous one finished, so checks never overlap.

| Kind | Check | `ok` / `loading` |
|---|---|---|
| `http` | `GET <url><health>` | 200 → `ok`; 200 `{"status":"idle"}` → `ok` with detail `idle`; 503 `{"status":"loading"}` → `loading`; anything else → `down` |
| `mcp` (SSE, e.g. Home Assistant) | `GET <url>` with the bearer token, `Accept: text/event-stream`; the stream is closed right after the response headers — no MCP message is sent, no tool is listed or called | 200 `text/event-stream` → `ok` |
| `mcp` (streamable HTTP) | same GET | any non-auth answer below 500 except 404 → `ok` |
| `vault` | the vault folder exists | → `ok` |

A disabled service (in the file, or by a missing environment variable) is
reported as `disabled` and never checked.

`items` is the full list in `services.yaml` order. It is sent to each
authenticated client after `welcome` + `state` (once the first round has
finished) and to all clients whenever a `status` or `detail` changes;
`checkedAt` alone changing does not trigger a frame. `detail` is a short code,
never a URL, host or token; a value outside this table is sent as `error`:

| `detail` | Meaning |
|---|---|
| `timeout` | No answer within `CORE_HEALTH_TIMEOUT_MS`. |
| `unreachable` | Connection refused / DNS / network error. |
| `unauthorized` | 401/403 (wrong or expired token). |
| `error` | The service reports `{"status":"error"}` (or a 200 with an unknown `status`). |
| `idle` | `ok`: the service's model is unloaded to save memory and reloads on the next request (whisper-svc idle unload); the first request after idle is slower. |
| `bad_response` | 200 but not an event stream (e.g. a proxy page). |
| `http_<status>` | Any other HTTP status. |
| `not_found` | The vault folder is missing. |
| `not_configured` | `disabled`: a required environment variable is missing. |
| `off` | `disabled`: `enabled: false` in `services.yaml`. |

Clients must treat unknown `status` or `detail` values as "not ok" / free text.
Features keep their own errors: e.g. an `audio` frame while whisper-svc is down
still gets `error stt_unavailable`.

## Turn lifecycle

```
user_text / audio→transcript
  → state thinking
  → assistant_delta* , tool* , (confirm_request → state awaiting_confirm → confirm_resolved → state thinking)*
  → assistant_done
  → state idle
```

Only one turn runs per session. A second `user_text` (or a non-answer `audio`)
during a turn gets `error busy`. `cancel` with the running turn's `id` aborts the
model turn, denies any pending confirmation (`confirm_resolved` with
`approved: false, by: "button"`; the conversation log records `cancel`), sends
`assistant_done` with the text streamed so far and returns to `idle`.
Conversation context is kept across turns of the same session.

## Voice input

`audio` carries one complete utterance, base64-encoded, with its mime type
(`audio/webm`, `audio/ogg`, `audio/wav`, `audio/mpeg`, `audio/mp4`, …). The Core
sends it to whisper-svc (`language=tr`) and emits `transcript`. Then:

1. If a confirmation is pending and the transcript is a yes/no answer, it
   resolves that confirmation (`by: "voice"`) and no new turn starts.
2. Otherwise, if a turn is running, `error busy`.
3. Otherwise the transcript is handled exactly like `user_text`.

An empty transcript produces `error bad_request` ("no speech recognized").

## Confirmation flow

A tool whose permission level is `confirm` pauses the turn:
`state awaiting_confirm` + `confirm_request`. It is resolved by whichever comes
first:

- the button: `confirm_response` with the `requestId`;
- voice: the next transcript that is a whole short utterance (max 3 words) made
  only of yes-words — `evet`, `onayla`, `onaylıyorum`, `tamam`, `olur` — or only
  of no-words — `hayır`, `iptal`, `vazgeç`, `vazgeçtim` (fillers `lütfen`, `et`
  allowed). Matching is case- and diacritic-insensitive (`HAYIR` = `hayir`);
  a voice answer applies to the oldest pending request;
- timeout: `expiresAt` (default 60 s, `CORE_CONFIRM_TIMEOUT_MS`) → denied;
- `cancel` of the turn → denied, reported as `by: "button"` (a client action);
  on socket close it is denied as well (logged as `cancel`).

`confirm_resolved` is emitted exactly once; later answers for the same
`requestId` are ignored. A denied tool produces `tool … status: denied` and the
model is told not to retry.

## Permission gate

Every tool call the model attempts goes through the gate
([`core/src/permissions.ts`](../core/src/permissions.ts)); the level comes from
[`services.yaml`](../services.yaml):

| Level | Behaviour |
|---|---|
| `read` | Runs. |
| `write` | Runs; recorded in the conversation log and the Core log. |
| `confirm` | Waits for the user (see above). |
| unknown tool/service | Treated as `confirm`. |
| built-in tools (Bash, Read, Write, WebFetch, …) | Always denied; they are also removed from the model's tool list. |

Lookup per tool: exact name rule → first matching glob rule (file order,
case-insensitive) → the service's `permission` default. `confirm_inputs` raises
a call to `confirm` when an argument (e.g. `domain`, `device_class`) has a listed
value — used for locks, alarms and garage doors that generic intents like
`HassTurnOn`/`HassTurnOff` can also drive. `CORE_READ_ONLY=1` denies every
non-`read` tool without asking (smoke tests).

## Model and services

- The Agent SDK uses the machine's Claude Code login; `ANTHROPIC_API_KEY` is an
  optional fallback. The user's `~/.claude` settings, CLAUDE.md files, MCP
  servers and plugins are **not** loaded (`settingSources: []`, `strictMcpConfig`).
- Models and routing: each turn is handled by one tier — 0 (no model: a
  [`router.yaml`](../router.yaml) pattern calls a Home Assistant tool directly),
  1 (`CORE_MODEL_TIER1`, default `haiku`), 2 (`CORE_MODEL_TIER2`, else `CORE_MODEL`,
  default `sonnet`) or 3 (`CORE_MODEL_TIER3`, default `opus`, only for explicit
  planning / deep-analysis requests). `CORE_ROUTER=off` restores the single-model
  behaviour. See [`docs/04-router.md`](04-router.md).
- Routing does not change the WebSocket protocol: a tier-0 turn produces the same
  frames as a model turn (`state`, `tool`, `confirm_request` / `confirm_resolved`,
  `assistant_delta`, `assistant_done`) and its tool calls pass the same permission
  gate. A tier-1 answer arrives as a single `assistant_delta` (it is buffered so
  that an escalation to tier 2 stays invisible to the client).
- Home Assistant is reached through its MCP Server integration over **SSE**
  (`${HA_URL}/mcp_server/sse`, `Authorization: Bearer <HA_CORE_TOKEN>`).
  HA's `/api/mcp` streamable-HTTP endpoint is not used (broken on the current HA version).
- The `shadow-vault` tools (`list_notes`, `read_note`) read `.md` notes from
  `SHADOW_VAULT_DIR`, limited to the `allow` globs in `services.yaml`. `Private`
  path segments, dot-folders, paths outside the vault (including via symlinks)
  are always refused; each read returns at most `max_bytes`.

## Conversation records

Each session writes JSONL to
`<SHADOW_DATA_DIR>/conversations/YYYY-MM-DD/<sessionId>.jsonl`
(default data dir: `<SHADOW_VAULT_DIR>/.shadow-assistant`). Entry kinds:
`session_start`, `user`, `route`, `assistant`, `tool_call`, `tool_result`,
`permission`, `usage`, `error`, `session_end`. `route` records the tier, model
and router rule of a turn (plus a tier-0 fallback reason or an escalation);
`usage` carries `tier`, cache read/write tokens and an `outcome` besides the
token counts. Readers must ignore unknown kinds and fields.

Every model call (and every tier-0 turn, with `model: "none"`) is also appended
to `<SHADOW_DATA_DIR>/usage/YYYY-MM-DD.jsonl` (format:
[`docs/04-router.md`](04-router.md#usage-records)); that folder gets its own
self-ignoring `.gitignore` as well. When the Core creates the data dir it writes a
`.gitignore` containing `*` into it, so the folder ignores itself inside a
git-tracked vault without editing the vault's own `.gitignore`.
