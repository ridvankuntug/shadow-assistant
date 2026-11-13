# 12 - Waking the PC from the phone, and a Core that runs before sign-in

Status: design (T21.2 in the vault plan; T21.3 and T21.4 are implemented from
it). Builds on the protocol ([`02-core-protocol.md`](02-core-protocol.md)), the
Android shell ([`03-platform-adapter.md`](03-platform-adapter.md),
[`android/README.md`](../android/README.md)), the deploy guide
([`05-deploy.md`](05-deploy.md)), the tray app
([`deploy/windows/tray/README.md`](../deploy/windows/tray/README.md)) and the
`pc-svc` link ([`11-pc-control.md`](11-pc-control.md#core-without-a-session-user-decision-2026-11-13-vault-plan-t214)).
Examples use placeholders (`<pc-mac>`, `<lan-broadcast>`, `<wake-host>`,
`<wake-port>`); nothing here or in the implementation may hold real hosts,
addresses, MACs, tokens or account names.

## Problem

1. When the PC is off, the phone shows "Çekirdeğe ulaşılamıyor" and nothing
   can be done from the app. The PC supports Wake-on-LAN (wired), and a
   Home Assistant Wake-on-LAN entry exists, but it **sometimes does not wake
   the PC** (cause unknown).
2. Even when the PC wakes, the Core does not come up: it is started by the
   tray app, which starts at **sign-in**, and the PC does not sign in by
   itself.

## Fixed user decisions (2026-11-13; not reopened here)

1. The Home Assistant path stays. A second path through the always-on Linux
   box on the LAN (a Raspberry Pi with Docker; it is also the Tailscale subnet
   router) is built as a **fallback**. The cause of the HA failures is looked
   for separately.
2. The phone reaches the same LAN addresses at home (Wi-Fi) and away
   (Tailscale subnet route).
3. **No automatic sign-in.** The Core becomes a scheduled task that runs
   "whether the user is signed in or not". The user creates the task's stored
   credential (password) themselves.
4. Until someone signs in, only **typed** home commands and the model-less
   fast path are promised. Speech (Docker Desktop: whisper-svc, tts-svc) and
   PC control (`pc-svc` in the tray) arrive with the sign-in.

## Current state (what the design relies on)

- **Android error screen.** `MainActivity.checkCore()` runs `CoreProbe` (plain
  TCP connect to the Core host/port) after page load, on every return to the
  foreground and after address/token changes; on failure a native panel shows
  **Tekrar dene** and **Adresi değiştir** (`ErrorKind.CORE`).
- **Android storage.** `BridgeStorage.get()` returns every key except the
  device token **to the page** (plain SharedPreferences). The device token is
  AES-GCM under a Keystore key (`TokenCipher`). Anything that must stay away
  from the page therefore needs its own store, not a new `BridgeStorage` key.
- **Network rules.** `network_security_config.xml` allows cleartext to one
  host (`CoreAddress.CLEARTEXT_HOST`, unit-tested against the XML). The CSP
  (`UiOrigin.CONTENT_SECURITY_POLICY`) limits the WebView's `connect-src` to
  that host and `wss:`. Native `HttpURLConnection` calls are bound by the NSC,
  **not** by the CSP.
- **Core `/health`** is unauthenticated and answers remote callers too (without
  `inbox`); it lists services with `status` / `detail`.
- **Tray.** One instance per session (`Local\ShadowAssistantCoreRunner`, shared
  with `run-core.ps1`). It does not start a second Core while one answers
  `/health` ("dışarıda çalışıyor", blue), but **takes over** after ~10 s of
  missed checks. The Core lives in the tray's job object (killed with it).
  Core output and `[tray]` lines go to one rotating `core.log`. On "gave up"
  the supervisor changes state but the process keeps running.
- **Task (T8.1).** `install-core-task.ps1`: AtLogOn trigger for the current
  user, `LogonType Interactive`, `RunLevel Limited`, `IgnoreNew`, task restart
  3x / 5 min.
- **Claude login.** The Agent SDK uses the Claude Code login in the user's
  profile (docs/05 "Why a task in your own session").
- **`pc-svc` (docs/11, T17.3, not built yet).** The tray dials the Core on a
  loopback `/pc` WebSocket after sign-in; the Core lists a Core-internal
  service `pc-svc` (`ok` / `down` + detail `no_session`). docs/11 already
  assumes the Core may run without a session.

## Decisions

### D1. Wake endpoint: `wake-svc`, a single-file Python service on the always-on box

**What it does:** `POST /wake` sends a magic packet to **one MAC configured on
the box**. The request body is ignored; no MAC, address or port is ever taken
from a request. `GET /health` says the service is up. Nothing else.

**Runtime:** Python 3 standard library only (`http.server` +
`ThreadingHTTPServer`, `socket`, `hmac`), one module plus tests, under
`services/wake-svc/` (same layout as the other services: `wake_svc/`,
`tests/`, `pyproject.toml`, `README.md`). Run as a **systemd unit** with
`DynamicUser=yes`.

| Option | For | Against |
|---|---|---|
| **systemd unit, `DynamicUser` (chosen)** | Nothing to build; the box already runs its other daemons this way; journald, restart, `LoadCredential=` for the token file; strong sandboxing (`NoNewPrivileges`, empty `CapabilityBoundingSet`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `MemoryMax`). Sending a UDP broadcast needs no capability. | Needs root once to install the unit. |
| Docker, `network_mode: host` | Same deploy style as the PC services. | A broadcast from a bridge network does not reach the LAN, so it **must** use host networking, which removes Docker's network isolation (and makes `ports:` meaningless); an image to build and update for ~150 lines of stdlib code. |
| Node / Go binary | – | A runtime or toolchain the box does not have, for no gain. |
| Reuse Home Assistant (`wake_on_lan.send_magic_packet` through HA's API) | No new service. | That is the path that fails sometimes, and the app would need an HA token; the app talks only to the Core by design. |

Docker stays a valid alternative if the user prefers one deploy style (open
question Q2); the code is the same.

**Protocol (all JSON):**

| Request | Answer |
|---|---|
| `GET /health` | `200 {"status":"ok","service":"wake-svc","version":"…"}` (no MAC, no target, no counters) |
| `POST /wake`, `Authorization: Bearer <wake token>` | `202 {"sent":true}`: the packets were handed to the network stack. **Not** proof that the PC woke. |
| no / wrong token | `401 {"error":"unauthorized"}` |
| rate limit hit | `429 {"error":"rate_limited","retryAfterS":N}` + `Retry-After` |
| send failed (socket error) | `503 {"error":"send_failed"}` |
| anything else (path, method) | `404` / `405`, empty body |

**Packet:** 6 × `0xFF` + 16 × MAC, UDP to port 9, sent **3 times 100 ms
apart** to each configured broadcast address (default: the LAN's
subnet-directed broadcast `<lan-broadcast>`; `255.255.255.255` optional). The
socket is bound to the LAN interface address (`WAKE_SOURCE_ADDR`) so the
packet leaves on the LAN, not `tailscale0`.

**Configuration** (environment from the unit, token through
`LoadCredential=`): `WAKE_MAC` (validated at start; invalid → exit 1),
`WAKE_BROADCASTS` (comma list, each must be IPv4), `WAKE_SOURCE_ADDR`,
`WAKE_BIND` (the box's LAN address; not `0.0.0.0`), `WAKE_PORT`, token file
`wake-token` (≥ 32 random bytes, base64url). Startup refuses an empty or short
token.

**Authentication:** a **separate** static bearer token, independent of every
Core device token, compared with `hmac.compare_digest`. Not HMAC-signed
requests or nonces: the only thing the token protects is "send a magic
packet", which any device on the LAN can do without a token anyway (see D6).

**Hardening inside the server:** socket timeout 5 s; at most 8 concurrent
requests; header ≤ 8 KB; body read ≤ 1 KB and discarded; no redirects, no
static files, `Server` header without version.

**Rate limits** (in memory, one lock, atomic check-and-set):
- accepted wakes: at most 1 per 10 s and 20 per hour (global; there is one
  target);
- failed authentications: 5 per minute per source address, then `429` for
  that address for 5 min; the table is capped (oldest entries dropped), and
  failed attempts never consume the accepted-wake budget.

**Logging:** one JSON line per request to stdout (journald): `ts`, `event`
(`wake_sent` / `auth_failed` / `rate_limited` / `send_failed`), source address,
`status`. Never the token, never the `Authorization` header, never the MAC.

**Exposure:** listens on the box's LAN address only. Away from home the phone
reaches it through the Tailscale subnet route like the Core. It is **never**
added to the Cloudflare tunnel or any public route (written in the service
README and the unit file comment).

**Repository and deploy:**
- `services/wake-svc/` (code, tests, README),
- `deploy/linux/wake-svc.service` (hardened unit, placeholders only),
  `deploy/linux/wake-svc.env.example`,
- a new section in `docs/05-deploy.md` "Wake endpoint on an always-on Linux
  box" with **[USER ACTION]** steps: copy the folder (or `git pull` a clone),
  create the token file under `/etc/credstore/` (`0600 root`), fill the env
  file, `systemctl enable --now wake-svc`, open the port in the box's firewall
  for the LAN and the tailnet only (if a firewall is active).

### D2. Android: "Bilgisayarı uyandır" on the Core error panel, all native

**Where:** only on the `ErrorKind.CORE` panel for `CoreStatus.Unreachable`
(not for `CleartextBlocked`, not for the local-network permission panel). A
third button **Bilgisayarı uyandır** next to Tekrar dene / Adresi değiştir.
The WebView and the bridge contract (docs/03) do not change.

**Setup (first press without a stored wake token):** a native dialog with two
fields: address (prefilled `http://<wake-host>:<wake-port>`) and token
(password field, paste). Saved through a new `WakeStore`:
- token: AES-GCM under its **own** Keystore alias `shadow.wakeToken.v1`, in
  its **own** SharedPreferences file (reusing `TokenCipher` with a different
  alias/AAD); never in `BridgeStorage`, so the page can never read it;
- address: plain, in the same `WakeStore` file (not a bridge key either);
- **Uyandırma ayarı** (small text button on the waking panel) reopens the
  dialog to change or delete both.

**Network rules:** the wake host is cleartext HTTP on the LAN like the Core,
so the NSC gets a second `<domain>` and a constant
`WakeAddress.CLEARTEXT_HOST`, checked against the XML by the existing unit
test pattern. The address dialog refuses any host other than that constant
(and `https://` is accepted to any host, for a later TLS setup). The **CSP
does not change**: the WebView never talks to the wake endpoint.

**Flow (a small pure-Kotlin state machine `WakeFlow`, clock injected, so it is
unit-testable without Android):**

```
press ─ POST /wake (timeout 5 s, no redirects)
  ├─ 202 ────────────── WAKING: "Uyandırma isteği gönderildi, bilgisayar açılıyor…"  (elapsed m:ss, İptal)
  ├─ 429 ────────────── WAKING (a packet went out moments ago): "Az önce gönderildi; bekleniyor…"
  ├─ 401 ────────────── "Uyandırma anahtarı kabul edilmedi." + Uyandırma ayarı
  ├─ 503 ────────────── "Uyandırma cihazı paketi gönderemedi." + Tekrar dene
  └─ no connection ──── "Uyandırma cihazına ulaşılamadı. Evde değilsen Tailscale açık mı?" + Tekrar dene
WAKING: every 5 s GET http(s)://<core>/health (timeout 3 s), max 4 min
  ├─ 200 status ok ──── hide panel, trigger the same re-check as a return to the foreground (the UI reconnects)
  │                      (speech / pc-svc state is not waited for; the UI shows it, see D4)
  └─ 4 min, no answer ─ "Uyandırma paketi gönderildi ama bilgisayar yanıt vermedi.
                         Bilgisayar kapalıysa uyandırma ayarlarını kontrol et (docs/12, C);
                         açıksa Shadow çekirdeği başlamamış olabilir." + Tekrar uyandır / Kapat
```

- Polling uses `/health`, not a bare TCP connect: a half-booted machine can
  accept TCP before the Core is usable. Any `200` with `"service":"core"` is
  success; service problems are shown by the UI afterwards.
- 4 min, not 3: a cold boot + the boot task delay (D4) + Core start; tune after
  measuring (verify item).
- The flow is cancelled (and its results ignored) when the activity is
  destroyed, the panel is closed, or the Core address changes.
- "Bilgisayar açıldı ama oturum açılmadı" is **not** a phone-side state: once
  the Core answers, the UI shows the no-session state from the Core (D4).

**Why not distinguish "PC on, Core dead" from "PC off":** it would need a
second probe port on the PC (e.g. a port that is open before sign-in) or
wake-svc checking the PC, both extra configuration for a rare case. With D4 the
Core starts before sign-in, so "Core answers" ≈ "PC is up". Revisit only if
the timeout message turns out to be ambiguous in practice (Q5).

**Browser UI: not needed.** The browser UI runs on the PC itself (if it shows,
the PC is awake) or on another PC on the LAN, where the HA path is at hand.
Adding it would mean a wake token in a page and CORS on wake-svc.

### D3. Diagnosing the intermittent Home Assistant failures (user checklist)

Nothing here is measured yet; every cause is a **candidate to verify**, not a
finding. Sending from the always-on box helps only if the cause is on the
sender side; if it is on the PC side, the fallback fails exactly the same way.
So the first step is to find out **when** it fails.

**Step 0 - record each attempt** (a week is enough): what the PC was doing
before (sleep / hibernate / "Shut down" / after a power cut), how long it had
been off, which sender (HA or wake-svc), woke yes/no. Candidates per pattern:

| Pattern (to be observed) | Most likely candidates (verify) |
|---|---|
| Fails after "Shut down", works from sleep | Windows **Fast Startup** (a "shut down" is a hybrid hibernate, some NIC drivers do not arm WoL in it); BIOS **ErP / deep power saving** cuts NIC standby power in S5; NIC "Shutdown Wake-On-LAN" off |
| Fails after a power cut / unplugging | Most boards forget WoL arming after AC loss until the next clean boot; BIOS "restore on AC power loss" |
| Fails only after the PC was off for hours | Sender uses **unicast to the PC's IP** instead of broadcast: the sender's ARP entry for the PC expires and the packet has no MAC to go to. Check HA's entry for a `host` (IP) vs `broadcast_address` |
| Fails at random from the same state | Sender on **Wi-Fi**: some access points drop or rate-limit broadcast from Wi-Fi clients (power save, broadcast-to-unicast, client isolation); the sender's Wi-Fi briefly dropped; wrong broadcast address or interface. Note: the always-on box is on Wi-Fi too, so it may share this cause |
| Fails after Windows / driver updates | Updates reset NIC power settings ("Allow this device to wake the computer" off, "Wake on Magic Packet" off) |

**Checklist for the user (one pass, ~15 min):**

1. **Windows:** Control Panel → Power Options → "Choose what the power buttons
   do" → **Turn on fast startup: off** (recommended anyway for D4, see
   below).
2. **Device Manager → network adapter → Power Management:** "Allow this
   device to wake the computer" **on**, "Only allow a magic packet to wake the
   computer" **on**. **Advanced:** "Wake on Magic Packet" **Enabled**,
   "Shutdown Wake-On-Lan" (if present) **Enabled**; note "Energy Efficient
   Ethernet" / "Green Ethernet" values (candidates, change only if the pattern
   points there).
3. **BIOS/UEFI:** ErP (or "Deep Sleep") **Disabled**; "Power On By PCI-E" /
   "Wake on LAN" **Enabled**. If BitLocker asks for a **pre-boot PIN**, a wake
   stops at the PIN screen: the Core cannot start (verify whether it is on).
4. **Link light:** with the PC shut down, the NIC's port LED should still be
   lit. Dark = no standby power (ErP / BIOS).
5. **Home Assistant entry:** uses `broadcast_address` (the LAN broadcast) and
   not only a `host`; MAC is the **wired** adapter's.
6. **See the packet:** with the PC on, start Wireshark on it with the filter
   `udp.port == 9 || wol` and trigger HA, then wake-svc. A packet that does not
   arrive here points at the sender / Wi-Fi; one that arrives but does not
   wake (when off) points at the PC.
7. If the pattern points at Wi-Fi: connect the always-on box with a cable
   (its Ethernet port is unused) and repeat; that also makes the fallback
   independent of the access point.

### D4. T21.4: the Core runs before sign-in

#### Two tasks instead of one

| Task | Trigger | Runs as | Action |
|---|---|---|---|
| `\ShadowAssistant\Shadow Assistant Core` (replaces T8.1's) | **At startup** (+60 s) **and** at the user's sign-in | the user, **"run whether the user is signed in or not"** (stored password, `LogonType Password`), `RunLevel Limited`, `IgnoreNew` | `ShadowTray.exe --headless --repo-root … --node-path …` |
| `\ShadowAssistant\Shadow Assistant Tray` (new) | at the user's sign-in (+30 s) | the user, interactive | `ShadowTray.exe --watch-task` (icon, menu, UI server; later `pc-svc`) |

The sign-in trigger on the Core task is a cheap second chance: if the Core
task is not running (stopped by hand, failed at boot), signing in starts it;
`IgnoreNew` makes it a no-op otherwise. It still runs non-interactively. The
tray needs its own interactive task because a password task never shows UI.

**Password, never seen by a script.** `install-core-task.ps1 -Headless`
registers both tasks; the Core task is registered **interactive and disabled**
(a cmdlet registration with `LogonType Password` would need the password in
the script's memory). The script then prints the **[USER ACTION]**: Task
Scheduler → `ShadowAssistant` → *Shadow Assistant Core* → Properties →
"Kullanıcı oturum açmış olsa da olmasa da çalıştır" → OK → enter the Windows
password in Windows' own dialog → Enable. `install-core-task.ps1 -Verify`
then checks (read-only) `LogonType = Password`, `RunLevel = Limited`, both
triggers, enabled, and prints what is missing. Alternative for users who
prefer the console: `schtasks /Create /XML <file> /RU <user> /RP *` (schtasks
itself prompts; the script still never handles the value; whether the prompt
masks input is a verify item).

**Not S4U ("do not store password").** S4U has no credentials: no network
shares, and DPAPI-protected secrets of the user are unreadable. Whether
Claude Code's login on this machine depends on DPAPI is unknown (current docs
describe a profile file); Password logon works in both cases, so it is the
choice.

Consequences the user must know (installer text + docs/05):
- A password change makes the task fail with a logon error until the password
  is entered again in the task (Troubleshooting row).
- The account needs a **password** (a PIN does not count). If the Microsoft
  account is set to passwordless sign-in only, this design does not work
  (verify item; then Q7).
- Registering a startup trigger needs an **elevated** PowerShell once; the
  task still runs as the user, not elevated (verify item).

#### `ShadowTray.exe --headless`: the supervisor without UI

Chosen over running `node` directly from the task (loses backoff, log
rotation, the job object and Ctrl+C stop) and over `run-core.ps1` (a second
supervisor to keep alive; stays the manual fallback).

- A separate entry path in `Program.cs` before any WinForms setup: no
  `NotifyIcon`, no message boxes, no UI server, no session-end handling; same
  `CoreSupervisor`, `NodeLauncher`, job object, `RotatingLog`.
- **Gave up ⇒ exit code 1** (today the process stays alive in "gave up"),
  so Task Scheduler's restart (3 × every 5 min) applies. Budget: 20 short runs
  inside, × 4 task starts at most, then it stays down until the next boot,
  sign-in, or a manual start; the tray shows it red.
- Clean exit of the Core (code 0) ⇒ headless exits 0 (no restart), as today.
- Logs: headless writes `core.log` (unchanged name and rotation). The
  watching tray writes its own lines to **`tray.log`**, so two processes never
  rotate one file.
- Single instance: the existing `Local\` mutex is per session and does not see
  a session-0 headless runner. No new cross-session lock: the task's
  `IgnoreNew` prevents a second headless runner, the watching tray never
  starts a Core, and a manual `run-core.ps1` / `npm run dev` Core fails to bind
  `CORE_PORT` (verify that the Core exits non-zero with a clear log line on
  `EADDRINUSE`).

#### The tray in task mode (`--watch-task`)

- **Never starts a Core of its own**, not even after missed checks (today's
  take-over rule is off in this mode); it only polls `/health`.
- Icon: green / yellow as today; **red** when the Core does not answer;
  tooltip "Core görevi çalışıyor" instead of "dışarıda çalışıyor". The blue
  "external" colour stays for a Core that runs while the task is **not**
  running (e.g. `npm run dev`).
- **Yeniden başlat / Durdur / Başlat** act on the Core task: Stop and Start
  through the Task Scheduler API (the user's own task; that a non-elevated
  user may run/end it is a verify item). Stopping a task ends its processes
  without Ctrl+C (the Core is killed, not shut down cleanly). Accepted for v1:
  all Core data files are written atomically, a hard kill loses at most
  buffered usage-log lines and coalesced notes (verify). A graceful stop over
  a local authenticated channel is a later option, not part of T21.4.
- Docker buttons, game mode, UI server, inbox counts: unchanged (they need the
  session, which this tray has).
- If no Core task exists, the tray behaves as today (it starts and supervises
  the Core): one exe, two modes, no forced migration.

#### Environment, `.env`, files

- The Core reads the repo-root `.env` as today; the task passes `--repo-root`
  and `--node-path` explicitly, so neither PATH nor user environment variables
  are needed. Whether user environment variables reach a password-logon task
  is not relied on (verify only).
- `%LOCALAPPDATA%` is the same user's, so `core.log`, `pc-svc.token`
  (docs/11) and `tray-state.json` keep working.
- **OneDrive risk:** the repo (and so `.env`, `core/dist`, `node_modules`) may
  sit in a OneDrive folder. Before sign-in the OneDrive client is not running;
  files that are not "always keep on this device" may be unreadable, and
  writes are synced later. First check: mark the repo folder and the data
  folder "Always keep on this device" and run the boot test. If anything
  fails, deploy a local copy outside OneDrive (Q6).
- Network at boot: the 60 s boot delay lets the wired network come up; the
  Core's HA and service checks retry anyway.

#### Claude Code login without a session: how it is verified, and the fallback

Risk: the model path fails before sign-in (login not found, token refresh not
writable). Verification (T21.4.2, user present, ~10 min):

1. With the user signed in, run the Core task once from Task Scheduler (it
   runs non-interactively even then). From the phone, send a **typed** request
   that needs the model ("bugün nasılsın"). Check `core.log` for auth errors.
2. Reboot, **do not sign in**. From the phone: a tier-0 home command ("salon
   ışığını aç"), then the same model request.
3. Leave it unsigned for a day (crosses an access-token refresh) and repeat
   step 2's model request.

Fallback if 1–3 fail: (a) a long-lived token from `claude setup-token` in
`.env` as `CLAUDE_CODE_OAUTH_TOKEN` (verify that the Agent SDK passes it to its
CLI; it expires, so the backup/notification producer should warn before that
date, separate task); (b) if that is not wanted, the Core runs model-less
before sign-in: tier 0 and HA direct answer; a model request answers
"Bilgisayarda oturum açılınca bu isteği yanıtlayabilirim." (no new protocol,
an `error`/answer text). Decide after the test (Q4).

#### Health and UI: "bilgisayarda oturum açık değil"

- Source: the `pc-svc` link of docs/11 (T17.3). No link ⇒ service `pc-svc`
  `down`; **no new detection** (Windows session APIs from Node would need
  native code or locale-dependent `quser` parsing). Caveat, accepted: "no
  link" also covers "signed in but the tray is not running"; the text says
  so.
- Protocol (v1, additive only): no new frame and no new `/health` field. The
  `pc-svc` service and its `detail` come from T17.3. Rename that detail from
  `no_session` to **`not_connected`** (more honest; T17.3 is not built yet, so
  nothing breaks) and document it in docs/02's service list.
- UI: while `pc-svc` is `down`/`not_connected` **and** whisper-svc is `down`, a
  banner: "Bilgisayarda oturum açık değil (ya da tepsi uygulaması
  çalışmıyor): ses ve bilgisayar kontrolü yok, yazılı komutlar çalışır." The
  mic is already disabled while whisper-svc is down; the phone falls back to
  Android TTS while tts-svc is down (existing behaviour). Only `pc-svc` down
  (whisper ok) shows docs/11's PC-only hint instead.
- Before T17.3 exists the Core reports no `pc-svc` and the banner never shows;
  T21.4.4 therefore comes after T17.3 (or ships T17.3's link part first).

#### Update and restart

- Core code: `npm run build` in `core/`, then tray → **Yeniden başlat** (task
  stop + start) or `Stop-ScheduledTask` / `Start-ScheduledTask` by hand.
- Tray app: the published exe is locked by **both** tasks: stop both, publish,
  start both (a small `deploy/windows/restart-tasks.ps1 [-StopOnly]` helper is
  part of T21.4.1).
- `.env` changes: restart the Core task.

#### Sleep, shutdown, power loss

| Event | Behaviour |
|---|---|
| Sleep → wake | The headless runner and the Core simply resume; clients reconnect with their own backoff. No task trigger. |
| Shut down → wake / power on (Fast Startup **off**) | Clean boot; the startup trigger starts the Core ~60 s after boot; the tray task at sign-in. |
| Shut down with Fast Startup **on** | Session 0 is hibernated, not ended; whether the headless Core then resumes, restarts or neither is **unknown** (verify). One more reason to turn Fast Startup off (D3). |
| Sign-out | Only the watching tray ends; the Core keeps running (new: today sign-out stops the Core). |
| Restart from Windows Update | Like shut down → boot. |
| Power loss | Boot only if the BIOS is set to power on after AC loss; otherwise a wake is needed (and may fail, D3). |

### D5. What stays the same

- The Core stays on the PC (decision of docs/11 #9); no Core on the box.
- The phone still talks only to the Core for everything except the wake call;
  the WebView, the bridge contract and the CSP are unchanged.
- HA's own wake script stays as is.

### D6. Threat model

| Threat | Mitigation | Remaining risk |
|---|---|---|
| Someone on the LAN sends magic packets | – (Wake-on-LAN has no authentication; any LAN device can wake the PC without wake-svc) | Unwanted power-ons; accepted (house LAN). |
| Wake token sniffed on Wi-Fi (cleartext HTTP on the LAN) | WPA2/3 on the LAN; Tailscale (WireGuard) when away; token separate from the Core token | An attacker on the Wi-Fi can wake the PC, which they could do anyway (row 1). |
| Token leaks (phone lost, copied) | Delete/rotate: new token file on the box + `systemctl restart`, re-enter on the phone | **Worst case:** whoever is on the LAN or the tailnet can wake the PC at most once per 10 s / 20 per hour. They cannot pick another MAC, cannot reach the Core, HA or any data, cannot run anything. |
| wake-svc reached from the internet | Bound to the LAN address; never in the Cloudflare tunnel; tailnet access is the user's own devices | Misconfiguration (someone adds a tunnel route): documented "never". |
| Request turned into a different packet / target | MAC and broadcast only from configuration; body ignored | – |
| Flood / slowloris on the box | Timeouts, concurrency and size caps, per-address auth limit, capped table | Can make wake-svc unavailable while it lasts; the HA path remains. |
| wake-svc compromised (code bug) | `DynamicUser`, no capabilities, read-only system, no home | Attacker gets an unprivileged process on the box with LAN access. |
| Core runs as the user before sign-in | Same account and rights as today; password stored by Windows (LSA), not by Shadow | The Core is reachable on the LAN at times it was not before (PC on, nobody signed in); its device-token protection is unchanged. |

## Failure modes

| Case | What the user sees |
|---|---|
| Box down / not reachable | "Uyandırma cihazına ulaşılamadı…"; use the HA app path. |
| Packet sent, PC does not wake | After 4 min the timeout text pointing to D3. |
| PC wakes, Core task failed (e.g. password changed) | Same timeout text; tray (after sign-in) red; Task Scheduler last result shows the logon failure. |
| PC up, nobody signed in | UI banner (D4); typed commands work; model works only if the login check passed. |
| Core gave up after crashes | Task restarts it 3 ×; then down until boot / sign-in / manual start. |
| Two Cores (manual run while the task runs) | The second fails on the port and exits; `core.log` says so. |

## Tests

- **wake-svc (pytest, no network):** packet bytes for a known MAC; MAC
  parsing (`:`/`-`, case) and rejection; body and query ignored (a MAC in the
  body changes nothing); token compare (missing, wrong, prefix, right); rate
  limits with a fake clock (10 s, hourly, auth lockout, failures not eating the
  wake budget, table cap); responses and status codes; log lines contain no
  token/MAC; startup refuses short token / bad MAC / wildcard bind. The socket
  sender is injected; one test sends to `127.0.0.1` and reads the datagram.
- **wake-svc (manual, on the box):** `curl` with and without token;
  `journalctl -u wake-svc`; packet seen in Wireshark on the PC (D3 step 6).
- **Android (JVM unit):** `WakeFlow` transitions for every answer and the
  timeout with a fake clock and fake HTTP; cancellation on address change;
  `WakeAddress.CLEARTEXT_HOST` vs NSC XML; the dialog's host validation;
  `WakeStore` (encrypted, own alias, own file, never readable through
  `BridgeStorage`, failed encryption ⇒ not stored), following
  `TokenStorageTest`.
- **Android (manual):** PC off at home → wake → UI connects; away on Tailscale;
  wrong token; two presses within 10 s (429 path); box off.
- **Tray (xUnit):** headless exits 1 on give-up, 0 on clean Core exit; task
  mode never starts a Core after missed checks; restart actions call the task
  API (fake); `tray.log` vs `core.log` paths.
- **Core:** `EADDRINUSE` ⇒ non-zero exit with a log line; T17.3's `pc-svc`
  detail `not_connected` in `/health` and `services`.
- **UI:** banner shown only for `pc-svc` `not_connected` + whisper-svc down.
- **Manual, T21.4:** the three login checks (D4); sign-out keeps the Core;
  tray restart; publish with both tasks stopped; boot without sign-in → phone
  typed command.

## Implementation order

Each step can be finished, tested and used on its own. **Files** is what the
step may touch.

| Step | What | Files | After |
|---|---|---|---|
| T21.3.1 | wake-svc service + tests + README | `services/wake-svc/**` (new) | – |
| T21.3.2 | Deploy on the box | `deploy/linux/wake-svc.service`, `deploy/linux/wake-svc.env.example` (new), `docs/05-deploy.md` (new section), `docs/README.md` (list docs/12) | T21.3.1 |
| T21.3.3 | Android: `WakeStore`, `WakeAddress` + NSC, `WakeFlow`, error-panel button, dialog, waking panel | `android/app/src/main/java/.../Wake*.kt` (new), `MainActivity.kt`, `res/layout/activity_main.xml`, `res/values/strings.xml`, `res/xml/network_security_config.xml`, android tests, `android/README.md` | T21.3.1 (protocol), not T21.3.2 |
| T21.3.4 | HA diagnosis (D3 checklist) and results in this doc | this doc | – (user, any time) |
| T21.4.1 | Tray `--headless` and `--watch-task`, give-up exit code, `tray.log`, task control | `deploy/windows/tray/src/ShadowTray/{Program,TrayApp,CoreSupervisor,TraySettings}.cs` (+ a small `CoreTask.cs`), tray tests, `deploy/windows/tray/README.md` | – (shares `TrayApp.cs` with T17.3: not in parallel) |
| T21.4.2 | Installer `-Headless` / `-Verify`, `restart-tasks.ps1`, uninstall of both tasks; docs/05 section 3 rewritten; **user runs the login checks** | `deploy/windows/{install,uninstall}-core-task.ps1`, `deploy/windows/restart-tasks.ps1` (new), `docs/05-deploy.md` | T21.4.1 |
| T21.4.3 | Core: clear exit on `EADDRINUSE` (only if the check shows it is missing) | `core/src/server.ts` or `index.ts`, core tests | – |
| T21.4.4 | "Oturum açık değil" banner; `pc-svc` detail `not_connected` | `core/src/health.ts` (with T17.3), `docs/02-core-protocol.md`, `ui/src/**` (banner, strings), ui tests | T17.3 |

**[USER ACTION]s, in order:** D3 checklist (any time; Fast Startup off before
T21.4.2's boot test); create the wake token, fill the env file and enable the
unit on the box (T21.3.2); enter the address and token in the phone (T21.3.3);
elevated install of the tasks + password in Task Scheduler (T21.4.2); the three
login checks; OneDrive "Always keep on this device" (or Q6).

## Kullanıcı kararı gerekli (open questions)

Each has a recommended default; the implementation uses the default until the
user decides.

| # | Question | Default |
|---|---|---|
| Q1 | The box's LAN address goes into the public repo's NSC (like the PC's address already does). OK, or HTTPS through Tailscale instead (then at home the phone needs Tailscale on too)? | Cleartext LAN address in the NSC, same as the Core. |
| Q2 | wake-svc as a systemd unit or a Docker container (host network)? | systemd unit (`DynamicUser`). |
| Q3 | Connect the always-on box by cable? (Both it and the HA box send from Wi-Fi today.) | Yes, if D3 points at Wi-Fi; otherwise optional. |
| Q4 | If Claude login fails before sign-in: long-lived `setup-token` in `.env`, or model-less until sign-in? | Decide after the test; lean: model-less (no new long-lived secret). |
| Q5 | Should the phone tell "PC on but Core down" apart from "PC off" (needs a second probe)? | No, single timeout message. |
| Q6 | Keep running the Core from the OneDrive folder, or deploy a local copy? | Keep, with "Always keep on this device"; move only if the boot test fails. |
| Q7 | If the account has no usable password (passwordless Microsoft account): set one, or stay with sign-in start? | Set a password (or a local account) for the task. |
| Q8 | Fast Startup off (helps WoL and the startup trigger)? | Off. |
| Q9 | Waking timeout on the phone | 4 min, adjusted after measuring a cold boot. |

## Not verified (must be checked before the step that uses it)

- The actual cause of the HA failures (D3: every row is a candidate).
- That a password-logon task sees the Claude Code login and can refresh it
  (T21.4.2 checks 1–3); whether the installed Claude Code stores it in a
  profile file or with DPAPI.
- That `CLAUDE_CODE_OAUTH_TOKEN` from `setup-token` is honoured by the Agent
  SDK's CLI (only if Q4 picks it).
- Registering a startup-trigger task needs elevation; a non-elevated user may
  run/end their own task; "Log on as a batch job" is granted to the account.
- A passwordless-only Microsoft account blocks password-logon tasks.
- User environment variables in a password-logon task (not relied on).
- OneDrive placeholders and writes before sign-in.
- Fast Startup: whether the startup trigger fires and what happens to a
  session-0 task across a hybrid shutdown.
- `schtasks /RP *` masks the typed password.
- The Core exits non-zero with a clear log line on `EADDRINUSE`.
- A hard kill (task end) loses no Core data beyond buffered usage-log lines
  and coalesced notes.
- The UI reconnects promptly once the native panel hides (or needs the
  visibility event).
- Boot-to-`/health` time (sets Q9).
- Whether BitLocker pre-boot PIN is on.
- That the box's packets leave on the LAN interface with `WAKE_SOURCE_ADDR`
  while it is a Tailscale subnet router.

## Out of scope and deferred

- Graceful Core stop from the watching tray (local control channel).
- Waking from the browser UI.
- Shutting the PC down remotely (that is T17.8, through the Core).
- Docker Desktop before sign-in (it needs the session).
- Automatic sign-in (rejected by the user).

## Progress log

- 2026-11-13: design written (software-architect, after a Codex review:
  systemd over Docker for a stdlib daemon, separate Android store for the wake
  token, `/health` polling instead of TCP, give-up exit code for the task
  restart, `tray.log`, `not_connected` instead of `no_session`).
