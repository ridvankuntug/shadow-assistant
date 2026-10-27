# Shadow UI

One React + Vite + Three.js app for the browser and the Android WebView shell.
Host-specific features go through the platform adapter — see
[`docs/03-platform-adapter.md`](../docs/03-platform-adapter.md).

```sh
npm ci
npm run dev        # Vite dev server
npm run lint
npm test           # vitest (protocol client, state reducer, controller, adapters)
npm run build
```

## Mock Core (development only)

`scripts/mock-core.mjs` imitates the Core WebSocket protocol so the UI can be
tried without the real Core:

```sh
npm run mock-core                 # ws://127.0.0.1:8700/ws, token "dev-token"
```

Then open the dev server and connect with `ws://localhost:8700/ws` and
`dev-token`. Messages containing "kilit" trigger a confirmation, "hata" a model
error. Env: `MOCK_PORT`, `MOCK_HOST`, `MOCK_TOKEN`, `MOCK_TRANSCRIPT` (fixed
speech-to-text result, e.g. `evet` to answer a confirmation by voice),
`MOCK_CONFIRM_MS`, `MOCK_TTS_FAIL=1`.

The microphone needs a secure context: `localhost` or https.
