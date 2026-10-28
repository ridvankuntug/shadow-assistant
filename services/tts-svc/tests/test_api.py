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
from tts_svc.voices import KNOWN_VOICES, VoiceError, ensure_voice, local_voice_ids, voice_paths

SR = 22050


class FakeEngine:
    def __init__(self, voices=("tr_TR-dfki-medium", "tr_TR-fettah-medium")) -> None:
        self.voices = list(voices)
        self.default_voice = self.voices[0]
        self.calls: list[tuple[str, str]] = []
        self.loads: list[str] = []

    def load_voice(self, voice_id: str) -> None:
        self.loads.append(voice_id)
        if voice_id not in self.voices:
            self.voices.append(voice_id)

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
def client(engine: FakeEngine, tmp_path: Path):
    # Empty voice dir: "available" = loaded + known voices, independent of the developer's disk.
    app = create_app(Settings(voice_dir=tmp_path), engine_loader=lambda _s: engine)
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
    # Loaded first, then the remaining known (downloadable) voices.
    assert body["available"] == ["tr_TR-dfki-medium", "tr_TR-fettah-medium", "tr_TR-fahrettin-medium"]
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


# --- on-demand voices -------------------------------------------------------


def _app(tmp_path: Path, engine: FakeEngine, **settings) -> TestClient:
    return TestClient(create_app(Settings(voice_dir=tmp_path, **settings), engine_loader=lambda _s: engine))


def test_available_voice_is_loaded_on_demand(tmp_path: Path) -> None:
    engine = FakeEngine(voices=("tr_TR-dfki-medium",))
    with _app(tmp_path, engine) as c:
        _wait_ready(c)
        assert c.get("/health").json()["voices"] == ["tr_TR-dfki-medium"]
        r = c.post("/synthesize", json={"text": "Merhaba", "voice": "tr_TR-fahrettin-medium"})
        assert r.status_code == 200
        assert r.headers["x-voice"] == "tr_TR-fahrettin-medium"
        assert engine.loads == ["tr_TR-fahrettin-medium"]
        assert c.get("/health").json()["voices"] == ["tr_TR-dfki-medium", "tr_TR-fahrettin-medium"]
        # Second request: already loaded, no new load.
        assert c.post("/synthesize", json={"text": "Tekrar", "voice": "tr_TR-fahrettin-medium"}).status_code == 200
        assert engine.loads == ["tr_TR-fahrettin-medium"]


def test_unknown_voice_lists_available(client: TestClient, engine: FakeEngine) -> None:
    r = client.post("/synthesize", json={"text": "Merhaba", "voice": "../../etc/passwd"})
    assert r.status_code == 400
    assert r.json()["error"] == "unknown_voice"
    assert "tr_TR-fahrettin-medium" in r.json()["available"]
    assert engine.loads == []


def test_no_auto_download_limits_available_to_disk(tmp_path: Path) -> None:
    # A complete custom voice and a known voice on disk; an incomplete one and a temp file are ignored.
    for name in ("xx_XX-custom-low.onnx", "xx_XX-custom-low.onnx.json", "tr_TR-fettah-medium.onnx",
                 "tr_TR-fettah-medium.onnx.json", "yy_YY-half-low.onnx", "tr_TR-dfki-medium.onnx.abc.part"):
        (tmp_path / name).write_bytes(b"x")
    engine = FakeEngine(voices=("tr_TR-dfki-medium",))
    with _app(tmp_path, engine, auto_download=False) as c:
        _wait_ready(c)
        assert c.get("/health").json()["available"] == ["tr_TR-dfki-medium", "tr_TR-fettah-medium", "xx_XX-custom-low"]
        r = c.post("/synthesize", json={"text": "Merhaba", "voice": "tr_TR-fahrettin-medium"})
        assert r.status_code == 400 and r.json()["error"] == "unknown_voice"
        assert c.post("/synthesize", json={"text": "Merhaba", "voice": "xx_XX-custom-low"}).status_code == 200
        assert engine.loads == ["xx_XX-custom-low"]


def test_slow_load_answers_503_then_succeeds(tmp_path: Path) -> None:
    release = threading.Event()

    class SlowEngine(FakeEngine):
        def load_voice(self, voice_id: str) -> None:
            release.wait(5)
            super().load_voice(voice_id)

    engine = SlowEngine(voices=("tr_TR-dfki-medium",))
    with _app(tmp_path, engine, voice_load_wait_s=0.05) as c:
        _wait_ready(c)
        statuses: list[int] = []

        def call() -> None:
            statuses.append(c.post("/synthesize", json={"text": "Merhaba", "voice": "tr_TR-fettah-medium"}).status_code)

        threads = [threading.Thread(target=call) for _ in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert statuses == [503] * 3
        r = c.post("/synthesize", json={"text": "Merhaba", "voice": "tr_TR-fettah-medium"})
        assert r.status_code == 503
        assert r.json()["error"] == "voice_loading" and r.json()["status"] == "loading"
        # The default voice keeps working while another voice loads.
        assert c.post("/synthesize", json={"text": "Merhaba"}).status_code == 200
        release.set()
        deadline = time.monotonic() + 5
        while "tr_TR-fettah-medium" not in engine.voices and time.monotonic() < deadline:
            time.sleep(0.01)
        assert c.post("/synthesize", json={"text": "Merhaba", "voice": "tr_TR-fettah-medium"}).status_code == 200
        assert engine.loads == ["tr_TR-fettah-medium"]  # concurrent requests shared one load


def test_failed_load_is_503_and_not_retried_immediately(tmp_path: Path) -> None:
    class BrokenEngine(FakeEngine):
        def load_voice(self, voice_id: str) -> None:
            self.loads.append(voice_id)
            raise OSError("network down")

    engine = BrokenEngine(voices=("tr_TR-dfki-medium",))
    with _app(tmp_path, engine) as c:
        _wait_ready(c)
        for _ in range(2):
            r = c.post("/synthesize", json={"text": "Merhaba", "voice": "tr_TR-fettah-medium"})
            assert r.status_code == 503
            assert r.json()["error"] == "voice_unavailable"
            assert "network down" in r.json()["detail"]
        assert engine.loads == ["tr_TR-fettah-medium"]
        assert c.get("/health").status_code == 200  # the service itself stays healthy


def test_piper_engine_downloads_voice_on_demand(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import hashlib

    import tts_svc.voices as voices
    from tts_svc.engine import PiperEngine
    from tts_svc.voices import KnownVoice, RemoteFile

    payload = {"https://x/m.onnx": b"model-bytes", "https://x/m.onnx.json": b"{}"}

    def remote(url: str) -> RemoteFile:
        return RemoteFile(url, hashlib.sha256(payload[url]).hexdigest(), len(payload[url]))

    monkeypatch.setitem(
        voices.KNOWN_VOICES,
        "tr_TR-test-medium",
        KnownVoice("tr_TR-test-medium", remote("https://x/m.onnx"), remote("https://x/m.onnx.json"), "test", "CC0"),
    )
    fetched: list[str] = []

    class FakeResp(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def fake_urlopen(url, timeout):
        fetched.append(url)
        return FakeResp(payload[url])

    monkeypatch.setattr(voices.urllib.request, "urlopen", fake_urlopen)

    class FakePiperVoice:
        class config:
            sample_rate = SR

    built: list[tuple[str, str]] = []

    def factory(model: Path, config: Path) -> FakePiperVoice:
        built.append((model.name, config.name))
        return FakePiperVoice()

    engine = PiperEngine({"tr_TR-dfki-medium": FakePiperVoice()}, "tr_TR-dfki-medium",
                         Settings(voice_dir=tmp_path), voice_factory=factory)
    engine.load_voice("tr_TR-test-medium")
    assert engine.voices == ["tr_TR-dfki-medium", "tr_TR-test-medium"]
    assert built == [("tr_TR-test-medium.onnx", "tr_TR-test-medium.onnx.json")]
    assert sorted(fetched) == ["https://x/m.onnx", "https://x/m.onnx.json"]
    assert (tmp_path / "tr_TR-test-medium.onnx").read_bytes() == b"model-bytes"
    engine.load_voice("tr_TR-test-medium")  # already loaded: no-op
    assert len(built) == 1 and len(fetched) == 2


def test_known_voices_are_turkish_and_pinned() -> None:
    assert list(KNOWN_VOICES)[0] == "tr_TR-dfki-medium"
    for v in KNOWN_VOICES.values():
        assert v.voice_id.startswith("tr_TR-")
        assert v.license and v.source
        for f in (v.model, v.config):
            assert f.url.startswith("https://huggingface.co/") and "/resolve/" in f.url
            assert len(f.sha256) == 64


def test_local_voice_ids_missing_dir(tmp_path: Path) -> None:
    assert local_voice_ids(tmp_path / "nope") == []


def test_settings_voice_load_wait() -> None:
    assert Settings.from_env({}).voice_load_wait_s == 20.0
    assert Settings.from_env({"TTS_VOICE_LOAD_WAIT_S": "5"}).voice_load_wait_s == 5.0
    for bad in ("abc", "-1", "nan", "601"):
        with pytest.raises(ValueError):
            Settings.from_env({"TTS_VOICE_LOAD_WAIT_S": bad})
