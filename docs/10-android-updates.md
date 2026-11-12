# 10 - Android: signed GitHub Releases and in-app update

Status: design (T14). Builds on the existing Android CI
([`.github/workflows/android.yml`](../.github/workflows/android.yml),
[`android/README.md`](../android/README.md#ci-and-signing)). Reference
implementation read (not copied verbatim): Buds Case Widget `Updater.kt`.
Nothing here may hold passwords, keystore contents or tokens.

## Problem

The Android app is installed by hand from a CI artifact or `adb`. It should get
signed builds from GitHub **Releases** and update itself from inside the app,
keeping its data: device token (`TokenCipher` / `AppStorage`, Keystore key
`shadow.deviceToken.v1`), runtime permissions, assist role, settings.
Android keeps all of these on an in-place update if and only if: same
`applicationId` (`app.shadowassistant.android`), same signing key (or a v3
rotation lineage from it), strictly higher `versionCode`.

## Current state

- **CI** (`android.yml`): on `main` pushes / PRs / dispatch builds `ui/dist`,
  tests, lint, debug APK; with the four secrets (not on PRs) a signed release
  APK artifact `shadow-release-apk`, checked with `apksigner verify`.
  `versionCode = github.run_number` (`-PshadowVersionCode`), `versionName` fixed
  `0.1.0`. No tag trigger, no Releases, `permissions: contents: read`.
- **Secrets exist** (created 2026-11-02): `SHADOW_KEYSTORE_BASE64`,
  `SHADOW_KEYSTORE_PASSWORD`, `SHADOW_KEY_ALIAS`, `SHADOW_KEY_PASSWORD`;
  `build.gradle.kts` reads them as `SHADOW_KEYSTORE_PATH` + the other three.
- **Signing certificates** (SHA-256 of the public certificate, from `apksigner verify --print-certs`):

  | APK | Signer | Cert SHA-256 |
  |---|---|---|
  | CI `shadow-release-apk` (run 3, versionCode 3) | `CN=Shadow Assistant` | `0be733ae…6d729d29` |
  | local `app/build/outputs/apk/release/app-release.apk` (2026-11-04, versionCode 1) | `CN=Shadow Assistant` | same |
  | local `app-debug.apk` (2026-11-07, versionCode 1) | `CN=Android Debug` | `46e1cdb0…df0c8544` (= `~/.android/debug.keystore`) |

  So the CI key and the local release key are the **same key**. Which APK is on
  the phone is not known (no `adb` used): CI release artifact or local release
  build → updates keep data; debug build (`adb install` per README) → see
  [One-time migration](#one-time-migration-if-the-phone-has-a-debug-build).
- Buds reference: tag `vX.Y.Z` → `versionCode = X*10000+Y*100+Z`, release job on
  tags with `contents: write`, `softprops/action-gh-release`; secrets
  `KEYSTORE_BASE64` / `KEYSTORE_PASSWORD` / `KEY_ALIAS` / `KEY_PASSWORD`; debug-key
  fallback when secrets are missing; updater is tap-only, HTTPS + host allowlist
  with manual redirects, size limit, checks package name + versionName after
  download, `PackageInstaller` session, `REQUEST_INSTALL_PACKAGES`.

## Decisions

### D1 — versionCode: keep `run_number`; decide "newer" by versionCode only

- Keep `versionCode = github.run_number` for every CI build (main and tag). It is
  monotonic across both channels and already ≥ anything installed (≤ 3).
  Buds' semver formula is **not** adopted: a release `v0.2.0` → 200 would block
  every later main artifact (run 4, 5, …) as a downgrade.
- `versionName`: tag build `X.Y.Z` (from tag `vX.Y.Z`, validated strictly);
  other CI builds `<gradle default>-ci.<run>`; local builds the gradle default.
  New Gradle property `-PshadowVersionName`. Display only.
- The in-app check compares **versionCode** (from `update.json`, D3) with the
  installed `longVersionCode`. Trade-off: a main artifact installed after a
  release (code 12) is not "downgraded" to an older release (code 11); the next
  release fixes it. Re-running a tag workflow reuses the run number: never
  replace a published APK.

### D2 — Release trigger: tags `v*` in the same `android.yml`

Same workflow so both channels share one `run_number` counter (a separate
workflow has its own counter → collisions). Tag build: strict
`^v\d+\.\d+\.\d+$` check, **fails** if signing secrets are missing (no silent
debug/unsigned release), then a `release` job with `permissions: contents:
write` creates the GitHub Release with `shadow-vX.Y.Z.apk` + `update.json`.
Concurrency for the publish job: own group, `cancel-in-progress: false`.
Main pushes stay artifact-only (as today). No other workflow changes.

### D3 — `update.json` release asset

Written by CI from the built APK (not from the tag alone):
`{"versionCode": N, "versionName": "X.Y.Z", "apk": "shadow-vX.Y.Z.apk", "sha256": "<hex>"}`.
GitHub's release API carries no Android versionCode; this file does, plus the
digest. Small, self-produced, same trust as the release itself.

### D4 — Security of the downloaded APK

Android already refuses an APK with a different signer or a lower versionCode
and never loses data for it. In addition (cheap, clear errors):

1. Only `https`, hosts `api.github.com`, `github.com`,
   `objects.githubusercontent.com`, `release-assets.githubusercontent.com`;
   redirects followed manually, each hop re-checked (as Buds). Existing
   `network_security_config.xml` already forbids cleartext and user CAs — no change.
2. Fixed repository in native code: `releases/latest` of this repo only; asset
   URLs must start with `https://github.com/<owner>/shadow-assistant/releases/download/`.
   Nothing comes from the WebView or the Core.
3. Size cap (e.g. 60 MB) and JSON cap; download to `cacheDir/update/`, deleted
   after the session commit or on any failure.
4. After download: SHA-256 equals `update.json.sha256`; `getPackageArchiveInfo`
   → package name equals ours, `longVersionCode == update.json.versionCode` and
   `> installed`; signer equals the installed signer
   (`GET_SIGNING_CERTIFICATES`, `hasSigningCertificate`-style check) so a wrong
   key gives "imza uyuşmuyor" instead of a generic installer error.
5. Install only via `PackageInstaller` session `MODE_FULL_INSTALL` with
   `setAppPackageName`; the system confirmation is always shown. Never
   uninstall, never clear data, no `adb`.

Not done (over-engineering for a single-user app): pinning the cert hash in
code (redundant with D4.4), release-notes rendering, background/periodic checks.

### D5 — Entry point: native, no `ui/` and no `ShadowBridge.kt` change

T15 edits the `ui/` top bar and `ShadowBridge.kt` in parallel. T14 therefore adds:

- a **static launcher shortcut** "Güncellemeleri denetle" (long-press the app
  icon) → a new small **`UpdateActivity`** (dialog theme, not exported; static
  shortcuts may target it). It runs check → "X.Y.Z mevcut, güncelle?" →
  download → install, and handles the "install unknown apps" special access
  (`canRequestPackageInstalls()` → `ACTION_MANAGE_UNKNOWN_APP_SOURCES` → back).
- No change to `MainActivity.kt` (the shortcut is manifest meta-data on its
  `<activity>` element), `ShadowBridge.kt`, `BridgeJs.kt` or `ui/`.
- Install status: `PendingIntent` to `UpdateActivity` (or an unexported
  receiver that forwards to it); the confirmation intent is not kept only in a
  static field, so process death does not lose it silently. If the app is in
  the background, the user re-opens the shortcut.
- Only on user action; no automatic check (an auto dialog would also interrupt
  the assist gesture).

Optional later (open question 2): a UI menu item calling a one-line bridge
method `openUpdates()` that starts `UpdateActivity` — only after T15 is merged.

### D6 — Data kept across updates (constraints for implementers)

Do not rename: SharedPreferences files, Keystore alias `shadow.deviceToken.v1`,
AAD, blob format (`AppStorage.kt`, `BridgeStorage.kt`, `TokenCipher.kt`),
component names of `MainActivity` and the `assist/` services (assist role).
`allowBackup=false` is irrelevant for in-place updates.

## One-time migration if the phone has a debug build

How to find out without `adb` and without risk: open the newest CI
`shadow-release-apk` on the phone. If Android installs it as an update, the
phone already had the release key — nothing to do. If it says the package
conflicts / "uygulama yüklenmedi", the phone has the debug key; the installer
refuses **without touching data**. Then choose (user decision, nothing automatic):

- **A. Reinstall once (recommended, simplest):** uninstall, install the
  release APK, re-enter the device token, re-grant permissions, re-select
  Shadow as assist app. Loses exactly that state; afterwards all updates keep data.
- **B. Key rotation (APK Signature Scheme v3 lineage, Android 9+, minSdk 29 ok):**
  once, locally, `apksigner rotate` from the debug key to the Shadow key;
  CI re-signs the release APK with `--lineage`. Keeps data, but adds a
  post-sign `apksigner sign` step in CI and a lineage file to manage. Worth it
  only if re-pairing is costly.
- **C. Use the debug key as the release key** (upload `debug.keystore` as the
  secret): keeps data, but ties the app forever to a dev-tool key that Android
  Studio may regenerate, and invalidates the three existing CI release builds.
  Not recommended.

## User steps (agents do NOT do these)

1. Secrets: already present; nothing to create unless the key changes (option C).
   Keep `shadow-release.jks` and its passwords backed up (password manager);
   losing them means a reinstall for every future update.
2. Repo settings → Actions → General → Workflow permissions: explicit
   `permissions: contents: write` in the release job is enough; check that no
   policy limits it. Optional: a tag ruleset so only you can create `v*` tags.
3. After T14 is merged: push a tag `vX.Y.Z` (each tag needs explicit approval
   to push), check the Release has `shadow-vX.Y.Z.apk` + `update.json`.
4. Run the debug/release check above; if debug, pick A/B/C.
5. First update via the shortcut: allow "Bilinmeyen uygulamaları yükle" for
   Shadow once, confirm the system install dialog.

## Tests

- JVM unit tests (no Android): `update.json` parse/validation, URL/host
  allowlist incl. redirect rejection, version decision (`>` only, equal and
  lower refused), SHA-256 compare, size caps.
- CI: workflow lint by running it on a test tag in a fork or after merge
  (cannot be verified locally; no push by agents).
- Manual on phone: update from N to N+1 keeps token (no token prompt),
  permissions, assist role; wrong-signer APK gives the signer error; airplane
  mode gives a clean network error.

## Implementation tasks

- [ ] T14.1 — Gradle: `-PshadowVersionName` (default `0.1.0`), versionCode
  unchanged. Files: `android/app/build.gradle.kts`.
- [ ] T14.2 — CI: tag trigger `v*`, strict tag check, versionName per D1,
  signing secrets required on tags, `update.json` + renamed APK, `release` job
  (`contents: write`, `softprops/action-gh-release`, own concurrency group),
  keystore removed in `always()`. Files: `.github/workflows/android.yml`.
- [ ] T14.3 — `Updater.kt` (pure logic + network): latest release, `update.json`,
  allowlist/redirects, download with caps, SHA-256, archive checks (package,
  versionCode, signer), `PackageInstaller` session. Files:
  `android/app/src/main/java/app/shadowassistant/android/Updater.kt`,
  `android/app/src/test/java/app/shadowassistant/android/UpdaterTest.kt`.
- [ ] T14.4 — `UpdateActivity` + shortcut: dialog flow, unknown-sources access,
  install status handling, Turkish strings. Files: `UpdateActivity.kt` (new),
  `AndroidManifest.xml` (`REQUEST_INSTALL_PACKAGES`, activity, receiver if
  used, shortcut meta-data on `MainActivity`), `res/xml/shortcuts.xml` (new),
  `res/values/strings.xml`, `res/values/themes.xml` (dialog theme if needed).
- [ ] T14.5 — Docs: `android/README.md` (Releases, update shortcut, debug vs
  release migration A/B/C, versioning), `docs/README.md` index line for this file.

Order: 14.1 → 14.2; 14.3 → 14.4; 14.5 last. No `ui/`, `ShadowBridge.kt`,
`MainActivity.kt` changes in any task.

## Kullanıcı kararı gerekli (open questions)

1. **Phone's current signer:** run the safe check; if debug, choose A (reinstall),
   B (rotation) or C (debug key as release key).
2. **Entry point:** shortcut only (D5), or also a UI menu item via a bridge
   method after T15 lands?
3. **Release cadence:** releases only on manual tags (proposed), or also keep
   using the per-push `shadow-release-apk` artifact for daily installs (both
   work with D1)?
