# whisper-svc

Speech-to-text service for Shadow Assistant.

- **Purpose:** turn Turkish speech captured by the UI into text for the Core.
- **Stack:** Python + [faster-whisper](https://github.com/SYSTRAN/faster-whisper).
- **Interface:** a small HTTP API called by the Core (URL configured via
  `WHISPER_SVC_URL` in `.env`).
- **Status:** not implemented yet. Planned for milestone **T4**.

Model files are downloaded at runtime and must not be committed.
