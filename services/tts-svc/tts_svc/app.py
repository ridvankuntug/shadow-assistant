"""HTTP API (shared contract §3):

- ``GET /health``      -> 200 ok + voice info | 503 ``{"status":"loading"}`` (or ``"error"``)
- ``POST /synthesize`` -> JSON ``{"text": "...", "voice": "<optional id>"}`` -> 200 ``audio/wav``;
  400 empty text / bad body / unknown voice, 413 text > 2000 chars, 503 while loading.
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

_LOGGER = logging.getLogger(__name__)

EngineLoader = Callable[[Settings], Engine]


class SynthesizeRequest(BaseModel):
    text: str
    voice: Optional[str] = None


class _State:
    """Loading status shared between the loader thread and request handlers."""

    def __init__(self) -> None:
        self.status = "loading"  # loading | ok | error
        self.engine: Optional[Engine] = None
        self.error: Optional[str] = None


def _error(status_code: int, code: str, detail: str, **extra: object) -> JSONResponse:
    return JSONResponse(status_code=status_code, content={"error": code, "detail": detail, **extra})


def create_app(settings: Settings, engine_loader: EngineLoader = PiperEngine.load) -> FastAPI:
    state = _State()

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
                "voices": engine.voices,
                "sample_rate": engine.sample_rate(engine.default_voice),
                "device": "cpu",
            }
        )

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
            return _error(400, "unknown_voice", f"voice {voice!r} is not loaded", voices=engine.voices)
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
