"""Synthesis engine: Piper voices (loaded at startup or on demand), text -> 16-bit mono WAV bytes.

The HTTP layer depends only on the small ``Engine`` protocol, so tests can
swap in a fake without installing piper-tts or downloading a voice.
"""

from __future__ import annotations

import io
import logging
import threading
import time
import wave
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any, Protocol

from .config import Settings
from .voices import ensure_voice

_LOGGER = logging.getLogger(__name__)


class Engine(Protocol):
    default_voice: str

    @property
    def voices(self) -> list[str]:
        """Ids of the voices loaded right now (default first)."""
        ...

    def sample_rate(self, voice: str) -> int: ...

    def synthesize(self, text: str, voice: str) -> bytes:
        """Return a complete WAV file (RIFF header + PCM) for ``text``."""
        ...

    def load_voice(self, voice_id: str) -> None:
        """Make ``voice_id`` available (download if needed, load, warm up). Blocking; may raise."""
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


VoiceFactory = Callable[[Path, Path], Any]


def _load_piper_voice(model: Path, config: Path) -> Any:
    from piper import PiperVoice  # imported lazily: tests do not need piper-tts

    voice = PiperVoice.load(model, config_path=config, use_cuda=False)
    # Warm-up: initialises espeak-ng and the onnxruntime session so the
    # first real request is not ~10x slower than the rest.
    for _ in voice.synthesize("Merhaba."):
        pass
    return voice


class PiperEngine:
    """Holds one ``PiperVoice`` per loaded voice, CPU only.

    The configured voices are loaded at startup; further voices are added at
    runtime through ``load_voice`` (the HTTP layer serialises those calls).
    """

    def __init__(
        self,
        voices: dict,
        default_voice: str,
        settings: Settings | None = None,
        voice_factory: VoiceFactory = _load_piper_voice,
    ) -> None:
        self._voices = dict(voices)
        self.default_voice = default_voice
        self._settings = settings
        self._voice_factory = voice_factory
        # Synthesis is CPU-bound and onnxruntime already uses all cores per call,
        # so running requests in parallel only adds contention. A single lock
        # serialises them, which also keeps espeak-ng's process-global state
        # (used for phonemisation) safe regardless of piper-tts internals.
        self._lock = threading.Lock()

    @property
    def voices(self) -> list[str]:
        return list(self._voices)

    @classmethod
    def load(cls, settings: Settings, voice_factory: VoiceFactory = _load_piper_voice) -> "PiperEngine":
        engine = cls({}, settings.voice, settings, voice_factory)
        for voice_id in settings.voices:
            engine.load_voice(voice_id)
        return engine

    def load_voice(self, voice_id: str) -> None:
        if voice_id in self._voices:
            return
        if self._settings is None:
            raise RuntimeError("engine has no settings; cannot load voices at runtime")
        model, config = ensure_voice(
            self._settings.voice_dir, voice_id, allow_download=self._settings.auto_download
        )
        started = time.perf_counter()
        voice = self._voice_factory(model, config)
        _LOGGER.info(
            "Loaded voice %s (%d Hz) in %.0f ms",
            voice_id,
            voice.config.sample_rate,
            (time.perf_counter() - started) * 1000,
        )
        # Published only once fully loaded and warmed up; a single dict store is
        # atomic, so concurrent readers see the voice either not at all or ready.
        self._voices[voice_id] = voice

    def sample_rate(self, voice: str) -> int:
        return int(self._voices[voice].config.sample_rate)

    def synthesize(self, text: str, voice: str) -> bytes:
        piper_voice = self._voices[voice]
        with self._lock:
            # piper yields one chunk per sentence; all share the voice's format
            # (16-bit mono at config.sample_rate).
            chunks = [chunk.audio_int16_bytes for chunk in piper_voice.synthesize(text)]
        return pcm_to_wav(chunks, self.sample_rate(voice))
