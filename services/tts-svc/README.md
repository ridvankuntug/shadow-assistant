# tts-svc

Turkish text-to-speech HTTP service for Shadow Assistant, built on
[Piper](https://github.com/OHF-Voice/piper1-gpl) (local, offline, CPU only).
Only the Core calls it (URL via `TTS_SVC_URL`, default `http://127.0.0.1:8702`).

## API

| Method | Path | Request | Response |
|---|---|---|---|
| `GET` | `/health` | – | `200 {"status":"ok","service":"tts-svc","version":"0.1.0","voice":"tr_TR-dfki-medium","voices":[...],"available":[...],"sample_rate":22050,"device":"cpu"}`<br>`voices` = loaded now; `available` = selectable via `voice` (loaded first, then known voices that can be downloaded, then other complete voices in `TTS_VOICE_DIR`)<br>`503 {"status":"loading"}` while the voice loads (first start also downloads it)<br>`503 {"status":"error","detail":"..."}` if loading failed (see the log) |
| `POST` | `/synthesize` | JSON `{"text":"...","voice":"<optional voice id>"}` | `200 audio/wav` (16-bit PCM, mono, 22.05 kHz for the bundled voices) |

`/synthesize` errors (JSON `{"error":"<code>","detail":"..."}`):

| Status | `error` | When |
|---|---|---|
| 400 | `empty_text` | `text` is empty or whitespace only |
| 400 | `bad_request` | body is not JSON / `text` missing or not a string / `voice` not a string |
| 400 | `unknown_voice` | `voice` is not in `available` (response lists `voices` and `available`) |
| 413 | `text_too_long` | `text` longer than 2000 characters |
| 500 | `synthesis_failed` | engine error (details in the service log) |
| 503 | – | startup voices still loading (`{"status":"loading"}`) or failed to load |
| 503 | `voice_loading` | the selected voice is being downloaded/loaded on demand and did not finish within `TTS_VOICE_LOAD_WAIT_S`; the load continues, retry shortly (body also has `"status":"loading"`, `"voice"`) |
| 503 | `voice_unavailable` | loading the selected voice failed (download/hash/model error, see the log); retried no sooner than 60 s later |

Omitted, `null` or empty `voice` uses the default voice. Text that produces no
speech (e.g. only punctuation) returns a valid, zero-length WAV. Responses carry
`X-Voice` and `X-Processing-Ms` headers. There is no auth: bind to loopback only.

Requests are processed one at a time (a lock around synthesis); concurrent
requests are safe and queue up. Synthesis is ~20x faster than real time on CPU,
so a 2000-character text (~2 min of audio) takes ~5 s.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` | bind address (the Docker image sets `0.0.0.0`; publish as `127.0.0.1:8702:8702`) |
| `PORT` | `8702` | port |
| `TTS_VOICE` | `tr_TR-dfki-medium` | default voice, loaded at startup |
| `TTS_VOICES` | – | optional comma-separated extra voices to load at startup (selectable via `voice`) |
| `TTS_VOICE_DIR` | `services/tts-svc/voices` (git-ignored) | where voice files are stored / downloaded |
| `TTS_AUTO_DOWNLOAD` | `1` | download a missing known voice (at startup or on demand); `0` = only voices already in `TTS_VOICE_DIR` |
| `TTS_VOICE_LOAD_WAIT_S` | `20` | how long `/synthesize` waits for an on-demand voice load before answering 503 `voice_loading` (0-600); keep it below the caller's timeout (the Core uses 30 s) |

The configured voices are loaded at startup (~3-5 s each). Any other voice in
`available` is loaded on demand: the first `/synthesize` that selects it
downloads it if needed (~63 MB, SHA-256 verified) and loads it in a background
thread, one voice at a time; concurrent requests for the same voice share that
load. A voice already on disk is ready within a few seconds (first request
succeeds); a download usually takes longer than the wait limit, so the first
request gets 503 `voice_loading` and a later one succeeds. Loaded voices stay
in memory (roughly the model size plus runtime overhead each) until the service restarts; `/health` stays 200
for the default voice throughout.

## Voices

Voice files (`<id>.onnx` + `<id>.onnx.json`) are downloaded at runtime, never
committed. Downloads are pinned to a repository commit and verified against a
pinned SHA-256 (`tts_svc/voices.py`); a mismatch aborts. Each voice is ~63 MB.

| Voice id | Source | Model license (MODEL_CARD) |
|---|---|---|
| `tr_TR-dfki-medium` (default) | official `rhasspy/piper-voices` | **CC BY-NC-SA 4.0** (non-commercial) |
| `tr_TR-fahrettin-medium` | third-party mirror `csukuangfj/vits-piper-tr_TR-fahrettin-medium` | CC0 |
| `tr_TR-fettah-medium` | third-party mirror `csukuangfj/vits-piper-tr_TR-fettah-medium` | CC0 |

All three are selectable per request (`voice`) and through the Core's `voices`
frame; see [THIRD_PARTY_NOTICES.md](../../THIRD_PARTY_NOTICES.md) for the exact
source URLs and licenses. Checked 2026-10-28: `rhasspy/piper-voices` contains
only `tr/tr_TR/dfki/medium` for Turkish.

Why `dfki` is the default: it is the only Turkish voice published in the official
Piper voice repository, so its provenance is verifiable. The other two are
listed in Piper's voice list but are only available from a third-party mirror,
whose MODEL_CARD states a CC0 dataset (NabuCasa voice-datasets). All three have
the same architecture (VITS, medium) and the same speed, so the choice is about
sound and license: listen to them and switch with `TTS_VOICE` if you prefer
another. Any other Piper voice works too: put its two files into `TTS_VOICE_DIR`.

```bash
python -m tts_svc.voices --list                     # known voices, size, license
python -m tts_svc.voices                            # pre-download TTS_VOICE (+ TTS_VOICES)
python -m tts_svc.voices tr_TR-fahrettin-medium     # download a specific voice
python -m tts_svc.voices --verify                   # re-check local files against the pinned hashes
```

## Run locally (venv)

From `services/tts-svc`:

```bash
python -m venv .venv
# Windows: .venv\Scripts\activate    Linux/macOS: source .venv/bin/activate
pip install -r requirements.txt -r requirements-dev.txt
python -m tts_svc                  # downloads the default voice on first start
python scripts/smoke.py            # in a second shell: end-to-end check with the real voice
```

If the repository lives in a synced folder (OneDrive etc.), point
`TTS_VOICE_DIR` somewhere outside it to avoid syncing ~63 MB per voice.

## Docker

```bash
docker build -t shadow-tts-svc services/tts-svc
docker run --rm -p 127.0.0.1:8702:8702 -v tts-voices:/voices shadow-tts-svc
```

The image (~500 MB, `python:3.11-slim`) does not contain a voice; it is
downloaded into the `/voices` volume on first start. Behind a TLS-intercepting
proxy pass a CA bundle at build time: `docker build --secret id=ca,src=ca.pem ...`.

## Tests

```bash
pytest                                            # unit tests, engine mocked: no piper/voice needed
python scripts/smoke.py --url http://127.0.0.1:8702 --out ./out   # opt-in, needs a running service
```

## Measurements

CPU only (Windows 11, Python 3.11, piper-tts 1.8.0, onnxruntime 1.31), four
Turkish sentences of 28-84 characters, warm model. RTF = synthesis time /
audio length (lower is faster).

| Voice | Audio | Synthesis | RTF |
|---|---|---|---|
| `tr_TR-dfki-medium` | 15.0 s | 0.6-1.0 s | 0.04-0.07 |
| `tr_TR-fahrettin-medium` | 12.5 s | 0.6-0.8 s | 0.045-0.06 |
| `tr_TR-fettah-medium` | 14.7 s | 0.8 s | 0.05 |

A short reply (~30-80 characters) is ready in ~85-300 ms through HTTP. In the
Docker image (Linux, same host) RTF was ~0.05. Load time ~3-5 s per voice.

## License notes

- **This service's code** is MIT, like the rest of the repository.
- **piper-tts** (the Python package this service depends on, version 1.8.0 from
  `OHF-Voice/piper1-gpl`) is **GPL-3.0-or-later**. It is a runtime dependency
  installed by `pip`; it is not copied into this repository. Older MIT-licensed
  Piper releases (`rhasspy/piper`, piper-tts 1.2.0) are not a GPL-free option:
  they bundle **espeak-ng (GPL-3.0)** for phonemisation as well, and piper-tts
  1.2.0 has no Windows wheels.
- Consequence: running the service locally is fine. **Distributing** a built
  Docker image or a bundle that includes piper-tts/espeak-ng means distributing
  GPL-3.0 software, with GPL obligations for that bundle (MIT code may be
  combined with GPL code; the combined work is then under GPL terms).
- **Voice models** have their own licenses (table above). The default
  `tr_TR-dfki-medium` is CC BY-NC-SA 4.0: fine for personal, non-commercial
  use; not for commercial use. Audio is generated locally and not redistributed.
