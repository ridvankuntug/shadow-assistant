"""API unit tests. The Piper engine is replaced by a fake: no piper-tts, no voice download."""

from __future__ import annotations

import io
import threading
import time
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tts_svc.app import create_app
from tts_svc.config import MAX_TEXT_CHARS, Settings
from tts_svc.engine import pcm_to_wav
from tts_svc.voices import VoiceError, ensure_voice, voice_paths

SR = 22050


class FakeEngine:
    def __init__(self, voices=("tr_TR-dfki-medium", "tr_TR-fettah-medium")) -> None:
        self.voices = list(voices)
        self.default_voice = self.voices[0]
        self.calls: list[tuple[str, str]] = []

    def sample_rate(self, voice: str) -> int:
        return SR

    def synthesize(self, text: str, voice: str) -> bytes:
        self.calls.append((text, voice))
        return pcm_to_wav([b"\x00\x00" * 100], SR)


def _wait_ready(client: TestClient, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if client.get("/health").status_code != 503:
            return
        time.sleep(0.01)
    raise AssertionError("service did not become ready")


@pytest.fixture
def engine() -> FakeEngine:
    return FakeEngine()


@pytest.fixture
def client(engine: FakeEngine):
    app = create_app(Settings(), engine_loader=lambda _s: engine)
    with TestClient(app) as c:
        _wait_ready(c)
        yield c


def test_health_ok(client: TestClient) -> None:
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["service"] == "tts-svc"
    assert body["version"]
    assert body["voice"] == "tr_TR-dfki-medium"
    assert body["voices"] == ["tr_TR-dfki-medium", "tr_TR-fettah-medium"]
    assert body["sample_rate"] == SR


def test_health_loading_then_ok() -> None:
    release = threading.Event()

    def slow_loader(_s: Settings) -> FakeEngine:
        release.wait(5)
        return FakeEngine()

    with TestClient(create_app(Settings(), engine_loader=slow_loader)) as c:
        r = c.get("/health")
        assert r.status_code == 503
        assert r.json() == {"status": "loading"}
        r = c.post("/synthesize", json={"text": "Merhaba"})
        assert r.status_code == 503
        release.set()
        _wait_ready(c)
        assert c.get("/health").status_code == 200


def test_health_load_error() -> None:
    def broken_loader(_s: Settings):
        raise VoiceError("voice missing")

    with TestClient(create_app(Settings(), engine_loader=broken_loader)) as c:
        deadline = time.monotonic() + 5
        while c.get("/health").json().get("status") == "loading" and time.monotonic() < deadline:
            time.sleep(0.01)
        r = c.get("/health")
        assert r.status_code == 503
        assert r.json()["status"] == "error"
        assert "voice missing" in r.json()["detail"]
        assert c.post("/synthesize", json={"text": "Merhaba"}).status_code == 503


def test_synthesize_returns_wav(client: TestClient, engine: FakeEngine) -> None:
    r = client.post("/synthesize", json={"text": "Salondaki ışıkları kapattım."})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"
    assert r.content[:4] == b"RIFF" and r.content[8:12] == b"WAVE"
    with wave.open(io.BytesIO(r.content)) as w:
        assert w.getframerate() == SR
        assert w.getnchannels() == 1
        assert w.getsampwidth() == 2
        assert w.getnframes() == 100
    assert r.headers["x-voice"] == "tr_TR-dfki-medium"
    assert int(r.headers["x-processing-ms"]) >= 0
    assert engine.calls == [("Salondaki ışıkları kapattım.", "tr_TR-dfki-medium")]


@pytest.mark.parametrize("text", ["", "   ", "\n\t"])
def test_empty_text_is_400(client: TestClient, engine: FakeEngine, text: str) -> None:
    r = client.post("/synthesize", json={"text": text})
    assert r.status_code == 400
    assert r.json()["error"] == "empty_text"
    assert engine.calls == []


def test_too_long_is_413(client: TestClient, engine: FakeEngine) -> None:
    r = client.post("/synthesize", json={"text": "a" * (MAX_TEXT_CHARS + 1)})
    assert r.status_code == 413
    assert engine.calls == []


def test_exactly_max_length_is_ok(client: TestClient) -> None:
    assert client.post("/synthesize", json={"text": "a" * MAX_TEXT_CHARS}).status_code == 200


@pytest.mark.parametrize(
    "kwargs",
    [
        {"json": {}},
        {"json": {"text": 123}},
        {"json": {"text": "Merhaba", "voice": 5}},
        {"content": b"not json", "headers": {"content-type": "application/json"}},
    ],
)
def test_bad_body_is_400(client: TestClient, kwargs: dict) -> None:
    r = client.post("/synthesize", **kwargs)
    assert r.status_code == 400
    assert r.json()["error"] == "bad_request"


def test_voice_parameter_selects_voice(client: TestClient, engine: FakeEngine) -> None:
    r = client.post("/synthesize", json={"text": "Merhaba", "voice": "tr_TR-fettah-medium"})
    assert r.status_code == 200
    assert r.headers["x-voice"] == "tr_TR-fettah-medium"
    assert engine.calls[-1] == ("Merhaba", "tr_TR-fettah-medium")


@pytest.mark.parametrize("voice", [None, ""])
def test_missing_voice_uses_default(client: TestClient, engine: FakeEngine, voice) -> None:
    assert client.post("/synthesize", json={"text": "Merhaba", "voice": voice}).status_code == 200
    assert engine.calls[-1][1] == "tr_TR-dfki-medium"


def test_unknown_voice_is_400(client: TestClient, engine: FakeEngine) -> None:
    r = client.post("/synthesize", json={"text": "Merhaba", "voice": "en_US-lessac-medium"})
    assert r.status_code == 400
    assert r.json()["error"] == "unknown_voice"
    assert r.json()["voices"] == engine.voices
    assert engine.calls == []


def test_engine_failure_is_500() -> None:
    class Boom(FakeEngine):
        def synthesize(self, text: str, voice: str) -> bytes:
            raise RuntimeError("onnx exploded")

    with TestClient(create_app(Settings(), engine_loader=lambda _s: Boom())) as c:
        _wait_ready(c)
        r = c.post("/synthesize", json={"text": "Merhaba"})
        assert r.status_code == 500
        assert r.json()["error"] == "synthesis_failed"


def test_concurrent_requests(client: TestClient, engine: FakeEngine) -> None:
    results: list[int] = []

    def call(i: int) -> None:
        results.append(client.post("/synthesize", json={"text": f"Cümle {i}"}).status_code)

    threads = [threading.Thread(target=call, args=(i,)) for i in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert results == [200] * 8
    assert len(engine.calls) == 8


def test_pcm_to_wav_empty_is_valid() -> None:
    with wave.open(io.BytesIO(pcm_to_wav([], SR))) as w:
        assert w.getnframes() == 0
        assert w.getframerate() == SR


# --- config / voices -------------------------------------------------------


def test_settings_defaults() -> None:
    s = Settings.from_env({})
    assert (s.host, s.port, s.voice, s.auto_download) == ("127.0.0.1", 8702, "tr_TR-dfki-medium", True)
    assert s.voices == ["tr_TR-dfki-medium"]


def test_settings_from_env(tmp_path: Path) -> None:
    s = Settings.from_env(
        {
            "HOST": "0.0.0.0",
            "PORT": "9000",
            "TTS_VOICE": "tr_TR-fettah-medium",
            "TTS_VOICES": "tr_TR-dfki-medium, tr_TR-fettah-medium,",
            "TTS_VOICE_DIR": str(tmp_path),
            "TTS_AUTO_DOWNLOAD": "false",
        }
    )
    assert (s.host, s.port, s.voice_dir, s.auto_download) == ("0.0.0.0", 9000, tmp_path, False)
    assert s.voices == ["tr_TR-fettah-medium", "tr_TR-dfki-medium"]


@pytest.mark.parametrize("port", ["abc", "0", "70000"])
def test_settings_bad_port(port: str) -> None:
    with pytest.raises(ValueError):
        Settings.from_env({"PORT": port})


@pytest.mark.parametrize("voice_id", ["../etc/passwd", "a/b-c-d", "tr_TR-dfki", "x-y-z.onnx"])
def test_voice_id_rejects_paths(tmp_path: Path, voice_id: str) -> None:
    with pytest.raises(VoiceError):
        voice_paths(tmp_path, voice_id)


def test_ensure_voice_uses_existing_files(tmp_path: Path) -> None:
    (tmp_path / "xx_XX-custom-low.onnx").write_bytes(b"m")
    (tmp_path / "xx_XX-custom-low.onnx.json").write_text("{}")
    model, config = ensure_voice(tmp_path, "xx_XX-custom-low", allow_download=False)
    assert model.name == "xx_XX-custom-low.onnx" and config.name == "xx_XX-custom-low.onnx.json"


def test_ensure_voice_unknown_and_missing(tmp_path: Path) -> None:
    with pytest.raises(VoiceError, match="not a known downloadable voice"):
        ensure_voice(tmp_path, "xx_XX-custom-low", allow_download=True)


def test_ensure_voice_no_download_when_disabled(tmp_path: Path) -> None:
    with pytest.raises(VoiceError, match="TTS_AUTO_DOWNLOAD is off"):
        ensure_voice(tmp_path, "tr_TR-dfki-medium", allow_download=False)


def test_download_rejects_hash_mismatch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import tts_svc.voices as voices

    class FakeResp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    monkeypatch.setattr(voices.urllib.request, "urlopen", lambda url, timeout: FakeResp(b"tampered"))
    with pytest.raises(VoiceError, match="SHA-256 mismatch"):
        ensure_voice(tmp_path, "tr_TR-dfki-medium", allow_download=True)
    assert list(tmp_path.iterdir()) == []  # no partial or unverified file left behind


def test_download_network_error_leaves_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import tts_svc.voices as voices

    def fail(url, timeout):
        raise OSError("network down")

    monkeypatch.setattr(voices.urllib.request, "urlopen", fail)
    with pytest.raises(OSError, match="network down"):
        ensure_voice(tmp_path, "tr_TR-dfki-medium", allow_download=True)
    assert list(tmp_path.iterdir()) == []
