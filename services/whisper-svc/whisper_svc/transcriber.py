"""faster-whisper wrapper: audio decoding, model loading and serialized GPU inference."""

from __future__ import annotations

import gc
import io
import logging
import os
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from .config import Settings

log = logging.getLogger("whisper_svc")

SAMPLE_RATE = 16_000


class AudioDecodeError(ValueError):
    """The request body could not be decoded as audio (maps to HTTP 400)."""


class UnsupportedLanguageError(ValueError):
    """The requested language code is not supported by Whisper (maps to HTTP 400)."""


@dataclass(frozen=True)
class TranscriptionResult:
    text: str
    language: str
    duration_ms: int


class Transcriber(Protocol):
    """What the HTTP layer needs. Tests provide a fake implementation."""

    def info(self) -> dict: ...

    def load(self) -> None: ...

    def unload(self) -> None: ...

    def validate_language(self, language: str) -> None: ...

    def transcribe(self, audio: bytes, language: str) -> TranscriptionResult: ...


def add_nvidia_dll_dirs() -> list[str]:
    """Windows only: make CUDA/cuDNN DLLs from the ``nvidia-*-cu12`` pip wheels loadable.

    CTranslate2 loads cuBLAS/cuDNN lazily by DLL name. The pip wheels put those DLLs
    under ``site-packages/nvidia/<lib>/bin``, which is not on the DLL search path, so
    we add each such directory both via ``os.add_dll_directory`` and to ``PATH``
    (CTranslate2 does not always use the add_dll_directory search mode).
    No-op on other platforms or when the wheels are not installed.
    """
    if sys.platform != "win32":
        return []
    try:
        import nvidia  # namespace package provided by the nvidia-*-cu12 wheels
    except ImportError:
        return []
    added: list[str] = []
    for root in list(getattr(nvidia, "__path__", [])):
        for bin_dir in sorted(Path(root).glob("*/bin")):
            path = str(bin_dir)
            os.add_dll_directory(path)
            added.append(path)
    if added:
        os.environ["PATH"] = os.pathsep.join(added + [os.environ.get("PATH", "")])
    return added


def decode_audio(data: bytes):
    """Decode any container/codec PyAV (FFmpeg) understands to 16 kHz mono float32."""
    from faster_whisper.audio import decode_audio as fw_decode

    try:
        samples = fw_decode(io.BytesIO(data), sampling_rate=SAMPLE_RATE)
    except Exception as exc:  # PyAV raises a family of av.error.* exceptions
        raise AudioDecodeError(f"could not decode audio: {type(exc).__name__}") from exc
    if samples.size == 0:
        raise AudioDecodeError("audio contains no samples")
    return samples


class WhisperTranscriber:
    """Owns one faster-whisper model. Inference is serialized with a lock.

    CTranslate2 can run concurrent requests on one GPU, but on an 8 GB card that
    risks out-of-memory and gives no throughput win for single-user push-to-talk,
    so requests queue on ``_lock`` instead. Decoding (CPU) happens outside the lock.
    """

    def __init__(self, settings: Settings):
        self._settings = settings
        self._model = None
        self._lock = threading.Lock()
        self._languages: frozenset[str] = frozenset()
        self._dll_dirs_added = False

    def info(self) -> dict:
        return {
            "model": self._settings.model,
            "device": self._settings.device,
            "compute_type": self._settings.compute_type,
        }

    def load(self) -> None:
        if not self._dll_dirs_added:  # once per process: a reload must not grow PATH again
            dirs = add_nvidia_dll_dirs()
            if dirs:
                log.info("added %d NVIDIA DLL directories", len(dirs))
            self._dll_dirs_added = True
        from faster_whisper import WhisperModel
        from faster_whisper.tokenizer import _LANGUAGE_CODES

        # Release any model still held (e.g. a previous load whose cleanup failed)
        # before building a new one: two models on an 8 GB card means OOM.
        self.unload()
        s = self._settings
        log.info("loading model=%s device=%s compute_type=%s", s.model, s.device, s.compute_type)
        self._model = WhisperModel(s.model, device=s.device, compute_type=s.compute_type)
        self._languages = frozenset(_LANGUAGE_CODES)
        try:
            self._warmup()
        except BaseException:
            # A failed warm-up (typically CUDA OOM) must not leave the half-loaded model
            # holding GPU memory, or every retry would OOM as well.
            try:
                self.unload()
            except Exception:
                log.warning("releasing model after failed warm-up failed", exc_info=True)
            raise

    def unload(self) -> None:
        """Free the model's GPU memory. ``load()`` brings it back.

        Steps, each needed for the memory to actually go back to the driver:

        1. Detach the model under the inference lock (never mid-inference).
        2. ``unload_model()`` on the CTranslate2 model frees the weights on the device
           right away, even if a stray reference to the Python object survives.
        3. Drop the last reference (+ ``gc.collect()`` for reference cycles inside
           faster-whisper): the CTranslate2 model is destroyed and its worker threads
           exit. CTranslate2's CUDA caching allocator and cuBLAS/cuDNN handles are
           per worker thread, so they are released only now.

        What stays is the process's CUDA context (driver-owned; it cannot be released
        without ending the process) - see README "Idle unload" for measured numbers.
        The supported-language set is kept so language validation works while idle.
        """
        with self._lock:
            model, self._model = self._model, None
        if model is None:
            return
        try:
            model.model.unload_model()
        except Exception:  # still drop the reference below
            log.warning("ctranslate2 unload_model() failed", exc_info=True)
        del model
        gc.collect()

    def _warmup(self) -> None:
        """Run one inference so CUDA kernels/cuBLAS handles are initialised before traffic."""
        import numpy as np

        rng = np.random.default_rng(0)
        noise = (rng.standard_normal(SAMPLE_RATE) * 0.01).astype("float32")
        with self._lock:
            segments, _ = self._model.transcribe(
                noise, language="tr", beam_size=self._settings.beam_size, vad_filter=False
            )
            list(segments)

    def validate_language(self, language: str) -> None:
        if self._languages and language not in self._languages:
            raise UnsupportedLanguageError(f"unsupported language code: {language!r}")

    def transcribe(self, audio: bytes, language: str) -> TranscriptionResult:
        if self._model is None:
            raise RuntimeError("model not loaded")
        self.validate_language(language)
        samples = decode_audio(audio)
        duration_ms = round(samples.size * 1000 / SAMPLE_RATE)
        with self._lock:
            segments, info = self._model.transcribe(
                samples,
                language=language,
                beam_size=self._settings.beam_size,
                vad_filter=self._settings.vad_filter,
                # Push-to-talk utterances are short and independent: no prompt carry-over.
                condition_on_previous_text=False,
            )
            # `segments` is a lazy generator; inference actually runs while iterating,
            # so it must be consumed inside the lock.
            text = " ".join(seg.text.strip() for seg in segments).strip()
        return TranscriptionResult(text=text, language=info.language, duration_ms=duration_ms)
