#!/usr/bin/env bash

# ============================================================================
# check.sh: every gate CI requires, in the order CI runs them.
#
# CI runs this script, so a local pass means the same checks pass in CI.
# Prerequisites: Node at the version in .node-version, with the npm it
# bundles, and network access for the install, signature and vulnerability
# checks. The first gate installs the locked dependencies with `npm ci`.
# --fast skips the web production build.
# ============================================================================

set -euo pipefail

usage="Usage: scripts/check.sh [--fast]"
fast=0
case "$#:${1:-}" in
    0:) ;;
    1:--fast) fast=1 ;;
    1:-h | 1:--help) echo "$usage" && exit 0 ;;
    *) echo "$usage" >&2 && exit 2 ;;
esac

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
require_command node "Install the version in .node-version."
require_command npm "Install Node at the version in .node-version, which bundles npm."

cd "$REPO_ROOT"

step() {
    echo ""
    echo "=== $* ==="
}

# CI always runs the pinned version; locally a mismatch is worth knowing about.
node_pin="$(read_pin .node-version)"
if [[ "$(node --version)" != "v$node_pin" ]]; then
    echo "Warning: Node is $(node --version) but .node-version pins $node_pin." >&2
fi

step "Dependency integrity"
# --ignore-scripts on the command line also overrides an npm_config_*
# environment variable, which would otherwise take precedence over .npmrc.
# The audit runs as its own gate below.
npm ci --ignore-scripts --no-audit --no-fund
npm audit signatures

step "Format and lint"
scripts/lint-files.sh

step "Types"
npm run --workspaces typecheck

step "Tests"
npm run --workspaces test

step "Vulnerabilities"
npm audit --audit-level=high

if [[ $fast -eq 0 ]]; then
    step "Build"
    npm run --silent --workspace apps/web build
fi

echo ""
echo "All checks passed."
