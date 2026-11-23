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
require_npm_tools

cd "$REPO_ROOT"

server_package=@wayfarerlabs/agention
contract=packages/api/src/agent-api.ts

fail() {
    echo "check-release-order.sh: $*" >&2
    exit 1
}

agent_version="$(node -p 'require(process.argv[1])["."]' "$REPO_ROOT/.release-please-manifest.agent.json")"
if [[ -n "$(git tag --list "agention-mcp-v$agent_version")" ]]; then
    echo "agention-mcp-v$agent_version is tagged, so HEAD is no agent line release; nothing to check."
    exit 0
fi

server_tag="$(git tag --list 'agention-v*' --sort=-version:refname | head -n 1)"
if [[ -z "$server_tag" ]]; then
    fail "no agention-v* release tag is fetched; fetch the tags with 'git fetch --tags' and run it again."
fi
server_version="${server_tag#agention-v}"

# Each agentApi is the value the contract's module exports, compiled with the
# repository's esbuild and run with its imports resolved from the contract's
# own directory, so however it is written, the version read is the one built.
read -r head_api server_oldest server_api < <(node - "$REPO_ROOT" "$contract" "$(cat "$contract")" \
    "$(git show "$server_tag:$contract")" <<'EOF' || true
const path = require("node:path");
const { createRequire } = require("node:module");
const [root, contract, head, server] = process.argv.slice(2);
const esbuild = require(path.join(root, "node_modules/esbuild"));
function agentApiOf(source) {
  const { code } = esbuild.transformSync(source, { loader: "ts", format: "cjs" });
  const module = { exports: {} };
  new Function("module", "exports", "require", code)(
    module,
    module.exports,
    createRequire(path.join(root, contract)),
  );
  const { version, oldest } = module.exports.agentApi ?? {};
  if (!Number.isInteger(version) || !Number.isInteger(oldest)) {
    throw new Error("agentApi is not { version, oldest } as integers");
  }
  return { version, oldest };
}
const [ours, theirs] = [agentApiOf(head), agentApiOf(server)];
console.log(ours.version, theirs.oldest, theirs.version);
EOF
)
if [[ -z "${server_api:-}" ]]; then
    fail "could not read agentApi from $contract at HEAD and at $server_tag, as Node says above."
fi

if ((head_api < server_oldest || head_api > server_api)); then
    fail "the agent line's release $agent_version speaks agent API version $head_api, and the newest server release, $server_tag, serves versions $server_oldest to $server_api. Merge the server line's release pull request first, and once the release workflow has published it, run this check again."
fi

if [[ "$(npm view "$server_package@$server_version" version)" != "$server_version" ]]; then
    fail "$server_tag is tagged, but npm does not have $server_package@$server_version, as npm says above; once the release workflow has published it, run this check again."
fi

echo "agention-mcp $agent_version speaks agent API version $head_api, which $server_tag serves and npm has."
