"""Model lifecycle: initial load, idle unload (frees the GPU) and reload on demand.

States (``ModelLifecycle.status``):

- ``loading`` - initial load at startup; ``/health`` answers 503, requests get 503.
- ``ok``      - model loaded.
- ``idle``    - model unloaded after ``idle_unload_seconds`` without requests, or being
                reloaded by a request; ``/health`` answers 200 so the Core keeps treating
                the service as up. The next request reloads the model and waits for it.
- ``error``   - a load failed. After a failed *initial* load the state is final (as
                before); after a failed *reload* the next request tries again.

Locking: ``_lock`` guards every state transition and the in-flight counter. A reload
runs while holding it, so concurrent requests queue behind the reload instead of
loading twice. An unload only happens with no request in flight, so it never pulls
the model away from a running inference. Lock order is always lifecycle lock ->
transcriber inference lock (the transcriber never calls back into this class).
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Callable

from .transcriber import Transcriber

log = logging.getLogger("whisper_svc")


class ModelUnavailable(Exception):
    """The model is not usable right now (initial load running or a load failed)."""


class ModelLifecycle:
    def __init__(
        self,
        transcriber: Transcriber,
        idle_unload_seconds: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._transcriber = transcriber
        self._idle_s = idle_unload_seconds
        self._clock = clock
        self._lock = threading.Lock()
        self._in_flight = 0
        self._last_used = clock()
        # True once the initial load succeeded: from then on a failed load is retried
        # by the next request instead of being final.
        self._reloadable = False
        self._stop = threading.Event()
        self._timer: threading.Thread | None = None
        self.status = "loading"  # loading | ok | idle | error
        self.error: str | None = None

    @property
    def idle_unload_enabled(self) -> bool:
        return self._idle_s > 0

    # --- loading -------------------------------------------------------------------

    def initial_load(self) -> None:
        """Load at startup. Failure is reported through ``status``/``error``, not raised."""
        started = time.perf_counter()
        with self._lock:
            try:
                self._transcriber.load()
            except Exception as exc:  # report through /health instead of crashing the server
                log.exception("model load failed")
                self.error = f"{type(exc).__name__}: {exc}"
                self.status = "error"
                return
            self.status = "ok"
            self.error = None
            self._reloadable = True
            self._last_used = self._clock()
        log.info("model ready in %.1f s", time.perf_counter() - started)

    def can_serve(self) -> bool:
        """Cheap pre-check (no lock): would ``begin()`` try to serve rather than fail fast?"""
        return self.status in ("ok", "idle") or (self.status == "error" and self._reloadable)

    def begin(self) -> None:
        """Mark a request in flight, reloading the model first if it was unloaded.

        Blocks while a reload runs (in this or another request). Raises
        ``ModelUnavailable`` if the model cannot be used.
        """
        with self._lock:
            if self.status == "idle" or (self.status == "error" and self._reloadable):
                self._reload_locked()
            elif self.status != "ok":
                raise ModelUnavailable()
            self._in_flight += 1

    def end(self) -> None:
        with self._lock:
            self._in_flight -= 1
            self._last_used = self._clock()

    def _reload_locked(self) -> None:
        # Keep reporting "idle" (not "loading") while reloading: the service is up,
        # this request is merely waiting for the model.
        if self.status == "error":
            self.status = "idle"
        started = time.perf_counter()
        log.info("reloading model after idle unload")
        try:
            self._transcriber.load()
        except Exception as exc:
            log.exception("model reload failed")
            self.error = f"{type(exc).__name__}: {exc}"
            self.status = "error"
            raise ModelUnavailable() from exc
        self.status = "ok"
        self.error = None
        log.info("model reloaded in %.1f s", time.perf_counter() - started)

    # --- idle unload ---------------------------------------------------------------

    def check_idle(self) -> float:
        """Unload the model if it has been idle long enough.

        Returns how many seconds the caller may sleep before checking again.
        """
        if not self.idle_unload_enabled:
            return float("inf")
        with self._lock:
            if self.status != "ok" or self._in_flight > 0:
                # Nothing to do now; end()/reload update _last_used, so a full period
                # from now is never too late.
                return self._idle_s
            remaining = self._last_used + self._idle_s - self._clock()
            if remaining > 0:
                return remaining
            log.info("no requests for %.0f s, unloading model", self._idle_s)
            started = time.perf_counter()
            try:
                self._transcriber.unload()
            except Exception:
                # The transcriber drops its model reference before cleaning up, so the
                # model is gone either way; the next request reloads it.
                log.exception("error while unloading model")
            self.status = "idle"
            log.info("model unloaded in %.2f s", time.perf_counter() - started)
            return self._idle_s

    def start_timer(self) -> None:
        if not self.idle_unload_enabled or self._timer is not None:
            return
        self._stop.clear()
        self._timer = threading.Thread(target=self._timer_loop, name="whisper-idle", daemon=True)
        self._timer.start()

    def stop_timer(self) -> None:
        self._stop.set()
        if self._timer is not None:
            self._timer.join(timeout=5)
            self._timer = None

    def _timer_loop(self) -> None:
        while True:
            try:
                wait = self.check_idle()
            except Exception:  # never let the timer thread die silently
                log.exception("idle check failed")
                wait = self._idle_s
            # Small floor so a clock edge case can never turn this into a busy loop.
            if self._stop.wait(timeout=max(wait, 0.01)):
                return
