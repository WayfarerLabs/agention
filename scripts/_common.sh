#!/usr/bin/env bash

# ============================================================================
# Shared helpers for the repository scripts. Source this file; do not run it.
# ============================================================================

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export REPO_ROOT

# require_command fails with an install hint when a command is missing.
require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Error: $1 is not installed. $2" >&2
        return 1
    fi
}

# require_npm_tools fails unless the locked npm dependencies are installed.
# Tools always run from node_modules, never through a package runner that
# would download a floating version.
require_npm_tools() {
    if [[ ! -x "$REPO_ROOT/node_modules/.bin/prettier" ]]; then
        echo "Error: npm dependencies are not installed. Run: npm ci --ignore-scripts" >&2
        return 1
    fi
}

# read_pin prints the version recorded in a version file.
read_pin() {
    tr -d '[:space:]' <"$REPO_ROOT/$1"
}
