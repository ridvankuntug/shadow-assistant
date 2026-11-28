#!/usr/bin/env bash
# core-package-deploy.sh <deploy/linux folder> <package root>: copies the Pi
# deploy files into <package root>/deploy/linux/ of the Core release package
# (.github/workflows/core.yml; docs/05 section 7 "Release packages"). They are
# covered by the package's SHA-256 in the signed SHA256SUMS like the rest.
#
# The Pi updater installs the scripts and units from there after a successful
# update (install-core.sh deploy-files); core.env.example and core-release.pub
# come along so that the folder can also run a first "install-core.sh install"
# (deploy-files never installs them: no update replaces its own trust root).
# Not packed: tests/ and the wake-svc files (another machine).
#
# Fails on a missing file or a symlink. Tests:
# .github/scripts/tests/core-package-deploy.test.sh
set -euo pipefail
export LC_ALL=C

readonly EXECUTABLES=(install-core.sh shadow-core-update.sh shadow-core-tls.sh)
readonly DATA_FILES=(
  shadow-core.service
  shadow-core-tls-renew.service shadow-core-tls-renew.timer
  shadow-core-update.service shadow-core-update.timer
  core.env.example core-release.pub
)

[[ $# -eq 2 ]] || { echo "usage: $0 <deploy/linux folder> <package root>" >&2; exit 2; }
src="$1"
dest="$2/deploy/linux"
[[ -d "$src" ]] || { echo "error: $src is not a folder" >&2; exit 1; }
[[ -d "$2" ]] || { echo "error: $2 is not a folder" >&2; exit 1; }
[[ ! -e "$2/deploy" ]] || { echo "error: $2/deploy exists already" >&2; exit 1; }

mkdir -p -- "$dest"
copy() { # copy <mode> <name>
  local f="$src/$2"
  if [[ -L "$f" || ! -f "$f" ]]; then
    echo "error: $f is missing or not a regular file" >&2
    exit 1
  fi
  install -m "$1" -- "$f" "$dest/$2"
}
for f in "${EXECUTABLES[@]}"; do copy 0755 "$f"; done
for f in "${DATA_FILES[@]}"; do copy 0644 "$f"; done
echo "deploy files: ${EXECUTABLES[*]} ${DATA_FILES[*]}"
