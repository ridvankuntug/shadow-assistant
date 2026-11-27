#!/usr/bin/env bash
# install-core.sh: install or update the Shadow Assistant Core on the Pi
# (docs/13-pi-core-and-agents.md K1 and section 7.1; steps: docs/05-deploy.md
# section 7 "Core on the Pi"). Run as root from a copy of deploy/linux/ (the
# unit and core.env.example are taken from this script's folder).
#
#   install-core.sh install --user <name> [--release <dir|tarball>] [--build <suffix>] [--start]
#   install-core.sh set-secret <NAME> [--user <name>] [--replace]
#   install-core.sh --help
# Common options: --dry-run (print, change nothing), --root <dir> (prefix every
# system path, for tests; skips systemctl).
#
# What it does (idempotent; safe to run again):
#   install     checks root, systemd >= 247, /usr/bin/node >= 22 and the target
#               account; copies a LOCAL release (repository layout) to
#               /opt/shadow-assistant/core/releases/<version>/ and switches the
#               `current` symlink atomically (old releases are kept); installs
#               the unit; creates /etc/shadow-assistant/core.env from the example
#               only if it is missing; creates /var/lib/shadow-assistant/{data,vault};
#               writes the drop-in local.conf; installs the TLS script
#               (/usr/local/sbin/shadow-core-tls) and its renewal timer;
#               daemon-reload; enable. It starts the Core only with --start.
#   set-secret  reads one secret without echo (never from the command line) into
#               /etc/credstore/shadow-core.<NAME> (root 0600, folder 0700) and
#               regenerates the LoadCredential= lines of local.conf.
# What it does not: download anything (T12), install Node, touch the Claude login
# (T11.3), create the TLS CA or certificate (shadow-core-tls init, T11.6),
# agent:// lines (T11.4), the vault clone (T18), uninstall
# (docs/05 section 7), or decide the Claude login write path (open, see below).
#
# This file holds no user names, addresses or tokens.

set -euo pipefail
umask 022
export LC_ALL=C

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
readonly UNIT_NAME="shadow-core.service"
readonly TLS_SCRIPT="shadow-core-tls.sh"
readonly TLS_SERVICE="shadow-core-tls-renew.service"
readonly TLS_TIMER="shadow-core-tls-renew.timer"
readonly NODE_MIN_MAJOR=22
readonly SYSTEMD_MIN=247            # LoadCredential=
readonly DEVICE_TOKEN_MIN=16        # core/src/auth.ts MIN_TOKEN_LENGTH
readonly AGENT_TOKEN_MIN=32         # docs/13 section 1.2
readonly DEVICE_TOKEN_MAX=1024      # core/src/auth.ts authenticate(): longer is never accepted
readonly CREDENTIAL_MAX_BYTES=4096  # core/src/credentials.ts MAX_CREDENTIAL_BYTES
# Marker of the not yet decided Claude login write path (see write_dropin).
readonly UNDECIDED_MARK="# CLAUDE-LOGIN-WRITE-PATH: UNDECIDED"
readonly BLOCK_BEGIN="# BEGIN claude-login (install-core.sh keeps this block as it is)"
readonly BLOCK_END="# END claude-login"

# ---------------------------------------------------------------- options
CMD=""
USER_NAME=""
RELEASE=""
BUILD=""
START=0
DRY_RUN=0
ROOT=""
SECRET_NAME=""
REPLACE=0

usage() {
  sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() { printf 'install-core: error: %s\n' "$*" >&2; exit 1; }
info() { printf 'install-core: %s\n' "$*"; }
WARNINGS=()
warn() { printf 'install-core: WARNING: %s\n' "$*" >&2; WARNINGS+=("$*"); }

need_value() { [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || die "$1 needs a value"; }

parse_args() {
  [[ $# -gt 0 ]] || { usage; exit 2; }
  case "$1" in
    install|set-secret) CMD="$1"; shift ;;
    -h|--help|help) usage; exit 0 ;;
    *) die "unknown command '$1' (install, set-secret, --help)" ;;
  esac
  if [[ "$CMD" == set-secret ]]; then
    [[ $# -gt 0 && "$1" != --* ]] || die "set-secret needs a secret name, e.g. set-secret DEVICE_TOKEN_PHONE"
    SECRET_NAME="$1"; shift
  fi
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --user) need_value "$@"; USER_NAME="$2"; shift 2 ;;
      --release) [[ "$CMD" == install ]] || die "--release is for install"; need_value "$@"; RELEASE="$2"; shift 2 ;;
      --build) [[ "$CMD" == install ]] || die "--build is for install"; need_value "$@"; BUILD="$2"; shift 2 ;;
      --start) [[ "$CMD" == install ]] || die "--start is for install"; START=1; shift ;;
      --replace) [[ "$CMD" == set-secret ]] || die "--replace is for set-secret"; REPLACE=1; shift ;;
      --dry-run) DRY_RUN=1; shift ;;
      --root) need_value "$@"; ROOT="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option '$1'" ;;
    esac
  done
  if [[ -n "$ROOT" ]]; then
    [[ -d "$ROOT" ]] || die "--root $ROOT is not a folder"
    ROOT="$(cd -- "$ROOT" && pwd -P)"
    [[ "$ROOT" != / ]] || ROOT=""
  fi
}

# Real paths (as the unit and the Core see them) and on-disk paths (with --root).
readonly OPT_REAL=/opt/shadow-assistant
readonly CORE_REAL=/opt/shadow-assistant/core
readonly ETC_REAL=/etc/shadow-assistant
readonly ENV_REAL=/etc/shadow-assistant/core.env
readonly CREDSTORE_REAL=/etc/credstore
readonly UNIT_REAL=/etc/systemd/system/shadow-core.service
readonly SYSTEMD_DIR_REAL=/etc/systemd/system
readonly TLS_BIN_REAL=/usr/local/sbin/shadow-core-tls
readonly TLS_KEY_ID=tls-key         # core/src/listeners.ts TLS_KEY_CREDENTIAL
readonly DROPIN_DIR_REAL=/etc/systemd/system/shadow-core.service.d
readonly DROPIN_REAL=/etc/systemd/system/shadow-core.service.d/local.conf
readonly STATE_REAL=/var/lib/shadow-assistant
readonly NODE_REAL=/usr/bin/node
p() { printf '%s%s' "$ROOT" "$1"; }   # on-disk path of a real path

# ---------------------------------------------------------------- helpers
# Run a command, or print it with --dry-run.
run() {
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  would run:'; printf ' %q' "$@"; printf '\n'
  else
    "$@"
  fi
}

# chown only as real root (with --root as a normal user it is skipped).
OWN_OK=1
own() { # own <owner:group> <path>...
  [[ $OWN_OK -eq 1 ]] || return 0
  run chown -h "$@"
}

# With --root every path written must stay under it, also through symlinked
# parent folders (a test root with etc -> /etc must not reach the real /etc).
in_root() {
  [[ -n "$ROOT" ]] || return 0
  local r
  r="$(realpath -m -- "$1")"
  [[ "$r" == "$ROOT" || "$r" == "$ROOT"/* ]] || die "$1 resolves to $r, outside --root $ROOT; refusing"
}

# ensure_dir <path>: a system folder (e.g. /etc/systemd/system) that normally
# exists; created only if missing (only with --root), its mode is not touched.
ensure_dir() {
  in_root "$1"
  [[ -d "$1" ]] && return 0
  if [[ $DRY_RUN -eq 1 ]]; then printf '  would create %s\n' "${1#"$ROOT"}"; return 0; fi
  mkdir -p -- "$1"
}

# own_dir <mode> <owner:group> <path>: a folder of this install; created if
# missing, then its mode and owner are set (not recursive).
own_dir() {
  local mode="$1" owner="$2" path="$3"
  in_root "$path"
  [[ ! -L "$path" ]] || die "${path#"$ROOT"} is a symlink; refusing"
  if [[ ! -d "$path" ]]; then
    [[ ! -e "$path" ]] || die "${path#"$ROOT"} exists and is not a folder"
    if [[ $DRY_RUN -eq 1 ]]; then printf '  would create %s (%s %s)\n' "${path#"$ROOT"}" "$mode" "$owner"; return 0; fi
    mkdir -m "$mode" -- "$path"
  fi
  run chmod "$mode" -- "$path"
  own "$owner" -- "$path"
}

# put_file <mode> <path> < content: atomic (temp file in the same folder + mv),
# root:root. Not for secrets (see set_secret).
put_file() {
  local mode="$1" path="$2" tmp
  in_root "$path"
  [[ ! -L "$path" ]] || die "${path#"$ROOT"} is a symlink; refusing"
  [[ ! -e "$path" || -f "$path" ]] || die "${path#"$ROOT"} exists and is not a regular file; refusing"
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  would write %s (%s root:root):\n' "${path#"$ROOT"}" "$mode"
    sed 's/^/    | /'
    return 0
  fi
  tmp="$(mktemp "$(dirname -- "$path")/.$(basename -- "$path").XXXXXX")" || die "cannot create a temporary file next to ${path#"$ROOT"}"
  # Explicit checks: a short write (full disk) must never be renamed into place.
  if ! cat > "$tmp" || ! chmod "$mode" -- "$tmp"; then
    rm -f -- "$tmp"; die "cannot write ${path#"$ROOT"}; left unchanged"
  fi
  own root:root -- "$tmp"
  mv -f -T -- "$tmp" "$path" || { rm -f -- "$tmp"; die "cannot replace ${path#"$ROOT"}"; }
}

file_mode() { stat -c '%a' -- "$1"; }
file_owner() { stat -c '%U:%G' -- "$1"; }

# Warn if a root-managed file or folder is not owned by root or is writable by others.
check_root_owned() {
  local path="$1" mode
  [[ -e "$path" ]] || return 0
  mode="$(file_mode "$path")"
  if [[ $OWN_OK -eq 1 && "$(stat -c '%u' -- "$path")" != 0 ]]; then
    warn "$path is not owned by root ($(file_owner "$path")); fix: chown root:root $path"
  fi
  if (( (8#$mode & 8#022) != 0 )); then
    warn "$path is writable by group or others (mode $mode); fix: chmod go-w $path"
  fi
}

# passwd entry of USER_NAME: from <root>/etc/passwd with --root, else getent.
passwd_entry() {
  if [[ -n "$ROOT" && -f "$ROOT/etc/passwd" ]]; then
    awk -F: -v u="$1" '$1 == u { print; exit }' "$ROOT/etc/passwd"
  else
    getent passwd "$1" || true
  fi
}

USER_UID=""
USER_GID=""
USER_HOME=""
check_user() {
  local entry
  [[ -n "$USER_NAME" ]] || die "--user <name> is required: the account that owns the Claude login (T9.1)"
  # A plain account name: also keeps local.conf well-formed.
  [[ "$USER_NAME" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || die "--user '$USER_NAME' is not a plain account name"
  [[ "$USER_NAME" != root && "$USER_NAME" != shadow-core-unset ]] || die "--user must not be '$USER_NAME'"
  entry="$(passwd_entry "$USER_NAME")"
  [[ -n "$entry" ]] || die "account '$USER_NAME' does not exist"
  USER_UID="$(cut -d: -f3 <<<"$entry")"
  USER_GID="$(cut -d: -f4 <<<"$entry")"
  USER_HOME="$(cut -d: -f6 <<<"$entry")"
  [[ "$USER_UID" != 0 ]] || die "account '$USER_NAME' has uid 0; the Core must not run as root"
}

check_root_and_systemd() {
  if [[ -n "$ROOT" ]]; then
    info "test root $ROOT: systemctl is skipped"
    [[ $EUID -eq 0 ]] || { OWN_OK=0; info "not root: ownership (chown) is skipped"; }
    return 0
  fi
  if [[ $EUID -ne 0 ]]; then
    [[ $DRY_RUN -eq 1 ]] || die "run as root (sudo $0 ...)"
    OWN_OK=0
    info "dry run as a normal user: some checks may be incomplete"
  fi
  [[ -d /run/systemd/system ]] || die "systemd is not running on this machine"
  local ver
  ver="$(systemctl --version 2>/dev/null | awk 'NR == 1 { print $2 }')"
  ver="${ver%%[!0-9]*}"
  [[ -n "$ver" ]] || die "cannot read the systemd version (systemctl --version)"
  (( ver >= SYSTEMD_MIN )) || die "systemd $ver is too old; LoadCredential= needs $SYSTEMD_MIN or newer"
}

check_node() {
  local node out major
  node="$(p "$NODE_REAL")"
  [[ -x "$node" ]] || die "$NODE_REAL not found: install Node.js $NODE_MIN_MAJOR or newer so that $NODE_REAL exists (the unit runs that path); this script does not install Node"
  out="$("$node" --version 2>/dev/null || true)"
  [[ "$out" =~ ^v([0-9]+)\. ]] || die "cannot read the version of $NODE_REAL ('$out')"
  major="${BASH_REMATCH[1]}"
  (( major >= NODE_MIN_MAJOR )) || die "$NODE_REAL is $out; the Core needs Node.js $NODE_MIN_MAJOR or newer"
  info "node $out at $NODE_REAL"
}

# Secret variables never belong in core.env (0644, readable by every account).
readonly SECRET_RE='^[[:space:]]*(export[[:space:]]+)?(DEVICE_TOKEN_[A-Za-z0-9_]*|HA_CORE_TOKEN|CORE_AGENT_TOKEN)[[:space:]]*='
check_env_file() {
  local env lines
  env="$(p "$ENV_REAL")"
  [[ -f "$env" ]] || return 0
  if lines="$(grep -nE "$SECRET_RE" "$env" | cut -d= -f1)"; then
    die "$ENV_REAL sets a secret (line:name, values not shown): $(tr '\n' ' ' <<<"$lines")-- move it to the credstore with '$0 set-secret <NAME>' and delete the line (the Core refuses a secret set in both places, and core.env is readable by every account)"
  fi
}

# ---------------------------------------------------------------- release
STAGING=""
cleanup() { [[ -z "$STAGING" ]] || rm -rf -- "$STAGING"; }
trap cleanup EXIT

RELEASE_SRC=""
VERSION_DIR=""
prepare_release() {
  local src="$RELEASE" version
  [[ -e "$src" ]] || die "--release $src does not exist"
  if [[ -d "$src" ]]; then
    RELEASE_SRC="$(cd -- "$src" && pwd -P)"
  elif [[ -f "$src" ]]; then
    case "$src" in
      *.tar|*.tar.gz|*.tgz|*.tar.xz) ;;
      *) die "--release must be a folder or a .tar, .tar.gz, .tgz or .tar.xz file" ;;
    esac
    # Extract next to the releases (same file system, so the final mv is a
    # rename); with --dry-run into a temporary folder. Removed at exit.
    if [[ $DRY_RUN -eq 1 ]]; then
      STAGING="$(mktemp -d)"
    else
      make_release_dirs
      STAGING="$(mktemp -d "$(p "$CORE_REAL/releases")/.staging.XXXXXX")"
    fi
    mkdir -- "$STAGING/x"
    # GNU tar drops leading '/' and refuses '..' members; owners and modes
    # from the archive are not used (root:root and go-w are set below).
    tar -xf "$src" -C "$STAGING/x" --no-same-owner --no-same-permissions
    if [[ -f "$STAGING/x/VERSION" ]]; then
      RELEASE_SRC="$STAGING/x"
    else
      local found=() e
      for e in "$STAGING"/x/* "$STAGING"/x/.[!.]* "$STAGING"/x/..?*; do [[ -e "$e" || -L "$e" ]] && found+=("$e"); done
      [[ ${#found[@]} -eq 1 && -d "${found[0]}" && ! -L "${found[0]}" ]] || die "the tarball must hold the release at its top level or in one folder"
      RELEASE_SRC="${found[0]}"
    fi
  else
    die "--release $src is neither a folder nor a file"
  fi

  # Layout the unit and the Core expect (core/src/config.ts: files two levels above core/dist/).
  local f
  # core/package.json: "type": "module", without it Node cannot load dist/.
  # core/prompts/: read at every start (core/src/index.ts).
  for f in VERSION core/package.json core/dist/index.js core/prompts/system.md core/prompts/tier1.md services.yaml router.yaml; do
    [[ -f "$RELEASE_SRC/$f" ]] || die "release is missing $f (expected the repository layout with a built Core)"
  done
  [[ -d "$RELEASE_SRC/core/node_modules" ]] || die "release is missing core/node_modules (run npm ci --omit=dev in core/ when building it)"
  # The Core reads <release>/.env if present: a copied PC .env would put
  # secrets into a world-readable folder and override the Pi settings.
  [[ ! -e "$RELEASE_SRC/.env" ]] || die "release contains a .env file; remove it (settings go to $ENV_REAL, secrets to the credstore)"
  # Early check on the source; repeated on the copy (an absolute link into the
  # source folder passes here but points outside the installed copy).
  check_links_inside "$RELEASE_SRC"

  version="$(head -n1 -- "$RELEASE_SRC/VERSION" | tr -d '[:space:]')"
  [[ "$version" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$ ]] || die "VERSION '$version' is not a plain version string"
  if [[ -n "$BUILD" ]]; then
    [[ "$BUILD" =~ ^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$ ]] || die "--build '$BUILD' may hold letters, digits, '.', '_' and '-' only"
    VERSION_DIR="$version+$BUILD"
  else
    VERSION_DIR="$version"
  fi
}

# Every symlink in the release must resolve inside it (npm's relative .bin
# links do): a link out of it would let code outside the root-owned release run.
check_links_inside() {
  local top="$1" l r
  top="$(realpath -- "$top")"
  while IFS= read -r -d '' l; do
    r="$(realpath -m -- "$l")"
    [[ "$r" == "$top" || "$r" == "$top"/* ]] || die "release symlink ${l#"$top"/} points outside the release ($(readlink -- "$l")); refusing"
  done < <(find "$top" -type l -print0)
}

make_release_dirs() {
  ensure_dir "$(p /opt)"
  own_dir 0755 root:root "$(p "$OPT_REAL")"
  own_dir 0755 root:root "$(p "$CORE_REAL")"
  own_dir 0755 root:root "$(p "$CORE_REAL/releases")"
}

install_release() {
  local releases dest cur link_tmp
  releases="$(p "$CORE_REAL/releases")"
  dest="$releases/$VERSION_DIR"
  make_release_dirs

  if [[ -e "$dest" || -L "$dest" ]]; then
    [[ -d "$dest" && ! -L "$dest" ]] || die "$dest exists and is not a folder"
    # Same content: nothing to copy (re-run). Different: never overwrite a
    # release in place, the running Core may use it.
    if diff -rq --no-dereference -- "$RELEASE_SRC" "$dest" >/dev/null 2>&1; then
      info "release $VERSION_DIR is already installed with the same content"
    else
      die "release $VERSION_DIR is already installed with different content; pass --build <suffix> (e.g. a date or commit) to install this build next to it"
    fi
  else
    info "installing release $VERSION_DIR to $CORE_REAL/releases/$VERSION_DIR"
    if [[ $DRY_RUN -eq 1 ]]; then
      printf '  would copy %s to %s (root:root, no group/other write)\n' "$RELEASE" "$dest"
    else
      local tmp
      if [[ -n "$STAGING" ]]; then
        tmp="$RELEASE_SRC"            # extracted tarball, already in releases/
      else
        STAGING="$(mktemp -d "$releases/.staging.XXXXXX")"
        tmp="$STAGING/tree"
        cp -a -- "$RELEASE_SRC" "$tmp"
      fi
      # root-owned, nobody else may write, no setuid/setgid bits.
      [[ $OWN_OK -eq 0 ]] || chown -R -h root:root -- "$tmp"
      chmod -R u+rwX,go+rX,go-w,ug-s -- "$tmp"
      chmod 0755 -- "$tmp"
      check_links_inside "$tmp"
      mv -T -- "$tmp" "$dest"
      rm -rf -- "$STAGING"; STAGING=""
    fi
  fi

  # Atomic switch of `current`: new symlink under a temp name, then rename over.
  cur="$(p "$CORE_REAL/current")"
  if [[ -e "$cur" && ! -L "$cur" ]]; then die "${cur#"$ROOT"} exists and is not a symlink"; fi
  if [[ -L "$cur" && "$(readlink -- "$cur")" == "releases/$VERSION_DIR" ]]; then
    info "current already points to releases/$VERSION_DIR"
  else
    link_tmp="$(p "$CORE_REAL/.current.new")"
    run rm -f -- "$link_tmp"
    run ln -s -- "releases/$VERSION_DIR" "$link_tmp"
    own root:root "$link_tmp"
    run mv -T -- "$link_tmp" "$cur"
    info "current -> releases/$VERSION_DIR"
    RELEASE_SWITCHED=1
  fi
}
RELEASE_SWITCHED=0

# ---------------------------------------------------------------- unit, env, state
# install_copy <mode> <file in this folder> <real destination>: copies it if
# the destination differs and sets COPIED=1 (0 if up to date). Always called
# as a plain command, never in a condition: bash turns set -e off inside a
# function called from a condition, and a failed write must stop the script.
COPIED=0
install_copy() {
  local mode="$1" src="$SCRIPT_DIR/$2" real="$3" dst
  [[ -f "$src" ]] || die "$src not found (run the script from a copy of deploy/linux/)"
  dst="$(p "$real")"
  COPIED=0
  if [[ -f "$dst" && ! -L "$dst" ]] && cmp -s -- "$src" "$dst"; then
    info "$real is up to date"
    check_root_owned "$dst"
    return 0
  fi
  info "installing $real"
  COPIED=1
  if [[ $DRY_RUN -eq 1 ]]; then
    in_root "$dst"
    printf '  would copy %s to %s (%s root:root)\n' "$2" "$real" "$mode"
    return 0
  fi
  put_file "$mode" "$dst" < "$src"
}

install_unit() {
  ensure_dir "$(p "$SYSTEMD_DIR_REAL")"
  install_copy 0644 "$UNIT_NAME" "$UNIT_REAL"
  if [[ $COPIED -eq 1 ]]; then UNIT_CHANGED=1; fi
}
UNIT_CHANGED=0

# The TLS script and its weekly renewal timer (docs/05 section 7 "HTTPS
# certificate"). The timer's service is skipped until the CA exists, so the
# timer is enabled on every install; creating the CA is the separate step
# "shadow-core-tls init --ip <pi-lan-ip>".
install_tls_tools() {
  ensure_dir "$(p /usr/local/sbin)"
  install_copy 0755 "$TLS_SCRIPT" "$TLS_BIN_REAL"
  install_copy 0644 "$TLS_SERVICE" "$SYSTEMD_DIR_REAL/$TLS_SERVICE"
  install_copy 0644 "$TLS_TIMER" "$SYSTEMD_DIR_REAL/$TLS_TIMER"
}

install_env() {
  local src="$SCRIPT_DIR/core.env.example" dst
  dst="$(p "$ENV_REAL")"
  ensure_dir "$(p /etc)"
  own_dir 0755 root:root "$(p "$ETC_REAL")"
  if [[ -e "$dst" || -L "$dst" ]]; then
    # Never overwritten: it holds the machine's settings (and CORE_REHEARSAL).
    [[ -f "$dst" && ! -L "$dst" ]] || die "$ENV_REAL is not a regular file"
    info "$ENV_REAL exists; left as it is"
    check_root_owned "$dst"
  else
    [[ -f "$src" ]] || die "$src not found (run the script from a copy of deploy/linux/)"
    ! grep -qE "$SECRET_RE" "$src" || die "$src sets a secret variable; refusing to copy it to the world-readable $ENV_REAL"
    info "creating $ENV_REAL from core.env.example (fill in the <placeholders>)"
    put_file 0644 "$dst" < "$src"
  fi
  [[ -f "$dst" ]] || return 0
  if grep -qE '^[^#]*<[A-Za-z0-9._-]+>' "$dst"; then
    warn "$ENV_REAL still has <placeholder> values (lines $(grep -nE '^[^#]*<[A-Za-z0-9._-]+>' "$dst" | cut -d: -f1 | paste -sd, -)); fill them in with: sudoedit $ENV_REAL"
  fi
  # The rehearsal flag (T11.5) is never changed here; only reported.
  if ! grep -qE '^[[:space:]]*CORE_REHEARSAL[[:space:]]*=[[:space:]]*1[[:space:]]*$' "$dst"; then
    warn "$ENV_REAL does not set CORE_REHEARSAL=1: the Pi Core will raise notifications next to the PC Core (rehearsal off, T11.5)"
  fi
}

# StateDirectory= creates /var/lib/shadow-assistant (owner User=, 0700) at
# start; the same owner and mode here, so nothing conflicts. data/ and vault/
# are created now because the Core treats a missing SHADOW_VAULT_DIR as "no vault".
install_state() {
  local base d owner
  base="$(p "$STATE_REAL")"
  owner="$USER_UID:$USER_GID"
  ensure_dir "$(p /var/lib)"
  for d in "$base" "$base/data" "$base/vault"; do
    if [[ -e "$d" || -L "$d" ]]; then
      [[ -d "$d" && ! -L "$d" ]] || die "$d exists and is not a folder"
      if [[ $OWN_OK -eq 1 && "$(stat -c '%u' -- "$d")" != "$USER_UID" ]]; then
        warn "${d#"$ROOT"} is owned by $(file_owner "$d"), not $USER_NAME; systemd re-owns $STATE_REAL at start (StateDirectory=), check data/ and vault/ then"
      fi
    else
      if [[ $DRY_RUN -eq 1 ]]; then
        printf '  would create %s (0700 %s)\n' "${d#"$ROOT"}" "$USER_NAME"
      else
        mkdir -m 0700 -- "$d"
        own "$owner" -- "$d"
      fi
    fi
  done
}

# ---------------------------------------------------------------- drop-in
# local.conf is regenerated on every run (User=, LoadCredential= lines) except
# the claude-login block, which is kept exactly as found. That block is the one
# place where the open decision (which paths the Claude CLI may write) is filled
# in; while the UNDECIDED marker is in it, the script warns.
SECRET_NAME_RE='^(DEVICE_TOKEN_[A-Z0-9_]+|HA_CORE_TOKEN|CORE_AGENT_TOKEN)$'

default_login_block() {
  cat <<EOF
$BLOCK_BEGIN
$UNDECIDED_MARK
# OPEN USER DECISION (docs/05 section 7 "Claude login"): which path(s) the
# Claude CLI may write when it refreshes the login of User= (ProtectHome=
# read-only keeps the home read-only otherwise). Options under discussion:
# the whole home writable; CLAUDE_CONFIG_DIR pointing to one writable folder;
# a dedicated account without sudo. Until this is filled in, the Core's token
# refresh may fail. Put the decided lines here (e.g. ReadWritePaths=...) and
# delete the UNDECIDED line above; install-core.sh keeps this block.
#ReadWritePaths=<to be decided>
$BLOCK_END
EOF
}

# Prints the kept block of an existing local.conf, or the default one.
login_block() {
  local file="$1" state
  if [[ -f "$file" ]] && grep -qxF "$BLOCK_BEGIN" "$file"; then
    state="$(awk -v b="$BLOCK_BEGIN" -v e="$BLOCK_END" '
      $0 == b { inb = 1; nb++ } inb { print } $0 == e && inb { inb = 0; ne++ }
      END { if (nb != 1 || ne != 1 || inb) exit 3 }' "$file")" \
      || die "$DROPIN_REAL: the claude-login block is not closed by '$BLOCK_END' (or appears twice); fix it by hand"
    printf '%s\n' "$state"
  else
    default_login_block
  fi
}

DROPIN_USER=""
# The User= of an existing local.conf (for set-secret without --user).
read_dropin_user() {
  local file
  file="$(p "$DROPIN_REAL")"
  [[ -f "$file" ]] || return 0
  DROPIN_USER="$(sed -n 's/^User=\(.*\)$/\1/p' "$file" | tail -n1)"
}

# Whether core.env enables the TLS listener: CORE_TLS_HOST is not empty after
# the last assignment (systemd's EnvironmentFile= keeps the last one; quotes
# removed as it does). Same parsing as env_value in shadow-core-tls.sh.
env_enables_tls() {
  local env v
  env="$(p "$ENV_REAL")"
  [[ -f "$env" ]] || return 1
  v="$(sed -n 's/^[[:space:]]*CORE_TLS_HOST[[:space:]]*=[[:space:]]*//p' "$env" | tail -n1)"
  v="${v%"${v##*[![:space:]]}"}"
  if [[ "$v" =~ ^\"(.*)\"$ || "$v" =~ ^\'(.*)\'$ ]]; then v="${BASH_REMATCH[1]}"; fi
  [[ -n "$v" ]]
}

credential_lines() {
  local store f name
  store="$(p "$CREDSTORE_REAL")"
  [[ -d "$store" ]] || return 0
  for f in "$store"/shadow-core.*; do
    [[ -e "$f" ]] || continue
    name="${f##*/shadow-core.}"
    case "$name" in *.new*|.*) continue ;; esac
    if [[ "$name" == "$TLS_KEY_ID" ]]; then
      # The Core counts the tls-key credential as part of the TLS setting: with
      # the TLS lines of core.env still commented it would refuse to start
      # ("partly configured"). So the line follows core.env.
      if env_enables_tls; then
        printf 'LoadCredential=%s:%s/shadow-core.%s\n' "$TLS_KEY_ID" "$CREDSTORE_REAL" "$TLS_KEY_ID"
      else
        info "credstore: ${f#"$ROOT"} (the TLS server key) is not listed in local.conf while $ENV_REAL does not set CORE_TLS_HOST; enable the TLS lines there, then run this again" >&2
      fi
      continue
    fi
    if [[ ! "$name" =~ $SECRET_NAME_RE ]]; then
      info "credstore: ${f#"$ROOT"} is neither a Core secret (DEVICE_TOKEN_<NAME>, HA_CORE_TOKEN, CORE_AGENT_TOKEN) nor the TLS key ($TLS_KEY_ID); not listed in local.conf" >&2
      continue
    fi
    # HA_CORE_TOKEN has its LoadCredential= in the unit itself.
    [[ "$name" != HA_CORE_TOKEN ]] || continue
    printf 'LoadCredential=%s:%s/shadow-core.%s\n' "$name" "$CREDSTORE_REAL" "$name"
  done
}

check_credstore() {
  local store f
  store="$(p "$CREDSTORE_REAL")"
  [[ -d "$store" ]] || return 0
  if [[ "$(file_mode "$store")" != 700 ]]; then warn "$CREDSTORE_REAL has mode $(file_mode "$store"), expected 700"; fi
  for f in "$store"/shadow-core.*; do
    [[ -e "$f" ]] || continue
    [[ ! -L "$f" ]] || { warn "${f#"$ROOT"} is a symlink"; continue; }
    if [[ "$(file_mode "$f")" != 600 ]]; then warn "${f#"$ROOT"} has mode $(file_mode "$f"), expected 600"; fi
    if [[ $OWN_OK -eq 1 && "$(stat -c '%u' -- "$f")" != 0 ]]; then warn "${f#"$ROOT"} is not owned by root"; fi
    if [[ ! -s "$f" ]]; then warn "${f#"$ROOT"} is empty; the Core refuses to start"; fi
  done
}

write_dropin() {
  local user="$1" dir file block creds content
  dir="$(p "$DROPIN_DIR_REAL")"
  file="$(p "$DROPIN_REAL")"
  ensure_dir "$(p /etc/systemd/system)"
  own_dir 0755 root:root "$dir"
  block="$(login_block "$file")"
  creds="$(credential_lines)"
  content="# Machine-specific drop-in for shadow-core.service, written by
# deploy/linux/install-core.sh (T11.1). Rewritten on every run of the script
# (install, set-secret) except the claude-login block below.
# Other local settings (limits from the rehearsal, ...): sudo systemctl edit
# shadow-core (writes override.conf next to this file).
[Service]
# The account that owns the Claude login (T9.1).
User=$user

$block

# Device and agent tokens and the TLS key found in $CREDSTORE_REAL
# (HA_CORE_TOKEN is in the unit).
${creds:-# (none yet: install-core.sh set-secret DEVICE_TOKEN_<NAME>)}"
  if [[ -f "$file" && ! -L "$file" && "$(cat -- "$file")" == "$content" ]]; then
    info "drop-in $DROPIN_REAL is up to date"
    check_root_owned "$file"
  else
    info "writing drop-in $DROPIN_REAL"
    printf '%s\n' "$content" | put_file 0644 "$file"
    DROPIN_CHANGED=1
  fi
}
DROPIN_CHANGED=0

login_undecided() {
  local file
  file="$(p "$DROPIN_REAL")"
  # With --dry-run on a fresh system the file does not exist yet: undecided.
  [[ ! -f "$file" ]] || grep -qxF "$UNDECIDED_MARK" "$file"
}

# ---------------------------------------------------------------- systemctl
sysctl() {
  if [[ -n "$ROOT" ]]; then printf '  (test root) skipped: systemctl %s\n' "$*"; return 0; fi
  run systemctl "$@"
}
unit_active() { [[ -z "$ROOT" ]] && systemctl is-active --quiet "$UNIT_NAME"; }

# ---------------------------------------------------------------- set-secret
read_secret() { # prints the value; prompts on a terminal, else reads one line from stdin
  local value again
  if [[ -t 0 ]]; then
    IFS= read -rs -p "Value for $SECRET_NAME (not shown): " value </dev/tty || true; printf '\n' >/dev/tty
    IFS= read -rs -p "Again: " again </dev/tty || true; printf '\n' >/dev/tty
    [[ "$value" == "$again" ]] || die "the two values differ; nothing written"
  else
    IFS= read -r value || [[ -n "$value" ]] || die "no value on stdin"
  fi
  printf '%s' "$value"
}

set_secret() {
  local store file value min=1 max=$CREDENTIAL_MAX_BYTES tmp
  [[ "$SECRET_NAME" =~ $SECRET_NAME_RE ]] || die "'$SECRET_NAME' is not a Core secret name (DEVICE_TOKEN_<NAME> in upper case, HA_CORE_TOKEN, CORE_AGENT_TOKEN)"
  case "$SECRET_NAME" in
    DEVICE_TOKEN_*) min=$DEVICE_TOKEN_MIN; max=$DEVICE_TOKEN_MAX ;;
    CORE_AGENT_TOKEN) min=$AGENT_TOKEN_MIN ;;
  esac
  read_dropin_user
  if [[ -z "$USER_NAME" ]]; then
    [[ -n "$DROPIN_USER" ]] || die "no $DROPIN_REAL yet: run 'install --user <name>' first or pass --user <name>"
    USER_NAME="$DROPIN_USER"
  fi
  check_user
  check_env_file

  store="$(p "$CREDSTORE_REAL")"
  file="$store/shadow-core.$SECRET_NAME"
  in_root "$file"
  if [[ -L "$file" || ( -e "$file" && ! -f "$file" ) ]]; then
    die "${file#"$ROOT"} exists and is not a regular file; refusing"
  fi
  if [[ -e "$file" && $REPLACE -eq 0 ]]; then
    die "${file#"$ROOT"} exists; pass --replace to change it"
  fi
  if [[ $DRY_RUN -eq 1 ]]; then
    printf '  would read the value of %s without echo and write %s (0600 root:root, folder 0700)\n' "$SECRET_NAME" "${file#"$ROOT"}"
  else
    value="$(read_secret)"
    [[ -n "$value" ]] || die "empty value; nothing written"
    # Printable ASCII without spaces: one byte per character, so the lengths
    # below are the ones the Core counts.
    [[ "$value" =~ ^[!-~]+$ ]] || die "the value may hold printable ASCII characters only (no spaces); nothing written"
    (( ${#value} >= min )) || die "$SECRET_NAME must be at least $min characters; nothing written"
    (( ${#value} <= max )) || die "$SECRET_NAME must be at most $max characters; nothing written"
    # Folder first (0700), then the file under umask 077: never readable by others.
    ensure_dir "$(p /etc)"
    [[ ! -L "$store" ]] || die "$CREDSTORE_REAL is a symlink; refusing"
    ( umask 077
      [[ -d "$store" ]] || mkdir -m 0700 -- "$store"
      chmod 0700 -- "$store"
      [[ $OWN_OK -eq 0 ]] || chown root:root -- "$store"
      tmp="$(mktemp "$store/.shadow-core.$SECRET_NAME.XXXXXX")"
      printf '%s' "$value" > "$tmp"   # printf is a builtin: the value is never in a process argv
      chmod 0600 -- "$tmp"
      [[ $OWN_OK -eq 0 ]] || chown root:root -- "$tmp"
      mv -f -T -- "$tmp" "$file" )
    value=""
    info "wrote ${file#"$ROOT"} (0600 root:root)"
  fi
  write_dropin "$USER_NAME"
  if [[ $DROPIN_CHANGED -eq 1 ]]; then sysctl daemon-reload; fi
  if unit_active; then
    info "the Core is running: restart it to use the secret: sudo systemctl restart shadow-core"
  fi
}

# ---------------------------------------------------------------- install
install_main() {
  check_root_and_systemd
  check_user
  check_node
  check_env_file
  if [[ -n "$RELEASE" ]]; then
    prepare_release
  elif [[ ! -L "$(p "$CORE_REAL/current")" ]]; then
    die "--release <dir|tarball> is required for the first install"
  fi

  if [[ -n "$RELEASE" ]]; then install_release; else info "no --release: keeping $(readlink -- "$(p "$CORE_REAL/current")")"; fi
  install_unit
  install_env
  install_state
  check_credstore
  local old_user=""
  read_dropin_user; old_user="$DROPIN_USER"
  if [[ -n "$old_user" && "$old_user" != "$USER_NAME" ]]; then
    warn "User= changes from $old_user to $USER_NAME; systemd re-owns $STATE_REAL at the next start"
  fi
  write_dropin "$USER_NAME"
  install_tls_tools
  sysctl daemon-reload
  sysctl enable "$UNIT_NAME"
  sysctl enable --now "$TLS_TIMER"

  if [[ $START -eq 1 ]]; then
    info "starting (or restarting) the Core (--start)"
    sysctl restart "$UNIT_NAME"
  elif [[ $RELEASE_SWITCHED -eq 1 || $UNIT_CHANGED -eq 1 || $DROPIN_CHANGED -eq 1 ]] && unit_active; then
    info "the Core is running the previous setup: sudo systemctl restart shadow-core"
  fi

  next_steps
}

next_steps() {
  local have_ha=0 have_dev=0 store
  store="$(p "$CREDSTORE_REAL")"
  [[ -f "$store/shadow-core.HA_CORE_TOKEN" ]] && have_ha=1
  compgen -G "$store/shadow-core.DEVICE_TOKEN_*" >/dev/null && have_dev=1
  printf '\nNext steps (docs/05 section 7):\n'
  [[ -d "$ROOT$USER_HOME/.claude" ]] || printf '  - Sign in to Claude Code as %s on the Pi (T11.3): ssh to the Pi as %s, run claude.\n' "$USER_NAME" "$USER_NAME"
  printf '  - Fill in %s: sudoedit %s\n' "$ENV_REAL" "$ENV_REAL"
  [[ $have_ha -eq 1 ]] || printf '  - Home Assistant token (the unit does not start without it): sudo %s set-secret HA_CORE_TOKEN\n' "$0"
  [[ $have_dev -eq 1 ]] || printf '  - Device tokens: sudo %s set-secret DEVICE_TOKEN_<NAME>\n' "$0"
  [[ -f "$store/shadow-core.$TLS_KEY_ID" ]] || printf '  - HTTPS listener for the PC browser (optional): sudo shadow-core-tls init --ip <pi-lan-ip>; docs/05 section 7 "HTTPS certificate"\n'
  [[ $START -eq 1 ]] || printf '  - Start: sudo systemctl start shadow-core; check: journalctl -u shadow-core -n 50\n'
}

final_warnings() {
  if [[ "$CMD" == install ]] && login_undecided; then
    cat >&2 <<EOF

**********************************************************************
WARNING: the Claude login write path is NOT DECIDED (open user decision).
The Core runs as $USER_NAME with a read-only home (ProtectHome=read-only),
and local.conf gives the Claude login no writable path yet. The Core may
run, but the Claude CLI's token refresh may fail until this is set. Fill in
the claude-login block of $DROPIN_REAL
(docs/05 section 7 "Claude login"), then:
  sudo systemctl daemon-reload && sudo systemctl restart shadow-core
**********************************************************************
EOF
  fi
  if [[ ${#WARNINGS[@]} -gt 0 ]]; then
    printf '\n%d warning(s):\n' "${#WARNINGS[@]}" >&2
    printf '  - %s\n' "${WARNINGS[@]}" >&2
  fi
}

main() {
  parse_args "$@"
  [[ $DRY_RUN -eq 0 ]] || info "dry run: nothing is changed"
  case "$CMD" in
    install) install_main ;;
    set-secret)
      if [[ -z "$ROOT" && $EUID -ne 0 && $DRY_RUN -eq 0 ]]; then die "run as root (sudo $0 ...)"; fi
      [[ $EUID -eq 0 ]] || OWN_OK=0
      set_secret ;;
  esac
  final_warnings
}

main "$@"
