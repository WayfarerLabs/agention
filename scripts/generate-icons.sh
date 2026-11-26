#!/usr/bin/env bash

# ============================================================================
# generate-icons.sh: redraw the web UI's app icons.
#
# Writes apps/web/public/icons/ from the SVG sources apps/web/generate-icons.ts
# names, in the browser tests' Chromium shell. Run it when a source changes,
# then commit the images with the change. Needs the shell installed
# (npx playwright install --only-shell chromium).
# ============================================================================

set -euo pipefail

usage="Usage: scripts/generate-icons.sh"
case "$#:${1:-}" in
    0:) ;;
    1:-h | 1:--help) echo "$usage" && exit 0 ;;
    *) echo "$usage" >&2 && exit 2 ;;
esac

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
require_command node "Install the version in .node-version."
require_npm_tools

cd "$REPO_ROOT/apps/web"
node generate-icons.ts
