"""POST /wake decision logic with a fake clock and a fake sender: token, rate limits, answers, logs, sending."""

from __future__ import annotations

import errno
import hmac
import io
import json
import socket

import pytest

from conftest import MAC, TOKEN, FakeClock, FakeSender, LogCapture, bearer
from wake_svc.server import (
    AUTH_FAIL_MAX,
    AUTH_LOCKOUT_S,
    WAKE_HOURLY_MAX,
    JsonLog,
    PacketSender,
    RateLimiter,
    WakeService,
    magic_packet,
)

SRC = "192.0.2.50"
OTHER = "192.0.2.51"


# ------------------------------------------------------------------ token compare


@pytest.mark.parametrize(
    "authorization",
    [
        [],  # missing
        [""],
        ["Bearer"],
        ["Bearer "],
        ["Bearer wrong-token"],
        ["Bearer " + TOKEN.decode()[:-1]],  # prefix of the right token
        ["Bearer " + TOKEN.decode() + "x"],  # right token plus a suffix
        ["Basic " + TOKEN.decode()],  # wrong scheme
        [TOKEN.decode()],  # no scheme
        ["Bearer " + TOKEN.decode(), "Bearer " + TOKEN.decode()],  # two headers
    ],
)
def test_wrong_or_missing_token_is_401(service: WakeService, sender: FakeSender, authorization) -> None:
    status, body, headers = service.handle_wake(SRC, authorization)
    assert status == 401
    assert body == {"error": "unauthorized"}
    assert ("WWW-Authenticate", "Bearer") in headers
    assert sender.payloads == []


@pytest.mark.parametrize("value", ["Bearer {t}", "bearer {t}", "BEARER {t}", "  Bearer   {t}  "])
def test_right_token_is_202(service: WakeService, sender: FakeSender, value: str) -> None:
    status, body, headers = service.handle_wake(SRC, [value.format(t=TOKEN.decode())])
    assert (status, body, headers) == (202, {"sent": True}, [])
    assert sender.payloads == [magic_packet(MAC)]


def test_token_is_compared_with_hmac_compare_digest(clock, sender, logs) -> None:
    calls: list[tuple[bytes, bytes]] = []

    def spy(a: bytes, b: bytes) -> bool:
        calls.append((a, b))
        return hmac.compare_digest(a, b)

    service = WakeService(TOKEN, MAC, sender, clock=clock, log=logs, compare=spy)
    assert service.handle_wake(SRC, ["Bearer nope"])[0] == 401
    assert service.handle_wake(SRC, bearer())[0] == 202
    assert calls == [(b"nope", TOKEN), (TOKEN, TOKEN)]
    # the default really is the constant-time compare
    assert WakeService(TOKEN, MAC, sender)._compare is hmac.compare_digest


# ------------------------------------------------------------------ wake rate limits


def test_second_wake_within_10_s_is_429_with_retry_after(service, sender, clock) -> None:
    assert service.handle_wake(SRC, bearer())[0] == 202
    clock.advance(3.2)
    status, body, headers = service.handle_wake(SRC, bearer())
    assert status == 429
    assert body == {"error": "rate_limited", "retryAfterS": 7}  # ceil(6.8)
    assert ("Retry-After", "7") in headers
    assert len(sender.payloads) == 1
    clock.advance(6.8)  # exactly 10 s after the first
    assert service.handle_wake(SRC, bearer())[0] == 202


def test_interval_limit_is_global_not_per_address(service, clock) -> None:
    assert service.handle_wake(SRC, bearer())[0] == 202
    clock.advance(1)
    assert service.handle_wake(OTHER, bearer())[0] == 429


def test_hourly_limit_20(service, sender, clock) -> None:
    for _ in range(WAKE_HOURLY_MAX):
        assert service.handle_wake(SRC, bearer())[0] == 202
        clock.advance(10)
    # 20 accepted in the last 200 s; the 21st must wait until the first is an hour old
    status, body, headers = service.handle_wake(SRC, bearer())
    assert status == 429
    assert body["retryAfterS"] == 3600 - 200
    assert ("Retry-After", str(3600 - 200)) in headers
    assert len(sender.payloads) == WAKE_HOURLY_MAX
    clock.advance(3600 - 200)
    assert service.handle_wake(SRC, bearer())[0] == 202


def test_retry_after_is_at_least_one_second(service, clock) -> None:
    assert service.handle_wake(SRC, bearer())[0] == 202
    clock.advance(9.9999)
    status, body, headers = service.handle_wake(SRC, bearer())
    assert status == 429 and body["retryAfterS"] == 1 and ("Retry-After", "1") in headers


# ------------------------------------------------------------------ auth lockout


def test_five_failures_per_minute_lock_the_address_for_5_minutes(service, clock, sender) -> None:
    for _ in range(AUTH_FAIL_MAX):
        assert service.handle_wake(SRC, ["Bearer nope"])[0] == 401
        clock.advance(1)
    # locked: even the right token gets 429 from that address
    status, body, headers = service.handle_wake(SRC, bearer())
    assert status == 429
    assert body == {"error": "rate_limited", "retryAfterS": 299}  # locked at t+4 for 300 s, now t+5
    assert ("Retry-After", "299") in headers
    assert sender.payloads == []
    # another address is not affected
    assert service.handle_wake(OTHER, bearer())[0] == 202
    clock.advance(AUTH_LOCKOUT_S)
    clock.advance(10)
    assert service.handle_wake(SRC, bearer())[0] == 202


def test_failures_older_than_a_minute_do_not_count(service, clock) -> None:
    for _ in range(AUTH_FAIL_MAX - 1):
        assert service.handle_wake(SRC, ["Bearer nope"])[0] == 401
    clock.advance(61)
    for _ in range(AUTH_FAIL_MAX - 1):
        assert service.handle_wake(SRC, ["Bearer nope"])[0] == 401
    assert service.handle_wake(SRC, bearer())[0] == 202


def test_lockout_expires_and_counting_starts_again(service, clock) -> None:
    for _ in range(AUTH_FAIL_MAX):
        service.handle_wake(SRC, [])
    clock.advance(AUTH_LOCKOUT_S)
    for _ in range(AUTH_FAIL_MAX - 1):
        assert service.handle_wake(SRC, [])[0] == 401
    assert service.handle_wake(SRC, bearer())[0] == 202


def test_failed_attempts_do_not_eat_the_wake_budget(service, clock, sender) -> None:
    # many addresses fail many times; the right token still wakes at once
    for i in range(50):
        for _ in range(AUTH_FAIL_MAX + 2):
            service.handle_wake(f"198.51.100.{i}", ["Bearer nope"])
    assert service.handle_wake(SRC, bearer())[0] == 202
    # and a failure right after a wake does not push the next wake further out
    clock.advance(5)
    service.handle_wake(OTHER, ["Bearer nope"])
    clock.advance(5)
    assert service.handle_wake(SRC, bearer())[0] == 202
    assert len(sender.payloads) == 2


def test_auth_table_is_capped_oldest_dropped(clock, sender, logs) -> None:
    limiter = RateLimiter(table_max=3)
    service = WakeService(TOKEN, MAC, sender, clock=clock, limiter=limiter, log=logs)
    for _ in range(AUTH_FAIL_MAX):
        service.handle_wake("198.51.100.1", [])  # locked
    for addr in ("198.51.100.2", "198.51.100.3", "198.51.100.4"):
        service.handle_wake(addr, [])
    assert limiter.auth_table_size() == 3
    # the oldest entry (the locked one) was dropped, so that address is no longer locked
    assert limiter.auth_lockout("198.51.100.1", clock()) is None
    for addr in ("198.51.100.2", "198.51.100.3", "198.51.100.4"):
        assert limiter.auth_lockout(addr, clock()) is None  # one failure each, not locked


def test_auth_table_cap_holds_under_many_addresses(service) -> None:
    for i in range(3000):
        service.handle_wake(f"10.{i // 256}.{i % 256}.1", [])
    assert service.limiter.auth_table_size() == 1024


# ------------------------------------------------------------------ send failure


def test_send_failure_is_503_and_gives_the_budget_back(clock, logs) -> None:
    failing = FakeSender(error=OSError(errno.ENETUNREACH, "unreachable"))
    service = WakeService(TOKEN, MAC, failing, clock=clock, log=logs)
    assert service.handle_wake(SRC, bearer()) == (503, {"error": "send_failed"}, [])
    failing.error = None
    clock.advance(1)
    assert service.handle_wake(SRC, bearer())[0] == 202  # not 429: nothing went out before
    assert logs[0]["event"] == "send_failed" and logs[0]["errno"] == errno.ENETUNREACH


# ------------------------------------------------------------------ logs


def test_log_lines_for_every_outcome_without_token_or_mac(clock, logs) -> None:
    sender = FakeSender()
    service = WakeService(TOKEN, MAC, sender, clock=clock, log=logs)
    service.handle_wake(SRC, bearer())  # wake_sent
    service.handle_wake(SRC, bearer())  # rate_limited (interval)
    service.handle_wake(SRC, ["Bearer " + TOKEN.decode()[:-1]])  # auth_failed
    sender.error = OSError(errno.EPERM, "no")
    clock.advance(10)
    service.handle_wake(SRC, bearer())  # send_failed
    assert logs.events() == ["wake_sent", "rate_limited", "auth_failed", "send_failed"]
    assert [r["status"] for r in logs] == [202, 429, 401, 503]
    assert all(r["src"] == SRC for r in logs)
    assert logs[1]["reason"] == "interval"

    # through the real JSON writer as well
    stream = io.StringIO()
    writer = JsonLog(stream)
    for record in logs:
        writer(record)
    text = stream.getvalue()
    lines = text.splitlines()
    assert len(lines) == 4
    for line in lines:
        record = json.loads(line)
        assert record["ts"].endswith("Z")
    assert_no_secret(text)


def assert_no_secret(text: str) -> None:
    lower = text.lower()
    token = TOKEN.decode()
    assert token not in text
    assert token[:12] not in text
    assert "authorization" not in lower and "bearer" not in lower
    for form in ("02:00:00:aa:bb:cc", "02-00-00-aa-bb-cc", "020000aabbcc", "aa:bb:cc", "aa-bb-cc"):
        assert form not in lower


def test_default_logger_writes_json_to_stdout(clock, sender, capsys) -> None:
    service = WakeService(TOKEN, MAC, sender, clock=clock)
    service.handle_wake(SRC, ["Bearer " + TOKEN.decode() + "x"])
    service.handle_wake(SRC, bearer())
    out = capsys.readouterr().out
    events = [json.loads(line)["event"] for line in out.splitlines()]
    assert events == ["auth_failed", "wake_sent"]
    assert_no_secret(out)


# ------------------------------------------------------------------ PacketSender


class FakeSocket:
    def __init__(self, fail_targets=(), fail_bind=False) -> None:
        self.options: list[tuple] = []
        self.bound = None
        self.sent: list[tuple[bytes, tuple[str, int]]] = []
        self.closed = False
        self._fail_targets = set(fail_targets)
        self._fail_bind = fail_bind

    def __enter__(self):
        return self

    def __exit__(self, *exc) -> None:
        self.closed = True

    def setsockopt(self, *args) -> None:
        self.options.append(args)

    def bind(self, address) -> None:
        if self._fail_bind:
            raise OSError(errno.EADDRNOTAVAIL, "cannot assign")
        self.bound = address

    def sendto(self, payload, address) -> int:
        if address[0] in self._fail_targets:
            raise OSError(errno.ENETUNREACH, "unreachable")
        self.sent.append((payload, address))
        return len(payload)


def make_sender(fake: FakeSocket, sleeps: list[float], broadcasts=("192.0.2.255", "255.255.255.255")) -> PacketSender:
    def factory(family, kind):
        assert (family, kind) == (socket.AF_INET, socket.SOCK_DGRAM)
        return fake

    return PacketSender(broadcasts, "192.0.2.10", sleep=sleeps.append, socket_factory=factory)


def test_sender_sends_three_rounds_100_ms_apart_from_the_lan_address() -> None:
    fake, sleeps = FakeSocket(), []
    packet = magic_packet(MAC)
    assert make_sender(fake, sleeps)(packet) == 6
    assert (socket.SOL_SOCKET, socket.SO_BROADCAST, 1) in fake.options
    assert fake.bound == ("192.0.2.10", 0)
    assert sleeps == [0.1, 0.1]
    assert fake.sent == [(packet, (addr, 9)) for _ in range(3) for addr in ("192.0.2.255", "255.255.255.255")]
    assert fake.closed


def test_sender_keeps_going_when_one_address_fails() -> None:
    fake, sleeps = FakeSocket(fail_targets={"255.255.255.255"}), []
    assert make_sender(fake, sleeps)(b"x") == 3


def test_sender_raises_when_nothing_was_sent() -> None:
    fake = FakeSocket(fail_targets={"192.0.2.255", "255.255.255.255"})
    with pytest.raises(OSError):
        make_sender(fake, [])(b"x")
    with pytest.raises(OSError):
        make_sender(FakeSocket(fail_bind=True), [])(b"x")


def test_real_udp_datagram_on_loopback() -> None:
    """One real send: to 127.0.0.1 on a free port, read back what arrived."""
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as receiver:
        receiver.bind(("127.0.0.1", 0))
        receiver.settimeout(5)
        port = receiver.getsockname()[1]
        sender = PacketSender(["127.0.0.1"], "127.0.0.1", port=port, sleep=lambda s: None)
        packet = magic_packet(MAC)
        assert sender(packet) == 3
        for _ in range(3):
            data, (addr, _) = receiver.recvfrom(2048)
            assert data == packet
            assert addr == "127.0.0.1"


def test_when_both_limits_apply_the_longer_hourly_wait_is_reported(service, clock) -> None:
    for _ in range(WAKE_HOURLY_MAX):
        assert service.handle_wake(SRC, bearer())[0] == 202
        clock.advance(10)
    clock.advance(-7)  # 3 s after the 20th wake: interval and hourly limits both apply
    status, body, headers = service.handle_wake(SRC, bearer())
    assert status == 429
    assert body["retryAfterS"] == 3600 - 193  # not 7
    assert ("Retry-After", str(3600 - 193)) in headers


def test_unexpected_sender_error_is_503_and_gives_the_budget_back(clock, logs) -> None:
    class Boom(FakeSender):
        def __call__(self, payload: bytes) -> int:
            raise RuntimeError("bug")

    service = WakeService(TOKEN, MAC, Boom(), clock=clock, log=logs)
    assert service.handle_wake(SRC, bearer()) == (503, {"error": "send_failed"}, [])
    assert logs[-1]["event"] == "send_failed" and logs[-1]["error"] == "RuntimeError"
    assert service.limiter.reserve_wake(clock()) is None  # budget was given back


def test_longer_wait_wins_when_the_hourly_window_is_about_to_open() -> None:
    limiter = RateLimiter()
    assert limiter.reserve_wake(0.0) is None
    for i in range(WAKE_HOURLY_MAX - 1):
        assert limiter.reserve_wake(3415.0 + 10 * i) is None  # last one at 3595
    # at 3598 the hourly slot frees in 2 s, but the interval needs 7 s
    assert limiter.reserve_wake(3598.0) == (7.0, "interval")
    assert limiter.reserve_wake(3605.0) is None
