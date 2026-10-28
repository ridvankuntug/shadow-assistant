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
| Core | Scheduled task at sign-in, your user, not elevated | `deploy/windows/` |
| Backup | Script (optionally a daily scheduled task), your user | `deploy/backup/` |

## 1. Prerequisites

- Windows 10 1803+ / Windows 11 (`tar.exe` and Task Scheduler are built in).
- Node.js 22+ (`node --version`).
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

## 3. Core as a scheduled task

### Why a task in your own session

The Core uses the Claude Agent SDK, which signs in with the Claude Code login
stored in your Windows profile. A Windows service, SYSTEM or another account
would not see that login (and would need an API key instead). So the task
runs as **you**, in your interactive session, started when you sign in, with
normal (not elevated) rights. The consequence: the Core runs only while you
are signed in. Locking the screen is fine; signing out stops it.

### What runs

The task starts `deploy/windows/run-core.ps1`, a small supervisor that:

- runs `node core/dist/index.js` from the repo root (the Core reads `.env`,
  `services.yaml`, `router.yaml` there);
- restarts the Core after a crash with exponential backoff (5 s doubling to
  5 min; the delay resets after 10 min of uptime) and gives up after 20 short
  runs in a row, so a broken setup does not loop forever;
- does not restart after a clean exit (code 0);
- writes the Core's output to `%LOCALAPPDATA%\ShadowAssistant\logs\core.log`,
  rotated at 10 MB, keeping 5 old files (`core.1.log` ...);
- allows only one instance per session.

The task itself has no time limit, ignores a second start while running, and
has Task Scheduler's own "restart on failure" (3 times, every 5 min) as a
second line of defence for when the supervisor itself fails.

Paths are not hard-coded: the repo root defaults to two folders above the
script, `node` comes from PATH. Override with parameters or the environment
variables `SHADOW_REPO_ROOT`, `SHADOW_NODE_PATH`, `SHADOW_CORE_LOG_DIR`. The
installer writes the resolved paths into the task, so the task does not depend
on those variables later.

### Install

From `deploy/windows/` in a normal (non-admin) PowerShell:

```powershell
.\run-core.ps1 -DryRun               # checks node, core\dist and .env, starts nothing
.\install-core-task.ps1 -WhatIf      # shows the task that would be registered
.\install-core-task.ps1 -StartNow    # [USER ACTION] registers \ShadowAssistant\Shadow Assistant Core and starts it
```

If the scripts are blocked by the execution policy, run them with
`powershell -ExecutionPolicy Bypass -File .\install-core-task.ps1 ...`. The task
itself runs PowerShell with `-ExecutionPolicy Bypass` for that one process only.

Options: `-NodePath`, `-RepoRoot`, `-LogDir`, `-LogonDelaySeconds` (default 30),
`-Force` (replace an existing task). Re-run with `-Force` after moving the repo
or changing Node.js.

Check it: `Get-ScheduledTask -TaskPath \ShadowAssistant\` and
`Get-Content $env:LOCALAPPDATA\ShadowAssistant\logs\core.log -Tail 50 -Wait`.

### Uninstall

```powershell
.\uninstall-core-task.ps1 -WhatIf
.\uninstall-core-task.ps1            # [USER ACTION] stops and removes the task, and stops a leftover Core process
```

Logs are kept; delete `%LOCALAPPDATA%\ShadowAssistant\logs` by hand if wanted.

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
| Core not reachable; task "Ready" with last result 1 | `core.log`: a config error (e.g. no device tokens) makes the Core exit; after 20 quick failures the supervisor gives up. Fix the cause, then `Start-ScheduledTask -TaskPath \ShadowAssistant\ -TaskName 'Shadow Assistant Core'`. |
| `run-core.ps1 -DryRun` warns "Core is not built" | `npm ci` and `npm run build` in `core/`. |
| Core answers "not logged in" / auth errors | Sign in to Claude Code as the same Windows user (`claude` in a terminal), then restart the task. |
| A console window flashes at sign-in | Expected: Task Scheduler opens PowerShell before `-WindowStyle Hidden` takes effect. |
| whisper-svc stays "starting" | First start downloads ~3 GB; see `docker compose logs whisper-svc`. GPU errors: check the CUDA test in Prerequisites. |
| `curl` from Git Bash to `/synthesize` returns 400 for Turkish text | Bash on Windows may re-encode command-line arguments. Send the JSON from a UTF-8 file: `curl --data-binary @body.json ...`. |
| Backup: "rclone remote 'gdrive' not found" | Step 1 of the backup setup, or set `SHADOW_BACKUP_DRIVE_REMOTE` / `SHADOW_BACKUP_RCLONE_CONFIG`. |
| Backup: "SHADOW_BACKUP_CRYPT_PASSWORD is not set" | Step 3. The scheduled task reads the repo-root `.env`; user environment variables only reach new processes after signing in again. |
| Restore: "could not be decrypted" warning | The two secrets differ from the ones used when the backup was made. |
| Drive OAuth token expired | `rclone config reconnect gdrive:` **[USER ACTION]** |
