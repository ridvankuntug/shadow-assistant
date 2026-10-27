"""Synthesis engine: Piper voices loaded once, text -> 16-bit mono WAV bytes.

The HTTP layer depends only on the small ``Engine`` protocol, so tests can
swap in a fake without installing piper-tts or downloading a voice.
"""

from __future__ import annotations

import io
import logging
import threading
import time
import wave
from collections.abc import Iterable
from typing import Protocol

from .config import Settings
from .voices import ensure_voice

_LOGGER = logging.getLogger(__name__)


class Engine(Protocol):
    default_voice: str
    voices: list[str]

    def sample_rate(self, voice: str) -> int: ...

    def synthesize(self, text: str, voice: str) -> bytes:
        """Return a complete WAV file (RIFF header + PCM) for ``text``."""
        ...


def pcm_to_wav(pcm_chunks: Iterable[bytes], sample_rate: int, channels: int = 1, sample_width: int = 2) -> bytes:
    """Wrap raw PCM chunks in a WAV container. No chunks -> valid zero-length WAV."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(sample_width)
        wav.setframerate(sample_rate)
        for chunk in pcm_chunks:
            wav.writeframes(chunk)
    return buf.getvalue()


class PiperEngine:
    """Holds one ``PiperVoice`` per configured voice, CPU only."""

    def __init__(self, voices: dict, default_voice: str) -> None:
        self._voices = voices
        self.default_voice = default_voice
        self.voices = list(voices)
        # Synthesis is CPU-bound and onnxruntime already uses all cores per call,
        # so running requests in parallel only adds contention. A single lock
        # serialises them, which also keeps espeak-ng's process-global state
        # (used for phonemisation) safe regardless of piper-tts internals.
        self._lock = threading.Lock()

    @classmethod
    def load(cls, settings: Settings) -> "PiperEngine":
        from piper import PiperVoice  # imported lazily: tests do not need piper-tts

        loaded = {}
        for voice_id in settings.voices:
            model, config = ensure_voice(settings.voice_dir, voice_id, allow_download=settings.auto_download)
            started = time.perf_counter()
            voice = PiperVoice.load(model, config_path=config, use_cuda=False)
            # Warm-up: initialises espeak-ng and the onnxruntime session so the
            # first real request is not ~10x slower than the rest.
            for _ in voice.synthesize("Merhaba."):
                pass
            _LOGGER.info(
                "Loaded voice %s (%d Hz) in %.0f ms",
                voice_id,
                voice.config.sample_rate,
                (time.perf_counter() - started) * 1000,
            )
            loaded[voice_id] = voice
        return cls(loaded, settings.voice)

    def sample_rate(self, voice: str) -> int:
        return int(self._voices[voice].config.sample_rate)

    def synthesize(self, text: str, voice: str) -> bytes:
        piper_voice = self._voices[voice]
        with self._lock:
            # piper yields one chunk per sentence; all share the voice's format
            # (16-bit mono at config.sample_rate).
            chunks = [chunk.audio_int16_bytes for chunk in piper_voice.synthesize(text)]
        return pcm_to_wav(chunks, self.sample_rate(voice))
