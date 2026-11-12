# Android shell

Thin Kotlin app that hosts the **same `ui/` build used in the browser** in a
WebView and adds what the browser cannot do well on a phone: native
microphone capture, audio playback, Turkish TextToSpeech (fallback only),
vibration, notifications, encrypted token storage, and the default-assistant
role (opens from the assist gesture / power key).

- The UI talks to the host only through the **platform adapter**; the shell
  implements the `window.ShadowAndroid` bridge exactly as specified in
  [docs/03-platform-adapter.md §4](../docs/03-platform-adapter.md#4-android-bridge-contract-windowshadowandroid)
  (`bridgeVersion` 1).
- The app talks **only to the Core** (`ws://192.168.1.2:8700/ws`), never to Home
  Assistant or a model. The WebSocket and `hello`/token flow are the UI's own,
  identical to the browser (`client: "android"`).
- No wake word, nothing listens in the background. The microphone is only open
  while you hold/latch the talk button in the foreground. The one background
  exception is the Buds case battery (below): a manifest broadcast receiver and
  a one-off WorkManager job — no service, no persistent notification, no
  periodic work.

| | |
|---|---|
| Language / build | Kotlin (AGP built-in Kotlin), Gradle wrapper, Kotlin DSL |
| AGP / Gradle / Kotlin | 9.5.0 / 9.8.2 / 2.2.10 (AGP's bundled Kotlin) |
| compileSdk / targetSdk / minSdk | 37 / 37 / 29 (Android 10) |
| Package | `app.shadowassistant.android` |

## Layout

| Path | What |
|---|---|
| `app/build.gradle.kts` | App module; task `copyUiBundle` copies `../ui/dist` into the APK assets (`assets/ui/`) |
| `MainActivity.kt` | WebView host, hardening, lifecycle (`visibility` events), native error screen |
| `ShadowBridge.kt` | The `@JavascriptInterface` methods of `ShadowAndroid` |
| `CaptureController.kt` | Microphone state machine of the contract (permission, background cut, cancel) |
| `AudioRecordRecorder.kt` | 16 kHz mono PCM capture → `audio/wav` |
| `AudioPlayer.kt` / `Speaker.kt` | `playAudio` (Core voice) / `speak` (TextToSpeech fallback) |
| `TokenCipher.kt`, `BridgeStorage.kt` | Keystore-encrypted device token, plain other keys |
| `CoreAddress.kt`, `CoreProbe.kt` | Default Core address, cleartext allowlist, reachability check |
| `LocalNetworkPermission.kt` | When the Android 17 local network permission is needed / asked at startup |
| `CaseBattery.kt`, `CaseBatterySync.kt` | Buds case battery: validation, Core request, receiver + WorkManager job |
| `AppStorage.kt` | Opens the stores (shared by the activity and the background job) |
| `Updater.kt`, `UpdateActivity.kt` | In-app update from GitHub Releases: checks (`UpdateRules`), download, `PackageInstaller`; shortcut dialog |
| `assist/AssistServices.kt` | `VoiceInteractionService` + session + recognition stub |
| `res/xml/network_security_config.xml` | Cleartext only to `192.168.1.2` |

## Build

Requirements: JDK 17+ (21 tested), Node 22+, Android SDK with
`platforms;android-37.0` and `build-tools;37.0.0`. The build is configured
with `android.builder.sdkDownload=false`, so it never installs SDK packages
(and never accepts licences) on its own; install them with Android Studio's
SDK Manager or `sdkmanager` yourself.

```sh
# 1. UI bundle (the APK embeds ui/dist unchanged; the build fails clearly if it is missing)
cd ui
npm ci
npm run build

# 2. APK — point Gradle at the SDK with ANDROID_HOME or android/local.properties (git-ignored):
#    sdk.dir=C\:/Users/<you>/AppData/Local/Android/Sdk
cd ../android
./gradlew assembleDebug          # Windows: gradlew.bat assembleDebug
./gradlew testDebugUnitTest lintDebug
```

Output: `app/build/outputs/apk/debug/app-debug.apk`.

Re-run `npm run build` in `ui/` whenever the UI changes; the next Gradle build
picks up the new `ui/dist`.

## Install

There is no Play Store release; the APK is installed by hand.

- USB: enable developer options + USB debugging, then
  `adb install -r app/build/outputs/apk/debug/app-debug.apk`.
- Or download the `shadow-release-apk` (or `shadow-debug-apk`) artifact of the
  **Android** workflow run on GitHub, copy it to the phone and open it (allow
  "Install unknown apps" for the file manager/browser once).

- Or, once a release build is installed, from inside the app: see
  [Releases and in-app update](#releases-and-in-app-update).

A debug APK and a release APK are signed with different keys: switching
between them requires uninstalling first (which deletes the stored token and
settings). Pick one; for daily use the signed release APK from CI.

## Core setup (once)

1. Give the phone its own token on the Core machine (`.env`, see
   `.env.example`): a random value of at least 16 characters, e.g.
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

   ```
   DEVICE_TOKEN_ANDROID=<random value>
   ```

   The device name (`android`) is the lower-cased suffix; use another suffix
   for a second phone.
2. Let the Core accept LAN connections: `CORE_HOST=0.0.0.0` (or the PC's
   address `192.168.1.2`), `CORE_PORT=8700` (default). Allow inbound TCP 8700
   in the Windows firewall for the private network (and the Tailscale
   interface if it is a separate profile). Restart the Core.
3. Open the app. The connect screen is prefilled with
   `ws://192.168.1.2:8700/ws`; paste the token and connect. The token is stored
   encrypted on the phone (below) and never logged.

## Network: home and away

The Core address is the same everywhere: at home the phone reaches
`192.168.1.2` on the LAN; outside, through Tailscale (the Pi subnet router
advertises `192.168.1.0/24`). Keep Tailscale on the phone connected with
"use subnet routes" enabled. If the network you are on also uses
`192.168.1.0/24`, the routes collide (decision #15: handled when it happens).

When the Core cannot be reached (or the address is not allowed, see below),
the app shows a native error screen with **Tekrar dene** and **Adresi
değiştir** (back to the UI's settings to edit the address). The check is a
plain TCP connect to the Core's host/port, run when the page has loaded, on
every return to the foreground and after the address or token changes.

**Local network permission (Android 17+).** With `targetSdk` 37, Android 17
blocks connections to LAN addresses such as `192.168.1.2` — on Wi-Fi and
through the Tailscale subnet route alike — unless the app holds the runtime
permission `ACCESS_LOCAL_NETWORK` ("Yerel ağ"). The app asks for it at
startup (together with the one-time notification prompt) and loads the UI
once it is granted. If it is denied, a separate native error ("Yerel ağ izni
gerekli", not "Çekirdeğe ulaşılamıyor") offers **Tekrar dene** (asks again)
and **Ayarları aç** (the app's settings page); granting it there and coming
back loads the UI without restarting the app. Older Android versions do not
have this permission and are unaffected.

**Buds case battery (T11).** Shadow does not read the Galaxy Buds case
itself; [Buds Case Widget](https://github.com/ridvankuntug/BudsCaseWidget)
(v0.2.0+) does and shares the last value (read-only provider + change
broadcast, permission `io.github.budscasewidget.permission.READ_CASE_BATTERY`,
protection level `dangerous`). If that app is installed, Shadow asks for the
permission once at startup, in the same dialog sequence as the others; if it
is not installed or the permission is denied, only this feature is off (allow
it later under the app's permissions in Settings). On the change broadcast,
whenever the app comes to the foreground and when the token is saved, a one-off unique
WorkManager job (needs a network; a newer trigger replaces it) reads the
provider and sends `POST /device/state` to the Core with the stored address
(`ws`→`http`, `wss`→`https`) and the device token as a bearer header. It gives
up quietly without the local network permission, token or address, retries
network errors/5xx at most 5 times and gives up on other answers (any 4xx). The
broadcast's extras are ignored (any app could send it): the value always
comes from the provider, whose owner is checked.

## Security notes

- **Device token**: `shadow.deviceToken` is encrypted with AES-256-GCM under a
  non-exportable Android Keystore key (`shadow.deviceToken.v1`, no user
  authentication so the assist gesture connects without a prompt); the blob
  is in its own SharedPreferences file and is bound to its key name (AAD). If
  the key is lost the blob is deleted and the UI asks for the token again. If
  encryption fails the token is **not** stored (never a plaintext fallback).
  Other keys (`shadow.coreUrl`, `shadow.quality`, …) are plain
  SharedPreferences. Backups and device-to-device transfer are disabled.
- **Cleartext**: `network_security_config.xml` permits cleartext only to
  `192.168.1.2`; everything else must be HTTPS/WSS with a system CA. A
  `ws://` address to any other host is refused by the WebView, and the app
  says so (`CoreAddress.CLEARTEXT_HOST` and the XML are checked against each
  other by a unit test).
- **WebView**: the bundle is served by `WebViewAssetLoader` from
  `https://appassets.androidplatform.net/assets/ui/`; file and content access
  are off; DOM storage is off (storage goes through the bridge). Every request
  that is not a bundle asset is answered `403`, every navigation off the
  bundle is blocked, so no foreign page ever shares the WebView with the
  bridge; the bridge methods also do nothing unless the main frame is the
  bundle.
- **Content-Security-Policy** on every bundle response
  (`UiOrigin.CONTENT_SECURITY_POLICY`): scripts only from the bundle (no
  inline, no eval), no frames/plugins, and `connect-src` limited to the
  bundle, `ws://192.168.1.2:*` and `wss:`. WebSocket handshakes do not pass
  through `shouldInterceptRequest`, so this is what keeps a plain `ws://`
  connection — and the token in `hello` — from going to any other host.
- **Mixed content**: Chromium only lets an https page open `ws://` with
  `MIXED_CONTENT_ALWAYS_ALLOW`. Because all non-asset HTTP(S) requests are
  refused anyway, that setting in practice admits only WebSockets, which the
  CSP limits to `192.168.1.2` (plain) or TLS.
  (Alternative if a device ever refuses this: serve the bundle from
  `http://appassets…` with `setHttpAllowed(true)` and keep mixed content off.)
- WebView remote debugging (`chrome://inspect`) is on only in debug builds;
  there the page — and so the token — is inspectable over USB.

## Microphone format

`stopCapture` returns `{"mime":"audio/wav","data":<base64 NO_WRAP>,"durationMs":…}`:
16 kHz mono 16-bit PCM WAV. The Core accepts any `audio/*` mime in the `audio`
message and whisper-svc decodes WAV with PyAV/FFmpeg. 60 s (the UI's
auto-stop) is about 2.6 MB base64, far below the Core frame limit (36 MiB) and
whisper-svc's 25 MB upload limit. Audio past 65 s is dropped.

## Default assistant (power key)

1. Install and open the app once.
2. Settings → Apps → Default apps → **Digital assistant app** → *Default
   digital assistant app* → **Shadow** (wording differs by vendor).
3. Trigger it with the assist gesture:
   - Pixel/stock Android: Settings → System → Gestures → *Press and hold
     power button* → **Digital assistant**.
   - Samsung One UI: Settings → Advanced features → **Side button** → *Press
     and hold* → **Digital assistant** (shown on recent One UI versions; older
     ones only offer Bixby/power-off menu — then use the navigation gesture:
     swipe up from a bottom corner, or long-press the home button).

The assist gesture opens Shadow's main screen; press the talk button to speak.
(Starting to listen automatically on the assist gesture is not part of bridge
contract v1; it would need a new host event in docs/03.)

Known side effect: while Shadow is the default assistant, Android also makes
its recognition service the system default speech recognizer. Shadow's is a
stub that refuses requests (speech-to-text runs on the Core), so apps that use
the *system* `SpeechRecognizer` (not Gboard's own voice typing) get an error.

## CI and signing

Workflow: [`.github/workflows/android.yml`](../.github/workflows/android.yml)
(separate from `ci.yml`). On pushes to `main` and PRs touching `android/`, `ui/` or the
workflow, and on manual dispatch, it builds `ui/dist`, runs unit tests and
lint, and builds the **debug APK** (artifact `shadow-debug-apk`). If all four
signing secrets exist (and the run is not a pull request) it also builds a
**signed release APK** (artifact `shadow-release-apk`) and verifies the
signature with `apksigner`. `versionCode` is the workflow run number, so each
CI release installs over the previous one. `versionName` is `0.1.0-ci.<run>`
(`X.Y.Z` for a release tag, see below); local builds keep `0.1.0` / `1`
unless `-PshadowVersionName` / `-PshadowVersionCode` are given.

The keystore never enters the repository: CI decodes it from a secret into
the runner's temp directory and deletes it at the end of the job.

### One-time setup (you)

1. Create an upload/signing key on your PC (keep the file and passwords in
   your password manager; losing them means users must uninstall to update):

   ```sh
   keytool -genkeypair -v -keystore shadow-release.jks -alias shadow \
     -keyalg RSA -keysize 4096 -validity 10000
   ```

   Keep `shadow-release.jks` **outside** the repository (`*.jks` is
   git-ignored anyway).
2. Base64-encode it (one line):
   - Git Bash / Linux: `base64 -w0 shadow-release.jks > keystore.b64`
   - PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("shadow-release.jks")) | Set-Content keystore.b64`
3. GitHub → repository → Settings → Secrets and variables → Actions → *New
   repository secret*, create:

   | Secret | Value |
   |---|---|
   | `SHADOW_KEYSTORE_BASE64` | contents of `keystore.b64` |
   | `SHADOW_KEYSTORE_PASSWORD` | keystore password |
   | `SHADOW_KEY_ALIAS` | `shadow` (the alias you chose) |
   | `SHADOW_KEY_PASSWORD` | key password |

   Delete `keystore.b64` afterwards.
4. Run the **Android** workflow (Actions → Android → Run workflow) and
   download `shadow-release-apk`.

Local signed build (optional): set the same values as environment variables
`SHADOW_KEYSTORE_PATH` (path to the `.jks`), `SHADOW_KEYSTORE_PASSWORD`,
`SHADOW_KEY_ALIAS`, `SHADOW_KEY_PASSWORD` and run `./gradlew assembleRelease`.
Without them `assembleRelease` produces an unsigned APK.

The repository is public, so workflow artifacts can be downloaded by other
GitHub users. The APK contains no token or address beyond the documented
`192.168.1.2` default.

Signing keys (`*.jks`, `*.keystore`) and `local.properties` are git-ignored and
must never be committed.

## Releases and in-app update

Design: [`docs/10-android-updates.md`](../docs/10-android-updates.md).

**Publishing (you):** push a tag `vX.Y.Z` (strictly three numbers, e.g.
`git tag v0.2.0 && git push origin v0.2.0`). The same **Android** workflow then
builds and tests as usual, refuses the tag if it is not `vX.Y.Z` or if any
signing secret is missing, builds the signed APK with `versionName X.Y.Z` and
`versionCode` = run number, and a separate `release` job (the only one with
`contents: write`; it never sees the signing secrets) publishes a GitHub
Release with two assets:

- `shadow-vX.Y.Z.apk`: the signed APK,
- `update.json`: `{"versionCode": N, "versionName": "X.Y.Z", "apk": "shadow-vX.Y.Z.apk", "sha256": "<hex>"}`,
  read back from the built APK by CI.

A release is never overwritten: if the tag's release already exists (e.g. a
re-run) the job fails; push a new tag instead.

**Versioning:** "newer" means a higher `versionCode` only (the run number is
shared by main pushes and tags). A main-push artifact installed after a release
is therefore not offered the older release; the next release supersedes it.

**Updating (phone):** long-press the Shadow icon → **Güncellemeleri denetle**.
It reads the latest release of this repository, shows "X.Y.Z mevcut" if its
`versionCode` is higher than the installed one, and on **Güncelle**:

1. asks once for "Bilinmeyen uygulamaları yükle" for Shadow (system settings),
2. downloads the APK (HTTPS only, hosts `api.github.com`, `github.com`,
   `objects.githubusercontent.com`, `release-assets.githubusercontent.com`,
   redirects re-checked, at most 60 MB) into the app's private cache,
3. checks SHA-256 against `update.json`, package name, `versionCode`
   (= `update.json`, > installed) and that the signer equals the installed
   app's (or is a key-rotation successor of it),
4. hands it to `PackageInstaller`; Android always shows its own install
   confirmation. The file is deleted afterwards.

Nothing is checked automatically or in the background. An in-place update keeps
the device token, settings, permissions and the assist role (same package, same
key, higher `versionCode`). Android itself also refuses a different key or a
lower version, without touching data.

### Debug build on the phone? (one-time)

The update only works if the installed app is signed with the release key.
To find out without `adb`: open the newest CI `shadow-release-apk` (or a
release APK) on the phone. If it installs as an update, nothing to do. If the
installer refuses ("uygulama yüklenmedi" / package conflict), the phone has a
debug build; the installer changes nothing. Then choose once:

- **A. Reinstall (recommended):** uninstall, install the release APK, enter the
  device token again, re-grant permissions, pick Shadow as assist app again.
  All later updates keep data.
- **B. Key rotation** (APK Signature Scheme v3, Android 9+): rotate from the
  debug key to the release key with `apksigner rotate` and sign releases with
  the lineage. Keeps data but needs an extra CI signing step and a lineage
  file; the in-app check already accepts a rotation successor.
- **C. Debug key as release key:** not recommended (ties releases to a
  dev-tool key that can be regenerated).
