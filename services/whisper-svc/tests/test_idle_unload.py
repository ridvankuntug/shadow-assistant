"""Idle unload / reload-on-request tests. The model is a fake; no GPU needed."""

from __future__ import annotations

import sys
import threading
import time
import types
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from whisper_svc import SERVICE_NAME, __version__
from whisper_svc import transcriber as transcriber_mod
from whisper_svc.app import create_app
from whisper_svc.config import Settings
from whisper_svc.lifecycle import ModelLifecycle, ModelUnavailable
from whisper_svc.transcriber import TranscriptionResult, UnsupportedLanguageError

AUDIO = b"RIFF-fake-audio-bytes"
HEADERS = {"content-type": "audio/wav"}
INFO = {"model": "fake-model", "device": "cpu", "compute_type": "int8"}


class FakeTranscriber:
    """Counts load/unload calls; loads and inferences can be held open with events."""

    def __init__(self) -> None:
        self.loads = 0
        self.unloads = 0
        self.loaded = False
        self.load_gate: threading.Event | None = None
        self.load_started = threading.Event()
        self.fail_loads = 0  # number of upcoming load() calls that raise
        self.infer_gate: threading.Event | None = None
        self.infer_started = threading.Event()
        self._mu = threading.Lock()
        self.concurrent_loads = 0
        self.max_concurrent_loads = 0

    def info(self) -> dict:
        return dict(INFO)

    def load(self) -> None:
        with self._mu:
            self.concurrent_loads += 1
            self.max_concurrent_loads = max(self.max_concurrent_loads, self.concurrent_loads)
        try:
            self.load_started.set()
            if self.load_gate is not None:
                assert self.load_gate.wait(5)
            with self._mu:
                self.loads += 1
                if self.fail_loads > 0:
                    self.fail_loads -= 1
                    raise RuntimeError("cuda oom")
            self.loaded = True
        finally:
            with self._mu:
                self.concurrent_loads -= 1

    def unload(self) -> None:
        assert self.loaded, "unload while not loaded"
        self.unloads += 1
        self.loaded = False

    def validate_language(self, language: str) -> None:
        if language not in {"tr", "en"}:
            raise UnsupportedLanguageError(language)

    def transcribe(self, audio: bytes, language: str) -> TranscriptionResult:
        assert self.loaded, "inference without a loaded model"
        self.infer_started.set()
        if self.infer_gate is not None:
            assert self.infer_gate.wait(5)
        assert self.loaded, "model unloaded during inference"
        return TranscriptionResult(text="ışığı aç", language=language, duration_ms=1000)


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _wait_for(pred, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.01)
    return pred()


def _loaded_lifecycle(idle: float = 60.0):
    fake, clock = FakeTranscriber(), FakeClock()
    lc = ModelLifecycle(fake, idle, clock=clock)
    lc.initial_load()
    assert lc.status == "ok"
    return lc, fake, clock


# --- lifecycle unit tests (fake clock) --------------------------------------------------


def test_timer_counts_from_last_use_and_unloads_after_timeout():
    lc, fake, clock = _loaded_lifecycle(60)
    clock.now += 59
    assert lc.check_idle() == pytest.approx(1)
    assert fake.unloads == 0 and lc.status == "ok"

    # A request resets the countdown.
    lc.begin()
    lc.end()
    clock.now += 59
    assert lc.check_idle() == pytest.approx(1)
    assert fake.unloads == 0
    clock.now += 1
    lc.check_idle()
    assert fake.unloads == 1
    assert lc.status == "idle"
    # Already idle: no second unload.
    clock.now += 600
    lc.check_idle()
    assert fake.unloads == 1


def test_no_unload_while_request_in_flight():
    lc, fake, clock = _loaded_lifecycle(60)
    lc.begin()
    clock.now += 3600
    lc.check_idle()
    assert fake.unloads == 0 and lc.status == "ok"
    lc.end()  # last use = now
    lc.check_idle()
    assert fake.unloads == 0
    clock.now += 60
    lc.check_idle()
    assert fake.unloads == 1


def test_begin_reloads_after_unload():
    lc, fake, clock = _loaded_lifecycle(60)
    clock.now += 60
    lc.check_idle()
    assert lc.status == "idle" and not fake.loaded
    lc.begin()
    assert fake.loads == 2 and fake.loaded and lc.status == "ok"
    lc.end()


def test_zero_means_never_unload():
    lc, fake, clock = _loaded_lifecycle(0)
    assert not lc.idle_unload_enabled
    clock.now += 10**9
    assert lc.check_idle() == float("inf")
    assert fake.unloads == 0 and lc.status == "ok"
    lc.start_timer()
    assert lc._timer is None  # no background thread at all


def test_initial_load_failure_is_final():
    fake = FakeTranscriber()
    fake.fail_loads = 1
    lc = ModelLifecycle(fake, 60, clock=FakeClock())
    lc.initial_load()
    assert lc.status == "error" and "cuda oom" in lc.error
    assert not lc.can_serve()
    with pytest.raises(ModelUnavailable):
        lc.begin()
    assert fake.loads == 1  # not retried


def test_requests_during_initial_load_are_not_served():
    lc = ModelLifecycle(FakeTranscriber(), 60, clock=FakeClock())
    assert lc.status == "loading" and not lc.can_serve()
    with pytest.raises(ModelUnavailable):
        lc.begin()


def test_failed_reload_reports_error_and_next_request_retries():
    lc, fake, clock = _loaded_lifecycle(60)
    clock.now += 60
    lc.check_idle()
    fake.fail_loads = 1
    with pytest.raises(ModelUnavailable):
        lc.begin()
    assert lc.status == "error" and "cuda oom" in lc.error
    assert lc.can_serve()  # retry allowed
    lc.begin()
    assert lc.status == "ok" and lc.error is None and fake.loads == 3
    lc.end()


def test_unload_error_still_ends_idle():
    lc, fake, clock = _loaded_lifecycle(60)

    def broken_unload():
        fake.loaded = False
        raise RuntimeError("driver hiccup")

    fake.unload = broken_unload
    clock.now += 60
    lc.check_idle()
    assert lc.status == "idle"
    lc.begin()
    assert fake.loaded
    lc.end()


# --- concurrency ----------------------------------------------------------------------


def test_concurrent_requests_while_idle_reload_once():
    lc, fake, clock = _loaded_lifecycle(60)
    clock.now += 60
    lc.check_idle()
    fake.load_gate = threading.Event()
    fake.load_started.clear()

    def request():
        lc.begin()
        try:
            return fake.transcribe(AUDIO, "tr").text
        finally:
            lc.end()

    with ThreadPoolExecutor(8) as pool:
        futures = [pool.submit(request) for _ in range(8)]
        assert fake.load_started.wait(5)
        time.sleep(0.05)
        assert lc.status == "idle"  # reloading still reports idle
        fake.load_gate.set()
        results = [f.result(5) for f in futures]
    assert results == ["ışığı aç"] * 8
    assert fake.loads == 2  # initial + exactly one reload
    assert fake.max_concurrent_loads == 1
    assert lc._in_flight == 0


def test_timer_does_not_unload_during_long_inference():
    fake = FakeTranscriber()
    fake.infer_gate = threading.Event()
    lc = ModelLifecycle(fake, 0.05)
    lc.initial_load()
    lc.start_timer()
    try:
        done = threading.Event()

        def request():
            lc.begin()
            try:
                fake.transcribe(AUDIO, "tr")
            finally:
                lc.end()
                done.set()

        t = threading.Thread(target=request)
        t.start()
        assert fake.infer_started.wait(5)
        time.sleep(0.3)  # several idle periods pass while the inference runs
        assert fake.unloads == 0 and lc.status == "ok"
        fake.infer_gate.set()
        assert done.wait(5)
        t.join(5)
        # After the request the countdown starts again and the timer unloads.
        assert _wait_for(lambda: lc.status == "idle")
        assert fake.unloads == 1
    finally:
        lc.stop_timer()


# --- HTTP level (real background timer, short timeout) --------------------------------


def _client(idle: float, fake: FakeTranscriber | None = None, background: bool = False):
    fake = fake or FakeTranscriber()
    app = create_app(Settings(idle_unload_seconds=idle), transcriber=fake, load_in_background=background)
    return TestClient(app), fake


def test_health_ok_idle_and_reload_on_request():
    c, fake = _client(0.1)
    with c:
        r = c.get("/health")
        assert r.status_code == 200 and r.json()["status"] == "ok"

        assert _wait_for(lambda: fake.unloads == 1)
        r = c.get("/health")
        assert r.status_code == 200
        assert r.json() == {"status": "idle", "service": SERVICE_NAME, "version": __version__, **INFO}

        r = c.post("/transcribe", content=AUDIO, headers=HEADERS)
        assert r.status_code == 200 and r.json()["text"] == "ışığı aç"
        assert fake.loads == 2
        # Unloads again after the next idle period.
        assert _wait_for(lambda: fake.unloads == 2)
        assert c.get("/health").json()["status"] == "idle"


def test_health_reports_idle_while_reloading():
    c, fake = _client(0.1)
    with c:
        assert _wait_for(lambda: fake.unloads == 1)
        fake.load_gate = threading.Event()
        fake.load_started.clear()
        with ThreadPoolExecutor(1) as pool:
            fut = pool.submit(c.post, "/transcribe", content=AUDIO, headers=HEADERS)
            assert fake.load_started.wait(5)
            r = c.get("/health")
            assert r.status_code == 200
            assert r.json()["status"] == "idle"
            fake.load_gate.set()
            assert fut.result(5).status_code == 200
        assert c.get("/health").json()["status"] in ("ok", "idle")


def test_reload_failure_returns_503_then_recovers():
    c, fake = _client(0.1)
    with c:
        assert _wait_for(lambda: fake.unloads == 1)
        fake.fail_loads = 1
        r = c.post("/transcribe", content=AUDIO, headers=HEADERS)
        assert r.status_code == 503
        assert r.json()["status"] == "error" and "cuda oom" in r.json()["error"]
        assert c.get("/health").status_code == 503
        r = c.post("/transcribe", content=AUDIO, headers=HEADERS)
        assert r.status_code == 200
        assert fake.loads == 3


def test_bad_language_while_idle_does_not_reload():
    c, fake = _client(0.1)
    with c:
        assert _wait_for(lambda: fake.unloads == 1)
        r = c.post("/transcribe?language=xx", content=AUDIO, headers=HEADERS)
        assert r.status_code == 400
        assert fake.loads == 1


def test_initial_loading_is_still_503():
    fake = FakeTranscriber()
    fake.load_gate = threading.Event()
    c, _ = _client(0.05, fake, background=True)
    with c:
        assert fake.load_started.wait(5)
        time.sleep(0.15)  # longer than the idle timeout: must not unload while loading
        r = c.get("/health")
        assert r.status_code == 503 and r.json() == {"status": "loading"}
        assert c.post("/transcribe", content=AUDIO, headers=HEADERS).status_code == 503
        fake.load_gate.set()
        assert _wait_for(lambda: c.get("/health").status_code == 200)


def test_zero_never_unloads_http():
    c, fake = _client(0)
    with c:
        time.sleep(0.2)
        assert fake.unloads == 0
        assert c.get("/health").json()["status"] == "ok"


def test_concurrent_http_requests_after_idle():
    c, fake = _client(0.1)
    with c:
        assert _wait_for(lambda: fake.unloads == 1)
        fake.load_gate = threading.Event()
        with ThreadPoolExecutor(6) as pool:
            futs = [pool.submit(c.post, "/transcribe", content=AUDIO, headers=HEADERS) for _ in range(6)]
            assert fake.load_started.wait(5)
            time.sleep(0.05)
            fake.load_gate.set()
            codes = [f.result(5).status_code for f in futs]
        assert codes == [200] * 6
        assert fake.loads == 2 and fake.max_concurrent_loads == 1


# --- settings ---------------------------------------------------------------------------


@pytest.mark.parametrize(("value", "seconds"), [(None, 600.0), ("", 600.0), ("0", 0.0), ("1", 60.0), ("30", 1800.0)])
def test_idle_unload_env(value, seconds):
    env = {} if value is None else {"WHISPER_IDLE_UNLOAD_MIN": value}
    assert Settings.from_env(env).idle_unload_seconds == seconds


@pytest.mark.parametrize("value", ["-1", "abc", "1.5"])
def test_idle_unload_env_invalid(value):
    with pytest.raises(ValueError):
        Settings.from_env({"WHISPER_IDLE_UNLOAD_MIN": value})


# --- WhisperTranscriber.unload/load with a stubbed faster-whisper ----------------------


class _StubCt2Model:
    def __init__(self) -> None:
        self.unloaded = False

    def unload_model(self) -> None:
        self.unloaded = True


class _StubWhisperModel:
    instances: list["_StubWhisperModel"] = []

    def __init__(self, *args, **kwargs) -> None:
        self.model = _StubCt2Model()
        _StubWhisperModel.instances.append(self)

    def transcribe(self, *args, **kwargs):
        return iter(()), types.SimpleNamespace(language="tr")


@pytest.fixture
def stub_faster_whisper(monkeypatch):
    _StubWhisperModel.instances = []
    fw = types.ModuleType("faster_whisper")
    fw.WhisperModel = _StubWhisperModel
    tok = types.ModuleType("faster_whisper.tokenizer")
    tok._LANGUAGE_CODES = ("tr", "en")
    fw.tokenizer = tok
    monkeypatch.setitem(sys.modules, "faster_whisper", fw)
    monkeypatch.setitem(sys.modules, "faster_whisper.tokenizer", tok)
    calls = []
    monkeypatch.setattr(transcriber_mod, "add_nvidia_dll_dirs", lambda: calls.append(1) or [])
    return calls


def test_whisper_transcriber_unload_releases_model(stub_faster_whisper):
    t = transcriber_mod.WhisperTranscriber(Settings(device="cpu"))
    t.load()
    first = _StubWhisperModel.instances[0]
    t.unload()
    assert first.model.unloaded
    assert t._model is None
    t.unload()  # idempotent
    # Language validation keeps working while unloaded.
    t.validate_language("tr")
    with pytest.raises(UnsupportedLanguageError):
        t.validate_language("xx")
    t.load()
    assert len(_StubWhisperModel.instances) == 2 and t._model is _StubWhisperModel.instances[1]
    # DLL directories (Windows PATH) are added once per process, not per reload.
    assert stub_faster_whisper == [1]


def test_failed_warmup_releases_partially_loaded_model(stub_faster_whisper, monkeypatch):
    t = transcriber_mod.WhisperTranscriber(Settings(device="cpu"))
    fail = [True]
    ok_transcribe = _StubWhisperModel.transcribe

    def maybe_boom(self, *args, **kwargs):
        if fail[0]:
            raise RuntimeError("CUDA failed with error out of memory")
        return ok_transcribe(self, *args, **kwargs)

    monkeypatch.setattr(_StubWhisperModel, "transcribe", maybe_boom)
    with pytest.raises(RuntimeError, match="out of memory"):
        t.load()
    # The half-loaded model is released, not kept on the GPU for the next attempt.
    first = _StubWhisperModel.instances[0]
    assert first.model.unloaded
    assert t._model is None
    # A later load (warm-up OK again) works and holds exactly one live model.
    fail[0] = False
    t.load()
    assert len(_StubWhisperModel.instances) == 2 and t._model is _StubWhisperModel.instances[1]
    assert not _StubWhisperModel.instances[1].model.unloaded


def test_load_releases_existing_model_first(stub_faster_whisper):
    t = transcriber_mod.WhisperTranscriber(Settings(device="cpu"))
    t.load()
    first = _StubWhisperModel.instances[0]
    t.load()  # e.g. a retry while a previous model is still referenced
    assert first.model.unloaded
    assert len(_StubWhisperModel.instances) == 2 and t._model is _StubWhisperModel.instances[1]
    assert not _StubWhisperModel.instances[1].model.unloaded
