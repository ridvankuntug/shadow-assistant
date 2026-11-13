"""Shared fixtures. Everything is local: no packet leaves the machine, servers bind to 127.0.0.1."""

from __future__ import annotations

import secrets
import threading
from collections.abc import Iterator

import pytest

from wake_svc.server import RateLimiter, WakeService, make_server

# A locally administered unicast MAC (02:...) that no real card ships with.
MAC_TEXT = "02:00:00:aa:bb:cc"
MAC = bytes.fromhex("020000aabbcc")
TOKEN = secrets.token_urlsafe(32).encode("ascii")  # 43 characters, as the README tells the user to create it


class FakeClock:
    def __init__(self, start: float = 1000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class FakeSender:
    """Records payloads instead of touching the network."""

    def __init__(self, result: int = 3, error: OSError | None = None) -> None:
        self.payloads: list[bytes] = []
        self.result = result
        self.error = error

    def __call__(self, payload: bytes) -> int:
        self.payloads.append(payload)
        if self.error is not None:
            raise self.error
        return self.result


class LogCapture(list):
    def __call__(self, record: dict) -> None:
        self.append(record)

    def events(self) -> list[str]:
        return [r["event"] for r in self]


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def sender() -> FakeSender:
    return FakeSender()


@pytest.fixture
def logs() -> LogCapture:
    return LogCapture()


@pytest.fixture
def service(clock: FakeClock, sender: FakeSender, logs: LogCapture) -> WakeService:
    return WakeService(TOKEN, MAC, sender, clock=clock, limiter=RateLimiter(), log=logs)


def bearer(token: bytes = TOKEN) -> list[str]:
    return ["Bearer " + token.decode("ascii")]


@pytest.fixture
def http_server(service: WakeService) -> Iterator[tuple[str, int]]:
    server = make_server("127.0.0.1", 0, service)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    try:
        yield server.server_address[0], server.server_address[1]
    finally:
        server.shutdown()
        server.server_close()
        thread.join(5)
