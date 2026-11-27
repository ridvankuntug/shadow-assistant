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
script (T11.1) will do the steps below; until then this section only lists
what the unit expects. The PC Core (section 3) is unchanged.

| Path on the Pi | What | Owner, mode |
| --- | --- | --- |
| `/etc/systemd/system/shadow-core.service` | The unit (`deploy/linux/shadow-core.service`) | `root:root 0644` |
| `/etc/systemd/system/shadow-core.service.d/local.conf` | Machine-specific drop-in: `User=`, the two writable Claude login paths, one `LoadCredential=` per device token (template in the unit's header) | `root:root 0644` |
| `/etc/shadow-assistant/core.env` | Settings, no secret (`deploy/linux/core.env.example`) | `root:root 0644` |
| `/etc/credstore/shadow-core.<VARIABLE>` | One secret per file: `HA_CORE_TOKEN`, `DEVICE_TOKEN_<NAME>`, later `CORE_AGENT_TOKEN` | `root:root 0600` (folder `0700`) |
| `/opt/shadow-assistant/core/current/` | Core release (repository layout, `core/dist/index.js`) | root, read-only for the service |
| `/var/lib/shadow-assistant/` | `StateDirectory`: `data/` (`SHADOW_DATA_DIR`), `vault/` (`SHADOW_VAULT_DIR`) | `<user>`, `0700` |

**Secrets.** The Core reads them from systemd's `$CREDENTIALS_DIRECTORY`
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
  left to their own readers; the Core logs their names once.
- Secret values never enter the process environment; the Claude CLI and its
  tools also do not get `CREDENTIALS_DIRECTORY`.

The unit uses `LoadCredential=` (systemd 247 or newer), not
`ImportCredential=` (254 or newer; Raspberry Pi OS bookworm ships 252). So a
new device token needs a file **and** a `LoadCredential=` line in `local.conf`,
then `sudo systemctl daemon-reload` and a restart. Not yet verified on the Pi.

**Create a credential file without the token in the shell history or on a
command line** (`read -rs` does not echo; `printf` is a shell builtin):

```sh
sudo install -d -m 0700 -o root -g root /etc/credstore
read -rs TOKEN && printf '%s' "$TOKEN" | sudo sh -c 'umask 077; cat > /etc/credstore/shadow-core.HA_CORE_TOKEN'; unset TOKEN
sudo ls -l /etc/credstore/shadow-core.HA_CORE_TOKEN      # -rw------- root root
```

`systemd-ask-password -n "HA token:" | sudo sh -c 'umask 077; cat > …'` works
the same way. A new random device token, generated on the Pi:

```sh
sudo sh -c 'umask 077; python3 -I -c "import secrets; print(secrets.token_urlsafe(32))" > /etc/credstore/shadow-core.DEVICE_TOKEN_<NAME>'
```

**Claude login.** The unit runs as the account that owns the Claude login
(T9.1): the CLI rewrites its login files when it refreshes the token, so they
cannot live in the credstore. `ProtectHome=read-only` keeps the home read-only
except the paths `local.conf` lists in `ReadWritePaths=` (`<home>/.claude`,
`<home>/.claude.json`). Not yet verified on the Pi: that the CLI can refresh
its login with only these two paths writable (if it replaces `.claude.json`
through a temporary file in the home folder, it cannot).

Without `local.conf` the unit refuses to start (`status=217/USER`: its
placeholder account does not exist), so it never runs as root.
