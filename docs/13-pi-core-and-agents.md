# 13 - Core on the Pi, the PC system agent and the tray link

Status: **design, revised after the user's answers of 2026-11-27 (Q1-Q7); the
remaining review is v0.2 plan T10.6.** Written for T10.1-T10.5 of the v0.2
plan. Nothing here is implemented yet; the plan tasks that build it are named in
every section, and tasks that the answers change or add are listed in the
[implementation map](#implementation-map).

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
assistant's area), `<core-port>`, `<tls-port>`. Nothing in this
document or in the implementation may hold real addresses, MACs, host or tailnet
names, account names, vault folder names or tokens.

## Problem

The Core and Claude run on the PC today. When the PC is off or nobody is signed
in, there is no assistant: no home control from the phone, no notifications. The
v0.2 plan moves the Core to the Pi (K1) and leaves on the PC only what needs the
PC: power commands, desktop commands, speech services (whisper-svc, tts-svc) and
the user's vault copy. This document fixes the contracts between the parts:

1. Pi Core <-> PC service: one outbound WebSocket (`/agent`).
2. PC service <-> tray: a local named pipe.
3. The UI in the PC's browser: served by the Pi over HTTPS on the LAN.
4. Everything that rides on them: PC state, desktop and power commands, voice,
   the data mirror, the development Core's writes. Plus release, update, file
   layout and the hardening of the PC service.

## Fixed decisions (v0.2 plan and user answers; not reopened here)

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
- **M5** one connection PC -> Pi for the **service**; the tray never connects to
  the Pi and talks to the service over the pipe. Four PC states (off / on without
  a session / full / development mode). No queue anywhere: an interrupted command
  fails.
- **A1 / O1, changed by the user on 2026-11-27 (Q1):** the UI is **not**
  relayed through the tray and the service. The PC's browser opens the UI
  directly from the Pi, like the phone, and connects to the Pi's `/ws` with its
  own device token. This is a deliberate second connection from the PC to the Pi
  (besides the service's `/agent` and the development Core's `role: dev` link).
  The tray's own traffic (desktop commands, mirror, development switch, state)
  still goes pipe -> service -> Pi. The `client` envelope and the virtual client
  session of the earlier draft are dropped.
- **Q1 addition (2026-11-27):** the browser opens the microphone only in a
  secure context, so the Pi serves the UI and `/ws` over **HTTPS / WSS on the
  LAN** with its own certificate, trusted once on the PC (section 4).
- **Q2 (2026-11-27):** `/agent` stays plain `ws://` on the LAN.
- **Q3 (2026-11-27):** the service runs as a virtual service account, built
  with care (section 8).
- **Q4 (2026-11-27):** Pi deploy files live in `deploy/linux/`.
- **Q5 (2026-11-27):** the service and the tray get a CI release and an updater
  on the PC, like Android and the Core (section 6.4).
- **Q6 / Q7 (2026-11-27):** see the decisions table.
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
  [6.3](#63-two-different-go-back-rules) for how this differs from the updaters'
  version rollback).

## Current state (what the design relies on)

Checked in the code on 2026-11-27.

- **Client endpoint.** `core/src/server.ts` upgrades only `/ws` (404 otherwise).
  The first frame must be `hello` within 5 s; the token is checked
  (`authenticate`), then `hello.protocol` (4401 / 4400). No Origin or Host check.
- **No server-side heartbeat** on `/ws`: clients send `ping`, the Core answers
  `pong`.
- **Versions.** The Core version (reported only by `GET /health`) is read
  when the server is created from the root `VERSION` file (`core/src/version.ts`; env
  `CORE_VERSION` overrides it, `0.0.0-dev` when the file is missing; 2026-11-27,
  first step of T12.3); `welcome` carries no version. The root
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
  `http://localhost:<port>` (`UiServer.cs`). The UI stores the device token in
  the browser (per origin) and sends `hello` itself (`ui/src/protocol/client.ts`;
  default address `ws://localhost:8700/ws`). The tray reads the unauthenticated
  loopback `GET /health` for its icon and the `inbox` counts (`TrayInbox`; a
  test asserts the tray settings hold no token). The user's Q1 answer keeps
  this split: the UI stays the only client, the tray stays tokenless.
- **Android** loads its UI from the app bundle
  (`https://appassets.androidplatform.net/assets/ui/`) and only connects to the
  Core's `/ws`; plain `ws://` is allowed only to a private IPv4 literal (docs/12
  progress log 2026-11-17). Away from home it uses Tailscale `serve` on the box
  (`wss://`, docs/05 section 5).
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
 phone (home) ──ws:// LAN──────────────────►┐
 phone (away) ──wss:// Tailscale serve─────►┤  Pi: Core
 PC browser (UI) ──https/wss:// LAN (Pi cert)►┤   - TLS listener: UI files, /ws, /health
                                            │   - plain listener: /ws, /health (LAN, loopback),
 PC service ──ws:// LAN /agent─────────────►┘     /agent (LAN, PC address only)
                                                data dir, vault clone, backups
 PC ─────────────────────────────────────────────────────────────────────────
  service (session-less Windows service, virtual account)
    ├─ power commands (itself)
    ├─ whisper-svc / tts-svc on 127.0.0.1 (http_request forwarder)
    └─ named pipe ──► tray (signed-in user; no token)
                        ├─ desktop commands (pc-svc executor), pc_state
                        ├─ mirror writer (rehearsal folder until T23.2)
                        ├─ development switch
                        └─ icon + counts (core_status); "Arayüzü aç" opens the Pi's UI
 development Core (PC, role dev)
    ├─ its own /agent on loopback (the service connects only while the switch is on)
    ├─ its own UI on localhost (tray UiServer, as today)
    └─ /ws to the Pi with hello role:"dev" (writes, notifications)  [M7 exception]
```

---

## 1. Agent channel (T10.1)

### 1.1 Endpoint and transport

- `ws://<pi-lan-ip>:<core-port>/agent` on the Core's plain LAN listener (4.2).
  JSON **text** frames with a `type` field; binary frames are a protocol error.
  Max frame **40 MiB** (a 25 MB speech body in base64 is about 34 MB, see 5.2).
- Plain `ws://` on the LAN (user decision Q2, 2026-11-27). The residual risk is
  in 8.8.
- The service connects to the Pi's **LAN** address, never through the Tailscale
  name: through Tailscale the source address would be the PC's tailnet address
  and the source check below would have to follow it.

### 1.2 Who may connect (source address, token)

Checked in this order, all before a session exists:

1. **Source address, before the upgrade.** `req.socket.remoteAddress` must equal
   `CORE_AGENT_SOURCE` (one IPv4 address; the IPv4-mapped IPv6 form is accepted
   too). Anything else gets `403` and no upgrade. `X-Forwarded-For` and other
   headers are never read. A request with an `Origin` header is refused
   (`403`): no browser page may open `/agent`. `/agent` is not served on the
   TLS listener nor on loopback. T9.4 made the PC's LAN address a DHCP
   reservation, so the value is stable.
2. **`agent_hello` within 5 s**, token compared in constant time with
   `CORE_AGENT_TOKEN` (at least 32 characters; credstore on the Pi, see 7.1).
   Wrong or late: `error unauthorized`, close **4401**.
3. **`agentProtocol`** different from the Core's: `error bad_request`, close
   **4400** (M3: different protocol = refused).

The development Core runs the same code; its `/agent` accepts only loopback
(`CORE_AGENT_SOURCE=127.0.0.1`) and the same agent token (K10).

One agent at a time: a new authenticated agent connection replaces the old one
(the old one is closed with 4409 `replaced`). Without `CORE_AGENT_TOKEN` the
endpoint answers 404 like an unknown path.

### 1.3 Handshake

```json
{"type":"agent_hello","agentProtocol":1,"token":"…","version":"0.2.57",
 "capabilities":["power","desktop","voice","mirror"],
 "state":{"session":"active","tray":true,"pc":{"locked":false,"fullscreen":false,"gameMode":false}}}
```

| Field | Meaning |
|---|---|
| `agentProtocol` | Integer, today `1`. Rule of M3, independent of the client protocol. |
| `token` | Agent token. Never in the URL, never logged. |
| `version` | The service's release version `X.Y.<n>` (6.4). Only `X.Y` is compared. |
| `capabilities` | What this service can do now: `power`, `desktop` (a tray is attached), `voice` (the speech forwarder is configured), `mirror`. Unknown names are ignored. |
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
  outage within seconds. The 10 s command timeout (1.7) is independent.
- **Planned goodbye.** Before sleep, shutdown, restart or a service stop the
  service sends `{"type":"agent_bye","reason":"sleep"|"shutdown"|"restart"|"stopping"|"update"}`
  and closes; the Core marks the PC off at once instead of 15 s later.
- **Reconnect (service).** Backoff 1, 2, 4, 8, 16, 30 s (30 s cap), each with
  50-100 % random jitter; the counter resets after 60 s connected. After a 4401
  or 4400 the service retries every 5 min only and reports
  `link.pi:"rejected"` to the tray. On resume from sleep and on network change
  the service reconnects at once (T14.8).

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
- A running mirror sync is dropped; the next connection starts with a fresh
  list (7.4).
- Client connections (phone, PC browser) are **not** affected: they have their
  own sockets to the Pi.

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
  `failed`) plus `no_session`, `already_locked`, `rejected` (failed input
  validation, 8.5); `interrupted` and `timeout` are produced by the Core only.
- **Timeouts (Core side):** 10 s for every `pc_request` (docs/11), then
  `timeout`, no retry. The service's own wait for the tray is 9 s, so its
  `failed` arrives before the Core gives up.
- **Duplicates:** the service and the tray remember a `requestId` for 10 min; a
  repeat returns the first answer and runs nothing. With no queue the Core never
  resends; this is defence in depth.
- Policy (permission list, confirmation, locked/fullscreen rules) stays in the
  Core (docs/11 D3, D4, D8). After the move the power warning text changes: the
  Core keeps running on the Pi, only the PC goes away (docs/11 update in T24.2).

### 1.8 Core status for the tray (Core -> service)

The tray's icon and the "Geliştirme (N)" / "Bildirimler (N)" / "İzinler (N)"
counts come from the loopback `GET /health` today; the Pi's Core is not on the
PC's loopback, and remote `/health` callers get no `inbox`. The Core therefore
sends the same numbers on the channel:

```json
{"type":"core_status","version":"0.2.61",
 "services":[{"name":"home-assistant","status":"ok","checkedAt":0}],
 "inbox":{"dev":2,"notifications":1,"notificationsUnavailable":false,"pc":0}}
```

Sent after `agent_welcome` and whenever a value changes (same triggers as the
`services`, `dev_count` and `pc_permissions_count` frames). Numbers, flags and
service states only, exactly what `GET /health` already gives a loopback
caller; no titles, no texts. The service keeps the last one and hands it to
every tray that attaches (3.3).

### 1.9 Other frames on the channel

| Frame | Direction | Section |
|---|---|---|
| `http_request` / `http_response` / `http_cancel` | Core -> service / back | [5](#5-voice-proxy-t103) |
| `mirror_list_request` / `mirror_list` / `mirror_get` / `mirror_chunk` | service -> Core / back | [7.4](#74-mirror-m6) |
| `agent_mode` / `agent_mode_ack` | service -> Core / back | [2.3](#23-development-mode) |
| `error` | both | `{"type":"error","requestId"?:"…","code":"…","message":"…"}`; unknown frame types and fields are ignored (as on `/ws`). |

**Why this shape.** One socket, one token, one source rule and one drop signal
for the PC's services (M5). Keeping the docs/11 command frames means the executor
in the tray is the one docs/11 already designed. Liveness is driven by the Pi
because only the Pi needs the "PC off" fact. Application-level ping because both
sides can test it and the .NET and Node libraries differ in what they expose.

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
- A frame of 40 MiB blocks the socket for a few seconds over Wi-Fi; only an
  unusually long utterance comes close.

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
| PC speech (whisper-svc / tts-svc through the agent), for every client | none | yes, if the T7 backend runs without a session | yes | none |
| Phone speech | Android recognizer if T40.1 is done, else "sesli komut kullanılamıyor" (K5) | through the PC | through the PC | as `off` |
| whisper-svc / tts-svc in `services` / `/health` | `down`, detail `pc_off`; no outage notification (T13.3) | as checked | as checked | `down`, detail `pc_dev`; no notification |
| UI band / phone panel | "Bilgisayar kapalı" + **Bilgisayarı uyandır** offered | "Bilgisayar açık, oturum yok" | none | "Bilgisayar geliştirme kipinde"; wake **not offered**, manual wake still available (P2) |
| `pc_state` | none | none | `{locked, fullscreen, gameMode}` | none |
| Mirror | none | none (needs the tray) | runs | paused |
| UI in the PC's browser | n/a (PC off) | n/a (nobody signed in) | Pi `/ws` directly | still the Pi; the development Core has its own UI on localhost (7.7) |

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

The Pi keeps `dev` in memory until a new agent connects (user decision Q7,
2026-11-27): a Pi restart while the switch is on shows `off` (wake suggested)
until the service returns. If the PC really goes off while the switch is on, the
Pi still shows `dev`: manual wake stays available (P2), only the suggestion is
hidden.

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

---

## 3. Tray link: the pipe (T10.2a) and the UI on the PC (T10.2b)

### 3.1 Pipe: transport and security (O3, T14.5)

- Name: `\\.\pipe\ShadowAssistant.Agent`. Byte mode; each message is a 4-byte
  little-endian length followed by UTF-8 JSON with a `type` field. Max message
  **8 MiB** (mirror chunks are 1 MiB raw; nothing else is large now that client
  traffic does not pass here).
- Server: the service. Created with `PIPE_REJECT_REMOTE_CLIENTS` and an ACL
  granting access only to the service's SID and the **active console user's
  SID** (re-created when the console user changes). One tray connection at a
  time; a second is refused.
- **Service checks the client** (details and fallbacks in 8.4): the client's
  token (by impersonating the pipe client) must belong to the console user and
  the active console session; the client process's image path must equal the
  installed tray path (`C:\Program Files\ShadowAssistant\…`, not
  user-writable). Any mismatch: disconnect and log.
- **Tray checks the server:** `GetNamedPipeServerProcessId` -> the process must
  be the installed service executable (blocks a user process that grabbed the
  name first).
- On session change (sign-out, user switch; lock is **not** a change) the
  service closes the pipe connection.
- First message from the tray: `{"type":"pipe_hello","pipeProtocol":1,"version":"0.2.57"}`;
  answer `{"type":"pipe_welcome","pipeProtocol":1,"version":"0.2.57"}`. Different
  `pipeProtocol`: closed. A different `version` makes the tray restart itself
  from the installed path after an update (6.4).

### 3.2 Pipe messages

| Direction | Message | Purpose |
|---|---|---|
| tray -> service | `pipe_hello` | 3.1. |
| service -> tray | `pipe_welcome` | 3.1. |
| service -> tray | `link` `{pi:"connected"\|"connecting"\|"rejected", target:"pi"\|"dev", warnings?:[…]}` | Agent channel state. Sent at attach and on change. |
| service -> tray | `core_status` | The Core's last 1.8 frame, plus `stale:true` while the channel is down (counts are shown as not current, not reset to 0). |
| tray -> service | `tray_state` `{pc:{locked, fullscreen, gameMode}}` | `pc_state` source; the service puts it in `agent_state`. |
| service -> tray | `pc_request` | Desktop command (1.7), unchanged. |
| tray -> service | `pc_response` | Reply, unchanged. |
| tray -> service | `dev_switch` `{on}` | Development switch (2.3). |
| service -> tray | `dev_switch_result` `{on, ok, code?}` | `code:"no_ack"` when the Pi did not acknowledge. |
| service -> tray | `mirror_scan_request` / `mirror_put` / `mirror_delete` | Mirror (7.4). |
| tray -> service | `mirror_scan` / `mirror_ack` | Mirror (7.4). |

The service holds no state for the tray beyond the last `core_status` and the
last `tray_state`. Nothing is queued: a `pc_request` while no tray is attached
gets `no_session` at once (M5). Every message type and field is checked against
a fixed schema on both sides; unknown types are logged and dropped (8.5).

### 3.3 What the tray shows

The tray has no chat, no push-to-talk and no notification texts of its own; it
never had them (they are in the UI). After the move it shows:

| Tray state | Condition | Icon / menu |
|---|---|---|
| "Shadow servisi çalışmıyor" | no pipe (the tray decides) | grey; PC functions (desktop commands, mirror, development switch) unavailable |
| "Pi'ye ulaşılamıyor" | pipe up, `link.pi` not `connected` | as today's "down"; counts marked stale |
| connected | `link.pi:"connected"`, target `pi` | as today's "running", counts from `core_status` |
| development | target `dev` | clearly marked (T16.4) |

- **Counts** ("Geliştirme (N)", "Bildirimler (N)", "İzinler (N)") come from
  `core_status` and stay numbers only (docs/08: the tray's notification text
  shows only a count; S8). Clicking one opens the Pi's UI at the matching page
  (the same hashes the tray uses today, plus `#permissions`).
- **No balloons with notification text.** Notifications are read and acted on
  in the UI (browser) and on the phone, as today. Urgent spoken notifications
  are spoken by a connected UI, as today.
- **"Arayüzü aç"** opens `https://<pi-lan-ip>:<tls-port>/` in the default
  browser. The tray's `UiServer` stays only for the development Core's UI
  (a separate "Geliştirme arayüzü" item while the development Core runs).
- O5 still holds for the tray: without the service or without the Pi link, the
  tray sends nothing and only shows the state. The UI is not affected (3.4).

### 3.4 The UI on the PC: direct to the Pi (T10.2b, user decision Q1)

- The browser loads the UI from the Pi's TLS listener and connects to
  `wss://<pi-lan-ip>:<tls-port>/ws` (same origin), exactly like any client:
  `hello` with its own device token, the docs/02 protocol unchanged.
- **Device token:** browser storage is per origin, so the token is entered once
  on the new origin. Which device name the PC browser uses is Q9.
- **Independent of the service:** if the service or the tray is down, the UI
  keeps chat, home control and notifications. What it loses is what needs the
  PC side: PC speech (the forwarder is in the service) and PC tools (the Pi sees
  the PC as `off`).
- **Push-to-talk on the PC:** the browser records, sends `audio` to the Pi, the
  Core sends the utterance back to the PC's whisper-svc through the agent
  (section 5). The microphone needs a secure context: hence section 4.
- Not needed any more (earlier draft): the tray relay `/ws`, the `client_open`
  / `client_frame` / `client_close` envelope, `cid` multiplexing, the Core's
  virtual client session and `CORE_AGENT_CLIENT_DEVICES`.

**Why.** The UI already is a complete client with its own token; giving it a
direct socket removes a multiplexing layer from the service, the tray and the
Core, and makes the UI survive a service crash (R7 shrinks). The cost is a
second PC -> Pi connection (accepted by the user) and HTTPS on the LAN for the
microphone.

**Plan tasks.** T14.1 (pipe library shared by service and tray), T14.4 (state,
desktop commands), T14.5 (pipe security, negative tests), T16.1 / T16.1a
(tray: "Arayüzü aç" to the Pi, states of 3.3, `UiServer` only for development),
T16.2 (`pc_request` executor, `pc_state`), T16.6 (version display). T13.5 and
T14.4a are no longer needed in their planned form (implementation map).

**Not verified.**

- Pipe peer checks from .NET in both directions under a virtual service account
  (8.4).
- Pipe ACL re-creation when the console user changes without the service
  restarting.

---

## 4. HTTPS on the LAN for the UI (new; user decision Q1 addition)

### 4.1 Contract

- The Pi's Core serves the built UI (`ui/dist`, shipped in the Core release
  package, T12.1) and `/ws`, `/health` on a **TLS listener**
  `https://<pi-lan-ip>:<tls-port>/`. Static files: GET/HEAD only,
  `X-Content-Type-Options: nosniff`, no directory listing (the rules of today's
  `UiServer`).
- The UI's default Core address, when it is loaded from the Pi, is its own
  origin (`wss://<same host>/ws`); the connect screen still allows another
  address.
- `/ws` on the TLS listener accepts only an `Origin` equal to the listener's own
  origin, or no `Origin` (non-browser clients). This blocks other web pages in
  the PC's browser from using the stored token's session.
- `/agent` is **not** served on the TLS listener (Q2: plain).

### 4.2 Listeners on the Pi

| Listener | Bind | Serves | Who uses it |
|---|---|---|---|
| TLS | `<pi-lan-ip>:<tls-port>` | UI files, `/ws`, `/health` | the PC's browser (and any LAN browser) |
| plain | `<pi-lan-ip>:<core-port>` | `/ws`, `/health`, `/agent` (PC address only, 1.2) | phone at home (`ws://`, private IPv4 rule of docs/12), service |
| plain | `127.0.0.1:<core-port>` | `/ws`, `/health` | Tailscale `serve` (phone away, `wss://` with Tailscale's certificate), updater health check |

Nothing listens on `0.0.0.0`, so the tailnet interface reaches the Core only
through `serve`.

### 4.3 Certificate

- **Local CA on the Pi.** At install (T11) a small CA is created on the Pi:
  EC P-256 key, valid 10 years, **name-constrained** to the Pi's LAN address
  (`IP:<pi-lan-ip>/32`, plus an optional LAN host name). The CA key stays on
  the Pi, root-only (`/etc/shadow-assistant/tls/ca.key`, 0600), used only to
  sign the server certificate.
- **Server certificate:** EC P-256, `subjectAltName = IP:<pi-lan-ip>`, valid
  **1 year**, signed by the CA; key readable by the Core's user only, delivered
  with `LoadCredential=`.
- **Renewal:** a systemd timer (weekly) renews the server certificate 30 days
  before expiry and restarts the Core (or reloads the TLS context). Renewal does
  not touch the PC: the PC trusts the CA, not the leaf.
- **Trust on the PC (once, by the user):** copy `ca.crt` (public) from the Pi and
  import it into the **current user's** "Trusted Root Certification
  Authorities" (`certutil -user -addstore Root ca.crt`); Edge and Chrome use the
  Windows store. Because of the name constraint, the CA can vouch for nothing
  but the Pi's address even if its key leaked. Repeat only when the CA is
  recreated (10 years, or a changed Pi address).
- **Considered:** Tailscale's certificate for the box's `ts.net` name (no own
  CA, but the PC would have to reach the Pi through Tailscale and a tailnet name
  would be the UI's address); a self-signed leaf trusted directly (no renewal
  without touching the PC again). The local CA keeps renewals automatic.

### 4.4 Effect on the phone's home address

None in the protocol: Android ships its own UI, so it does not need the Pi's
pages, and it keeps plain `ws://` to a private IPv4 literal at home (the Android
app would not trust a user-installed CA without a network security config
change). Only the address moves from the PC to the Pi, and that stays a T23.2
step (prepared and tested with a test address in T22). Using the TLS listener
from the phone as well is a possible later change (Q10), not part of v0.2.

**Plan tasks.** New subtask proposed for T11 (implementation map): TLS listener,
local CA, renewal timer, UI files in the Core; T12.1 (package includes
`ui/dist`); T16.1 ("Arayüzü aç" to the Pi); T23.2 (user imports the CA before
the PC's UI is switched; checklist item in T23.1).

**Not verified.**

- That the Pi's LAN address is fixed (DHCP reservation). T9.4 checked only the
  PC's. The certificate, the service configuration and the phone's home address
  all depend on it (Q8).
- That Edge/Chrome on the PC honour an IP name constraint on a user-trusted root
  and accept an IP-only `subjectAltName` (expected; checked in T11).
- That `getUserMedia` works on the Pi origin once the certificate is trusted.

---

## 5. Voice proxy (T10.3)

### 5.1 Flows

- **Phone push-to-talk:** phone -> Pi `/ws` `audio` -> Core -> `http_request`
  (whisper-svc) -> service -> `127.0.0.1` whisper -> back; TTS sentences the
  same way (`speech_chunk` to the phone).
- **PC push-to-talk (UI in the browser):** browser -> Pi `/ws` (`wss://`)
  `audio` -> Core -> `http_request` -> service -> whisper -> back. The audio
  crosses the Wi-Fi twice. R4 / T25.1 measure this against the 2.5 s target;
  T25.2 is the conditional short path (needs a new design now, see the
  implementation map).
- **PC off or `dev`:** no `http_request` is sent; `audio` gets `stt_unavailable`
  and the UI shows "sesli komut kullanılamıyor" (T15.3). On the phone: Android
  recognizer if T40.1 is done (K5), else the same message.

"Streamed" in the plan means what exists today: the utterance goes as one piece,
the answer comes back sentence by sentence. Streaming audio *into* whisper is not
part of v0.2.

### 5.2 Frames (agent channel)

A restricted HTTP forwarder, not typed speech frames:

```json
{"type":"http_request","requestId":"h-12","service":"whisper-svc","method":"POST",
 "path":"/transcribe?language=tr","contentType":"audio/webm","body":"<base64>","timeoutMs":60000}
{"type":"http_response","requestId":"h-12","status":200,"contentType":"application/json","body":"<base64>"}
{"type":"http_response","requestId":"h-12","error":"unreachable"|"timeout"|"not_allowed"|"too_large"}
{"type":"http_cancel","requestId":"h-12"}
```

- **The service's own allow-list decides**, never the Pi (8.5): service name ->
  local base URL from the service's configuration (`http://127.0.0.1:8701`,
  `:8702`), and per service the permitted `(method, path)` pairs: whisper-svc
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
Base64 inside JSON instead of binary frames: one framing rule on every link (as
`/ws` today); the overhead on an utterance of a few hundred KB is small.

### 5.3 Privacy

- Audio is held in memory on the Pi only for the request and is never written:
  no file, no log body. The conversation log records the transcript, as today.
- The service logs service name, path, status, byte counts and duration only;
  never bodies.
- The PC browser's audio reaches the Pi over TLS (section 4). The Pi -> PC leg
  (`/agent`) is plain on the LAN (Q2); the phone's home leg is plain too, as
  today.

**Plan tasks.** T15.1 (backend from T7), T15.2 (forwarder in the service, Core
adapter), T15.3 (off / dev behaviour), T15.4 and T25.1 (latency).

**Not verified.**

- The exact paths and content types of whisper-svc and tts-svc (only the three
  calls above were seen in `speech.ts`).
- Round-trip time of a typical utterance through the double hop (T15.4, T25.1).
- That the conversation log and dev-notes never store audio (expected from the
  code; T15.2 adds a test).

---

## 6. Release, version and update (T10.4)

### 6.1 Version source and tags (M3, M4, O8c)

- The base `X.Y` comes only from the root `VERSION` file (today `0.2`).
- Tags, one per workflow, never colliding:

| Product | Tag | Trigger paths |
|---|---|---|
| Android | `v<X.Y>.<n>` (exists) | `android/`, `ui/`, `VERSION` |
| Core (Pi, arm64; includes `ui/dist`) | `core-v<X.Y>.<n>` | `core/`, `ui/`, `VERSION` |
| PC service + tray | `pc-v<X.Y>.<n>` (proposed) | `deploy/windows/`, the shared pipe library, `VERSION` |

  `<n>` is each workflow's run number.
- The build writes the version into the package and the program reports it:
  Core in `GET /health`, a new optional `welcome.version` (additive, protocol
  stays 1) and `agent_welcome.version`; service in `agent_hello.version`; tray
  and service in `pipe_hello` / `pipe_welcome`. The hard-coded
  `CORE_VERSION = "0.1.0"` is gone (2026-11-27): the Core reads `X.Y` from
  `VERSION` at startup (env `CORE_VERSION` can set `X.Y.<n>`); writing the
  build number into the package and `welcome.version` remain T12.3.
- **Compatibility (M3)**, the same rule on every link:

| Link | Protocol field | Different protocol | Same protocol, different `X.Y` |
|---|---|---|---|
| client `/ws` (phone, PC browser) | `hello.protocol` | refused (4400) | accepted, `welcome.warnings:["version_base"]` (needs `hello.clientVersion`) |
| agent `/agent` | `agent_hello.agentProtocol` | refused (4400) | accepted, `agent_welcome.warnings` |
| pipe | `pipe_hello.pipeProtocol` | closed | the tray restarts from the installed path (6.4) |

### 6.2 Pi updater (T12.2)

1. A systemd timer (e.g. every 30 min) runs the updater as root.
2. It asks the GitHub Releases API for the newest `core-v<X.Y>.<n>` with the
   Pi's configured `X.Y` (a new `X.Y` series is never taken automatically).
3. Downloads the package and `SHA256SUMS`, checks the checksum, unpacks into
   `/opt/shadow-assistant/core/releases/<version>/`.
4. Switches the `current` symlink, restarts `shadow-core.service`.
5. **Health check:** within 90 s `GET /health` on `127.0.0.1:<core-port>` must
   answer 200 with `version` equal to the new one.
6. **On failure:** symlink back to the previous release, restart, record the
   version in `/var/lib/shadow-assistant/updater/failed` (never retried) and
   raise a Core notification "güncelleme geri alındı (<version>)" once the old
   Core is up. Keep the current and the two previous releases.

The updater never touches the data folder or the vault clone. A release that
changes the data format must say so in its notes and is not installed by the
timer without a manual step.

### 6.3 Two different "go back" rules

- **Updater rollback (M4, T12.2, and 6.4 for the PC):** a failed release goes
  back to the previous release **of the same product on the same machine**.
  Routine, automatic.
- **No return to the PC (O6, R8, T23.5):** the move itself is one-way. Once T23.2
  has run, the old production Core on the PC is removed; problems on the Pi are
  fixed forward or by restoring a Pi backup (or the last PC backup from the
  move day). The development Core on the PC is not a production fallback.

The two never mix: the updaters only ever choose between releases of the
product they update.

### 6.4 PC release and updater (user decision Q5)

- **CI (proposed new task, implementation map):** one Windows workflow builds
  the service and the tray from the same commit (one version for both), runs
  their tests, and publishes `shadow-pc-<X.Y>.<n>.zip` with `SHA256SUMS` and
  `SHA256SUMS.sig`.
- **Signature:** `SHA256SUMS` is signed with an ECDSA P-256 key kept as a CI
  secret (like the Android keystore); the public key ships in the installed
  updater's configuration. Checksum alone is not enough on the PC, because the
  updater runs with administrator rights. Authenticode was considered: it needs
  a code-signing certificate (cost, or a self-signed one trusted on the PC);
  ECDSA over the checksum file uses only built-in primitives on both sides.
- **Installed layout:** `C:\Program Files\ShadowAssistant\releases\<version>\`
  (service, tray, updater) and a `current` directory junction. The service's
  registered image path and the tray's start entry point at `current\…`.
- **Updater:** a separate executable run by a scheduled task as `SYSTEM`, daily
  and 10 min after start-up. Not the service itself: a service cannot replace
  its own running executable, and the service account stays without write
  rights to `Program Files` (8.3).
  1. Ask GitHub Releases for the newest `pc-v<X.Y>.<n>` with the installed
     `X.Y`; skip versions in the `failed` list.
  2. Download, verify the signature, then the checksum; unpack into
     `releases\<version>\`; set the ACLs of 8.3.
  3. Stop the service (it sends `agent_bye` `update`), switch the junction,
     start the service.
  4. **Health check:** within 60 s the service must be running and must have
     written `%ProgramData%\ShadowAssistant\agent\health.json` with the new
     version and `started:true` (written after its own start-up checks, whether
     or not the Pi is reachable, so a Pi outage does not cause a rollback).
  5. **On failure:** junction back, start the service, add the version to
     `failed`, write an event-log entry; the tray shows "güncelleme geri
     alındı" from the service's next `pipe_welcome`.
  6. **Tray:** at the next `pipe_welcome` with a different version the tray
     starts the installed `current` tray and exits (single instance hands
     over). A running old tray is never killed by the updater.
  Keep the current and the two previous releases.
- **First install:** an elevated script (`deploy/windows/install-agent.ps1`)
  creates the folders, ACLs, the service, its privileges (8.2), the updater task
  and the agent token file.

**Plan tasks.** T12.1, T12.2, T12.3, T14.9, T16.6; new tasks for the PC release
and updater (implementation map).

**Not verified.**

- Which parts of the Core package are architecture-specific (the Agent SDK's
  Claude Code CLI, any native module); T9.1 installed Claude Code separately in
  the user's home.
- That the service control manager and `QueryFullProcessImageName` behave as
  expected with a junction in the image path (the pipe check compares paths;
  it may need to compare against the resolved `releases\<version>\` path).
- GitHub API rate limits for unauthenticated timers (expected well within).

---

## 7. Layout (T10.5)

### 7.1 Pi

Deploy files in `deploy/linux/` (user decision Q4), next to wake-svc.

| Path | What | Owner |
|---|---|---|
| `/opt/shadow-assistant/core/releases/<version>/`, `current` | Core code and UI files (6.2) | root, read-only for the service |
| `/etc/systemd/system/shadow-core.service` | Core unit; `User=<user>` (the account that owns the Claude login, T9.1), `StateDirectory=shadow-assistant` | root |
| `/etc/shadow-assistant/core.env` | Non-secret settings: `SHADOW_DATA_DIR`, `SHADOW_VAULT_DIR`, listener addresses and ports (4.2), `CORE_AGENT_SOURCE`, `WHISPER_SVC_URL=agent://…`, rehearsal flag (T11.5). Read by the Core **and** the backup unit (T17.1: one source for the path). | root 0644 |
| `/etc/shadow-assistant/tls/` | `ca.key` (0600, root), `ca.crt`, server certificate and key (4.3) | root |
| `/etc/credstore/shadow-core.*` | HA token, device tokens, agent token, vault deploy key, TLS server key (`LoadCredential=`) | root 0600 |
| `/etc/credstore/shadow-backup.*` | rclone config and crypt passwords (T19.1) | root 0600 |
| `/var/lib/shadow-assistant/data/` | **Data folder** (`SHADOW_DATA_DIR`): conversations, memory, dev-notes, notifications, sessions, usage, `backup/status.json` | `<user>` |
| `/var/lib/shadow-assistant/vault/` | **Vault clone** (`SHADOW_VAULT_DIR`), 7.3 | `<user>` |
| `~<user>/.claude/`, `~<user>/.claude.json` | Claude login; written by the CLI when it refreshes (T9.1: credstore is not suitable) | `<user>` |
| `/opt/shadow-assistant/wake-svc/` | Unchanged (docs/05 section 5) | root |

- The data folder is set explicitly and lies **outside** the vault clone: git
  never sees it, and the backup takes it as one folder.
- The Core reads its secrets from `$CREDENTIALS_DIRECTORY` (new: today it reads
  `DEVICE_TOKEN_<NAME>` from the environment; T11.2).
- Logs go to the journal. Claude Code reads data over SSH (T17.3).

### 7.2 PC

| Path | What |
|---|---|
| `C:\Program Files\ShadowAssistant\releases\<version>\`, `current` | Service, tray and updater executables (6.4); ACLs in 8.3 |
| `%ProgramData%\ShadowAssistant\agent\agent.json` | Service settings: Pi LAN address and port, speech allow-list, tray path, development Core address (`127.0.0.1:<dev-port>`) |
| `%ProgramData%\ShadowAssistant\agent\agent.token` | Agent token (8.3) |
| `%ProgramData%\ShadowAssistant\agent\health.json`, `…\updater\failed` | Update health and failed versions (6.4) |
| `%ProgramData%\ShadowAssistant\logs\` | Service and updater logs (also the Windows event log, 8.6) |
| `%LOCALAPPDATA%\ShadowAssistant\mirror-rehearsal\data\`, `…\daily\` | **Rehearsal mirror** (until T23.2) |
| `<vault>\.shadow-assistant\` | **Live mirror** target for the data folder (after T23.2) |
| `<vault>\<companion>\Assistant\daily\` | **Live mirror** target for the daily summaries (after T23.2) |
| `%LOCALAPPDATA%\ShadowAssistant\logs\` | Tray and development Core logs (as today) |

The development Core keeps running from the repository as today (tray
`CoreSupervisor`, T16.1), on its own port (T21.6), with its own UI from the
tray's `UiServer`.

### 7.3 Vault clone, write area, push guard (K7, decisions 3, 8, 10)

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
  push guard would refuse it from the Pi: **the user adds it once from the PC**
  (user decision Q6, 2026-11-27), before T18.6 is tested.

### 7.4 Mirror (M6)

Scope: two roots. `data` = the Pi data folder -> `.shadow-assistant`;
`daily` = `<companion>/Assistant/daily/` of the Pi clone -> the same path in the
PC vault. Excluded on the Pi side: `dev/` (never listed, never deleted),
temporary files of atomic writes.

Flow (service drives, tray writes; T13.6, T14.6, T16.3):

1. On every agent connection with a tray attached, and then every 60 s, the
   service asks the tray `mirror_scan_request {root}`; the tray answers
   `mirror_scan {root, files:[{path, size, mtime, sha256}]}` for its target
   folder (rehearsal or live, 7.5), skipping `dev/`.
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

### 7.5 Rehearsal folder and the switch to live

- Until T23.2 the tray's mirror target is the **rehearsal folder**
  (`%LOCALAPPDATA%\ShadowAssistant\mirror-rehearsal\`), outside the vault and
  outside OneDrive: the live `<vault>\.shadow-assistant` belongs to the
  production Core on the PC until the move.
- The target is a tray setting `mirror.target` = `rehearsal` (default) or
  `live`. There is **no menu item** for it: it is changed by hand in the tray
  settings file in T23.2 step 6, after the last copy has been checked. The tray
  logs the target at every start.
- The development Core reads from the same folder the mirror writes to:
  rehearsal before T23.2 (T21.2), live after.

### 7.6 Backups (K8, T19)

- rclone and the existing crypt configuration move to the Pi; secrets in
  credstore (T19.1). A systemd timer runs the backup (T19.2).
- Archive contents: the data folder (without `backup/status.json`, as today)
  and `<companion>/Assistant/daily/` from the clone (T19.5). The rest of the
  vault is in git. The TLS CA key is not in the backup: losing it means a new
  CA and one new import on the PC.
- Status: `<data>/backup/status.json`, written where the Core reads it (same
  `core.env`).
- The PC's backup task is switched off only after the first good Pi backup with
  real data after T23 (T19.4).

### 7.7 Development Core (K10a, M7)

- Starts with `SHADOW_ROLE=dev`, on its own port; marked "dev" in UI, log and
  notifications (T21.1, T21.6). Its UI is served by the tray's `UiServer` on
  localhost, as today.
- **Reads** memory, conversations and dev-notes from the mirror folder
  (`SHADOW_DATA_DIR` = rehearsal or live data mirror; T21.2).
- **Writes** nothing into the mirror except under `dev/`:
  `dev/conversations/…` (T21.5), `dev/dropped-writes.jsonl`, and every other
  state file it needs to run (sessions, usage, notifications store, …). T21
  lists those files; a role-dev Core opens no write path outside `dev/`
  (tested, T21.2).
- **Write link to the Pi (M7, O7).** A `/ws` connection to the Pi's plain LAN
  listener with its own device token and `hello.role:"dev"`:

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

**Why `/ws` with a role.** M7 names a `hello` with `role: dev`; the `/ws`
handshake, token check and reconnect logic already exist. An HTTP `POST` (like
`/device/state`) was considered: simpler per call, but a second auth path.

**Plan tasks.** T11.1-T11.5, T13.6, T14.6, T16.3, T17.1-T17.3, T18.1-T18.6,
T19.1-T19.5, T21.1-T21.7, T23.2 (step 6), T23.5.

**Not verified.**

- Non-cone sparse checkout together with `--filter=blob:none` never fetching
  the `Private/` blob across pulls and merges; `GIT_NO_LAZY_FETCH` support in
  the Pi's git version.
- systemd `StateDirectory=` with `User=<user>` and `LoadCredential=` for a
  non-root `User=`.
- That the tray can write into `<vault>` under OneDrive with atomic replace and
  set mtimes.
- Hash cost of a 60 s re-list on the Pi for the real data size.

---

## 8. Security and hardening of the PC service (user decision Q3)

### 8.1 What the service must be able to do (and nothing more)

| Need | How |
|---|---|
| Outbound TCP to `<pi-lan-ip>:<core-port>` | normal network access |
| Loopback HTTP to whisper-svc / tts-svc | normal network access |
| Sleep, shutdown, restart | `SeShutdownPrivilege` |
| Session change notifications | `SERVICE_ACCEPT_SESSIONCHANGE`; no privilege |
| Pipe server, peer checks | no privilege beyond the pipe ACL (8.4) |
| Read its settings and token, write its logs and `health.json` | file ACLs (8.3) |

What it must **not** be able to do, by design: start processes in the user's
session (no `WTSQueryUserToken` / `CreateProcessAsUser`, which would need
`SeTcbPrivilege`), write to `Program Files`, read the user's profile or vault,
listen on any network port.

### 8.2 Account and privileges

- **Virtual service account** `NT SERVICE\ShadowAgent` (no password, local
  only, network access as the computer account; nothing on the network needs
  it).
- **Required privileges list** (`sc privs`): `SeShutdownPrivilege` and
  `SeChangeNotifyPrivilege` only; Windows strips every other privilege from the
  service's token. `SeShutdownPrivilege` is also granted to the account by the
  installer (LSA account rights).
- **Restricted service SID** (`sc sidtype ShadowAgent restricted`): the process
  can write only where its service SID is granted write explicitly (8.3), even
  if a broader group would allow it.
- Recovery: restart after 5 s, 10 s, 60 s; reset the count after one day
  (T14.2, R7).

### 8.3 File and registry ACLs

| Object | Access |
|---|---|
| `Program Files\ShadowAssistant\` (all releases) | Administrators, SYSTEM: full; Users and the service SID: read and execute |
| `%ProgramData%\ShadowAssistant\agent\agent.json` | Administrators, SYSTEM: full; service SID: read |
| `…\agent\agent.token` | Administrators, SYSTEM: full; service SID: read. Encrypted with DPAPI (machine scope) so a copied file is useless elsewhere; the ACL is the real boundary on this machine. |
| `…\agent\health.json`, `%ProgramData%\ShadowAssistant\logs\` | Administrators, SYSTEM: full; service SID: modify; Users: read on logs |
| `…\updater\` | Administrators, SYSTEM only |
| Service configuration (SCM) | default: only administrators may change or stop it |

Inheritance is disabled on these folders so a later broad ACE on
`ProgramData` does not leak in.

### 8.4 Pipe ACL and peer verification

- ACL (3.1): service SID full; the active console user's SID read/write; nobody
  else. `PIPE_REJECT_REMOTE_CLIENTS`. Re-created at every console user change;
  existing connections are closed then.
- Client check, in order:
  1. `ImpersonateNamedPipeClient` -> token user SID = console user, token
     session id = active console session (`WTSGetActiveConsoleSessionId`),
     then revert. No process access needed for this step.
  2. `GetNamedPipeClientProcessId` -> `QueryFullProcessImageName` must equal
     the installed tray path. If a virtual service account cannot open the
     user's process for `PROCESS_QUERY_LIMITED_INFORMATION` (to be checked in
     T14.5), step 2 falls back to step 1 plus a per-boot pipe secret: the
     service writes it to a file readable only by the console user and the
     service, and the tray sends it in `pipe_hello`. Same-user code can read it
     too; see 8.8 for why that is accepted.
- Tray -> server check: `GetNamedPipeServerProcessId` -> image path = installed
  service executable; the pipe must already exist with the expected owner (the
  service SID) before the tray writes anything.

### 8.5 Commands from the Pi: allow-list and input validation

The Pi is trusted, but the service treats every frame as input:

- **Frame types:** a fixed enum; unknown types are logged and dropped, never
  forwarded.
- **`pc_request`:** `op` in `run`/`apps`/`games`; `action` in the docs/11
  catalogue; `requestId` 1-128 chars `[A-Za-z0-9_-]`; `target` ≤ 256 chars;
  `params` only the keys the action's schema allows, typed and bounded. Failure:
  `code:"rejected"`, nothing runs.
- **Power actions** run in the service: only the three enum values, no
  parameters (no delay, no message, no "force" flag passed through); at most one
  power action per 60 s (a second one gets `rejected`).
- **Desktop actions** are forwarded to the tray, which **re-validates** them
  (docs/11 D1: own enum, inventory ids, deny list, `https:` URLs built from a
  host + template). Opening apps always goes through the tray because only the
  tray runs on the user's desktop; the service in session 0 cannot and does not
  try.
- **`http_request`:** service name and `(method, path)` from the service's own
  allow-list (5.2); only `Content-Type` passes; body and response size limits;
  no redirects; base URLs are loopback only.
- **Mirror:** the service only asks for paths that the Pi listed and only
  passes them to the tray, which applies the path rules of 7.4.
- **Sizes:** frames over 40 MiB close the channel; base64 that does not decode
  is `rejected`.

### 8.6 Audit log

- The service writes one Windows event-log entry (source `ShadowAgent`) per
  power action, per rejected frame, per pipe client refused, per channel
  connect / drop / reject and per update result: time, `requestId`, action,
  result code, peer. Never tokens, never bodies, never audio.
- Desktop actions are logged by the tray (its log) and by the Core (docs/11 D9
  action log); the service logs only that it forwarded them.
- Logs rotate (10 MB × 5, as the tray's).

### 8.7 Pi side

- `/agent`: source address before the upgrade, no `Origin`, token in constant
  time, 5 s hello, one agent at a time, max frame size, ping-based drop (1.2,
  1.4).
- The Core never asks for more than it needs: PC tools follow the state (2.2),
  `http_request` only to the two speech services.

### 8.8 If something is compromised (impact)

| Attacker controls | Can | Cannot |
|---|---|---|
| **The Pi's Core** (or the agent token **and** the PC's source address) | sleep / shut down / restart the PC; run catalogue desktop actions (open inventory apps, `https` sites by template, media, volume, lock); send audio to the local speech services; write files into the two mirror roots (which Claude Code and Obsidian read: a prompt-injection risk, bounded by the roots) | run arbitrary commands or paths, read files on the PC, reach the user's session other than through the tray's catalogue, listen on the PC |
| **The service process** (code running as `NT SERVICE\ShadowAgent`) | everything in the row above, plus: read the agent token and impersonate the PC to the Pi from the PC's address, which gives `mirror_get` access to the Pi's **data folder** (conversations, memory); send forged `agent_state` | write `Program Files` or other services' files (restricted SID), get other privileges (stripped), act in the user's session except through the tray's re-validated catalogue |
| **A process of the signed-in user** | what the user can already do; with the pipe secret fallback (8.4) it could pose as the tray | gain the service's privileges (the pipe gives it only the tray's messages) |
| **Someone on the LAN** (`/agent` is plain, Q2) | read the agent token and PC traffic (desktop commands, speech, mirrored data) on the wire; to use the token they must also send from the PC's address (ARP spoofing) | — (accepted residual risk of Q2; the same holds for the phone's plain home connection today) |

The most valuable secret on the PC is therefore the agent token (it opens the
Pi's data through the mirror); it is protected by the ACL in 8.3 and never
leaves the service. Rotating it: new token on the Pi credstore and in
`agent.token`, service restart.

**Plan tasks.** T14.2 (account, privileges, recovery, token file), T14.3
(power), T14.5 (pipe ACL, peer checks, negative tests), T15.2 (forwarder
allow-list), new PC release tasks (installer ACLs, updater), T23.4 (pipe
security test).

**Not verified.**

- `PROCESS_QUERY_LIMITED_INFORMATION` on a user process from a virtual service
  account (decides 8.4 step 2).
- `SetSuspendState` / `InitiateShutdown` from a service with only
  `SeShutdownPrivilege` under a restricted SID.
- Event-log source registration by the installer.

---

## Failure modes

| Failure | Effect | Handling |
|---|---|---|
| Wi-Fi of the Pi drops for < 15 s | nothing visible on the agent channel; clients reconnect | heartbeat tolerance |
| Pi down | phone and PC browser: "Çekirdeğe ulaşılamıyor"; tray: "Pi'ye ulaşılamıyor"; service keeps retrying | no local fallback (R2) |
| Service crashed or stopped | **UI in the browser keeps working** (chat, home control, notifications); Pi sees the PC `off`: no PC tools, no PC speech; tray: "Shadow servisi çalışmıyor", no mirror | Windows recovery restarts it (8.2, R7 narrower than planned) |
| Tray crashed | Pi: `no_session`; desktop commands `no_session`; no mirror; UI unaffected | user restarts the tray (single instance) |
| Command sent, channel drops | `interrupted`, "yapılıp yapılmadığı bilinmiyor" | no retry (1.5) |
| Mirror write fails | old file stays; retried next round | 7.4 |
| Pi certificate expired (renewal failed) | browser warns on the Pi's UI; phone and service unaffected | renewal timer alerts through a Core notification 14 days before expiry |
| Core update fails health check | previous release back, notification | 6.2 |
| PC update fails health check | previous release back, event log, tray notice | 6.4 |
| Push guard trips | nothing pushed, notification | 7.3 |

## Relation to existing documents and the plan (changed by this design)

- **docs/02:** new `/agent`, the `pc` frame and feature `pc_status`,
  `welcome.version` / `welcome.warnings`, detail codes `pc_off` / `pc_dev`,
  `hello.role` and feature `dev_role`, the TLS listener and the Origin rule on
  it. `/health` `inbox` stays loopback-only; the tray gets the counts from
  `core_status`. Written into docs/02 by T13.4 / T24.3.
- **docs/11 D1:** loopback `/pc`, the per-start token file and the Core-internal
  `pc-svc` health entry are replaced by sections 1, 3 and 8 (T24.2). The executor
  and its messages stay. The power warning text changes (1.7).
- **docs/12:** D4 no longer applies; Q5 has its new form in 2.4; Q4, Q6, Q7 are
  obsolete, Q8 (Fast Startup off) still matters for WoL (T24.1).
- **docs/05:** section 3 (tray starts the Core) becomes the development set-up
  only; section 4 (backups) moves to the Pi; section 5 gains the Core on the Pi,
  the TLS listener and the CA import on the PC; `tailscale serve` points at the
  Pi's loopback listener (T24.3).
- **v0.2 plan (for the plan owner):** A1 / O1 / M5 text about the tray carrying
  chat, push-to-talk and notifications, the `client` envelope and the virtual
  session; R7 ("service down = everything on the PC stops") is narrower now;
  T11.1 path (`deploy/linux/`); T10.2b, T13.5, T14.4a, T16.1, T16.1a, T23.4
  (last two bullets), T25.2, T41, T42 (see the implementation map).

## Decisions and open questions

### Decisions (user, 2026-11-27; Q8-Q13 the same day, second round)

| # | Question | Decision |
|---|---|---|
| Q1 | Tray relay or tray-held token for the UI's traffic? | **Neither.** The UI is served by the Pi; the PC's browser connects to the Pi's `/ws` directly with its own device token (deliberate exception to "one connection"). Envelope, relay and virtual session dropped (3.4). Microphone: HTTPS/WSS on the LAN with the Pi's own certificate, trusted once on the PC (4). |
| Q2 | `/agent` plain `ws://` or TLS? | Plain `ws://` (1.1; residual risk 8.8). |
| Q3 | Service account? | Virtual service account, hardened (8). |
| Q4 | `deploy/pi/` or `deploy/linux/`? | `deploy/linux/` (7.1). |
| Q5 | Release and update of the service and the tray? | CI release and a PC updater like Android and the Core (6.4). |
| Q6 | Who adds the `.gitignore` line for `Assistant/daily/`? | The user, once, from the PC (7.3, T18.6). |
| Q7 | Development mode across a Pi restart? | In memory on the Pi; accepted (2.3). |
| Q8 | Is the Pi's LAN address reserved in DHCP? | Yes, reserved (user). |
| Q9 | Device token for the PC's browser on the Pi? | Today's browser device; the token is re-entered once on the new origin. |
| Q10 | Phone's home address on the TLS listener? | Not in v0.2; plain `ws://` at home stays (4.4). |
| Q11 | Tray hotkey and wake word (T41, T42) without a client connection? | The tray opens or focuses the Pi's UI with `#ptt` and the UI starts recording (T41). |
| Q12 | T25.2 short path without the tray's audio path? | Re-design only if T25.1 shows the 2.5 s target is missed. |
| Q13 | PC release signature? | ECDSA-signed `SHA256SUMS` (6.4). |

### Open questions

None at the time of writing; new ones are added here.

## Not verified (summary)

Listed per section above. The ones that can change the design: tool hiding with
the persistent SDK session (2), the source address behind the subnet router (1),
pipe peer checks from a virtual service account (8.4), IP name constraints and
microphone access on the Pi origin (4), lazy fetch with sparse + partial clone
(7.3), junction paths in the PC update (6.4). Each is checked first in the task
that uses it.

## Implementation map

| Section | Tasks |
|---|---|
| 1 Agent channel | T13.1, T13.2, T13.4, T14.2, T14.3, T14.4, T14.8, T14.9 |
| 2 PC state | T13.2, T13.3, T13.4, T14.4, T14.7, T15.3, T16.4, T22.2, T23.4 |
| 3 Pipe and tray | T14.1, T14.4, T14.5, T16.1, T16.1a, T16.2, T16.6 |
| 4 HTTPS on the LAN | new T11 subtask (below), T12.1, T16.1, T23.1, T23.2 |
| 5 Voice proxy | T15.1-T15.4, T25.1 |
| 6 Release and update | T12.1-T12.3, T14.9, T16.6, new PC release tasks (below) |
| 7 Layout | T11.1-T11.5, T13.6, T14.6, T16.3, T17, T18, T19, T21, T23.2, T23.5 |
| 8 Hardening | T14.2, T14.3, T14.5, T15.2, T23.4, new PC release tasks |

**Tasks the 2026-11-27 answers change (for the plan owner):**

| Task | Change |
|---|---|
| T10.2b | No envelope and no virtual session: "the PC's browser connects to the Pi's `/ws` directly" (3.4). |
| T13.5 | Not needed (no `client` envelope). Its "refuse the tray identity outside the envelope" rule falls away. |
| T14.4a | Not needed for client traffic; only the link state and `core_status` to the tray remain (part of T14.4). |
| T16.1 | The tray loses no Core connection (it had none); "Arayüzü aç" opens the Pi's UI; `UiServer` only for the development Core. |
| T16.1a | Tray states of 3.3; no chat/push-to-talk to disable (the UI does not depend on the service). |
| T23.4 | "Tepsinin sohbeti, bas-konuşu ve bildirimleri servis üzerinden" becomes "the PC browser's UI works from the Pi, also with the service stopped"; add: CA import and microphone on the Pi origin. |
| R7 | A service crash stops PC tools, PC speech and the mirror, not the UI. |
| T25.2, T41, T42 | See Q11, Q12. |
| T11.1 | `deploy/linux/` instead of `deploy/pi/`. |

**New tasks proposed (numbers are the plan owner's):**

- **T11.6** TLS on the LAN: Core TLS listener and static UI files, Origin rule on
  it, local CA with IP name constraint, server certificate, renewal timer and
  expiry notification, `ca.crt` import steps for the PC in docs/05 (section 4).
- **PC release (e.g. T12.4-T12.6):** Windows workflow for service + tray
  (`pc-v<X.Y>.<n>`, signed `SHA256SUMS`); PC updater (scheduled task as
  `SYSTEM`, junction switch, health file, rollback, tray hand-over); elevated
  first-install script with the ACLs and privileges of section 8 (6.4, 8.2,
  8.3).

## Progress log

- 2026-11-27: design written for T10.1-T10.5 (software-architect, after a Codex
  review). From the review: a `core_status` frame for the tray counts, Pi-driven
  5 s / 15 s heartbeat, "unknown outcome" wording for interrupted commands, path
  rules for the mirror writer. Deviations from the review: a restricted HTTP
  forwarder instead of typed speech frames, base64 in JSON instead of binary
  frames.
- 2026-11-27: revised after the user's answers to Q1-Q7. The UI is served by the
  Pi and the PC's browser connects directly (relay, `client` envelope and virtual
  session removed); new section 4 (HTTPS on the LAN, local CA); new 6.4 (PC
  release and updater); new section 8 (service hardening); `deploy/linux/`;
  decisions table; new open questions Q8-Q13; implementation map lists changed
  and proposed tasks. Awaiting T10.6.
