#!/usr/bin/env bash
# core-release-notes.sh: the release notes (notes.md) of a Core release
# core-v<version>, used by .github/workflows/core.yml (job "GitHub Release").
#
#   core-release-notes.sh <version> <commit> <package file> <key fingerprint>
#
# Run inside a full clone (fetch-depth: 0, with tags); prints the notes on
# stdout, warnings on stderr (GitHub "::warning::" lines).
#
# Data-format marker (docs/05 section 7 "Automatic updates"): every commit in
# the release range that carries a trailer
#   Data-Format-Change: <short reason>
# adds a line "data-format-change: <reason> (<short commit>)" to the notes.
# The Pi updater (deploy/linux/shadow-core-update.sh, DATA_FORMAT_MARKER)
# looks for "data-format-change" (any case) in the notes and never installs
# such a release, nor a later one, by itself. Without such a trailer the notes
# never contain that word.
#
# Release range: the commits since the newest core-v* tag reachable from
# <commit> (that tag excluded; merged branches included), so a marked commit
# that was pushed together with others, or whose own run did not publish, is
# still found. Without such a tag (the first release, or a shallow clone):
# <commit> alone, with a warning.
#
# Tests: .github/scripts/tests/core-release-notes.test.sh.

set -euo pipefail
export LC_ALL=C

die() { printf 'core-release-notes: error: %s\n' "$*" >&2; exit 1; }

[[ $# -eq 4 ]] || die "usage: core-release-notes.sh <version> <commit> <package file> <key fingerprint>"
version="$1" commit="$2" pkg="$3" fingerprint="$4"
[[ "$version" =~ ^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$ ]] || die "unexpected version '$version'"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die "commit must be a full SHA-1, got '$commit'"
git rev-parse -q --verify "$commit^{commit}" >/dev/null || die "commit $commit is not in this clone"

# The release range as git log arguments.
if [[ "$(git rev-parse --is-shallow-repository)" == true ]]; then
  echo "::warning::shallow clone: only the release commit is checked for a Data-Format-Change trailer (fetch-depth: 0 is needed)" >&2
  range=(-n 1 "$commit")
elif prev="$(git describe --tags --abbrev=0 --match 'core-v*' "$commit" 2>/dev/null)"; then
  range=("$prev..$commit")
else
  echo "::warning::no earlier core-v* tag: only the release commit is checked for a Data-Format-Change trailer" >&2
  range=(-n 1 "$commit")
fi

# One line per commit: "<sha>\t<values>", values split by %x1f (unfold: a
# value continued on the next line comes as one line). git matches the
# trailer key case-insensitively, only in the commit's trailer block (the
# last paragraph, with Co-Authored-By).
markers=()
while IFS=$'\t' read -r sha values; do
  [[ -n "$values" ]] || continue
  while IFS= read -r -d $'\x1f' value || [[ -n "$value" ]]; do
    # One plain line: control characters out, spaces collapsed.
    value="$(printf '%s' "$value" | tr -d '\000-\010\013-\037\177' | tr '\t\r\n' '   ' | tr -s ' ')"
    value="${value# }"; value="${value% }"
    [[ -n "$value" ]] || value="(no reason given)"
    markers+=("data-format-change: $value (${sha:0:12})")
  done <<<"$values"
done < <(git log --no-show-signature --format='%H%x09%(trailers:key=Data-Format-Change,valueonly,unfold,separator=%x1f)' "${range[@]}" --)

echo "Shadow Assistant Core $version for the Pi (linux-arm64, Node 24)."
echo
if [[ ${#markers[@]} -gt 0 ]]; then
  echo "**Data format change.** This release changes the format of the data folder: the Pi's automatic updater does not install it (or any later release) by itself. Back up, then install it by hand (docs/05 §7 \"Automatic updates\")."
  echo
  printf -- '- %s\n' "${markers[@]}"
  echo
fi
echo "- Version: \`$version\` (reported by \`GET /health\`)"
echo "- Commit: \`$commit\`"
echo "- Package: \`$pkg\` (install: \`install-core.sh install --user <user> --release $pkg\`, docs/05 §7)"
echo "- Signing key: ECDSA P-256, SHA-256 of the DER public key \`$fingerprint\`"
echo
echo "Verify (needs the public key \`deploy/linux/core-release.pub\` from the repository):"
echo
echo '```sh'
echo "openssl dgst -sha256 -verify core-release.pub -signature SHA256SUMS.sig SHA256SUMS"
echo "sha256sum -c SHA256SUMS"
echo '```'
