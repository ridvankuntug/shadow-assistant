"""Settings read from environment variables (see README "Configuration")."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_VOICE = "tr_TR-dfki-medium"
# <service dir>/voices -- git-ignored (services/tts-svc/.gitignore).
DEFAULT_VOICE_DIR = Path(__file__).resolve().parent.parent / "voices"
# Fixed by the service contract (§3): text longer than this -> 413.
MAX_TEXT_CHARS = 2000

_FALSE = {"0", "false", "no", "off"}


def _split_voices(raw: str) -> tuple[str, ...]:
    return tuple(v.strip() for v in raw.split(",") if v.strip())


@dataclass(frozen=True)
class Settings:
    host: str = "127.0.0.1"
    port: int = 8702
    voice: str = DEFAULT_VOICE
    extra_voices: tuple[str, ...] = ()
    voice_dir: Path = field(default=DEFAULT_VOICE_DIR)
    auto_download: bool = True

    @property
    def voices(self) -> list[str]:
        """All voices loaded at startup: the default first, then extras (deduplicated)."""
        return list(dict.fromkeys([self.voice, *self.extra_voices]))

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        env = os.environ if env is None else env
        port_raw = env.get("PORT", "").strip() or "8702"
        try:
            port = int(port_raw)
        except ValueError as exc:
            raise ValueError(f"PORT must be an integer, got {port_raw!r}") from exc
        if not 0 < port < 65536:
            raise ValueError(f"PORT out of range: {port}")
        voice_dir_raw = env.get("TTS_VOICE_DIR", "").strip()
        return cls(
            host=env.get("HOST", "").strip() or "127.0.0.1",
            port=port,
            voice=env.get("TTS_VOICE", "").strip() or DEFAULT_VOICE,
            extra_voices=_split_voices(env.get("TTS_VOICES", "")),
            voice_dir=Path(voice_dir_raw) if voice_dir_raw else DEFAULT_VOICE_DIR,
            auto_download=env.get("TTS_AUTO_DOWNLOAD", "1").strip().lower() not in _FALSE,
        )
