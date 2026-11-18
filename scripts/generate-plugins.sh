#!/usr/bin/env bash

# ============================================================================
# generate-plugins.sh: render the agent plugins from their canonical source.
#
# Reads apps/agent-plugin/plugin.json and apps/agent-plugin/skills/, and writes
# out/claude-plugin/, out/codex-plugin/, .claude-plugin/marketplace.json and
# .agents/plugins/marketplace.json. Run it after changing the sources or the
# generator, then commit the outputs with the change. With --check it writes
# nothing and fails if the outputs differ from what generation would write.
# With --bridge-package and --out it writes plugins that run a packed bridge
# into a new directory instead, for trying an unreleased bridge on a host.
# ============================================================================

set -euo pipefail

usage="Usage: scripts/generate-plugins.sh [--check]
       scripts/generate-plugins.sh --bridge-package FILE --out DIR"
case "$#:${1:-}" in
    0: | 1:--check | 4:--bridge-package | 4:--out) ;;
    1:-h | 1:--help) echo "$usage" && exit 0 ;;
    *) echo "$usage" >&2 && exit 2 ;;
esac

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
require_command node "Install the version in .node-version."

# The generator is TypeScript that Node runs directly, so it needs no install.
# It runs from the caller's directory, so relative paths given to it resolve
# there.
node "$REPO_ROOT/apps/agent-plugin/gen/main.ts" --root "$REPO_ROOT" "$@"
