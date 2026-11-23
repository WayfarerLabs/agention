#!/usr/bin/env bash

# ============================================================================
# check-release-tag.test.sh: fixture tests for scripts/check-release-tag.sh.
#
# Each case copies the check, both release-please configurations and every
# file they write a version into from this checkout into a throwaway
# directory, sets both lines to versions of the case's own, changes one place
# where the case needs a mismatch, and asserts whether each tag passes.
#
# Usage:
#   ./scripts/check-release-tag.test.sh
#
# Exit codes: 0 every case behaved as expected, 1 otherwise.
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASSED=0
FAILED=0

# set_json <file> <jsonpath key...> <value>: write a JSON string at a key path.
set_json() {
    node - "$@" <<'EOF'
const fs = require("node:fs");
const [file, ...rest] = process.argv.slice(2);
const value = rest.pop();
const data = JSON.parse(fs.readFileSync(file, "utf8"));
const parent = rest.slice(0, -1).reduce((node, key) => node[key], data);
parent[rest.at(-1)] = value;
fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
EOF
}

# new_tree <name>: a copy of what the check reads, with the server line at
# 1.2.0 and the agent line at 2.4.0 everywhere their releases write them.
new_tree() {
    local tree="$WORK/$1" file
    mkdir -p "$tree/scripts"
    cp "$SCRIPT_DIR/check-release-tag.sh" "$SCRIPT_DIR/_common.sh" "$tree/scripts/"
    while IFS= read -r file; do
        mkdir -p "$tree/$(dirname "$file")"
        cp "$REPO_ROOT/$file" "$tree/$file"
    done < <(cd "$REPO_ROOT" && node -e '
        const configs = ["release-please-config.json", "release-please-config.agent.json"];
        const files = new Set([...configs, ".release-please-manifest.json",
            ".release-please-manifest.agent.json", "package.json", "package-lock.json"]);
        for (const config of configs) {
            for (const extra of require(`./${config}`).packages["."]["extra-files"]) {
                files.add(extra.path);
            }
        }
        console.log([...files].join("\n"));')
    (
        cd "$tree"
        set_json .release-please-manifest.json . 1.2.0
        set_json package.json version 1.2.0
        set_json package-lock.json version 1.2.0
        set_json package-lock.json packages "" version 1.2.0
        set_json apps/server/package.json version 1.2.0
        set_json package-lock.json packages apps/server version 1.2.0
        set_json .release-please-manifest.agent.json . 2.4.0
        set_json apps/bridge/package.json version 2.4.0
        set_json package-lock.json packages apps/bridge version 2.4.0
        set_json apps/agent-plugin/plugin.json version 2.4.0
        for host in claude codex; do
            set_json "out/$host-plugin/.$host-plugin/plugin.json" version 2.4.0
            set_json "out/$host-plugin/.mcp.json" mcpServers agention args 1 @wayfarerlabs/agention-mcp@2.4.0
        done
    )
    echo "$tree"
}

# expect <pass|fail> <description> <tree> <tag>
expect() {
    local want="$1" what="$2" tree="$3" tag="$4" got
    if "$tree/scripts/check-release-tag.sh" "$tag" >"$WORK/out" 2>&1; then got=pass; else got=fail; fi
    if [[ "$got" == "$want" ]]; then
        PASSED=$((PASSED + 1))
        echo "  ok: $what ($want)"
    else
        FAILED=$((FAILED + 1))
        echo "  FAIL: $what (expected $want, got $got)" >&2
        sed 's/^/      /' "$WORK/out" >&2
    fi
}

echo "=== each line's own tag ==="

tree="$(new_tree matching)"
expect pass "the server line's tag at its version" "$tree" agention-v1.2.0
expect pass "the agent line's tag at its version" "$tree" agention-mcp-v2.4.0
expect fail "the server line's tag at the agent line's version" "$tree" agention-v2.4.0
expect fail "the agent line's tag at the server line's version" "$tree" agention-mcp-v1.2.0
expect fail "a legacy v tag, which names no line" "$tree" v1.2.0
expect fail "a tag that does not end in a version" "$tree" agention-v1.2

echo "=== one place out of step ==="

tree="$(new_tree server-package)"
set_json "$tree/apps/server/package.json" version 1.2.1
expect fail "the server's package.json behind its tag" "$tree" agention-v1.2.0
expect pass "the agent line, which does not write it" "$tree" agention-mcp-v2.4.0

tree="$(new_tree root-package)"
set_json "$tree/package.json" version 2.4.0
expect fail "the root package.json, which the server line's release type writes" "$tree" agention-v1.2.0
expect pass "the agent line, whose release type writes no package.json" "$tree" agention-mcp-v2.4.0

tree="$(new_tree plugin-spec)"
set_json "$tree/out/codex-plugin/.mcp.json" mcpServers agention args 1 @wayfarerlabs/agention-mcp@2.3.0
expect fail "a generated plugin pinning another bridge" "$tree" agention-mcp-v2.4.0
expect pass "the server line, which does not write it" "$tree" agention-v1.2.0

tree="$(new_tree agent-manifest)"
set_json "$tree/.release-please-manifest.agent.json" . 2.5.0
expect fail "the agent line's manifest ahead of its tag" "$tree" agention-mcp-v2.4.0

echo ""
echo "check-release-tag.test.sh: $PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]]
