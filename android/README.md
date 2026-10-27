# Android shell

Thin Android app (Kotlin + WebView) that hosts the same `ui/` build used in the
browser.

- Platform-specific features (microphone, audio playback, TTS, vibration,
  notifications, token storage) are exposed to the UI through the
  **platform adapter** interface, so the web bundle stays identical.
- **Status:** not implemented yet. Planned for milestone **T6** (no Android
  CI workflow until then).

Signing keys (`*.jks`, `*.keystore`) and `local.properties` are git-ignored and
must never be committed.
