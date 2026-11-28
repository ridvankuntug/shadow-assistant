#!/usr/bin/env bash
# Offline tests for .github/scripts/core-release-notes.sh: throw-away git
# repositories, no network. Needs bash and git, e.g. (from the repository root):
#   docker run --rm -v "$PWD/.github/scripts:/s:ro" shadow-deploy-test sh -c \
#     'apt-get update -qq && apt-get install -y -qq git >/dev/null && bash /s/tests/core-release-notes.test.sh'
# Exit 0 when every scenario passes.

# shellcheck disable=SC2016
set -uo pipefail
export LC_ALL=C

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
NOTES="$HERE/core-release-notes.sh"
W="$(mktemp -d)"
trap 'rm -rf -- "$W"' EXIT
command -v git >/dev/null || { echo "git is needed" >&2; exit 2; }
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid

PASS=0
FAIL=0
CURRENT_TEST=""
check() { if eval "$1"; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); printf 'FAIL [%s]: %s\n--- notes:\n' "$CURRENT_TEST" "$2"; sed 's/^/    /' "$W/out" "$W/err" 2>/dev/null; fi; }

repo() {
  CURRENT_TEST="$1"
  rm -rf -- "$W/r"; mkdir -p "$W/r"
  git -C "$W/r" init -q -b main
}
commit() { # commit <message>
  # One file per branch: a merge never conflicts.
  local f
  f="f-$(git -C "$W/r" branch --show-current)"
  printf '%s\n' "$RANDOM" >> "$W/r/$f"
  git -C "$W/r" add -- "$f"
  git -C "$W/r" commit -q -m "$1"
}
head_sha() { git -C "$W/r" rev-parse HEAD; }
RC=0
notes() { # notes [commit]
  (cd "$W/r" && bash "$NOTES" 0.2.9 "${1:-$(head_sha)}" shadow-core-v0.2.9-linux-arm64.tar.gz abc123) > "$W/out" 2> "$W/err"
  RC=$?
}
has() { grep -qF -- "$1" "$W/out"; }
marker_lines() { grep -ci 'data-format-change' "$W/out"; }

repo "no trailer: no marker"
commit "feat: one"
git -C "$W/r" tag core-v0.2.8
commit "fix: two

Co-Authored-By: x <x@example.invalid>"
notes
check '[[ $RC -eq 0 ]] && has "Shadow Assistant Core 0.2.9" && has "Commit: \`$(head_sha)\`"' "rc $RC"
check '[[ "$(marker_lines)" == 0 ]] && ! has "Data format change"' "marker without a trailer"
check '[[ ! -s "$W/err" ]]' "warnings: $(cat "$W/err")"

repo "trailer in the head commit"
commit "feat: one"
git -C "$W/r" tag core-v0.2.8
commit "feat: move conversations

Data-Format-Change: conversations move to data/conv
Co-Authored-By: x <x@example.invalid>"
notes
check '[[ $RC -eq 0 ]] && has "- data-format-change: conversations move to data/conv ($(head_sha | cut -c1-12))" && has "Data format change"' "rc $RC"

repo "trailer in an earlier commit of the range, key in another case, two values"
commit "feat: one"
git -C "$W/r" tag core-v0.2.8
commit "feat: a

data-format-change: first reason
DATA-FORMAT-CHANGE: second reason"
first="$(head_sha)"
commit "fix: b"
notes
check '[[ $RC -eq 0 && "$(marker_lines)" == 2 ]] && has "data-format-change: first reason (${first:0:12})" && has "data-format-change: second reason (${first:0:12})"' "rc $RC lines $(marker_lines)"

repo "trailer before the previous release tag: not in the range"
commit "feat: old

Data-Format-Change: already released"
git -C "$W/r" tag core-v0.2.8
commit "fix: new"
notes
check '[[ $RC -eq 0 && "$(marker_lines)" == 0 ]]' "old trailer counted"

repo "the newest reachable core-v tag bounds the range; other tags do not"
commit "feat: a

Data-Format-Change: in 0.2.7"
git -C "$W/r" tag core-v0.2.7
commit "feat: b

Data-Format-Change: since 0.2.7"
git -C "$W/r" tag v0.2.40
commit "fix: c"
notes
check '[[ $RC -eq 0 && "$(marker_lines)" == 1 ]] && has "since 0.2.7" && ! has "in 0.2.7 ("' "lines $(marker_lines)"

repo "a merged branch's trailer counts"
commit "feat: base"
git -C "$W/r" tag core-v0.2.8
git -C "$W/r" checkout -q -b side
commit "feat: side

Data-Format-Change: from the branch"
git -C "$W/r" checkout -q main
commit "fix: main"
git -C "$W/r" merge -q --no-ff -m "merge side" side
notes
check '[[ $RC -eq 0 ]] && has "data-format-change: from the branch"' "rc $RC"

repo "not a trailer (body text mid-message): no marker"
commit "feat: one"
git -C "$W/r" tag core-v0.2.8
commit "docs: explain

Data-Format-Change: this line is followed by a paragraph

so it is not in the trailer block."
notes
check '[[ $RC -eq 0 && "$(marker_lines)" == 0 ]]' "body text counted"

repo "no earlier tag: the release commit alone, with a warning"
commit "feat: old

Data-Format-Change: before any release"
commit "feat: head"
notes
check '[[ $RC -eq 0 && "$(marker_lines)" == 0 ]] && grep -q "no earlier core-v" "$W/err"' "rc $RC"
commit "feat: marked head

Data-Format-Change: in the first release"
notes
check '[[ $RC -eq 0 && "$(marker_lines)" == 1 ]]' "head not checked: lines $(marker_lines)"

repo "a folded value comes as one line"
commit "feat: one"
git -C "$W/r" tag core-v0.2.8
commit "feat: long

Data-Format-Change: the reason goes on
  on the next line"
notes
check '[[ $RC -eq 0 ]] && has "data-format-change: the reason goes on on the next line ("' "not unfolded"

repo "bad arguments are refused"
commit "feat: one"
(cd "$W/r" && bash "$NOTES" 0.2 "$(head_sha)" p f) > "$W/out" 2> "$W/err"; RC=$?
check '[[ $RC -ne 0 ]]' "bad version accepted"
(cd "$W/r" && bash "$NOTES" 0.2.9 HEAD p f) > "$W/out" 2> "$W/err"; RC=$?
check '[[ $RC -ne 0 ]]' "short ref accepted"
(cd "$W/r" && bash "$NOTES" 0.2.9 0123456789012345678901234567890123456789 p f) > "$W/out" 2> "$W/err"; RC=$?
check '[[ $RC -ne 0 ]] && grep -q "not in this clone" "$W/err"' "unknown commit accepted"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
