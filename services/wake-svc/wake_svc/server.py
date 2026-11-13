"""wake-svc: one HTTP endpoint that sends a Wake-on-LAN magic packet (docs/12, D1).

Python standard library only, so the file runs as-is on the always-on box
(``python3 -m wake_svc.server`` or ``python3 wake_svc/server.py``).

* ``POST /wake`` with ``Authorization: Bearer <wake token>`` sends the magic
  packet for the **one** MAC from the configuration. The request body and the
  query string are read (bounded) and ignored: no MAC, address or port is ever
  taken from a request.
* ``GET /health`` says the service is up (no MAC, no target, no counters).
* Everything else: ``404`` / ``405`` with an empty body.

Configuration comes from the environment (see ``load_config`` and the
README); the token comes from a file (systemd ``LoadCredential=``), never from
an environment variable. Startup refuses a bad MAC, a short token and a
wildcard bind address (exit code 1).
"""

from __future__ import annotations

import base64
import binascii
import collections
import hmac
import http.client
import ipaddress
import json
import math
import os
import re
import signal
import socket
import socketserver
import sys
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Iterable, Mapping, Optional, Sequence

VERSION = "0.1.0"
SERVICE = "wake-svc"

DEFAULT_PORT = 8704
WOL_PORT = 9  # UDP "discard"; what Wake-on-LAN senders use by convention
PACKET_REPEATS = 3
PACKET_INTERVAL_S = 0.1
MAX_BROADCASTS = 8

MIN_TOKEN_BYTES = 32  # decoded length of the base64url token
MAX_TOKEN_FILE_BYTES = 4096
TOKEN_CREDENTIAL_NAME = "wake-token"

# Server hardening (docs/12, D1)
SOCKET_TIMEOUT_S = 5  # per read/write on the connection socket
CONNECTION_DEADLINE_S = 10.0  # whole connection, answer and lingering close included (slowloris cap)
MAX_CONCURRENT_REQUESTS = 8
MAX_HEADER_BYTES = 8 * 1024  # request line + headers
MAX_BODY_BYTES = 1024  # read at most this much of a body, then discard it
LINGER_S = 0.5  # after answering, drain what the client still sends for at most this long
LINGER_MAX_BYTES = 64 * 1024

# Rate limits (docs/12, D1)
WAKE_MIN_INTERVAL_S = 10.0
WAKE_HOURLY_MAX = 20
WAKE_HOUR_S = 3600.0
AUTH_FAIL_WINDOW_S = 60.0
AUTH_FAIL_MAX = 5
AUTH_LOCKOUT_S = 300.0
AUTH_TABLE_MAX = 1024

_MAC_RE = re.compile(r"^[0-9A-Fa-f]{2}([:-])[0-9A-Fa-f]{2}(?:\1[0-9A-Fa-f]{2}){4}$")
_TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]+={0,2}$")


# --------------------------------------------------------------------------- config


class ConfigError(ValueError):
    """Invalid configuration. The message never contains the token or the MAC."""


@dataclass(frozen=True)
class Config:
    mac: bytes
    broadcasts: tuple[str, ...]
    source_addr: str
    bind: str
    port: int
    token: bytes

    def __repr__(self) -> str:  # keep the token and the MAC out of any accidental print
        return (
            f"Config(bind={self.bind!r}, port={self.port}, "
            f"broadcasts={len(self.broadcasts)}, source_addr={self.source_addr!r})"
        )


def parse_mac(text: str) -> bytes:
    """``aa:bb:cc:dd:ee:ff`` or ``AA-BB-CC-DD-EE-FF`` (one separator throughout, any case).

    Refuses the all-zero address and group (multicast/broadcast) addresses: a
    network card's own address is always a unicast one.
    """
    text = (text or "").strip()
    if not _MAC_RE.match(text):
        raise ConfigError(
            "WAKE_MAC is missing or not a MAC address "
            "(expected six hex pairs separated by ':' or '-')"
        )
    mac = bytes.fromhex(text.replace(":", "").replace("-", ""))
    if mac == bytes(6):
        raise ConfigError("WAKE_MAC must not be the all-zero address")
    if mac[0] & 0x01:
        raise ConfigError("WAKE_MAC must be a unicast address (it is a multicast/broadcast one)")
    return mac


def magic_packet(mac: bytes) -> bytes:
    """6 x 0xFF followed by the MAC 16 times (102 bytes)."""
    if len(mac) != 6:
        raise ValueError("a MAC address has 6 bytes")
    return b"\xff" * 6 + mac * 16


def _parse_ipv4(name: str, text: str) -> ipaddress.IPv4Address:
    text = (text or "").strip()
    try:
        addr = ipaddress.ip_address(text)
    except ValueError:
        raise ConfigError(f"{name} must be an IPv4 address") from None
    if not isinstance(addr, ipaddress.IPv4Address):
        if addr.is_unspecified:
            raise ConfigError(f"{name} must not be a wildcard address")
        raise ConfigError(f"{name} must be an IPv4 address (IPv6 is not supported)")
    return addr


def parse_bind(text: str) -> str:
    """The box's LAN address. Wildcards (``0.0.0.0``, ``::``, empty) are refused."""
    if not (text or "").strip():
        raise ConfigError("WAKE_BIND is required (the box's LAN address; a wildcard is not allowed)")
    addr = _parse_ipv4("WAKE_BIND", text)
    if addr.is_unspecified:
        raise ConfigError("WAKE_BIND must not be a wildcard address; use the box's LAN address")
    if addr.is_multicast or addr == ipaddress.IPv4Address("255.255.255.255"):
        raise ConfigError("WAKE_BIND must be a unicast address")
    return str(addr)


def parse_source_addr(text: str) -> str:
    addr = _parse_ipv4("WAKE_SOURCE_ADDR", text)
    if addr.is_unspecified or addr.is_multicast or addr == ipaddress.IPv4Address("255.255.255.255"):
        raise ConfigError("WAKE_SOURCE_ADDR must be the LAN interface's own (unicast) address")
    return str(addr)


def parse_port(text: str) -> int:
    text = (text or "").strip()
    if not text.isdigit() or not 1 <= int(text) <= 65535:
        raise ConfigError("WAKE_PORT must be a number from 1 to 65535")
    return int(text)


def parse_broadcasts(text: str) -> tuple[str, ...]:
    """Comma list of IPv4 broadcast addresses (e.g. the LAN's subnet-directed broadcast)."""
    items = [part.strip() for part in (text or "").split(",") if part.strip()]
    if not items:
        raise ConfigError("WAKE_BROADCASTS is required (comma list of IPv4 broadcast addresses)")
    result: list[str] = []
    for item in items:
        addr = _parse_ipv4("WAKE_BROADCASTS", item)
        if addr.is_unspecified or addr.is_multicast:
            raise ConfigError("WAKE_BROADCASTS: a wildcard or multicast address is not a broadcast address")
        if str(addr) not in result:
            result.append(str(addr))
    if len(result) > MAX_BROADCASTS:
        raise ConfigError(f"WAKE_BROADCASTS: at most {MAX_BROADCASTS} addresses")
    return tuple(result)


def parse_token(raw: bytes) -> bytes:
    """A base64url token of at least 32 random bytes; surrounding whitespace is ignored.

    Returns the token text as ASCII bytes (what the client sends), not the
    decoded bytes.
    """
    text = raw.strip()
    if not text:
        raise ConfigError("the wake token is empty")
    try:
        ascii_text = text.decode("ascii")
    except UnicodeDecodeError:
        raise ConfigError("the wake token must be base64url text") from None
    if not _TOKEN_RE.match(ascii_text):
        raise ConfigError("the wake token must be base64url text (A-Z a-z 0-9 - _)")
    unpadded = ascii_text.rstrip("=")
    try:
        decoded = base64.urlsafe_b64decode(unpadded + "=" * (-len(unpadded) % 4))
    except (binascii.Error, ValueError):
        raise ConfigError("the wake token is not valid base64url") from None
    if len(decoded) < MIN_TOKEN_BYTES:
        raise ConfigError(
            f"the wake token is too short (needs at least {MIN_TOKEN_BYTES} random bytes, "
            "e.g. python3 -c \"import secrets; print(secrets.token_urlsafe(32))\")"
        )
    return text


def token_path(env: Mapping[str, str]) -> str:
    """``WAKE_TOKEN_FILE`` if set, else ``$CREDENTIALS_DIRECTORY/wake-token`` (systemd)."""
    explicit = (env.get("WAKE_TOKEN_FILE") or "").strip()
    if explicit:
        return explicit
    cred_dir = (env.get("CREDENTIALS_DIRECTORY") or "").strip()
    if cred_dir:
        return os.path.join(cred_dir, TOKEN_CREDENTIAL_NAME)
    raise ConfigError(
        "no wake token: set WAKE_TOKEN_FILE, or run under systemd with "
        f"LoadCredential={TOKEN_CREDENTIAL_NAME}:<file>"
    )


def read_token_file(path: str) -> bytes:
    try:
        with open(path, "rb") as fh:
            raw = fh.read(MAX_TOKEN_FILE_BYTES + 1)
    except OSError as exc:
        raise ConfigError(f"cannot read the wake token file ({exc.strerror or type(exc).__name__})") from None
    if len(raw) > MAX_TOKEN_FILE_BYTES:
        raise ConfigError("the wake token file is too large")
    return raw


def load_config(env: Mapping[str, str], read_file: Callable[[str], bytes] = read_token_file) -> Config:
    if (env.get("WAKE_TOKEN") or "").strip():
        raise ConfigError("WAKE_TOKEN is not read (environment is visible to other tools); use a token file")
    mac = parse_mac(env.get("WAKE_MAC", ""))
    bind = parse_bind(env.get("WAKE_BIND", ""))
    port = parse_port(env.get("WAKE_PORT") or str(DEFAULT_PORT))
    broadcasts = parse_broadcasts(env.get("WAKE_BROADCASTS", ""))
    source_addr = parse_source_addr(env.get("WAKE_SOURCE_ADDR") or bind)
    token = parse_token(read_file(token_path(env)))
    return Config(mac=mac, broadcasts=broadcasts, source_addr=source_addr, bind=bind, port=port, token=token)


# --------------------------------------------------------------------------- sending


class PacketSender:
    """Sends a payload as UDP broadcast, ``repeats`` times ``interval_s`` apart, to each address.

    The socket is bound to ``source_addr`` so the packet leaves on the LAN
    interface (not e.g. ``tailscale0``). Returns the number of datagrams handed
    to the network stack; raises ``OSError`` if none could be sent. A failing
    address does not stop the others.
    """

    def __init__(
        self,
        broadcasts: Sequence[str],
        source_addr: str,
        port: int = WOL_PORT,
        repeats: int = PACKET_REPEATS,
        interval_s: float = PACKET_INTERVAL_S,
        sleep: Callable[[float], None] = time.sleep,
        socket_factory: Callable[..., socket.socket] = socket.socket,
    ) -> None:
        self._broadcasts = tuple(broadcasts)
        self._source_addr = source_addr
        self._port = port
        self._repeats = repeats
        self._interval_s = interval_s
        self._sleep = sleep
        self._socket_factory = socket_factory

    def __call__(self, payload: bytes) -> int:
        sent = 0
        last_error: Optional[OSError] = None
        with self._socket_factory(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
            sock.bind((self._source_addr, 0))
            for round_no in range(self._repeats):
                if round_no:
                    self._sleep(self._interval_s)
                for target in self._broadcasts:
                    try:
                        sock.sendto(payload, (target, self._port))
                        sent += 1
                    except OSError as exc:
                        last_error = exc
        if sent == 0:
            raise last_error or OSError("no datagram sent")
        return sent


# --------------------------------------------------------------------------- rate limits


class _AuthEntry:
    __slots__ = ("failures", "locked_until")

    def __init__(self) -> None:
        self.failures: collections.deque[float] = collections.deque()
        self.locked_until = 0.0


class RateLimiter:
    """In-memory limits behind one lock; every method is an atomic check-and-set.

    * accepted wakes (global, there is one target): one per ``WAKE_MIN_INTERVAL_S``
      and ``WAKE_HOURLY_MAX`` per sliding hour;
    * failed authentications per source address: ``AUTH_FAIL_MAX`` within
      ``AUTH_FAIL_WINDOW_S`` locks that address for ``AUTH_LOCKOUT_S``. The
      table holds at most ``table_max`` addresses (least recently failed dropped
      first). Failures never touch the wake budget.
    """

    def __init__(self, table_max: int = AUTH_TABLE_MAX) -> None:
        self._lock = threading.Lock()
        self._wakes: collections.deque[float] = collections.deque()
        self._auth: collections.OrderedDict[str, _AuthEntry] = collections.OrderedDict()
        self._table_max = table_max

    def auth_lockout(self, src: str, now: float) -> Optional[float]:
        """Seconds left if ``src`` is locked out, else ``None``."""
        with self._lock:
            entry = self._auth.get(src)
            if entry is not None and entry.locked_until > now:
                return entry.locked_until - now
            return None

    def auth_failed(self, src: str, now: float) -> bool:
        """Records a failure; returns ``True`` if this failure locked the address."""
        with self._lock:
            entry = self._auth.pop(src, None)
            if entry is None or (entry.locked_until and entry.locked_until <= now):
                entry = _AuthEntry()
            while entry.failures and entry.failures[0] <= now - AUTH_FAIL_WINDOW_S:
                entry.failures.popleft()
            entry.failures.append(now)
            locked = False
            if len(entry.failures) >= AUTH_FAIL_MAX:
                entry.failures.clear()
                entry.locked_until = now + AUTH_LOCKOUT_S
                locked = True
            self._auth[src] = entry  # (re)inserted last = most recent
            while len(self._auth) > self._table_max:
                self._auth.popitem(last=False)
            return locked

    def reserve_wake(self, now: float) -> Optional[tuple[float, str]]:
        """Takes one wake from the budget.

        Returns ``None`` on success, else ``(seconds to wait, "interval" | "hourly")``.
        """
        with self._lock:
            while self._wakes and self._wakes[0] <= now - WAKE_HOUR_S:
                self._wakes.popleft()
            waits: list[tuple[float, str]] = []
            if self._wakes and now - self._wakes[-1] < WAKE_MIN_INTERVAL_S:
                waits.append((WAKE_MIN_INTERVAL_S - (now - self._wakes[-1]), "interval"))
            if len(self._wakes) >= WAKE_HOURLY_MAX:
                waits.append((self._wakes[0] + WAKE_HOUR_S - now, "hourly"))
            if waits:
                return max(waits)  # both may apply: report the longer wait, so one retry suffices
            self._wakes.append(now)
            return None

    def refund_wake(self, stamp: float) -> None:
        """Gives back a reservation whose packet never left (send failed).

        Known, accepted side effect: a second request that arrived while the
        failing send was in progress already got ``429 interval`` although no
        packet went out (needs two presses within ~0.3 s).
        """
        with self._lock:
            try:
                self._wakes.remove(stamp)
            except ValueError:
                pass

    def auth_table_size(self) -> int:
        with self._lock:
            return len(self._auth)


# --------------------------------------------------------------------------- service logic


def _retry_seconds(seconds: float) -> int:
    return max(1, math.ceil(seconds))


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


class JsonLog:
    """One JSON object per line on stdout (journald). Callers never pass the token or the MAC."""

    def __init__(self, stream=None) -> None:
        self._stream = stream
        self._lock = threading.Lock()

    def __call__(self, record: dict) -> None:
        line = json.dumps({"ts": _utc_now(), **record}, separators=(",", ":"))
        with self._lock:
            stream = self._stream or sys.stdout
            stream.write(line + "\n")
            stream.flush()


Response = tuple[int, Optional[dict], list[tuple[str, str]]]


class WakeService:
    """The ``POST /wake`` decision, independent of HTTP (unit-testable with a fake clock)."""

    def __init__(
        self,
        token: bytes,
        mac: bytes,
        sender: Callable[[bytes], int],
        clock: Callable[[], float] = time.monotonic,
        limiter: Optional[RateLimiter] = None,
        log: Optional[Callable[[dict], None]] = None,
        compare: Callable[[bytes, bytes], bool] = hmac.compare_digest,
    ) -> None:
        self._token = token
        self._packet = magic_packet(mac)
        self._sender = sender
        self._clock = clock
        self.limiter = limiter if limiter is not None else RateLimiter()
        self.log = log if log is not None else JsonLog()
        self._compare = compare

    def token_ok(self, authorization: Sequence[str]) -> bool:
        """Exactly one ``Authorization: Bearer <token>`` header, compared in constant time."""
        if len(authorization) != 1:
            return False
        scheme, _, credentials = authorization[0].strip().partition(" ")
        if scheme.lower() != "bearer":
            return False
        provided = credentials.strip().encode("utf-8", "replace")
        return self._compare(provided, self._token)

    def handle_wake(self, src: str, authorization: Sequence[str]) -> Response:
        now = self._clock()

        locked_for = self.limiter.auth_lockout(src, now)
        if locked_for is not None:
            return self._rate_limited(src, locked_for, "auth_lockout")

        if not self.token_ok(authorization):
            locked = self.limiter.auth_failed(src, now)
            self.log({"event": "auth_failed", "src": src, "status": 401, "locked": locked})
            return 401, {"error": "unauthorized"}, [("WWW-Authenticate", "Bearer")]

        refused = self.limiter.reserve_wake(now)
        if refused is not None:
            wait, reason = refused
            return self._rate_limited(src, wait, reason)

        try:
            sent = self._sender(self._packet)
        except Exception as exc:  # noqa: BLE001 - any sender failure is "send_failed", never a lost answer
            self.limiter.refund_wake(now)
            self.log({"event": "send_failed", "src": src, "status": 503,
                      "errno": getattr(exc, "errno", None), "error": type(exc).__name__})
            return 503, {"error": "send_failed"}, []
        self.log({"event": "wake_sent", "src": src, "status": 202, "datagrams": sent})
        return 202, {"sent": True}, []

    def _rate_limited(self, src: str, seconds: float, reason: str) -> Response:
        retry = _retry_seconds(seconds)
        self.log({"event": "rate_limited", "src": src, "status": 429, "reason": reason, "retryAfterS": retry})
        return 429, {"error": "rate_limited", "retryAfterS": retry}, [("Retry-After", str(retry))]


# --------------------------------------------------------------------------- HTTP


class _HeaderBudget:
    """Wraps ``rfile`` while headers are parsed; past the budget ``http.server`` answers 431."""

    def __init__(self, raw, budget: int) -> None:
        self._raw = raw
        self._left = budget

    def readline(self, size: int = -1) -> bytes:
        limit = self._left + 1
        if size is not None and size >= 0:
            limit = min(limit, size)
        line = self._raw.readline(limit)
        self._left -= len(line)
        if self._left < 0:
            raise http.client.LineTooLong("header")
        return line


class WakeRequestHandler(BaseHTTPRequestHandler):
    server_version = SERVICE
    sys_version = ""
    timeout = SOCKET_TIMEOUT_S  # applied to the connection socket by StreamRequestHandler
    connection_deadline_s = CONNECTION_DEADLINE_S
    # Error answers to malformed requests carry a status line (the base class default,
    # HTTP/0.9, would send a bare body, here: nothing).
    default_request_version = "HTTP/1.0"
    server: "WakeHTTPServer"

    def version_string(self) -> str:
        return SERVICE  # no Python / service version in the Server header

    def log_message(self, format: str, *args) -> None:  # noqa: A002 - base class signature
        pass  # the default prints the request line (path, query) to stderr; WakeService logs instead

    def setup(self) -> None:
        """Starts a watchdog that shuts the socket down at the connection deadline.

        ``timeout`` only bounds each single read; a client trickling one byte
        every few seconds would otherwise hold one of the few request slots for
        hours. Shutting the socket down makes the blocked read return at once.
        """
        super().setup()
        self._expired = False
        self._deadline = time.monotonic() + self.connection_deadline_s
        self._watchdog = threading.Timer(self.connection_deadline_s, self._expire)
        self._watchdog.daemon = True
        self._watchdog.start()

    def _expire(self) -> None:
        self._expired = True
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def handle_one_request(self) -> None:
        """Like the base class, but with an 8 KB cap on request line + headers and one request per connection."""
        try:
            self.raw_requestline = self.rfile.readline(MAX_HEADER_BYTES + 1)
            if len(self.raw_requestline) > MAX_HEADER_BYTES:
                self.requestline = ""
                self.request_version = ""
                self.command = ""
                self.send_error(HTTPStatus.REQUEST_URI_TOO_LONG)
                return
            if not self.raw_requestline:
                self.close_connection = True
                return
            raw = self.rfile
            self.rfile = _HeaderBudget(raw, MAX_HEADER_BYTES - len(self.raw_requestline))
            try:
                parsed = self.parse_request()
            finally:
                self.rfile = raw
            if not parsed or self._past_deadline():
                return
            self.close_connection = True
            self._route()
            self.wfile.flush()
        except TimeoutError:
            self.close_connection = True

    def finish(self) -> None:
        """Lingering close: stop sending, then briefly read and drop what the client still sends.

        Without it, closing a socket that has unread data (an oversized header or
        body) sends a TCP reset, and some clients (Windows in particular) then
        lose the answer that was already sent. Bounded in total by ``LINGER_S``
        (and the connection deadline) and by ``LINGER_MAX_BYTES``.
        """
        try:
            super().finish()
            self.connection.shutdown(socket.SHUT_WR)
            end = min(time.monotonic() + LINGER_S, self._deadline)
            left = LINGER_MAX_BYTES
            while left > 0:
                remaining = end - time.monotonic()
                if remaining <= 0:
                    break
                self.connection.settimeout(remaining)
                chunk = self.connection.recv(min(4096, left))
                if not chunk:
                    break
                left -= len(chunk)
        except OSError:
            pass
        finally:
            self._watchdog.cancel()

    def _past_deadline(self) -> bool:
        """True once the watchdog cut the connection.

        After ``shutdown`` a blocked read returns EOF (Linux), which the header
        parser takes as the end of the headers: a cut-off request must not be
        acted on (it would send a packet whose answer can no longer be written).
        """
        return self._expired or time.monotonic() >= self._deadline

    def send_error(self, code, message=None, explain=None) -> None:
        self.close_connection = True
        self._send(int(code), None)

    def _route(self) -> None:
        path = self.path.split("?", 1)[0]  # the query string is ignored
        if path == "/health":
            if self.command != "GET":
                self._send(405, None, [("Allow", "GET")])
                return
            self._send(200, {"status": "ok", "service": SERVICE, "version": VERSION})
            return
        if path == "/wake":
            if self.command != "POST":
                self._send(405, None, [("Allow", "POST")])
                return
            self._discard_body()
            if self._past_deadline():
                self.close_connection = True
                return
            status, body, headers = self.server.wake.handle_wake(
                self.client_address[0], self.headers.get_all("Authorization") or []
            )
            self._send(status, body, headers)
            return
        self._send(404, None)

    def _discard_body(self) -> None:
        """Reads at most ``MAX_BODY_BYTES`` of the body and throws it away."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        length = max(0, min(length, MAX_BODY_BYTES))
        if length:
            self.rfile.read(length)

    def _send(self, status: int, body: Optional[dict], headers: Iterable[tuple[str, str]] = ()) -> None:
        data = b"" if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        if body is not None:
            self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        for name, value in headers:
            self.send_header(name, value)
        self.end_headers()
        if data and self.command != "HEAD":
            self.wfile.write(data)


class WakeHTTPServer(ThreadingHTTPServer):
    """Thread per request, at most ``max_concurrent`` at once (extra connections are closed unanswered)."""

    daemon_threads = True

    def __init__(self, address: tuple[str, int], service: WakeService, max_concurrent: int = MAX_CONCURRENT_REQUESTS):
        self.wake = service
        self._slots = threading.BoundedSemaphore(max_concurrent)
        super().__init__(address, WakeRequestHandler)

    def server_bind(self) -> None:
        # HTTPServer.server_bind would do a reverse DNS lookup (getfqdn); not needed.
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = port

    def process_request(self, request, client_address) -> None:
        if not self._slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._slots.release()
            raise

    def process_request_thread(self, request, client_address) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()

    def handle_error(self, request, client_address) -> None:
        exc = sys.exc_info()[1]
        if isinstance(exc, OSError):
            return  # the client went away / the deadline closed the socket: not an internal error
        self.wake.log({"event": "internal_error", "src": client_address[0], "error": type(exc).__name__})


def make_server(bind: str, port: int, service: WakeService, max_concurrent: int = MAX_CONCURRENT_REQUESTS) -> WakeHTTPServer:
    return WakeHTTPServer((bind, port), service, max_concurrent)


# --------------------------------------------------------------------------- entry point


def main(env: Optional[Mapping[str, str]] = None) -> int:
    env = os.environ if env is None else env
    try:
        config = load_config(env)
    except ConfigError as exc:
        print(f"{SERVICE}: {exc}", file=sys.stderr)
        return 1
    log = JsonLog()
    sender = PacketSender(config.broadcasts, config.source_addr)
    service = WakeService(config.token, config.mac, sender, log=log)
    try:
        server = make_server(config.bind, config.port, service)
    except OSError as exc:
        print(f"{SERVICE}: cannot listen on {config.bind}:{config.port} ({exc.strerror or exc})", file=sys.stderr)
        return 1

    def _stop(signum, frame):  # systemd sends SIGTERM
        raise SystemExit(0)

    signal.signal(signal.SIGTERM, _stop)
    log({"event": "started", "version": VERSION, "bind": config.bind, "port": config.port,
         "broadcasts": len(config.broadcasts)})
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
