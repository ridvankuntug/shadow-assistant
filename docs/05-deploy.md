# 05 - Running Shadow Assistant at home

How to run the pieces on a Windows PC: the speech services in Docker, the Core
as a scheduled task in your own session, and an encrypted daily backup of the
Core's data folder to Google Drive. One piece runs on the always-on Linux box: the
Wake-on-LAN endpoint (section 5).

Steps you have to do or approve yourself are marked **[USER ACTION]**. Nothing
in this repo registers tasks, creates rclone remotes or starts containers on
its own.

| Piece | Runs as | Files |
| --- | --- | --- |
| whisper-svc, tts-svc | Docker containers, ports on 127.0.0.1 only | `deploy/docker-compose.yml` |
| Core | Tray app started by a scheduled task at sign-in, your user, not elevated | `deploy/windows/` |
| Backup | Script (optionally a daily scheduled task), your user | `deploy/backup/` |
| wake-svc | systemd unit on the always-on Linux box, throw-away user (`DynamicUser`), LAN address only | `deploy/linux/` |
| Core on the Pi (in progress, docs/13) | systemd unit, the account that owns the Claude login (section 7) | `deploy/linux/` |

## 1. Prerequisites

- Windows 10 1803+ / Windows 11 (`tar.exe` and Task Scheduler are built in).
- Node.js 22+ (`node --version`).
- .NET 10 SDK to build the tray app (`dotnet --list-sdks`); running it needs
  the .NET 10 Desktop Runtime and ASP.NET Core Runtime, which the SDK includes.
- Docker Desktop with the WSL 2 backend; for whisper-svc on the GPU, an NVIDIA
  driver with WSL CUDA support (`docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi` must work).
- Claude Code installed and signed in as the same Windows user that will run
  the Core (`claude` works in a normal terminal).
- For backups: rclone (`winget install Rclone.Rclone`) and a Google account.
- **[USER ACTION]** Copy `.env.example` to `.env` in the repo root and fill it
  in (device tokens, Home Assistant, `SHADOW_VAULT_DIR` / `SHADOW_DATA_DIR`).
- **[USER ACTION]** Build the Core once:

  ```powershell
  cd core
  npm ci
  npm run build
  ```

## 2. Speech services (Docker Compose)

From `deploy/`:

```powershell
docker compose --env-file ../.env up -d --build   # first time: builds images, downloads models
docker compose --env-file ../.env ps              # both should become "healthy"
docker compose --env-file ../.env down            # stop; model/voice volumes are kept
```

- The first start downloads the Whisper model (~3 GB, volume `whisper-models`)
  and the Piper voice (~63 MB, volume `tts-voices`). Later starts take about
  15-20 s until both `/health` endpoints answer.
- whisper-svc `large-v3` (float16) uses about 4 GB of GPU memory while running.
- By default the containers do not come back after a reboot. To make them
  start with Docker Desktop, set `SHADOW_RESTART=unless-stopped` in `.env` and
  run `up -d` once. **[USER ACTION]** decide whether you want this.
- Quick check:

  ```powershell
  curl.exe -s http://127.0.0.1:8701/health
  curl.exe -s http://127.0.0.1:8702/health
  ```

### Voices

tts-svc offers `tr_TR-dfki-medium` (default, CC BY-NC-SA 4.0: non-commercial
use only), `tr_TR-fahrettin-medium` and `tr_TR-fettah-medium` (both CC0). The
others are downloaded into the `tts-voices` volume on first use (~63 MB each).
The first request for a new voice may answer `tts_unavailable` while it
downloads (`TTS_VOICE_LOAD_WAIT_S`, default 20 s). To fetch them ahead of time,
from `deploy/`:

```powershell
docker compose run --rm tts-svc python -m tts_svc.voices tr_TR-fahrettin-medium tr_TR-fettah-medium
```

The choice is per device in the UI (Ayarlar → Ses, "Dene" plays a sample).
Licences are listed in `THIRD_PARTY_NOTICES.md`.

### Pronunciation

`pronunciations.yaml` in the repo root maps written words to how they should be
spoken (e.g. `Shadow: Şadov`). The Core applies it only to text sent to
tts-svc, never to what is shown. Matching is whole word and case-insensitive,
and a suffix after an apostrophe is kept. Edit the file and restart the Core.

### Idle GPU release (whisper-svc)

After `WHISPER_IDLE_UNLOAD_MIN` minutes (default 10) without transcription
requests, whisper-svc unloads its model and returns ~90 % of its VRAM (only the
CUDA context, ~60-90 MiB, stays; measured with the small model). The first
voice command afterwards reloads the model and waits for it (a few seconds).
Meanwhile `/health` answers `200 {"status":"idle",...}`, so the service still
counts as up (Core detail `idle`, tray "hazır (boşta, model kaldırıldı)", UI
hint). `0` keeps the model loaded. After a failed reload `/health` returns
`503 error`; the next request tries again.

### Oyun modu (tray)

Tray menu → *Oyun modunu aç* stops the whisper-svc container (the item then
reads *Oyun modunu kapat*)
(`docker compose --env-file ..\.env stop whisper-svc` in `deploy\`) to free the
GPU; unchecking runs `docker compose --env-file ..\.env up -d whisper-svc`.
While on, the tray icon shows a pause mark, the tooltip starts with
"(oyun modu)", and whisper-svc reads "oyun modu" instead of turning the icon
yellow. The setting survives restarts
(`%LOCALAPPDATA%\ShadowAssistant\tray-state.json`); a tray started with game
mode on says so (balloon) and stops whisper-svc again. If a docker command
fails, the check does not move (see `core.log`). The web UI disables the mic
with a note while whisper-svc is down; typing still works.

### Redeploy after this change

From `deploy/`: `docker compose --env-file ../.env up -d --build tts-svc whisper-svc`
(rebuilds both images). Then rebuild the Core (`core/dist`) and restart it,
rebuild `ui`, and re-publish the tray app.

## 3. Core: tray app started by a scheduled task

### Why a task in your own session

The Core uses the Claude Agent SDK, which signs in with the Claude Code login
stored in your Windows profile. A Windows service, SYSTEM or another account
would not see that login (and would need an API key instead). So the task
runs as **you**, in your interactive session, started when you sign in, with
normal (not elevated) rights. The consequence: the Core runs only while you
are signed in. Locking the screen is fine; signing out stops it.

### What runs

The task starts the tray app `deploy/windows/tray/publish/ShadowTray.exe`
([README](../deploy/windows/tray/README.md)), which:

- runs `node core/dist/index.js` from the repo root **directly**: no
  PowerShell or cmd.exe in between and no console window (the Core reads
  `.env`, `services.yaml`, `router.yaml` there);
- restarts the Core after a crash with exponential backoff (5 s doubling to
  5 min; the delay resets after 10 min of uptime) and gives up after 20 short
  runs in a row, so a broken setup does not loop forever;
- does not restart after a clean exit (code 0);
- writes the Core's output to `%LOCALAPPDATA%\ShadowAssistant\logs\core.log`,
  rotated at 10 MB, keeping 5 old files (`core.1.log` ...);
- allows only one instance per session (a second start says "Shadow Tray
  zaten çalışıyor" and exits);
- does not start a second Core when one started by hand already answers
  `GET /health`: it shows "Core dışarıda çalışıyor" (blue icon), watches it,
  and starts and supervises its own Core once that one has stopped answering
  for about 10 s;
- keeps the Core in a job object, so the Core ends when the tray app ends;
- shows a green / yellow / red (blue: external Core) icon in the notification
  area with a menu: status of the Core and of each service (from the Core's
  `GET /health`, with its short `detail` code such as "kapalı (timeout)"),
  **Arayüzü aç** (serves `ui/dist` at `http://localhost:8703/`, port
  `SHADOW_UI_PORT`; the browser is opened through explorer.exe so that it is
  not killed with the task's job), **Yeniden başlat / Durdur / Başlat**,
  start/stop of the speech containers (`docker compose up -d` / `down`),
  **Logları aç** and **Çıkış**.

Stopping (menu or Çıkış) is graceful: the tray sends the Core Ctrl+C, which
the Core handles like SIGINT (closes connections, flushes logs, exits 0); after
10 s it is killed. A Core started moments ago is first given up to 5 s from
its start to answer `/health` (its handler is in place by then). Ctrl+C
rather than Ctrl+Break (SIGBREAK) because it stops older Core builds cleanly
too; details in the tray README.

The task itself has no time limit, ignores a second start while running, and
has Task Scheduler's own "restart on failure" (3 times, every 5 min) as a
second line of defence for when the tray app itself fails.

Paths are not hard-coded: the repo root defaults to the first folder above
the exe that contains `core\` and `services.yaml`, `node` comes from PATH.
Override with `--repo-root`, `--node-path`, `--log-dir` or the environment
variables `SHADOW_REPO_ROOT`, `SHADOW_NODE_PATH`, `SHADOW_CORE_LOG_DIR` (real
environment only, not `.env`). The installer writes the resolved repo root
and node path into the task's arguments, so the task does not depend on
those variables later. An unknown argument is logged as a warning and
ignored.

`deploy/windows/run-core.ps1` (the PowerShell supervisor the task used before)
stays as a **manual fallback**, e.g. when the .NET runtime is missing:
`.\run-core.ps1 -DryRun`, then `.\run-core.ps1`. It shares the tray app's
single-instance lock, so the two never run a Core at the same time.

### Build the tray app

From `deploy/windows/tray/` (if `dotnet` on PATH is a runtime-only install,
call the SDK's `dotnet.exe` by its full path):

```powershell
dotnet test ShadowTray.slnx                                            # unit tests
dotnet publish src\ShadowTray\ShadowTray.csproj -c Release -o publish  # framework-dependent build
```

Output: `deploy/windows/tray/publish/ShadowTray.exe` (git-ignored). Stop the
tray app (menu → Çıkış) before publishing again: a running exe is locked.

### Install

From `deploy/windows/` in a normal (non-admin) PowerShell:

```powershell
.\install-core-task.ps1 -WhatIf      # checks the tray exe, node, core\dist and .env; shows the task, registers nothing
.\install-core-task.ps1 -StartNow    # [USER ACTION] registers \ShadowAssistant\Shadow Assistant Core and starts it
```

If the scripts are blocked by the execution policy, run them with
`powershell -ExecutionPolicy Bypass -File .\install-core-task.ps1 ...`. The task
itself starts `ShadowTray.exe` directly; PowerShell is not involved at sign-in.

Options: `-TrayPath`, `-NodePath`, `-RepoRoot`, `-LogDir`, `-LogonDelaySeconds`
(default 30), `-Force` (replace an existing task). Re-run with `-Force` after
moving the repo or changing Node.js.

The installer also creates a **Shadow Assistant** shortcut in your Start menu
(skip with `-NoShortcut`). It starts the task, so after **Çıkış** you can bring
the tray app back without signing out; a click while it already runs does
nothing. `.\install-core-task.ps1 -ShortcutOnly` adds just the shortcut to an
existing task; the uninstaller removes it.

**Switching from the earlier run-core.ps1 task:** `-Force` replaces the task
definition but not a running instance. Run `.\uninstall-core-task.ps1` first
(stops the old task and its Core), then publish and install as above.

Check it: the tray icon, `Get-ScheduledTask -TaskPath \ShadowAssistant\` and
`Get-Content $env:LOCALAPPDATA\ShadowAssistant\logs\core.log -Tail 50 -Wait`.

### Uninstall

```powershell
.\uninstall-core-task.ps1 -WhatIf
.\uninstall-core-task.ps1            # [USER ACTION] stops and removes the task, a tray app started from this repo and a leftover Core process
```

Logs are kept; delete `%LOCALAPPDATA%\ShadowAssistant\logs` by hand if wanted.

### Data folder

Everything the Core keeps (conversations, memory, notifications, sessions,
usage, the backup status) lives in one data folder. One rule decides where;
the Core defines it (`resolveDataDir` in `core/src/config.ts`) and the backup
script mirrors it (`Resolve-ShadowDataDir` in
`deploy/backup/backup-common.ps1`), so `backup\status.json` is written where
the Core reads it. Change the code on both sides and this section together.

1. `SHADOW_DATA_DIR`, if not blank: an absolute path is used as written; a
   relative one is resolved against the repo root.
2. Else `<SHADOW_VAULT_DIR>\.shadow-assistant`, if `SHADOW_VAULT_DIR` names an
   existing folder when the Core starts.
3. Else `<repo root>\.shadow-assistant`.

Details:

- A variable set in the real environment wins over `.env`, even when it is
  blank (blank then means "not set", and `.env` is not read for it). Values
  are trimmed. `SHADOW_ENV_FILE` picks another `.env`; a relative one is
  resolved against the repo root. If it names a missing file, the backup
  scripts stop with an error instead of falling back to the default folder.
- Relative paths are resolved against the repo root, never the caller's
  working directory. The Core resolves a relative `SHADOW_VAULT_DIR` against
  its working directory, which the tray and `run-core.ps1` set to the repo
  root; started elsewhere (e.g. `npm start` in `core\`), it logs a warning.
  Prefer absolute paths.
- No expansion: `~` and `%USERPROFILE%` are taken literally (a relative path
  under the repo root). A trailing `\` changes nothing. Avoid `\data`
  (root-relative) and `D:data` (drive-relative): their folder depends on the
  process's current drive and folder, so both sides log a warning.
- Write Windows paths unquoted or in single quotes in `.env`: in double quotes
  Node turns `\n` into a line break (`"C:\new"`).
- Both sides decide when they run: the Core at startup, the backup at each
  run. Changing the folder needs a Core restart, and moving the data there is
  up to you.

Checking it: the Core logs `data folder: <path> (from ...)` at startup
(`core.log`), and every backup run logs `data folder: <path> (from ...);
status file: ...` first (`backup.log`, also printed with `-WhatIf`). The two
paths must match. When the status file is missing, the Core logs its path once
(`backup producer: no status file at ...`): either backups are not set up or
the two sides disagree. `backup-data.ps1 -DataDir` overrides the rule; the Core
then does not see that run's status.

### Persistent sessions and memory

All optional, set in `.env` (defaults in `.env.example`; details in
[07-speed.md](07-speed.md) and [06-memory.md](06-memory.md)):

- Sessions: `CORE_AGENT_PERSISTENT` (one long-lived model session per device),
  `CORE_AGENT_PREWARM`, `CORE_AGENT_IDLE_MIN` (each open session holds about
  250 MB), `CORE_TURN_TIMEOUT_MS`, `CORE_CONTINUITY_MIN`.
- `CORE_AGENT_SKIP_TURN_SUMMARY=1` is opt-in and relies on an undocumented
  Claude Code CLI variable: an SDK update may silently stop it working. Leave
  it off unless you measured a gain.
- Memory: `CORE_MEMORY` (`off` disables it completely), `CORE_MEMORY_MODEL`,
  `CORE_MEMORY_IDLE_MIN`, `CORE_MEMORY_EVERY_TURNS`, `CORE_MEMORY_MAX_RUNS_DAY`,
  `CORE_COMPACT_AT_TOKENS`.
- Notifications: `CORE_QUIET_HOURS` (default `00:00-09:00`, `off` disables):
  urgent notifications are shown but not spoken in this window (docs/09).
- Rehearsal: `CORE_REHEARSAL` (default off; T11.5, docs/13): on = the
  notification producers are not started and no urgent notification is
  spoken (one startup warn line says so); the inbox still works. An invalid
  value stops the Core.
- `SHADOW_PRONUNCIATIONS_FILE`: alternative pronunciation lexicon.

Data lives in the data folder (see "Data folder" above):
`sessions/devices.json`, `memory/brief.md`, `memory/notes/*.md`,
`memory/index.json`, `memory/state.json`, `memory/forget-pending.json`. All of
it is inside the encrypted backup (section 4); nothing extra to configure.

View or delete memory in the UI (Ayarlar → Hafıza), or by voice/text: "neyi
hatırlıyorsun" lists it, "bunu unut" deletes an entry.

Redeploy: `npm run build` in `core/` (rebuilds `core/dist`), restart the Core
(tray → Yeniden başlat), then rebuild `ui`.

## 4. Backups

`deploy/backup/backup-data.ps1` packs the Core's data folder (resolved by the
Core's rule, section 3 "Data folder": conversation logs, memory, usage
records, ...) into
`shadow-assistant-data-YYYYMMDD-HHMMSS.tar.gz`, uploads it to an rclone
**crypt** remote on top of a Google Drive remote, and prunes:

- on Drive: archives older than 60 days (`SHADOW_BACKUP_REMOTE_DAYS`, 0 = keep all);
- locally (`%LOCALAPPDATA%\ShadowAssistant\backups`): all but the newest 3
  (`SHADOW_BACKUP_LOCAL_KEEP`).

File contents **and** file names are encrypted on Drive. The Drive remote uses
the `drive.file` scope, so rclone can only see files it created itself, not the
rest of your Drive. Log: `%LOCALAPPDATA%\ShadowAssistant\logs\backup.log`.

Status: each run also writes `<data folder>\backup\status.json` (atomically,
at start and at the end): `result` (`running` / `ok` / `failed`), the failed
`stage` (`setup` / `archive` / `upload` / `prune`), `lastSuccessAt` and the
run's timestamps (UTC). The Core reads this file to raise "backup failed" and
"no backup" notifications; no file means backups are not set up, so no
notification. It holds no error text (that is in `backup.log`), is not written
under `-WhatIf` or when the data folder is missing, and is left out of the
archive, so a restore never brings back an old status.

All settings (parameter, else environment variable, else `.env`, else
default) are listed in `.env.example` under "Backups" and in
`Get-Help .\backup-data.ps1 -Full`. rclone is found on PATH, else in the winget
install folder, else set `SHADOW_BACKUP_RCLONE_PATH`.

### Where the crypt passwords live

The crypt remote is **not** stored in `rclone.conf`. The scripts define it for
their own process only, through rclone's environment-variable config
(`RCLONE_CONFIG_SHADOWCRYPT_*`), from `SHADOW_BACKUP_CRYPT_PASSWORD` and
`SHADOW_BACKUP_CRYPT_SALT`, and remove those variables again when they finish.
`rclone.conf` then holds only the Drive OAuth token.

Reason: rclone.conf keeps passwords "obscured", which is a reversible encoding,
not encryption, in a well-known file that every rclone command and tool reads.
Keeping the two secrets only in `.env` (git-ignored, already holding the other
secrets) or in your user environment keeps them in one place you control. The
scripts pass them to rclone over stdin, never on a command line, and never
write them to the log.

If `SHADOW_BACKUP_CRYPT_PASSWORD` is empty and `rclone.conf` already contains a
crypt remote named `shadowcrypt` (`SHADOW_BACKUP_CRYPT_REMOTE`), that one is
used as-is.

> **Warning.** Without the exact two passwords the backups cannot be
> decrypted by anyone, including you. There is no recovery. Store both in your
> password manager before the first backup.

### One-time setup

1. **[USER ACTION]** Create the Drive remote (opens a browser for Google sign-in):

   ```powershell
   rclone config create gdrive drive scope=drive.file
   rclone lsd gdrive:            # must work without errors
   ```

   Optional but recommended: create your own Google OAuth client ID (rclone
   docs, "Making your own client_id") and add `client_id=... client_secret=...`
   to the command; the shared rclone client ID is rate-limited.
   Another remote name works too: set `SHADOW_BACKUP_DRIVE_REMOTE`.

2. **[USER ACTION]** Generate two random secrets and store them in your
   password manager:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

3. **[USER ACTION]** Put them into `.env`:

   ```
   SHADOW_BACKUP_CRYPT_PASSWORD=<first value>
   SHADOW_BACKUP_CRYPT_SALT=<second value>
   ```

4. Test and run once, from `deploy/backup/`:

   ```powershell
   .\backup-data.ps1 -WhatIf     # checks rclone and the remotes, writes nothing
   .\backup-data.ps1             # [USER ACTION] first real backup
   .\restore-data.ps1 -List      # the archive name, decrypted
   ```

   On Drive you will see a folder `shadow-assistant-backup` containing files
   with random-looking names.

5. Optional: **[USER ACTION]** schedule it daily (your user, not elevated;
   runs at the next opportunity if the PC was off):

   ```powershell
   .\install-backup-task.ps1 -At 03:30 -WhatIf
   .\install-backup-task.ps1 -At 03:30
   .\install-backup-task.ps1 -Uninstall     # to remove it
   ```

### Restore

```powershell
.\restore-data.ps1 -List
.\restore-data.ps1 -Destination $env:TEMP\shadow-restore                 # newest archive
.\restore-data.ps1 -Archive shadow-assistant-data-YYYYMMDD-HHMMSS.tar.gz -Destination D:\restore
```

The archive is downloaded, decrypted and unpacked into the (new or empty)
destination folder as `.shadow-assistant\`. The live data folder is never
overwritten: stop the Core, copy the files you need, start the Core again.

On a new PC: install rclone, create the Drive remote again (step 1) and set
the same two secrets (step 3) before restoring.

Without the scripts, the same remote can be defined in plain rclone:
`rclone config create shadowcrypt crypt remote=gdrive:shadow-assistant-backup password=<first> password2=<second> filename_encryption=standard directory_name_encryption=true`
(rclone obscures the values; this stores them in rclone.conf).

## 5. Wake endpoint on the always-on Linux box

`wake-svc` ([services/wake-svc](../services/wake-svc/README.md), design:
[docs/12](12-wake-and-headless-core.md) D1/D6) runs on the always-on Linux box
(systemd, e.g. a Raspberry Pi) and sends a Wake-on-LAN packet to the PC's
**one** configured MAC when the phone asks with the wake token. It is a single
Python 3.10+ file using only the standard library: nothing to install besides
`python3` (and `curl` for the checks).

Rules that do not change:

- It listens on the box's **LAN address only**. It is **never** added to the
  Cloudflare tunnel or any other public route. The phone reaches it, like the
  Core, only through the box's tailnet-only HTTPS address ("HTTPS addresses
  through Tailscale" below), at home and away.
- The wake token is **separate** from every Core device token and only allows
  "send the magic packet". It lives in one root-only file and reaches the
  service through systemd `LoadCredential=`, never through the environment, a
  command line or a tracked file.
- The MAC, the addresses and the token are set only on the box. The tracked
  files (`deploy/linux/`) hold placeholders and paths only.

| Path on the box | What | Owner, mode |
| --- | --- | --- |
| `/opt/shadow-assistant/wake-svc/server.py` | The code (`services/wake-svc/wake_svc/server.py`) | `root:root 0644` (folders `0755`) |
| `/etc/systemd/system/wake-svc.service` | The unit (`deploy/linux/wake-svc.service`) | `root:root 0644` |
| `/etc/shadow-assistant/wake-svc.env` | Settings: MAC, LAN address, broadcast (from `deploy/linux/wake-svc.env.example`) | `root:root 0600` |
| `/etc/credstore/wake-svc.token` | The wake token | `root:root 0600` (folder `0700`) |

The unit runs the service as a throw-away user (`DynamicUser=yes`) with no
capabilities, a read-only system, no home and a system-call filter; only root
and the service itself can read the token. If you change any of these paths,
change them in the unit too.

Placeholders below: `<user>@<box>` is your SSH login on the box,
`<box-lan-ip>` its LAN address (the same value as `WAKE_BIND`), `<lan-cidr>`
the home LAN range.

### Install

1. **[USER ACTION]** Check that the box has Python 3.10 or newer and systemd:

   ```sh
   python3 --version
   systemctl --version | head -1
   ```

2. **[USER ACTION]** Copy the three files to a private folder in your home
   on the box (not `/tmp`, where other local users could swap them before root
   installs them). From the repo root on the PC (PowerShell or Git Bash):

   ```sh
   ssh <user>@<box> "mkdir -p -m 0700 wake-svc-install"
   scp services/wake-svc/wake_svc/server.py deploy/linux/wake-svc.service deploy/linux/wake-svc.env.example <user>@<box>:wake-svc-install/
   ```

   (Or `git pull` a clone on the box and use the same files from there.)

3. **[USER ACTION]** On the box, install the code and the unit:

   ```sh
   sudo install -d -m 0755 -o root -g root /opt/shadow-assistant /opt/shadow-assistant/wake-svc
   sudo install -m 0644 -o root -g root ~/wake-svc-install/server.py /opt/shadow-assistant/wake-svc/server.py
   sudo install -m 0644 -o root -g root ~/wake-svc-install/wake-svc.service /etc/systemd/system/wake-svc.service
   ```

4. **[USER ACTION]** Create the env file and fill it in. `WAKE_MAC` is the
   PC's **wired** adapter MAC (`Get-NetAdapter` on the PC, `MacAddress` of the
   Ethernet adapter), `WAKE_BIND` the box's LAN IPv4 address (`ip -4 addr` on
   the box), `WAKE_BROADCASTS` the LAN's broadcast address (the `brd` value in
   the same output). Give the box a fixed LAN address (a DHCP reservation in
   the router, or a static address on the box): if it changes, wake-svc can no
   longer listen.

   ```sh
   sudo install -d -m 0755 -o root -g root /etc/shadow-assistant
   sudo install -m 0600 -o root -g root ~/wake-svc-install/wake-svc.env.example /etc/shadow-assistant/wake-svc.env
   sudoedit /etc/shadow-assistant/wake-svc.env
   ```

   Do not add `WAKE_TOKEN` (refused at startup) or `WAKE_TOKEN_FILE` (it would
   bypass the credential).

5. **[USER ACTION]** Generate the wake token **on the box**. It goes straight
   into a root-only file and never appears on a command line:

   ```sh
   sudo install -d -m 0700 -o root -g root /etc/credstore
   sudo sh -c 'umask 077; python3 -I -c "import secrets; print(secrets.token_urlsafe(32))" > /etc/credstore/wake-svc.token.new && mv /etc/credstore/wake-svc.token.new /etc/credstore/wake-svc.token'
   sudo ls -l /etc/credstore/wake-svc.token      # -rw------- root root
   ```

   You need the value once, to enter it in the phone (docs/12, D2):
   `sudo cat /etc/credstore/wake-svc.token`. Copy it from the terminal into
   your password manager or straight into the phone; never paste it into
   chats, issues, files in the repo or a command line.

6. **[USER ACTION]** Remove the copies and start the service:

   ```sh
   rm -r ~/wake-svc-install
   sudo systemctl daemon-reload
   sudo systemctl enable --now wake-svc
   systemctl status wake-svc --no-pager
   ```

   A configuration error (bad MAC, short token, wildcard address, ...)
   stops it with exit code 1; `journalctl -u wake-svc -n 20` names the setting
   (never its value). A missing token file stops it before it runs, with
   `status=243/CREDENTIALS`. The unit keeps retrying every 15 s; fix the
   cause, then `sudo systemctl restart wake-svc`.

7. **[USER ACTION]** If a firewall is active on the box, open the port
   (default `8704/tcp`) for the LAN and the tailnet only, e.g. with ufw:

   ```sh
   sudo ufw allow from <lan-cidr> to any port 8704 proto tcp
   sudo ufw allow in on tailscale0 to any port 8704 proto tcp
   ```

### Verify

From the box and from the PC (or a browser on the phone, on the home Wi-Fi):

```sh
curl -i http://<box-lan-ip>:8704/health
# 200 {"status":"ok","service":"wake-svc","version":"0.1.0"}
curl -i -X POST http://<box-lan-ip>:8704/wake
# 401 {"error":"unauthorized"}   (no token)
```

A full wake test, on the box, with the token passed through a pipe so it is
not on a command line (if the PC is on, the packet does nothing):

```sh
sudo sh -c 'printf "Authorization: Bearer %s\n" "$(cat /etc/credstore/wake-svc.token)"' \
  | curl -i -X POST -H @- http://<box-lan-ip>:8704/wake
# 202 {"sent":true}; a second call within 10 s gives 429
journalctl -u wake-svc -n 5 --no-pager      # a "wake_sent" line, no token, no MAC
```

`202` means the packets left the box, not that the PC woke: test a real wake
with the PC shut down (docs/12, D3). Optional: `systemd-analyze security
wake-svc` rates the unit's sandbox.

### HTTPS addresses through Tailscale (recommended; required by the Android app)

Away from home the Android app talks to the Core over `wss://` and to
wake-svc over `https://`; it has no built-in address (android/README.md,
"Network: home and away"). At home it can use plain LAN addresses instead
(see "Home addresses" below). Tailscale `serve` on
the box gives both a tailnet-only HTTPS address with a valid certificate, on
the box's one ts.net name:

| Address (tailnet only) | Proxied to | Entered in the phone as |
| --- | --- | --- |
| `https://<box>.<tailnet>.ts.net` (port 443) | the Core, `http://<pc-lan-ip>:8700` (incl. the WebSocket) | Core address `wss://<box>.<tailnet>.ts.net/ws` |
| `https://<box>.<tailnet>.ts.net:8443` | wake-svc, `http://<box-lan-ip>:8704` | wake address `https://<box>.<tailnet>.ts.net:8443` |

Costs of this path:

- The name resolves only on the tailnet, so **away** the phone needs
  Tailscale connected (at home not, if the home addresses are entered, see
  below).
- **If the box is off** (or loses the LAN), the phone cannot reach the Core
  at all, and cannot wake the PC either.
- The box's machine name and your tailnet name appear in the public
  **certificate transparency** logs.
- Every request reaches wake-svc from the box itself, so the **wrong-token
  lockout is shared by all callers**: a few wrong tokens from any tailnet
  device lock out the phone too until the lockout ends.
- The Core sees every phone connection as coming from the box's LAN address.
  That is fine: the device token still decides, the `/health` `inbox` stays
  loopback-only (the box is not loopback), and the Core never reads
  `X-Forwarded-For`.

1. **[USER ACTION]** In the Tailscale admin console, DNS page: enable
   **MagicDNS** and **HTTPS Certificates** (once per tailnet).

2. **[USER ACTION]** On the PC, let the Core accept connections from the box:
   `CORE_HOST=0.0.0.0` (or `<pc-lan-ip>`) in `.env`, and allow inbound TCP
   8700 in the Windows firewall from `<box-lan-ip>` (android/README.md, "Core
   setup"). Restart the Core.

3. **[USER ACTION]** On the box, proxy tailnet HTTPS to the Core and to
   wake-svc. Use `serve` (tailnet only), never `funnel` (public internet):

   ```sh
   sudo tailscale serve --bg --https=443 http://<pc-lan-ip>:8700
   sudo tailscale serve --bg --https=8443 http://<box-lan-ip>:8704
   tailscale serve status      # shows both https://<box>.<tailnet>.ts.net entries
   ```

   `--bg` keeps the settings across reboots. Undo:
   `sudo tailscale serve --https=443 off` and
   `sudo tailscale serve --https=8443 off`.

4. **[USER ACTION]** Check from a device on the tailnet (the first request
   may take a few seconds while the certificate is issued):

   ```sh
   curl -i https://<box>.<tailnet>.ts.net/health
   # 200 {"status":"ok","service":"core",...}   (no "inbox": the Core sees the box, not loopback)
   curl -i https://<box>.<tailnet>.ts.net:8443/health
   # 200 {"status":"ok","service":"wake-svc","version":"0.1.0"}
   ```

   While the PC is off the first answers `502` (the box is up, the Core is
   not); the app then shows "Çekirdeğe ulaşılamıyor" with the wake button.

5. **[USER ACTION]** In the phone: Core address
   `wss://<box>.<tailnet>.ts.net/ws` (connect screen), wake away address
   `https://<box>.<tailnet>.ts.net:8443` (**Adresler**).

### Home addresses (no Tailscale at home)

The app tries a **home** address first (Core: `/health` with a 1.5 s
timeout; wake: first `POST`) and falls back to the away address above
(T21.3.3). Plain `ws://` / `http://` is accepted only to a private IPv4
address (10.0.0.0/8, 172.16.0.0/12, 192.168/16), never to a name.

1. **[USER ACTION]** Give the PC and the box fixed LAN addresses (DHCP
   reservation on the router), so the entered addresses stay valid.
2. **[USER ACTION]** The Core already listens on the LAN (step 2 above); allow
   inbound TCP 8700 in the Windows firewall from the phone's Wi-Fi subnet as
   well, not only from `<box-lan-ip>`. wake-svc listens on `<box-lan-ip>:8704`
   (section "Install").
3. **[USER ACTION]** In the phone, **Adresler**: Core home address
   `ws://<pc-lan-ip>:8700/ws`, wake home address `http://<box-lan-ip>:8704`.

On the home Wi-Fi this traffic (including the device token in `hello` and
the wake token) is not encrypted; anyone on that network can read it. Use it
only on a network you trust.

### Rotate the token

When the phone is lost, the token was shown somewhere it should not be, or
just from time to time:

```sh
sudo sh -c 'umask 077; python3 -I -c "import secrets; print(secrets.token_urlsafe(32))" > /etc/credstore/wake-svc.token.new && mv /etc/credstore/wake-svc.token.new /etc/credstore/wake-svc.token'
sudo systemctl restart wake-svc
```

The old token stops working with the restart (the service reads the token only
at start); the restart also clears the in-memory rate limits. Then enter the
new token in the phone (`sudo cat /etc/credstore/wake-svc.token`).

### Update or remove

- Update: copy the new `server.py` (step 2), install it (the second line of
  step 3), `sudo systemctl restart wake-svc`, then `rm -r ~/wake-svc-install`.
  If the unit changed, install it again and run `sudo systemctl daemon-reload`
  before the restart.
- Remove: `sudo systemctl disable --now wake-svc`, delete the four paths in
  the table above, `sudo systemctl daemon-reload`.

## 6. Troubleshooting

| Symptom | Check |
| --- | --- |
| `install-core-task.ps1`: "Access is denied" | Some managed PCs block per-user task creation. Run the installer once from an elevated PowerShell; the task still runs as you, not elevated. |
| Tray icon red, menu says "vazgeçildi" | `core.log`: a config error (e.g. no device tokens) makes the Core exit; after 20 quick failures the tray gives up. Fix the cause, then **Başlat** in the tray menu. |
| No tray icon after sign-in | Task last result in Task Scheduler; `ShadowTray.exe` missing (publish it) or the .NET 10 runtime missing. Start it by hand to see. While one (or `run-core.ps1`) is running, a second start shows "Shadow Tray zaten çalışıyor" and exits. |
| Tray icon blue, "Core dışarıda çalışıyor" | A Core the tray did not start answers on `CORE_PORT` (started by hand or `npm run dev`). The tray starts its own about 10 s after that one stops. |
| Tray menu: "Arayüz: port 8703 kullanılamıyor" | Another program uses the port: set `SHADOW_UI_PORT` in `.env`, then restart the tray app. |
| "Core derlenmemiş" in the tray menu, or `run-core.ps1 -DryRun` warns "Core is not built" | `npm ci` and `npm run build` in `core/`, then **Başlat**. |
| Core answers "not logged in" / auth errors | Sign in to Claude Code as the same Windows user (`claude` in a terminal), then restart the task. |
| A console window opens at sign-in | The task still runs the old `run-core.ps1` (Windows Terminal ignores `-WindowStyle Hidden`). Re-install the task (see "Switching from the earlier run-core.ps1 task"). |
| whisper-svc stays "starting" | First start downloads ~3 GB; see `docker compose logs whisper-svc`. GPU errors: check the CUDA test in Prerequisites. |
| `curl` from Git Bash to `/synthesize` returns 400 for Turkish text | Bash on Windows may re-encode command-line arguments. Send the JSON from a UTF-8 file: `curl --data-binary @body.json ...`. |
| Backup: "rclone remote 'gdrive' not found" | Step 1 of the backup setup, or set `SHADOW_BACKUP_DRIVE_REMOTE` / `SHADOW_BACKUP_RCLONE_CONFIG`. |
| Backup: "SHADOW_BACKUP_CRYPT_PASSWORD is not set" | Step 3. The scheduled task reads the repo-root `.env`; user environment variables only reach new processes after signing in again. |
| Restore: "could not be decrypted" warning | The two secrets differ from the ones used when the backup was made. |
| Drive OAuth token expired | `rclone config reconnect gdrive:` **[USER ACTION]** |
| wake-svc: `/health` answers on the box but times out from the PC | The box's firewall (section 5, step 7), or `WAKE_BIND` is not the address you are calling. |
| wake-svc does not start, journal: "cannot listen on ..." | `WAKE_BIND` is not an address of the box, or the port is in use (`ss -ltnp`). At boot the LAN address may come up late; the unit retries every 15 s. Give the box a fixed address (section 5, step 4). |
| wake-svc fails with `status=243/CREDENTIALS` | `/etc/credstore/wake-svc.token` is missing or not at the path in the unit's `LoadCredential=` (section 5, step 5). |
| wake-svc answers `202` but the PC stays off | Wake-on-LAN enabled in the PC's BIOS/UEFI and on the wired adapter, the wired MAC in `WAKE_MAC`, packet seen on the PC (docs/12, D3 checklist). |

## 7. Core on the Pi (in progress)

Design: [docs/13](13-pi-core-and-agents.md) K1 and section 7.1. The install
script `deploy/linux/install-core.sh` (T11.1) does the steps below; nothing in
this section has been run on the Pi yet. The PC Core (section 3) is unchanged.

| Path on the Pi | What | Owner, mode |
| --- | --- | --- |
| `/etc/systemd/system/shadow-core.service` | The unit (`deploy/linux/shadow-core.service`) | `root:root 0644` |
| `/etc/systemd/system/shadow-core.service.d/local.conf` | Machine-specific drop-in, written by the script: `User=`, the claude-login block (open, see "Claude login"), one `LoadCredential=` per device or agent token | `root:root 0644` |
| `/etc/shadow-assistant/core.env` | Settings, no secret (`deploy/linux/core.env.example`); created once, never overwritten | `root:root 0644` |
| `/etc/credstore/shadow-core.<VARIABLE>` | One secret per file: `HA_CORE_TOKEN`, `DEVICE_TOKEN_<NAME>`, later `CORE_AGENT_TOKEN` | `root:root 0600` (folder `0700`) |
| `/opt/shadow-assistant/core/releases/<version>/`, `current` | Core releases (repository layout, `core/dist/index.js`); `current` is a symlink to one of them | root, read-only for the service |
| `/var/lib/shadow-assistant/` | `StateDirectory`: `data/` (`SHADOW_DATA_DIR`), `vault/` (`SHADOW_VAULT_DIR`) | `<user>`, `0700` |
| `/usr/local/sbin/shadow-core-tls` | The TLS script (`deploy/linux/shadow-core-tls.sh`), see "HTTPS certificate" | `root:root 0755` |
| `/etc/systemd/system/shadow-core-tls-renew.{service,timer}` | Weekly renewal of the server certificate | `root:root 0644` |
| `/etc/shadow-assistant/tls/` | `ca.key` (CA key, never leaves the Pi), `ca.crt` (public, the file the PC imports), `core.crt` (server certificate); created by `shadow-core-tls init` | folder `root 0755`; `ca.key` `0600`, the certificates `0644` |
| `/etc/credstore/shadow-core.tls-key` | The server certificate's key (credential `tls-key`) | `root:root 0600` |

Placeholders below: `<user>` is the account on the Pi that owns (or will own)
the Claude login, `<pi>` the Pi's SSH address, `<release>` the release file.

### Install

1. **[USER ACTION]** On the Pi: Node.js 22 or newer at `/usr/bin/node` (the
   unit runs that path; `/usr/bin/node --version`) and systemd 247 or newer
   (`systemctl --version | head -1`). The script checks both and installs
   neither.

2. **[USER ACTION]** Build a release on the PC: the repository layout with a
   built Core and its production modules: `VERSION`, `services.yaml`,
   `router.yaml`, `pronunciations.yaml`, `core/package.json`, `core/dist/`,
   `core/prompts/`, `core/node_modules/` (`npm ci && npm run build`, then
   `npm prune --omit=dev` in `core/`; modules with native parts must be
   installed for the Pi's architecture). **No `.env`** in it: the Core would
   read it, and the script refuses such a release, as well as one with a
   symlink pointing outside it. Pack it as a `.tar.gz`
   (the release at the top or in one folder) or copy the folder. Downloading
   releases is T12; the script only installs a local one.

3. **[USER ACTION]** Copy the release and `deploy/linux/` (the script takes
   the unit and `core.env.example` from its own folder) to a private folder
   on the Pi (not `/tmp`):

   ```sh
   ssh <user>@<pi> "mkdir -p -m 0700 core-install"
   scp -r deploy/linux <release>.tar.gz <user>@<pi>:core-install/
   ```

4. **[USER ACTION]** On the Pi, look first, then install:

   ```sh
   sudo bash ~/core-install/linux/install-core.sh install --user <user> --release ~/core-install/<release>.tar.gz --dry-run
   sudo bash ~/core-install/linux/install-core.sh install --user <user> --release ~/core-install/<release>.tar.gz
   ```

   It copies the release to `/opt/shadow-assistant/core/releases/<VERSION>/`
   (root-owned, nobody else can write, no setuid bits), switches `current` to
   it atomically (old releases stay), installs the unit, creates `core.env`
   from the example if it does not exist (with `CORE_REHEARSAL=1`, T11.5),
   creates `/var/lib/shadow-assistant/{data,vault}` for `<user>`, writes
   `local.conf`, runs `systemctl daemon-reload` and `enable`. It does **not
   start** the Core (only with `--start`): the Claude login (T11.3) and the
   write-path decision ("Claude login" below) come first. It ends with the
   next steps and a prominent warning while the write path is undecided.

   A `core.env` that sets a secret (`DEVICE_TOKEN_*`, `HA_CORE_TOKEN`,
   `CORE_AGENT_TOKEN`) stops the script: move the value to the credstore
   (step 6) and delete the line.

5. **[USER ACTION]** Fill in every `<placeholder>` of `core.env`
   (`sudoedit /etc/shadow-assistant/core.env`). Leave `CORE_REHEARSAL=1`
   until the move (T23.2); the script never changes it, it only warns when it
   is not set.

6. **[USER ACTION]** Secrets, one at a time. The script asks twice without
   echo (or reads one line from a pipe), checks the name and the length the
   Core needs (printable ASCII without spaces; device token 16 to 1024
   characters, agent token 32 or more),
   writes `/etc/credstore/shadow-core.<NAME>` with mode `0600` from the start
   and adds the `LoadCredential=` line to `local.conf`:

   ```sh
   sudo bash ~/core-install/linux/install-core.sh set-secret HA_CORE_TOKEN
   sudo bash ~/core-install/linux/install-core.sh set-secret DEVICE_TOKEN_<NAME>
   ```

   A new random device token, generated on the Pi and piped in (read it once
   for the phone with `sudo cat /etc/credstore/shadow-core.DEVICE_TOKEN_<NAME>`):

   ```sh
   python3 -I -c "import secrets; print(secrets.token_urlsafe(32))" | sudo bash ~/core-install/linux/install-core.sh set-secret DEVICE_TOKEN_<NAME>
   ```

   An existing secret is changed only with `--replace`. Restart the Core
   after a change (`sudo systemctl restart shadow-core`).

7. **[USER ACTION]** The Claude login (T11.3) and the write path ("Claude
   login" below), then start and look:

   ```sh
   sudo systemctl start shadow-core
   systemctl status shadow-core --no-pager
   journalctl -u shadow-core -n 50
   rm -r ~/core-install
   ```

Running the script again is safe: an identical release, the unit and
`local.conf` are left as they are; `core.env` and existing secrets are never
overwritten. Options: `--dry-run` (print, change nothing), `--start` (start
or restart at the end), `--build <suffix>` (a second build of the same
`VERSION`, e.g. `--build 20261127`; without it a different build with the
same `VERSION` is refused), `--root <dir>` (install under a test folder,
skips `systemctl`; for testing the script only).

`local.conf` is rewritten on every run (`User=`, `LoadCredential=` lines)
except the block between `# BEGIN claude-login` and `# END claude-login`,
which is kept exactly as found. Every run also installs the TLS script and its
renewal units and enables the timer (`systemctl enable --now
shadow-core-tls-renew.timer`); the timer does nothing until the CA exists
("HTTPS certificate" below). Other local settings (limits measured in the
rehearsal, T11.5) go into `sudo systemctl edit shadow-core` (`override.conf`).

### Update or remove

- Update: copy the new release (step 3), run step 4 with it, then
  `sudo systemctl restart shadow-core` (or add `--start`). Back to an older
  release: run step 4 with that release again and restart.
- Remove: `sudo systemctl disable --now shadow-core`; delete
  `/etc/systemd/system/shadow-core.service`, the folder
  `/etc/systemd/system/shadow-core.service.d/`, `/opt/shadow-assistant/core/`,
  `/etc/shadow-assistant/core.env` and `/etc/credstore/shadow-core.*`; for
  the HTTPS listener also `sudo systemctl disable --now
  shadow-core-tls-renew.timer`, the two `shadow-core-tls-renew.*` units,
  `/usr/local/sbin/shadow-core-tls` and `/etc/shadow-assistant/tls/` (and
  remove the CA on the PC, "HTTPS certificate"); then
  `sudo systemctl daemon-reload`. `/var/lib/shadow-assistant/` holds the data
  folder and the vault clone: back it up or keep it.

### Listeners and the HTTPS listener (T11.6)

Design: [docs/13](13-pi-core-and-agents.md) section 4. All settings are
optional; without them the Core binds `CORE_HOST:CORE_PORT` only, as on the PC.

| Setting | Meaning |
| --- | --- |
| `CORE_EXTRA_HOSTS` | Further IP addresses of the plain listener on `CORE_PORT`, comma-separated. The Pi: `127.0.0.1` (Tailscale `serve`, the updater's health check) next to `CORE_HOST=<pi-lan-ip>`. No `0.0.0.0` / `::`, and `CORE_HOST` must then be a specific address too. |
| `CORE_TLS_HOST`, `CORE_TLS_PORT` | The TLS listener `https://<CORE_TLS_HOST>:<CORE_TLS_PORT>/`: the UI files, `/ws`, `GET /health`. An IP address, not `0.0.0.0` / `::`; with it, `CORE_HOST` must not be a wildcard either. |
| `CORE_TLS_CERT_FILE` | PEM certificate (chain) naming `CORE_TLS_HOST` (`subjectAltName IP:`). On the Pi: `/etc/shadow-assistant/tls/core.crt` (root, readable). |
| credential `tls-key` | The PEM private key: `LoadCredential=tls-key:/etc/credstore/shadow-core.tls-key` (also accepted as the ID `shadow-core.tls-key`). Read by the listener code, not as a variable (`credentials.ts` leaves IDs that are not variable names alone). |
| `CORE_TLS_KEY_FILE` | The key as a file path, for development and tests only; never together with the credential. |
| `CORE_UI_DIR` | The built UI; default `<release root>/ui/dist` (in the Core release package from T12.1). A relative path is taken from the release root. |

What the Core refuses at start (one `[shadow-core] fatal:` line, never key
material): a partial TLS setting (any of the TLS settings or the `tls-key`
credential without the others), a host that is not an IP address, a wildcard
address in the places above, the TLS port equal to `CORE_PORT` on the same
address, a missing, empty, unreadable or oversized (64 KiB) certificate or
key, an encrypted key, or a key that does not belong to the certificate. It
warns (and starts) when the certificate expires within 14 days or has
expired, is not yet valid, or does not name `CORE_TLS_HOST`, and when the UI
folder has no `index.html` (the listener then answers 404 for the UI but
`/ws` works).

On the TLS listener:

- Static files: GET/HEAD only (405 otherwise), `X-Content-Type-Options:
  nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`,
  `Content-Security-Policy: frame-ancestors 'none'`; no directory listing, no
  dot files, no unknown file types, no fallback page; `index.html` for `/`
  (revalidated on every load, assets cached for an hour), like the tray's
  `UiServer`. A path with `..`, `\`, `:` or NUL (also percent-encoded) is not
  served, and a file reached through a symlink must still lie in the UI
  folder.
- `/ws` accepts only an `Origin` equal to the listener's own origin
  (`https://<CORE_TLS_HOST>:<CORE_TLS_PORT>`, compared after normalising case
  and default port) or no `Origin` (non-browser clients); anything else gets
  `403` before the WebSocket handshake. Device tokens, sessions and shutdown
  are the same as on the plain listener.
- Not served: `POST /device/state` and (from T13) `/agent`, which stay on the
  plain listener.
- TLS 1.2 or newer.

A renewed certificate takes effect at the next Core start: the renewal
("HTTPS certificate" below) restarts the Core (`systemctl restart
shadow-core`); there is no reload of the TLS context while it runs.

Keep the TLS lines of `core.env` commented until the certificate exists
(next section). Not yet verified on the Pi or in a browser.

### HTTPS certificate (T11.6)

Design: [docs/13](13-pi-core-and-agents.md) section 4.3. A small CA on the Pi
signs the Core's server certificate; the PC trusts the CA once, so the yearly
renewal never touches the PC. `shadow-core-tls` (installed by
`install-core.sh`) does the Pi side:

| | CA (`ca.crt`) | Server certificate (`core.crt`) |
| --- | --- | --- |
| Key | EC P-256, `/etc/shadow-assistant/tls/ca.key` (root `0600`) | EC P-256, `/etc/credstore/shadow-core.tls-key` (root `0600`, credential `tls-key`); no other copy |
| Valid | 10 years | 1 year, renewed 30 days before expiry |
| Extensions | `basicConstraints` critical `CA:TRUE, pathlen:0`; `keyUsage` critical `keyCertSign, cRLSign`; `nameConstraints` critical, permitted `IP:<pi-lan-ip>/255.255.255.255` and `DNS:invalid` | `basicConstraints` `CA:FALSE`; `keyUsage` `digitalSignature`; `extendedKeyUsage` `serverAuth`; `subjectAltName` `IP:<pi-lan-ip>` only; random serial |

The name constraint limits the CA to the Pi's one address: IP names to that
address, DNS names to the reserved `.invalid` domain (RFC 6761), which never
resolves. An IP subtree alone does not limit DNS names, so without the second
entry a leaked CA key could vouch for any web site. IPv4 only; a LAN host name
is not supported (open question). The subject names are plain labels
(`Shadow Assistant local CA`, `Shadow Assistant Core`), not addresses.

**On the Pi** (after "Install" above):

1. **[USER ACTION]** Create the CA and the server certificate:

   ```sh
   sudo shadow-core-tls init --ip <pi-lan-ip>
   ```

   It prints the CA's SHA-1 hash (compare it on the PC below). Running it again
   changes nothing. An existing CA is never replaced, except with
   `--recreate-ca`, which prints a warning: every PC then has to import the
   new `ca.crt`.

2. **[USER ACTION]** Enable the listener in `core.env`
   (`sudoedit /etc/shadow-assistant/core.env`): uncomment `CORE_TLS_HOST=<pi-lan-ip>`
   (the same address), `CORE_TLS_PORT=<tls-port>` and
   `CORE_TLS_CERT_FILE=/etc/shadow-assistant/tls/core.crt` (the only path
   the script writes; it refuses to run while core.env names another).

3. **[USER ACTION]** Add the key's `LoadCredential=` line and restart:

   ```sh
   sudo bash ~/core-install/linux/install-core.sh install --user <user>
   sudo systemctl restart shadow-core
   journalctl -u shadow-core -n 50
   ```

   `install-core.sh` lists `LoadCredential=tls-key:/etc/credstore/shadow-core.tls-key`
   in `local.conf` only while `core.env` sets `CORE_TLS_HOST`: the Core
   refuses to start with the key but without the other TLS settings.

**On the PC, once per CA** (by the user; nothing is automated on Windows):

1. **[USER ACTION]** Copy the public CA certificate (never `ca.key`) and check
   it is the Pi's: the `Cert Hash(sha1)` line must hold the same hex digits
   as the SHA-1 printed by `init` (ignore colons and case; on the Pi again:
   `openssl x509 -in /etc/shadow-assistant/tls/ca.crt -noout -fingerprint
   -sha1`):

   ```powershell
   scp <user>@<pi>:/etc/shadow-assistant/tls/ca.crt .
   certutil -dump ca.crt
   ```

2. **[USER ACTION]** Import it into the current user's "Trusted Root
   Certification Authorities" (Windows asks for confirmation; no
   administrator rights needed). Edge and Chrome use this store:

   ```powershell
   certutil -user -addstore Root ca.crt
   ```

3. **[USER ACTION]** Verify: open `https://<pi-lan-ip>:<tls-port>/` in Edge
   or Chrome; the page loads without a certificate warning. The CA is listed
   by `certutil -user -store Root "Shadow Assistant local CA"`.

4. Remove (when the CA is replaced, or to stop trusting it): find its serial
   number with the `-store` command above, then

   ```powershell
   certutil -user -delstore Root <serial>
   ```

   The serial rather than the name: a recreated CA has the same name.

Repeat the PC steps only when the CA is recreated: after 10 years, or when the
Pi's address changes (`sudo shadow-core-tls init --ip <new-address>
--recreate-ca`, with `CORE_TLS_HOST` changed to the new address first; then
remove the old CA on the PC and import the new one).

**Renewal.** `shadow-core-tls-renew.timer` runs `shadow-core-tls renew`
weekly (`Persistent=true`: a run missed while the Pi was off follows the next
boot; up to 6 hours random delay). It issues a new server certificate when the
current one expires within 30 days, names another address than
`CORE_TLS_HOST`, does not verify against the CA, or its key in the credstore
is missing or does not match; otherwise it exits without changing anything.
After a new certificate it restarts `shadow-core` if the Core is running and
`core.env` enables the TLS listener. The address comes from `CORE_TLS_HOST`
in `core.env` (one setting; while that line is commented, the CA's own
address). The service runs as root with a read-only file system except
`/etc/shadow-assistant/tls` and `/etc/credstore`, without network and without
capabilities.

```sh
systemctl list-timers shadow-core-tls-renew.timer
sudo systemctl start shadow-core-tls-renew       # run it now
journalctl -u shadow-core-tls-renew -n 20
sudo shadow-core-tls renew --force               # new certificate now
```

A failed renewal leaves the unit failed (`systemctl --failed`,
`journalctl -u shadow-core-tls-renew`); the Core itself warns in its journal
14 days before the certificate expires. Typical causes: `CORE_TLS_HOST`
changed to an address the CA is not constrained to (recreate the CA, see
above), or the CA expires within a year (recreate it). No phone or Core
notification about an expiring certificate yet (open).

**Backup.** The CA key is not in the backup (docs/13 section 7.6). Losing it
means a new CA (`init --ip <pi-lan-ip> --recreate-ca`) and a new import on
the PC.

**Turning the listener off:** comment the TLS lines of `core.env`, run
`install-core.sh install --user <user>` again (it drops the `tls-key` line)
and restart the Core.

Not yet verified on the Pi or on the PC: the commands above, the renewal unit
under systemd (its sandbox and `systemctl restart` from it), and that Edge
and Chrome accept a user-imported root with this name constraint and a
certificate that names only an IP address.

### Secrets

The Core reads them from systemd's `$CREDENTIALS_DIRECTORY`
(`core/src/credentials.ts`), only when systemd sets that variable:

- The credential ID is the variable name (`LoadCredential=HA_CORE_TOKEN:/etc/credstore/shadow-core.HA_CORE_TOKEN`);
  an ID starting with `shadow-core.` has the prefix removed (the IDs
  `ImportCredential=shadow-core.*` would give, systemd 254 or newer).
- One trailing newline is removed. An empty file, a second line, a file over
  4096 bytes or an unreadable file stops the Core at start (the message names
  the credential, never its value).
- A variable set in `core.env` (or the environment) **and** as a credential
  stops the Core at start: one source per secret.
- IDs that are not upper-case variable names (a TLS key, a deploy key) are
  left to their own readers; the Core logs their names once. The script lists
  only `tls-key` among them in `local.conf` (while `core.env` sets
  `CORE_TLS_HOST`, see "HTTPS certificate").
- Secret values never enter the process environment; the Claude CLI and its
  tools also do not get `CREDENTIALS_DIRECTORY`.

The unit uses `LoadCredential=` (systemd 247 or newer), not
`ImportCredential=` (254 or newer; Raspberry Pi OS bookworm ships 252). So a
new device token needs a file **and** a `LoadCredential=` line in
`local.conf` (`set-secret` adds both), then a restart. `HA_CORE_TOKEN` has its
line in the unit itself; the unit does not start while that file is missing
(`status=243/CREDENTIALS`). Not yet verified on the Pi.

By hand, without the script (`read -rs` does not echo; `printf` is a shell
builtin, so the value never appears on a command line):

```sh
sudo install -d -m 0700 -o root -g root /etc/credstore
read -rs TOKEN && printf '%s' "$TOKEN" | sudo sh -c 'umask 077; cat > /etc/credstore/shadow-core.HA_CORE_TOKEN'; unset TOKEN
sudo ls -l /etc/credstore/shadow-core.HA_CORE_TOKEN      # -rw------- root root
```

A device token added by hand also needs its `LoadCredential=` line: run
`install-core.sh install --user <user>` again (without `--release`), which
regenerates `local.conf` from the files in `/etc/credstore`.

### Claude login

The unit runs as the account that owns the Claude login (T9.1): the CLI
rewrites its login files when it refreshes the token, so they cannot live in
the credstore. `ProtectHome=read-only` keeps the home read-only except the
paths `local.conf` makes writable. **Open (user decision):** which paths.
Listing only `<home>/.claude` and `<home>/.claude.json` probably breaks the
token refresh: if the CLI replaces `.claude.json` through a temporary file and
`rename()`, the temporary file cannot be created in the read-only home, and
`rename()` over a single bind-mounted file fails (`EBUSY`). Options: the whole
home writable (simple, but a compromised Core could then change the account's
shell start files), the Claude configuration moved into one writable folder
(`CLAUDE_CONFIG_DIR`, which changes where the T9.1 login lives), or a
dedicated account without sudo.

Until it is decided, the script writes a commented placeholder into the
claude-login block of `local.conf`, with the line
`# CLAUDE-LOGIN-WRITE-PATH: UNDECIDED`, and warns at the end of every
install. Once decided: put the lines into that block, delete the UNDECIDED
line, `sudo systemctl daemon-reload` and restart; the script keeps the block
from then on.

Without `local.conf` the unit refuses to start (`status=217/USER`: its
placeholder account does not exist), so it never runs as root.
