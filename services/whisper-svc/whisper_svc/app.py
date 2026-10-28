"""HTTP API (shared contract §3, whisper-svc).

GET  /health      -> 200 {"status":"ok","service","version","model","device","compute_type"}
                     200 {"status":"idle", same fields} model unloaded after WHISPER_IDLE_UNLOAD_MIN
                         without requests, or being reloaded by a request
                     503 {"status":"loading"} while the model loads at startup
                     503 {"status":"error","error":"..."} if loading failed
POST /transcribe  -> raw audio body or multipart/form-data field ``file``; query ``language`` (default tr)
                     200 {"text","language","duration_ms","processing_ms"}
                     400 undecodable / empty audio, bad multipart, unsupported language
                     413 body > 25 MB
                     503 model not ready
A request that arrives while the model is unloaded ("idle") reloads it and waits.
"""

from __future__ import annotations

import logging
import threading
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Query, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException, MultiPartParser

from . import SERVICE_NAME, __version__
from .config import Settings
from .lifecycle import ModelLifecycle, ModelUnavailable
from .transcriber import (
    AudioDecodeError,
    Transcriber,
    UnsupportedLanguageError,
    WhisperTranscriber,
)

log = logging.getLogger("whisper_svc")


class PayloadTooLarge(Exception):
    pass


def _error(status: int, code: str, detail: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": code, "detail": detail})


async def _read_body_capped(request: Request, limit: int) -> bytes:
    """Read the request body, failing fast once it exceeds ``limit`` bytes."""
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > limit:
        raise PayloadTooLarge()
    buf = bytearray()
    async for chunk in request.stream():
        buf.extend(chunk)
        if len(buf) > limit:
            raise PayloadTooLarge()
    return bytes(buf)


async def _audio_from_multipart(request: Request, body: bytes) -> bytes:
    async def _stream() -> AsyncIterator[bytes]:
        yield body

    parser = MultiPartParser(request.headers, _stream(), max_files=1, max_fields=16)
    try:
        form = await parser.parse()
    except MultiPartException as exc:
        raise AudioDecodeError(f"invalid multipart body: {exc.message}") from exc
    try:
        upload = form.get("file")
        if not isinstance(upload, UploadFile):
            raise AudioDecodeError("multipart body must contain a file field named 'file'")
        return await upload.read()
    finally:
        await form.close()


def create_app(
    settings: Settings | None = None,
    transcriber: Transcriber | None = None,
    load_in_background: bool = True,
) -> FastAPI:
    settings = settings or Settings.from_env()
    transcriber = transcriber or WhisperTranscriber(settings)
    lifecycle = ModelLifecycle(transcriber, settings.idle_unload_seconds)

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        if load_in_background:
            # Load in a thread so /health can answer 503 "loading" meanwhile.
            threading.Thread(target=lifecycle.initial_load, name="whisper-load", daemon=True).start()
        else:
            lifecycle.initial_load()
        lifecycle.start_timer()
        try:
            yield
        finally:
            lifecycle.stop_timer()

    app = FastAPI(title=SERVICE_NAME, version=__version__, lifespan=lifespan)
    app.state.lifecycle = lifecycle

    def _not_ready() -> JSONResponse:
        if lifecycle.status == "error":
            return JSONResponse(status_code=503, content={"status": "error", "error": lifecycle.error})
        return JSONResponse(status_code=503, content={"status": "loading"})

    @app.get("/health")
    async def health():
        status = lifecycle.status
        if status not in ("ok", "idle"):
            return _not_ready()
        # "idle" (unloaded or reloading) is still healthy: the next request reloads the model.
        return {"status": status, "service": SERVICE_NAME, "version": __version__, **transcriber.info()}

    def _transcribe_sync(audio: bytes, lang: str):
        lifecycle.begin()  # may reload the model after an idle unload (blocks meanwhile)
        try:
            return transcriber.transcribe(audio, lang)
        finally:
            lifecycle.end()

    @app.post(
        "/transcribe",
        openapi_extra={
            "requestBody": {
                "required": True,
                "content": {
                    "audio/*": {"schema": {"type": "string", "format": "binary"}},
                    "multipart/form-data": {
                        "schema": {
                            "type": "object",
                            "properties": {"file": {"type": "string", "format": "binary"}},
                            "required": ["file"],
                        }
                    },
                },
            }
        },
    )
    async def transcribe(request: Request, language: str = Query("tr")):
        started = time.perf_counter()
        if not lifecycle.can_serve():
            return _not_ready()

        lang = language.strip().lower()
        try:
            if not lang:
                raise UnsupportedLanguageError("language must not be empty")
            transcriber.validate_language(lang)
        except UnsupportedLanguageError as exc:
            return _error(400, "bad_language", str(exc))

        try:
            body = await _read_body_capped(request, settings.max_upload_bytes)
        except PayloadTooLarge:
            return _error(413, "too_large", f"body exceeds {settings.max_upload_bytes} bytes")

        content_type = request.headers.get("content-type", "").lower()
        try:
            if content_type.startswith("multipart/form-data"):
                audio = await _audio_from_multipart(request, body)
            else:
                audio = body
            if not audio:
                raise AudioDecodeError("empty audio")
            result = await run_in_threadpool(_transcribe_sync, audio, lang)
        except ModelUnavailable:
            return _not_ready()
        except UnsupportedLanguageError as exc:
            return _error(400, "bad_language", str(exc))
        except AudioDecodeError as exc:
            return _error(400, "bad_audio", str(exc))

        processing_ms = round((time.perf_counter() - started) * 1000)
        # Transcripts are user speech: log sizes/timings only, never the text.
        log.info(
            "transcribed %d bytes, audio=%d ms, processing=%d ms",
            len(audio),
            result.duration_ms,
            processing_ms,
        )
        return {
            "text": result.text,
            "language": result.language,
            "duration_ms": result.duration_ms,
            "processing_ms": processing_ms,
        }

    return app
