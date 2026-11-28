# deploy

Files for running Shadow Assistant at home on Windows, plus the wake endpoint
on the always-on Linux box. Full guide:
[docs/05-deploy.md](../docs/05-deploy.md).

| Path | What |
| --- | --- |
| `docker-compose.yml` | whisper-svc (GPU) and tts-svc, ports on 127.0.0.1, model/voice caches in named volumes |
| `windows/tray/` | Tray app (C#/.NET): runs and supervises the Core without a console window, status icon and menu ([README](windows/tray/README.md)) |
| `windows/install-core-task.ps1`, `uninstall-core-task.ps1` | Scheduled task that starts the tray app at sign-in in your own session (`-WhatIf` supported) |
| `windows/run-core.ps1` | Manual fallback supervisor in PowerShell (`-DryRun` to check); no longer used by the task |
| `backup/backup-data.ps1`, `restore-data.ps1` | Encrypted backup of the data folder to Google Drive via rclone crypt, and restore; the data folder is resolved by the Core's rule ([docs/05 "Data folder"](../docs/05-deploy.md#data-folder)) |
| `backup/install-backup-task.ps1` | Optional daily backup task |
| `linux/wake-svc.service`, `linux/wake-svc.env.example` | Hardened systemd unit (`DynamicUser`, token via `LoadCredential=`) and settings template for wake-svc on the always-on Linux box; LAN only, never behind the tunnel ([docs/05 section 5](../docs/05-deploy.md#5-wake-endpoint-on-the-always-on-linux-box)) |
| `linux/install-core.sh`, `linux/shadow-core.service`, `linux/core.env.example` | Core on the Pi (in progress): install script (local release, unit, drop-in, secrets into the credstore; `--dry-run` supported), hardened systemd unit and settings template ([docs/05 section 7](../docs/05-deploy.md#7-core-on-the-pi-in-progress)) |
| `linux/shadow-core-tls.sh`, `linux/shadow-core-tls-renew.service`, `linux/shadow-core-tls-renew.timer` | HTTPS certificate for the Core's TLS listener: a local CA limited to the Pi's address and `shadow.lan`, the server certificate, and its timed renewal ([docs/05 "HTTPS certificate"](../docs/05-deploy.md#https-certificate-t116)) |
| `linux/shadow-core-update.sh`, `linux/shadow-core-update.service`, `linux/shadow-core-update.timer`, `linux/core-release.pub` | Automatic Core updates from signed GitHub releases (`core-v<X.Y>.<n>`): signature and checksum check, install, health check, rollback; the public key the signatures are checked against ([docs/05 "Automatic updates"](../docs/05-deploy.md#automatic-updates-t122)) |
| `linux/tests/` | Offline tests of the Linux scripts, run in a Debian container |

The Core is not containerised: the Claude Agent SDK uses the Claude Code login
of the account it runs as (the Windows profile on the PC; on the Pi the
unit's `CLAUDE_CONFIG_DIR`, see docs/05 "Claude login").

Configuration comes from the root `.env` file (copy `.env.example`); never put
real tokens, passwords, hostnames or IP addresses in files tracked by git.
