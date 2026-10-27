"""Entry point: ``python -m whisper_svc`` (reads HOST/PORT/WHISPER_* from the environment)."""

from __future__ import annotations

import logging

import uvicorn

from .app import create_app
from .config import Settings


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = Settings.from_env()
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, log_level="info")


if __name__ == "__main__":
    main()
