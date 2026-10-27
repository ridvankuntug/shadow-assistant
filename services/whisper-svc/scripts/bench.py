"""Latency / accuracy benchmark against a running whisper-svc (stdlib only).

Usage:
    python scripts/bench.py --clips <dir> [--url http://127.0.0.1:8701] [--reps 5]
                            [--wait-ready 600] [--multipart] [--json-out result.json]

<dir> contains audio clips (.wav/.webm/.ogg/.mp3/.m4a/.mp4) and optionally
``expected.json`` = {"<file name>": "<expected transcript>"}.

Each clip is sent once as a warm-up, then ``--reps`` times. Reported per clip:
client-side end-to-end HTTP latency (median / p90), server ``processing_ms``,
the transcript and whether it matches the expected text (case/punctuation-insensitive).
With ``--wait-ready`` the script first polls /health and reports seconds until 200
(start the server right before this script to measure model load time).
GPU memory in use (whole GPU, via nvidia-smi) is reported if nvidia-smi is available.
"""

from __future__ import annotations

import argparse
import http.client
import json
import math
import mimetypes
import re
import statistics
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

AUDIO_EXT = {".wav", ".webm", ".ogg", ".opus", ".mp3", ".m4a", ".mp4", ".flac"}
MIME = {".webm": "audio/webm", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".m4a": "audio/mp4", ".mp4": "audio/mp4"}


def normalize(text: str) -> str:
    text = text.replace("I", "ı").replace("İ", "i").lower()
    text = unicodedata.normalize("NFC", text)
    text = re.sub(r"[^\w\s]", " ", text)
    return " ".join(text.split())


def percentile(values: list[float], p: float) -> float:
    """Nearest-rank percentile (no interpolation; fine for small samples)."""
    s = sorted(values)
    k = max(0, math.ceil(p / 100 * len(s)) - 1)
    return s[k]


def gpu_mem_used_mib() -> int | None:
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=10, check=True,
        ).stdout
        return int(out.strip().splitlines()[0])
    except Exception:
        return None


def wait_ready(url: str, timeout: float) -> float:
    start = time.perf_counter()
    while time.perf_counter() - start < timeout:
        try:
            with urllib.request.urlopen(url + "/health", timeout=5) as r:
                if r.status == 200:
                    return time.perf_counter() - start
        except urllib.error.HTTPError as e:
            if e.code != 503:
                raise
            body = json.loads(e.read() or b"{}")
            if body.get("status") == "error":
                raise SystemExit(f"model load failed: {body.get('error')}")
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            pass
        time.sleep(0.25)
    raise SystemExit(f"service not ready after {timeout} s")


class Client:
    """Keep-alive HTTP client (one persistent connection, reconnects if the server closed it).

    Keep-alive matters on Windows loopback: responses on ``Connection: close`` sockets were
    occasionally cut by a TCP RST in testing, and reconnecting per request also adds latency
    that the Core (which keeps its connection open) would not see.
    """

    def __init__(self, url: str):
        u = urllib.parse.urlsplit(url)
        self.host, self.port = u.hostname or "127.0.0.1", u.port or 80
        self.conn: http.client.HTTPConnection | None = None
        self.retries = 0

    def request(self, method: str, path: str, body: bytes | None = None, headers: dict | None = None):
        """Return ``(status, body, elapsed_ms)``; ``elapsed_ms`` covers the successful attempt only.

        If a reused connection turns out to be closed, the request is retried once on a
        fresh connection. The retry is counted in ``self.retries`` and its timing replaces
        the failed attempt, so latency statistics never include two round trips.
        """
        for attempt in (1, 2):
            if self.conn is None:
                self.conn = http.client.HTTPConnection(self.host, self.port, timeout=120)
            t0 = time.perf_counter()
            try:
                self.conn.request(method, path, body=body, headers=headers or {})
                r = self.conn.getresponse()
                data = r.read()
                return r.status, data, (time.perf_counter() - t0) * 1000
            except (http.client.RemoteDisconnected, ConnectionError):
                self.conn.close()
                self.conn = None
                if attempt == 2:
                    raise
                self.retries += 1
        raise AssertionError("unreachable")


def post(client: Client, path: Path, multipart: bool, language: str) -> tuple[float, dict]:
    data = path.read_bytes()
    mime = MIME.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    if multipart:
        boundary = uuid.uuid4().hex
        body = (
            f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{path.name}\"\r\n"
            f"Content-Type: {mime}\r\n\r\n"
        ).encode() + data + f"\r\n--{boundary}--\r\n".encode()
        ctype = f"multipart/form-data; boundary={boundary}"
    else:
        body, ctype = data, mime
    status, raw, lat = client.request(
        "POST", f"/transcribe?language={urllib.parse.quote(language)}", body, {"Content-Type": ctype}
    )
    if status != 200:
        raise SystemExit(f"{path.name}: HTTP {status}: {raw[:300]!r}")
    return lat, json.loads(raw)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="http://127.0.0.1:8701")
    ap.add_argument("--clips", required=True, type=Path)
    ap.add_argument("--reps", type=int, default=5)
    ap.add_argument("--language", default="tr")
    ap.add_argument("--multipart", action="store_true", help="send as multipart field 'file' instead of raw body")
    ap.add_argument("--wait-ready", type=float, default=0, metavar="SECONDS")
    ap.add_argument("--label", default="")
    ap.add_argument("--json-out", type=Path)
    args = ap.parse_args()

    url = args.url.rstrip("/")
    ready_s = wait_ready(url, args.wait_ready) if args.wait_ready else None
    if ready_s is not None:
        print(f"ready after {ready_s:.1f} s")
    client = Client(url)
    status, raw, _ = client.request("GET", "/health")
    if status != 200:
        raise SystemExit(f"service not ready: HTTP {status}: {raw[:300]!r}")
    health = json.loads(raw)
    print("health:", health)

    expected_file = args.clips / "expected.json"
    expected = json.loads(expected_file.read_text(encoding="utf-8")) if expected_file.exists() else {}
    clips = sorted(p for p in args.clips.iterdir() if p.suffix.lower() in AUDIO_EXT)
    if not clips:
        print("no clips found", file=sys.stderr)
        return 2

    rows, all_lat, all_proc = [], [], []
    for clip in clips:
        post(client, clip, args.multipart, args.language)  # warm-up for this clip/format
        lats, procs, text, dur = [], [], "", 0
        for _ in range(args.reps):
            lat, payload = post(client, clip, args.multipart, args.language)
            lats.append(lat)
            procs.append(payload["processing_ms"])
            text, dur = payload["text"], payload["duration_ms"]
        exp = expected.get(clip.name)
        ok = None if exp is None else normalize(exp) == normalize(text)
        rows.append({
            "clip": clip.name, "audio_ms": dur,
            "lat_median_ms": round(statistics.median(lats)), "lat_p90_ms": round(percentile(lats, 90)),
            "proc_median_ms": round(statistics.median(procs)), "text": text, "expected": exp, "match": ok,
        })
        all_lat += lats
        all_proc += procs
        mark = {True: "OK ", False: "DIFF", None: "    "}[ok]
        print(f"{mark} {clip.name:28} audio={dur:5d}ms  e2e med={rows[-1]['lat_median_ms']:4d} "
              f"p90={rows[-1]['lat_p90_ms']:4d}  proc med={rows[-1]['proc_median_ms']:4d}  -> {text!r}")

    matched = [r["match"] for r in rows if r["match"] is not None]
    summary = {
        "label": args.label, "health": health, "ready_s": None if ready_s is None else round(ready_s, 1),
        "reps": args.reps, "multipart": args.multipart,
        "lat_median_ms": round(statistics.median(all_lat)), "lat_p90_ms": round(percentile(all_lat, 90)),
        "proc_median_ms": round(statistics.median(all_proc)),
        "gpu_mem_used_mib": gpu_mem_used_mib(),
        "connection_retries": client.retries,
        "exact_matches": f"{sum(matched)}/{len(matched)}" if matched else None,
        "rows": rows,
    }
    print(f"ALL e2e median={summary['lat_median_ms']} ms p90={summary['lat_p90_ms']} ms "
          f"proc median={summary['proc_median_ms']} ms  gpu_mem={summary['gpu_mem_used_mib']} MiB  "
          f"matches={summary['exact_matches']}")
    if args.json_out:
        args.json_out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
