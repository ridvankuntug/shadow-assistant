# Platform adapter

The UI (`ui/`) is one React app that runs in a normal browser and inside the
Android WebView shell (`android/`, milestone T6). Everything that depends on
the host — microphone, audio playback, text-to-speech, vibration,
notifications, persistent storage, foreground/background state and the device
class — sits behind a single interface, the **platform adapter**.

UI components and the assistant controller only use this interface. They never
call `getUserMedia`, `MediaRecorder`, `Audio`/Web Audio, `navigator.vibrate`,
`localStorage` or the Android bridge directly.

| File | Purpose |
|---|---|
| `ui/src/platform/types.ts` | The `PlatformAdapter` interface, error codes, storage keys |
| `ui/src/platform/web.ts` | Browser implementation |
| `ui/src/platform/android.ts` | Wrapper around the Kotlin bridge `window.ShadowAndroid` |
| `ui/src/platform/select.ts` | Picks the adapter at start-up |

## 1. The interface (TypeScript)

```ts
interface PlatformAdapter {
  readonly kind: "web" | "android";
  readonly clientKind: "web" | "android";   // sent as hello.client to the Core
  readonly mic: {
    start(): Promise<void>;                  // rejects PlatformError
    stop(): Promise<Utterance>;              // one complete encoded utterance
    cancel(): void;                          // stop and discard, never throws
    level(): number;                         // 0..1 input loudness, called every frame
  };
  readonly playback: {
    play(clip: { mime: string; data: string }): Promise<void>; // resolves when finished OR stopped
    stop(): void;
    level(): number;                         // 0..1 output loudness
    unlock(): void;                          // called from a user gesture (autoplay rules)
  };
  readonly tts:
    | { mode: "core" }                       // web: Core `speak` -> tts-svc -> `speech` -> playback.play
    | { mode: "native"; speak(text: string): Promise<void>; stop(): void }; // Android
  readonly storage: { get(key): string | null; set(key, value): void; remove(key): void };
  vibrate(pattern: number[]): void;          // ms on/off pattern; ignored where unsupported
  notify(title: string, body: string): void; // optional; ignored where unsupported
  deviceClass(): "phone" | "tablet" | "desktop";
  prefersReducedMotion(): boolean;
  isVisible(): boolean;
  onVisibilityChange(listener: (visible: boolean) => void): () => void; // returns unsubscribe
}

type Utterance = { mime: string; data: string; durationMs: number };
```

- `Utterance.mime` is the base MIME type without parameters (`audio/webm`,
  `audio/ogg`, `audio/mp4`, `audio/wav` …). `data` is standard base64 without a
  `data:` prefix. The UI sends it unchanged as the Core `audio` message
  (`{"type":"audio","id":"…","mime":"…","data":"…"}`); whisper-svc decodes it
  with ffmpeg/PyAV.
- `durationMs` is used to drop accidental taps (< 300 ms). `0` means "unknown"
  and disables that check.
- `PlatformError.code` is one of `permission_denied`, `not_supported`, `busy`,
  `not_recording`, `capture_aborted`, `playback_failed`, `timeout`,
  `cancelled`, `unknown`. The UI shows a Turkish message for each, except
  `cancelled` (the host abandoned a pending request, see §4.2): that one only
  ends the capture, silently.
- `capture_aborted`: the host cut a running recording because the app (Android
  `onPause`) or the browser tab went to the background, and this is the
  `stop()` that follows; no audio is returned or sent (§4.5). The UI ends the
  capture with a short note ("recording stopped, nothing sent"), not as a
  microphone failure. `not_recording` stays for a `stop()` with no recording
  at all.

### Storage keys

| Key | Value |
|---|---|
| `shadow.coreUrl` | Core WebSocket URL, e.g. `ws://localhost:8700/ws` |
| `shadow.deviceToken` | Device token for `hello` (secret — see below) |
| `shadow.quality` | `high` / `medium` / `low` (absent = device default) |
| `shadow.voiceReplies` | `1` / `0` (absent = on) |

### How the app uses it

- **Push-to-talk.** Press: if Shadow is speaking or a turn is in flight, the
  controller first *barges in* — `playback.stop()` (or `tts.stop()`), then a
  Core `cancel` for that turn — and calls `mic.start()`. Release: `mic.stop()`,
  then one `audio` message. While a confirmation is pending nothing is
  cancelled; the utterance is the voice answer. Recording auto-stops after 60 s.
  (Not an adapter concern, but useful to know: after cancelling a running Core
  turn the controller holds the next `user_text`/`audio` until the Core's
  `state: idle`, at most 2 s, because the Core answers `busy` until the
  cancelled turn has wound down.)
- **Replies.** On `assistant_done`, if voice replies are on:
  `tts.mode === "core"` → the app sends `speak` and plays the returned
  `speech` clip with `playback.play`; `tts.mode === "native"` → `tts.speak(text)`.
  "Speaking" is shown while that promise is pending.
- **Lifecycle.** While `isVisible()` is false the 3D render loop stops. Coming
  back to the foreground triggers an immediate reconnect attempt if the socket
  dropped.
- **3D quality default.** `deviceClass()`: `phone` → low, `tablet` → medium,
  `desktop` → high, unless the user picked one (`shadow.quality`).

## 2. Adapter selection

At start-up `selectAdapter(window)`:

1. no `window.ShadowAndroid` → web adapter;
2. `window.ShadowAndroid` has every required method (see §4) **and**
   `getInfo()` returns `bridgeVersion: 1` → Android adapter;
3. otherwise (incomplete or incompatible bridge) → web adapter, with a console
   warning.

The bridge must therefore be injected **before the page loads**
(`addJavascriptInterface` before `loadUrl`).

## 3. Web adapter

- Microphone: `getUserMedia({audio: {echoCancellation, noiseSuppression,
  autoGainControl}})` + `MediaRecorder` (first supported of
  `audio/webm;codecs=opus`, `audio/webm`, `audio/ogg;codecs=opus`, `audio/mp4`).
  The stream is opened per utterance and released afterwards, so the browser's
  recording indicator is only on while talking. An `AnalyserNode` provides
  `level()`. A recording never continues in a hidden tab (§4.5).
- `getUserMedia` exists only in secure contexts: **https or `localhost`**. A
  phone opening the UI over plain `http://<lan-address>` cannot record; it gets
  `not_supported` and can still type. (The Android shell uses native capture
  and is not affected.)
- Playback: one shared `AudioContext`; clips are decoded with
  `decodeAudioData` and played through an analyser (for `level()`).
  `stop()` resolves the pending `play()`.
- TTS: `mode: "core"`.
- Storage: `localStorage`, falling back to memory when it is blocked. The
  device token is therefore readable by scripts on the same origin; serve the
  UI from a trusted origin only.
- Vibration: `navigator.vibrate` when present. Notifications: not used.
- Device class: coarse pointer and short screen side < 600 px → phone,
  < 1024 px → tablet; fine pointer → desktop.

## 4. Android bridge contract (`window.ShadowAndroid`)

The Kotlin shell exposes one object named `ShadowAndroid` through
`WebView.addJavascriptInterface(bridge, "ShadowAndroid")`. Every method is a
public `@JavascriptInterface` method. **Only strings, numbers, booleans and
`void` cross the bridge**; structured data is JSON in a string.

JavaScript calls these methods on a WebView-owned background thread
(the "JavaBridge" thread). Do audio work on your own threads/handlers and
never block the bridge thread for long.

### 4.1 Methods

| Method (Kotlin) | Returns | Kind | Notes |
|---|---|---|---|
| `getInfo(): String` | JSON | sync | `{"bridgeVersion":1,"appVersion":"1.0.0","deviceClass":"phone","reducedMotion":false}`. `bridgeVersion` is required and must be `1`; `deviceClass` (`phone`/`tablet`/`desktop`) and `reducedMotion` are optional (defaults: `phone`, the WebView's `prefers-reduced-motion`). |
| `startCapture(requestId: String)` | void | async | Start recording one utterance. Callback `{"ok":true}` once the mic is actually recording, or an error (`permission_denied`, `busy`, `not_supported`; `capture_aborted` if the activity went to the background before recording began, see §4.5). |
| `stopCapture(requestId: String)` | void | async | Stop and encode. Callback `{"ok":true,"mime":"audio/mp4","data":"<base64>","durationMs":1840}`. `data` = whole file (e.g. AAC in MP4 from `MediaRecorder`, or WAV), base64 `NO_WRAP`. Error `capture_aborted` if the shell cut the recording on `onPause` since the last `startCapture` (§4.5); `not_recording` if nothing was recording. |
| `cancelCapture()` | void | sync | Stop and discard; no callback. Must be safe when idle. |
| `getInputLevel(): Float` | 0..1 | sync | Current input loudness (e.g. RMS of the last buffer). Called up to 60×/s — keep it a field read. Optional; missing = 0. |
| `playAudio(requestId: String, mime: String, base64: String)` | void | async | Play a clip (currently `audio/wav` from tts-svc). Callback `{"ok":true}` when playback **finishes or is stopped by `stopAudio()`**; `playback_failed` if it cannot be decoded/played. A new `playAudio` while playing stops the old clip first (and answers its callback `{"ok":true}`). |
| `stopAudio()` | void | sync | Stop playback. Must be safe when idle. |
| `getOutputLevel(): Float` | 0..1 | sync | Output loudness while playing or speaking. Optional; missing = 0. |
| `speak(requestId: String, text: String)` | void | async | Native `TextToSpeech` (Turkish voice). Callback `{"ok":true}` when the utterance finishes **or is stopped by `stopSpeaking()`**; error otherwise. |
| `stopSpeaking()` | void | sync | Stop TTS. Must be safe when idle. |
| `vibrate(patternJson: String)` | void | sync | e.g. `"[30,60,30]"` — on/off milliseconds starting with "on". Optional. |
| `notify(title: String, body: String)` | void | sync | System notification, used for a confirmation request while the app is in the background. Optional. |
| `getItem(key: String): String?` | string or null | sync | Persistent storage (see storage keys). Store `shadow.deviceToken` encrypted (e.g. Android Keystore-backed). |
| `setItem(key: String, value: String)` | void | sync | |
| `removeItem(key: String)` | void | sync | |

Required for the bridge to be accepted: `getInfo`, `startCapture`,
`stopCapture`, `cancelCapture`, `playAudio`, `stopAudio`, `speak`,
`stopSpeaking`, `getItem`, `setItem`, `removeItem`. The rest are optional.

### 4.2 Async results: `window.__shadowAndroidCallback`

Async methods return immediately. When the operation completes, Kotlin calls
the JavaScript function the adapter installs:

```js
window.__shadowAndroidCallback(requestId, payload)
```

- `requestId` — the string passed into the method (opaque; echo it back).
- `payload` — a JSON **string** (or an object literal). Success:
  `{"ok":true, ...fields}`. Failure:
  `{"ok":false,"error":{"code":"permission_denied","message":"…"}}` with a code
  from the list in §1 (unknown codes become `unknown`).
- Call it exactly once per request, on the UI thread:

```kotlin
fun reply(requestId: String, json: JSONObject) {
    // JSONObject.quote() produces a valid JS string literal of the JSON text.
    val js = "window.__shadowAndroidCallback(${JSONObject.quote(requestId)}, ${JSONObject.quote(json.toString())})"
    webView.post { webView.evaluateJavascript(js, null) }
}
```

`startCapture` and `stopCapture` time out after 15 s on the JS side (the
adapter reports `timeout`; a later callback for that id is ignored). After such
a timeout the adapter calls `cancelCapture()`: the shell must then drop that
pending request and must not start recording for it — even if the user grants
the microphone permission afterwards.
If `cancelCapture()` is called while a `startCapture` request is still pending
(e.g. the permission dialog is open), the shell answers that cancelled request
exactly once with `{"ok":false,"error":{"code":"cancelled"}}` and does not
start recording for it. The UI ignores `cancelled` silently (no error shown).
The UI does not call `startCapture` again until the previous one has been
answered, because `cancelCapture()` is not tied to a request and a late
cleanup would otherwise stop the newer recording.
`playAudio` and `speak` have no timeout — answer them when playback/speech
ends or is stopped.

### 4.3 Events: `window.__shadowAndroidEvent`

The shell pushes host events with:

```js
window.__shadowAndroidEvent(name, payload)   // payload: JSON string or object
```

| Event | Payload | When |
|---|---|---|
| `visibility` | `{"visible":false}` / `{"visible":true}` | `onPause` / `onResume` of the activity hosting the WebView |

The adapter combines this with `document.visibilityState`; either one hidden
means "in background". Calling `webView.onPause()/onResume()` as well is
recommended so the WebView throttles timers.

### 4.4 Permissions and errors

- `RECORD_AUDIO` is requested by the shell at the first `startCapture` (runtime
  permission). While the system dialog is open, keep the request pending and
  answer the callback after the user decides: `{"ok":true}` or
  `permission_denied`. If the user chose "don't ask again", answer
  `permission_denied` immediately (the UI explains how to enable it).
- Audio focus: request transient focus while recording/playing/speaking;
  losing focus while playing should stop playback and answer the pending
  `playAudio`/`speak` callback with `{"ok":true}`.
- Microphone held by another app → `busy`. Device without a microphone →
  `not_supported`.
- A thrown exception in a sync method is caught by the adapter and treated as
  "unsupported/ignored"; do not rely on that — return quietly instead.

### 4.5 Lifecycle

1. Activity `onCreate`: configure the WebView (JavaScript on, media playback
   without user gesture allowed), `addJavascriptInterface(bridge, "ShadowAndroid")`,
   then load the UI bundle (`ui/dist`, built with a relative base).
2. The page starts, `selectAdapter` finds the bridge, calls `getInfo()` once and
   installs `__shadowAndroidCallback` / `__shadowAndroidEvent`.
3. `onPause`: send `visibility {visible:false}`; stop playback/TTS, answering
   their pending callbacks. **`onPause` does not cancel a pending
   `startCapture` (the permission dialog pauses the activity too); it only cuts
   a recording that is already running**, discarding its audio. The UI only
   stops rendering 3D on `visibility {visible:false}`; cutting the recording
   is the shell's job. After such a cut, the next `stopCapture` answers
   `{"ok":false,"error":{"code":"capture_aborted"}}` (once; a `stopCapture`
   after that answers `not_recording`) and the UI ends the capture with a
   short note, sending nothing. A `stopCapture` that was already called before
   `onPause` is not affected: the recording had ended, so its audio (recorded
   in the foreground) is answered normally. A `startCapture` still pending at
   `onPause` is answered as in §4.4 once the user decides; it is cancelled
   only by `cancelCapture()` (§4.2). It must never begin recording while the
   activity is in the background: after a permission grant, start once the
   activity is resumed; if the mic would start while the activity is paused
   for any other reason (e.g. slow mic start, user pressed Home), release it
   and answer `capture_aborted`.

   Web (browser tab, for comparison): the web adapter does the same itself.
   When `document.visibilityState` becomes `hidden` it stops a running
   `MediaRecorder` and the mic tracks and drops the recorded data; the next
   `mic.stop()` rejects with `capture_aborted`, so no `audio` reaches the
   Core — whether the user was holding the button or had latched recording on
   with a tap. A `getUserMedia` that completes while the tab is hidden is
   released at once and `mic.start()` rejects with `capture_aborted`. A
   `mic.stop()` already in progress when the tab is hidden still returns its
   (foreground) audio. When the tab is visible again the controller closes a
   recording that was cut, so the user sees the note at once instead of a
   recording that only looks active.
4. `onResume`: send `visibility {visible:true}`; the UI reconnects to the Core
   at once if the socket dropped.
5. `onDestroy`: release `MediaRecorder`, `MediaPlayer`/`AudioTrack` and
   `TextToSpeech`.

The WebSocket connection to the Core is made by the UI itself (same
`hello`/token flow as the browser, `client: "android"`); the shell does not
proxy it. The Core URL and token are entered in the UI and stored through
`setItem`.

## 5. Changing the contract

The Android bridge is versioned by `getInfo().bridgeVersion` (currently `1`).
Additive changes (new optional methods, new optional fields) keep the version.
Anything else bumps it; the UI falls back to the web adapter when it does not
recognise the version. Keep `ui/src/platform/android.ts` and this document in
sync.
