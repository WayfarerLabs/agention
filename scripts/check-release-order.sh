#!/usr/bin/env bash

# ============================================================================
# check-release-order.sh: the release order gate, which keeps the agent
# line's release pull request from merging before a released server serves
# its agent API version, as CONTRIBUTING.md "Releasing" describes.
#
# It acts only when the agent line's version at HEAD has no agention-mcp-v
# tag yet, which holds only on that line's release pull request. It then reads
# the agent API version at HEAD and at the newest agention-v tag by version,
# among every fetched tag, reachable from HEAD or not, and fails unless that
# server serves HEAD's version and npm has that server. A re-run reads the tags
# again, so once the server is released and published, running the check
# again passes. It needs the release tags and network access.
#
# Usage:
#   scripts/check-release-order.sh
#
# Exit codes: 0 nothing to check or the order holds, 1 otherwise.
# ============================================================================

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
require_command git "Install Git."
require_command node "Install the version in .node-version."
require_command npm "Install Node at the version in .node-version, which bundles npm."

cd "$REPO_ROOT"

server_package=@wayfarerlabs/agention
manifest=.release-please-manifest.agent.json
contract=packages/api/src/agent-api.ts

fail() {
    echo "check-release-order.sh: $*" >&2
    exit 1
}

agent_version="$(node -p 'require(process.argv[1])["."] ?? ""' "$REPO_ROOT/$manifest")"
if [[ -z "$agent_version" ]]; then
    fail "$manifest has no version under the key \".\", the agent line's root package."
fi
if [[ -n "$(git tag --list "agention-mcp-v$agent_version")" ]]; then
    echo "agention-mcp-v$agent_version is tagged, so HEAD is no agent line release; nothing to check."
    exit 0
fi

# versionsort.suffix sorts a prerelease, such as 1.0.0-rc.1, below its release.
server_tag="$(git -c versionsort.suffix=- tag --list 'agention-v*' --sort=-v:refname | sed -n 1p)"
if [[ -z "$server_tag" ]]; then
    fail "no agention-v* release tag is fetched; fetch the tags with 'git fetch --tags' and run it again."
fi
server_version="${server_tag#agention-v}"

# agentApi_of prints the version and oldest of the one line that declares
# agentApi, written as the contract writes it; a line written any other way
# prints nothing, which fails below rather than reading a wrong version.
agentApi_of() {
    sed -nE 's/^export const agentApi = \{ version: ([0-9]+), oldest: ([0-9]+) \} as const;$/\1 \2/p'
}
read -r head_api _ < <(agentApi_of <"$contract") || true
read -r server_api server_oldest < <(git show "$server_tag:$contract" | agentApi_of) || true
if [[ -z "${head_api:-}" ]]; then
    fail "could not read agentApi's version from $contract at HEAD."
fi
if [[ -z "${server_api:-}" || -z "${server_oldest:-}" ]]; then
    fail "could not read agentApi's version and oldest from $contract at $server_tag."
fi

if ((head_api < server_oldest || head_api > server_api)); then
    fail "the agent line's release $agent_version speaks agent API version $head_api, and the newest server release, $server_tag, serves versions $server_oldest to $server_api. Merge the server line's release pull request first, and once the release workflow has published it, run this check again."
fi

if [[ "$(npm view "$server_package@$server_version" version)" != "$server_version" ]]; then
    fail "$server_tag is tagged, but npm does not have $server_package@$server_version, as npm says above; once the release workflow has published it, run this check again."
fi

echo "agention-mcp $agent_version speaks agent API version $head_api, which $server_tag serves and npm has."
