# 11 - PC control (`pc-svc`) and the switched permission list

Status: design (T17.1 in the vault plan). Builds on the protocol
([`02-core-protocol.md`](02-core-protocol.md)), the router and tier 0
([`04-router.md`](04-router.md)), the tray app
([`05-deploy.md`](05-deploy.md#3-core-tray-app-started-by-a-scheduled-task)), the
Development tab and learned rules ([`08-learning-fast-path.md`](08-learning-fast-path.md))
and the notification producers ([`09-notification-producers.md`](09-notification-producers.md)).
Examples use generic names; nothing here or in the implementation may hold
hosts, addresses, tokens or account names.

## Problem

Shadow controls the home through Home Assistant but cannot touch the PC it runs
on: open an app or a site, search, change the volume, pause music, lock the
screen, sleep or shut down, start a game. The user wants this from the phone and
from the PC, by voice or typing, under a permission list the user alone
controls.

## Fixed user decisions (2026-11-13; not reopened here)

1. A **"İzinler"** page in the UI (under the ⋮ menu): one row per action + one
   switch. Everything is **off** by default.
2. A request that is not allowed: Shadow says "bu komut izinli değil" and does
   nothing; the row is **added by itself, switched off**.
3. Rows are per **action + target** ("Steam'i aç", "youtube.com'u aç", "ses
   düzeyini değiştir", "ekranı kilitle"), not per sentence; synonyms land on the
   same row.
4. Only the user flips a switch, **by tapping the screen**, only from **trusted
   devices**. Neither voice nor the model can.
5. Risky actions (shut down, restart, force-close an app) **ask every time**,
   even with the switch on.
6. A new row makes **no sound**; the page has a count badge.
7. A target that does not exist on the PC is **not added**; Shadow says
   "bulamadım".
8. The model cannot run free commands; only defined actions.
9. The Core stays on the PC. Sleep / shut down warn that **Shadow goes down too**.
10. First targets: series/films on Prime Video first, HBO Max (Turkey) when the
    title is not on Prime; music on YouTube Music; games: World of Warcraft
    through Battle.net, Steam and Epic installed.

## Current state (what the design relies on)

- **Core process.** The tray app (`deploy/windows/tray`, C#/.NET 10 WinForms,
  non-elevated, in the user's interactive session) starts `node core/dist/index.js`
  ([`NodeLauncher.cs`](../deploy/windows/tray/src/ShadowTray/NodeLauncher.cs)). The
  Core lives in the tray's job object (`KILL_ON_JOB_CLOSE`,
  [`Native.cs`](../deploy/windows/tray/src/ShadowTray/Native.cs)), and the tray
  itself in Task Scheduler's job. Later the Core runs as a task **without a
  user sign-in** (vault plan T21.4), so it will not be the tray's child. **Anything the Core or the tray starts directly
  dies with that job.** The tray already solves this for the browser:
  [`ShellLauncher.cs`](../deploy/windows/tray/src/ShadowTray/ShellLauncher.cs) asks
  explorer.exe to `ShellExecute`, so the started process is in none of the jobs.
- **Tray HTTP.** The tray hosts Kestrel for the UI
  ([`UiServer.cs`](../deploy/windows/tray/src/ShadowTray/UiServer.cs): `localhost`
  only, loopback `AllowedHosts`, GET/HEAD only). Game mode
  ([`GameMode.cs`](../deploy/windows/tray/src/ShadowTray/GameMode.cs)) stops
  whisper-svc; state in `%LOCALAPPDATA%\ShadowAssistant\tray-state.json`.
- **Gateway.** Every model tool goes through the Core MCP gateway
  ([`mcp-gateway.ts`](../core/src/mcp-gateway.ts)). For a local tool it validates
  the arguments (line ~454), runs the **gate** (line ~474: read / write /
  confirm, cancel, read-only, tier services) and only **then** calls
  `local.handler` (line ~502). Built-in local services exist:
  `shadow-device` ([`device-state.ts`](../core/src/device-state.ts),
  `deviceServiceDef()`: code-defined levels, not in `services.yaml`).
- **Gate.** [`permissions.ts`](../core/src/permissions.ts): exact rule → glob →
  service default; `confirm_inputs` only raises; built-ins denied; the confirm
  dialog text is `summarizeToolCall()` (generic "… çalıştırılsın mı?").
- **Authorization precedent.** Development "Kuralı ekle" is limited to
  `CORE_DEV_DEVICES` (unset = nobody), device taken from the token, never from
  `hello.client` ([docs/08 Authorization](08-learning-fast-path.md#authorization)).
- **Tier 0** ([docs/04](04-router.md#tier-0-direct-calls-without-a-model)) and
  learned rules are HA-specific (`service: home-assistant`, four intent tools,
  `LEARNABLE_TOOLS` / `LEARNABLE_DOMAINS`).
- **Persistent data.** `writeFileAtomic` / `readJsonOrQuarantine`
  ([`atomic-file.ts`](../core/src/atomic-file.ts)); everything under
  `<SHADOW_DATA_DIR>` is in the nightly backup.
- **Voice.** Both the browser and the phone send audio to whisper-svc on the PC
  ([docs/03](03-platform-adapter.md)). In game mode **no client has voice input**;
  typing still works.

## Decisions

### D1. Where `pc-svc` runs: inside the tray app; the Core decides, the tray executes

`pc-svc` is a component of the tray app (new files under
`deploy/windows/tray/src/ShadowTray/Pc/`). It is a **dumb, typed executor**:
it enumerates what is installed, reports PC state and runs one of a fixed set
of actions. All policy (target resolution, permission list, risk, confirmation,
log) lives in the Core.

| Option | For | Against |
|---|---|---|
| **Tray (chosen)** | C# reaches Core Audio (volume), `SendInput` (media keys), `LockWorkStation`, power APIs, session lock events, fullscreen state and the shell (AppsFolder) without native Node modules; `ShellLauncher` already escapes the job; runs in the user's session whenever someone is signed in. | A tray crash takes PC control down until it restarts; the Core keeps running. |
| Core (Node) | One language for policy and execution. | Needs PowerShell per action (slow, a command line is exactly the "free command" surface we forbid) or native addons (build/deploy cost); processes it starts die with the job; once the Core runs without a sign-in (T21.4) it cannot reach the interactive session at all. |
| Separate process | Crash isolation. | Another lifecycle, install step and secret; no benefit today. |

Split of work: **enumeration and execution in C#**, **matching in TypeScript**
(the Core already has Turkish normalization in [`turkish.ts`](../core/src/turkish.ts),
and tier 0 needs the same matcher).

#### Core without a session (user decision 2026-11-13, vault plan T21.4)

The Core will later run as a scheduled task that starts **without a user
sign-in** (no automatic sign-in). Consequences, all part of this design:

1. `pc-svc` cannot live in the Core: launching apps, the shell, media keys,
   lock state and fullscreen state exist only in the user's **interactive
   session**. It stays in the tray app (or a process the tray starts), and it
   **connects to the Core** once the user signs in. The Core never starts it
   and never depends on it to start.
2. While no `pc-svc` is connected, the Core runs normally (home devices,
   typed chat). A PC action then gets "**Bilgisayarda oturum açık değil;
   bilgisayar komutları şu an çalışmıyor.**" and **no row is added** (nothing
   was resolved, see D4).
3. Without a session there is no speech recognition either (Docker Desktop,
   and with it whisper-svc, starts with the session): typed commands only.
   This is existing behaviour (whisper `down` disables the mic in the UI).
4. Target resolution (installed apps, games) needs `pc-svc`: the inventory is
   fetched when it connects and dropped when it disconnects.

Today the tray still starts the Core; the design below works the same in both
set-ups, because the connection goes from `pc-svc` to the Core.

#### Transport and authentication: `pc-svc` dials the Core

- The Core opens a second WebSocket endpoint **`/pc`** on its existing port,
  separate from the client endpoint `/ws`, so the client protocol of docs/02
  does not change. `/pc` accepts **loopback connections only**
  (`127.0.0.1` / `::1`; anything else gets 403 before the upgrade) and refuses
  requests that carry an `Origin` header (no browser page may open it).
- **Secret:** at every start the Core writes a fresh 32-byte random token to
  `%LOCALAPPDATA%\ShadowAssistant\pc-svc.token` (atomic write; outside the data
  dir, which may sit in a synced vault). The tray reads it before each connect.
  Both run as the same Windows user, so the user's profile ACL is the boundary;
  the token is never in `.env`, logs or tool texts. A Core restart rotates it;
  the tray's reconnect picks up the new one. (Assumption to verify with T21.4:
  the background Core task runs as the same user. If it runs as another account,
  the file needs a shared location with an explicit ACL.)
- **Handshake:** `pc-svc` sends `{"type":"pc_hello","token":"…","version":"…"}`
  within 5 s; the Core answers `pc_welcome` or closes (4401). One `pc-svc` at a
  time: a new authenticated connection replaces the old one.
- **Liveness:** ping every 15 s; a `pc-svc` that misses two is treated as gone.
  The tray reconnects with backoff (1 s doubling to 30 s) for as long as the
  session lasts, so a Core that starts later or restarts is found again.
- **Health:** the Core lists a Core-internal service `pc-svc` in the `services`
  frame and `/health`: `ok` while connected, `down` with detail `no_session`
  otherwise. The UI's service indicator then explains why PC commands do not
  work. No `services.yaml` entry.
- Alternatives considered: (a) the Core calls an HTTP listener in the tray with
  a secret the tray passes in the Core's environment: works only while the tray
  starts the Core, so it breaks with T21.4; (b) a named pipe with a per-user
  ACL: no stronger than loopback + token against same-user code, and a second
  transport in Node and C#; (c) `pc-svc` as an MCP server that the gateway
  mirrors: the gateway would dial the tray (same problem as (a)) and the policy
  would have to wrap a foreign tool list.

#### `pc-svc` messages (over `/pc`, JSON text frames)

| Direction | Frame | Purpose |
|---|---|---|
| pc-svc → Core | `pc_state` | `{locked, fullscreen, gameMode}`; sent after `pc_welcome` and on every change. `locked` from session lock notifications (WTS), `fullscreen` from `SHQueryUserNotificationState` (D3D full screen / busy). |
| Core → pc-svc | `pc_request` `op:"apps"` | Installed apps from the shell's AppsFolder: `[{id, name, kind: "win32"\|"store", exe?}]`. Asked on connect and at most every 10 min, or once more when a name is not found. |
| Core → pc-svc | `pc_request` `op:"games"` | Installed games from launcher manifests: `[{launcher: "steam"\|"epic"\|"battlenet", id, name}]` (see D5). |
| Core → pc-svc | `pc_request` `op:"run"` | `{requestId, action, target, params}`. |
| pc-svc → Core | `pc_response` | `{requestId, ok, code, data?}`; `code` one of `done`, `not_found`, `locked`, `unsupported`, `failed`. Timeout 10 s on the Core side (then `failed`, no retry). |

`requestId` is remembered by `pc-svc` for 10 min: a repeat returns the first
answer and runs nothing (no double launch after a reconnect). Frames are at
most 256 KB (app lists), `run` at most 16 KB.

`pc-svc` **re-validates** every `run`: the action is in its own enum, an app id
is in its current inventory and not on its deny list, a URL is `https:` and
was built by `pc-svc` from a host + template (never passed through), a game id
is in its manifest list. Defence in depth: a Core bug cannot turn into a free
command.

### D2. Action catalogue (v1)

Model tools live in one built-in gateway service **`shadow-pc`** (like
`shadow-device`). One tool per action: clearer schemas, strict enums, per-tool
levels. The **level** is fixed in code (`pcServiceDef()`); a `services.yaml`
entry named `shadow-pc` is a **startup error** (unlike `shadow-device`, config
must not be able to lower a level). The **row** is the permission-list key
(D3); "system" means a fixed target.

| Tool | Parameters | Level | Row (action · target) | Notes |
|---|---|---|---|---|
| `pc_find` | `query` (≤ 64 chars), `kind?` (`app`\|`game`\|`site`) | read | none | Candidates (names only, ≤ 5) for asking back; never creates rows. |
| `pc_status` | – | read | none | Locked / fullscreen / game mode, for the model's answer. |
| `pc_open_app` | `app` (name) | write | `open_app · app:<id>` | Through `ShellLauncher` (`shell:AppsFolder\<id>`). |
| `pc_close_app` | `app` | write | `close_app · app:<id>` | Graceful `WM_CLOSE` to the app's top-level windows; Win32 apps with a known exe only. |
| `pc_force_close_app` | `app` | **confirm** | `force_close_app · app:<id>` | Terminates the app's processes. Separate row from `close_app`. |
| `pc_open_site` | `site` (name or host) | write | `open_site · site:<host>` | Opens `https://<host>/` only; see D5. |
| `pc_web_search` | `query` (≤ 200) | write | `web_search · search:web` | Default engine's results page (decision Q12). |
| `pc_youtube` | `query`, `service` (`youtube`\|`youtube_music`) | write | `media_search · search:youtube` / `search:youtube-music` | Opens the search results page (D6). |
| `pc_watch` | `title` (≤ 120), `service` (`prime_video`\|`hbo_max`), `season?`, `episode?` | write | `media_search · search:prime-video` / `search:hbo-max` | v1 = search page; episode links only after verification (D6). |
| `pc_volume` | `op` (`set`\|`up`\|`down`\|`mute`\|`unmute`), `percent?` (0–100, `set` only) | write | `volume · system:volume` | Core Audio on the default output; `up`/`down` = ±10. |
| `pc_media` | `op` (`play_pause`\|`next`\|`previous`\|`stop`) | write | `media · system:media` | Media keys (`SendInput`), work while a game has focus. |
| `pc_lock` | – | write | `lock · system:lock` | `LockWorkStation`. Already locked: "zaten kilitli", nothing run. |
| `pc_sleep` | – | **confirm** (Q1) | `sleep · system:sleep` | "Shadow da kapanacak" (D4). |
| `pc_shutdown` | – | **confirm** | `shutdown · system:shutdown` | Same warning. |
| `pc_restart` | – | **confirm** | `restart · system:restart` | Same warning; Shadow returns only after sign-in. |
| `pc_play_game` | `game` (name) | write | `play_game · <launcher>:<id>` | Launcher URI / command per D5. |

Out of v1 (on purpose): typing text into windows, window management, file
access, clipboard, arbitrary URLs with paths, killing system processes, any
"run" or "command" tool. A missing capability shows up as a Development
`missing_capability` note as today.

Never targets (deny list in **both** Core and tray, by exe name and AppsFolder
id): command interpreters and shells (`cmd`, `powershell`, `pwsh`, `wt`,
`wsl`, `bash`), script hosts (`wscript`, `cscript`, `mshta`), `regedit`,
`mmc` and `.msc` consoles, `control`, uninstallers and installers
(name or exe containing `uninstall`, `kaldır`, `setup`, `install`), and Shadow's
own processes (`node`, `ShadowTray`, `explorer` for close). Shortcuts whose
target is a `.bat` / `.cmd` / `.ps1` / `.vbs` / `.js` are dropped from the
inventory.

### D3. Permission list: store, row identity, protocol, who may switch

#### Row identity

A row is **(action, target kind, canonical target id)**, never the spoken text.
Synonyms ("Steam aç", "Steam'i başlat", "steami çalıştır") resolve to the same
target and therefore the same row; verbs are synonyms by construction (one
tool per action).

| Target kind | Canonical id | Example label |
|---|---|---|
| `app` | AppsFolder parsing name, lower-cased (an AUMID, or the known-folder path of a Win32 exe) | "Steam · aç" |
| `steam` / `epic` / `battlenet` | Steam app id, Epic app name, Battle.net product code | "World of Warcraft · başlat" |
| `site` | host, lower-cased, IDNA ASCII form, leading `www.` removed | "youtube.com · aç" |
| `search` | `web`, `youtube`, `youtube-music`, `prime-video`, `hbo-max` | "YouTube Music · ara" |
| `system` | `volume`, `media`, `lock`, `sleep`, `shutdown`, `restart` | "Ses düzeyi · değiştir" |

`rowId` = `p-` + the first 16 hex digits of `sha256(action|kind|id)`:
deterministic, so a repeated refused request finds its row instead of adding
another. Labels are "**‹target› · ‹verb›**" so the Core never has to build
Turkish case suffixes ("Steam'i", "YouTube'u") from arbitrary names.

A target whose id changes (an app reinstalled to another folder) is a new
row, off; the old row stays until the user deletes it (Q6). Permission never
moves from a display name to a different program.

#### Store

`<SHADOW_DATA_DIR>/pc/permissions.json`, read once at startup, kept in memory,
written through:

```json
{"version":1,
 "rows":[{"id":"p-3f9a1c2e5b7d0a11","action":"open_app",
          "target":{"kind":"app","id":"<appsfolder id>","label":"Steam"},
          "aliases":["steam"],
          "enabled":false,"seen":false,
          "createdAt":"2026-11-14T18:00:00.000Z","lastRequestedAt":"…","requests":1,
          "changedAt":null,"changedBy":null}]}
```

- `aliases`: normalized spoken names that resolved to this target (at most 10,
  newest kept). Used by tier 0 (D7) and to show "denildiği gibi" forms.
- `seen: false` = added by a refused request and not yet seen on the page; the
  badge counts these.
- One in-process mutex around every read-modify-write; `writeFileAtomic` then
  publishes. Memory changes only after the write succeeded.
- **Unreadable or corrupt file**: `readJsonOrQuarantine` moves it aside; the
  store is then **unavailable**: every PC action is refused with "İzin listesi
  okunamadı; bilgisayar komutları kapalı", **nothing is written** (an
  auto-added row must not overwrite the grants that are still in the
  quarantined copy), and the page shows the problem
  (`available: false`). Fail closed. Recovery is by hand (quarantine copy or
  backup) and a Core restart.
- At most 300 rows; at the limit no new row is added (the request is still
  refused, a log line says why).
- Backup: the nightly backup already covers `<SHADOW_DATA_DIR>`. A restore can
  bring back a switch the user had turned off since; the restore section of
  docs/05 gets one line: "after a restore, check the İzinler page".

#### Protocol (additive, protocol stays 1; feature `pc_permissions`)

| Direction | Frame | Fields |
|---|---|---|
| client → Core | `pc_permissions_list` | `id` |
| client → Core | `pc_permission_set` | `id`, `rowId`, `enabled` (boolean; an explicit value, never "toggle", so a repeat is harmless) |
| client → Core | `pc_permissions_seen` | `id` (marks every row seen; the badge goes to 0) |
| Core → client | `pc_permissions` | `id`, `rows[]`, `unseen`, `canManage`, `available` |
| Core → every authenticated socket | `pc_permissions_count` | `unseen` (sent when it changes) |

`rows[]`: `{rowId, action, kind, label, enabled, seen, requests, createdAt,
lastRequestedAt, changedAt?}`; never ids of the target, aliases, search
texts or device names. Errors (with `id`): unknown `rowId` → `unknown_item`;
`pc_permission_set` from a device that may not manage → `not_allowed`; store
unavailable → new code `pc_permissions_unavailable` (clients treat unknown codes
as generic); malformed → `bad_request`. `pc_permissions_list` and
`pc_permissions_seen` are open to every authenticated device (they do not change
what the PC does). Loopback `GET /health` `inbox` gets `pc: <unseen>` so the
tray can show "İzinler (N)" (same rule as `dev`).

#### Who may switch, and why voice and the model cannot

- `CORE_PC_PERMISSION_DEVICES`: comma-separated device names from
  `DEVICE_TOKEN_<NAME>`. **Unset = nobody** (fail closed, as `CORE_DEV_DEVICES`).
  The device is the token's, never `hello.client`. Every change is logged with
  the device (D9).
- **Structural separation** (the guarantee, not a convention):
  1. The only code that can set `enabled: true` is
     `PcPermissionStore.setEnabled()`, and the only caller is the WebSocket
     handler of `pc_permission_set`. The PC coordinator (model tools and tier 0)
     receives a narrower interface, `PcPermissionView`: `lookup(row)` and
     `recordRefusal(row)` (creates a row **off** or bumps its counter). It has no
     way to switch.
  2. `pc_permission_set` is a frame, not a turn. `user_text` and `audio` only
     start turns; no router rule, tool or learned rule produces this frame.
  3. No gateway tool reads or changes the list (the model only sees "not
     allowed").
  4. Tests pin this: a test walks every gateway tool and every tier-0 rule kind
     and asserts none reaches `setEnabled`; "Steam iznini aç" as text and as
     audio leaves the store unchanged.
- **Limit, stated plainly:** the Core cannot prove a physical tap. A stolen
  token of a trusted device can send `pc_permission_set`. That is the threat
  model's top item (D9), handled by keeping trusted devices few and tokens
  per device and revocable.

#### UI ("İzinler")

`ui/src/ui/PermissionsPanel.tsx` (same `Drawer` pattern as `DevPanel`), opened
from the ⋮ menu (`AppMenu` item "İzinler", with the `unseen` count) and from the
URL hash `#permissions` (tray). Shown only with feature `pc_permissions`.

- Groups: "Yeni" (unseen) first, then "Açık", then "Kapalı"; each row the label,
  "N kez istendi", the last request time and a switch.
- Opening the page sends `pc_permissions_seen` after the list arrived.
- With `canManage: false` the switches are disabled with the hint "Bu cihaz
  izinleri değiştiremez. Çekirdekte CORE_PC_PERMISSION_DEVICES ayarına bu
  cihazın adı eklenmeli."
- Switching **on** a risky row (`force_close_app`, `shutdown`, `restart`,
  `sleep`) shows the note "Açık olsa da her seferinde onay sorulur."
- No sound, no `adapter.notify`, no balloon.

### D4. One flow for every PC request (model and tier 0)

The gateway gets an optional **`prepare`** step for local tools, run **before**
the gate. Resolution and the permission list must come first: otherwise a
refused or unknown target would still open a confirmation, and the confirm
text could not name the resolved target.

```
validate args (zod)
 → prepare (PC coordinator):
     pc-svc linked? ─ no → "Bilgisayarda oturum açık değil", no row, tool result (isError)
     resolve target ─ not found → "bulamadım", no row, tool result (isError)
                    ─ ambiguous → candidate names, no row, tool result (isError)
     status check   ─ locked / fullscreen policy (D8)
     permission row ─ missing or off → recordRefusal(); "bu komut izinli değil"; tool status denied
 → gate (code level: read / write / confirm; read-only, tier services, cancel)
     confirm summary from the PC catalogue (Turkish, names the resolved target and,
     for power, "Shadow da kapanacak")
 → re-check: row still on, same target id, turn still current
 → pc-svc `run` over /pc (requestId = toolUseID)
 → action log (D9) + conversation log (`tool_call`, `permission`, `tool_result`)
```

- A refusal is **terminal**: never a confirmation ("onaylarsan açarım" would
  bypass the switch by voice), never a fallback to another tier. The model gets:
  "The user's PC permission list does not allow this. A switched-off row was
  added. Tell the user 'bu komut izinli değil'. Do not retry and do not try
  another tool for the same goal."
- `LocalTool` gains `prepare?(args, ctx)` returning either a final result or a
  plan `{input, summary?}`; the gateway passes `summary` to the gate. The gate's
  `Session.gate()` uses it instead of `summarizeToolCall()` when present. Other
  local services are unchanged.
- **T7.y classification:** every `shadow-pc` tool is classified in code, so no
  "new tool: classify" note can arise for it. The read/write/confirm gate
  decides *whether to ask*; the list decides *whether the target is allowed at
  all*. Both apply; neither can lower the other.
- Power actions: after approval the Core sends the answer ("Tamam, kapatıyorum.
  Shadow da kapanıyor.") and its speech first; `run` takes `delayMs: 5000`
  and the tray waits before calling the power API, so the phone hears the
  answer. The log entry is written before the call ("submitted"); completion
  cannot be observed.
- **No `pc-svc` connected** (nobody signed in, or the tray is not running):
  "Bilgisayarda oturum açık değil; bilgisayar komutları şu an çalışmıyor."
  Checked first in `prepare`, before resolution. **No row is added**, also for
  system targets (volume, lock) that need no resolution, so the list only holds
  rows for requests that could have run. A `pc-svc` that drops during a call:
  `failed`, no retry.
- ev cihazları are unchanged: they stay under HA's Assist exposure and the
  existing gate. The list is for PC actions only.

### D5. Target resolution

#### Apps

- **Source:** the shell's AppsFolder (what the Start menu's "All apps" shows:
  Win32 shortcuts from both Start Menu folders and Store apps), enumerated in
  the tray through the shell (`FOLDERID_AppsFolder`). It gives a display name
  and a parsing name (AUMID or known-folder path) that `shell:AppsFolder\<id>`
  launches. Win32 entries also give the target exe (needed for close).
- **Matching (Core):** the spoken name is normalized like router text
  (Turkish lower case, apostrophe suffix dropped, letters folded) and its last
  word tried with the case-suffix stems tier 0 already uses ("steami",
  "discordu"). Against each entry's normalized name and the row aliases:
  1. exact name or alias → that entry;
  2. the spoken words equal the leading words of exactly one name ("epic" →
     "Epic Games Launcher") → that entry;
  3. otherwise all entries containing every spoken word → **ambiguous** (≤ 5
     names back; the model asks), or none → **not found**.
  Rule 2/3 ties (several entries) are always ambiguous. No edit-distance
  guessing in v1: a near miss is "bulamadım", never a different program.
- Game launchers and games (below) are matched first for `pc_play_game` and
  also for `pc_open_app` ("World of Warcraft'ı aç" → game row), so the same
  game is not reachable under two rows.
- Not found → the inventory is refreshed once (an app installed minutes ago)
  and matched again before answering "bulamadım".

#### Games (each launch template marked **verify** is checked in T17.7 before use)

| Launcher | Installed games from | Launch |
|---|---|---|
| Steam | `steamapps/libraryfolders.vdf` + `appmanifest_<id>.acf` per library (Steam path from the registry) | `steam://rungameid/<id>` (widely used; **verify**) |
| Epic | `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item` (JSON: display name, app name, catalog ids) | `com.epicgames.launcher://apps/<namespace>%3A<itemId>%3A<appName>?action=launch&silent=true` (**verify**) |
| Battle.net | No public game manifest. v1: a fixed code list of product codes (World of Warcraft retail first) checked against the Battle.net install (registry / install folder) | `Battle.net.exe --exec="launch <code>"` is the commonly reported way; `battlenet://<code>` may only open the game's page (**verify both**; Battle.net may also need to be running and signed in) |

A game that a launcher knows but is not installed is **not found**. WoW retail
and Classic are separate targets (separate product codes).

#### Sites

- `pc_open_site` takes a name or a host. Order: (1) a committed alias catalogue
  of generic site names (`youtube`, `youtube music`, `prime video`, `hbo max`,
  `google`, `gmail`, `vikipedi`, …) in `core/src/pc/sites.ts`; (2) otherwise the
  text must be a syntactically valid host name.
- Rejected outright: IP literals, `localhost`, single-label names, `.local` /
  `.lan` / `.internal` / `.home.arpa`, ports, user info, paths, schemes other
  than https; anything resolving to a private, loopback or link-local address.
- **Existence check** before a row is added: the host must resolve in DNS
  (one lookup, 2 s). No answer → "bulamadım", no row. This keeps
  model-invented domains out of the list (decision 7).
- The tray opens `https://<host>/` built from the host; a model URL is never
  passed through. Paths come only from the server-owned search templates (D6).
- Row key = exact host without `www.` (`music.youtube.com` and `youtube.com`
  are separate rows). Stricter than grouping by registrable domain and needs no
  public-suffix list; Q13.
- IDN: the label shows the Unicode form **and** the ASCII form when they
  differ, so a look-alike domain is visible before the user switches it on.
- Abuse limits: at most 3 new rows per turn (a prompt-injected model cannot
  flood the list); further refusals in that turn add nothing.

### D6. Searches, YouTube, YouTube Music, Prime Video, HBO Max

All of these open a page in the default browser through `ShellLauncher`; the
query is URL-encoded into a fixed template owned by the tray.

| Target | Template | Status |
|---|---|---|
| Web search | `https://www.google.com/search?q=<q>` | Known stable. |
| YouTube | `https://www.youtube.com/results?search_query=<q>` | Known stable. |
| YouTube Music | `https://music.youtube.com/search?q=<q>` | **Verify** (expected to work; check signed in). |
| Prime Video | `https://www.primevideo.com/search/?phrase=<q>` (form seen in the wild) | **Verify**: domain for a Turkish account, parameter name, whether TR catalogue is shown. |
| HBO Max (Turkey) | Expected under `play.hbomax.com` with a search route | **Verify**: domain, search route; not assumed. |

What is **not** known and must not be assumed:

- **Episode links.** Prime Video titles have detail pages (`/detail/<id>/`),
  historically per season; whether an episode can be opened or auto-played by
  URL, and with which parameters, is unverified. HBO Max episode URLs carry
  opaque ids. **No episode URL is ever built from a series name.** v1 opens the
  search page with "‹dizi› ‹sezon› ‹bölüm›" text, and Shadow says "arama
  sayfasını açtım", never "oynatıyorum".
- **"Not on Prime" detection.** There is no public catalogue API. v1 does not
  detect absence: the model uses the user's stated service or asks ("Prime'da
  mı, HBO'da mı?"); a per-title preference can be remembered by the memory
  service. An automatic check waits for T19 (web search) and is a separate
  decision (Q9). Opening HBO Max needs its own row; a Prime grant never
  carries over.
- **YouTube "X'i aç".** Playing the first result needs a video id, which needs
  the YouTube Data API (a key) or a web search. v1 opens the results page
  (Q11). A later step may add `youtube.com/watch?v=<id>` from an id that a
  T19 search returns, validated by its 11-character form.

**Verification step (T17.9, with the user, one evening):** for each service,
signed in on the PC's default browser: (1) open the search template with a
known title; does it show results from the Turkish catalogue? (2) open a
series, copy the share link of an episode; does that link open the episode, the
season, or the series page; does it start playing? (3) repeat after a browser
restart (session kept?). Results go into this section with the date; only
templates that passed are enabled. Episode links, if they work, can be stored
per title from a link the user shares (never constructed).

### D7. Tier 0 (no model) and learning

**Static PC rules** in `router.yaml`, with `service: shadow-pc` and a new rule
family handled by a PC executor next to `direct.ts`. They call the same PC
coordinator (D4): resolution, list, gate, re-check, log. So a switched-off row
answers "bu komut izinli değil" without a model, and a refusal is never handed
to a model (as `declined` today).

| Rule | Examples | Tool |
|---|---|---|
| `pc-volume-set` | "sesi yüzde 30 yap", "ses düzeyini %50'ye ayarla" | `pc_volume set` |
| `pc-volume-step` | "sesi aç / artır / yükselt", "sesi kıs / azalt" | `pc_volume up/down` |
| `pc-mute` | "sesi kapat", "sessize al", "sesi geri aç" | `pc_volume mute/unmute` |
| `pc-media` | "müziği durdur / duraklat", "devam ettir", "sonraki şarkı", "önceki parça" | `pc_media` |
| `pc-lock` | "ekranı kilitle", "bilgisayarı kilitle" | `pc_lock` |
| `pc-power` | "bilgisayarı uyut / kapat / yeniden başlat" | `pc_sleep` / `pc_shutdown` / `pc_restart` (confirm as always) |
| `pc-open` | "‹hedef› aç / başlat / çalıştır" | `pc_open_app` / `pc_play_game` / `pc_open_site` |

- `‹hedef›` is a new slot: it matches only a target that **already has a row**
  (on or off), by its label or aliases. Anything else is not claimed by the
  rule and the router goes on (to the HA `device-on` rule, then the model). So
  the first "Steam'i aç" goes to the model, which resolves it and adds the row;
  later ones are tier 0. PC rules come **before** HA `device-on`; a name that is
  both a row target and an HA entity goes to the PC (rare; Q5 covers the media
  wording).
- Free-text commands (web search, YouTube, series) stay with the model in v1.
- "sesi aç" means volume up, never "open something called ses": `ses` is in
  `direct.stop_names` for `pc-open`.

**Learning (later, T17.11):** `LEARNABLE_TOOLS` may gain `pc_open_app`,
`pc_play_game`, `pc_volume`, `pc_media` only; power, close and force-close are
in the never-learnable ceiling. A learned PC rule runs through the same
coordinator, so **with the row off it matches but answers "izinli değil"**:
the rule never runs an action whose switch is off, without any extra check.
Observation only counts turns whose PC action ran (`done`). Approving a learned
rule in Development enables a phrasing, **never a permission row**.

### D8. Locked screen, game mode, fullscreen games

| State | Allowed | Refused (nothing queued for later) |
|---|---|---|
| Locked | `pc_volume` (Core Audio does not need the desktop), `pc_lock` (no-op), `pc_sleep` / `pc_shutdown` / `pc_restart` (with confirm), reads | Opening apps, sites, searches, games; `pc_media` (injected keys do not reach the secure desktop; **verify**) → "Bilgisayar kilitli; açınca tekrar söyle." |
| Fullscreen (D3D full screen or "busy") | volume, media, lock, power, reads | Window-opening actions **ask first** (Q3): "Oyun tam ekranda; açarsam öne gelir. Açayım mı?" through the normal confirmation. |
| No session (no `pc-svc` connected) | Nothing on the PC: "Bilgisayarda oturum açık değil"; home devices and chat work, **typed only** (no Docker, so no whisper-svc) | Every PC action; no row added |
| Game mode (whisper-svc stopped) | Everything, by **typing** on the phone or PC | Voice from any client (no speech-to-text; existing behaviour). |

- Shadow never unlocks the PC and never touches the secure desktop.
- Borderless-window games are not always reported as fullscreen; then the
  action just runs. Accepted.
- **Game mode voice (problem 2 of the vault plan):** v1 = typing only, no new
  work. Recommended follow-up (Q4): on Android, use the phone's own speech
  recognizer when the Core reports whisper `down` with game mode, sending
  `user_text`; it costs the PC nothing. A small CPU whisper model on the PC is
  **not** recommended: it competes with the game for CPU and adds a second
  speech stack.

### D9. Action log and threat model

**Action log:** `<SHADOW_DATA_DIR>/pc/actions/YYYY-MM-DD.jsonl` (self-ignoring
`.gitignore` like `usage/`), one line per decision:

```json
{"ts":1793793600000,"device":"android","sessionId":"…","turnId":"t1","tier":1,
 "tool":"pc_open_app","action":"open_app","row":"p-3f9a1c2e5b7d0a11","label":"Steam",
 "decision":"done","confirm":null,"state":{"locked":false,"fullscreen":false}}
```

`decision`: `done`, `failed`, `not_found`, `ambiguous`, `not_allowed`,
`declined`, `timeout`, `locked`, `unavailable`, `submitted` (power). Search
texts and titles are **not** written here (they are in the conversation log
already); `params` keeps only numbers and enums (`{"op":"set","percent":30}`).
Switch changes go to the same file: `{"ts":…,"device":"browser","kind":"switch","row":"p-…","enabled":true}`.
Kept 90 days (pruned at startup). The Core log gets one short line per action
(no texts).

**Threat model** (what changed: a device token now controls the PC):

| Threat | Mitigation | Residual |
|---|---|---|
| Stolen phone token | Executes only rows already on; risky ones still ask; every action logged with the device; network access stays LAN + Tailscale; token per device, revoke by removing `DEVICE_TOKEN_<NAME>` | Can run allowed actions; if the phone is in `CORE_PC_PERMISSION_DEVICES` it can also switch rows on. Keep that list short (Q2). |
| Prompt injection (vault notes, later web pages) makes the model open things | List default off; refusal terminal; ≤ 3 new rows per turn; no URL pass-through; no free commands | Can open sites/apps the user already allowed. |
| Model or voice tries to flip a switch | D3 structural separation and its tests | None known. |
| Malicious Start-menu shortcut (scripts, interpreters) | Deny list in Core and tray; script targets dropped from the inventory | A malicious *program* the user installed and switched on. |
| Another local process connects to `/pc` and poses as `pc-svc` (it would see run requests and could fake results) | Token file in the user's profile, rotated per Core start; loopback only; `Origin` refused; one link at a time, each new link logged | Same-user code can read the token file; out of scope (it could do anything anyway). |
| Duplicate execution on retry | `requestId` deduplication in the tray; no blind retries in the Core | – |
| Restored old backup re-enables a revoked row | Restore note in docs/05 | Manual. |

### Failure modes

| Situation | Behaviour |
|---|---|
| No `pc-svc` connected (no session, tray not running, tray cannot read the token) | Tools and tier-0 PC rules: "Bilgisayarda oturum açık değil"; no row added; `services` shows `pc-svc` `down` (`no_session`). |
| `pc-svc` answers `failed` | "Açamadım" + log; no retry, no fallback to another tier. |
| Inventory enumeration fails | `pc_find` / resolution answer "kullanılamıyor" (not "bulamadım": absence is unknown). |
| Store unavailable | Every PC action refused with the store message; page shows `available: false`. |
| Explorer not running (`ShellLauncher` throws) | Action fails; the tray does **not** fall back to starting the process itself (it would die with the job). |

## Tests

- **Core unit:** row id determinism and normalization (synonyms → one row;
  `www.` and case; IDN); store (atomic write, mutex, corrupt → unavailable and
  no write, cap, `seen`/badge); matcher (exact, leading words, ambiguous, not
  found, suffix stems, deny list); site validation table (IPs, ports,
  `localhost`, private DNS answers); coordinator flow (not found adds no row;
  off adds an off row and never opens a confirmation; confirm summary text;
  re-check after confirm; locked / fullscreen policy).
- **Core session/protocol:** `pc_permissions_list` / `set` / `seen`, `not_allowed`
  outside `CORE_PC_PERMISSION_DEVICES` and when unset, `pc_permissions_count`
  broadcast, feature flag, `/health` `inbox.pc` loopback only. The **negative
  tests** of D3 (no tool, no rule, no text or audio turn reaches `setEnabled`).
- **Gateway:** `prepare` runs before the gate; a refusal never calls the gate;
  other local services unchanged; `services.yaml` `shadow-pc` fails startup.
- **Tier 0:** `‹hedef›` slot claims only row targets; off row answers without a
  model; HA rules unaffected (existing router tests stay green).
- **`/pc` link (Core):** loopback only, `Origin` refused, bad or late token →
  4401, a new link replaces the old one, ping timeout marks it gone, token
  rotated per start; no link → "oturum açık değil" and no row (model and tier 0).
- **Tray (xUnit, fakes for shell/audio/power):** token read before each connect,
  reconnect with backoff after a Core restart (new token), `requestId` dedupe,
  re-validation (unknown id, deny list, non-https), power `delayMs`,
  `pc_state` on lock / unlock.
- **Manual (user, live):** acceptance scenarios 7–10 and 12 of the vault plan;
  each verify item of D5/D6/D8.

## Kullanıcı kararı gerekli (open questions)

Each has a recommended default; the implementation uses the default until the
user decides.

| # | Question | Default |
|---|---|---|
| Q1 | Does **sleep** also ask every time? (Your risky list names shut down, restart, force-close; a warning without a confirmation cannot be acted on.) | Yes, sleep asks too; the confirm text carries "Shadow da kapanacak". |
| Q2 | Which devices may switch rows (`CORE_PC_PERMISSION_DEVICES`)? | The PC browser and the phone (`browser`, `android`). |
| Q3 | Fullscreen game: should window-opening actions ask first? | Yes, ask. Volume and media never ask. |
| Q4 | Voice during game mode: typing only, or later Android's own recognizer? | Typing only in T17; Android recognizer as a separate later task. No CPU whisper. |
| Q5 | "müziği durdur" without a device name: PC or an HA speaker? | The PC; HA speakers by name ("‹ad›'ı durdur") as today. |
| Q6 | Can rows be deleted on the page? | Not in v1 (switch only; cap 300). Add "Kaldır" later if the list gets long. |
| Q7 | One row for all volume changes and one for all media keys? | Yes (as in your example "ses düzeyini değiştir"). |
| Q8 | May every authenticated device *run* allowed actions, or only a list? | Every authenticated device (there are two); only switching is limited. |
| Q9 | Prime → HBO fallback: how is "not on Prime" decided? | v1: the service you name, or Shadow asks; remembered per title if you say so. Automatic check only with T19. |
| Q10 | Locked PC and "X'i aç": refuse, or open after unlock? | Refuse with "kilitli; açınca tekrar söyle"; nothing queued. |
| Q11 | "YouTube'da X aç": results page in v1, direct play only with T19? | Yes. |
| Q12 | Search engine for "web'de ara"? | Google. |
| Q13 | Site rows per exact host (`music.youtube.com` ≠ `youtube.com`) or per registrable domain? | Exact host. |

## Not verified (must be checked before the step that uses it)

- Steam `rungameid`, Epic launch URI format, Battle.net `--exec` / `battlenet://`
  behaviour and WoW product codes (T17.7).
- YouTube Music, Prime Video and HBO Max search templates; any episode deep
  link; TR catalogue behaviour (T17.9).
- Media keys via `SendInput` while locked and while a fullscreen game has focus;
  Core Audio volume while locked (T17.4).
- `SetSuspendState` may hibernate instead of sleep when hibernation is on;
  pick the API after a test (T17.8).
- `SHQueryUserNotificationState` for borderless games (T17.5).
- The background Core task of T21.4 runs as the same Windows user, so both see
  the same `%LOCALAPPDATA%` and the token file (else: shared location + ACL).
- Enumerating AppsFolder from .NET without WinRT (shell COM) and that its
  parsing names launch through `ShellLauncher` (T17.5).

## Out of scope and deferred

- Controlling other PCs; waking the PC (T21); hotkey / wake word (T18).
- Learning PC phrasings (T17.11, after static rules are in use).
- `pc-svc` without a user session (impossible by design: the session is what it controls).
- Proving a physical tap (device-bound user-presence checks).

## Implementation tasks

Boxes: `[ ]` not started, `[~]` started, `[x]` done. **Files** lists what a
task may touch. Tasks sharing a file are not run in parallel (**After**).

| Task | Files | After | Data |
|---|---|---|---|
| T17.2 | `core/src/pc/permissions.ts` (new), `core/src/protocol.ts`, `core/src/session.ts`, `core/src/server.ts` (`/health` inbox), `core/src/config.ts`, `core/src/index.ts`, `.env.example`, `docs/02-core-protocol.md`, `docs/README.md`, core tests; `ui/src/ui/PermissionsPanel.tsx` (new), `ui/src/App.tsx`, `ui/src/ui/AppMenu.tsx` / `menu.ts`, `ui/src/ui/strings.ts`, `ui/src/protocol/types.ts`, `ui/src/assistant/{state,controller}.ts`, ui tests | – | `pc/permissions.json` |
| T17.3 | `core/src/pc/link.ts` (new: `/pc` endpoint, token file, requests), `core/src/server.ts`, `core/src/health.ts` (`pc-svc` status), `core/src/index.ts`, `docs/02-core-protocol.md` (services list); `deploy/windows/tray/src/ShadowTray/Pc/*` (new: client, reconnect, `pc_state`), `TrayApp.cs`, tray tests | T17.2 (shares `server.ts`, `index.ts`) | `%LOCALAPPDATA%\ShadowAssistant\pc-svc.token` |
| T17.4 | `core/src/mcp-gateway.ts` (`prepare`), `core/src/session.ts` (summary), `core/src/pc/{catalog,coordinator,service,action-log}.ts` (new), `core/src/services.ts` (reserved name), `core/prompts/*`, `router.yaml` (tier services), `docs/02-core-protocol.md`; tray `Pc/` volume, media, lock | T17.2, T17.3 | `pc/actions/` |
| T17.5 | `core/src/pc/{resolve,coordinator}.ts`, tray `Pc/` AppsFolder inventory, deny list, close / force-close, fullscreen + lock state | T17.4 | – |
| T17.6 | `core/src/pc/sites.ts` (new), coordinator, tray `Pc/` URL templates | T17.4 | – |
| T17.7 | tray `Pc/` launcher manifests; `core/src/pc/resolve.ts` | T17.5 | – |
| T17.8 | tray `Pc/` power; coordinator (delay, summary); docs/05 restore note | T17.4 | – |
| T17.9 | this doc (results), tray templates | T17.6 | – |
| T17.10 | `router.yaml`, `core/src/router-config.ts`, `core/src/router.ts`, `core/src/pc/direct.ts` (new), `docs/04-router.md`, router tests | T17.5 | – |
| T17.11 | `core/src/learn/*`, `router-config.ts` ceilings, `docs/08` | T17.10 | `fast-path/rules.json` |

- [ ] **T17.2 — Permission list without execution.** Store, protocol frames,
  `CORE_PC_PERMISSION_DEVICES`, İzinler page under ⋮, badge, tray inbox
  number. Acceptance: list / set / seen / count work; `not_allowed` outside the
  list and when unset; corrupt file → unavailable, nothing written; D3 negative
  tests green.
- [ ] **T17.3 — `pc-svc` link.** Core `/pc` endpoint and token file; tray
  client that dials the Core after sign-in and reconnects; `pc_state`;
  `pc-svc` in the services list. Acceptance: Core sees lock state; wrong or
  missing token and `Origin` refused; with the tray closed the Core keeps
  working and a PC request answers "oturum açık değil" without adding a row.
- [ ] **T17.4 — Coordinator, `shadow-pc` service, volume / media / lock.**
  Gateway `prepare`, code levels, Turkish confirm summaries, action log.
  Acceptance: "sesi yüzde 30 yap" with the row off → "izinli değil" + off row +
  badge; switched on → volume changes; log line present.
- [ ] **T17.5 — Apps: inventory, resolution, open / close / force-close.**
  Acceptance: scenario 7; ambiguous asks back; unknown → "bulamadım", no row;
  force-close always asks; locked and fullscreen rules of D8.
- [ ] **T17.6 — Sites and searches.** Alias catalogue, host validation, DNS
  existence, web / YouTube / YouTube Music search pages. Acceptance: scenario 9
  (results page); invented domain → "bulamadım"; IP / localhost refused.
- [ ] **T17.7 — Games.** First verify the three launch mechanisms on the PC with
  the user, then Steam / Epic / Battle.net adapters. Acceptance: "WoW'u aç"
  starts World of Warcraft through Battle.net.
- [ ] **T17.8 — Power.** Sleep / shut down / restart with confirmation, "Shadow
  da kapanacak", delayed execution, `submitted` log. Acceptance: scenario 10.
- [ ] **T17.9 — Series and films.** The D6 verification evening, then Prime
  Video / HBO Max search (and episode links only if verified).
- [ ] **T17.10 — Tier-0 PC rules.** D7 table, `‹hedef›` slot. Acceptance:
  scenario 8 path (typed) without a model call; off row answers without a model.
- [ ] **T17.11 — Learning for PC phrasings (later).** Only after T17.10 has been
  in daily use.

## Progress log

- 2026-11-13: design written (software-architect, after a Codex review of the
  same code: tray executor, gateway `prepare` before the gate, structural
  separation of the switch).
- 2026-11-13: updated for the user decision that the Core will run without a
  sign-in (T21.4): `pc-svc` dials the Core over a loopback `/pc` WebSocket with a
  per-start token file; no link = "oturum açık değil", no row.
