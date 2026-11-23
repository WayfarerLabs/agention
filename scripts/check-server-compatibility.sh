#!/usr/bin/env bash

# ============================================================================
# check-server-compatibility.sh: the server compatibility gate, the bridge at
# HEAD against the newest released server of each agent API version older
# than its own, as CONTRIBUTING.md "The agent API" describes. A release
# stating no version, as every one before 0.3.0 does, counts as one version
# older than any other. It needs the server line's release tags and, but for
# --list, network access.
#
# Usage:
#   scripts/check-server-compatibility.sh [--list]
#
# --list prints the releases it would check, one "<version> <agent API
# version or none>" a line, and stops before installing them.
#
# Exit codes: 0 every release refused the bridge as it should, 1 otherwise,
# 2 usage.
# ============================================================================

set -euo pipefail

usage="Usage: scripts/check-server-compatibility.sh [--list]"
list=0
case "$#:${1:-}" in
    0:) ;;
    1:--list) list=1 ;;
    1:-h | 1:--help) echo "$usage" && exit 0 ;;
    *) echo "$usage" >&2 && exit 2 ;;
esac

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
require_command git "Install Git."

cd "$REPO_ROOT"

package=@wayfarerlabs/agention
prefix=agention-v
contract=packages/api/src/agent-api.ts

fail() {
    echo "check-server-compatibility.sh: $*" >&2
    exit 1
}

read -r head_api _ < <(agent_api_of <"$contract") || true
if [[ -z "${head_api:-}" ]]; then
    fail "could not read agentApi's version from $contract at HEAD."
fi

# The server line's releases reachable from HEAD, newest first by version,
# prereleases skipped. The first met at each agent API version older than
# HEAD's is that version's newest. A release without the contract states no
# version, as releases before it was added do.
servers=()
taken=" "
while IFS= read -r tag; do
    version="${tag#"$prefix"}"
    if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
        continue
    fi
    api=""
    if git cat-file -e "$tag:$contract" 2>/dev/null; then
        read -r api _ < <(git show "$tag:$contract" | agent_api_of) || true
        if [[ -z "$api" ]]; then
            fail "could not read agentApi's version from $contract at $tag."
        fi
        if ((api >= head_api)); then
            continue
        fi
    else
        api=none
    fi
    if [[ "$taken" != *" $api "* ]]; then
        taken+="$api "
        servers+=("$version $api")
    fi
done < <(git tag --list "$prefix*" --merged HEAD --sort=-v:refname)

if [[ ${#servers[@]} -eq 0 ]]; then
    fail "no server release older than agent API version $head_api is reachable from HEAD, though releases before 0.3.0 state none; fetch the tags with 'git fetch --tags' and run it again."
fi

if ((list)); then
    printf '%s\n' "${servers[@]}"
    exit 0
fi

require_command node "Install the version in .node-version."
require_command npm "Install Node at the version in .node-version, which bundles npm."
require_npm_tools

scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT

for server in "${servers[@]}"; do
    read -r version api <<<"$server"
    dir="$scratch/servers/$version"
    mkdir -p "$dir"
    # As in check-agent-compatibility.sh: --prefix keeps the repository's
    # .npmrc out of this install, and --min-release-age=0 turns off a
    # hold-back a user's or the global npmrc may set. The package is a bundle
    # that declares no dependencies, so nothing else resolves.
    if ! npm install --loglevel=error --no-progress --prefix "$dir" --ignore-scripts --no-audit \
        --no-fund --min-release-age=0 "$package@$version" >/dev/null; then
        echo "check-server-compatibility.sh: $prefix$version is tagged, but npm could not install $package@$version, as npm says above." >&2
        exit 1
    fi
    npm audit signatures --prefix "$dir"
    # What the release states, for the suite.
    echo "$api" >"$dir/agent-api"
    echo "$prefix$version: $package@$version installed and verified; it states agent API version $api"
done

AGENTION_RELEASED_SERVERS="$scratch/servers" npm run --silent --workspace apps/bridge test:server-compat
