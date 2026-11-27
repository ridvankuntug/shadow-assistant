#!/usr/bin/env bash
# shadow-core-tls.sh: the local CA and the TLS server certificate of the Core's
# HTTPS listener on the Pi (docs/13-pi-core-and-agents.md section 4.3; steps:
# docs/05-deploy.md section 7 "HTTPS certificate"). install-core.sh installs it
# as /usr/local/sbin/shadow-core-tls; the renewal timer runs "renew". Run as root.
#
#   shadow-core-tls init --ip <pi-lan-ip> [--hostname <lan-name>] [--recreate-ca]
#   shadow-core-tls renew [--days <n>] [--force]
#   shadow-core-tls --help
# Common option: --root <dir> (prefix every path, for tests; skips systemctl).
#
# init   creates the CA if there is none (EC P-256, 10 years, name-constrained
#        to the one IPv4 address and, with --hostname, that one DNS name),
#        then issues the server certificate as renew does. An existing CA is
#        never replaced, except with --recreate-ca (then every PC must import
#        the new ca.crt again); another address or host name needs that.
# renew  issues a new server certificate (EC P-256, 1 year, subjectAltName
#        IP:<address>, plus DNS:<name> with a host name) when there is none,
#        it expires within --days (default 30), it names anything else, it is
#        not signed by the current CA, its key in the credstore is missing or
#        does not match, or with --force. Then it restarts shadow-core if it is
#        running and core.env enables the TLS listener. Nothing to do: exit 0,
#        nothing changed. It refuses (nothing changed) when core.env asks for
#        another address or host name than the CA is constrained to.
# The address and host name: CORE_TLS_HOST and CORE_TLS_HOSTNAME in
# /etc/shadow-assistant/core.env (the one setting); while both lines are
# commented, the CA's own. IPv4 only. The host name is optional: one
# lower-case DNS name with at least two labels (e.g. shadow.lan), no wildcard.
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
NAME=""   # --hostname (not HOSTNAME: bash sets that one)
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
      --hostname) [[ "$CMD" == init ]] || die "--hostname is for init (renew reads CORE_TLS_HOSTNAME from $ENV_REAL)"; need_value "$@"; NAME="$2"; shift 2 ;;
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

# The host name rule (the same as validTlsHostname in core/src/listeners.ts):
# lower-case LDH labels of 1-63 characters, at least two labels, at most 253
# characters, no wildcard, no trailing dot, last label not all digits (never
# an IPv4 address).
valid_hostname() {
  local l='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
  [[ ${#1} -le 253 && "$1" =~ ^($l\.)+$l$ && ! "${1##*.}" =~ ^[0-9]+$ ]]
}
readonly HOSTNAME_RULE="one lower-case DNS name with at least two labels (letters, digits, inner '-'; no wildcard, no trailing dot, not an IP address), e.g. shadow.lan"

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
  tmp="$(mktemp "$(dirname -- "$dest")/.$(basename -- "$dest").XXXXXX")" || die "cannot create a temporary file next to ${dest#"$ROOT"}"
  # Explicit checks: a short write (full disk) must never be renamed into place.
  if ! cat -- "$src" > "$tmp" || ! chmod "$mode" -- "$tmp"; then
    rm -f -- "$tmp"; die "cannot write ${dest#"$ROOT"}; left unchanged"
  fi
  mv -f -T -- "$tmp" "$dest" || { rm -f -- "$tmp"; die "cannot replace ${dest#"$ROOT"}"; }
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
# The CA's name constraint, one subtree per line: "permitted IP:<a>/<mask>",
# "permitted DNS:<n>", "excluded DNS:<n>" (other kinds keep OpenSSL's label
# and make ca_state refuse the CA).
ca_subtrees() {
  local crt
  crt="$(p "$TLS_DIR_REAL")/ca.crt"
  openssl x509 -in "$crt" -noout -ext nameConstraints 2>/dev/null | awk '
    /^[[:space:]]*Permitted:[[:space:]]*$/ { k = "permitted"; next }
    /^[[:space:]]*Excluded:[[:space:]]*$/ { k = "excluded"; next }
    k != "" && NF { sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, ""); print k " " $0 }'
}

# The subtrees create_ca writes: the IP, and the host name with its
# subdomains excluded, or the DNS name "invalid" when there is no host name.
nc_subtrees() { # nc_subtrees <ip> <name or empty>
  printf 'permitted IP:%s/255.255.255.255\n' "$1"
  if [[ -n "$2" ]]; then
    printf 'permitted DNS:%s\nexcluded DNS:.%s\n' "$2" "$2"
  else
    printf 'permitted DNS:invalid\n'
  fi
}

# The address the CA is constrained to (its one permitted IP subtree), or empty.
ca_ip() {
  ca_subtrees | sed -n 's|^permitted IP:\([0-9.]*\)/255\.255\.255\.255$|\1|p'
}

# The host name the CA is constrained to, or empty (DNS:invalid: no host name).
ca_name() {
  ca_subtrees | sed -n 's|^permitted DNS:||p' | grep -vx invalid || true
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
  # Exactly the set create_ca writes: nothing else permitted, nothing else excluded.
  n="$(ca_name)"
  if [[ -n "$n" ]] && ! valid_hostname "$n"; then echo "ca.crt is not constrained to one valid host name (not made by this script?)"; return; fi
  [[ "$(ca_subtrees)" == "$(nc_subtrees "$(ca_ip)" "$n")" ]] || { echo "ca.crt has a name constraint this script does not write (not made by this script?)"; return; }
  echo ok
}

check_ca_key_mode() {
  local key
  key="$(p "$TLS_DIR_REAL")/ca.key"
  [[ "$(stat -c '%a' -- "$key")" == 600 ]] || die "${key#"$ROOT"} has mode $(stat -c '%a' -- "$key"), expected 600; fix it (chmod 600) and run again"
  if [[ $EUID -eq 0 && "$(stat -c '%u' -- "$key")" != 0 ]]; then die "${key#"$ROOT"} is not owned by root"; fi
}

create_ca() {
  local ip="$1" name="$2" dir serial nc
  dir="$(p "$TLS_DIR_REAL")"
  work_dir
  # pathlen:0: this CA signs server certificates only, never another CA.
  # Name constraint: the permitted IP subtree limits IP names to the Pi's one
  # address. An IP subtree alone does not constrain DNS names at all (a leaf
  # for www.example.com would verify), so there is always a DNS subtree too:
  # - with a host name: permitted DNS:<name>. A permitted DNS subtree also
  #   covers every subdomain (RFC 5280), so excluded DNS:.<name> takes those
  #   out again (OpenSSL: ".<name>" matches subdomains only, not <name>);
  # - without one: permitted DNS:invalid (RFC 6761, never resolves).
  # Together the CA cannot vouch for any real web site even if its key leaked.
  nc="critical, permitted;IP:$ip/255.255.255.255"
  if [[ -n "$name" ]]; then nc+=", permitted;DNS:$name, excluded;DNS:.$name"; else nc+=", permitted;DNS:invalid"; fi
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
nameConstraints = $nc
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
  info "created the CA for $(names_text "$ip" "$name") (valid $CA_DAYS days): ${TLS_DIR_REAL}/ca.crt"
}

# "IP <ip>" or "IP <ip> and DNS name <name>", for messages.
names_text() { printf 'IP %s%s' "$1" "${2:+ and DNS name $2}"; }

# ---------------------------------------------------------------- server certificate
# Prints why the server certificate must be (re)issued for <ip> [<name>], or nothing.
leaf_reason() {
  local ip="$1" name="$2" dir crt key san
  dir="$(p "$TLS_DIR_REAL")"; crt="$dir/core.crt"; key="$(p "$KEY_REAL")"
  [[ -f "$crt" && ! -L "$crt" ]] || { echo "there is no server certificate"; return; }
  [[ -f "$key" && ! -L "$key" ]] || { echo "there is no server key in $KEY_REAL"; return; }
  openssl x509 -in "$crt" -noout 2>/dev/null || { echo "core.crt is not a PEM certificate"; return; }
  if ! openssl x509 -in "$crt" -noout -checkend $(( DAYS * 86400 )) >/dev/null 2>&1; then
    echo "it expires within $DAYS days ($(openssl x509 -in "$crt" -noout -enddate | cut -d= -f2))"; return
  fi
  san="$(openssl x509 -in "$crt" -noout -ext subjectAltName 2>/dev/null | sed -n '2,$p' | tr -d ' ')"
  [[ "$san" == "IPAddress:$ip${name:+,DNS:$name}" ]] || { echo "it names ${san:-nothing}, not IP Address:$ip${name:+, DNS:$name}"; return; }
  if ! openssl verify -x509_strict -purpose sslserver -CAfile "$dir/ca.crt" "$crt" >/dev/null 2>&1; then
    echo "it does not verify against the current CA"; return
  fi
  if [[ "$(openssl pkey -in "$key" -pubout 2>/dev/null)" != "$(openssl x509 -in "$crt" -noout -pubkey 2>/dev/null)" ]]; then
    echo "the key in $KEY_REAL does not belong to it"; return
  fi
}

issue_leaf() {
  local ip="$1" name="$2" dir store serial
  dir="$(p "$TLS_DIR_REAL")"; store="$(p "$CREDSTORE_REAL")"
  # The CA must outlive the new certificate (browsers reject the chain once the CA expires).
  if ! openssl x509 -in "$dir/ca.crt" -noout -checkend $(( (LEAF_DAYS + 1) * 86400 )) >/dev/null 2>&1; then
    die "the CA expires on $(openssl x509 -in "$dir/ca.crt" -noout -enddate | cut -d= -f2), before a new certificate would: recreate it (init --ip <pi-lan-ip> [--hostname <lan-name>] --recreate-ca) and import the new ca.crt on the PC"
  fi
  work_dir
  cat > "$WORK/leaf.cnf" <<EOF
[v3_leaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = IP:$ip${name:+, DNS:$name}
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
  info "issued the server certificate for $(names_text "$ip" "$name"), valid until $(openssl x509 -in "$dir/core.crt" -noout -enddate | cut -d= -f2) (key: $KEY_REAL)"
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

# renew_leaf <ip> <name> <env_ip> <force>: issues the certificate if needed, restarts.
renew_leaf() {
  local ip="$1" name="$2" env_ip="$3" force="$4" reason
  reason="$(leaf_reason "$ip" "$name")"
  if [[ $force -eq 1 ]]; then reason="${reason:-forced}"; fi
  if [[ -z "$reason" ]]; then
    info "server certificate for $(names_text "$ip" "$name") is valid until $(openssl x509 -in "$(p "$TLS_DIR_REAL")/core.crt" -noout -enddate | cut -d= -f2); nothing to do"
    return 0
  fi
  info "issuing a new server certificate: $reason"
  issue_leaf "$ip" "$name"
  restart_core "$env_ip"
}

# The certificate is always written to tls/core.crt. Another CORE_TLS_CERT_FILE
# would pair the new key with an old certificate at the next start (the Core
# then refuses to start), so refuse before anything is written.
check_cert_file() {
  local cf
  cf="$(env_value CORE_TLS_CERT_FILE)"
  if [[ -n "$cf" && "$cf" != "$TLS_DIR_REAL/core.crt" ]]; then
    die "$ENV_REAL sets CORE_TLS_CERT_FILE=$cf; this script writes $TLS_DIR_REAL/core.crt only: set CORE_TLS_CERT_FILE=$TLS_DIR_REAL/core.crt (nothing changed)"
  fi
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
  local env_ip env_name state cur cur_name recreated=0
  valid_ipv4 "$IP" || die "--ip '$IP' is not an IPv4 address (dotted, no leading zeros; not 0.0.0.0); IPv6 is not supported, a host name goes to --hostname"
  [[ -z "$NAME" ]] || valid_hostname "$NAME" || die "--hostname '$NAME' is not valid: $HOSTNAME_RULE"
  env_ip="$(env_value CORE_TLS_HOST)"
  env_name="$(env_value CORE_TLS_HOSTNAME)"
  if [[ -n "$env_ip" && "$env_ip" != "$IP" ]]; then
    die "$ENV_REAL sets CORE_TLS_HOST=$env_ip, not $IP: use that address or change core.env first (renewals read it from there)"
  fi
  # core.env is the one setting: once it has a TLS line, --hostname must say the same.
  [[ -z "$env_name" ]] || valid_hostname "$env_name" || die "CORE_TLS_HOSTNAME=$env_name in $ENV_REAL is not valid: $HOSTNAME_RULE"
  if [[ -n "$env_name" && "$env_name" != "$NAME" ]]; then
    die "$ENV_REAL sets CORE_TLS_HOSTNAME=$env_name, not ${NAME:-(none)}: pass --hostname $env_name or change core.env first (renewals read it from there)"
  fi
  if [[ -n "$env_ip" && -z "$env_name" && -n "$NAME" ]]; then
    die "$ENV_REAL enables the TLS listener without CORE_TLS_HOSTNAME: add CORE_TLS_HOSTNAME=$NAME there first, or run init without --hostname (renewals read it from there)"
  fi
  check_cert_file
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
  # The credstore before the CA: the renewal unit cannot create it later
  # (ProtectSystem=strict keeps /etc read-only there).
  own_dir 0700 "$(p "$CREDSTORE_REAL")"
  take_lock

  state="$(ca_state)"
  if [[ "$state" == ok ]]; then
    cur="$(ca_ip)"; cur_name="$(ca_name)"
    if [[ $RECREATE_CA -eq 0 ]]; then
      check_ca_key_mode
      [[ "$cur" == "$IP" && "$cur_name" == "$NAME" ]] || die "the CA is constrained to $(names_text "$cur" "$cur_name"), not $(names_text "$IP" "$NAME"); to replace it pass --recreate-ca (every PC must then import the new ca.crt again)"
      info "CA for $(names_text "$IP" "$NAME") exists; kept"
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
    create_ca "$IP" "$NAME"
    recreated=1
  fi

  renew_leaf "$IP" "$NAME" "$env_ip" "$recreated"
  print_ca_info
  printf '\nNext steps (docs/05 section 7 "HTTPS certificate"):\n'
  [[ -n "$env_ip" ]] || printf '  - Enable the TLS lines in %s (CORE_TLS_HOST=%s, CORE_TLS_PORT, CORE_TLS_CERT_FILE=%s)\n' "$ENV_REAL" "$IP" "$TLS_DIR_REAL/core.crt"
  [[ -z "$NAME" || -n "$env_name" ]] || printf '  - Also set CORE_TLS_HOSTNAME=%s there; the name must resolve to %s on the LAN (router DNS or the PC hosts file)\n' "$NAME" "$IP"
  printf '  - Run install-core.sh install --user <user> again (adds LoadCredential=tls-key), then: sudo systemctl restart shadow-core\n'
  if [[ $recreated -eq 1 ]]; then
    printf '  - On the PC (once per CA): copy %s and run: certutil -user -addstore Root ca.crt\n' "$TLS_DIR_REAL/ca.crt"
  fi
}

renew_main() {
  local env_ip env_name state ip cur name cur_name
  [[ -d "$(p "$TLS_DIR_REAL")" ]] || die "no $TLS_DIR_REAL: create the CA first (shadow-core-tls init --ip <pi-lan-ip>)"
  check_cert_file
  own_dir 0755 "$(p "$TLS_DIR_REAL")"
  take_lock
  state="$(ca_state)"
  [[ "$state" != none ]] || die "no CA in $TLS_DIR_REAL: create it first (shadow-core-tls init --ip <pi-lan-ip>)"
  [[ "$state" == ok ]] || die "the CA in $TLS_DIR_REAL cannot be used: $state (shadow-core-tls init --ip <pi-lan-ip> --recreate-ca replaces it)"
  check_ca_key_mode
  cur="$(ca_ip)"; cur_name="$(ca_name)"
  env_ip="$(env_value CORE_TLS_HOST)"
  env_name="$(env_value CORE_TLS_HOSTNAME)"
  if [[ -n "$env_ip" ]]; then
    valid_ipv4 "$env_ip" || die "CORE_TLS_HOST=$env_ip in $ENV_REAL is not an IPv4 address; this script supports IPv4 only"
    ip="$env_ip"
  else
    ip="$cur"
    info "CORE_TLS_HOST is not set in $ENV_REAL: using the CA's address $ip"
  fi
  # With either TLS line set, core.env decides the host name (none while its line is commented).
  if [[ -n "$env_ip" || -n "$env_name" ]]; then
    [[ -z "$env_name" ]] || valid_hostname "$env_name" || die "CORE_TLS_HOSTNAME=$env_name in $ENV_REAL is not valid: $HOSTNAME_RULE"
    name="$env_name"
  else
    name="$cur_name"
    [[ -z "$name" ]] || info "CORE_TLS_HOSTNAME is not set in $ENV_REAL: using the CA's host name $name"
  fi
  [[ "$ip" == "$cur" ]] || die "CORE_TLS_HOST=$ip, but the CA is constrained to $cur: a certificate for $ip would not be trusted. Recreate the CA (shadow-core-tls init --ip $ip${name:+ --hostname $name} --recreate-ca) and import the new ca.crt on the PC"
  # The host name is part of the CA's name constraint: adding, changing or removing it needs a new CA.
  if [[ "$name" != "$cur_name" ]]; then
    die "$ENV_REAL asks for host name ${name:-(none)}, but the CA is constrained to ${cur_name:-no host name}; the name is part of the CA, so this needs a new CA (nothing changed): shadow-core-tls init --ip $ip${name:+ --hostname $name} --recreate-ca, then import the new ca.crt on the PC (docs/05 section 7)"
  fi
  renew_leaf "$ip" "$name" "$env_ip" "$FORCE"
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
