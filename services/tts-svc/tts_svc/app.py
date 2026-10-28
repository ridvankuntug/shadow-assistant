"""HTTP API (shared contract §3):

- ``GET /health``      -> 200 ok + voice info (``voices`` = loaded, ``available`` = selectable)
  | 503 ``{"status":"loading"}`` (or ``"error"``)
- ``POST /synthesize`` -> JSON ``{"text": "...", "voice": "<optional id>"}`` -> 200 ``audio/wav``;
  400 empty text / bad body / unknown voice, 413 text > 2000 chars, 503 while loading.

A voice that is available but not loaded yet is downloaded (if needed) and
loaded on the first request that selects it, in a background thread, one voice
at a time. The request waits up to ``TTS_VOICE_LOAD_WAIT_S`` for it and then
answers 503 ``voice_loading``; the load keeps going, so a later request
succeeds. A failed load answers 503 ``voice_unavailable`` and is not retried
for ``VOICE_RETRY_AFTER_S`` (no download loop on a broken network).
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from . import SERVICE_NAME, __version__
from .config import MAX_TEXT_CHARS, Settings
from .engine import Engine, PiperEngine
from .voices import available_voice_ids

_LOGGER = logging.getLogger(__name__)

EngineLoader = Callable[[Settings], Engine]

# After a failed on-demand load, requests for that voice fail fast for this long.
VOICE_RETRY_AFTER_S = 60.0


class SynthesizeRequest(BaseModel):
    text: str
    voice: Optional[str] = None


class _State:
    """Loading status shared between the loader thread and request handlers."""

    def __init__(self) -> None:
        self.status = "loading"  # loading | ok | error
        self.engine: Optional[Engine] = None
        self.error: Optional[str] = None


class _VoiceLoader:
    """Loads available-but-not-loaded voices in background threads, one at a time.

    Concurrent requests for the same voice share one load (one ``Event``);
    loads of different voices queue on ``_serial`` so two ~63 MB downloads and
    model loads never run in parallel.
    """

    def __init__(self, retry_after_s: float = VOICE_RETRY_AFTER_S) -> None:
        self._guard = threading.Lock()  # protects _pending and _errors
        self._serial = threading.Lock()  # one download/load at a time
        self._pending: dict[str, threading.Event] = {}
        self._errors: dict[str, tuple[str, float]] = {}
        self._retry_after_s = retry_after_s

    def recent_error(self, voice_id: str) -> Optional[str]:
        """The last load error of ``voice_id`` if it failed less than ``retry_after_s`` ago."""
        with self._guard:
            entry = self._errors.get(voice_id)
        if entry is None or time.monotonic() - entry[1] >= self._retry_after_s:
            return None
        return entry[0]

    def request(self, engine: Engine, voice_id: str) -> threading.Event:
        """Start loading ``voice_id`` unless already in progress; the event is set when the attempt ends."""
        with self._guard:
            done = self._pending.get(voice_id)
            if done is None:
                done = threading.Event()
                self._pending[voice_id] = done
                threading.Thread(
                    target=self._run, args=(engine, voice_id, done), name=f"tts-voice-load-{voice_id}", daemon=True
                ).start()
            return done

    def _run(self, engine: Engine, voice_id: str, done: threading.Event) -> None:
        error: Optional[str] = None
        try:
            with self._serial:
                started = time.perf_counter()
                engine.load_voice(voice_id)
                _LOGGER.info("Voice %s ready on demand in %.1f s", voice_id, time.perf_counter() - started)
        except Exception as exc:
            _LOGGER.exception("Loading voice %s on demand failed", voice_id)
            error = f"{type(exc).__name__}: {exc}"
        finally:
            with self._guard:
                self._pending.pop(voice_id, None)
                if error is None:
                    self._errors.pop(voice_id, None)
                else:
                    self._errors[voice_id] = (error, time.monotonic())
            done.set()


def _error(status_code: int, code: str, detail: str, **extra: object) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": code, "detail": detail, **extra})


def create_app(settings: Settings, engine_loader: EngineLoader = PiperEngine.load) -> FastAPI:
    state = _State()
    loader = _VoiceLoader()

    def _available(engine: Engine) -> list[str]:
        return available_voice_ids(settings.voice_dir, allow_download=settings.auto_download, loaded=engine.voices)

    def _load() -> None:
        started = time.perf_counter()
        try:
            engine = engine_loader(settings)
        except Exception as exc:  # surfaced via /health; the process keeps running
            _LOGGER.exception("Loading voices failed")
            state.error = f"{type(exc).__name__}: {exc}"
            state.status = "error"
            return
        state.engine = engine
        state.status = "ok"
        _LOGGER.info("tts-svc ready in %.1f s (voices: %s)", time.perf_counter() - started, ", ".join(engine.voices))

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        # Load in the background so /health can answer 503 "loading" meanwhile
        # (first start may download ~63 MB per voice).
        threading.Thread(target=_load, name="tts-voice-loader", daemon=True).start()
        yield

    app = FastAPI(title=SERVICE_NAME, version=__version__, lifespan=lifespan)
    app.state.tts = state

    @app.exception_handler(RequestValidationError)
    async def _bad_request(_: Request, exc: RequestValidationError) -> JSONResponse:
        # Contract: malformed input is a 400, not FastAPI's default 422.
        return _error(400, "bad_request", "body must be JSON {\"text\": string, \"voice\"?: string}",
                      errors=jsonable_errors(exc))

    def _not_ready() -> JSONResponse:
        if state.status == "error":
            return JSONResponse(status_code=503, content={"status": "error", "detail": state.error})
        return JSONResponse(status_code=503, content={"status": "loading"})

    @app.get("/health")
    async def health() -> JSONResponse:  # async: never queued behind synthesis worker threads
        engine = state.engine
        if state.status != "ok" or engine is None:
            return _not_ready()
        return JSONResponse(
            content={
                "status": "ok",
                "service": SERVICE_NAME,
                "version": __version__,
                "voice": engine.default_voice,
                "voices": engine.voices,  # loaded now
                "available": _available(engine),  # selectable via "voice" (loaded + downloadable/local)
                "sample_rate": engine.sample_rate(engine.default_voice),
                "device": "cpu",
            }
        )

    def _ensure_loaded(engine: Engine, voice: str) -> Optional[JSONResponse]:
        """Load an available voice on demand (blocking up to the wait limit); None once it is loaded."""
        available = _available(engine)
        if voice not in available:
            return _error(400, "unknown_voice", f"voice {voice!r} is not available",
                          voices=engine.voices, available=available)
        failed = loader.recent_error(voice)
        if failed is not None:
            return _error(503, "voice_unavailable", f"loading voice {voice!r} failed: {failed}", voice=voice)
        done = loader.request(engine, voice)
        if not done.wait(settings.voice_load_wait_s):
            return _error(503, "voice_loading", f"voice {voice!r} is being downloaded/loaded; retry shortly",
                          status="loading", voice=voice)
        if voice not in engine.voices:
            failed = loader.recent_error(voice) or "unknown error"
            return _error(503, "voice_unavailable", f"loading voice {voice!r} failed: {failed}", voice=voice)
        return None

    # Plain ``def``: FastAPI runs it in a worker thread, so CPU-bound synthesis
    # never blocks the event loop (and /health stays responsive).
    @app.post("/synthesize", response_model=None)
    def synthesize(req: SynthesizeRequest) -> Response:
        if not req.text.strip():
            return _error(400, "empty_text", "text must not be empty")
        if len(req.text) > MAX_TEXT_CHARS:
            return _error(413, "text_too_long", f"text exceeds {MAX_TEXT_CHARS} characters")
        engine = state.engine
        if state.status != "ok" or engine is None:
            return _not_ready()
        voice = req.voice or engine.default_voice
        if voice not in engine.voices:
            unavailable = _ensure_loaded(engine, voice)
            if unavailable is not None:
                return unavailable
        started = time.perf_counter()
        try:
            wav = engine.synthesize(req.text, voice)
        except Exception:
            _LOGGER.exception("Synthesis failed (voice=%s, chars=%d)", voice, len(req.text))
            return _error(500, "synthesis_failed", "synthesis failed")
        elapsed_ms = round((time.perf_counter() - started) * 1000)
        return Response(
            content=wav,
            media_type="audio/wav",
            headers={"X-Voice": voice, "X-Processing-Ms": str(elapsed_ms)},
        )

    return app


def jsonable_errors(exc: RequestValidationError) -> list[dict[str, object]]:
    """Validation errors without the raw input echo (keeps responses small)."""
    return [{"loc": list(e.get("loc", ())), "msg": e.get("msg", "")} for e in exc.errors()]
