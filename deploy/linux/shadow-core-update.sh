#!/usr/bin/env bash
# shadow-core-update: the Pi Core updater (docs/13-pi-core-and-agents.md section
# 6.2, T12.2; docs/05-deploy.md section 7 "Automatic updates"). Installed by
# install-core.sh as /usr/local/sbin/shadow-core-update; run as root by
# shadow-core-update.timer (shadow-core-update.service: --now).
#
#   shadow-core-update --check     show what would be installed; changes nothing
#   shadow-core-update --now       update now (what the timer runs)
#   shadow-core-update --dry-run   download and verify the update; installs nothing
#   shadow-core-update --help
# Test option: --root <dir> (prefix every system path; only with
# SHADOW_UPDATE_TEST=1, the deploy tests use it).
#
# A run (--now):
#   1. Reads the installed version from /opt/shadow-assistant/core/current/VERSION
#      (<X.Y>.<n>, a CI release). Only releases core-v<X.Y>.<m> of the same X.Y
#      with m > n count: a new X.Y series is installed by hand (install-core.sh).
#   2. Lists the GitHub releases (public repository, no token; Core releases are
#      never "latest"). Skips drafts, pre-releases, versions in the failed list
#      and every version from the first one whose notes contain
#      "data-format-change" (those need a manual step). Takes the newest left.
#   3. Needs shadow-core.service running and answering GET /health on
#      127.0.0.1:<CORE_PORT> with the installed version; otherwise it does not
#      update (it could not tell a bad release from a bad setup).
#   4. Downloads SHA256SUMS and SHA256SUMS.sig, verifies the ECDSA P-256
#      signature with /etc/shadow-assistant/core-release.pub FIRST, then
#      downloads the package and compares its SHA-256 with the signed list, and
#      checks that the package's VERSION is the release's version. Any mismatch:
#      nothing is installed (the run fails, see journalctl).
#   5. Installs it with install-core.sh release (copy to releases/<version>/,
#      atomic `current` switch), restarts shadow-core and waits up to 90 s for
#      GET /health with the new version.
#   6. On failure: records the version in /var/lib/shadow-assistant-updater/failed
#      (never retried), switches `current` back (install-core.sh switch),
#      restarts and waits for the old Core. Keeps `current` and the two newest
#      other releases (the previous one always), deletes older ones.
#   7. After a successful update only: installs the scripts and units of the
#      new release (its deploy/linux/: this updater, the copy of
#      install-core.sh, the TLS script, the five units) with that release's
#      install-core.sh deploy-files; daemon-reload. Never
#      the public key, core.env, local.conf or the credstore. A release
#      without deploy/linux/ (up to 0.2.4): skipped with a log line.
# Offline, GitHub down or rate-limited, assets not uploaded yet: one log line,
# exit 0, the next timer run tries again. Never touches the data folder, the
# vault clone, core.env, the credstore or the public key.
#
# This file holds no user names, addresses or tokens.

set -euo pipefail
umask 077
export LC_ALL=C

readonly REPO="ridvankuntug/shadow-assistant"
readonly API_URL="https://api.github.com/repos/$REPO/releases"
readonly DOWNLOAD_URL="https://github.com/$REPO/releases/download"
readonly UNIT_NAME="shadow-core.service"
readonly CORE_REAL=/opt/shadow-assistant/core
readonly ENV_REAL=/etc/shadow-assistant/core.env
readonly PUBKEY_REAL=/etc/shadow-assistant/core-release.pub
readonly INSTALLER_REAL=/usr/local/lib/shadow-assistant/install-core.sh
# Root-owned (not the Core's StateDirectory): the Core account cannot clear the
# failed list or plant a pending rollback.
readonly STATE_REAL=/var/lib/shadow-assistant-updater
readonly NODE_REAL=/usr/bin/node
readonly DEFAULT_CORE_PORT=8700     # core/src/config.ts
readonly KEEP_RELEASES=3            # current + two previous (docs/13 section 6.2)
readonly DATA_FORMAT_MARKER="data-format-change"
readonly PER_PAGE=100
readonly MAX_PAGES=5
readonly MAX_LIST_BYTES=$((16 * 1024 * 1024))
readonly MAX_SMALL_BYTES=65536
readonly MAX_PACKAGE_BYTES=$((1024 * 1024 * 1024))
HEALTH_TIMEOUT=90                   # seconds, docs/13 section 6.2
HEALTH_POLL=2

# ---------------------------------------------------------------- options
MODE=""
ROOT=""

usage() {
  sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

log() { printf 'shadow-core-update: %s\n' "$*"; }
err() { printf 'shadow-core-update: error: %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

parse_args() {
  [[ $# -gt 0 ]] || { usage; exit 2; }
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --check|--now|--dry-run)
        local m="${1#--}"
        # --now --dry-run is the same as --dry-run.
        if [[ -n "$MODE" && "$MODE" != "$m" ]]; then
          if [[ "$MODE$m" == nowdry-run || "$MODE$m" == dry-runnow ]]; then m=dry-run; else die "--$MODE and $1 exclude each other"; fi
        fi
        MODE="$m"; shift ;;
      --root)
        [[ $# -ge 2 && -n "$2" ]] || die "--root needs a value"
        ROOT="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option '$1' (--check, --now, --dry-run, --help)" ;;
    esac
  done
  [[ -n "$MODE" ]] || die "give --check, --now or --dry-run"
  if [[ -n "$ROOT" ]]; then
    [[ "${SHADOW_UPDATE_TEST:-}" == 1 ]] || die "--root is for the deploy tests only (SHADOW_UPDATE_TEST=1)"
    [[ -d "$ROOT" ]] || die "--root $ROOT is not a folder"
    ROOT="$(cd -- "$ROOT" && pwd -P)"
    [[ "$ROOT" != / ]] || ROOT=""
    # Short health wait in the tests only.
    if [[ "${SHADOW_UPDATE_HEALTH_TIMEOUT:-}" =~ ^[0-9]{1,3}$ ]]; then HEALTH_TIMEOUT="$SHADOW_UPDATE_HEALTH_TIMEOUT"; HEALTH_POLL=1; fi
  fi
}

p() { printf '%s%s' "$ROOT" "$1"; }   # on-disk path of a real path

# ---------------------------------------------------------------- checks
OWN_CHECK=1
check_root_and_tools() {
  if [[ -n "$ROOT" ]]; then
    [[ $EUID -eq 0 ]] || OWN_CHECK=0
  else
    [[ $EUID -eq 0 ]] || die "run as root (sudo shadow-core-update --$MODE)"
  fi
  local t
  for t in curl openssl sha256sum tar flock systemctl; do
    command -v "$t" >/dev/null 2>&1 || die "$t not found; the updater needs it"
  done
  [[ -x "$(p "$NODE_REAL")" ]] || die "$NODE_REAL not found (the Core's Node.js; used to read JSON)"
}

# A file the updater trusts (public key, installer): root's, a regular file,
# nobody else may write it.
check_trusted_file() {
  local real="$1" f mode
  f="$(p "$real")"
  [[ -f "$f" && ! -L "$f" ]] || die "$real is missing or not a regular file (run install-core.sh install again)"
  mode="$(stat -c '%a' -- "$f")"
  if [[ $OWN_CHECK -eq 1 && "$(stat -c '%u' -- "$f")" != 0 ]]; then die "$real is not owned by root; refusing"; fi
  (( (8#$mode & 8#022) == 0 )) || die "$real is writable by group or others (mode $mode); refusing"
}

# ---------------------------------------------------------------- state
STATE=""
DOWNLOAD_DIR=""
cleanup() { [[ -z "$DOWNLOAD_DIR" ]] || rm -rf -- "$DOWNLOAD_DIR"; }
trap cleanup EXIT

prepare_state() {
  STATE="$(p "$STATE_REAL")"
  [[ ! -L "$STATE" ]] || die "$STATE_REAL is a symlink; refusing"
  if [[ ! -d "$STATE" ]]; then
    [[ ! -e "$STATE" ]] || die "$STATE_REAL exists and is not a folder"
    mkdir -m 0700 -- "$STATE"
  fi
  if [[ $OWN_CHECK -eq 1 && "$(stat -c '%u' -- "$STATE")" != 0 ]]; then die "$STATE_REAL is not owned by root (uid $(stat -c '%u' -- "$STATE")); refusing (check its files, then: chown -R root:root $STATE_REAL)"; fi
  chmod 0700 -- "$STATE"
  check_state_files
}

# The files the updater reads or writes in its state folder. One not owned by
# root was written while the folder was open to another account (that account
# could have cleared `failed` or planted `pending`): refused, not repaired, so
# the content is checked by hand first. A symlink is refused too (every write
# here would follow it). Loose modes of root's own files are only tightened.
readonly STATE_FILES=(lock failed pending pending.new releases.json health.json download)
check_state_files() {
  local name f mode
  for name in "${STATE_FILES[@]}"; do
    f="$STATE/$name"
    [[ -e "$f" || -L "$f" ]] || continue
    [[ ! -L "$f" ]] || die "$STATE_REAL/$name is a symlink; refusing (remove it after checking it)"
    if [[ $OWN_CHECK -eq 1 && "$(stat -c '%u' -- "$f")" != 0 ]]; then
      die "$STATE_REAL/$name is not owned by root (uid $(stat -c '%u' -- "$f")); refusing (check its content, then: chown root:root $STATE_REAL/$name)"
    fi
    if [[ "$name" == download ]]; then
      [[ -d "$f" ]] || die "$STATE_REAL/download is not a folder; refusing"
      continue
    fi
    [[ -f "$f" ]] || die "$STATE_REAL/$name is not a regular file; refusing"
    mode="$(stat -c '%a' -- "$f")"
    if (( (8#$mode & 8#077) != 0 )); then
      log "$STATE_REAL/$name had mode $mode; set to 600"
      chmod 0600 -- "$f"
    fi
  done
}

# One run at a time (timer and a manual run). The lock is released when the
# process exits, also when it is killed. fd 9 stays open (and locked) for the
# whole run; install-core.sh, started by installer(), inherits it and checks
# that it really is this lock (SHADOW_CORE_UPDATE_LOCK_HELD alone is not
# trusted).
take_lock() {
  local lock="$STATE/lock"
  [[ ! -L "$lock" ]] || die "$STATE_REAL/lock is a symlink; refusing"
  exec 9>>"$lock"
  if ! flock -n 9; then
    log "another update run is in progress; nothing to do"
    exit 0
  fi
}

# An install killed between its mktemp and the final rename (install-core.sh
# release/install, SIGKILL or power loss: its EXIT trap never ran) leaves
# releases/.staging.<random>. Every install holds the lock, so with it held
# such a folder is a leftover. Only names mktemp makes, directly in releases/,
# real folders only (a symlink is left alone; rm -rf never follows links
# inside).
clean_staging() {
  local releases d name
  releases="$(p "$CORE_REAL/releases")"
  [[ -d "$releases" && ! -L "$releases" ]] || return 0
  if [[ $OWN_CHECK -eq 1 && "$(stat -c '%u' -- "$releases")" != 0 ]]; then
    log "$CORE_REAL/releases is not owned by root; leftover .staging folders are not removed"
    return 0
  fi
  for d in "$releases"/.staging.*; do
    [[ -e "$d" || -L "$d" ]] || continue
    name="${d##*/}"
    [[ "$name" =~ ^\.staging\.[0-9A-Za-z]{1,64}$ ]] || continue
    if [[ -L "$d" || ! -d "$d" ]]; then
      log "releases/$name is not a folder; left alone"
      continue
    fi
    log "removing releases/$name (left by an interrupted install)"
    # A leftover the service cannot delete (e.g. files of another account from
    # a manual install killed before its chown; the unit has no capabilities)
    # must not stop every later run before recover_pending: logged, kept.
    if ! rm -rf -- "${releases:?}/$name" 2>/dev/null; then
      err "could not remove all of releases/$name; remove it by hand (sudo rm -rf $CORE_REAL/releases/$name)"
    fi
  done
}

readonly VERSION_RE='^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$'

is_failed() {
  [[ -f "$STATE/failed" ]] && grep -qxF -- "$1" "$STATE/failed"
}

record_failed() {
  local v="$1"
  [[ "$v" =~ $VERSION_RE ]] || return 0
  if ! is_failed "$v"; then
    printf '%s\n' "$v" >> "$STATE/failed"
  fi
  log "recorded $v in $STATE_REAL/failed: it is never tried again (delete the line to allow it)"
}

# ---------------------------------------------------------------- HTTP
# gh_get <url> <out file> <max bytes> <max seconds>: HTTPS only (also after a
# redirect: release assets redirect to GitHub's download host). Prints the HTTP
# status ("000" when there was no answer); returns curl's exit code.
gh_get() {
  curl -sS -L --proto '=https' --proto-redir '=https' --tlsv1.2 \
    --connect-timeout 20 --max-time "$4" --max-filesize "$3" \
    -A 'shadow-core-update' -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    -w '%{http_code}' -o "$2" "$1"
}

# health_get <out file>: GET /health of the local Core (plain listener on
# 127.0.0.1, CORE_EXTRA_HOSTS), never through a proxy.
health_get() {
  curl -sS --proto '=http' --noproxy '*' --connect-timeout 3 --max-time 5 \
    --max-filesize "$MAX_SMALL_BYTES" -w '%{http_code}' -o "$1" \
    "http://127.0.0.1:$CORE_PORT/health"
}

node_json() { "$(p "$NODE_REAL")" -e "$1" -- "${@:2}"; }

# The last CORE_PORT= of core.env (systemd's EnvironmentFile= keeps the last;
# quotes removed as it does); default 8700.
CORE_PORT=""
read_core_port() {
  local env v=""
  env="$(p "$ENV_REAL")"
  if [[ -f "$env" ]]; then
    v="$(sed -n 's/^[[:space:]]*CORE_PORT[[:space:]]*=[[:space:]]*//p' "$env" | tail -n1)"
    v="${v%"${v##*[![:space:]]}"}"
    if [[ "$v" =~ ^\"(.*)\"$ || "$v" =~ ^\'(.*)\'$ ]]; then v="${BASH_REMATCH[1]}"; fi
  fi
  [[ -n "$v" ]] || v="$DEFAULT_CORE_PORT"
  if [[ ! "$v" =~ ^[1-9][0-9]{0,4}$ ]] || (( v > 65535 )); then die "CORE_PORT '$v' in $ENV_REAL is not a port number"; fi
  CORE_PORT="$v"
}

# health_version: the version the running Core reports, or nothing.
health_version() {
  local f="$STATE/health.json" code
  rm -f -- "$f"
  code="$(health_get "$f" 2>/dev/null)" || code=000
  [[ "$code" == 200 && -f "$f" ]] || { rm -f -- "$f"; return 0; }
  node_json 'try { const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); if (j && typeof j.version === "string" && /^[0-9A-Za-z._+-]{1,64}$/.test(j.version)) process.stdout.write(j.version); } catch {}' "$f" || true
  rm -f -- "$f"
}

# wait_health <version>: up to HEALTH_TIMEOUT seconds for GET /health = 200
# with that version.
wait_health() {
  local want="$1" deadline got=""
  deadline=$((SECONDS + HEALTH_TIMEOUT))
  while :; do
    got="$(health_version)"
    if [[ "$got" == "$want" ]]; then return 0; fi
    (( SECONDS < deadline )) || break
    sleep "$HEALTH_POLL"
  done
  log "GET /health did not report $want within ${HEALTH_TIMEOUT}s (last answer: ${got:-none})"
  return 1
}

# ---------------------------------------------------------------- installed release
CUR_DIR=""      # releases/<CUR_DIR> is current
CUR_VERSION=""  # its VERSION
SERIES=""       # X.Y
CUR_N=""
read_current() {
  local cur link
  cur="$(p "$CORE_REAL/current")"
  if [[ ! -L "$cur" ]]; then
    log "no Core installed ($CORE_REAL/current missing); install it first with install-core.sh"
    exit 0
  fi
  link="$(readlink -- "$cur")"
  [[ "$link" == releases/* && "${link#releases/}" != */* ]] || die "$CORE_REAL/current points to '$link', not to releases/<version>; refusing"
  CUR_DIR="${link#releases/}"
  [[ -f "$cur/VERSION" ]] || die "$CORE_REAL/current/VERSION is missing"
  CUR_VERSION="$(head -n1 -- "$cur/VERSION" | tr -d '[:space:]')"
  # A local build (VERSION holds only X.Y) is replaced by the newest CI
  # release of its series like an older one (user decision 2026-11-28): every
  # CI release is installed, by hand or not. To test a local build on the Pi,
  # turn automatic updates off first (install-core.sh --no-auto-update).
  if [[ "$CUR_VERSION" =~ ^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$ ]]; then
    SERIES="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"
    CUR_N=-1
    log "the installed Core is a local build ('$CUR_VERSION'); the newest core-v$SERIES.<n> replaces it"
    return 0
  fi
  if [[ ! "$CUR_VERSION" =~ $VERSION_RE ]]; then
    log "the installed Core is '$CUR_VERSION', neither a CI release (<X.Y>.<n>) nor a local build (<X.Y>); not updating automatically"
    exit 0
  fi
  SERIES="${BASH_REMATCH[1]}.${BASH_REMATCH[2]}"
  CUR_N="${BASH_REMATCH[3]}"
}

# ---------------------------------------------------------------- releases
# Prints "<version> <marker 0|1>" per Core release of any series and a first
# line "count <n>" for a page of the GitHub release list.
readonly PARSE_PAGE='
const fs = require("fs");
let data;
try { data = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); } catch { process.exit(3); }
if (!Array.isArray(data)) process.exit(3);
const out = ["count " + data.length];
const tag = /^core-v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/;
const marker = new RegExp(process.argv[2], "i");
for (const r of data) {
  if (!r || typeof r !== "object" || r.draft !== false || r.prerelease !== false) continue;
  const m = typeof r.tag_name === "string" ? tag.exec(r.tag_name) : null;
  if (!m) continue;
  const body = typeof r.body === "string" ? r.body : "";
  out.push(m[1] + "." + m[2] + "." + m[3] + " " + (marker.test(body) ? 1 : 0));
}
process.stdout.write(out.join("\n") + "\n");
'

TARGET=""             # version to install, empty = none
SKIP_NOTES=()
list_releases() {
  local page=1 code f lines count v mark n stop=0 marker_min="" cand=() x
  f="$STATE/releases.json"
  while (( page <= MAX_PAGES )); do
    rm -f -- "$f"
    if ! code="$(gh_get "$API_URL?per_page=$PER_PAGE&page=$page" "$f" "$MAX_LIST_BYTES" 60 2>/dev/null)"; then
      rm -f -- "$f"
      log "GitHub is not reachable (release list); trying again at the next run"
      exit 0
    fi
    if [[ "$code" != 200 ]]; then
      rm -f -- "$f"
      log "GitHub answered HTTP $code for the release list (offline, rate limit or outage); trying again at the next run"
      exit 0
    fi
    lines="$(node_json "$PARSE_PAGE" "$f" "$DATA_FORMAT_MARKER")" || { rm -f -- "$f"; log "the GitHub release list could not be read; trying again at the next run"; exit 0; }
    rm -f -- "$f"
    count=""
    while read -r v mark; do
      if [[ "$v" == count ]]; then count="$mark"; continue; fi
      [[ "$v" =~ $VERSION_RE ]] || continue
      [[ "${BASH_REMATCH[1]}.${BASH_REMATCH[2]}" == "$SERIES" ]] || continue
      n="${BASH_REMATCH[3]}"
      if (( n <= CUR_N )); then stop=1; continue; fi
      cand+=("$n $mark")
    done <<<"$lines"
    [[ "$count" =~ ^[0-9]+$ ]] || { log "the GitHub release list could not be read; trying again at the next run"; exit 0; }
    # The list is newest first: a release of this series at or below the
    # installed one means every newer one has been seen.
    if [[ $stop -eq 1 || $count -lt $PER_PAGE ]]; then break; fi
    page=$((page + 1))
  done
  # Without the installed version in sight a data-format marker further back
  # could be missed: no decision on a partial list.
  if (( page > MAX_PAGES )); then
    die "the newest $((MAX_PAGES * PER_PAGE)) releases do not reach the installed $CUR_VERSION; not updating automatically (install the newest core-v$SERIES.<n> by hand)"
  fi

  # A data-format change blocks its version and every later one (they carry it).
  for x in "${cand[@]}"; do
    read -r n mark <<<"$x"
    if [[ "$mark" == 1 ]] && [[ -z "$marker_min" || $n -lt $marker_min ]]; then marker_min="$n"; fi
  done
  local best=""
  for x in "${cand[@]}"; do
    read -r n mark <<<"$x"
    v="$SERIES.$n"
    if [[ -n "$marker_min" && $n -ge $marker_min ]]; then continue; fi
    if is_failed "$v"; then SKIP_NOTES+=("$v failed before (in $STATE_REAL/failed)"); continue; fi
    if [[ -z "$best" || $n -gt $best ]]; then best="$n"; fi
  done
  if [[ -n "$marker_min" ]]; then
    SKIP_NOTES+=("core-v$SERIES.$marker_min notes mark a data-format change: it and later releases need the manual step (docs/05 section 7 \"Automatic updates\")")
  fi
  [[ -z "$best" ]] || TARGET="$SERIES.$best"
}

report_skips() {
  local s
  for s in "${SKIP_NOTES[@]}"; do log "skipped: $s"; done
}

# ---------------------------------------------------------------- download and verify
PKG=""
download_and_verify() {
  local v="$1" tag name code sums sig line hash want ver
  tag="core-v$v"
  name="shadow-$tag-linux-arm64.tar.gz"
  DOWNLOAD_DIR="$STATE/download"
  rm -rf -- "$DOWNLOAD_DIR"
  mkdir -m 0700 -- "$DOWNLOAD_DIR"
  sums="$DOWNLOAD_DIR/SHA256SUMS"
  sig="$DOWNLOAD_DIR/SHA256SUMS.sig"

  fetch_asset "$tag" SHA256SUMS "$sums" "$MAX_SMALL_BYTES" 60
  fetch_asset "$tag" SHA256SUMS.sig "$sig" "$MAX_SMALL_BYTES" 60
  # Signature first: nothing from SHA256SUMS is used before it is verified.
  if ! openssl dgst -sha256 -verify "$(p "$PUBKEY_REAL")" -signature "$sig" "$sums" >/dev/null 2>&1; then
    die "$tag: the signature of SHA256SUMS does not verify with $PUBKEY_REAL; not installing"
  fi
  log "$tag: SHA256SUMS signature verified"
  want=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    if [[ "$line" =~ ^([0-9a-f]{64})\ [\ *](.+)$ && "${BASH_REMATCH[2]}" == "$name" ]]; then
      [[ -z "$want" ]] || die "$tag: SHA256SUMS lists $name twice; not installing"
      want="${BASH_REMATCH[1]}"
    fi
  done < "$sums"
  [[ -n "$want" ]] || die "$tag: the signed SHA256SUMS does not list $name; not installing"

  PKG="$DOWNLOAD_DIR/$name"
  fetch_asset "$tag" "$name" "$PKG" "$MAX_PACKAGE_BYTES" 1800
  hash="$(sha256sum -- "$PKG" | cut -d' ' -f1)"
  [[ "$hash" == "$want" ]] || die "$tag: the package's SHA-256 does not match the signed SHA256SUMS; not installing"
  log "$tag: package checksum verified"
  # The folder install-core.sh names after VERSION must be this release.
  ver="$(tar -xzOf "$PKG" -- "shadow-$tag-linux-arm64/VERSION" 2>/dev/null | head -n1 | tr -d '[:space:]')" || ver=""
  [[ "$ver" == "$v" ]] || die "$tag: the package's VERSION is '${ver:-missing}', not $v; not installing"
}

# fetch_asset <tag> <asset> <out> <max bytes> <max seconds>: missing (the
# release is still uploading) or no network: one line, exit 0.
fetch_asset() {
  local code
  if ! code="$(gh_get "$DOWNLOAD_URL/$1/$2" "$3" "$4" "$5" 2>/dev/null)"; then
    log "$1: downloading $2 failed (network); trying again at the next run"
    exit 0
  fi
  if [[ "$code" != 200 ]]; then
    log "$1: $2 is not available (HTTP $code; the release may still be uploading); trying again at the next run"
    exit 0
  fi
}

# ---------------------------------------------------------------- install, rollback, prune
# Every installer run: its trust check first (also on the recovery path), and
# it skips its own lock (this process holds it; install-core.sh takes it
# otherwise, so a manual install never runs next to an update).
installer() {
  local args=("$@")
  check_trusted_file "$INSTALLER_REAL"
  [[ -z "$ROOT" ]] || args+=(--root "$ROOT")
  SHADOW_CORE_UPDATE_LOCK_HELD=1 bash "$(p "$INSTALLER_REAL")" "${args[@]}"
}

restart_core() {
  systemctl restart "$UNIT_NAME" || err "systemctl restart $UNIT_NAME failed"
}

current_dir() {
  local l
  l="$(readlink -- "$(p "$CORE_REAL/current")" 2>/dev/null)" || true
  printf '%s' "${l#releases/}"
}

# The pending file is written before `current` is switched and removed after
# the health check or a completed rollback: a run killed in between is rolled
# back by the next run. stage=installing: written before the install (current
# may or may not be switched yet); stage=rolling_back: written as the first
# step of a rollback (the failed release did run; the rollback is repeated
# until the previous release answers).
# write_pending <prev dir> <prev version> <new version> <stage>
write_pending() {
  printf 'prev_dir=%s\nprev_version=%s\nnew_version=%s\nstage=%s\n' "$1" "$2" "$3" "$4" > "$STATE/pending.new"
  mv -f -T -- "$STATE/pending.new" "$STATE/pending"
}

# rollback <failed version> <previous release folder> <previous version>
rollback() {
  local bad="$1" prev_dir="$2" prev_v="$3"
  write_pending "$prev_dir" "$prev_v" "$bad" rolling_back
  record_failed "$bad"
  if [[ "$(current_dir)" != "$prev_dir" ]]; then
    if ! installer switch "$prev_dir"; then
      # pending stays: the next run tries the rollback again.
      err "could not switch current back to releases/$prev_dir; the next run tries again (by hand: install-core.sh switch $prev_dir, then systemctl restart shadow-core)"
      exit 1
    fi
  fi
  restart_core
  if wait_health "$prev_v"; then
    log "update to $bad rolled back; the Core runs $prev_v again"
    # docs/13 section 6.2 asks for a Core notification "güncelleme geri alındı
    # (<version>)". The Core has no local way in for one yet (no endpoint, and
    # the updater never writes the data folder): open point, see docs/05.
    log "NOTICE: güncelleme geri alındı ($bad) - no Core notification is raised (not built yet); this journal line is the record"
  else
    # pending stays (the next run checks again); nothing is pruned.
    err "update to $bad rolled back, but the previous release $prev_v does not answer GET /health either; check: journalctl -u shadow-core"
    exit 1
  fi
  rm -f -- "$STATE/pending"
  prune "$prev_dir" ""
  exit 1
}

# A run that was killed between the switch and the health check: its release
# counts as failed; back to the previous one.
recover_pending() {
  local f="$STATE/pending" prev_dir="" prev_v="" new_v="" stage="" k val
  [[ -f "$f" ]] || return 0
  while IFS='=' read -r k val; do
    case "$k" in
      prev_dir) prev_dir="$val" ;;
      prev_version) prev_v="$val" ;;
      new_version) new_v="$val" ;;
      stage) stage="$val" ;;
    esac
  done < "$f"
  if [[ ! "$new_v" =~ $VERSION_RE || ! "$prev_dir" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]{0,128}$ || ! "$prev_v" =~ ^[0-9A-Za-z._+-]{1,64}$ || ( "$stage" != installing && "$stage" != rolling_back ) ]]; then
    err "$STATE_REAL/pending is not readable; remove it after checking $CORE_REAL/current by hand"
    exit 1
  fi
  if [[ "$MODE" != now ]]; then
    log "an earlier run was interrupted (stage $stage, release $new_v); the next --now run finishes it"
    return 0
  fi
  if [[ "$stage" == rolling_back ]]; then
    # The failed release ran; the rollback did not finish (killed, or the
    # previous release did not answer): switch (if needed), restart, health.
    log "an earlier rollback of $new_v did not finish; repeating it (releases/$prev_dir)"
    rollback "$new_v" "$prev_dir" "$prev_v"
  fi
  local cur
  cur="$(current_dir)"
  if [[ "$cur" == "$prev_dir" && "$cur" != "$new_v" ]]; then
    # Killed before the switch (download or copy): the new release never ran.
    # Not recorded as failed; tried again below.
    log "an earlier run was interrupted before switching to $new_v; current is unchanged"
    rm -f -- "$f"
    return 0
  fi
  if [[ "$cur" != "$new_v" ]]; then
    err "$STATE_REAL/pending names $new_v (from $prev_dir), but current points to releases/$cur; check by hand, then remove $STATE_REAL/pending"
    exit 1
  fi
  log "an earlier run was interrupted while installing $new_v; rolling back to releases/$prev_dir"
  rollback "$new_v" "$prev_dir" "$prev_v"
}

# prune <current folder> <previous folder>: keep those two and the newest
# others (version order) up to KEEP_RELEASES; delete the rest.
prune() {
  local cur="$1" prev="$2" releases d name kept=0 keep
  releases="$(p "$CORE_REAL/releases")"
  local names=()
  for d in "$releases"/*; do
    [[ -d "$d" && ! -L "$d" ]] || continue
    name="${d##*/}"
    [[ "$name" =~ ^[0-9A-Za-z][0-9A-Za-z._+-]{0,128}$ ]] || continue
    names+=("$name")
  done
  [[ ${#names[@]} -gt 0 ]] || return 0
  [[ -z "$cur" ]] || kept=$((kept + 1))
  [[ -z "$prev" || "$prev" == "$cur" ]] || kept=$((kept + 1))
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    if [[ "$name" == "$cur" || "$name" == "$prev" ]]; then continue; fi
    keep=0
    if (( kept < KEEP_RELEASES )); then keep=1; kept=$((kept + 1)); fi
    if [[ $keep -eq 0 ]]; then
      log "removing old release releases/$name"
      rm -rf -- "${releases:?}/$name"
    fi
  done < <(printf '%s\n' "${names[@]}" | sort -rV)
}

# ---------------------------------------------------------------- deploy files
# refresh_deploy_files <release folder>: after the health check of that
# release (so a rolled-back release never leaves its files). Runs the
# release's own install-core.sh (signed with the release, installed root-owned
# by install-core.sh release): each release installs its deploy files the way
# it knows. This script's own file is replaced by a rename: the running bash
# keeps reading the old one. A failure here leaves the Core update in place
# (it passed its health check) but fails the run, so it is seen.
refresh_deploy_files() {
  local name="$1" rel d
  rel="$CORE_REAL/releases/$name"
  for d in "$rel" "$rel/deploy" "$rel/deploy/linux"; do
    if [[ -L "$(p "$d")" || ( -e "$(p "$d")" && ! -d "$(p "$d")" ) ]]; then
      die "$d is not a folder; the deploy files were not refreshed (the Core update itself succeeded)"
    fi
    if [[ ! -e "$(p "$d")" ]]; then
      log "core-v$name has no deploy files ($d missing; releases up to 0.2.4); the updater, its units and the TLS script are left as they are"
      return 0
    fi
  done
  check_trusted_file "$rel/deploy/linux/install-core.sh"
  local args=(deploy-files)
  [[ -z "$ROOT" ]] || args+=(--root "$ROOT")
  log "refreshing the updater, install-core.sh, the TLS script and the units from core-v$name"
  if ! SHADOW_CORE_UPDATE_LOCK_HELD=1 bash "$(p "$rel/deploy/linux/install-core.sh")" "${args[@]}"; then
    die "refreshing the deploy files from core-v$name failed (the Core update itself succeeded); by hand: sudo bash $rel/deploy/linux/install-core.sh deploy-files"
  fi
}

# ---------------------------------------------------------------- main
main() {
  parse_args "$@"
  check_root_and_tools
  prepare_state
  take_lock
  [[ "$MODE" != now ]] || clean_staging
  read_core_port
  recover_pending
  read_current
  list_releases
  report_skips
  if [[ -z "$TARGET" ]]; then
    log "up to date: $CUR_VERSION is the newest usable core-v$SERIES.<n> release"
    exit 0
  fi
  if [[ "$MODE" == check ]]; then
    log "update available: $CUR_VERSION -> $TARGET (run: shadow-core-update --now)"
    exit 0
  fi

  if ! systemctl is-active --quiet "$UNIT_NAME"; then
    log "$UNIT_NAME is not running; not updating to $TARGET (the health check needs it running)"
    exit 0
  fi
  local running
  running="$(health_version)"
  if [[ "$running" != "$CUR_VERSION" ]]; then
    die "the running Core does not answer GET /health on 127.0.0.1:$CORE_PORT with $CUR_VERSION (answer: ${running:-none}); not updating to $TARGET. Check CORE_EXTRA_HOSTS=127.0.0.1 and CORE_PORT in $ENV_REAL, and that core.env does not set CORE_VERSION"
  fi

  check_trusted_file "$PUBKEY_REAL"
  download_and_verify "$TARGET"
  if [[ "$MODE" == dry-run ]]; then
    log "dry run: core-v$TARGET is downloaded and verified; would install it and restart shadow-core (nothing changed)"
    exit 0
  fi

  local prev_dir="$CUR_DIR" prev_v="$CUR_VERSION"
  log "installing core-v$TARGET (from $prev_v)"
  write_pending "$prev_dir" "$prev_v" "$TARGET" installing
  if ! installer release --release "$PKG"; then
    if [[ "$(current_dir)" == "$prev_dir" ]]; then
      rm -f -- "$STATE/pending"
      die "install-core.sh release failed for $TARGET; nothing switched (see the lines above)"
    fi
    err "install-core.sh release failed after switching current"
    rollback "$TARGET" "$prev_dir" "$prev_v"
  fi
  rm -rf -- "$DOWNLOAD_DIR"; DOWNLOAD_DIR=""
  restart_core
  if ! wait_health "$TARGET"; then
    rollback "$TARGET" "$prev_dir" "$prev_v"
  fi
  rm -f -- "$STATE/pending"
  log "updated: the Core runs $TARGET (was $prev_v)"
  prune "$(current_dir)" "$prev_dir"
  refresh_deploy_files "$(current_dir)"
}

main "$@"
