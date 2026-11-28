#!/usr/bin/env bash
# Offline tests for .github/scripts/core-package-deploy.sh: copies of the
# repository's deploy/linux/ in a temporary folder. Needs bash and GNU
# coreutils, e.g. (from the repository root):
#   docker run --rm -v "$PWD:/r:ro" shadow-deploy-test bash /r/.github/scripts/tests/core-package-deploy.test.sh
# Exit 0 when every scenario passes.

# shellcheck disable=SC2016,SC2012,SC2034
set -uo pipefail
export LC_ALL=C

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
SCRIPT="$HERE/core-package-deploy.sh"
DEPLOY="$(cd -- "$HERE/../../deploy/linux" && pwd -P)"
W="$(mktemp -d)"
trap 'rm -rf -- "$W"' EXIT

PASS=0
FAIL=0
CURRENT_TEST=""
check() { if eval "$1"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); printf 'FAIL [%s]: %s\n--- output:\n' "$CURRENT_TEST" "$2"; sed 's/^/    /' "$W/out" 2>/dev/null; fi; }

setup() {
  CURRENT_TEST="$1"
  rm -rf -- "$W/src" "$W/pkg"
  mkdir -p "$W/pkg"
  cp -a -- "$DEPLOY" "$W/src"
}
RC=0
pack() { bash "$SCRIPT" "$W/src" "$W/pkg" > "$W/out" 2>&1; RC=$?; }
packed() { (cd "$W/pkg/deploy/linux" 2>/dev/null && ls -A | tr '\n' ' '); }

readonly EXPECTED="core-release.pub core.env.example install-core.sh shadow-core-tls-renew.service shadow-core-tls-renew.timer shadow-core-tls.sh shadow-core-update.service shadow-core-update.sh shadow-core-update.timer shadow-core.service "

setup "packs the deploy files, nothing else"
pack
check '[[ $RC -eq 0 && "$(packed)" == "$EXPECTED" ]]' "rc $RC packed: $(packed)"
check '( for f in $EXPECTED; do cmp -s "$DEPLOY/$f" "$W/pkg/deploy/linux/$f" || exit 1; done )' "content differs"
check '[[ "$(stat -c %a "$W/pkg/deploy/linux/shadow-core-update.sh")" == 755 && "$(stat -c %a "$W/pkg/deploy/linux/shadow-core.service")" == 644 ]]' "modes"
check '[[ -z "$(find "$W/pkg" -type l)" ]]' "symlink in the package"

# Every file install-core.sh deploy-files installs (its DEPLOY_FILES list) is packed.
setup "the package holds every file of install-core.sh's DEPLOY_FILES"
pack
names="$(sed -n '/^readonly DEPLOY_FILES=(/,/^)/p' "$DEPLOY/install-core.sh" | sed -n 's/^  "0[0-7]*|\([^|]*\)|.*/\1/p')"
resolved=""
for n in $names; do
  case "$n" in
    '$UNIT_NAME') n=shadow-core.service ;;
    '$TLS_SCRIPT') n=shadow-core-tls.sh ;;
    '$TLS_SERVICE') n=shadow-core-tls-renew.service ;;
    '$TLS_TIMER') n=shadow-core-tls-renew.timer ;;
    '$UPDATE_SCRIPT') n=shadow-core-update.sh ;;
    '$UPDATE_SERVICE') n=shadow-core-update.service ;;
    '$UPDATE_TIMER') n=shadow-core-update.timer ;;
  esac
  resolved+="$n "
done
check '[[ "$(wc -w <<<"$resolved")" -eq 8 ]]' "DEPLOY_FILES not read: '$resolved'"
check '( for n in $resolved; do [[ "$n" != *'"'"'$'"'"'* && -f "$W/pkg/deploy/linux/$n" ]] || exit 1; done )' "not packed: $resolved"

setup "a missing file fails"
rm "$W/src/shadow-core-tls.sh"
pack
check '[[ $RC -ne 0 ]] && grep -q "shadow-core-tls.sh is missing" "$W/out"' "rc $RC"

setup "a symlink fails"
rm "$W/src/shadow-core.service"; ln -s /etc/passwd "$W/src/shadow-core.service"
pack
check '[[ $RC -ne 0 ]] && grep -q "shadow-core.service is missing or not a regular file" "$W/out"' "rc $RC"

setup "an existing deploy folder in the package fails"
mkdir -p "$W/pkg/deploy"
pack
check '[[ $RC -ne 0 ]] && grep -q "exists already" "$W/out"' "rc $RC"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
