# wake-svc

Wake-on-LAN endpoint for Shadow Assistant. It runs on an always-on Linux box
on the LAN and, on an authenticated `POST /wake`, sends a magic packet to **one
MAC configured on the box** (the PC). The Android app calls it when the Core
is unreachable; it is the fallback next to the Home Assistant wake path.
Design: [`docs/12-wake-and-headless-core.md`](../../docs/12-wake-and-headless-core.md) (D1, D6).

- One file, Python 3.10+ **standard library only** (`wake_svc/server.py`);
  nothing to install on the box. `pytest` is needed only for the tests.
- No MAC, address or port is ever taken from a request: the body and the query
  string are ignored.
- **Never** put this service behind the Cloudflare tunnel or any other public
  route. It listens on the box's LAN address only; away from home the phone
  reaches it through the Tailscale subnet route, like the Core.

## API

All answers are JSON (`Content-Type: application/json`) unless the body is
empty; every answer has `Cache-Control: no-store` and `Connection: close`.

| Request | Status | Body |
|---|---|---|
| `GET /health` | `200` | `{"status":"ok","service":"wake-svc","version":"0.1.0"}` (no MAC, no target, no counters) |
| `POST /wake` + `Authorization: Bearer <wake token>` | `202` | `{"sent":true}`: the packets were handed to the network stack. **Not** proof that the PC woke. |
| `POST /wake`, token missing / wrong / malformed | `401` | `{"error":"unauthorized"}` (+ `WWW-Authenticate: Bearer`) |
| `POST /wake`, a rate limit hit | `429` | `{"error":"rate_limited","retryAfterS":N}` (+ `Retry-After: N`, whole seconds, at least 1) |
| `POST /wake`, the packet could not be sent (socket error) | `503` | `{"error":"send_failed"}` |
| known path, other method | `405` | empty (+ `Allow: GET` / `Allow: POST`) |
| any other path | `404` | empty |
| request line or headers over 8 KB / malformed request | `414` / `431` / `400` | empty |

- The query string is ignored on both paths (`/wake?x=…` is `/wake`).
- `Authorization` scheme is case-insensitive (`Bearer`, `bearer`); exactly one
  `Authorization` header, otherwise `401`.
- `429` means either a wake was accepted moments ago (10 s / hourly limit) or
  the caller's address is locked after failed tokens (see below); the body is
  the same in both cases.
- The `Server` header is just `wake-svc` (no versions).

Example (placeholders; never paste a real token into a shell history you share):

```sh
curl -i http://<wake-host>:<wake-port>/health
curl -i -X POST -H "Authorization: Bearer $(cat /path/to/wake-token)" http://<wake-host>:<wake-port>/wake
```

## Packet

6 × `0xFF` + 16 × MAC (102 bytes), UDP to port 9, sent **3 times 100 ms
apart** to every address in `WAKE_BROADCASTS`. The sending socket is bound to
`WAKE_SOURCE_ADDR` (the LAN interface's address) so the packet leaves on the
LAN and not on `tailscale0`. A failing address does not stop the others; the
answer is `503` only if no datagram at all could be sent (then that attempt
does not count against the wake limit).

## Configuration

Environment variables (on the box: from the systemd unit's environment file,
see "Deploy" below):

| Env | Required | Meaning |
|---|---|---|
| `WAKE_MAC` | yes | The PC's **wired** adapter MAC, `aa:bb:cc:dd:ee:ff` or `AA-BB-CC-DD-EE-FF` (one separator, any case). Must be a unicast, non-zero address. |
| `WAKE_BIND` | yes | The box's LAN IPv4 address to listen on, e.g. `192.0.2.10`. `0.0.0.0`, `::`, empty, host names and IPv6 are refused. |
| `WAKE_BROADCASTS` | yes | Comma list of IPv4 broadcast addresses, e.g. `192.0.2.255` (the LAN's subnet-directed broadcast); `255.255.255.255` may be added. At most 8. |
| `WAKE_PORT` | no (`8704`) | TCP port to listen on (1–65535). |
| `WAKE_SOURCE_ADDR` | no (= `WAKE_BIND`) | Address the UDP socket is bound to (the LAN interface's own address). |
| `WAKE_TOKEN_FILE` | no | Path of the token file. If unset, `$CREDENTIALS_DIRECTORY/wake-token` is used (systemd `LoadCredential=wake-token:<file>`). |

The token is read **only from a file**; a `WAKE_TOKEN` variable is refused
(process environments are visible to other tools). The file holds one
base64url token of **at least 32 random bytes** (surrounding whitespace and a
trailing newline are ignored). Create it on the box, readable only by root
(systemd hands it to the service):

```sh
python3 -c "import secrets; print(secrets.token_urlsafe(32))" > wake-token
chmod 600 wake-token
```

This token is **separate** from every Core device token; it only allows
"send the magic packet". Rotate it by writing a new file and restarting the
service, then enter it in the phone again.

Startup refuses (message on stderr, exit code `1`): a missing/invalid MAC, a
missing, empty, short, non-base64url or oversized token file, a wildcard or
non-IPv4 bind address, a bad port, missing or invalid broadcast addresses.
Error messages name the variable but never repeat its value (so neither the
token nor a MAC pasted into the wrong variable ends up in the journal).

## Running

```sh
cd services/wake-svc
WAKE_MAC=02:00:00:aa:bb:cc WAKE_BIND=192.0.2.10 WAKE_BROADCASTS=192.0.2.255 \
WAKE_TOKEN_FILE=/path/to/wake-token python3 -m wake_svc.server
```

(`python3 wake_svc/server.py` works too.) `SIGTERM` and Ctrl+C stop it.

**Deploy on the box:** the hardened systemd unit (`DynamicUser=yes`,
`LoadCredential=`, sandboxing), the environment file example and the
**[USER ACTION]** steps come with T21.3.2 (`deploy/linux/wake-svc.service`,
`deploy/linux/wake-svc.env.example`, `docs/05-deploy.md`). Until then, run it
by hand as above for a test.

## Limits and hardening

- Accepted wakes: at most **1 per 10 s** and **20 per hour** (global; there
  is one target).
- Failed authentications: **5 per minute per source address**, then that
  address gets `429` for **5 minutes** (even with the right token). The table
  of addresses holds at most 1024 entries (least recently failed dropped).
  Failed attempts never use up the wake budget.
- All limits live in memory: a restart resets them.
- Socket timeout 5 s per read, and **10 s for the whole connection** (a
  client trickling bytes is cut off then); after the answer, at most 0.5 s /
  64 KB of further client data is drained before closing. At most 8
  requests at once (further connections are closed without an answer); request
  line + headers ≤ 8 KB; at most 1 KB of a body is read, then discarded; one
  request per connection; no redirects, no static files.
- This limits, but does not prevent, flooding: a few clients on the LAN or the
  tailnet that keep opening slow connections can make wake-svc unavailable
  while they do (accepted in docs/12, D6; the Home Assistant path remains).
- When both wake limits apply, `retryAfterS` is the longer of the two waits.
- If a send fails (`503`), the attempt is given back to the wake budget. A
  second press that arrived during that failing send (within ~0.3 s) already
  got `429`, although nothing went out.

## Logs

One JSON line per `POST /wake` on stdout (journald on the box), plus one
`started` line:

```json
{"ts":"2026-01-01T12:00:00Z","event":"wake_sent","src":"192.0.2.50","status":202,"datagrams":3}
```

`event` is `wake_sent`, `auth_failed` (`locked: true` when this failure locked
the address), `rate_limited` (`reason`: `interval` / `hourly` /
`auth_lockout`, `retryAfterS`) or `send_failed` (`errno`, `error` = exception
type); `internal_error` for an unexpected handler error (exception type only;
client disconnects and socket errors are not logged). The token, the
`Authorization` header and the MAC are **never** logged. `GET /health` and
`404` / `405` answers are not logged.

## Security notes

- Wake-on-LAN itself has no authentication: any device on the LAN can wake the
  PC without this service. The token keeps the endpoint from being an open
  remote trigger; a leaked token lets someone on the LAN or the tailnet wake
  the PC at most once per 10 s / 20 per hour, nothing else (docs/12, D6).
- The token travels as cleartext HTTP on the LAN (WPA2/3) or inside Tailscale
  (WireGuard) when away.
- Bind to the LAN address only; open the port in the box's firewall for the
  LAN and the tailnet only (if a firewall is active). Never route it through
  the Cloudflare tunnel or any public address.

## Tests

No network beyond loopback: the packet sender is injected (one test sends a
real datagram to `127.0.0.1` and reads it back; HTTP tests run a server on
`127.0.0.1`).

```sh
cd services/wake-svc
python -m pip install -r requirements-dev.txt
python -m pytest
```
