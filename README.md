# Shadow Assistant

A personal voice and text assistant for the home.

Shadow Assistant is made of a central **Core** that talks to Claude (via the
Claude Agent SDK) and to Home Assistant (via MCP), a single **UI** that runs
both in the browser and inside an Android WebView, and small local speech
services for Turkish speech-to-text and text-to-speech.

> Status: early skeleton. Components are being built milestone by milestone
> (see [docs/](docs/)).

## Components

| Component | Stack | Role |
| --- | --- | --- |
| `core/` | Node.js + TypeScript, Claude Agent SDK | WebSocket API, router, permission gate, service registry, Home Assistant integration over MCP |
| `ui/` | React + Vite + TypeScript (Three.js later) | The one interface. The same bundle runs in the browser and in the Android WebView; platform-specific features (microphone, audio playback, TTS, vibration, notifications, token storage) sit behind a **platform adapter** |
| `services/whisper-svc/` | Python, faster-whisper | Turkish speech-to-text |
| `services/tts-svc/` | Piper | Text-to-speech |
| `android/` | Kotlin + WebView | Thin Android shell around the UI |

## Repository layout

```
shadow-assistant/
├── core/                  Node + TypeScript Core
├── ui/                    React + Vite UI
├── services/
│   ├── whisper-svc/       speech-to-text (planned)
│   └── tts-svc/           text-to-speech (planned)
├── android/               Android WebView shell (planned)
├── deploy/                docker-compose and deployment notes
├── docs/                  plans and documentation
├── .github/workflows/     CI (lint + build for core and ui)
├── .env.example           configuration template (placeholders only)
├── .pre-commit-config.yaml  gitleaks secret scanning hook
├── LICENSE
└── THIRD_PARTY_NOTICES.md
```

## Requirements

- Node.js 20.19+ (22 LTS or newer also works) and npm
- Python 3.11+ (for `pre-commit`, and later for `whisper-svc`)
- [gitleaks](https://github.com/gitleaks/gitleaks) and
  [pre-commit](https://pre-commit.com/) for secret scanning (see below)

## Getting started

`core/` and `ui/` are independent npm packages, each with its own
`package-lock.json`. Run the commands inside the package directory.

### Core

```sh
cd core
npm ci            # install exact locked dependencies
npm run dev       # run from source with auto-reload (tsx)
npm run lint      # ESLint (flat config + typescript-eslint)
npm run build     # compile to dist/ with tsc
npm start         # run the compiled build
```

### UI

```sh
cd ui
npm ci
npm run dev       # Vite dev server
npm run lint
npm run build     # type-check and build to dist/
```

## Configuration and secret hygiene

This repository is intended to be public. Real tokens, API keys, hostnames, IP
addresses and personal data must never be committed.

1. **Local configuration.** Copy the template and fill in real values locally:

   ```sh
   cp .env.example .env
   ```

   `.env` and `.env.*` are git-ignored; only `.env.example` (placeholders only)
   is tracked. Local-only files can also use the `*.local.*` naming pattern,
   which is ignored too.

2. **Pre-commit secret scanning.** Every commit is scanned with gitleaks via
   the `pre-commit` framework. The hook (`gitleaks-system`) uses the gitleaks
   binary on your `PATH`, so neither Go nor Docker is needed. Set it up once per
   clone:

   ```sh
   # 1. install pre-commit
   python -m pip install --user pre-commit

   # 2. install gitleaks (pick one)
   winget install --id Gitleaks.Gitleaks -e --source winget   # Windows
   scoop install gitleaks                                       # Windows (scoop)
   brew install gitleaks                                        # macOS / Linux
   # or download a release binary from https://github.com/gitleaks/gitleaks/releases

   # 3. enable the hook in this clone
   python -m pre_commit install

   # optional: scan the whole working tree
   python -m pre_commit run --all-files
   gitleaks dir .
   ```

   After installing gitleaks, open a new terminal so the updated `PATH` is
   picked up.

3. **On GitHub.** When the repository is published, GitHub **secret scanning**
   and **push protection** will be enabled as a second line of defence.

If a secret is ever committed, treat it as leaked: revoke and rotate it first,
then clean up history.

## License

Released under the [MIT License](LICENSE).

This project builds on third-party work; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for attributions (including
[Jarvis](https://github.com/adewaskar/jarvis), MIT).
