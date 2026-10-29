# 05 - Running Shadow Assistant at home

How to run the pieces on a Windows PC: the speech services in Docker, the Core
as a scheduled task in your own session, and an encrypted daily backup of the
Core's data folder to Google Drive.

Steps you have to do or approve yourself are marked **[USER ACTION]**. Nothing
in this repo registers tasks, creates rclone remotes or starts containers on
its own.

| Piece | Runs as | Files |
| --- | --- | --- |
| whisper-svc, tts-svc | Docker containers, ports on 127.0.0.1 only | `deploy/docker-compose.yml` |
| Core | Tray app started by a scheduled task at sign-in, your user, not elevated | `deploy/windows/` |
| Backup | Script (optionally a daily scheduled task), your user | `deploy/backup/` |

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

Tray menu → *Oyun modu* stops the whisper-svc container
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
- `SHADOW_PRONUNCIATIONS_FILE`: alternative pronunciation lexicon.

Data lives in `<SHADOW_DATA_DIR>`: `sessions/devices.json`, `memory/brief.md`,
`memory/notes/*.md`, `memory/index.json`, `memory/state.json`,
`memory/forget-pending.json`. All of it is inside the encrypted backup (section
4); nothing extra to configure.

View or delete memory in the UI (Ayarlar → Hafıza), or by voice/text: "neyi
hatırlıyorsun" lists it, "bunu unut" deletes an entry.

Redeploy: `npm run build` in `core/` (rebuilds `core/dist`), restart the Core
(tray → Yeniden başlat), then rebuild `ui`.

## 4. Backups

`deploy/backup/backup-data.ps1` packs the Core's data folder
(`SHADOW_DATA_DIR`, default `<SHADOW_VAULT_DIR>\.shadow-assistant`: conversation
logs and usage records) into
`shadow-assistant-data-YYYYMMDD-HHMMSS.tar.gz`, uploads it to an rclone
**crypt** remote on top of a Google Drive remote, and prunes:

- on Drive: archives older than 60 days (`SHADOW_BACKUP_REMOTE_DAYS`, 0 = keep all);
- locally (`%LOCALAPPDATA%\ShadowAssistant\backups`): all but the newest 3
  (`SHADOW_BACKUP_LOCAL_KEEP`).

File contents **and** file names are encrypted on Drive. The Drive remote uses
the `drive.file` scope, so rclone can only see files it created itself, not the
rest of your Drive. Log: `%LOCALAPPDATA%\ShadowAssistant\logs\backup.log`.

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

## 5. Troubleshooting

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
