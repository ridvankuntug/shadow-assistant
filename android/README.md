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
- The app talks **only to the Core** (over `wss://`, e.g.
  `wss://<box>.<tailnet>.ts.net/ws` through the always-on box, or at home over
  `ws://` to the PC's private LAN address, see "Network"),
  never to Home Assistant or a model. The WebSocket and `hello`/token flow are the UI's own,
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
| `app/build.gradle.kts` | App module; task `copyUiBundle` copies `../ui/dist` into the APK assets (`assets/ui/`); tasks `generateNetworkSecurityConfigDebug` / `…Release` write the network security config per build type (see "Waking the PC") |
| `MainActivity.kt` | WebView host, hardening, lifecycle (`visibility` events), native error screen |
| `ShadowBridge.kt` | The `@JavascriptInterface` methods of `ShadowAndroid` |
| `CaptureController.kt` | Microphone state machine of the contract (permission, background cut, cancel) |
| `AudioRecordRecorder.kt` | 16 kHz mono PCM capture → `audio/wav` |
| `AudioPlayer.kt` / `Speaker.kt` | `playAudio` (Core voice) / `speak` (TextToSpeech fallback) |
| `TokenCipher.kt`, `BridgeStorage.kt` | Keystore-encrypted device token, plain other keys |
| `CoreAddress.kt`, `CoreProbe.kt` | Core address parsing, cleartext gate (private IPv4 only), page CSP, home/away selection and reachability check (`/health`) |
| `LocalNetworkPermission.kt` | When the Android 17 local network permission is needed / asked at startup |
| `WakeAddress.kt`, `WakeStore.kt`, `WakeFlow.kt`, `WakeNet.kt`, `WakeDialog.kt` | "Bilgisayarı uyandır" (docs/12 D2): wake address checks, encrypted wake token store, waking state machine, HTTP + scheduler, settings dialog |
| `CaseBattery.kt`, `CaseBatterySync.kt` | Buds case battery: validation, Core request, receiver + WorkManager job |
| `AppStorage.kt` | Opens the stores (shared by the activity and the background job) |
| `Updater.kt`, `UpdateActivity.kt` | In-app update from GitHub Releases: checks (`UpdateRules`), download, `PackageInstaller`; shortcut dialog |
| `assist/AssistServices.kt` | `VoiceInteractionService` + session + recognition stub |
| `src/main/nsc/network_security_config.xml` | Template of the network security config: cleartext permitted in base-config (no ranges in NSC); the gate is in code |

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
2. Let the Core accept connections from the always-on box: `CORE_HOST=0.0.0.0`
   (or the PC's LAN address `<pc-lan-ip>`), `CORE_PORT=8700` (default). Allow
   inbound TCP 8700 in the Windows firewall from the box (at least
   `<box-lan-ip>`). Restart the Core. Then give the Core its HTTPS address on
   the box: [docs/05 section 5](../docs/05-deploy.md#5-wake-endpoint-on-the-always-on-linux-box),
   "HTTPS addresses through Tailscale".
3. Open the app. There is no built-in address: the connect screen asks for
   it. Replace the example with `wss://<box>.<tailnet>.ts.net/ws`, paste the
   token and connect.
   The token is stored encrypted on the phone (below) and never logged.

## Network: home and away

The Core and wake-svc each have an **away** and an optional **home**
address (T21.3.3). Away: the tailnet-only HTTPS addresses that Tailscale
`serve` on the always-on box proxies to the PC and to wake-svc
(`wss://<box>.<tailnet>.ts.net/ws`, `https://<box>.<tailnet>.ts.net:8443`,
[docs/05 section 5](../docs/05-deploy.md#5-wake-endpoint-on-the-always-on-linux-box)).
Home: plain LAN addresses, so the phone needs no Tailscale at home
(`ws://<pc-lan-ip>:8700/ws`, `http://<box-lan-ip>:8704`).

- **Where they are entered.** The Core's away address is the UI's connect
  screen (`shadow.coreUrl`). The Core's home address and both wake addresses
  are in the native **Adresler** dialog (button on the "Çekirdeğe
  ulaşılamıyor" panel; the UI's **Adresler** button in Ayarlar and on the
  connect screen, through the bridge method `openAddresses()`; also opened
  by the first wake press). Every address
  may be empty: one address alone works.
- **Selection.** On every Core check (page loaded, return to the
  foreground, **Tekrar dene**, address/token change, a finished wake) the app
  asks the home address's `/health` first with a 1.5 s timeout and uses it if
  the Core answers; otherwise it asks the away address. The page reads the
  address in use through the bridge key `shadow.coreUrl` (the home address
  while it is selected); a change reloads the page. If neither answers, the
  current choice is kept. The UI's reconnect logic is unchanged. Wake: the
  home address is tried first; the away address only when the home one gives
  no answer at all; the waiting polls the Core at both addresses.
- **Cleartext gate.** Plain `ws://` / `http://` is accepted only to a private
  IPv4 address written as a plain dotted quad (10.0.0.0/8, 172.16.0.0/12,
  192.168/16; `CoreAddress.isPrivateIpv4Literal`); hostnames, public
  addresses, IPv6, user info and forms like `10.1` or `010.0.0.1` are
  refused. Android's network security config cannot express address ranges,
  so it permits cleartext in base-config; the gate is in code (dialog
  validation, storage, probe, wake) and in the page's CSP, which admits plain
  `ws://` only to the exact configured `host:port` (see "Security").
- **Upgrade.** A stored `wss://` Core address stays the away address. A
  stored `http://` wake address moves to the home slot if it is a private
  IPv4 address, otherwise it is dropped (`WakeStore.migrate`); `https://`
  stays the away address.

There is no built-in Core address: on first launch the UI's connect screen
asks for it (its form shows the UI's generic `ws://localhost:8700/ws` example,
which the app refuses; replace it with the `wss://` address). A stored plain
`ws://` address the gate refuses (e.g. a hostname) is dropped at start
(`BridgeStorage.forgetUnusableCoreUrl`); the token is kept and the connect
screen asks again.

When the Core cannot be reached (or the address is not allowed, see below),
the app shows a native error screen with **Tekrar dene** and **Adresi
değiştir** (back to the UI's settings to edit the address). The check asks
the Core's own `GET /health` (same host and port, `wss`→`https`; only a `200`
whose body says `"service":"core"` counts), run when the page has loaded, on
every return to the foreground and after the address or token changes. A
bare TCP connect would not do: the box's proxy accepts the connection even
while the PC is off (and answers `502`).

**Waking the PC (docs/12 D2).** On the "Çekirdeğe ulaşılamıyor" panel (and
only there: not for a blocked cleartext address, not for the local network
panel) a third button **Bilgisayarı uyandır** sends `POST /wake` to wake-svc
on the always-on box (docs/12 D1), which sends the Wake-on-LAN packet. The
first press opens **Adresler**: the box's home and away addresses
(`http://<box-lan-ip>:8704`, `https://<box>.<tailnet>.ts.net:8443`) and the
wake token (password field, paste; never shown again, empty = keep the
stored one; **Sil** deletes the addresses, the token and the Core's home
address). After `202` the panel shows "bilgisayar açılıyor…"
with the elapsed time and polls the Core's `/health` every 5 s (3 s timeout)
for at most 4 min; when the Core answers, the panel closes and the UI
reconnects. `401` / `429 auth_locked` / `429 rate_limited` (also any other
`429`) / `503 send_failed` / no answer each show their own text and never
start the waiting (the `429`s are told apart by the body's `error`, as the
docs/12 D1 contract says). **İptal**, closing the panel, leaving the app for
good or changing the Core address stops the flow.

- The wake token is AES-GCM under its **own** Keystore key
  (`shadow.wakeToken.v1`) in its **own** SharedPreferences file
  (`shadow_wake`), never a bridge key, so the page can never read it. If
  encryption fails nothing is stored; an undecryptable token is deleted and
  the dialog asks again. The token is never logged.
- `https://` is accepted to any host; plain `http://` only to a private IPv4
  address (or a development build's wake host, below). The WebView never
  talks to the box.
- **Development cleartext hosts come from the build, never from the
  repository, and are empty by default.** The network security config is
  generated from `app/src/main/nsc/` per build type
  (`generateNetworkSecurityConfigDebug` / `…Release`). **Debug builds only**:
  with the Gradle property `shadowCoreHost`
  (or the environment variable `SHADOW_CORE_HOST`) it allows plain `ws://` to
  that Core host; with `shadowWakeHost` (`SHADOW_WAKE_HOST`) plain `http://`
  to that wake host. The values also become `BuildConfig.CORE_CLEARTEXT_HOST`
  / `WAKE_CLEARTEXT_HOST` (`CoreAddress` / `WakeAddress.CLEARTEXT_HOST`); a
  Core host also adds `ws://<host>:*` to the CSP and turns on mixed content.
  Only an IPv4 address or a DNS name is accepted. Local development build
  only: `./gradlew assembleDebug -PshadowCoreHost=<pc-lan-ip>
  -PshadowWakeHost=<box-lan-ip>` (or the same keys in
  `~/.gradle/gradle.properties`, outside the repository). A release build
  ignores both (its NSC and `BuildConfig` never get a cleartext host, even
  when the properties are set).
- Phone setup (once): open the app while the PC is off, press **Bilgisayarı
  uyandır**, enter the Core's home address `ws://<pc-lan-ip>:8700/ws`, the
  wake addresses `http://<box-lan-ip>:8704` and
  `https://<box>.<tailnet>.ts.net:8443`, and paste the token from the box's
  `/etc/credstore/wake-svc.token` (docs/05 section 5), **Kaydet**. The wake
  goes out right after saving.

**Local network permission (Android 17+).** With `targetSdk` 37, Android 17
blocks connections to local network addresses unless the app holds the
runtime permission `ACCESS_LOCAL_NETWORK` ("Yerel ağ"). The Core's HTTPS name
resolves to a tailnet address (Tailscale's `100.64.0.0/10` range, through the
VPN), and a development build may use a LAN host; whether Android counts the
tailnet range as local is not verified on a device yet, so the permission is
kept. The app asks for it at
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
- **Cleartext** (T21.3.3): `network_security_config.xml` permits cleartext
  in base-config, because the home LAN addresses are entered on the phone and
  NSC cannot name address ranges; TLS always uses a system CA. The gate is in
  code: plain `ws://` / `http://` only to a private IPv4 literal (see
  "Network"), refused everywhere else, and the app says so. A development
  build may add its `shadowCoreHost` / `shadowWakeHost` (see "Waking the
  PC"). The updater accepts `https` only.
- **WebView**: the bundle is served by `WebViewAssetLoader` from
  `https://appassets.androidplatform.net/assets/ui/`; file and content access
  are off; DOM storage is off (storage goes through the bridge). Every request
  that is not a bundle asset is answered `403`, every navigation off the
  bundle is blocked, so no foreign page ever shares the WebView with the
  bridge; the bridge methods also do nothing unless the main frame is the
  bundle.
- **Content-Security-Policy** on every bundle response
  (`UiOrigin.pagePolicy`, fixed per page load): scripts only from the bundle
  (no inline, no eval), no frames/plugins, and `connect-src` limited to the
  bundle, `wss:` and plain `ws://<ip>:<port>` only for the exact configured
  Core address(es) that pass the cleartext gate (plus `ws://<host>:*` for a
  development build's Core host). WebSocket handshakes do not pass through
  `shouldInterceptRequest`, so this is what keeps a plain `ws://` connection
  — and the token in `hello` — from going anywhere else.
- **Mixed content** is off (`MIXED_CONTENT_NEVER_ALLOW`) unless a configured
  Core address is a plain `ws://` one that passes the gate (or a development
  Core host is set); only then `MIXED_CONTENT_ALWAYS_ALLOW`, because Chromium
  lets an https page open `ws://` only with it. All non-asset HTTP(S)
  requests are refused anyway, so it admits only WebSockets, which the CSP
  limits as above.
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
(separate from `ci.yml`). On pushes to `main` and PRs touching `android/`, `ui/`, `VERSION` or the
workflow, and on manual dispatch, it builds `ui/dist`, runs unit tests and
lint, and builds the **debug APK** (artifact `shadow-debug-apk`). If all four
signing secrets exist (and the run is not a pull request) it also builds a
**signed release APK** (artifact `shadow-release-apk`) and verifies the
signature with `apksigner`. `versionCode` is the workflow run number, so each
CI release installs over the previous one. `versionName` is derived by Gradle
as `X.Y.<versionCode>`, where `X.Y` is the content of the root
[`VERSION`](../VERSION) file (its only source; the build stops if it is not
`X.Y`); local builds without
`-PshadowVersionCode` are `X.Y.0` / `1`.

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

**No addresses in CI.** The CI workflow sets neither `SHADOW_CORE_HOST` nor
`SHADOW_WAKE_HOST`, and must not: the release APK reaches the Core and
wake-svc over `wss://` / `https://`, or in plain text only to private IPv4
addresses the user enters on the phone (see "Network: home and away").

The repository is public, so workflow artifacts can be downloaded by other
GitHub users. The APK contains no token and no address: the Core and wake
addresses are entered on the phone.

Signing keys (`*.jks`, `*.keystore`) and `local.properties` are git-ignored and
must never be committed.

## Releases and in-app update

Design: [`docs/10-android-updates.md`](../docs/10-android-updates.md).

**Publishing (automatic, docs/10 D7):** every push to `main` whose app
sources (`android/`, `ui/`, `VERSION`; not `*.md` or test sources) changed since the
latest release publishes a release. The **Android** workflow builds and tests
as usual, fails if any signing secret is missing, builds the signed APK
(`versionCode` = run number, `versionName` = `X.Y.<run>`), and a separate
`release` job (the only one with `contents: write`; it never sees the signing
secrets) publishes the GitHub Release `vX.Y.<run>` (tag created at the built
commit) with two assets:

- `shadow-vX.Y.<run>.apk`: the signed APK,
- `update.json`: `{"versionCode": N, "versionName": "X.Y.N", "apk": "shadow-vX.Y.N.apk", "sha256": "<hex>"}`,
  read back from the built APK by CI.

No release when nothing in the app changed (e.g. only the workflow or docs).
Pull requests, forks and manual runs never release. There is no manual tag
path: pushing a `v*` tag does nothing. A release is never overwritten: if the
release, its tag or a draft of it already exists (e.g. a re-run) the job fails.
To start a new `X.Y` line, edit the root `VERSION` file (e.g. `0.2` → `0.3`);
that commit itself releases.

**Versioning:** "newer" means a higher `versionCode` only (one run-number
counter for every build of this workflow). Never rename `android.yml`: a new
workflow restarts the run number at 1.

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
