#!/usr/bin/env bash

# ============================================================================
# lint-files.sh: formatting, Markdown structure and spelling checks.
#
# Runs Prettier, markdownlint-cli2 and cspell. The tools run from node_modules
# at the versions locked in package-lock.json, so install them first with
# `npm ci --ignore-scripts`. With --fix it first applies what the tools can
# fix; cspell cannot fix anything, so correct the spelling or add the word to
# .cspell.json.
# ============================================================================

# Deliberately no `set -e`: every checker runs so one pass shows every
# problem, and failures are collected in $fail.
set -uo pipefail

usage="Usage: scripts/lint-files.sh [--fix]"
fix=0
case "$#:${1:-}" in
    0:) ;;
    1:--fix) fix=1 ;;
    1:-h | 1:--help) echo "$usage" && exit 0 ;;
    *) echo "$usage" >&2 && exit 2 ;;
esac

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
require_npm_tools || exit 1

cd "$REPO_ROOT" || exit 1
bin="$REPO_ROOT/node_modules/.bin"
prettier_globs=('**/*.md' '**/*.json' '**/*.jsonc' '**/*.yml' '**/*.yaml' '**/*.ts' '**/*.tsx' '**/*.html' '**/*.css')
cspell_globs=('**/*.md' '**/*.ts' '**/*.tsx' '**/*.html' '**/*.css' '**/*.sh' '**/*.yml' '**/*.yaml')

if [[ $fix -eq 1 ]]; then
    echo "--- prettier --write ---"
    "$bin/prettier" --write --log-level warn --no-error-on-unmatched-pattern "${prettier_globs[@]}"
    echo "--- markdownlint-cli2 --fix ---"
    # Unfixable findings make this exit non-zero; the check pass reports them.
    "$bin/markdownlint-cli2" --fix '**/*.md' >/dev/null || true
fi

fail=0

echo "=== prettier ==="
if "$bin/prettier" --check --log-level warn --no-error-on-unmatched-pattern "${prettier_globs[@]}"; then
    echo "  ok"
else
    fail=1
fi

echo "=== markdownlint-cli2 ==="
if "$bin/markdownlint-cli2" '**/*.md'; then
    echo "  ok"
else
    fail=1
fi

echo "=== cspell ==="
if "$bin/cspell" --no-progress --no-summary --dot "${cspell_globs[@]}"; then
    echo "  ok"
else
    echo "  Correct the spelling or add the word to .cspell.json."
    fail=1
fi

if [[ $fail -ne 0 ]]; then
    echo "One or more file checks failed."
    exit 1
fi
echo "All file checks passed."
