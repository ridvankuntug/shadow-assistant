# Core WebSocket protocol v1

The Core exposes one WebSocket endpoint that every client (web UI, Android
shell) uses. TypeScript types for all frames live in a single module:
[`core/src/protocol.ts`](../core/src/protocol.ts).

- Endpoint: `ws://<core-host>:<CORE_PORT>/ws` (default port `8700`, default bind `127.0.0.1`).
- Health: `GET http://<core-host>:<CORE_PORT>/health` →
  `200 {"status":"ok","service":"core","version":"…","services":[{"name":"…","enabled":true}]}`.
- Every frame is a JSON **text** frame with a `type` field. Binary frames are rejected.
- `id` is a client-generated turn id (string, 1–128 chars). The Core echoes it on
  every frame that belongs to that turn.
- Max frame size: 36 MB (base64 audio included). Max `text` length: 4000 chars.

## Authentication

1. The first client frame **must** be `hello`, sent within **5 s** of connecting.
2. The token goes in the `hello` frame, never in the URL.
3. On success the Core replies `welcome` followed by `state: idle`.
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
| `{"type":"speak","id":"t1","text":"…"}` | Ask the Core to synthesize speech via tts-svc (web adapter). |
| `{"type":"cancel","id":"t1"}` | Barge-in: stop turn `t1`. |
| `{"type":"history_request","limit":20}` | Recent conversation items (default 20, max 100). |
| `{"type":"ping"}` | Keep-alive; answered with `pong`. |

## Core → Client

| Frame | Meaning |
|---|---|
| `{"type":"welcome","protocol":1,"sessionId":"…","device":"browser"}` | Authenticated. |
| `{"type":"state","state":"idle"\|"thinking"\|"awaiting_confirm"}` | Server-side state. `listening` and `speaking` are client-local states. |
| `{"type":"transcript","id":"t2","text":"…"}` | Result of speech-to-text for an `audio` frame. |
| `{"type":"assistant_delta","id":"t1","text":"<chunk>"}` | Streaming answer chunk. |
| `{"type":"assistant_done","id":"t1","text":"<full text>"}` | Answer finished (also sent after `cancel`, with the partial text). |
| `{"type":"tool","id":"t1","name":"<tool>","status":"started"\|"done"\|"denied"\|"error"}` | Tool activity. |
| `{"type":"confirm_request","requestId":"c1","id":"t1","tool":"<tool>","summary":"…","expiresAt":<epoch ms>}` | The turn is paused until the user confirms. |
| `{"type":"confirm_resolved","requestId":"c1","approved":true\|false,"by":"button"\|"voice"\|"timeout"}` | Sent exactly once per `confirm_request`. |
| `{"type":"speech","id":"t1","mime":"audio/wav","data":"<base64>"}` | Synthesized audio for a `speak` request. |
| `{"type":"history","items":[{"id":"…","role":"user"\|"assistant","text":"…","ts":<epoch ms>}]}` | Oldest first. |
| `{"type":"error","id"?:"t1","code":"…","message":"…"}` | See *Errors*. |
| `{"type":"pong"}` | Reply to `ping`. |

Tool names in `tool` and `confirm_request` frames are the service's own tool
names (e.g. `homeassistant__GetLiveContext`, `intent__HassTurnOff`), without the
Agent SDK's `mcp__<service>__` prefix.

### Errors

| `code` | When |
|---|---|
| `unauthorized` | Bad/missing hello or token (socket is closed with 4401). |
| `bad_request` | Malformed frame, invalid base64/empty audio, audio > 25 MB, no speech recognized, speech service rejected the input, unsupported protocol. |
| `stt_unavailable` | whisper-svc not configured, unreachable, loading (503) or timed out. |
| `tts_unavailable` | tts-svc not configured, unreachable, loading or timed out. |
| `model_error` | The model turn failed (auth, API, max turns, …). The client should show a short failure message; partial text may follow as `assistant_done`. |
| `busy` | A turn is already running (one turn per session at a time). |
| `internal` | Unexpected server error. |

Clients must treat unknown `code` values as generic errors.

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
