#!/usr/bin/env bash

# ============================================================================
# generate-api-docs.sh: write the API's OpenAPI document from the server's
# operation declarations.
#
# Writes docs/api/openapi.json, the document agention serve --api-docs serves.
# Run it after changing an operation or a schema it uses, then commit the
# document with the change; the server's tests fail while the committed
# document differs from what generation would write.
# ============================================================================

set -euo pipefail

usage="Usage: scripts/generate-api-docs.sh"
case "$#:${1:-}" in
    0:) ;;
    1:-h | 1:--help) echo "$usage" && exit 0 ;;
    *) echo "$usage" >&2 && exit 2 ;;
esac

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
require_command node "Install the version in .node-version."
require_npm_tools

# Node runs the server's TypeScript directly; the API contract it imports
# needs the locked npm dependencies.
mkdir -p "$REPO_ROOT/docs/api"
node "$REPO_ROOT/apps/server/generate-api-docs.ts" "$REPO_ROOT/docs/api/openapi.json"
