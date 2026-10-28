# deploy

Files for running Shadow Assistant at home on Windows. Full guide:
[docs/05-deploy.md](../docs/05-deploy.md).

| Path | What |
| --- | --- |
| `docker-compose.yml` | whisper-svc (GPU) and tts-svc, ports on 127.0.0.1, model/voice caches in named volumes |
| `windows/tray/` | Tray app (C#/.NET): runs and supervises the Core without a console window, status icon and menu ([README](windows/tray/README.md)) |
| `windows/install-core-task.ps1`, `uninstall-core-task.ps1` | Scheduled task that starts the tray app at sign-in in your own session (`-WhatIf` supported) |
| `windows/run-core.ps1` | Manual fallback supervisor in PowerShell (`-DryRun` to check); no longer used by the task |
| `backup/backup-data.ps1`, `restore-data.ps1` | Encrypted backup of the data folder to Google Drive via rclone crypt, and restore |
| `backup/install-backup-task.ps1` | Optional daily backup task |

The Core is not containerised: the Claude Agent SDK uses the Claude Code login
in the user's Windows profile.

Configuration comes from the root `.env` file (copy `.env.example`); never put
real tokens, passwords, hostnames or IP addresses in files tracked by git.
