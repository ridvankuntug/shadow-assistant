#!/usr/bin/env bash
# Offline scenario tests for shadow-core-update.sh (T12.2) and the parts of
# install-core.sh it uses (release, switch) or that install it. No network, no
# systemd: curl and systemctl are fakes on PATH, every system path lives under
# a test root (--root). A real signing key pair is made for each run.
#
# Needs Linux with bash, GNU coreutils/tar, openssl, node and flock, e.g.:
#   docker run --rm -v "$PWD/deploy/linux:/d:ro" debian:bookworm-slim sh -c \
#     'apt-get update -qq && apt-get install -y -qq openssl nodejs >/dev/null && bash /d/tests/shadow-core-update.test.sh'
# Exit 0 when every scenario passes.

# check takes its condition in single quotes on purpose (evaluated later).
# shellcheck disable=SC2016,SC2012
set -uo pipefail
export LC_ALL=C

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
W="$(mktemp -d)"
trap 'rm -rf -- "$W"' EXIT
NODE_BIN="$(command -v node || command -v nodejs || true)"
[[ -n "$NODE_BIN" ]] || { echo "node is needed" >&2; exit 2; }
for t in openssl flock tar sha256sum; do command -v "$t" >/dev/null || { echo "$t is needed" >&2; exit 2; }; done

PASS=0
FAIL=0
CURRENT_TEST=""
ok() { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); printf 'FAIL [%s]: %s\n' "$CURRENT_TEST" "$*"; printf -- '--- output:\n'; sed 's/^/    /' "$W/out" 2>/dev/null; }
check() { if eval "$1"; then ok; else bad "$2"; fi; }

# ---------------------------------------------------------------- keys
mkdir -p "$W/keys"
openssl ecparam -name prime256v1 -genkey -noout -out "$W/keys/good.key" 2>/dev/null
openssl pkey -in "$W/keys/good.key" -pubout -out "$W/keys/good.pub" 2>/dev/null
openssl ecparam -name prime256v1 -genkey -noout -out "$W/keys/other.key" 2>/dev/null

# ---------------------------------------------------------------- fakes
mkdir -p "$W/bin"
cat > "$W/bin/curl" <<'EOF'
#!/usr/bin/env bash
# Fake curl: serves $FIX/api/page-<n>.json, $FIX/dl/<tag>/<asset> and the
# Core's /health (the VERSION of the test root's current release).
out="" url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w|-H|-A|--max-time|--connect-timeout|--max-filesize|--proto|--proto-redir|--noproxy) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\n' "$url" >> "$FAKE_STATE/curl.log"
if [[ -e "$FAKE_STATE/offline" && "$url" == https://* ]]; then printf '000'; echo "curl: (6) Could not resolve host" >&2; exit 6; fi
case "$url" in
  "https://api.github.com/repos/"*"/releases?per_page=100&page="*)
    f="$FIX/api/page-${url##*page=}.json" ;;
  "https://github.com/"*"/releases/download/"*)
    f="$FIX/dl/${url#*/releases/download/}" ;;
  "http://127.0.0.1:8701/health")
    cur="$FAKE_ROOT/opt/shadow-assistant/core/current"
    if [[ -e "$FAKE_STATE/core-down" || -e "$cur/BROKEN" || ! -f "$cur/VERSION" ]]; then
      printf '000'; echo "curl: (7) Failed to connect" >&2; exit 7
    fi
    v="$(head -n1 "$cur/VERSION")"
    [[ ! -f "$FAKE_STATE/health-version" ]] || v="$(cat "$FAKE_STATE/health-version")"
    printf '{"status":"ok","service":"core","version":"%s"}' "$v" > "$out"
    printf '200'; exit 0 ;;
  *) printf '000'; echo "fake curl: unexpected URL $url" >&2; exit 3 ;;
esac
if [[ -f "$f" ]]; then cp -- "$f" "$out"; printf '200'; else printf 'Not Found' > "$out"; printf '404'; fi
EOF
cat > "$W/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_STATE/systemctl.log"
case "$1" in
  is-active) [[ ! -e "$FAKE_STATE/inactive" ]] ;;
  --version) echo "systemd 252 (252.0)" ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$W/bin/curl" "$W/bin/systemctl"

# ---------------------------------------------------------------- fixtures
FIX="$W/fix"
R="$W/root"
FS="$W/state"

# release_tree <dir> <version> [broken]: the layout install-core.sh checks.
release_tree() {
  local d="$1" v="$2"
  mkdir -p "$d/core/dist" "$d/core/prompts" "$d/core/node_modules/x" "$d/ui/dist"
  printf '%s\n' "$v" > "$d/VERSION"
  echo '{"type":"module"}' > "$d/core/package.json"
  echo "// core $v" > "$d/core/dist/index.js"
  echo system > "$d/core/prompts/system.md"
  echo tier1 > "$d/core/prompts/tier1.md"
  echo "services: {}" > "$d/services.yaml"
  echo "routes: []" > "$d/router.yaml"
  echo "module.exports = 1" > "$d/core/node_modules/x/index.js"
  [[ "${3:-}" != broken ]] || touch "$d/BROKEN"
}

# publish <version> [broken|badsig|badsum|badversion|nosig]: the three assets.
publish() {
  local v="$1" how="${2:-}" tag="core-v$1" name dir stage pv="$1"
  name="shadow-$tag-linux-arm64"
  dir="$FIX/dl/$tag"
  stage="$W/stage/$tag"
  rm -rf -- "$dir" "$stage"; mkdir -p "$dir" "$stage"
  [[ "$how" != badversion ]] || pv="9.9.9"
  release_tree "$stage/$name" "$pv" "$( [[ "$how" == broken ]] && echo broken )"
  tar -C "$stage" -czf "$dir/$name.tar.gz" "$name"
  (cd "$dir" && sha256sum "$name.tar.gz" > SHA256SUMS)
  local key="$W/keys/good.key"
  [[ "$how" != badsig ]] || key="$W/keys/other.key"
  openssl dgst -sha256 -sign "$key" -out "$dir/SHA256SUMS.sig" "$dir/SHA256SUMS"
  if [[ "$how" == badsum ]]; then
    # Package changed after signing: the signed list no longer matches.
    echo tampered >> "$stage/$name/core/dist/index.js"
    tar -C "$stage" -czf "$dir/$name.tar.gz" "$name"
  fi
  [[ "$how" != nosig ]] || rm -f -- "$dir/SHA256SUMS.sig"
}

# api <entry>...: page 1 of the release list; an entry is "tag" or "tag|body".
api() {
  local e tag body first=1
  mkdir -p "$FIX/api"
  {
    printf '['
    for e in "$@"; do
      tag="${e%%|*}"; body=""; [[ "$e" != *"|"* ]] || body="${e#*|}"
      [[ $first -eq 1 ]] || printf ','
      first=0
      printf '{"tag_name":"%s","draft":false,"prerelease":false,"body":"%s"}' "$tag" "$body"
    done
    printf ']'
  } > "$FIX/api/page-1.json"
}

# fresh <installed version>...: a new test root with these releases; current
# is the last one.
fresh() {
  CURRENT_TEST="$1"; shift
  rm -rf -- "$R" "$FS" "$FIX" "$W/stage"
  mkdir -p "$R/etc/shadow-assistant" "$R/usr/local/lib/shadow-assistant" "$R/usr/bin" \
    "$R/opt/shadow-assistant/core/releases" "$R/var/lib" "$FS" "$FIX/dl"
  chmod 0755 "$R/opt/shadow-assistant" "$R/opt/shadow-assistant/core" "$R/opt/shadow-assistant/core/releases"
  printf 'CORE_HOST=127.0.0.1\nCORE_PORT="8701"\n' > "$R/etc/shadow-assistant/core.env"
  install -m 0644 "$W/keys/good.pub" "$R/etc/shadow-assistant/core-release.pub"
  install -m 0755 "$HERE/install-core.sh" "$R/usr/local/lib/shadow-assistant/install-core.sh"
  ln -s "$NODE_BIN" "$R/usr/bin/node"
  local v
  for v in "$@"; do
    release_tree "$R/opt/shadow-assistant/core/releases/$v" "$v"
    chmod -R go-w "$R/opt/shadow-assistant/core/releases/$v"
    ln -sfn "releases/$v" "$R/opt/shadow-assistant/core/current"
  done
  api
}

RC=0
upd() {
  PATH="$W/bin:$PATH" SHADOW_UPDATE_TEST=1 SHADOW_UPDATE_HEALTH_TIMEOUT=2 \
    FIX="$FIX" FAKE_ROOT="$R" FAKE_STATE="$FS" \
    bash "$HERE/shadow-core-update.sh" --root "$R" "$@" > "$W/out" 2>&1
  RC=$?
}
current() { readlink "$R/opt/shadow-assistant/core/current"; }
failed_list() { cat "$R/var/lib/shadow-assistant-updater/failed" 2>/dev/null; }
count() { local n; n="$(grep -c -- "$1" "$2" 2>/dev/null)"; printf '%s' "${n:-0}"; }
downloads() { count '/releases/download/' "$FS/curl.log"; }
pkg_downloads() { count '\.tar\.gz$' "$FS/curl.log"; }
restarts() { count '^restart shadow-core.service$' "$FS/systemctl.log"; }
out_has() { grep -qF -- "$1" "$W/out"; }

# ---------------------------------------------------------------- scenarios
fresh "update to the newest of the series" 0.2.5
publish 0.2.6; publish 0.2.7
api core-v0.3.1 v0.2.9 core-v0.2.7 core-v0.2.6 core-v0.2.5 core-v0.2.4
upd --now
check '[[ $RC -eq 0 ]]' "exit $RC"
check '[[ "$(current)" == releases/0.2.7 ]]' "current is $(current)"
check '[[ "$(restarts)" == 1 ]]' "restarts: $(restarts)"
check '[[ ! -e "$R/var/lib/shadow-assistant-updater/pending" ]]' "pending left behind"
check '[[ ! -e "$R/var/lib/shadow-assistant-updater/download" ]]' "download folder left behind"
check '! grep -q "core-v0.3.1\|core-v0.2.6/" "$FS/curl.log"' "downloaded another release"
check '[[ "$(stat -c %a "$R/var/lib/shadow-assistant-updater")" == 700 ]]' "state dir mode"
check 'out_has "SHA256SUMS signature verified" && out_has "package checksum verified"' "verification lines missing"

fresh "same version: no-op" 0.2.7
publish 0.2.7
api core-v0.2.7 core-v0.2.6
upd --now
check '[[ $RC -eq 0 ]] && out_has "up to date"' "exit $RC / message"
check '[[ "$(downloads)" == 0 && "$(restarts)" == 0 ]]' "downloads $(downloads), restarts $(restarts)"

fresh "X.Y mismatch: a new series is never taken" 0.2.5
publish 0.3.1
api core-v0.3.2 core-v0.3.1 core-v0.2.5
upd --now
check '[[ $RC -eq 0 && "$(current)" == releases/0.2.5 && "$(downloads)" == 0 ]]' "rc $RC current $(current) downloads $(downloads)"

fresh "signature reject: nothing installed, package never downloaded" 0.2.5
publish 0.2.6 badsig
api core-v0.2.6 core-v0.2.5
upd --now
check '[[ $RC -eq 1 ]] && out_has "signature of SHA256SUMS does not verify"' "exit $RC"
check '[[ "$(current)" == releases/0.2.5 && "$(pkg_downloads)" == 0 && "$(restarts)" == 0 ]]' "current $(current) pkg $(pkg_downloads) restarts $(restarts)"
check '[[ ! -e "$R/opt/shadow-assistant/core/releases/0.2.6" && -z "$(failed_list)" ]]' "release dir or failed entry"

fresh "missing signature (still uploading): quiet, nothing installed" 0.2.5
publish 0.2.6 nosig
api core-v0.2.6 core-v0.2.5
upd --now
check '[[ $RC -eq 0 && "$(current)" == releases/0.2.5 && "$(pkg_downloads)" == 0 ]]' "rc $RC current $(current)"

fresh "checksum reject" 0.2.5
publish 0.2.6 badsum
api core-v0.2.6 core-v0.2.5
upd --now
check '[[ $RC -eq 1 ]] && out_has "does not match the signed SHA256SUMS"' "exit $RC"
check '[[ "$(current)" == releases/0.2.5 && "$(restarts)" == 0 && ! -e "$R/opt/shadow-assistant/core/releases/0.2.6" ]]' "installed anyway"

fresh "package VERSION differs from the tag" 0.2.5
publish 0.2.6 badversion
api core-v0.2.6 core-v0.2.5
upd --now
check '[[ $RC -eq 1 && "$(current)" == releases/0.2.5 ]] && out_has "package'"'"'s VERSION is '"'"'9.9.9'"'"'"' "rc $RC"

fresh "failed version is skipped (older one taken)" 0.2.5
publish 0.2.6; publish 0.2.7
api core-v0.2.7 core-v0.2.6 core-v0.2.5
mkdir -p "$R/var/lib/shadow-assistant-updater"; chmod 0700 "$R/var/lib/shadow-assistant-updater"; echo 0.2.7 > "$R/var/lib/shadow-assistant-updater/failed"
upd --now
check '[[ $RC -eq 0 && "$(current)" == releases/0.2.6 ]]' "rc $RC current $(current)"
check '! grep -q "core-v0.2.7/" "$FS/curl.log" && out_has "0.2.7 failed before"' "0.2.7 touched"

fresh "health failure: rollback, recorded, never retried" 0.2.5
publish 0.2.6 broken
api core-v0.2.6 core-v0.2.5
upd --now
check '[[ $RC -eq 1 && "$(current)" == releases/0.2.5 ]]' "rc $RC current $(current)"
check '[[ "$(failed_list)" == 0.2.6 && "$(restarts)" == 2 ]]' "failed '$(failed_list)' restarts $(restarts)"
check 'out_has "güncelleme geri alındı (0.2.6)" && out_has "the Core runs 0.2.5 again"' "rollback lines"
check '[[ ! -e "$R/var/lib/shadow-assistant-updater/pending" ]]' "pending left behind"
: > "$FS/curl.log"
upd --now
check '[[ $RC -eq 0 && "$(current)" == releases/0.2.5 && "$(downloads)" == 0 ]] && out_has "up to date"' "retried: rc $RC downloads $(downloads)"

fresh "prune: current and two previous are kept" 0.2.1 0.2.2 0.2.3 0.2.4 0.2.5
publish 0.2.7
api core-v0.2.7 core-v0.2.5
upd --now
check '[[ $RC -eq 0 && "$(current)" == releases/0.2.7 ]]' "rc $RC current $(current)"
check '[[ "$(ls "$R/opt/shadow-assistant/core/releases" | tr "\n" " ")" == "0.2.4 0.2.5 0.2.7 " ]]' "left: $(ls "$R/opt/shadow-assistant/core/releases" | tr '\n' ' ')"

fresh "prune keeps the previous release even if it is older" 0.2.8 0.2.9 0.2.3
publish 0.2.10
api core-v0.2.10 core-v0.2.9 core-v0.2.8 core-v0.2.3
upd --now
check '[[ $RC -eq 0 && "$(current)" == releases/0.2.10 ]]' "rc $RC current $(current)"
check '[[ "$(ls "$R/opt/shadow-assistant/core/releases" | sort -V | tr "\n" " ")" == "0.2.3 0.2.9 0.2.10 " ]]' "left: $(ls "$R/opt/shadow-assistant/core/releases" | tr '\n' ' ')"

fresh "offline: quiet exit, nothing changed" 0.2.5
touch "$FS/offline"
upd --now
check '[[ $RC -eq 0 && "$(current)" == releases/0.2.5 ]] && out_has "not reachable"' "rc $RC"

fresh "GitHub answers an HTTP error: quiet" 0.2.5
rm -f "$FIX/api/page-1.json"
upd --now
check '[[ $RC -eq 0 ]] && out_has "answered HTTP 404"' "rc $RC"

fresh "data-format change blocks it and later releases" 0.2.5
publish 0.2.6; publish 0.2.7
api core-v0.2.7 "core-v0.2.6|Notes\\n\\ndata-format-change: conversations move" core-v0.2.5
upd --now
check '[[ $RC -eq 0 && "$(current)" == releases/0.2.5 && "$(downloads)" == 0 ]] && out_has "data-format change"' "rc $RC current $(current)"

fresh "data-format change in a later release: the earlier one is taken" 0.2.5
publish 0.2.6; publish 0.2.7
api "core-v0.2.7|DATA-FORMAT-CHANGE" core-v0.2.6 core-v0.2.5
upd --now
check '[[ $RC -eq 0 && "$(current)" == releases/0.2.6 ]]' "rc $RC current $(current)"

fresh "drafts and pre-releases are ignored" 0.2.5
publish 0.2.6
printf '[{"tag_name":"core-v0.2.6","draft":true,"prerelease":false,"body":""},{"tag_name":"core-v0.2.6","draft":false,"prerelease":true,"body":""},{"tag_name":"core-v0.2.5","draft":false,"prerelease":false,"body":""}]' > "$FIX/api/page-1.json"
upd --now
check '[[ $RC -eq 0 && "$(current)" == releases/0.2.5 && "$(downloads)" == 0 ]]' "rc $RC current $(current)"

fresh "--check changes nothing" 0.2.5
publish 0.2.6
api core-v0.2.6 core-v0.2.5
upd --check
check '[[ $RC -eq 0 && "$(current)" == releases/0.2.5 && "$(downloads)" == 0 ]] && out_has "update available: 0.2.5 -> 0.2.6"' "rc $RC"

fresh "--dry-run verifies but installs nothing" 0.2.5
publish 0.2.6
api core-v0.2.6 core-v0.2.5
upd --dry-run
check '[[ $RC -eq 0 && "$(current)" == releases/0.2.5 && "$(pkg_downloads)" == 1 && "$(restarts)" == 0 ]] && out_has "dry run"' "rc $RC"
check '[[ ! -e "$R/opt/shadow-assistant/core/releases/0.2.6" ]]' "release dir created"

fresh "Core not running: no update" 0.2.5
publish 0.2.6
api core-v0.2.6 core-v0.2.5
touch "$FS/inactive"
upd --now
check '[[ $RC -eq 0 && "$(current)" == releases/0.2.5 && "$(downloads)" == 0 ]] && out_has "not running"' "rc $RC"

fresh "running Core reports another version: refuse" 0.2.5
publish 0.2.6
api core-v0.2.6 core-v0.2.5
echo 0.2 > "$FS/health-version"
upd --now
check '[[ $RC -eq 1 && "$(current)" == releases/0.2.5 && "$(downloads)" == 0 ]] && out_has "does not answer GET /health"' "rc $RC"

fresh "non-CI installed version (X.Y only): skipped" 0.2
publish 0.2.6
api core-v0.2.6
upd --now
check '[[ $RC -eq 0 && "$(current)" == releases/0.2 && "$(downloads)" == 0 ]] && out_has "not a CI release"' "rc $RC"

fresh "concurrent run: the second exits quietly" 0.2.5
publish 0.2.6
api core-v0.2.6 core-v0.2.5
mkdir -p "$R/var/lib/shadow-assistant-updater"; chmod 0700 "$R/var/lib/shadow-assistant-updater"
exec 8>>"$R/var/lib/shadow-assistant-updater/lock"; flock -n 8
upd --now
exec 8>&-
check '[[ $RC -eq 0 && "$(current)" == releases/0.2.5 ]] && out_has "in progress"' "rc $RC"

fresh "interrupted run is rolled back by the next run" 0.2.5 0.2.6
mkdir -p "$R/var/lib/shadow-assistant-updater"; chmod 0700 "$R/var/lib/shadow-assistant-updater"
printf 'prev_dir=0.2.5\nprev_version=0.2.5\nnew_version=0.2.6\nstage=installing\n' > "$R/var/lib/shadow-assistant-updater/pending"
api core-v0.2.6 core-v0.2.5
upd --now
check '[[ $RC -eq 1 && "$(current)" == releases/0.2.5 && "$(failed_list)" == 0.2.6 ]]' "rc $RC current $(current) failed $(failed_list)"
check '[[ ! -e "$R/var/lib/shadow-assistant-updater/pending" ]]' "pending left behind"

fresh "interrupted before the switch: not failed, installed again" 0.2.5
publish 0.2.6
mkdir -p "$R/var/lib/shadow-assistant-updater"; chmod 0700 "$R/var/lib/shadow-assistant-updater"
printf 'prev_dir=0.2.5\nprev_version=0.2.5\nnew_version=0.2.6\nstage=installing\n' > "$R/var/lib/shadow-assistant-updater/pending"
api core-v0.2.6 core-v0.2.5
upd --now
check '[[ $RC -eq 0 && "$(current)" == releases/0.2.6 && -z "$(failed_list)" && "$(restarts)" == 1 ]]' "rc $RC current $(current) failed '$(failed_list)' restarts $(restarts)"

fresh "rollback that cannot switch back keeps pending" 0.2.5
publish 0.2.6 broken
api core-v0.2.6 core-v0.2.5
# An installer copy whose switch fails (e.g. a full disk).
upd_with_failing_switch() {
  printf '#!/usr/bin/env bash\nif [[ "$1" == switch ]]; then echo "switch refused" >&2; exit 1; fi\nexec bash %q "$@"\n' "$HERE/install-core.sh" > "$R/usr/local/lib/shadow-assistant/install-core.sh"
  chmod 0755 "$R/usr/local/lib/shadow-assistant/install-core.sh"
  upd --now
}
upd_with_failing_switch
check '[[ $RC -eq 1 && "$(current)" == releases/0.2.6 && -f "$R/var/lib/shadow-assistant-updater/pending" && "$(failed_list)" == 0.2.6 ]]' "rc $RC current $(current)"
install -m 0755 "$HERE/install-core.sh" "$R/usr/local/lib/shadow-assistant/install-core.sh"
upd --now
check '[[ $RC -eq 1 && "$(current)" == releases/0.2.5 && ! -f "$R/var/lib/shadow-assistant-updater/pending" ]] && out_has "the Core runs 0.2.5 again"' "retry: rc $RC current $(current)"

fresh "rollback whose old Core stays down is repeated by the next run" 0.2.5
publish 0.2.6 broken
api core-v0.2.6 core-v0.2.5
upd --now
check '[[ $RC -eq 1 && "$(current)" == releases/0.2.5 && "$(failed_list)" == 0.2.6 ]]' "first: rc $RC current $(current)"
touch "$FS/core-down"
mkdir -p "$R/var/lib/shadow-assistant-updater"
printf 'prev_dir=0.2.5\nprev_version=0.2.5\nnew_version=0.2.6\nstage=rolling_back\n' > "$R/var/lib/shadow-assistant-updater/pending"
: > "$FS/systemctl.log"
upd --now
check '[[ $RC -eq 1 && "$(restarts)" == 1 && -f "$R/var/lib/shadow-assistant-updater/pending" ]] && grep -q "^stage=rolling_back$" "$R/var/lib/shadow-assistant-updater/pending" && out_has "rollback of 0.2.6 did not finish" && out_has "does not answer GET /health either"' "repeat while down: rc $RC restarts $(restarts)"
: > "$FS/systemctl.log"
upd --now
check '[[ $RC -eq 1 && "$(restarts)" == 1 && -f "$R/var/lib/shadow-assistant-updater/pending" ]]' "second repeat while down: rc $RC restarts $(restarts)"
rm -f "$FS/core-down"; : > "$FS/systemctl.log"
upd --now
check '[[ $RC -eq 1 && "$(restarts)" == 1 && ! -f "$R/var/lib/shadow-assistant-updater/pending" && "$(current)" == releases/0.2.5 ]] && out_has "the Core runs 0.2.5 again"' "recovered: rc $RC restarts $(restarts)"
upd --now
check '[[ $RC -eq 0 ]] && out_has "up to date"' "after recovery: rc $RC"

fresh "killed during the rollback (current already back): rollback repeated" 0.2.5 0.2.6
ln -sfn releases/0.2.5 "$R/opt/shadow-assistant/core/current"
mkdir -p "$R/var/lib/shadow-assistant-updater"; chmod 0700 "$R/var/lib/shadow-assistant-updater"
printf 'prev_dir=0.2.5\nprev_version=0.2.5\nnew_version=0.2.6\nstage=rolling_back\n' > "$R/var/lib/shadow-assistant-updater/pending"
api core-v0.2.6 core-v0.2.5
upd --now
check '[[ $RC -eq 1 && "$(restarts)" == 1 && "$(failed_list)" == 0.2.6 && ! -f "$R/var/lib/shadow-assistant-updater/pending" ]] && out_has "the Core runs 0.2.5 again"' "rc $RC restarts $(restarts) failed '$(failed_list)'"

fresh "history longer than the scan: no decision" 0.2.5
publish 0.2.600
for pg in 1 2 3 4 5; do
  { printf '['; for i in $(seq 1 100); do [[ $i -eq 1 ]] || printf ','; printf '{"tag_name":"core-v0.2.%d","draft":false,"prerelease":false,"body":""}' $((1000 - pg * 100 + 100 - i)); done; printf ']'; } > "$FIX/api/page-$pg.json"
done
upd --now
check '[[ $RC -eq 1 && "$(current)" == releases/0.2.5 && "$(downloads)" == 0 ]] && out_has "do not reach the installed"' "rc $RC"

fresh "a manual install waits for a running update (lock)" 0.2.5
mkdir -p "$R/var/lib/shadow-assistant-updater"; chmod 0700 "$R/var/lib/shadow-assistant-updater"
exec 8>>"$R/var/lib/shadow-assistant-updater/lock"; flock -n 8
PATH="$W/bin:$PATH" bash "$HERE/install-core.sh" switch 0.2.5 --root "$R" > "$W/out" 2>&1; RC=$?
exec 8>&-
check '[[ $RC -ne 0 ]] && out_has "in progress"' "rc $RC"

fresh "untrusted public key (group-writable): refuse" 0.2.5
publish 0.2.6
api core-v0.2.6 core-v0.2.5
chmod 0664 "$R/etc/shadow-assistant/core-release.pub"
upd --now
check '[[ $RC -eq 1 && "$(current)" == releases/0.2.5 && "$(downloads)" == 0 ]] && out_has "writable by group or others"' "rc $RC"

fresh "--root needs the test switch" 0.2.5
PATH="$W/bin:$PATH" bash "$HERE/shadow-core-update.sh" --root "$R" --check > "$W/out" 2>&1; RC=$?
check '[[ $RC -eq 1 ]] && out_has "deploy tests only"' "rc $RC"

# ---------------------------------------------------------------- install-core.sh
fresh "install-core.sh switch: atomic switch, refuses unknown names" 0.2.5 0.2.6
PATH="$W/bin:$PATH" bash "$HERE/install-core.sh" switch 0.2.5 --root "$R" > "$W/out" 2>&1; RC=$?
check '[[ $RC -eq 0 && "$(current)" == releases/0.2.5 ]]' "rc $RC current $(current)"
PATH="$W/bin:$PATH" bash "$HERE/install-core.sh" switch ../x --root "$R" > "$W/out" 2>&1; RC=$?
check '[[ $RC -ne 0 && "$(current)" == releases/0.2.5 ]]' "accepted ../x"
PATH="$W/bin:$PATH" bash "$HERE/install-core.sh" switch 0.2.9 --root "$R" > "$W/out" 2>&1; RC=$?
check '[[ $RC -ne 0 ]] && out_has "not an installed release"' "accepted a missing release"

fresh "install-core.sh release needs the existing releases folder" 0.2.5
publish 0.2.6
rm -rf "$R/opt"
PATH="$W/bin:$PATH" bash "$HERE/install-core.sh" release --release "$FIX/dl/core-v0.2.6/shadow-core-v0.2.6-linux-arm64.tar.gz" --root "$R" > "$W/out" 2>&1; RC=$?
check '[[ $RC -ne 0 && ! -e "$R/opt" ]] && out_has "run '"'"'install'"'"' first"' "rc $RC"

# install: the updater files and the timer (systemctl is skipped under --root,
# its lines are printed).
install_root() {
  CURRENT_TEST="$1"
  rm -rf -- "$R"; mkdir -p "$R/etc" "$R/usr/bin"
  printf 'root:x:0:0::/root:/bin/sh\npi:x:1000:1000::/home/pi:/bin/sh\n' > "$R/etc/passwd"
  printf '#!/bin/sh\necho v22.1.0\n' > "$R/usr/bin/node"; chmod +x "$R/usr/bin/node"
  release_tree "$W/rel" 0.2.5
}
install_root "install-core.sh install: installs the updater and enables its timer"
PATH="$W/bin:$PATH" bash "$HERE/install-core.sh" install --user pi --release "$W/rel" --root "$R" > "$W/out" 2>&1; RC=$?
check '[[ $RC -eq 0 ]]' "rc $RC"
check '[[ -x "$R/usr/local/sbin/shadow-core-update" && -f "$R/usr/local/lib/shadow-assistant/install-core.sh" ]]' "scripts not installed"
check 'cmp -s "$HERE/core-release.pub" "$R/etc/shadow-assistant/core-release.pub"' "public key not installed"
check '[[ -f "$R/etc/systemd/system/shadow-core-update.service" && -f "$R/etc/systemd/system/shadow-core-update.timer" ]]' "units not installed"
check 'out_has "skipped: systemctl enable --now shadow-core-update.timer"' "timer not enabled"
check '[[ "$(stat -c %a "$R/etc/shadow-assistant/core-release.pub")" == 644 && "$(stat -c %a "$R/usr/local/sbin/shadow-core-update")" == 755 ]]' "modes"
PATH="$W/bin:$PATH" bash "$HERE/install-core.sh" install --user pi --no-auto-update --root "$R" > "$W/out" 2>&1; RC=$?
check '[[ $RC -eq 0 && -f "$R/etc/shadow-assistant/core-update.disabled" ]] && out_has "skipped: systemctl disable --now shadow-core-update.timer"' "opt-out: rc $RC"
PATH="$W/bin:$PATH" bash "$HERE/install-core.sh" install --user pi --root "$R" > "$W/out" 2>&1; RC=$?
check '[[ $RC -eq 0 && -f "$R/etc/shadow-assistant/core-update.disabled" ]] && out_has "disable --now shadow-core-update.timer"' "opt-out not kept: rc $RC"
PATH="$W/bin:$PATH" bash "$HERE/install-core.sh" install --user pi --auto-update --root "$R" > "$W/out" 2>&1; RC=$?
check '[[ $RC -eq 0 && ! -e "$R/etc/shadow-assistant/core-update.disabled" ]] && out_has "enable --now shadow-core-update.timer"' "opt-in: rc $RC"
PATH="$W/bin:$PATH" bash "$HERE/install-core.sh" install --user pi --auto-update --no-auto-update --root "$R" > "$W/out" 2>&1; RC=$?
check '[[ $RC -ne 0 ]]' "both options accepted"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
