#!/usr/bin/env bash

# ============================================================================
# check-agent-compatibility.sh: the agent compatibility gate, every released
# bridge against the agent routes at HEAD, as CONTRIBUTING.md "The agent API"
# describes. It needs the release tags and network access.
# ============================================================================

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
require_command git "Install Git."
require_command node "Install the version in .node-version."
require_command npm "Install Node at the version in .node-version, which bundles npm."
require_npm_tools

cd "$REPO_ROOT"

package=@wayfarerlabs/agention-mcp

# The v* tags reachable from HEAD, apart from those on HEAD itself.
tags=()
while IFS= read -r tag; do
    tags+=("$tag")
done < <(comm -23 <(git tag --list 'v*' --merged HEAD | sort) <(git tag --list 'v*' --points-at HEAD | sort))
if [[ ${#tags[@]} -eq 0 ]]; then
    echo "check-agent-compatibility.sh: no release tag is reachable from HEAD; fetch the tags with 'git fetch --tags' and run it again." >&2
    exit 1
fi

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

for tag in "${tags[@]}"; do
    version="${tag#v}"
    dir="$scratch/bridges/$version"
    mkdir -p "$dir"
    # --prefix keeps the repository's .npmrc out of this install, and
    # --min-release-age=0 turns off a hold-back a user's or the global npmrc
    # may set, so a release is checked as soon as it is published. The package
    # is a bundle that declares no dependencies, so nothing else resolves.
    if ! npm install --loglevel=error --no-progress --prefix "$dir" --ignore-scripts --no-audit \
        --no-fund --min-release-age=0 "$package@$version" >/dev/null; then
        echo "check-agent-compatibility.sh: $tag is tagged, but npm could not install $package@$version, as npm says above; if npm has no such version yet, run the check again once the release workflow publishes it." >&2
        exit 1
    fi
    npm audit signatures --prefix "$dir"
    echo "$tag: $package@$version installed and verified"
done

AGENTION_RELEASED_BRIDGES="$scratch/bridges" npm run --silent --workspace apps/bridge test:compat
