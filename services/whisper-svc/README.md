# whisper-svc

Turkish speech-to-text HTTP service for Shadow Assistant, built on
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) (CTranslate2) with the
`large-v3` model on an NVIDIA GPU. Only the Core calls it (`WHISPER_SVC_URL`,
default `http://127.0.0.1:8701`).

Model files are downloaded at runtime into the Hugging Face cache and are **never
committed** to this repository.

## Recommended setup: Docker (GPU)

Requirements: NVIDIA driver with CUDA 12 support; on Windows, Docker Desktop with the
WSL2 backend (GPU support is built in); on Linux, the NVIDIA Container Toolkit.

```sh
docker build -t shadow-whisper-svc services/whisper-svc
docker run -d --name whisper-svc --gpus all \
    -p 127.0.0.1:8701:8701 \
    -v whisper-models:/models \
    shadow-whisper-svc
```

- The first start downloads the model (~2.9 GiB) into the `whisper-models` volume;
  later starts are offline-capable (add `-e HF_HUB_OFFLINE=1` to forbid network access).
- Keep the model in a **named Docker volume**, not a bind mount of a Windows folder:
  loading 3 GB through the Windows file share made the service ready in 27–31 s
  instead of 8 s (see measurements).
- To reuse a model that is already in a host Hugging Face cache, copy it into the volume once:

  ```sh
  docker run --rm -v <host HF cache>/hub:/src:ro -v whisper-models:/models \
      --entrypoint sh shadow-whisper-svc -c "mkdir -p /models/hub && cp -r /src/models--Systran--faster-whisper-large-v3 /models/hub/"
  ```
- Behind a TLS-intercepting proxy, pass an extra CA bundle at build time:
  `docker build --secret id=ca,src=<ca.pem> ...`.
- Inside the container the service listens on `0.0.0.0`; publish the port on the host's
  loopback only (`-p 127.0.0.1:8701:8701`).
- The container has a `HEALTHCHECK` on `/health` (start period 300 s for the first download).

## Alternative: local Python (Windows/Linux)

Python 3.10+.

```sh
cd services/whisper-svc
python -m venv .venv
.venv/Scripts/activate            # Linux: source .venv/bin/activate
pip install -r requirements.txt -r requirements-cuda.txt
python -m whisper_svc
```

`requirements-cuda.txt` installs cuBLAS and cuDNN 9 as pip wheels, so no system-wide
CUDA Toolkit/cuDNN is needed; on Windows the service adds their DLL folders itself.
On Linux the wheels' libraries are not on the loader path; export it before starting
(or use system-wide CUDA 12 + cuDNN 9):

```sh
export LD_LIBRARY_PATH=$(python -c 'import os, nvidia.cublas.lib, nvidia.cudnn.lib; print(os.path.dirname(nvidia.cublas.lib.__file__) + ":" + os.path.dirname(nvidia.cudnn.lib.__file__))')
```

The model goes to the user's Hugging Face cache (`~/.cache/huggingface/hub`, override
with `HF_HOME`).

Tested versions: Python 3.11 (local) / 3.10 (Docker), faster-whisper 1.2.1,
ctranslate2 4.8.4, fastapi 0.162, uvicorn 0.54, python-multipart 0.0.32;
Docker base image `nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04`.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Bind address |
| `PORT` | `8701` | Port |
| `WHISPER_MODEL` | `large-v3` | faster-whisper model name or local model path |
| `WHISPER_DEVICE` | `cuda` | `cuda` or `cpu` |
| `WHISPER_COMPUTE_TYPE` | `float16` | CTranslate2 compute type; `int8_float16` saves ~2 GB VRAM |
| `WHISPER_BEAM_SIZE` | `1` | Beam size (>= 1) |
| `WHISPER_VAD` | `1` | Silero VAD filter (`1/0`, `true/false`, `yes/no`, `on/off`) |
| `WHISPER_IDLE_UNLOAD_MIN` | `10` | Unload the model from the GPU after this many whole minutes without transcription requests; the next request reloads it. `0` = never unload (see "Idle unload") |
| `HF_HOME` | HF default (`/models` in Docker) | Hugging Face cache root |
| `HF_HUB_OFFLINE` | unset | `1` = never contact the Hub (model must be cached) |

## API

### `GET /health`

- `200 {"status":"ok","service":"whisper-svc","version":"0.1.0","model":"large-v3","device":"cuda","compute_type":"float16"}`
- `200 {"status":"idle", ...same fields as "ok"}` while the model is unloaded after
  `WHISPER_IDLE_UNLOAD_MIN` minutes without requests, **and** while a request is reloading
  it. The service is healthy: the next `/transcribe` reloads the model and waits for it.
- `503 {"status":"loading"}` while the model loads **at startup** (the HTTP server is up immediately).
- `503 {"status":"error","error":"..."}` if loading failed (e.g. no GPU, model not cached while offline).
  After a failed startup load this is final (restart the service); after a failed reload
  following an idle unload, the next `/transcribe` tries to load again.

Clients should treat any `200` (`ok` or `idle`) as "up".

### `POST /transcribe?language=tr`

Body: the raw audio bytes (`Content-Type: audio/webm`, `audio/ogg`, `audio/wav`,
`audio/mpeg`, `audio/mp4`, …; anything FFmpeg/PyAV decodes), **or**
`multipart/form-data` with the audio in the field `file`.
`language` is a Whisper language code, default `tr` (case-insensitive).

```sh
curl -s -X POST --data-binary @clip.webm -H "Content-Type: audio/webm" http://127.0.0.1:8701/transcribe
curl -s -F file=@clip.webm "http://127.0.0.1:8701/transcribe?language=tr"
```

| Status | Body |
|---|---|
| 200 | `{"text":"Oturma odası ışığını kapat.","language":"tr","duration_ms":2020,"processing_ms":478}` |
| 400 | `{"error":"bad_audio","detail":...}` undecodable/empty audio or bad multipart; `{"error":"bad_language",...}` unknown language |
| 413 | `{"error":"too_large",...}` body > 25 MB (checked while streaming, also without `Content-Length`) |
| 503 | model not ready: startup load still running or a load failed (same body as `/health`) |

`duration_ms` is the decoded audio length; `processing_ms` is server time for the
request. `text` can be empty (silence only). Requests are processed one at a time
on the GPU (single-user push-to-talk; avoids out-of-memory on 8 GB cards).
Transcripts are not logged.

## Idle unload

To give the GPU back to other applications (games, other models), the service unloads
the model after `WHISPER_IDLE_UNLOAD_MIN` minutes (default 10) without `/transcribe`
requests and reloads it on the next request; that request waits for the reload, so the
first command after a quiet period is slower by the model load time (~3-4 s for `small`
from a bind mount in the measurement below; for `large-v3` expect roughly the
"Ready" times in "Measurements", i.e. ~5-8 s from a named volume with the files in the
OS page cache). `/health` keeps answering `200 {"status":"idle"}` throughout. An unload
never happens while a request is running; requests arriving during a reload queue
behind it (one reload, not several). `WHISPER_IDLE_UNLOAD_MIN=0` keeps the model loaded
forever (lowest latency, GPU memory permanently in use).

Unloading drops the faster-whisper model (CTranslate2 `unload_model()` + releasing the
last reference + `gc.collect()`). That destroys CTranslate2's worker threads and with them
their per-thread CUDA caching allocator and cuBLAS/cuDNN handles, so the weights *and*
the cached work memory go back to the driver. Only the process's CUDA context remains.

Measured in Docker (WSL2, RTX 3060 Ti) with the `small` model, `float16`,
`WHISPER_IDLE_UNLOAD_MIN=1`, a second whisper-svc instance on the same GPU. Windows does
not report per-process VRAM for WSL containers, so values are whole-GPU `nvidia-smi`
(median of 7 samples) minus the baseline taken before the test container started:

| Point | GPU used vs. baseline |
|---|---|
| Container started, model loaded + 1 transcription | +756 MiB |
| After idle unload | +58 MiB |
| After reload + 1 transcription | +689 MiB |
| After second idle unload | +93 MiB |
| After second reload + 1 transcription | +802 MiB |
| Container stopped | +11 MiB (noise) |

So ~90 % of the service's VRAM is released; the remaining ~60-90 MiB is the CUDA context,
which only goes away when the process exits (desktop noise is about +/-30 MiB). The
weights' share is larger for `large-v3` (~3.9 GB loaded), so the relative saving is
bigger there.

## Measurements

Setup: RTX 3060 Ti (8 GB, ~2.6 GB already used by the desktop), `large-v3`,
14 short **synthetic** Turkish commands (Piper TTS; 0.6–2.3 s; wav, plus webm/ogg/m4a
variants of two clips), each sent once as warm-up and then 7 times
(`scripts/bench.py`, keep-alive HTTP client). Latency = client-side end-to-end per
request; "ready" = process/container start until `/health` returns 200 (includes model
load and one warm-up inference); VRAM = whole-GPU usage while loaded.

| Path | compute_type | beam | VAD | Ready | Median | p90 | VRAM (GPU total) | Exact matches |
|---|---|---|---|---|---|---|---|---|
| Local (Windows venv) | float16 | 1 | off | 10.0 s | 549 ms | 633 ms | 6.7 GB | 12/14 |
| Local | float16 | 1 | on | 8.3 s | 530 ms | 596 ms | 6.6 GB | 12/14 |
| Local | float16 | 5 | off | 9.6 s | 603 ms | 694 ms | 6.6 GB | 11/14 |
| Local | float16 | 5 | on | 8.1 s | 606 ms | 691 ms | 6.6 GB | 11/14 |
| Local | int8_float16 | 1 | off | 13.6 s | 613 ms | 703 ms | 4.7 GB | 11/14 |
| Local | int8_float16 | 5 | off | 13.6 s | 663 ms | 781 ms | 4.7 GB | 11/14 |
| Docker, model on Windows bind mount | float16 | 1 | off | 28.7 s | 486 ms | 579 ms | 6.5 GB | 12/14 |
| Docker, model on Windows bind mount | float16 | 1 | on | 27.0 s | 485 ms | 573 ms | 6.5 GB | 12/14 |
| Docker, model on Windows bind mount | int8_float16 | 1 | off | 30.9 s | 490 ms | 576 ms | 4.7 GB | 11/14 |
| **Docker, named volume** | **float16** | **1** | **on** | **8.1 s** | **475 ms** | **562 ms** | **6.5 GB** | **12/14** |

The service itself uses ~3.9 GB VRAM with `float16` and ~2.0 GB with `int8_float16`.
The two "misses" in every row are number formatting, not recognition errors
("yüzde elli" → "%50", "yirmi iki" → "22"); the extra miss for beam 5 / int8 is
"Evet." → "Evlat" on the m4a variant.

**Chosen defaults: Docker, `float16`, beam 1, VAD on.** All configurations are far
below the 1.5 s target for short commands; beam 1 is ~10 % faster than beam 5 with no
accuracy gain on short commands; VAD costs nothing measurable and removes silence on
which Whisper hallucinates text (2 s of silence or low noise came back as
"Altyazı M.K." without VAD and as `""` with VAD). `int8_float16` is the fallback when VRAM is
tight (saves ~2 GB, similar latency in Docker, slightly slower load). Docker matched or
beat the local Windows run and fits the planned docker-compose deployment.

Caveat: the clips are synthetic TTS speech; real microphone audio (noise, accents,
far-field) will be less accurate and should be re-measured.

Run the benchmark against a running service:

```sh
python scripts/bench.py --clips <dir with clips and optional expected.json> --reps 7 --wait-ready 600
```

## Download sizes

| Item | Size |
|---|---|
| Model `Systran/faster-whisper-large-v3` (HF cache `hub/models--Systran--faster-whisper-large-v3`) | 2.9 GiB (`model.bin` 3.09 GB) |
| Local only: CUDA pip wheels (`nvidia-cublas-cu12`, `nvidia-cudnn-cu12`, `nvidia-cuda-nvrtc-cu12`, Windows) | ~1.3 GB download, ~2.0 GB installed |
| Local: other Python dependencies | ~0.1 GB |
| Docker image (incl. CUDA/cuDNN runtime base) | 2.3 GB download/content, 6.2 GB on disk |

## Tests

```sh
pip install -r requirements-dev.txt
pytest
```

The tests replace the model with a fake (no GPU, no download); two tests use the real
PyAV decoder.
