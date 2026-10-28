# Shadow Assistant tray app

`ShadowTray.exe` (C#, .NET 10, WinForms) runs the Core in your Windows session
and shows its state in the notification area. The `\ShadowAssistant\Shadow
Assistant Core` scheduled task starts it at sign-in
(`..\install-core-task.ps1`). Full guide: [docs/05-deploy.md](../../../docs/05-deploy.md).

## What it does

- Starts `node core\dist\index.js` **directly** from the repo root: no
  PowerShell or cmd.exe in between and no console window (so neither Windows
  Terminal nor antivirus behaviour rules for `powershell → node` get involved).
- Supervises it like `run-core.ps1` did: after a crash, restart with backoff
  (5 s doubling to 5 min, reset after 10 min of uptime), give up after 20
  short runs in a row; no restart after a clean exit (code 0).
- Writes the Core's stdout/stderr and its own `[tray]` lines to
  `%LOCALAPPDATA%\ShadowAssistant\logs\core.log`, rotated at 10 MB, keeping 5
  old files (`core.1.log` ... `core.5.log`), same names as `run-core.ps1`.
- One instance per sign-in session: a second start exits at once. The named
  mutex (`Local\ShadowAssistantCoreRunner`) is the same one `run-core.ps1`
  uses, so the tray and the script never both run a Core.
- The Core runs inside a Windows job object with *kill on close*: if the tray
  app ends for any reason (crash, Task Manager, sign-out), the Core and its
  child processes end with it.

## Icon and menu

| Colour | Meaning |
| --- | --- |
| green | Core running, its `/health` answers and every enabled service is `ok` |
| yellow | Core running but `/health` not answering yet, or an enabled service is `down` / `loading` / `unknown`; or the Core is waiting to be restarted / stopping |
| red | Core stopped, given up after repeated crashes, or cannot start (see the menu) |

The tooltip has a one-line summary. Menu (right click):

- status lines: Core, then every service the Core reports (home-assistant,
  shadow-vault, whisper-svc, tts-svc). Service health comes from the Core's
  `GET /health` (polled every 5 s while the Core runs); the Core itself checks
  the services (T8.4). While the Core is not running they read "bilinmiyor".
- **Arayüzü aç** (also double click): opens the web UI. Nothing else serves
  `ui\dist`, and the UI does not work from `file://` (module scripts, and the
  microphone needs a secure context), so the tray serves `ui\dist` itself at
  `http://localhost:8703/` (Kestrel, loopback only, static files, GET/HEAD,
  Host header limited to loopback names). Port: `SHADOW_UI_PORT`. Build the
  UI first (`npm run build` in `ui\`); after rebuilding, files are served
  fresh, but a missing `ui\dist` is only noticed at tray start.
- **Yeniden başlat / Durdur / Başlat**: the Core. Başlat during a restart
  wait restarts now; after "gave up" it starts over with fresh counters.
- **Konuşma servisleri (Docker)**: `docker compose --env-file ..\.env up -d`
  / `down` in `deploy\` (docker.exe started directly; output goes to
  `core.log`). Disabled when docker.exe is not found (PATH, else Docker
  Desktop's default folder).
- **Logları aç**: the log folder (`core.log`, `backup.log`).
- **Çıkış**: stops the Core cleanly, then exits.

### Clean stop

The Core shuts down gracefully on SIGINT (closes the WebSocket server and
sessions, flushes the usage log, exits 0). On Windows a SIGINT is a Ctrl+C
console event. The tray does not raise it itself: it starts its own exe once
more as a short-lived helper (`ShadowTray.exe --send-ctrl-c <pid>`, no
window) that attaches to the Core's (window-less) console, ignores Ctrl+C
itself, raises it there and exits. That way a late event can never reach
the tray, and the tray never has to change its own Ctrl+C handling (which
the next Core would inherit). If the helper fails, or the Core has not
exited after 10 s (5 s at sign-out / shutdown) the tray kills the job, i.e.
the Core and everything it started. SIGTERM cannot be delivered on Windows.

## Settings

Each value: command-line argument, else environment variable, else default.

| Argument | Environment | Default |
| --- | --- | --- |
| `--repo-root <dir>` | `SHADOW_REPO_ROOT` | first folder above the exe that has `core\` and `services.yaml` |
| `--node-path <exe>` | `SHADOW_NODE_PATH` | `node.exe` from PATH |
| `--log-dir <dir>` | `SHADOW_CORE_LOG_DIR` | `%LOCALAPPDATA%\ShadowAssistant\logs` |

The installer writes the resolved repo root and node path into the task's
arguments. The Core address is read like the Core reads it: `CORE_HOST` /
`CORE_PORT` from the environment, else the repo-root `.env` (or
`SHADOW_ENV_FILE`), else `127.0.0.1:8700`; a wildcard bind address
(`0.0.0.0`, `::`) means loopback. `SHADOW_UI_PORT` (default 8703) the same way.

## Build and test

Needs the .NET 10 SDK to build; running needs the .NET 10 Desktop Runtime and
ASP.NET Core Runtime (both come with the SDK). From this folder:

```powershell
dotnet build ShadowTray.slnx
dotnet test ShadowTray.slnx
dotnet publish src\ShadowTray\ShadowTray.csproj -c Release -o publish
```

`publish\ShadowTray.exe` is the default the installer uses. The tray app locks
its files while running: stop it (menu → Çıkış, or `Stop-ScheduledTask`)
before publishing again.

If `dotnet` on PATH is a runtime-only install without the SDK, call the SDK's
`dotnet.exe` by its full path.

Layout: `src\ShadowTray\` (the app; supervisor, backoff, log rotation, status
logic and settings are plain classes without WinForms), `tests\ShadowTray.Tests\`
(xUnit).
