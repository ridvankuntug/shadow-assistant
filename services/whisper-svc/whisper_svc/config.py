"""Runtime settings, read from environment variables."""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Mapping

# Contract (docs: shared contract §3): bodies larger than 25 MB are rejected with 413.
MAX_UPLOAD_BYTES = 25 * 1024 * 1024


def _env_bool(value: str | None, default: bool) -> bool:
    if value is None or value.strip() == "":
        return default
    v = value.strip().lower()
    if v in {"1", "true", "yes", "on"}:
        return True
    if v in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"invalid boolean value: {value!r}")


def _env_int(value: str | None, default: int, name: str) -> int:
    if value is None or value.strip() == "":
        return default
    try:
        return int(value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer, got {value!r}") from exc


@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 8701
    model: str = "large-v3"
    device: str = "cuda"
    compute_type: str = "float16"
    # Decoding options. Defaults were chosen from the measurements in README.md
    # (short Turkish commands on an 8 GB RTX-class GPU): beam 1 is faster than beam 5
    # with no accuracy loss on short commands; the Silero VAD filter costs no measurable
    # latency and drops silence (leading/trailing push-to-talk silence, empty presses),
    # on which Whisper otherwise hallucinates text (e.g. "Altyazı M.K." for pure silence).
    beam_size: int = 1
    vad_filter: bool = True
    max_upload_bytes: int = MAX_UPLOAD_BYTES

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        e = os.environ if env is None else env
        d = cls()
        beam = _env_int(e.get("WHISPER_BEAM_SIZE"), d.beam_size, "WHISPER_BEAM_SIZE")
        if beam < 1:
            raise ValueError("WHISPER_BEAM_SIZE must be >= 1")
        return cls(
            host=e.get("HOST") or d.host,
            port=_env_int(e.get("PORT"), d.port, "PORT"),
            model=e.get("WHISPER_MODEL") or d.model,
            device=e.get("WHISPER_DEVICE") or d.device,
            compute_type=e.get("WHISPER_COMPUTE_TYPE") or d.compute_type,
            beam_size=beam,
            vad_filter=_env_bool(e.get("WHISPER_VAD"), d.vad_filter),
        )
