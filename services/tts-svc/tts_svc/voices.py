"""Known Turkish Piper voices, and download with SHA-256 verification.

Voice files are fetched at runtime into ``TTS_VOICE_DIR`` and never committed.
URLs are pinned to a repository commit and every downloaded file is checked
against a pinned SHA-256, so a changed or tampered upstream file fails loudly
instead of being loaded.

CLI::

    python -m tts_svc.voices                         # download the configured voices (TTS_VOICE + TTS_VOICES)
    python -m tts_svc.voices tr_TR-fahrettin-medium  # download specific voices
    python -m tts_svc.voices --list                  # list known voices

The service also downloads a known voice on demand, the first time a
``/synthesize`` request selects it (see app.py).
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import os
import re
import sys
import tempfile
import urllib.request
from dataclasses import dataclass
from pathlib import Path

_LOGGER = logging.getLogger(__name__)

# Voice ids become file names; reject anything that could escape TTS_VOICE_DIR.
VOICE_ID_RE = re.compile(r"^[A-Za-z0-9_]+-[A-Za-z0-9_]+-[A-Za-z0-9_]+$")

_OFFICIAL = (
    "https://huggingface.co/rhasspy/piper-voices/resolve/"
    "5041a7a49ae5b3a0f30e6837769eb03fdbb231bd/tr/tr_TR"
)
_MIRROR = "https://huggingface.co/csukuangfj/vits-piper-tr_TR-{name}-medium/resolve/{rev}"
_FAHRETTIN = _MIRROR.format(name="fahrettin", rev="ec73b891c2f4f9b14b1f14dab62b90ea0eb983ad")
_FETTAH = _MIRROR.format(name="fettah", rev="2ebce1b57d884634c3b349670a3971f0ec9440f1")


@dataclass(frozen=True)
class RemoteFile:
    url: str
    sha256: str
    size: int


@dataclass(frozen=True)
class KnownVoice:
    voice_id: str
    model: RemoteFile
    config: RemoteFile
    source: str
    license: str


KNOWN_VOICES: dict[str, KnownVoice] = {
    v.voice_id: v
    for v in (
        KnownVoice(
            voice_id="tr_TR-dfki-medium",
            model=RemoteFile(
                f"{_OFFICIAL}/dfki/medium/tr_TR-dfki-medium.onnx",
                "2844717f524ab965d3fe86e60562cbb601d3e456836efcc2196cc3a14112a8fb",
                63201294,
            ),
            config=RemoteFile(
                f"{_OFFICIAL}/dfki/medium/tr_TR-dfki-medium.onnx.json",
                "13ebd7810f1b61b5027583cf3131a0a233b6ea81c38f2200ebc4ff41c3cca039",
                4960,
            ),
            source="rhasspy/piper-voices (official)",
            license="CC BY-NC-SA 4.0 (MODEL_CARD; training data MaryTTS dfki-ot-data)",
        ),
        KnownVoice(
            voice_id="tr_TR-fahrettin-medium",
            model=RemoteFile(
                f"{_FAHRETTIN}/tr_TR-fahrettin-medium.onnx",
                "5809ca3765979ec7bb419ef67a86e0348bcf605cc70a9818417c62d473059c0c",
                63201422,
            ),
            config=RemoteFile(
                f"{_FAHRETTIN}/tr_TR-fahrettin-medium.onnx.json",
                "93741b234acc5f123430a0e343f619e01cfda6b1dc0970ee80bce7da22b1a09b",
                5022,
            ),
            source="csukuangfj/vits-piper-tr_TR-fahrettin-medium (third-party mirror)",
            license="CC0 per bundled MODEL_CARD (dataset: NabuCasa voice-datasets)",
        ),
        KnownVoice(
            voice_id="tr_TR-fettah-medium",
            model=RemoteFile(
                f"{_FETTAH}/tr_TR-fettah-medium.onnx",
                "31677a00f7927c94a279d210efd11771b9740df24e73c5ebd7a387875b52b2f0",
                63201422,
            ),
            config=RemoteFile(
                f"{_FETTAH}/tr_TR-fettah-medium.onnx.json",
                "0738ecd770d4102fa967a784ae89f64d846b1b5f104076e410c978fefa70b3e7",
                4877,
            ),
            source="csukuangfj/vits-piper-tr_TR-fettah-medium (third-party mirror)",
            license="CC0 per bundled MODEL_CARD (dataset: NabuCasa voice-datasets)",
        ),
    )
}


class VoiceError(Exception):
    """A voice cannot be found, downloaded or verified."""


def validate_voice_id(voice_id: str) -> str:
    if not VOICE_ID_RE.match(voice_id):
        raise VoiceError(f"invalid voice id {voice_id!r} (expected e.g. 'tr_TR-dfki-medium')")
    return voice_id


def voice_paths(voice_dir: Path, voice_id: str) -> tuple[Path, Path]:
    validate_voice_id(voice_id)
    return voice_dir / f"{voice_id}.onnx", voice_dir / f"{voice_id}.onnx.json"


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _download(remote: RemoteFile, target: Path) -> None:
    """Download to a unique temp file next to ``target``, verify SHA-256, then atomically rename.

    The temp name is unique per call, so two processes downloading into the same
    directory (e.g. the service and ``python -m tts_svc.voices``) cannot interleave
    writes into one file; the last verified copy wins the rename.
    """
    fd, part_name = tempfile.mkstemp(dir=target.parent, prefix=target.name + ".", suffix=".part")
    part = Path(part_name)
    _LOGGER.info("Downloading %s (%.1f MB) -> %s", remote.url, remote.size / 1e6, target)
    digest = hashlib.sha256()
    try:
        # fdopen first: it takes ownership of fd, so the handle is closed even if urlopen fails.
        with os.fdopen(fd, "wb") as out, urllib.request.urlopen(remote.url, timeout=60) as resp:
            for block in iter(lambda: resp.read(1 << 20), b""):
                digest.update(block)
                out.write(block)
        actual = digest.hexdigest()
        if actual != remote.sha256:
            raise VoiceError(
                f"SHA-256 mismatch for {remote.url}: expected {remote.sha256}, got {actual}"
            )
        os.replace(part, target)
    except Exception:
        part.unlink(missing_ok=True)
        raise


def ensure_voice(voice_dir: Path, voice_id: str, *, allow_download: bool) -> tuple[Path, Path]:
    """Return (model, config) paths for ``voice_id``, downloading a known voice if missing.

    Files that already exist are used as-is (not re-hashed on every start; use
    ``verify_voice`` for that). Unknown voice ids must be placed in ``voice_dir`` by hand.
    """
    model, config = voice_paths(voice_dir, voice_id)
    missing = [p for p in (model, config) if not p.is_file()]
    if not missing:
        return model, config
    known = KNOWN_VOICES.get(voice_id)
    if known is None:
        raise VoiceError(
            f"voice {voice_id!r} not found in {voice_dir} and not a known downloadable voice "
            f"(known: {', '.join(KNOWN_VOICES)})"
        )
    if not allow_download:
        raise VoiceError(
            f"voice {voice_id!r} not found in {voice_dir} and TTS_AUTO_DOWNLOAD is off; "
            f"run: python -m tts_svc.voices {voice_id}"
        )
    voice_dir.mkdir(parents=True, exist_ok=True)
    for path in missing:
        _download(known.model if path == model else known.config, path)
    return model, config


def local_voice_ids(voice_dir: Path) -> list[str]:
    """Voice ids whose two files (``<id>.onnx`` + ``<id>.onnx.json``) are in ``voice_dir``, sorted."""
    try:
        names = {p.name for p in voice_dir.iterdir() if p.is_file()}
    except OSError:  # missing / unreadable directory: nothing local
        return []
    ids = []
    for name in names:
        if not name.endswith(".onnx"):
            continue
        voice_id = name[: -len(".onnx")]
        if VOICE_ID_RE.match(voice_id) and f"{name}.json" in names:
            ids.append(voice_id)
    return sorted(ids)


def available_voice_ids(voice_dir: Path, *, allow_download: bool, loaded: list[str]) -> list[str]:
    """Voices a request may select: loaded ones first, then known voices (downloadable,
    or already on disk when downloads are off), then any other complete local voice."""
    local = local_voice_ids(voice_dir)
    known = [v for v in KNOWN_VOICES if allow_download or v in local]
    return list(dict.fromkeys([*loaded, *known, *local]))


def verify_voice(voice_dir: Path, voice_id: str) -> bool:
    """True if the local files of a known voice match the pinned hashes."""
    known = KNOWN_VOICES[voice_id]
    model, config = voice_paths(voice_dir, voice_id)
    return _sha256(model) == known.model.sha256 and _sha256(config) == known.config.sha256


def main(argv: list[str] | None = None) -> int:
    from .config import Settings

    parser = argparse.ArgumentParser(prog="python -m tts_svc.voices", description="Download Piper voices.")
    parser.add_argument("voice", nargs="*", help="voice ids (default: TTS_VOICE + TTS_VOICES)")
    parser.add_argument("--dir", type=Path, help="target directory (default: TTS_VOICE_DIR)")
    parser.add_argument("--list", action="store_true", help="list known voices and exit")
    parser.add_argument("--verify", action="store_true", help="re-hash existing files of known voices")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    if args.list:
        for v in KNOWN_VOICES.values():
            size_mb = (v.model.size + v.config.size) / 1e6
            print(f"{v.voice_id}\t{size_mb:.1f} MB\t{v.license}\t{v.source}")
        return 0
    settings = Settings.from_env()
    voice_dir = args.dir or settings.voice_dir
    try:
        for voice_id in args.voice or settings.voices:
            model, _ = ensure_voice(voice_dir, voice_id, allow_download=True)
            if args.verify and voice_id in KNOWN_VOICES and not verify_voice(voice_dir, voice_id):
                raise VoiceError(f"{voice_id}: local files do not match the pinned SHA-256")
            print(f"ok {voice_id}: {model}")
    except (VoiceError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
