"""HTTP contract against a real server on 127.0.0.1 (sender faked: no packet is sent)."""

from __future__ import annotations

import http.client
import json
import socket

import pytest

from conftest import MAC, TOKEN, FakeSender
from wake_svc.server import (
    MAX_BODY_BYTES,
    SOCKET_TIMEOUT_S,
    VERSION,
    WakeRequestHandler,
    magic_packet,
    make_server,
)


def request(addr, method, path, body=None, headers=None):
    conn = http.client.HTTPConnection(*addr, timeout=5)
    try:
        conn.request(method, path, body=body, headers=headers or {})
        resp = conn.getresponse()
        data = resp.read()
        return resp.status, dict(resp.getheaders()), data
    finally:
        conn.close()


def auth(token: bytes = TOKEN) -> dict[str, str]:
    return {"Authorization": "Bearer " + token.decode()}


def raw_request(addr, payload: bytes) -> bytes:
    with socket.create_connection(addr, timeout=5) as sock:
        sock.sendall(payload)
        chunks = []
        while True:
            try:
                chunk = sock.recv(4096)
            except (ConnectionResetError, ConnectionAbortedError):
                break
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks)


# ------------------------------------------------------------------ /health


def test_health(http_server) -> None:
    status, headers, data = request(http_server, "GET", "/health")
    assert status == 200
    assert headers["Content-Type"] == "application/json"
    assert json.loads(data) == {"status": "ok", "service": "wake-svc", "version": VERSION}
    assert headers["Server"] == "wake-svc"  # no Python or service version
    assert headers["Cache-Control"] == "no-store"


def test_health_ignores_query(http_server) -> None:
    status, _, data = request(http_server, "GET", "/health?x=1")
    assert status == 200 and json.loads(data)["service"] == "wake-svc"


@pytest.mark.parametrize("method", ["POST", "PUT", "DELETE", "HEAD", "OPTIONS"])
def test_health_other_methods_405_empty(http_server, method) -> None:
    status, headers, data = request(http_server, method, "/health")
    assert status == 405
    assert headers["Allow"] == "GET"
    assert data == b""


# ------------------------------------------------------------------ /wake


def test_wake_202(http_server, sender: FakeSender) -> None:
    status, headers, data = request(http_server, "POST", "/wake", headers=auth())
    assert status == 202
    assert headers["Content-Type"] == "application/json"
    assert json.loads(data) == {"sent": True}
    assert sender.payloads == [magic_packet(MAC)]


def test_wake_body_and_query_are_ignored(http_server, sender: FakeSender) -> None:
    body = json.dumps({"mac": "02:11:22:33:44:55", "broadcast": "198.51.100.255", "port": 7}).encode()
    status, _, data = request(
        http_server,
        "POST",
        "/wake?mac=02-11-22-33-44-55&target=198.51.100.255",
        body=body,
        headers={**auth(), "Content-Type": "application/json"},
    )
    assert status == 202 and json.loads(data) == {"sent": True}
    assert sender.payloads == [magic_packet(MAC)]  # still the configured MAC


def test_wake_with_large_body_reads_at_most_1_kb(http_server, sender: FakeSender) -> None:
    # Content-Length claims 1 MB, only 1 KB + a bit is sent: the server reads 1 KB and answers.
    head = (
        "POST /wake HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer " + TOKEN.decode() +
        "\r\nContent-Length: 1048576\r\n\r\n"
    ).encode()
    reply = raw_request(http_server, head + b"m" * (MAX_BODY_BYTES + 10))
    assert reply.startswith(b"HTTP/1.0 202")
    assert sender.payloads == [magic_packet(MAC)]


def test_wake_without_token_401(http_server, sender: FakeSender) -> None:
    status, headers, data = request(http_server, "POST", "/wake")
    assert status == 401
    assert json.loads(data) == {"error": "unauthorized"}
    assert headers["WWW-Authenticate"] == "Bearer"
    assert sender.payloads == []


@pytest.mark.parametrize("token", [b"wrong", TOKEN[:-1], TOKEN + b"A"])
def test_wake_wrong_token_401(http_server, sender: FakeSender, token: bytes) -> None:
    status, _, data = request(http_server, "POST", "/wake", headers=auth(token))
    assert status == 401 and json.loads(data) == {"error": "unauthorized"}
    assert sender.payloads == []


def test_wake_twice_429_with_retry_after(http_server) -> None:
    assert request(http_server, "POST", "/wake", headers=auth())[0] == 202
    status, headers, data = request(http_server, "POST", "/wake", headers=auth())
    assert status == 429
    body = json.loads(data)
    assert body["error"] == "rate_limited"
    assert isinstance(body["retryAfterS"], int) and 1 <= body["retryAfterS"] <= 10
    assert headers["Retry-After"] == str(body["retryAfterS"])


def test_wake_send_failure_503(http_server, sender: FakeSender) -> None:
    sender.error = OSError(101, "unreachable")
    status, _, data = request(http_server, "POST", "/wake", headers=auth())
    assert status == 503 and json.loads(data) == {"error": "send_failed"}


@pytest.mark.parametrize("method", ["GET", "PUT", "DELETE", "HEAD"])
def test_wake_other_methods_405_empty(http_server, sender: FakeSender, method) -> None:
    status, headers, data = request(http_server, method, "/wake", headers=auth())
    assert status == 405
    assert headers["Allow"] == "POST"
    assert data == b""
    assert sender.payloads == []


@pytest.mark.parametrize("path", ["/", "/wake/", "/WAKE", "/wake/now", "/health/x", "/static/x.js", "/wake;x"])
@pytest.mark.parametrize("method", ["GET", "POST"])
def test_unknown_paths_404_empty(http_server, sender: FakeSender, path, method) -> None:
    status, headers, data = request(http_server, method, path, headers=auth())
    assert status == 404
    assert data == b"" and headers["Content-Length"] == "0"
    assert sender.payloads == []


def test_log_has_no_token_or_mac_for_http_requests(http_server, logs) -> None:
    request(http_server, "POST", "/wake", headers=auth(TOKEN[:-1]))
    request(http_server, "POST", "/wake", headers=auth())
    request(http_server, "POST", "/wake", headers=auth())
    text = json.dumps(list(logs)).lower()
    assert [r["event"] for r in logs] == ["auth_failed", "wake_sent", "rate_limited"]
    assert [r["src"] for r in logs] == ["127.0.0.1"] * 3
    assert TOKEN.decode().lower() not in text
    assert "bearer" not in text and "authorization" not in text
    for form in ("02:00:00:aa:bb:cc", "02-00-00-aa-bb-cc", "020000aabbcc"):
        assert form not in text


# ------------------------------------------------------------------ hardening


def test_headers_over_8_kb_431(http_server, sender: FakeSender) -> None:
    payload = (
        "POST /wake HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer " + TOKEN.decode() +
        "\r\nX-Pad: " + "a" * (9 * 1024) + "\r\n\r\n"
    ).encode()
    reply = raw_request(http_server, payload)
    assert reply.startswith(b"HTTP/1.0 431")
    assert reply.endswith(b"\r\n\r\n")  # empty body
    assert sender.payloads == []


def test_many_small_headers_over_8_kb_431(http_server) -> None:
    lines = "".join(f"X-{i}: {'b' * 60}\r\n" for i in range(140))  # ~9.5 KB in 140 lines
    reply = raw_request(http_server, f"GET /health HTTP/1.1\r\nHost: x\r\n{lines}\r\n".encode())
    assert reply.startswith(b"HTTP/1.0 431")


def test_headers_just_under_8_kb_are_fine(http_server) -> None:
    head = "GET /health HTTP/1.1\r\nHost: x\r\n"
    pad = 8 * 1024 - len(head) - len("X-Pad: \r\n\r\n") - 1
    reply = raw_request(http_server, (head + "X-Pad: " + "c" * pad + "\r\n\r\n").encode())
    assert reply.startswith(b"HTTP/1.0 200")


def test_request_line_over_8_kb_414(http_server) -> None:
    reply = raw_request(http_server, ("GET /" + "x" * (9 * 1024) + " HTTP/1.1\r\n\r\n").encode())
    assert reply.startswith(b"HTTP/1.0 414")


def test_garbage_request_400_empty(http_server) -> None:
    reply = raw_request(http_server, b"NOT A REQUEST AT ALL\r\n\r\n")
    assert reply.startswith(b"HTTP/1.0 400")
    assert reply.endswith(b"\r\n\r\n")


def test_socket_timeout_is_5_s() -> None:
    assert WakeRequestHandler.timeout == SOCKET_TIMEOUT_S == 5


def test_connections_over_the_concurrency_cap_are_closed(service) -> None:
    import threading

    server = make_server("127.0.0.1", 0, service, max_concurrent=1)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    try:
        assert server._slots.acquire(blocking=False)  # take the only slot
        reply = raw_request(server.server_address, b"GET /health HTTP/1.0\r\n\r\n")
        assert reply == b""
        server._slots.release()
        status, _, _ = request(server.server_address, "GET", "/health")
        assert status == 200
    finally:
        server.shutdown()
        server.server_close()
        thread.join(5)


def run_server(service, max_concurrent):
    import threading

    server = make_server("127.0.0.1", 0, service, max_concurrent=max_concurrent)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
    thread.start()
    return server, thread


def stop_server(server, thread) -> None:
    server.shutdown()
    server.server_close()
    thread.join(5)


def test_two_authorization_headers_401_over_http(http_server, sender: FakeSender) -> None:
    line = "Authorization: Bearer " + TOKEN.decode() + "\r\n"
    reply = raw_request(http_server, ("POST /wake HTTP/1.1\r\nHost: x\r\n" + line + line + "\r\n").encode())
    assert reply.startswith(b"HTTP/1.0 401")
    assert sender.payloads == []


def test_slots_are_released_after_many_requests(service) -> None:
    server, thread = run_server(service, max_concurrent=2)
    try:
        for _ in range(25):
            assert request(server.server_address, "GET", "/health")[0] == 200
        assert request(server.server_address, "GET", "/nope")[0] == 404
        assert raw_request(server.server_address, b"garbage\r\n\r\n").startswith(b"HTTP/1.0 400")
        assert request(server.server_address, "GET", "/health")[0] == 200
    finally:
        stop_server(server, thread)


def wait_for_slot(addr, limit_s: float) -> float:
    """Seconds until a /health request on a 1-slot server is answered again."""
    import time

    start = time.monotonic()
    while time.monotonic() - start < limit_s:
        try:
            if request(addr, "GET", "/health")[0] == 200:
                return time.monotonic() - start
        except (OSError, http.client.HTTPException):
            pass
        time.sleep(0.05)
    return float("inf")


def test_slow_client_is_cut_at_the_connection_deadline(service, monkeypatch) -> None:
    import time

    monkeypatch.setattr(WakeRequestHandler, "connection_deadline_s", 0.6)
    server, thread = run_server(service, max_concurrent=1)
    try:
        slow = socket.create_connection(server.server_address, timeout=5)
        slow.sendall(b"GET /hea")  # never finishes the request line
        time.sleep(0.1)
        start = time.monotonic()
        slow.settimeout(3)
        try:
            data = slow.recv(100)  # the server shuts the socket down at the deadline
        except (ConnectionResetError, ConnectionAbortedError):
            data = b""
        assert data == b"" or data.startswith(b"HTTP/1.0 400")
        assert time.monotonic() - start < 2
        slow.close()
        assert wait_for_slot(server.server_address, 3) < 3
    finally:
        stop_server(server, thread)


def test_lingering_close_is_bounded_in_total(service) -> None:
    import threading
    import time

    server, thread = run_server(service, max_concurrent=1)
    stop = threading.Event()
    try:
        trickle = socket.create_connection(server.server_address, timeout=5)
        trickle.sendall(b"GET /health HTTP/1.0\r\n\r\n")
        assert trickle.recv(4096).startswith(b"HTTP/1.0 200")

        def keep_sending() -> None:  # one byte every 50 ms: each read gap is far below LINGER_S
            try:
                while not stop.is_set():
                    trickle.send(b"x")
                    time.sleep(0.05)
            except OSError:
                pass

        threading.Thread(target=keep_sending, daemon=True).start()
        assert wait_for_slot(server.server_address, 3) < 2  # LINGER_S = 0.5 total, not per read
    finally:
        stop.set()
        trickle.close()
        stop_server(server, thread)


def test_request_cut_at_the_deadline_is_not_acted_on(service, sender: FakeSender, monkeypatch) -> None:
    """A /wake whose body never completes before the deadline sends nothing.

    (On Linux the cut read returns EOF; on Windows it raises. Both must end
    without a packet.)
    """
    import time

    monkeypatch.setattr(WakeRequestHandler, "connection_deadline_s", 0.4)
    server, thread = run_server(service, max_concurrent=1)
    try:
        sock = socket.create_connection(server.server_address, timeout=5)
        sock.sendall((
            "POST /wake HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer " + TOKEN.decode() +
            "\r\nContent-Length: 10\r\n\r\nab"
        ).encode())
        time.sleep(1.0)
        sock.close()
        assert wait_for_slot(server.server_address, 3) < 3
        assert sender.payloads == []
    finally:
        stop_server(server, thread)
