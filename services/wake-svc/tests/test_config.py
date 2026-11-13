"""Startup configuration: MAC parsing, packet bytes, token file, bind/broadcast validation, exit code."""

from __future__ import annotations

import base64
import os

import pytest

from conftest import MAC, MAC_TEXT, TOKEN
from wake_svc import server
from wake_svc.server import (
    ConfigError,
    DEFAULT_PORT,
    load_config,
    magic_packet,
    parse_bind,
    parse_broadcasts,
    parse_mac,
    parse_port,
    parse_token,
    token_path,
)


def base_env(**overrides: str) -> dict[str, str]:
    env = {
        "WAKE_MAC": MAC_TEXT,
        "WAKE_BIND": "192.0.2.10",
        "WAKE_BROADCASTS": "192.0.2.255",
        "WAKE_TOKEN_FILE": "/fake/wake-token",
    }
    env.update(overrides)
    return {k: v for k, v in env.items() if v is not None}


def fake_read(content: bytes = TOKEN + b"\n"):
    seen: list[str] = []

    def read(path: str) -> bytes:
        seen.append(path)
        return content

    read.seen = seen  # type: ignore[attr-defined]
    return read


# ------------------------------------------------------------------ MAC and packet


@pytest.mark.parametrize(
    "text",
    ["02:00:00:aa:bb:cc", "02:00:00:AA:BB:CC", "02-00-00-aa-bb-cc", "02-00-00-AA-bb-Cc", "  02:00:00:aa:bb:cc\n"],
)
def test_parse_mac_accepts_colon_dash_and_any_case(text: str) -> None:
    assert parse_mac(text) == MAC


@pytest.mark.parametrize(
    "text",
    [
        "",
        "020000aabbcc",  # no separator
        "02:00:00:aa:bb",  # five pairs
        "02:00:00:aa:bb:cc:dd",  # seven pairs
        "02:00:00-aa:bb:cc",  # mixed separators
        "02.00.00.aa.bb.cc",
        "02:00:00:aa:bb:cg",  # not hex
        "2:00:00:aa:bb:cc",  # one digit
        "00:00:00:00:00:00",  # all zero
        "ff:ff:ff:ff:ff:ff",  # broadcast
        "01:00:5e:00:00:01",  # multicast
    ],
)
def test_parse_mac_rejects(text: str) -> None:
    with pytest.raises(ConfigError):
        parse_mac(text)


def test_mac_error_does_not_echo_the_value() -> None:
    with pytest.raises(ConfigError) as err:
        parse_mac("02:00:00:aa:bb:zz")
    assert "aa:bb" not in str(err.value)


def test_magic_packet_bytes_for_a_known_mac() -> None:
    packet = magic_packet(MAC)
    assert len(packet) == 102
    assert packet[:6] == b"\xff\xff\xff\xff\xff\xff"
    assert packet == bytes.fromhex("ffffffffffff" + "020000aabbcc" * 16)


def test_magic_packet_needs_six_bytes() -> None:
    with pytest.raises(ValueError):
        magic_packet(b"\x02\x00")


# ------------------------------------------------------------------ token


def test_token_of_32_random_bytes_is_accepted_and_whitespace_stripped() -> None:
    assert parse_token(b"  " + TOKEN + b"\r\n") == TOKEN


def test_padded_base64url_token_is_accepted() -> None:
    padded = base64.urlsafe_b64encode(os.urandom(32))  # 44 chars ending in '='
    assert parse_token(padded) == padded


@pytest.mark.parametrize(
    "raw",
    [
        b"",
        b"   \n",
        base64.urlsafe_b64encode(os.urandom(31)).rstrip(b"="),  # 31 bytes: too short
        b"short",
        TOKEN[:-2] + b"+/",  # standard base64 alphabet, not base64url
        TOKEN[:20] + b" " + TOKEN[20:],  # inner space
        "ä".encode("utf-8") + TOKEN,  # not ASCII
    ],
)
def test_bad_tokens_are_refused(raw: bytes) -> None:
    with pytest.raises(ConfigError) as err:
        parse_token(raw)
    if len(raw.strip()) > 10:  # the message never echoes the token
        assert raw.strip().decode("utf-8", "replace") not in str(err.value)


def test_token_path_prefers_explicit_file_then_systemd_credentials() -> None:
    assert token_path({"WAKE_TOKEN_FILE": "/a/b", "CREDENTIALS_DIRECTORY": "/run/cred"}) == "/a/b"
    assert token_path({"CREDENTIALS_DIRECTORY": "/run/cred"}) == os.path.join("/run/cred", "wake-token")
    with pytest.raises(ConfigError):
        token_path({})


def test_token_file_is_read_from_disk(tmp_path) -> None:
    path = tmp_path / "wake-token"
    path.write_bytes(TOKEN + b"\n")
    config = load_config(base_env(WAKE_TOKEN_FILE=str(path)))
    assert config.token == TOKEN


def test_missing_token_file_is_a_config_error(tmp_path) -> None:
    with pytest.raises(ConfigError):
        load_config(base_env(WAKE_TOKEN_FILE=str(tmp_path / "missing")))


def test_oversized_token_file_is_refused(tmp_path) -> None:
    path = tmp_path / "wake-token"
    path.write_bytes(b"A" * 5000)
    with pytest.raises(ConfigError):
        load_config(base_env(WAKE_TOKEN_FILE=str(path)))


def test_token_in_environment_is_refused() -> None:
    with pytest.raises(ConfigError):
        load_config(base_env(WAKE_TOKEN=TOKEN.decode()), read_file=fake_read())


# ------------------------------------------------------------------ bind, port, broadcasts


@pytest.mark.parametrize("text", ["0.0.0.0", "::", "", "  ", "0.0.0.0 "])
def test_wildcard_bind_is_refused(text: str) -> None:
    with pytest.raises(ConfigError):
        parse_bind(text)


@pytest.mark.parametrize("text", ["localhost", "box.lan", "192.0.2", "2001:db8::1", "255.255.255.255", "224.0.0.1"])
def test_bind_must_be_a_unicast_ipv4_literal(text: str) -> None:
    with pytest.raises(ConfigError):
        parse_bind(text)


def test_bind_accepts_a_lan_address() -> None:
    assert parse_bind(" 192.0.2.10 ") == "192.0.2.10"


@pytest.mark.parametrize("text", ["0", "65536", "-1", "abc", "80a"])
def test_bad_port_is_refused(text: str) -> None:
    with pytest.raises(ConfigError):
        parse_port(text)


def test_broadcast_list_is_parsed_trimmed_and_deduplicated() -> None:
    assert parse_broadcasts(" 192.0.2.255 , 255.255.255.255,192.0.2.255,") == ("192.0.2.255", "255.255.255.255")


@pytest.mark.parametrize("text", ["", " , ", "192.0.2.256", "box.lan", "0.0.0.0", "2001:db8::ff", "224.0.0.1"])
def test_bad_broadcasts_are_refused(text: str) -> None:
    with pytest.raises(ConfigError):
        parse_broadcasts(text)


def test_too_many_broadcasts_are_refused() -> None:
    with pytest.raises(ConfigError):
        parse_broadcasts(",".join(f"192.0.2.{i}" for i in range(1, 11)))


# ------------------------------------------------------------------ load_config / main


def test_load_config_defaults() -> None:
    read = fake_read()
    config = load_config(base_env(), read_file=read)
    assert config.mac == MAC
    assert config.bind == "192.0.2.10"
    assert config.port == DEFAULT_PORT
    assert config.broadcasts == ("192.0.2.255",)
    assert config.source_addr == "192.0.2.10"  # defaults to the bind address
    assert config.token == TOKEN
    assert read.seen == ["/fake/wake-token"]


def test_load_config_explicit_port_and_source() -> None:
    config = load_config(base_env(WAKE_PORT="9100", WAKE_SOURCE_ADDR="192.0.2.11"), read_file=fake_read())
    assert config.port == 9100
    assert config.source_addr == "192.0.2.11"


def test_wildcard_source_is_refused() -> None:
    with pytest.raises(ConfigError):
        load_config(base_env(WAKE_SOURCE_ADDR="0.0.0.0"), read_file=fake_read())


def test_config_repr_hides_token_and_mac() -> None:
    text = repr(load_config(base_env(), read_file=fake_read()))
    assert TOKEN.decode() not in text
    assert "aa:bb:cc" not in text.lower() and "020000aabbcc" not in text.lower()


@pytest.mark.parametrize(
    "env",
    [
        base_env(WAKE_MAC="02:00:00:aa:bb"),  # bad MAC
        base_env(WAKE_MAC=None),
        base_env(WAKE_BIND="0.0.0.0"),  # wildcard bind
        base_env(WAKE_BIND=None),
        base_env(WAKE_BROADCASTS=None),
        base_env(WAKE_TOKEN_FILE=None),  # no token source at all
    ],
)
def test_main_exits_1_on_bad_config(env, capsys) -> None:
    assert server.main(env) == 1
    err = capsys.readouterr().err
    assert err.startswith("wake-svc: ")
    assert TOKEN.decode() not in err


def test_main_exits_1_on_short_token(tmp_path, capsys) -> None:
    path = tmp_path / "wake-token"
    short = base64.urlsafe_b64encode(os.urandom(16)).rstrip(b"=")  # valid base64url, 16 bytes
    path.write_bytes(short)
    assert server.main(base_env(WAKE_TOKEN_FILE=str(path))) == 1
    err = capsys.readouterr().err
    assert "too short" in err
    assert short.decode() not in err


@pytest.mark.parametrize("name", ["WAKE_BIND", "WAKE_BROADCASTS", "WAKE_SOURCE_ADDR", "WAKE_PORT"])
def test_a_mac_pasted_into_the_wrong_variable_is_not_echoed(name, capsys) -> None:
    assert server.main(base_env(**{name: MAC_TEXT})) == 1
    err = capsys.readouterr().err.lower()
    assert err.startswith("wake-svc: ")
    assert "aa:bb:cc" not in err
