# 13 - Core on the Pi, the PC system agent and the tray link

Status: **design, awaiting user review (v0.2 plan T10.6).** Written for T10.1-T10.5
of the v0.2 plan. Nothing here is implemented yet; the plan tasks that build it
are named in every section.

Builds on [`02-core-protocol.md`](02-core-protocol.md) (client protocol, `hello`,
protocol versioning), [`05-deploy.md`](05-deploy.md) (data folder, backups, the
always-on box), [`11-pc-control.md`](11-pc-control.md) (PC actions, `pc_request` /
`pc_response` / `pc_state`) and [`12-wake-and-headless-core.md`](12-wake-and-headless-core.md)
(wake path, Q5). It replaces the PC-side transport of docs/11 D1 ("Core without a
session", loopback `/pc`) and docs/12 D4 (session-less Core on the PC); those
documents are rewritten in T24.

Names: **Pi** is the always-on Linux box (Debian arm64, Wi-Fi) that already runs
wake-svc and will run the Core. **PC** is the Windows machine. **Service** (or
system agent) is the new Windows service on the PC that runs without a sign-in.
**Tray** is the existing tray app (`deploy/windows/tray`). **UI** is the web UI
(`ui/`). Placeholders: `<pi-lan-ip>`, `<pc-lan-ip>`, `<user>` (the login on the
Pi), `<vault>` (vault root), `<companion>` (the vault folder that holds the
assistant's area). Nothing in this document or in the implementation may hold
real addresses, MACs, host or tailnet names, account names, vault folder names
or tokens.

## Problem

The Core and Claude run on the PC today. When the PC is off or nobody is signed
in, there is no assistant: no home control from the phone, no notifications. The
v0.2 plan moves the Core to the Pi (K1) and leaves on the PC only what needs the
PC: power commands, desktop commands, speech services (whisper-svc, tts-svc) and
the user's vault copy. This document fixes the contracts between the three
parts:

1. Pi Core <-> PC service: one outbound WebSocket (`/agent`).
2. PC service <-> tray: a local named pipe.
3. Everything that rides on them: PC state, desktop and power commands, the
   tray-side client traffic, voice, the data mirror, the development Core's
   writes. Plus release, update and file layout on both machines.

## Fixed decisions (v0.2 plan; not reopened here)

- **K1** Core and Claude move to the Pi (systemd, credstore). **K3** the PC dials
  out; no inbound port on the PC; channel drop = PC off; token **and** expected
  source address on the Pi. **K7** vault clone on the Pi: partial clone + sparse
  checkout, `Private/` never on the Pi, deploy key for this one repository.
  **K8** backups from the Pi. **K9** version base 0.2, protocol rule.
  **K10 / K10a** the development Core uses the same identities, reads the mirror,
  never writes production data directly.
- **M3** protocol number rule; `/agent` has its own `agentProtocol: 1`.
- **M4** Core release `core-v0.2.<n>`, base from the root `VERSION` file, the Pi
  pulls updates (systemd timer), checksum, health check, back to the previous
  version on failure.
- **M5 / A1 / O1** one connection PC -> Pi, held by the service. The tray never
  connects to the Pi; its traffic goes over the pipe to the service, which
  carries client traffic **unopened** in a `client` envelope; the Core turns it
  into a virtual client session authenticated with the device token and accepted
  only from an authenticated agent channel. Four PC states (off / on without a
  session / full / development mode). No queue anywhere: an interrupted command
  fails. Explicit exception: the development Core's `role: dev` write link (M7,
  O7).
- **O3** pipe rules: ACL only for the service account and the active console
  user, `PIPE_REJECT_REMOTE_CLIENTS`, both sides verify the peer process.
- **O4** the development switch returns to the Pi when the switch is turned off,
  the tray exits or the session ends. **O5** no service or no Pi link: the tray
  sends nothing, only shows the state.
- **M6 / O2** one-way mirror Pi -> PC (file list diff), written **by the tray**;
  rehearsal folder until T23.2; `dev/` untouched.
- **M7** development writes: drop and log to `dev/dropped-writes.jsonl` when the
  Pi is unreachable; no automatic resend.
- **O6** the move to the Pi is one-way: no return to the old Core on the PC (see
  [T10.4](#5-release-version-and-update-t104) for how this differs from the
  updater's version rollback).

## Current state (what the design relies on)

Checked in the code on 2026-11-27.

- **Client endpoint.** `core/src/server.ts` upgrades only `/ws` (404 otherwise).
  The first frame must be `hello` within 5 s; the token is checked
  (`authenticate`), then `hello.protocol` (4401 / 4400). A session is created
  through `opts.createSession({sessionId, device, client, clientVersion}, send)`:
  the session only sees a `send` function, which makes a virtual session
  (T10.2b) a transport change, not a session change.
- **No server-side heartbeat** on `/ws`: clients send `ping`, the Core answers
  `pong`.
- **Versions.** `CORE_VERSION` is a hard-coded `"0.1.0"` in `server.ts`
  (reported only by `GET /health`); `welcome` carries no version. The root
  `VERSION` file holds `0.2` (T1.1). The `X.Y` warning of M3 is not implemented
  (T12.3).
- **Speech.** `WhisperClient` / the TTS client in `core/src/speech.ts` call
  `POST <url>/transcribe?language=tr`, `POST <url>/synthesize` and
  `GET <url>/health` through an injectable `fetchFn`. `audio` frames carry one
  complete utterance (base64, at most 25 MB); TTS is per sentence
  (`speech_chunk`). There is no streamed audio today.
- **Data folder.** `resolveDataDir` (`core/src/config.ts`): `SHADOW_DATA_DIR`,
  else `<SHADOW_VAULT_DIR>/.shadow-assistant`, else the repo root. The backup
  script mirrors the rule (docs/05 "Data folder").
- **services.yaml** already takes the speech URLs from the environment:
  `${WHISPER_SVC_URL:-http://127.0.0.1:8701}` (same for tts-svc). The vault
  service reads `knowledge/**` under `SHADOW_VAULT_DIR`.
- **The tray holds no device token and has no WebSocket.** Chat, push-to-talk
  and notification actions live in the **UI**, which the tray serves on
  `http://localhost:<port>` (`UiServer.cs`, Kestrel, loopback, GET/HEAD only,
  Host filter). The UI stores the device token and sends `hello` itself
  (`ui/src/protocol/client.ts`; default address `ws://localhost:8700/ws`). The
  tray reads the unauthenticated loopback `GET /health` for its icon and the
  `inbox` counts (`TrayInbox`; a test asserts the tray settings hold no token).
  This differs from the plan's wording in M5 ("the tray keeps today's device
  token and produces `hello` itself"); see [T10.2b](#3-tray-client-session-t102b-and-the-pipe-t102a)
  and Q1.
- **Tray and Core lifetime.** The tray starts and supervises the Core
  (`CoreSupervisor`, job object). After the move this stays only for the
  development Core (T16.1).
- **`pc-svc` (docs/11 D1) is not built.** Its message set (`pc_state`,
  `pc_request` `apps` / `games` / `run`, `pc_response` with `done` / `not_found`
  / `locked` / `unsupported` / `failed`, 10 s timeout, `requestId` remembered for
  10 min) is reused below on the new path.
- **Deploy on the Linux box** lives in `deploy/linux/` (wake-svc unit and env
  example); docs/05 section 5 sets the pattern (unit, `/etc/shadow-assistant/`,
  `/etc/credstore/`, `LoadCredential=`).

## Overview

```
 phone ──wss/ws──────────────────────────►┐
                                          │  Pi: Core  (/ws, /agent, /health)
                    ┌── /agent (ws, LAN) ─┤      data dir, vault clone, backups
                    │                     └──────────────────────────────────
 PC ────────────────┼───────────────────────────────────────────────────────
  service (session-less, Windows service)
    ├─ power commands (itself)
    ├─ whisper-svc / tts-svc on 127.0.0.1 (http_request proxy)
    └─ named pipe ──► tray (signed-in user)
                        ├─ desktop commands (pc-svc executor), pc_state
                        ├─ mirror writer (rehearsal folder until T23.2)
                        ├─ development switch
                        └─ /ws relay on the UiServer port ◄── UI in the browser
                                                             (device token, hello)
 development Core (PC, role dev)
    ├─ /agent of its own (loopback) — the service connects here only while
    │  the development switch is on
    └─ /ws to the Pi with hello role:"dev" (writes, notifications)  [M7 exception]
```

---

## 1. Agent channel (T10.1)

### 1.1 Endpoint and transport

- `ws://<pi-lan-ip>:<CORE_PORT>/agent` on the Core's existing port, next to
  `/ws`. Same framing rules as `/ws`: JSON **text** frames with a `type` field;
  binary frames are a protocol error. Max frame **40 MiB** (a 36 MB client frame
  plus its envelope, see 3.4).
- Plain `ws://` on the LAN, the same as the phone's home address today (docs/12
  progress log 2026-11-17). Whether this is enough is Q2.
- The service connects to the Pi's **LAN** address, never through the Tailscale
  name: through Tailscale the source address would be the PC's tailnet address
  and the source check below would have to follow it.

### 1.2 Who may connect (source address, token)

Checked in this order, all before a session exists:

1. **Source address, before the upgrade.** `req.socket.remoteAddress` must equal
   `CORE_AGENT_SOURCE` (one IPv4 address; the IPv4-mapped IPv6 form is accepted
   too). Anything else gets `403` and no upgrade. `X-Forwarded-For` and other
   headers are never read (same rule as `/health` today). A request with an
   `Origin` header is refused (`403`): no browser page may open `/agent`.
   T9.4 made the PC's LAN address a DHCP reservation, so the value is stable.
2. **`agent_hello` within 5 s** (same timer as `/ws`), token compared in
   constant time with `CORE_AGENT_TOKEN` (at least 32 characters; credstore on
   the Pi, see 6.1). Wrong or late: `error unauthorized`, close **4401**.
3. **`agentProtocol`** different from the Core's: `error bad_request`, close
   **4400** (M3: different protocol = refused).

The development Core runs the same code; its `/agent` accepts only loopback
(`CORE_AGENT_SOURCE=127.0.0.1`) and the same agent token (K10).

One agent at a time: a new authenticated agent connection replaces the old one
(the old one is closed with 4409 `replaced`). Without `CORE_AGENT_TOKEN` the
endpoint answers 404 like an unknown path (a Core without an agent, e.g. a test
set-up).

### 1.3 Handshake

```json
{"type":"agent_hello","agentProtocol":1,"token":"…","version":"0.2.57",
 "capabilities":["power","desktop","voice","mirror","client"],
 "state":{"session":"active","tray":true,"pc":{"locked":false,"fullscreen":false,"gameMode":false}}}
```

| Field | Meaning |
|---|---|
| `agentProtocol` | Integer, today `1`. Rule of M3, independent of the client protocol. |
| `token` | Agent token. Never in the URL, never logged. |
| `version` | The service's release version `X.Y.<n>`. Only `X.Y` is compared. |
| `capabilities` | What this service can do now: `power`, `desktop` (a tray is attached), `voice` (the speech proxy is configured), `mirror`, `client`. Unknown names are ignored. |
| `state` | The PC report of 1.6, so the Core knows the PC state from the first frame. |

```json
{"type":"agent_welcome","agentProtocol":1,"version":"0.2.61","role":"prod","warnings":["version_base"]}
```

- `role`: `prod` (Pi) or `dev` (development Core). The service passes it to the
  tray (`link.target`).
- `warnings` (optional): `version_base` when the `X.Y` bases differ (M3:
  accepted with a warning). The service logs it and forwards it to the tray
  (T16.6 shows it). Patch numbers are never compared.

### 1.4 Liveness and drop

- The **Core** sends `{"type":"ping","n":<int>}` every **5 s**; the service
  answers `{"type":"pong","n":<same>}` at once.
- The Core treats the channel as gone **15 s** after the last matching `pong`
  (three missed rounds), and at once on a close or socket error. The service
  closes its side after 15 s without a `ping`.
- Why these numbers: T9.3 measured Pi -> PC round trips of 15.5 ms on average,
  127 ms at most, no loss. 15 s tolerates a Wi-Fi hiccup and still shows a real
  outage within seconds of a sleeping PC. The 10 s command timeout (1.7) is
  independent.
- **Planned goodbye.** Before sleep, shutdown, restart or a service stop the
  service sends `{"type":"agent_bye","reason":"sleep"|"shutdown"|"restart"|"stopping"}`
  and closes; the Core marks the PC off at once instead of 15 s later.
- **Reconnect (service).** Backoff 1, 2, 4, 8, 16, 30 s (30 s cap), each with
  50-100 % random jitter; the counter resets after 60 s connected. After a 4401
  or 4400 the service retries every 5 min only (a wrong token must not hammer
  the Pi) and reports `link.pi:"rejected"` to the tray. On resume from sleep
  and on network change the service reconnects at once (T14.8).

### 1.5 What happens on a drop (no queue)

All at the moment the Core declares the channel gone:

- PC state -> **off** (or stays **dev**, see 2.3). PC tools disappear from the
  model's tool list for the next turn (T13.2).
- Every open `pc_request` fails with `code:"interrupted"`. The model and the
  user get: "Bilgisayarla bağlantı koptu; komutun yapılıp yapılmadığı
  bilinmiyor." A command may have run and only its answer been lost, so the
  text does not claim failure. Nothing is retried, nothing is queued.
- Every open `http_request` fails: speech turns get `stt_unavailable` /
  `tts_unavailable` as today when whisper-svc is down.
- Every virtual client session closes (`socket_closed`, as for a real socket);
  the service closes the tray-side streams (3.4).
- A running mirror sync is dropped; the next connection starts with a fresh
  list (6.4).

### 1.6 PC state report (service -> Core)

```json
{"type":"agent_state","session":"none"|"active","tray":true,"pc":{"locked":false,"fullscreen":false,"gameMode":false}}
```

- Sent in `agent_hello.state` and then on every change.
- `session`: from Windows session notifications (`WTS_SESSION_LOGON` /
  `LOGOFF` / `LOCK` / `UNLOCK`, console connect/disconnect). `active` = a user
  is signed in on the console.
- `tray`: a verified tray is attached to the pipe (3.1) **in the active console
  session**.
- `pc`: the tray's `pc_state` (docs/11 D1) passed through; `null` while
  `tray` is `false`.

### 1.7 Commands and replies

The docs/11 frames are reused unchanged in meaning; the service routes by
action:

```json
{"type":"pc_request","requestId":"r-8f2c","op":"run","action":"pc_open_app","target":"…","params":{}}
{"type":"pc_response","requestId":"r-8f2c","ok":true,"code":"done","data":{}}
```

| Action | Executed by | Without a tray |
|---|---|---|
| `pc_sleep`, `pc_shutdown`, `pc_restart` | **service** (it answers `done`, then starts the OS action about 2 s later so the answer gets out; then `agent_bye`) | runs |
| `pc_lock` | tray (`LockWorkStation`) | `code:"already_locked"` (M5: no session = already locked) |
| every other `run`, `apps`, `games` | tray (docs/11 executor) | `code:"no_session"` |

- `code` values: docs/11 (`done`, `not_found`, `locked`, `unsupported`,
  `failed`) plus `no_session`, `already_locked`; `interrupted` and `timeout`
  are produced by the Core only.
- **Timeouts (Core side):** 10 s for every `pc_request` (docs/11), then
  `timeout`, no retry. The service's own wait for the tray is 9 s, so its
  `failed` arrives before the Core gives up.
- **Duplicates:** the service and the tray remember a `requestId` for 10 min; a
  repeat returns the first answer and runs nothing. With no queue the Core never
  resends; this is defence in depth.
- Policy (permission list, confirmation, the "Shadow da kapanacak" warning,
  locked/fullscreen rules) stays in the Core (docs/11 D3, D4, D8). After the
  move the power warning text changes: the Core keeps running on the Pi, only
  the PC goes away (docs/11 update in T24.2).

### 1.8 Core status for the tray (Core -> service)

The tray's icon and the "Geliştirme (N)" / "Bildirimler (N)" / "İzinler (N)"
counts come from the loopback `GET /health` today; that address no longer
reaches a Core. The Core therefore sends the same numbers on the channel:

```json
{"type":"core_status","version":"0.2.61",
 "services":[{"name":"home-assistant","status":"ok","checkedAt":0}],
 "inbox":{"dev":2,"notifications":1,"notificationsUnavailable":false,"pc":0}}
```

Sent after `agent_welcome` and whenever a value changes (same triggers as the
`services`, `dev_count` and `pc_permissions_count` frames). Numbers, flags and
service states only, exactly what `GET /health` already gives a loopback
caller; no titles, no texts. The service keeps the last one and hands it to
every tray that attaches (3.3, `core_status`).

### 1.9 Other frames on the channel

| Frame | Direction | Section |
|---|---|---|
| `client_open` / `client_frame` / `client_close` | both | [3](#3-tray-client-session-t102b-and-the-pipe-t102a) |
| `http_request` / `http_response` / `http_cancel` | Core -> service / back | [4](#4-voice-proxy-t103) |
| `mirror_list_request` / `mirror_list` / `mirror_get` / `mirror_chunk` | service -> Core / back | [6.4](#64-mirror-m6) |
| `agent_mode` / `agent_mode_ack` | service -> Core / back | [2.3](#23-development-mode) |
| `error` | both | `{"type":"error","requestId"?:"…","code":"…","message":"…"}`; unknown frame types and fields are ignored (as on `/ws`). |

**Why this shape.** One socket, one token, one source rule and one drop signal
(M5). Keeping the docs/11 command frames means the executor in the tray is the
one docs/11 already designed. Liveness is driven by the Pi because only the Pi
needs the "PC off" fact. Application-level ping (not WebSocket control frames)
because both sides can test it and the .NET and Node libraries differ in what
they expose.

**Plan tasks.** T13.1 (endpoint, source check, token, state report, drop),
T13.2 (tool hiding, interrupted commands), T13.4 (PC state to clients),
T14.2 (connection, reconnect, token storage), T14.3 (power), T14.4 (state
report, forwarding desktop commands), T14.8 (sleep/resume test), T14.9 and
T12.3 (versions).

**Not verified.**

- That `req.socket.remoteAddress` on the Pi shows the PC's LAN address for a
  connection to `<pi-lan-ip>` while the Pi is a Tailscale subnet router (no
  SNAT on the LAN path).
- That the service can send `agent_bye` before sleep (time budget of the
  Windows power broadcast for a service) and that it sees resume reliably
  (T14.8).
- 40 MiB frames on the Pi: memory per frame is fine (T9.2: 14 GB free), but a
  frame of that size blocks the socket for a few seconds over Wi-Fi; only an
  unusually long utterance would come close.

**Open questions.** Q2 (transport security), Q3 (service account).

---

## 2. PC state model (T10.2)

### 2.1 States

The Core derives one state from the channel and the last `agent_state`:

| State | Condition |
|---|---|
| `off` | No agent channel, and the last channel did not end with a development switch. |
| `no_session` | Channel up; `session:"none"`, or `tray:false`. |
| `full` | Channel up; `session:"active"` and `tray:true`. |
| `dev` | The service announced the development switch (2.3) and has not reported back to the Pi since. |

Locked, fullscreen and game mode are **not** states; they are `pc_state` inside
`full` and keep the docs/11 D8 rules.

### 2.2 What each state means

| | `off` | `no_session` | `full` | `dev` |
|---|---|---|---|---|
| Power tools (`pc_sleep`, `pc_shutdown`, `pc_restart`) for the model | hidden | shown | shown | hidden |
| `pc_lock` | hidden | shown; answers "zaten kilitli" | shown | hidden |
| Desktop tools (all other `shadow-pc` tools, `pc_find`, `pc_status`) | hidden | hidden | shown (D8 rules for locked / fullscreen) | hidden |
| Tier-0 PC rule that still matches | "Bilgisayar kapalı." | desktop: "Bilgisayarda oturum açık değil."; power runs | runs | "Bilgisayar geliştirme kipinde." |
| PC speech (whisper-svc / tts-svc through the agent) | none | yes, if the T7 backend runs without a session | yes | none |
| Phone speech | Android recognizer if T40.1 is done, else "sesli komut kullanılamıyor" (K5) | through the PC | through the PC | as `off` |
| whisper-svc / tts-svc in `services` / `/health` | `down`, detail `pc_off`; no outage notification (T13.3) | as checked | as checked | `down`, detail `pc_dev`; no notification |
| UI band / phone panel | "Bilgisayar kapalı" + **Bilgisayarı uyandır** offered | "Bilgisayar açık, oturum yok" | none | "Bilgisayar geliştirme kipinde"; wake **not offered**, manual wake still in the Adresler/wake menu (P2) |
| `pc_state` | none | none | `{locked, fullscreen, gameMode}` | none |
| Mirror | none | none (needs the tray) | runs | paused |
| Tray traffic (UI on the PC) | n/a (PC off) | n/a (no tray) | through the service | goes to the development Core |

The new detail codes `pc_off` / `pc_dev` are additive: clients treat unknown
`detail` values as free text (docs/02 *Service health*).

### 2.3 Development mode

Sequence (T14.7, T16.4; O4, P2):

1. Tray -> service: `dev_switch {on:true}` (3.3).
2. Service -> Pi: `{"type":"agent_mode","requestId":"m-1","mode":"dev"}`.
3. Pi records `dev`, applies 2.2, answers `{"type":"agent_mode_ack","requestId":"m-1"}`.
4. Only after the ack the service closes the Pi channel (close code **4000**,
   reason `dev_mode`) and connects to the development Core's `/agent` on
   loopback. No ack within 5 s: the service does not switch and the tray shows
   the failure.
5. Back: switch off, tray gone or session ended -> the service reconnects to the
   Pi; the new `agent_hello.state` ends `dev` on the Pi.

The Pi keeps `dev` until a new agent connects (P2: "until the service reports
back"). It is held in memory: a Pi restart during development mode shows `off`
until the service returns. See Q7.

If the PC really goes off while the switch is on, the Pi still shows `dev`:
manual wake stays available (P2), only the suggestion is hidden.

### 2.4 Protocol to clients (T13.4)

New client frame, feature `pc_status` (additive, protocol stays 1):

```json
{"type":"pc","state":"off"|"no_session"|"full"|"dev","since":<epoch ms>}
```

Sent after `welcome` (with `state` and `services`) and to every authenticated
socket on change. Android binds the wake panel to it (T22.2): the panel no
longer depends on the Core being unreachable, because the Core on the Pi is
always reachable. Clients ignore unknown `state` values (treated as `off`).

**docs/12 Q5, new form.** Q5 asked whether the phone should tell "PC on but Core
down" from "PC off" (default: no, one timeout message). With the Core on the Pi
the question changes: the Core is up, and the phone learns the PC state from the
`pc` frame. "Core unreachable" now means the Pi or the network is down, and the
wake panel is not the answer to it. docs/12 is rewritten in T24.1.

**Why.** The four states are exactly M5's; the table only writes down what each
one hides. Hiding tools (instead of answering "PC off" from inside the tool)
keeps the model from offering what cannot run (T13.2).

**Plan tasks.** T13.2, T13.3, T13.4, T14.4, T14.7, T15.3, T16.4, T22.2, T23.4.

**Not verified.**

- Whether hiding tools per turn works with the persistent agent session
  (docs/07 A1): the tool list of a running SDK session may be fixed at start;
  then a state change needs a session restart or a "PC tools unavailable" gate
  answer instead. T13.2 checks it first.
- Whether the T7 speech backend really runs without a session (that is what T7
  measures; `no_session` speech depends on it).

**Open questions.** Q7 (dev state across a Pi restart).

---

## 3. Tray client session (T10.2b) and the pipe (T10.2a)

### 3.1 Pipe: transport and security (O3, T14.5)

- Name: `\\.\pipe\ShadowAssistant.Agent`. Byte mode; each message is a 4-byte
  little-endian length followed by UTF-8 JSON with a `type` field. Max message
  **40 MiB** (same as the agent channel, so a client frame passes intact).
- Server: the service. Created with `PIPE_REJECT_REMOTE_CLIENTS` and an ACL
  granting access only to the service account and the **active console user's
  SID** (re-created when the console user changes). One tray connection at a
  time; a second is refused.
- **Service checks the client:** `GetNamedPipeClientProcessId` -> the process's
  image path must equal the tray's installed path (configured at install, under
  `Program Files`, not user-writable), its session id must equal the active
  console session, and its token user must be the console user. Any mismatch:
  disconnect and log.
- **Tray checks the server:** `GetNamedPipeServerProcessId` -> the process must
  be the installed service executable running as the service account (blocks a
  user process that grabbed the name first).
- On session change (sign-out, user switch, lock is **not** a change) the
  service closes the pipe connection and every client stream that came from it.
- First message from the tray: `{"type":"pipe_hello","pipeProtocol":1,"version":"0.2.57"}`;
  answer `{"type":"pipe_welcome","pipeProtocol":1,"version":"0.2.57"}`. Different
  `pipeProtocol`: closed. Tray and service ship from the same build (Q5), so
  `X.Y` is only logged.

### 3.2 Why the tray relays and does not hold a token (Q1)

The plan says the tray keeps "today's device token" and produces `hello`. In the
code the tray has no token; the UI has it and produces `hello`, and the browser
cannot open a named pipe. Two ways to meet A1:

| Option | For | Against |
|---|---|---|
| **(a) Relay (proposed).** The tray's `UiServer` gets a loopback WebSocket endpoint `/ws` on the port that already serves the UI. The UI connects there (same origin) and sends its normal frames, including `hello` with its device token. The tray passes every frame unparsed over the pipe as `client_frame`. | The client protocol, the UI and the device token stay exactly as today; the tray stays tokenless (its existing test keeps holding); the service and the tray never parse client frames (O1 "unopened"); the Core authenticates the device token as today. | A multiplexing layer (stream ids); the tray must guard the new loopback endpoint (Origin check). |
| (b) The tray becomes a client with its own token and the UI talks to the tray. | One fewer hop inside the PC. | The tray would need the client protocol (every new frame needs a tray update), a token in the tray, and the UI would still need a transport to the tray: more work and a second token store. |

Proposal (a). It keeps the substance of O1: unopened envelope, device token
checked by the Core, accepted only from the agent channel. Needs the user's
confirmation because it reinterprets the M5 wording (Q1).

### 3.3 Pipe messages

| Direction | Message | Purpose |
|---|---|---|
| tray -> service | `pipe_hello` | 3.1. |
| service -> tray | `pipe_welcome` | 3.1. |
| service -> tray | `link` `{pi:"connected"\|"connecting"\|"rejected", target:"pi"\|"dev", warnings?:[…]}` | Agent channel state. Sent at attach and on change. The tray shows "Pi'ye ulaşılamıyor" for anything but `connected` (T16.1a). No pipe at all = "Shadow servisi çalışmıyor" (the tray decides that itself). |
| service -> tray | `core_status` | The Core's last 1.8 frame, plus `stale:true` while the channel is down (counts are shown as not current, not reset to 0). |
| tray -> service | `tray_state` `{pc:{locked, fullscreen, gameMode}}` | `pc_state` source; the service puts it in `agent_state`. |
| service -> tray | `pc_request` | Desktop command (1.7), unchanged. |
| tray -> service | `pc_response` | Reply, unchanged. |
| tray -> service | `client_open` `{cid}` / `client_frame` `{cid, frame}` / `client_close` `{cid, code?, reason?}` | One UI socket on the relay (3.4). `frame` is the raw text of one client frame. |
| service -> tray | `client_frame` `{cid, frame}` / `client_close` `{cid, code, reason}` | Core frames back to that UI socket; close codes (4401, 4400) are passed through to the browser. |
| tray -> service | `dev_switch` `{on}` | Development switch (2.3). |
| service -> tray | `dev_switch_result` `{on, ok, code?}` | `code:"no_ack"` when the Pi did not acknowledge. |
| service -> tray | `mirror_scan_request` / `mirror_put` / `mirror_delete` | Mirror (6.4). |
| tray -> service | `mirror_scan` / `mirror_ack` | Mirror (6.4). |

The service holds no state for the tray beyond the last `core_status`, the last
`tray_state` and the open `cid`s. Nothing is queued: a `pc_request` while no
tray is attached gets `no_session` at once (M5).

### 3.4 Client envelope and the virtual session

On the agent channel the same three frames are used:

```json
{"type":"client_open","cid":"c-1f3a"}
{"type":"client_frame","cid":"c-1f3a","frame":"{\"type\":\"hello\",\"protocol\":1,\"token\":\"…\",\"client\":\"web\"}"}
{"type":"client_close","cid":"c-1f3a","code":4401,"reason":"unauthorized"}
```

- `cid`: chosen by the tray per relay socket (random, 8-64 characters
  `[A-Za-z0-9_-]`); the service passes it on. At most **8** open `cid`s per
  agent connection (several browser tabs); a ninth gets `client_close` 1013.
- **Core side (T13.5).** `client_open` creates a virtual socket bound to this
  agent connection. From there the `/ws` rules apply unchanged: the first
  `client_frame` must be `hello` within 5 s, the device token is checked, then
  the protocol number; `createSession` gets a `send` that wraps every frame in
  `client_frame`. Max client frame 36 MB as on `/ws`; text frames only (the
  envelope cannot carry binary anyway).
- **Which devices may use which path.** New setting
  `CORE_AGENT_CLIENT_DEVICES` (device names as in `DEVICE_TOKEN_<NAME>`): those
  devices are accepted **only** inside the envelope, and a direct `/ws`
  connection with their token is refused with 4401 (T13.5 "a tray identity from
  outside the envelope is refused"). Devices not in the list are refused inside
  the envelope. Device trust and permission rules (`CORE_DEV_DEVICES`,
  `CORE_PC_PERMISSION_DEVICES`, …) apply unchanged by device name.
- **Lifetime.** A virtual session closes on `client_close` from either side, on
  agent drop (1.5) and on agent replacement. The tray closes the browser socket
  (code 1012 "service restart") when the pipe drops or the link leaves
  `connected`; the UI reconnects as it does today, and while the link is down
  the relay refuses the upgrade (503), so nothing is sent (O5).
- **Relay endpoint rules (tray, T16.1).** Loopback only (Kestrel already binds
  `localhost`), Host filter as today, and the `Origin` header must equal the
  UiServer's own origin; anything else is refused before the upgrade. The relay
  never parses frames; it only counts bytes against the 36 MB limit.
- **UI address.** When the UI is served by the tray its Core address becomes the
  same-origin `ws://localhost:<ui-port>/ws`. The UI's address model (ConnectScreen
  default `ws://localhost:8700/ws`) changes in T16; the Android app is not
  affected.

**Why.** The Core sees a normal client: the same `hello`, token, session and
features. The service and tray are byte pipes for client traffic, so a client
protocol addition never needs a service or tray update (O1). Agent identity does
not replace device identity: both must hold (M5).

**Plan tasks.** T14.1 (pipe library shared by service and tray), T14.4a
(carrying client traffic, link state), T14.5 (pipe security, negative tests),
T13.5 (virtual session), T16.1 / T16.1a (relay, states, reconnect), T16.2
(`pc_request` executor, `pc_state`), T16.6 (version display).

**Not verified.**

- `GetNamedPipeClientProcessId` / `GetNamedPipeServerProcessId` and the image
  path check from .NET in both directions, including a tray started from a user
  folder (development builds) being refused.
- Pipe ACL re-creation when the console user changes without the service
  restarting.
- Kestrel WebSocket on the existing slim builder (`CreateSlimBuilder`) without
  adding a large dependency.
- The UI's microphone still works on the relay origin (it is the same
  `http://localhost` secure context as today; expected to work).

**Open questions.** Q1 (relay instead of a tray token).

---

## 4. Voice proxy (T10.3)

### 4.1 Flows

- **Phone push-to-talk:** phone -> Pi `/ws` `audio` -> Core -> `http_request`
  (whisper-svc) -> service -> `127.0.0.1` whisper -> back; TTS sentences the
  same way (`speech_chunk` to the phone).
- **PC push-to-talk (UI):** browser -> tray relay -> pipe -> service -> agent
  `client_frame` (`audio`) -> Core -> `http_request` -> service -> whisper -> …
  The audio crosses the Wi-Fi twice. R4 / T25.1 measure this against the 2.5 s
  target; T25.2 is the conditional short path (PC audio recognised on the PC,
  only text sent).
- **PC off or `dev`:** no `http_request` is sent; `audio` gets `stt_unavailable`
  and the UI shows "sesli komut kullanılamıyor" (T15.3). On the phone: Android
  recognizer if T40.1 is done (K5), else the same message.

"Streamed" in the plan means what exists today: the utterance goes as one piece,
the answer comes back sentence by sentence. Streaming audio *into* whisper is not
part of v0.2.

### 4.2 Frames (agent channel)

A restricted HTTP forwarder, not typed speech frames:

```json
{"type":"http_request","requestId":"h-12","service":"whisper-svc","method":"POST",
 "path":"/transcribe?language=tr","contentType":"audio/webm","body":"<base64>","timeoutMs":60000}
{"type":"http_response","requestId":"h-12","status":200,"contentType":"application/json","body":"<base64>"}
{"type":"http_response","requestId":"h-12","error":"unreachable"|"timeout"|"not_allowed"|"too_large"}
{"type":"http_cancel","requestId":"h-12"}
```

- **The service's own allow-list decides**, never the Pi: service name -> local
  base URL from the service's configuration (`http://127.0.0.1:8701`, `:8702`),
  and per service the permitted `(method, path)` pairs: whisper-svc
  `POST /transcribe`, `GET /health`; tts-svc `POST /synthesize`, `GET /health`.
  Anything else: `error:"not_allowed"`. No headers other than `Content-Type`
  pass in either direction; no redirects are followed.
- Limits: request body 25 MB (the `audio` limit), response body 25 MB.
  `timeoutMs` is the Core's per-service timeout (`timeout_ms` in services.yaml);
  the Core waits `timeoutMs + 5 s` in total, then fails as `stt_unavailable` /
  `tts_unavailable`. `http_cancel` (turn cancelled, channel closing) aborts the
  local request.
- **Core side:** an `agent://<service>` base URL selects the forwarder as the
  speech clients' `fetchFn`. The Pi sets `WHISPER_SVC_URL=agent://whisper-svc`
  and `TTS_SVC_URL=agent://tts-svc`; `services.yaml` itself does not change
  (T11.4 "Pi profile" becomes environment only). Health checks of these entries
  go through the same forwarder (`GET /health`), and are skipped with detail
  `pc_off` / `pc_dev` in those states (2.2).

**Why a forwarder and not typed frames.** The speech clients already take an
injectable `fetchFn`, so the Core change is one adapter; whisper-svc and tts-svc
APIs stay where they are. A generic proxy would let the Pi make the PC call
anything; the allow-list in the service (not in the request) prevents that.
Typed `stt` / `tts` frames were considered (narrower, but the service would have
to rebuild each request and change with every speech API change). Base64 inside
JSON instead of binary frames: one framing rule on every link (as `/ws` today),
and the 33 % overhead on an utterance of a few hundred KB is small next to the
measured round trip.

### 4.3 Privacy

- Audio is held in memory on the Pi only for the request and is never written:
  no file, no log body. The conversation log records the transcript, as today.
- The service logs service name, path, status, byte counts and duration only;
  never bodies.
- The agent channel is the persistent, token-checked, LAN-only link of section
  1; it exists only at home (the PC and the Pi are both on the LAN). Whether it
  should be encrypted is Q2 (the audio and the chat text cross the home network
  in plain text today too: phone -> PC on the home address).

**Plan tasks.** T15.1 (backend from T7), T15.2 (forwarder in the service, Core
adapter), T15.3 (off / dev behaviour), T15.4 and T25.1 (latency).

**Not verified.**

- The exact paths and content types of whisper-svc and tts-svc (only the three
  calls above were seen in `speech.ts`; a voice list may come from `/health`).
- Round-trip time of a typical utterance through the double hop (T15.4,
  T25.1).
- That the conversation log and dev-notes never store audio (expected from the
  code; T15.2 adds a test).

**Open questions.** Q2 (transport security). The speech backend itself is T7's
decision, not this document's.

---

## 5. Release, version and update (T10.4)

### 5.1 Version source and tags (M3, M4, O8c)

- The base `X.Y` comes only from the root `VERSION` file (today `0.2`).
- Core workflow (T12.1): runs when `core/` or `VERSION` changes, builds an
  arm64 package, tags **`core-v<X.Y>.<n>`** (`<n>` = the workflow's run
  number), attaches `SHA256SUMS`. Does not collide with Android's `v0.2.<n>`.
- The build writes the version into the package (a generated file read at
  start) and the Core reports it in `GET /health`, in a new optional
  `welcome.version` (additive, protocol stays 1) and in `agent_welcome.version`.
  The hard-coded `CORE_VERSION = "0.1.0"` goes (T12.3).
- **Compatibility (M3)**, the same table on every link:

| Link | Protocol field | Different protocol | Same protocol, different `X.Y` |
|---|---|---|---|
| client `/ws` (phone, UI, through the relay too) | `hello.protocol` | refused (4400) | accepted, `welcome.warnings:["version_base"]` (needs `hello.clientVersion`) |
| agent `/agent` | `agent_hello.agentProtocol` | refused (4400) | accepted, `agent_welcome.warnings` |
| pipe | `pipe_hello.pipeProtocol` | closed | logged only |

### 5.2 Pi updater (T12.2)

1. A systemd timer (e.g. every 30 min) runs the updater as root.
2. It asks the GitHub Releases API for the newest `core-v<X.Y>.<n>` with the
   Pi's configured `X.Y` (a new `X.Y` series is never taken automatically; that
   is a planned step with its own notes).
3. Downloads the package and `SHA256SUMS`, checks the checksum, unpacks into
   `/opt/shadow-assistant/core/releases/<version>/`.
4. Switches the `current` symlink, restarts `shadow-core.service`.
5. **Health check:** within 90 s `GET /health` on loopback must answer 200 with
   `version` equal to the new one.
6. **On failure:** symlink back to the previous release, restart, record the
   version in `/var/lib/shadow-assistant/updater/failed` (never retried) and
   raise a Core notification "güncelleme geri alındı (<version>)" once the old
   Core is up. Keep the current and the two previous releases.

The updater never touches the data folder or the vault clone. A release that
changes the data format must say so in its notes; such a change is not
installed by the timer without a manual step (no automatic data migration
rollback exists).

### 5.3 Two different "go back" rules

- **Updater rollback (M4, T12.2):** a failed Core release on the Pi goes back to
  the previous release **on the Pi**. Routine, automatic.
- **No return to the PC (O6, R8, T23.5):** the move itself is one-way. Once T23.2
  has run, the old production Core on the PC is removed; problems on the Pi are
  fixed forward or by restoring a Pi backup (or the last PC backup from the
  move day). The development Core on the PC is not a production fallback.

The two never mix: the updater only ever chooses between Pi releases.

**Plan tasks.** T12.1, T12.2, T12.3, T14.9, T16.6.

**Not verified.**

- Which parts of the package are architecture-specific (the Agent SDK's Claude
  Code CLI, any native module); T9.1 installed Claude Code separately in the
  user's home. The package may contain only `core/dist` + production
  `node_modules`, with Node and Claude Code installed once by T11.1.
- GitHub API rate limits for an unauthenticated timer (expected well within).

**Open questions.** Q5 (how the service and the tray are released and updated;
the plan has a workflow only for the Core and Android).

---

## 6. Layout (T10.5)

### 6.1 Pi

| Path | What | Owner |
|---|---|---|
| `/opt/shadow-assistant/core/releases/<version>/`, `current` | Core code (5.2) | root, read-only for the service |
| `/etc/systemd/system/shadow-core.service` | Core unit; `User=<user>` (the account that owns the Claude login, T9.1), `StateDirectory=shadow-assistant` | root |
| `/etc/shadow-assistant/core.env` | Non-secret settings: `SHADOW_DATA_DIR`, `SHADOW_VAULT_DIR`, `CORE_HOST`, `CORE_AGENT_SOURCE`, `WHISPER_SVC_URL=agent://…`, rehearsal flag (T11.5). Read by the Core **and** the backup unit (T17.1: one source for the path). | root 0644 |
| `/etc/credstore/shadow-core.*` | HA token, device tokens, agent token, vault deploy key (`LoadCredential=`) | root 0600 |
| `/etc/credstore/shadow-backup.*` | rclone config and crypt passwords (T19.1) | root 0600 |
| `/var/lib/shadow-assistant/data/` | **Data folder** (`SHADOW_DATA_DIR`): conversations, memory, dev-notes, notifications, sessions, usage, `backup/status.json` | `<user>` |
| `/var/lib/shadow-assistant/vault/` | **Vault clone** (`SHADOW_VAULT_DIR`), 6.3 | `<user>` |
| `~<user>/.claude/`, `~<user>/.claude.json` | Claude login; written by the CLI when it refreshes (T9.1: credstore is not suitable) | `<user>` |
| `/opt/shadow-assistant/wake-svc/` | Unchanged (docs/05 section 5) | root |

- The data folder is set explicitly and lies **outside** the vault clone: git
  never sees it, and the backup takes it as one folder.
- The Core reads its secrets from `$CREDENTIALS_DIRECTORY` (new: today it reads
  `DEVICE_TOKEN_<NAME>` from the environment; T11.2).
- Logs go to the journal. Claude Code reads data over SSH (T17.3).

### 6.2 PC

| Path | What |
|---|---|
| `C:\Program Files\ShadowAssistant\Agent\` | Service executable (installed, admin-only write) |
| `C:\Program Files\ShadowAssistant\Tray\` | Tray executable at the path the service verifies (3.1) |
| `%ProgramData%\ShadowAssistant\agent\agent.json` | Service settings: Pi LAN address and port, speech allow-list, tray path, development Core address (`127.0.0.1:<dev-port>`) |
| `%ProgramData%\ShadowAssistant\agent\agent.token` | Agent token, DPAPI machine scope, ACL: service account + Administrators |
| `%LOCALAPPDATA%\ShadowAssistant\mirror-rehearsal\data\`, `…\daily\` | **Rehearsal mirror** (until T23.2) |
| `<vault>\.shadow-assistant\` | **Live mirror** target for the data folder (after T23.2) |
| `<vault>\<companion>\Assistant\daily\` | **Live mirror** target for the daily summaries (after T23.2) |
| `%LOCALAPPDATA%\ShadowAssistant\logs\` | Tray and development Core logs (as today); the service logs to the Windows event log and `%ProgramData%\ShadowAssistant\logs\` |

The development Core keeps running from the repository as today (tray
`CoreSupervisor`, T16.1), on its own port (T21.6).

### 6.3 Vault clone, write area, push guard (K7, decisions 3, 8, 10)

- **Clone (T18.1):** `git clone --filter=blob:none --sparse` with a deploy key
  that may push to this one repository, then a **non-cone** sparse pattern that
  keeps everything except `Private/` (cone mode cannot exclude a folder).
  Optional hardening to verify: run git with lazy fetching disabled
  (`GIT_NO_LAZY_FETCH=1`), so no later command can download the excluded blob.
  Check: `git ls-files Private` shows no file in the working tree, and the
  tracked file's blob is not in the object database (`git cat-file -e` fails).
- **Write area (T18.2):** the Core writes only under
  `<vault>/<companion>/Assistant/`. The write gate resolves the real path and
  refuses anything outside (also through `..`, links, case variants).
- **`Assistant/` contents (T18.5, decision 10):** notes from "not al", the
  memory summary (readable form of `state.json`), development notes (readable
  form of dev-notes), daily summaries in `Assistant/daily/`.
- **Commit and push (T18.3):** the Core stages only explicit paths under
  `Assistant/` (never `git add -A`), commits in batches, pushes on a timer;
  periodic pull, immediate pull on commands like "hafızanı güncelle".
- **Push guard (R6, T18.1):** before every push the Core lists the outgoing
  change (`git diff --name-only <remote>/<branch>..HEAD`); any path outside
  `<companion>/Assistant/`, or inside `<companion>/Assistant/daily/`, stops the
  push: nothing is pushed, the reason is logged and a notification is raised. A
  `pre-push` hook runs the same check as a second line.
- **Conflicts (T18.4, decision 3):** the user's version wins; the assistant's
  version is written to `<name>.assistant-<date>.md` beside it.
- **Daily summaries stay out of git (T18.6):** the vault's root `.gitignore` gets
  `/<companion>/Assistant/daily/`. This line is outside the write area, so the
  push guard would refuse it from the Pi: it is added once by the user from the
  PC (see Q6).

### 6.4 Mirror (M6)

Scope: two roots. `data` = the Pi data folder -> `.shadow-assistant`;
`daily` = `<companion>/Assistant/daily/` of the Pi clone -> the same path in the
PC vault. Excluded on the Pi side: `dev/` (never listed, never deleted),
temporary files of atomic writes.

Flow (service drives, tray writes; T13.6, T14.6, T16.3):

1. On every agent connection with a tray attached, and then every 60 s, the
   service asks the tray `mirror_scan_request {root}`; the tray answers
   `mirror_scan {root, files:[{path, size, mtime, sha256}]}` for its target
   folder (rehearsal or live, 6.5), skipping `dev/`.
2. Service -> Core `mirror_list_request {requestId, root}`; Core ->
   `mirror_list {requestId, root, files:[…]}` (same fields; the Core caches
   hashes by size + mtime so a re-list does not re-read unchanged files).
3. The service compares by `sha256` (mtime only to skip work). For each new or
   changed file: `mirror_get {requestId, root, path, offset}` ->
   `mirror_chunk {requestId, root, path, sha256, size, offset, data, final}`
   (up to 1 MiB raw per chunk, base64), passed to the tray as `mirror_put` with
   the same fields plus `mtime`.
4. The tray writes into a temporary file in the target folder, checks size and
   hash at `final`, replaces the file atomically, sets the mtime and answers
   `mirror_ack {root, path, ok, code?}`. A bad hash: `ok:false`, file left as it
   was; the next round tries again.
5. Files present at the target but not on the Pi: `mirror_delete {root, path}`,
   only for files the mirror itself wrote before (the tray keeps a small
   manifest of them), never under `dev/`.
6. Drop or tray gone: the round is abandoned, temporary files deleted; the next
   round recomputes the difference. Nothing is lost (M6).

Path rules in the tray: relative paths only, no `..`, no drive or UNC prefix,
no alternate data streams, no reserved Windows names, the resolved path must
stay inside the target root (no junction or link escape). Anything else:
`ok:false`, logged.

Why the service compares and the tray only writes: the plan puts the
comparison in the service (T14.6); the tray stays a simple writer with its own
path checks, which matters because it writes into the user's vault.

### 6.5 Rehearsal folder and the switch to live

- Until T23.2 the tray's mirror target is the **rehearsal folder**
  (`%LOCALAPPDATA%\ShadowAssistant\mirror-rehearsal\`), outside the vault and
  outside OneDrive: the live `<vault>\.shadow-assistant` belongs to the
  production Core on the PC until the move.
- The target is a tray setting `mirror.target` = `rehearsal` (default) or
  `live`. There is **no menu item** for it: it is changed by hand in the tray
  settings file in T23.2 step 6, after the last copy has been checked, so it
  cannot be switched by accident. The tray logs the target at every start.
- The development Core reads from the same folder the mirror writes to:
  rehearsal before T23.2 (T21.2), live after.

### 6.6 Backups (K8, T19)

- rclone and the existing crypt configuration move to the Pi; secrets in
  credstore (T19.1). A systemd timer runs the backup (T19.2).
- Archive contents: the data folder (without `backup/status.json`, as today)
  and `<companion>/Assistant/daily/` from the clone (T19.5; its only copy
  besides the mirror). The rest of the vault is in git.
- Status: `<data>/backup/status.json`, written where the Core reads it (same
  `core.env`).
- The PC's backup task is switched off only after the first good Pi backup with
  real data after T23 (T19.4).

### 6.7 Development Core (K10a, M7)

- Starts with `SHADOW_ROLE=dev`, on its own port; marked "dev" in UI, log and
  notifications (T21.1, T21.6).
- **Reads** memory, conversations and dev-notes from the mirror folder
  (`SHADOW_DATA_DIR` = rehearsal or live data mirror; T21.2).
- **Writes** nothing into the mirror except under `dev/`:
  `dev/conversations/…` (its own conversation records, T21.5),
  `dev/dropped-writes.jsonl`, and every other state file it needs to run
  (sessions, usage, notifications store, …). T21 lists those files; the rule is
  that a role-dev Core opens no write path outside `dev/` (tested, T21.2).
- **Write link to the Pi (M7, O7; the exception to "one connection").** A
  `/ws` connection to the Pi with its own device token and
  `hello.role:"dev"`:

```json
{"type":"hello","protocol":1,"token":"…","client":"core","role":"dev"}
{"type":"dev_write","id":"w-1","kind":"memory_note"|"memory_update"|"memory_forget"|"dev_note","payload":{…}}
{"type":"dev_write_result","id":"w-1","ok":true}
{"type":"dev_notify","id":"w-2","item":{…}}
```

  The Pi accepts `role:"dev"` only from devices listed in
  `CORE_DEV_ROLE_DEVICES` and only from `CORE_AGENT_SOURCE`; such a session may
  send only `dev_write` / `dev_notify` (a `user_text` gets `not_allowed`).
  Records written this way carry `origin:"dev"`; notifications go to the phone
  with the "[dev]" prefix and `origin:"dev"` (K10a, P1). Feature `dev_role` in
  `welcome`. The link works with the development switch off (T21.3). The payload
  shapes are fixed in T21.3.
- **Pi unreachable (M7, T21.4):** the write or notification is dropped, its full
  content appended to `dev/dropped-writes.jsonl`
  (`{ts, kind, payload, reason}`), the band "[dev] Pi'ye ulaşılamıyor, yazmalar
  yerelde kaydediliyor" is shown, notifications stay in the development UI and
  the tray. No automatic resend.
- Urgent speech is off in role dev (T21.7).

**Why `/ws` with a role and not a new endpoint or HTTP.** M7 names a `hello` with
`role: dev`; the `/ws` handshake, token check and reconnect logic already exist.
An HTTP `POST` (like `/device/state`) was considered: simpler per call, but a
second auth path and no place for the role in a `hello`.

**Plan tasks.** T11.1-T11.5, T13.6, T14.6, T16.3, T17.1-T17.3, T18.1-T18.6,
T19.1-T19.5, T21.1-T21.7, T23.2 (step 6), T23.5.

**Not verified.**

- Non-cone sparse checkout together with `--filter=blob:none` never fetching
  the `Private/` blob across pulls and merges; `GIT_NO_LAZY_FETCH` support in
  the Pi's git version.
- systemd `StateDirectory=` with `User=<user>` (ownership on first start) and
  `LoadCredential=` for a non-root `User=`.
- That the tray can write into `<vault>` under OneDrive with atomic replace and
  set mtimes (the reason M6 gives the job to the tray).
- Hash cost of a 60 s re-list on the Pi for the real data size (cached by
  size + mtime, expected small).

**Open questions.** Q4 (`deploy/pi/` vs `deploy/linux/`), Q6 (who commits the
`.gitignore` line).

---

## Failure modes

| Failure | Effect | Handling |
|---|---|---|
| Wi-Fi of the Pi drops for < 15 s | nothing visible | heartbeat tolerance |
| Pi down | phone: "Çekirdeğe ulaşılamıyor"; tray: "Pi'ye ulaşılamıyor"; PC service keeps retrying | no local fallback (R2) |
| Service crashed | tray: "Shadow servisi çalışmıyor"; Pi: PC off | Windows recovery restarts it (T14.2, R7) |
| Tray crashed | Pi: `no_session`; desktop commands `no_session`; UI on the PC gets no relay | user restarts the tray (single instance) |
| Command sent, channel drops | `interrupted`, "yapılıp yapılmadığı bilinmiyor" | no retry (1.5) |
| Mirror write fails | old file stays; retried next round | 6.4 |
| Update fails health check | previous release back, notification | 5.2 |
| Push guard trips | nothing pushed, notification | 6.3 |

## Relation to existing documents (changed by this design)

- **docs/02:** `/health` `inbox` is documented as "for the tray on the same
  machine"; after the move the tray gets the counts from `core_status` (1.8).
  New: `/agent`, the `pc` frame and feature `pc_status`, `welcome.version` /
  `welcome.warnings`, detail codes `pc_off` / `pc_dev`, `hello.role`,
  `CORE_AGENT_CLIENT_DEVICES`. Written into docs/02 by T13.4 / T24.3.
- **docs/11 D1:** loopback `/pc`, the per-start token file
  `%LOCALAPPDATA%\…\pc-svc.token` and the Core-internal `pc-svc` health entry
  are replaced by sections 1 and 3 (T24.2). The executor and its messages stay.
  The "Shadow da kapanacak" warning text changes (1.7).
- **docs/12:** D4 (headless Core on the PC) no longer applies; Q5 has its new
  form in 2.4; Q4, Q6, Q7 are obsolete, Q8 (Fast Startup off) still matters for
  WoL (T24.1).
- **docs/05:** section 3 (tray starts the Core) becomes the development set-up
  only; section 4 (backups) moves to the Pi; section 5 gains the Core on the Pi
  (T24.3).
- **v0.2 plan M5 wording:** "the tray keeps today's device token and produces
  `hello` itself" does not match the code (3.2, Q1).
- **v0.2 plan T11.1:** names `deploy/pi/`; the existing Linux box files are in
  `deploy/linux/` (Q4).

## Open questions (Kullanıcı kararı gerekli)

The document uses the proposal in each row until the user decides (T10.6).

| # | Question | Proposal |
|---|---|---|
| Q1 | The tray has no device token today; the UI has it. Accept the **relay** (3.2 a: the UI connects to a loopback `/ws` on the tray's UI port, the tray passes frames unparsed over the pipe) instead of the plan's "the tray holds the token and produces `hello`"? | Relay. |
| Q2 | Agent channel (and with it the PC's chat and audio) runs as plain `ws://` on the home LAN, like the phone's home address today. Enough, or TLS (`wss://` with a self-signed certificate pinned in the service) on `/agent`? | Plain `ws://` now (same as the accepted phone home path); revisit if the LAN is not trusted. |
| Q3 | Service account: a virtual service account (`NT SERVICE\…`) granted `SeShutdownPrivilege`, or `LocalSystem`? | Virtual account (least privilege); `LocalSystem` only if a needed API fails under it (T14.2). |
| Q4 | Pi deploy files in `deploy/pi/` (plan T11.1) or next to wake-svc in `deploy/linux/` (existing)? | `deploy/linux/` (one place for the box), unless the user wants the plan's name. |
| Q5 | How are the service and the tray built, versioned and updated on the PC? The plan has workflows for the Core and Android only; today the tray is published locally. | A CI artifact for both from the same run (one version), installed by an elevated script; automatic update later, not in v0.2. |
| Q6 | The `.gitignore` line for `Assistant/daily/` lies outside the Pi's write area, so the push guard refuses it from the Pi. Added once by the user from the PC? | Yes, by the user, before T18.6 is tested. |
| Q7 | Development mode is held in memory on the Pi: a Pi restart while the switch is on shows "off" (wake suggested) until the service returns. Accept, or persist it? | Accept (rare; manual return to the Pi clears it). |

## Not verified (summary)

Listed per section above. The ones that can change the design: tool hiding with
the persistent SDK session (2), the source address behind the subnet router (1),
pipe peer checks from .NET (3), and lazy fetch with sparse + partial clone (6.3).
Each is checked first in the task that uses it.

## Implementation map

| Section | Tasks |
|---|---|
| 1 Agent channel | T13.1, T13.2, T13.4, T14.2, T14.3, T14.4, T14.8, T14.9 |
| 2 PC state | T13.2, T13.3, T13.4, T14.4, T14.7, T15.3, T16.4, T22.2, T23.4 |
| 3 Pipe and client session | T13.5, T14.1, T14.4a, T14.5, T16.1, T16.1a, T16.2, T16.6 |
| 4 Voice proxy | T15.1-T15.4, T25.1, T25.2 |
| 5 Release and update | T12.1-T12.3, T14.9, T16.6 |
| 6 Layout | T11.1-T11.5, T13.6, T14.6, T16.3, T17, T18, T19, T21, T23.2, T23.5 |

## Progress log

- 2026-11-27: design written for T10.1-T10.5 (software-architect, after a Codex
  review). From the review: the tray relay instead of a tray token, a
  `core_status` frame for the tray counts, Pi-driven 5 s / 15 s heartbeat,
  "unknown outcome" wording for interrupted commands, path rules for the mirror
  writer, Origin check on the relay. Deviations from the review: a restricted
  HTTP forwarder instead of typed speech frames, base64 in JSON instead of
  binary frames, no chunking of client frames. Awaiting T10.6.
