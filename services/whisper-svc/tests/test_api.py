"""API unit tests. The Whisper model is replaced by a fake; no GPU or model download needed."""

from __future__ import annotations

import io
import threading
import time
import wave

import pytest
from fastapi.testclient import TestClient

from whisper_svc import SERVICE_NAME, __version__
from whisper_svc.app import create_app
from whisper_svc.config import Settings
from whisper_svc.transcriber import (
    AudioDecodeError,
    TranscriptionResult,
    UnsupportedLanguageError,
)

GOOD_AUDIO = b"RIFF-fake-audio-bytes"
BAD_AUDIO = b"definitely not audio"


class FakeTranscriber:
    def __init__(self, load_gate: threading.Event | None = None, fail_load: bool = False):
        self.calls: list[tuple[bytes, str]] = []
        self.load_gate = load_gate
        self.fail_load = fail_load

    def info(self) -> dict:
        return {"model": "fake-model", "device": "cpu", "compute_type": "int8"}

    def load(self) -> None:
        if self.load_gate is not None:
            self.load_gate.wait(5)
        if self.fail_load:
            raise RuntimeError("boom")

    def validate_language(self, language: str) -> None:
        if language not in {"tr", "en"}:
            raise UnsupportedLanguageError(f"unsupported language code: {language!r}")

    def transcribe(self, audio: bytes, language: str) -> TranscriptionResult:
        self.validate_language(language)
        if audio == BAD_AUDIO:
            raise AudioDecodeError("could not decode audio")
        self.calls.append((audio, language))
        return TranscriptionResult(text="ışığı kapat", language=language, duration_ms=1234)


def make_client(fake: FakeTranscriber | None = None, **settings_kw) -> tuple[TestClient, FakeTranscriber]:
    fake = fake or FakeTranscriber()
    app = create_app(Settings(**settings_kw), transcriber=fake, load_in_background=False)
    return TestClient(app), fake


@pytest.fixture
def client():
    c, fake = make_client()
    with c:
        yield c, fake


def test_health_ok(client):
    c, _ = client
    r = c.get("/health")
    assert r.status_code == 200
    assert r.json() == {
        "status": "ok",
        "service": SERVICE_NAME,
        "version": __version__,
        "model": "fake-model",
        "device": "cpu",
        "compute_type": "int8",
    }


def test_health_loading_then_ok_and_transcribe_blocked_while_loading():
    gate = threading.Event()
    fake = FakeTranscriber(load_gate=gate)
    app = create_app(Settings(), transcriber=fake, load_in_background=True)
    with TestClient(app) as c:
        r = c.get("/health")
        assert r.status_code == 503
        assert r.json() == {"status": "loading"}
        r = c.post("/transcribe", content=GOOD_AUDIO, headers={"content-type": "audio/wav"})
        assert r.status_code == 503
        assert fake.calls == []
        gate.set()
        for _ in range(100):
            if c.get("/health").status_code == 200:
                break
            time.sleep(0.02)
        assert c.get("/health").status_code == 200


def test_health_reports_load_failure():
    fake = FakeTranscriber(fail_load=True)
    with TestClient(create_app(Settings(), transcriber=fake, load_in_background=False)) as c:
        r = c.get("/health")
        assert r.status_code == 503
        assert r.json()["status"] == "error"
        assert "boom" in r.json()["error"]


def test_transcribe_raw_body_defaults_to_turkish(client):
    c, fake = client
    r = c.post("/transcribe", content=GOOD_AUDIO, headers={"content-type": "audio/webm"})
    assert r.status_code == 200
    body = r.json()
    assert body["text"] == "ışığı kapat"
    assert body["language"] == "tr"
    assert body["duration_ms"] == 1234
    assert isinstance(body["processing_ms"], int) and body["processing_ms"] >= 0
    assert set(body) == {"text", "language", "duration_ms", "processing_ms"}
    assert fake.calls == [(GOOD_AUDIO, "tr")]


def test_transcribe_multipart_file_field(client):
    c, fake = client
    r = c.post("/transcribe", files={"file": ("clip.webm", GOOD_AUDIO, "audio/webm")})
    assert r.status_code == 200
    assert fake.calls == [(GOOD_AUDIO, "tr")]


def test_transcribe_multipart_without_file_field_is_400(client):
    c, fake = client
    r = c.post("/transcribe", files={"audio": ("clip.webm", GOOD_AUDIO, "audio/webm")})
    assert r.status_code == 400
    assert r.json()["error"] == "bad_audio"
    assert fake.calls == []


@pytest.mark.parametrize(
    "body",
    [
        b"garbage",
        b"--xyz\r\nbad header line\r\n\r\ndata\r\n--xyz--\r\n",  # invalid header char
        b"--xyzQQ\r\n",  # no CR after boundary
        b'--xyz\r\nContent-Disposition: form-data; name="file"; filename="a"\r\n\r\nabc',  # truncated
    ],
)
def test_transcribe_malformed_multipart_is_400(client, body):
    c, fake = client
    r = c.post("/transcribe", content=body, headers={"content-type": "multipart/form-data; boundary=xyz"})
    assert r.status_code == 400
    assert r.json()["error"] == "bad_audio"
    assert fake.calls == []


def test_transcribe_multipart_without_boundary_is_400(client):
    c, _ = client
    r = c.post("/transcribe", content=b"abc", headers={"content-type": "multipart/form-data"})
    assert r.status_code == 400


def test_transcribe_language_parameter(client):
    c, fake = client
    r = c.post("/transcribe?language=EN", content=GOOD_AUDIO, headers={"content-type": "audio/ogg"})
    assert r.status_code == 200
    assert r.json()["language"] == "en"
    assert fake.calls == [(GOOD_AUDIO, "en")]


@pytest.mark.parametrize("lang", ["xx", "", "  "])
def test_transcribe_unsupported_language_is_400(client, lang):
    c, fake = client
    r = c.post("/transcribe", params={"language": lang}, content=GOOD_AUDIO)
    assert r.status_code == 400
    assert r.json()["error"] == "bad_language"
    assert fake.calls == []


def test_transcribe_undecodable_audio_is_400(client):
    c, _ = client
    r = c.post("/transcribe", content=BAD_AUDIO, headers={"content-type": "audio/webm"})
    assert r.status_code == 400
    assert r.json()["error"] == "bad_audio"


def test_transcribe_empty_body_is_400(client):
    c, fake = client
    r = c.post("/transcribe", content=b"", headers={"content-type": "audio/wav"})
    assert r.status_code == 400
    assert fake.calls == []


def test_transcribe_too_large_raw_is_413():
    c, fake = make_client(max_upload_bytes=1000)
    with c:
        r = c.post("/transcribe", content=b"x" * 1001, headers={"content-type": "audio/wav"})
        assert r.status_code == 413
        assert r.json()["error"] == "too_large"
        # Exactly at the limit is accepted.
        r = c.post("/transcribe", content=b"y" * 1000, headers={"content-type": "audio/wav"})
        assert r.status_code == 200
    assert fake.calls == [(b"y" * 1000, "tr")]


def test_transcribe_too_large_multipart_is_413():
    c, fake = make_client(max_upload_bytes=1000)
    with c:
        r = c.post("/transcribe", files={"file": ("a.wav", b"x" * 2000, "audio/wav")})
        assert r.status_code == 413
    assert fake.calls == []


def test_transcribe_too_large_without_content_length_is_413():
    """Chunked upload (no Content-Length) is still capped while streaming."""
    c, fake = make_client(max_upload_bytes=1000)

    def chunks():
        for _ in range(5):
            yield b"z" * 400

    with c:
        r = c.post("/transcribe", content=chunks(), headers={"content-type": "audio/wav"})
        assert r.status_code == 413
    assert fake.calls == []


def test_default_upload_limit_is_25_mb():
    assert Settings().max_upload_bytes == 25 * 1024 * 1024


def test_settings_from_env():
    s = Settings.from_env(
        {
            "HOST": "0.0.0.0",
            "PORT": "9000",
            "WHISPER_MODEL": "small",
            "WHISPER_DEVICE": "cpu",
            "WHISPER_COMPUTE_TYPE": "int8",
            "WHISPER_BEAM_SIZE": "5",
            "WHISPER_VAD": "true",
        }
    )
    assert (s.host, s.port, s.model, s.device, s.compute_type, s.beam_size, s.vad_filter) == (
        "0.0.0.0",
        9000,
        "small",
        "cpu",
        "int8",
        5,
        True,
    )
    d = Settings.from_env({})
    assert (d.host, d.port, d.model, d.device) == ("127.0.0.1", 8701, "large-v3", "cuda")
    # Chosen defaults (see README "Measurements").
    assert (d.compute_type, d.beam_size, d.vad_filter) == ("float16", 1, True)
    assert Settings.from_env({"WHISPER_VAD": "0"}).vad_filter is False
    with pytest.raises(ValueError):
        Settings.from_env({"PORT": "abc"})
    with pytest.raises(ValueError):
        Settings.from_env({"WHISPER_BEAM_SIZE": "0"})
    with pytest.raises(ValueError):
        Settings.from_env({"WHISPER_VAD": "maybe"})


def test_transcribe_multipart_with_language(client):
    c, fake = client
    r = c.post("/transcribe?language=en", files={"file": ("clip.ogg", GOOD_AUDIO, "audio/ogg")})
    assert r.status_code == 200
    assert r.json()["language"] == "en"
    assert fake.calls == [(GOOD_AUDIO, "en")]


# --- real decoder (PyAV via faster-whisper), still no model -------------------------------


def _wav_bytes(seconds: float = 0.5, rate: int = 22050) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x01" * int(seconds * rate))
    return buf.getvalue()


def test_decode_audio_resamples_wav_to_16k():
    pytest.importorskip("faster_whisper")
    from whisper_svc.transcriber import SAMPLE_RATE, decode_audio

    samples = decode_audio(_wav_bytes(0.5))
    assert abs(samples.size - SAMPLE_RATE // 2) < 200


def test_decode_audio_rejects_garbage():
    pytest.importorskip("faster_whisper")
    from whisper_svc.transcriber import decode_audio

    with pytest.raises(AudioDecodeError):
        decode_audio(b"\x00\x11garbage" * 50)
