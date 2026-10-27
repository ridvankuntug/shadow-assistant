"""Opt-in end-to-end smoke test against a RUNNING tts-svc with a real voice.

    python scripts/smoke.py                          # http://127.0.0.1:8702
    python scripts/smoke.py --url http://127.0.0.1:8702 --out out-dir --voice tr_TR-dfki-medium

Waits for /health, synthesises a few Turkish sentences, checks the WAV and
prints wall time, server time (X-Processing-Ms), audio length and RTF
(synthesis time / audio length; < 1 = faster than real time). Stdlib only.
"""

from __future__ import annotations

import argparse
import http.client
import io
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import wave
from pathlib import Path

SENTENCES = [
    "Merhaba, size nasıl yardımcı olabilirim?",
    "Salondaki ışıkları kapattım.",
    "Bugün hava parçalı bulutlu, sıcaklık yirmi iki derece civarında olacak.",
    "Mutfak penceresi açık görünüyor; kapatmamı ister misiniz? Onaylamak için evet deyin.",
]


def wait_healthy(url: str, timeout: float) -> dict:
    deadline = time.monotonic() + timeout
    last = "no response"
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"{url}/health", timeout=5) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as exc:
            last = f"{exc.code} {exc.read().decode(errors='replace')}"
        except OSError as exc:
            last = str(exc)
        time.sleep(1)
    raise SystemExit(f"service not healthy after {timeout:.0f}s: {last}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8702")
    parser.add_argument("--voice", default=None)
    parser.add_argument("--out", type=Path, default=None, help="directory to save the WAV files")
    parser.add_argument("--timeout", type=float, default=300, help="seconds to wait for /health")
    args = parser.parse_args()

    url = args.url.rstrip("/")
    print("health:", json.dumps(wait_healthy(url, args.timeout), ensure_ascii=False))
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)

    # One persistent (keep-alive) connection, like a real client. urllib sends
    # "Connection: close", and on some Windows hosts loopback responses that end
    # with a server-side close are intermittently cut off by a TCP reset.
    parsed = urllib.parse.urlsplit(url)
    conn = http.client.HTTPConnection(parsed.hostname, parsed.port or 80, timeout=60)
    total_audio = total_server = 0.0
    for i, text in enumerate(SENTENCES):
        body = json.dumps({"text": text, "voice": args.voice}).encode()
        started = time.perf_counter()
        conn.request("POST", "/synthesize", body=body, headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        data = resp.read()
        server_ms = int(resp.headers.get("X-Processing-Ms", "0"))
        ctype = resp.headers.get("Content-Type")
        wall_ms = (time.perf_counter() - started) * 1000
        if resp.status != 200 or ctype != "audio/wav" or data[:4] != b"RIFF":
            print(f"FAIL: unexpected response ({resp.status} {ctype}, {data[:80]!r})")
            return 1
        with wave.open(io.BytesIO(data)) as w:
            audio_s = w.getnframes() / w.getframerate()
        if audio_s <= 0:
            print(f"FAIL: empty audio for sentence {i}")
            return 1
        total_audio += audio_s
        total_server += server_ms / 1000
        print(
            f"[{i}] chars={len(text):3d} audio={audio_s:5.2f}s server={server_ms:4d}ms "
            f"wall={wall_ms:5.0f}ms rtf={server_ms / 1000 / audio_s:.3f}"
        )
        if args.out:
            (args.out / f"smoke-{i}.wav").write_bytes(data)
    conn.close()
    print(f"OK: total audio {total_audio:.2f}s, server time {total_server:.2f}s, RTF {total_server / total_audio:.3f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
