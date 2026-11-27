#!/usr/bin/env bash
# shadow-core-tls.sh: the local CA and the TLS server certificate of the Core's
# HTTPS listener on the Pi (docs/13-pi-core-and-agents.md section 4.3; steps:
# docs/05-deploy.md section 7 "HTTPS certificate"). install-core.sh installs it
# as /usr/local/sbin/shadow-core-tls; the renewal timer runs "renew". Run as root.
#
#   shadow-core-tls init --ip <pi-lan-ip> [--recreate-ca]
#   shadow-core-tls renew [--days <n>] [--force]
#   shadow-core-tls --help
# Common option: --root <dir> (prefix every path, for tests; skips systemctl).
#
# init   creates the CA if there is none (EC P-256, 10 years, name-constrained
#        to the one IPv4 address), then issues the server certificate as renew
#        does. An existing CA is never replaced, except with --recreate-ca
#        (then every PC must import the new ca.crt again).
# renew  issues a new server certificate (EC P-256, 1 year, subjectAltName
#        IP:<address>) when there is none, it expires within --days (default
#        30), it names another address, it is not signed by the current CA, its
#        key in the credstore is missing or does not match, or with --force.
#        Then it restarts shadow-core if it is running and core.env enables the
#        TLS listener. Nothing to do: exit 0, nothing changed.
# The address: CORE_TLS_HOST in /etc/shadow-assistant/core.env (the one
# setting); while that line is commented, the CA's own address. IPv4 only; a
# LAN host name is not supported (open question, docs/05 section 7).
#
# Files: /etc/shadow-assistant/tls/ca.key (root 0600, never leaves the Pi, not
# in the backup), ca.crt (public, 0644: the file the PC imports), core.crt
# (0644); the server key only at /etc/credstore/shadow-core.tls-key (root 0600,
# delivered to the Core with LoadCredential=tls-key:...).
#
# This file holds no addresses, host names or keys.

set -euo pipefail
umask 077
export LC_ALL=C

readonly TLS_DIR_REAL=/etc/shadow-assistant/tls
readonly ETC_REAL=/etc/shadow-assistant
readonly ENV_REAL=/etc/shadow-assistant/core.env
readonly CREDSTORE_REAL=/etc/credstore
readonly KEY_REAL=/etc/credstore/shadow-core.tls-key
readonly DROPIN_REAL=/etc/systemd/system/shadow-core.service.d/local.conf
readonly CORE_UNIT=shadow-core.service
readonly CA_DAYS=3650           # 10 years (docs/13 4.3)
readonly LEAF_DAYS=365          # 1 year; browsers cap public CAs at 398 days
readonly CA_CN="Shadow Assistant local CA"
# Not an address: a CN that looks like a host name is checked against the
# name constraint by some verifiers (OpenSSL rejects CN=<ip> here).
readonly LEAF_CN="Shadow Assistant Core"

CMD=""
IP=""
RECREATE_CA=0
DAYS=30
FORCE=0
ROOT=""

usage() { sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die() { printf 'shadow-core-tls: error: %s\n' "$*" >&2; exit 1; }
info() { printf 'shadow-core-tls: %s\n' "$*"; }
warn() { printf 'shadow-core-tls: WARNING: %s\n' "$*" >&2; }
need_value() { [[ $# -ge 2 && -n "$2" && "$2" != --* ]] || die "$1 needs a value"; }

parse_args() {
  [[ $# -gt 0 ]] || { usage; exit 2; }
  case "$1" in
    init|renew) CMD="$1"; shift ;;
    -h|--help|help) usage; exit 0 ;;
    *) die "unknown command '$1' (init, renew, --help)" ;;
  esac
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --ip) [[ "$CMD" == init ]] || die "--ip is for init (renew reads CORE_TLS_HOST from $ENV_REAL)"; need_value "$@"; IP="$2"; shift 2 ;;
      --recreate-ca) [[ "$CMD" == init ]] || die "--recreate-ca is for init"; RECREATE_CA=1; shift ;;
      --days) [[ "$CMD" == renew ]] || die "--days is for renew"; need_value "$@"; DAYS="$2"; shift 2 ;;
      --force) [[ "$CMD" == renew ]] || die "--force is for renew"; FORCE=1; shift ;;
      --root) need_value "$@"; ROOT="$2"; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown option '$1'" ;;
    esac
  done
  [[ "$CMD" != init || -n "$IP" ]] || die "init needs --ip <pi-lan-ip>"
  # Upper bound: a window longer than the certificate's life would renew on every run.
  if [[ ! "$DAYS" =~ ^[1-9][0-9]{0,2}$ ]] || (( DAYS >= LEAF_DAYS )); then
    die "--days must be a whole number from 1 to $((LEAF_DAYS - 1))"
  fi
  if [[ -n "$ROOT" ]]; then
    [[ -d "$ROOT" ]] || die "--root $ROOT is not a folder"
    ROOT="$(cd -- "$ROOT" && pwd -P)"
    [[ "$ROOT" != / ]] || ROOT=""
  fi
}

p() { printf '%s%s' "$ROOT" "$1"; }   # on-disk path of a real path

# With --root every path written must stay under it, also through symlinked parents.
in_root() {
  [[ -n "$ROOT" ]] || return 0
  local r
  r="$(realpath -m -- "$1")"
  [[ "$r" == "$ROOT" || "$r" == "$ROOT"/* ]] || die "$1 resolves to $r, outside --root $ROOT; refusing"
}

# A dotted IPv4 address without leading zeros (no octal ambiguity), not a
# wildcard or broadcast address.
valid_ipv4() {
  local o='(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])'
  [[ "$1" =~ ^$o\.$o\.$o\.$o$ && "$1" != 0.0.0.0 && "$1" != 255.255.255.255 ]]
}

# The value of a setting in core.env (last uncommented line; surrounding
# quotes removed as systemd's EnvironmentFile= does), or empty.
env_value() {
  local env v
  env="$(p "$ENV_REAL")"
  [[ -f "$env" ]] || return 0
  v="$(sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$env" | tail -n1)"
  v="${v%"${v##*[![:space:]]}"}"
  if [[ "$v" =~ ^\"(.*)\"$ || "$v" =~ ^\'(.*)\'$ ]]; then v="${BASH_REMATCH[1]}"; fi
  printf '%s' "$v"
}

# openssl, with its messages shown only when it fails.
OSSL_ERR=""
ossl() {
  local out
  if ! out="$(openssl "$@" 2>&1 >/dev/null)"; then
    OSSL_ERR="$out"
    return 1
  fi
}

check_prereqs() {
  if [[ -z "$ROOT" && $EUID -ne 0 ]]; then die "run as root (sudo $0 ...)"; fi
  command -v openssl >/dev/null 2>&1 || die "openssl not found (Raspberry Pi OS ships it: sudo apt install openssl)"
  [[ -n "$ROOT" ]] || command -v flock >/dev/null 2>&1 || die "flock not found (util-linux)"
}

# A root-owned folder of this script: created if missing; refused if it is a
# symlink or someone else could write to it.
own_dir() { # own_dir <mode> <path>
  local mode="$1" path="$2"
  in_root "$path"
  [[ ! -L "$path" ]] || die "${path#"$ROOT"} is a symlink; refusing"
  if [[ ! -d "$path" ]]; then
    [[ ! -e "$path" ]] || die "${path#"$ROOT"} exists and is not a folder"
    mkdir -m "$mode" -- "$path"
  fi
  if [[ $EUID -eq 0 && "$(stat -c '%u' -- "$path")" != 0 ]]; then
    die "${path#"$ROOT"} is not owned by root; fix it (chown root:root) and run again"
  fi
  chmod "$mode" -- "$path"
}

# put_file <mode> <dest> <src>: atomic (temp file in the destination folder,
# then rename), so a reader sees the old or the new file, never a part.
put_file() {
  local mode="$1" dest="$2" src="$3" tmp
  in_root "$dest"
  [[ ! -L "$dest" ]] || die "${dest#"$ROOT"} is a symlink; refusing"
  [[ ! -e "$dest" || -f "$dest" ]] || die "${dest#"$ROOT"} exists and is not a regular file; refusing"
  tmp="$(mktemp "$(dirname -- "$dest")/.$(basename -- "$dest").XXXXXX")"
  cat -- "$src" > "$tmp"
  chmod "$mode" -- "$tmp"
  mv -f -T -- "$tmp" "$dest"
}

WORK=""
cleanup() { [[ -z "$WORK" ]] || rm -rf -- "$WORK"; }
trap cleanup EXIT

LOCKED=0
take_lock() {
  [[ $LOCKED -eq 0 ]] || return 0
  local lock
  lock="$(p "$TLS_DIR_REAL")/.lock"
  in_root "$lock"
  [[ ! -L "$lock" ]] || die "${lock#"$ROOT"} is a symlink; refusing"
  exec 9>>"$lock"
  if command -v flock >/dev/null 2>&1; then
    flock -w 60 9 || die "another shadow-core-tls run holds ${lock#"$ROOT"}; try again later"
  fi
  LOCKED=1
}

work_dir() {
  [[ -n "$WORK" ]] || WORK="$(mktemp -d "$(p "$TLS_DIR_REAL")/.work.XXXXXX")"
}

# ---------------------------------------------------------------- CA
# The address the CA is constrained to (its one permitted IP subtree), or empty.
ca_ip() {
  local crt
  crt="$(p "$TLS_DIR_REAL")/ca.crt"
  openssl x509 -in "$crt" -noout -ext nameConstraints 2>/dev/null \
    | sed -n 's|^[[:space:]]*IP:\([0-9.]*\)/255\.255\.255\.255[[:space:]]*$|\1|p'
}

# Prints the state of the CA files: none, ok, or a reason they cannot be used.
ca_state() {
  local dir key crt n
  dir="$(p "$TLS_DIR_REAL")"; key="$dir/ca.key"; crt="$dir/ca.crt"
  if [[ ! -e "$key" && ! -L "$key" && ! -e "$crt" && ! -L "$crt" ]]; then echo none; return; fi
  if [[ -L "$key" || -L "$crt" ]]; then echo "ca.key or ca.crt is a symlink"; return; fi
  [[ -f "$key" ]] || { echo "ca.key is missing"; return; }
  [[ -f "$crt" ]] || { echo "ca.crt is missing"; return; }
  if ! openssl x509 -in "$crt" -noout 2>/dev/null; then echo "ca.crt is not a PEM certificate"; return; fi
  if [[ "$(openssl pkey -in "$key" -pubout 2>/dev/null)" != "$(openssl x509 -in "$crt" -noout -pubkey 2>/dev/null)" ]]; then
    echo "ca.key does not belong to ca.crt"; return
  fi
  n="$(ca_ip | grep -c . || true)"
  [[ "$n" == 1 ]] || { echo "ca.crt is not constrained to exactly one IPv4 address (not made by this script?)"; return; }
  echo ok
}

check_ca_key_mode() {
  local key
  key="$(p "$TLS_DIR_REAL")/ca.key"
  [[ "$(stat -c '%a' -- "$key")" == 600 ]] || die "${key#"$ROOT"} has mode $(stat -c '%a' -- "$key"), expected 600; fix it (chmod 600) and run again"
  if [[ $EUID -eq 0 && "$(stat -c '%u' -- "$key")" != 0 ]]; then die "${key#"$ROOT"} is not owned by root"; fi
}

create_ca() {
  local ip="$1" dir serial
  dir="$(p "$TLS_DIR_REAL")"
  work_dir
  # pathlen:0: this CA signs server certificates only, never another CA.
  # Name constraint: the permitted IP subtree limits IP names to the Pi's one
  # address; the permitted DNS subtree "invalid" (RFC 6761, never resolves)
  # keeps DNS names out as well, which an IP subtree alone does not constrain.
  # Together the CA cannot vouch for any real web site even if its key leaked.
  cat > "$WORK/ca.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
[dn]
CN = $CA_CN
[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical, permitted;IP:$ip/255.255.255.255, permitted;DNS:invalid
EOF
  serial="0x$(openssl rand -hex 16)"
  ossl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$WORK/ca.key" \
    || die "cannot create the CA key: $OSSL_ERR"
  ossl req -x509 -new -key "$WORK/ca.key" -config "$WORK/ca.cnf" -extensions v3_ca \
      -set_serial "$serial" -days "$CA_DAYS" -sha256 -out "$WORK/ca.crt" \
    || die "cannot create the CA certificate: $OSSL_ERR"
  # Key first: a crash in between leaves a pair that ca_state reports as not matching.
  put_file 0600 "$dir/ca.key" "$WORK/ca.key"
  put_file 0644 "$dir/ca.crt" "$WORK/ca.crt"
  rm -f -- "$WORK/ca.key"
  info "created the CA for $ip (valid $CA_DAYS days): ${TLS_DIR_REAL}/ca.crt"
}

# ---------------------------------------------------------------- server certificate
# Prints why the server certificate must be (re)issued for <ip>, or nothing.
leaf_reason() {
  local ip="$1" dir crt key san
  dir="$(p "$TLS_DIR_REAL")"; crt="$dir/core.crt"; key="$(p "$KEY_REAL")"
  [[ -f "$crt" && ! -L "$crt" ]] || { echo "there is no server certificate"; return; }
  [[ -f "$key" && ! -L "$key" ]] || { echo "there is no server key in $KEY_REAL"; return; }
  openssl x509 -in "$crt" -noout 2>/dev/null || { echo "core.crt is not a PEM certificate"; return; }
  if ! openssl x509 -in "$crt" -noout -checkend $(( DAYS * 86400 )) >/dev/null 2>&1; then
    echo "it expires within $DAYS days ($(openssl x509 -in "$crt" -noout -enddate | cut -d= -f2))"; return
  fi
  san="$(openssl x509 -in "$crt" -noout -ext subjectAltName 2>/dev/null | sed -n '2,$p' | tr -d ' ')"
  [[ "$san" == "IPAddress:$ip" ]] || { echo "it names ${san:-nothing}, not IP Address:$ip"; return; }
  if ! openssl verify -x509_strict -purpose sslserver -CAfile "$dir/ca.crt" "$crt" >/dev/null 2>&1; then
    echo "it does not verify against the current CA"; return
  fi
  if [[ "$(openssl pkey -in "$key" -pubout 2>/dev/null)" != "$(openssl x509 -in "$crt" -noout -pubkey 2>/dev/null)" ]]; then
    echo "the key in $KEY_REAL does not belong to it"; return
  fi
}

issue_leaf() {
  local ip="$1" dir store serial
  dir="$(p "$TLS_DIR_REAL")"; store="$(p "$CREDSTORE_REAL")"
  # The CA must outlive the new certificate (browsers reject the chain once the CA expires).
  if ! openssl x509 -in "$dir/ca.crt" -noout -checkend $(( (LEAF_DAYS + 1) * 86400 )) >/dev/null 2>&1; then
    die "the CA expires on $(openssl x509 -in "$dir/ca.crt" -noout -enddate | cut -d= -f2), before a new certificate would: recreate it (init --ip <pi-lan-ip> --recreate-ca) and import the new ca.crt on the PC"
  fi
  work_dir
  cat > "$WORK/leaf.cnf" <<EOF
[v3_leaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = IP:$ip
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
EOF
  serial="0x$(openssl rand -hex 16)"
  ossl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$WORK/leaf.key" \
    || die "cannot create the server key: $OSSL_ERR"
  ossl req -new -key "$WORK/leaf.key" -subj "/CN=$LEAF_CN" -out "$WORK/leaf.csr" \
    || die "cannot create the certificate request: $OSSL_ERR"
  ossl x509 -req -in "$WORK/leaf.csr" -CA "$dir/ca.crt" -CAkey "$dir/ca.key" -set_serial "$serial" \
      -days "$LEAF_DAYS" -sha256 -extfile "$WORK/leaf.cnf" -extensions v3_leaf -out "$WORK/leaf.crt" \
    || die "cannot sign the server certificate: $OSSL_ERR"
  # Never install a certificate that the CA (and its name constraint) does not accept.
  ossl verify -x509_strict -purpose sslserver -CAfile "$dir/ca.crt" "$WORK/leaf.crt" \
    || die "the new server certificate does not verify; nothing installed: $OSSL_ERR"

  # Key into the credstore (root 0700; file 0600 from the start under umask 077),
  # then the certificate. Between the two renames the pair does not match; the
  # Core only reads them at start, and the restart below comes after both.
  own_dir 0700 "$store"
  put_file 0600 "$(p "$KEY_REAL")" "$WORK/leaf.key"
  rm -f -- "$WORK/leaf.key"
  put_file 0644 "$dir/core.crt" "$WORK/leaf.crt"
  info "issued the server certificate for IP $ip, valid until $(openssl x509 -in "$dir/core.crt" -noout -enddate | cut -d= -f2) (key: $KEY_REAL)"
}

# ---------------------------------------------------------------- systemctl
core_active() {
  [[ -n "$ROOT" ]] && return 0   # test root: report what would happen
  systemctl is-active --quiet "$CORE_UNIT"
}

restart_core() {
  local env_ip="$1" dropin
  if [[ -z "$env_ip" ]]; then
    info "core.env does not enable the TLS listener (CORE_TLS_HOST): no restart"
    return 0
  fi
  dropin="$(p "$DROPIN_REAL")"
  if ! grep -qx "LoadCredential=tls-key:$KEY_REAL" "$dropin" 2>/dev/null; then
    warn "$DROPIN_REAL has no 'LoadCredential=tls-key:$KEY_REAL' line: run install-core.sh install --user <user> again (it adds the line), then restart shadow-core"
  fi
  if ! core_active; then
    info "shadow-core is not running: the new certificate is used at its next start"
    return 0
  fi
  if [[ -n "$ROOT" ]]; then
    printf '  (test root) skipped: systemctl restart %s\n' "$CORE_UNIT"
    return 0
  fi
  info "restarting shadow-core to load the new certificate"
  systemctl restart "$CORE_UNIT" || die "systemctl restart $CORE_UNIT failed: journalctl -u shadow-core -n 50"
}

# renew_leaf <ip> <env_ip> <force>: issues the certificate if needed, restarts.
renew_leaf() {
  local ip="$1" env_ip="$2" force="$3" reason cf
  reason="$(leaf_reason "$ip")"
  if [[ $force -eq 1 ]]; then reason="${reason:-forced}"; fi
  if [[ -z "$reason" ]]; then
    info "server certificate for $ip is valid until $(openssl x509 -in "$(p "$TLS_DIR_REAL")/core.crt" -noout -enddate | cut -d= -f2); nothing to do"
    return 0
  fi
  info "issuing a new server certificate: $reason"
  issue_leaf "$ip"
  cf="$(env_value CORE_TLS_CERT_FILE)"
  if [[ -n "$cf" && "$cf" != "$TLS_DIR_REAL/core.crt" ]]; then
    warn "core.env sets CORE_TLS_CERT_FILE=$cf, but the certificate is written to $TLS_DIR_REAL/core.crt"
  fi
  restart_core "$env_ip"
}

# ---------------------------------------------------------------- commands
print_ca_info() {
  local crt
  crt="$(p "$TLS_DIR_REAL")/ca.crt"
  printf '\nCA certificate for the PC (public): %s\n' "$TLS_DIR_REAL/ca.crt"
  printf '  %s\n' "$(openssl x509 -in "$crt" -noout -subject)"
  printf '  serial=%s\n' "$(openssl x509 -in "$crt" -noout -serial | cut -d= -f2)"
  printf '  SHA-1 (certutil "Cert Hash(sha1)") %s\n' "$(openssl x509 -in "$crt" -noout -fingerprint -sha1 | cut -d= -f2)"
  printf '  valid until %s\n' "$(openssl x509 -in "$crt" -noout -enddate | cut -d= -f2)"
}

init_main() {
  local env_ip state cur recreated=0
  valid_ipv4 "$IP" || die "--ip '$IP' is not an IPv4 address (dotted, no leading zeros; not 0.0.0.0); IPv6 and host names are not supported"
  env_ip="$(env_value CORE_TLS_HOST)"
  if [[ -n "$env_ip" && "$env_ip" != "$IP" ]]; then
    die "$ENV_REAL sets CORE_TLS_HOST=$env_ip, not $IP: use that address or change core.env first (renewals read it from there)"
  fi
  [[ -d "$(p /etc)" ]] || die "$(p /etc) does not exist"
  # install-core.sh owns /etc/shadow-assistant (its mode is not changed here).
  local etc
  etc="$(p "$ETC_REAL")"
  in_root "$etc"
  if [[ -L "$etc" || ! -d "$etc" ]]; then
    own_dir 0755 "$etc"
  elif [[ $EUID -eq 0 ]] && { [[ "$(stat -c '%u' -- "$etc")" != 0 ]] || (( (8#$(stat -c '%a' -- "$etc") & 8#022) != 0 )); }; then
    die "$ETC_REAL must be owned by root and not writable by group or others; fix it and run again"
  fi
  own_dir 0755 "$(p "$TLS_DIR_REAL")"
  take_lock

  state="$(ca_state)"
  if [[ "$state" == ok ]]; then
    cur="$(ca_ip)"
    if [[ $RECREATE_CA -eq 0 ]]; then
      check_ca_key_mode
      [[ "$cur" == "$IP" ]] || die "the CA is constrained to $cur, not $IP; to replace it pass --recreate-ca (every PC must then import the new ca.crt again)"
      info "CA for $IP exists; kept"
    fi
  elif [[ "$state" != none && $RECREATE_CA -eq 0 ]]; then
    die "the CA in $TLS_DIR_REAL cannot be used: $state; to replace it pass --recreate-ca (every PC must then import the new ca.crt again)"
  fi

  if [[ "$state" == none || $RECREATE_CA -eq 1 ]]; then
    if [[ "$state" != none ]]; then
      cat >&2 <<EOF

**********************************************************************
WARNING: replacing the CA in $TLS_DIR_REAL (--recreate-ca).
Every browser that trusted the old CA stops trusting the Pi's HTTPS
listener. On each PC: remove the old CA from the current user's Trusted
Root Certification Authorities and import the new ca.crt
(docs/05 section 7 "HTTPS certificate").
**********************************************************************

EOF
    fi
    create_ca "$IP"
    recreated=1
  fi

  renew_leaf "$IP" "$env_ip" "$recreated"
  print_ca_info
  printf '\nNext steps (docs/05 section 7 "HTTPS certificate"):\n'
  [[ -n "$env_ip" ]] || printf '  - Enable the TLS lines in %s (CORE_TLS_HOST=%s, CORE_TLS_PORT, CORE_TLS_CERT_FILE=%s)\n' "$ENV_REAL" "$IP" "$TLS_DIR_REAL/core.crt"
  printf '  - Run install-core.sh install --user <user> again (adds LoadCredential=tls-key), then: sudo systemctl restart shadow-core\n'
  if [[ $recreated -eq 1 ]]; then
    printf '  - On the PC (once per CA): copy %s and run: certutil -user -addstore Root ca.crt\n' "$TLS_DIR_REAL/ca.crt"
  fi
}

renew_main() {
  local env_ip state ip cur
  [[ -d "$(p "$TLS_DIR_REAL")" ]] || die "no $TLS_DIR_REAL: create the CA first (shadow-core-tls init --ip <pi-lan-ip>)"
  own_dir 0755 "$(p "$TLS_DIR_REAL")"
  take_lock
  state="$(ca_state)"
  [[ "$state" != none ]] || die "no CA in $TLS_DIR_REAL: create it first (shadow-core-tls init --ip <pi-lan-ip>)"
  [[ "$state" == ok ]] || die "the CA in $TLS_DIR_REAL cannot be used: $state (shadow-core-tls init --ip <pi-lan-ip> --recreate-ca replaces it)"
  check_ca_key_mode
  cur="$(ca_ip)"
  env_ip="$(env_value CORE_TLS_HOST)"
  if [[ -n "$env_ip" ]]; then
    valid_ipv4 "$env_ip" || die "CORE_TLS_HOST=$env_ip in $ENV_REAL is not an IPv4 address; this script supports IPv4 only"
    ip="$env_ip"
  else
    ip="$cur"
    info "CORE_TLS_HOST is not set in $ENV_REAL: using the CA's address $ip"
  fi
  [[ "$ip" == "$cur" ]] || die "CORE_TLS_HOST=$ip, but the CA is constrained to $cur: a certificate for $ip would not be trusted. Recreate the CA (shadow-core-tls init --ip $ip --recreate-ca) and import the new ca.crt on the PC"
  renew_leaf "$ip" "$env_ip" "$FORCE"
}

main() {
  parse_args "$@"
  check_prereqs
  case "$CMD" in
    init) init_main ;;
    renew) renew_main ;;
  esac
}

main "$@"
