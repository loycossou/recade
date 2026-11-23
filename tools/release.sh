#!/usr/bin/env bash
# Publish the main branch of this repository to its release repository, in one command that stops at the first check
# that fails. Without --push it prepares and checks the release commit and stops before anything leaves the machine.
#
#   tools/release.sh <release-dir> -m "<commit message>" [--push]
#
# The checks, in order:
#   1. this repository is on main, with no change to a tracked file;
#   2. the release repository is on main, with no change at all (another session may be working in it), and not behind
#      its remote;
#   3. a private name list exists: RECADE_PRIVATE_NAMES (comma separated) or the file
#      ${XDG_CONFIG_HOME:-~/.config}/recade/private-names (one name per line), kept outside every repository;
#   4. the release tree is replaced by the tree of main: files deleted from main are deleted from the release too;
#   5. the two trees are identical, blob for blob;
#   6. npm test passes with "# fail 0", the names check passes, and publish-check passes on the tree and the history.
# A check that fails after the commit leaves the commit local, says so and prints how to undo it. Nothing is pushed.
set -euo pipefail

usage() { echo "Usage: tools/release.sh <release-dir> -m \"<commit message>\" [--push]" >&2; exit 2; }
fail() { echo "release: $*" >&2; exit 1; }

REL="" MSG="" PUSH=0
while [ $# -gt 0 ]; do
  case "$1" in
    -m) [ $# -ge 2 ] || usage; MSG="$2"; shift 2 ;;
    --push) PUSH=1; shift ;;
    -*) usage ;;
    *) [ -z "$REL" ] || usage; REL="$1"; shift ;;
  esac
done
[ -n "$REL" ] && [ -n "$MSG" ] || usage

SRC="$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)"
REL="$(cd "$REL" 2>/dev/null && git rev-parse --show-toplevel)" || fail "$REL is not a Git repository."
[ "$SRC" != "$REL" ] || fail "the release repository must not be this repository."

# 1. The source.
[ "$(git -C "$SRC" branch --show-current)" = "main" ] || fail "$SRC is not on main."
[ -z "$(git -C "$SRC" status --porcelain --untracked-files=no)" ] || fail "$SRC has uncommitted changes to tracked files. Commit or drop them first."

# 2. The release repository.
[ "$(git -C "$REL" branch --show-current)" = "main" ] || fail "$REL is not on main."
[ -z "$(git -C "$REL" status --porcelain)" ] || fail "$REL has changes nobody committed. Another session may be working there: look before you touch it."
if git -C "$REL" remote get-url origin >/dev/null 2>&1; then
  git -C "$REL" fetch -q origin main || fail "cannot fetch origin/main in $REL."
  behind="$(git -C "$REL" rev-list --count HEAD..origin/main)"
  [ "$behind" = "0" ] || fail "$REL is $behind commit(s) behind origin/main. Pull first."
fi

# 3. The private names.
NAMES_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/recade/private-names"
if [ -z "${RECADE_PRIVATE_NAMES:-}" ]; then
  [ -s "$NAMES_FILE" ] || fail "no private name list. Set RECADE_PRIVATE_NAMES or write $NAMES_FILE, one name per line."
  RECADE_PRIVATE_NAMES="$(grep -v '^[[:space:]]*\(#\|$\)' "$NAMES_FILE" | paste -sd, -)"
fi
[ -n "$RECADE_PRIVATE_NAMES" ] || fail "the private name list is empty."
export RECADE_PRIVATE_NAMES

# 4. Replace the release tree by the tree of main.
git -C "$REL" ls-files -z | (cd "$REL" && xargs -0 -r rm -f --)
git -C "$SRC" archive main | tar -x -C "$REL"
git -C "$REL" add -A

# 5. The trees must match.
tree() { git -C "$1" ls-tree -r "$2" | awk '{print $3, $4}'; }
if ! diff <(tree "$REL" "$(git -C "$REL" write-tree)") <(tree "$SRC" main) >/dev/null; then
  fail "the release tree differs from main after the copy. Nothing was committed; run git -C \"$REL\" reset --hard to drop the copy."
fi

if git -C "$REL" diff --cached --quiet; then
  echo "release: main has nothing new for the release repository."
  COMMITTED=0
else
  # 6a. Tests and checks on the copy, before the commit. A new or changed dependency is installed first, as the
  # installed plugin gets it from this folder.
  LOG="$(mktemp)"
  if [ -f "$REL/package-lock.json" ] && { [ ! -d "$REL/node_modules" ] || ! git -C "$REL" diff --cached --quiet -- package-lock.json; }; then
    if ! (cd "$REL" && npm ci --no-audit --no-fund >"$LOG" 2>&1); then
      fail "npm ci failed in $REL (full log: $LOG). Nothing was committed; run git -C \"$REL\" reset --hard to drop the copy."
    fi
    echo "release: dependencies installed with npm ci."
  fi
  if ! (cd "$REL" && npm test >"$LOG" 2>&1) || ! grep -q '^# fail 0' "$LOG"; then
    grep -E '^# (pass|fail)|^not ok' "$LOG" | head -20 >&2 || true
    fail "npm test failed in $REL (full log: $LOG). Nothing was committed; run git -C \"$REL\" reset --hard to drop the copy."
  fi
  echo "release: $(grep -E '^# pass' "$LOG")"
  (cd "$REL" && node bin/recade.js guard-names) || fail "the names check failed. Nothing was committed; run git -C \"$REL\" reset --hard to drop the copy."
  git -C "$REL" commit -q -m "$MSG"
  COMMITTED=1
fi

# 6b. publish-check on the tree and on the whole history, after the commit so the new commit is part of it.
if ! (cd "$REL" && node tools/publish-check.js --require-names --history); then
  [ "$COMMITTED" = "1" ] && fail "publish-check failed. The release commit is local only; undo it with git -C \"$REL\" reset --hard HEAD~1."
  fail "publish-check failed on the history already in $REL."
fi

AHEAD="$(git -C "$REL" rev-list --count '@{upstream}..HEAD' 2>/dev/null || echo 0)"
if [ "$PUSH" = "1" ]; then
  [ "$AHEAD" != "0" ] || { echo "release: nothing to push."; exit 0; }
  RECADE_RELEASE=1 git -C "$REL" push -q origin main
  echo "release: pushed $(git -C "$REL" rev-parse --short HEAD) to $(git -C "$REL" remote get-url origin)."
  echo "release: follow the CI with gh run list --commit $(git -C "$REL" rev-parse HEAD)"
else
  echo "release: ready, $AHEAD commit(s) ahead of the remote. Run again with --push to publish."
fi
