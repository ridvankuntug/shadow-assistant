# tts-svc

Text-to-speech service for Shadow Assistant.

- **Purpose:** turn the assistant's text replies into speech audio.
- **Stack:** [Piper](https://github.com/rhasspy/piper) (local, offline TTS).
- **Interface:** a small HTTP API called by the Core (URL configured via
  `TTS_SVC_URL` in `.env`).
- **Status:** not implemented yet. Planned for milestone **T5**.

Voice model files (`*.onnx`) are downloaded at runtime and are git-ignored.
