#!/usr/bin/env bash

# ============================================================================
# generate-screenshots.sh: retake the screenshots the READMEs show.
#
# Writes docs/images/, from a server it starts on data of its own and fills
# with the demonstration threads in apps/web/e2e/readme-screenshots.ts. Run it
# when a view the screenshots show changes, then commit the images with the
# change. Needs the server built (npm run -w apps/server build) and the
# browser tests' Chromium shell installed.
# ============================================================================

set -euo pipefail

usage="Usage: scripts/generate-screenshots.sh"
case "$#:${1:-}" in
    0:) ;;
    1:-h | 1:--help) echo "$usage" && exit 0 ;;
    *) echo "$usage" >&2 && exit 2 ;;
esac

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
require_command node "Install the version in .node-version."
require_npm_tools

cd "$REPO_ROOT/apps/web"
"$REPO_ROOT/node_modules/.bin/playwright" test --config playwright.screenshots.config.ts
