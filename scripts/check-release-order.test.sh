#!/usr/bin/env bash

# ============================================================================
# check-release-order.test.sh: fixture tests for scripts/check-release-order.sh.
#
# Each case builds a throwaway git repository holding a copy of the gate, the
# agent line's manifest and an agent API contract, tags commits on it as the
# two release lines would, and runs the gate there with npm replaced by a stub
# that knows only the server versions the case publishes, so no case needs the
# network or the repository's own tags.
#
# Usage:
#   ./scripts/check-release-order.test.sh
#
# Exit codes: 0 every case behaved as expected, 1 otherwise.
# ============================================================================

set -euo pipefail

# Fixtures commit with the repository-local settings below alone, so a
# contributor's signing, hooks or other global git settings never apply.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASSED=0
FAILED=0

# The npm stub answers `npm view <package>@<version> version` for the
# versions in PUBLISHED, and fails as npm does for any other.
mkdir "$WORK/bin"
cat >"$WORK/bin/npm" <<'EOF'
#!/usr/bin/env bash
spec="$2"
for published in $PUBLISHED; do
    if [[ "$1" == view && "$spec" == "@wayfarerlabs/agention@$published" ]]; then
        echo "$published"
        exit 0
    fi
done
echo "npm error 404 No match found for $spec" >&2
exit 1
EOF
chmod +x "$WORK/bin/npm"

# new_repo <name> <agent version>: a fixture repository whose first commit
# holds the gate, the agent line at the version given and agent API version 3.
new_repo() {
    local repo="$WORK/$1"
    git -c init.defaultBranch=main init -q "$repo"
    git -C "$repo" config user.name fixture
    git -C "$repo" config user.email fixture@example.invalid
    mkdir -p "$repo/scripts" "$repo/packages/api/src"
    cp "$SCRIPT_DIR/check-release-order.sh" "$SCRIPT_DIR/_common.sh" "$repo/scripts/"
    ln -s "$REPO_ROOT/node_modules" "$repo/node_modules"
    printf 'node_modules\n' >"$repo/.gitignore"
    printf '{ ".": "%s" }\n' "$2" >"$repo/.release-please-manifest.agent.json"
    contract "$repo" 3 1
    git -C "$repo" add -A
    git -C "$repo" commit -q -m base
    echo "$repo"
}

# contract <repo> <version> <oldest>: commit an agent API contract.
contract() {
    printf 'export const agentApi = { version: %s, oldest: %s } as const;\n' "$2" "$3" \
        >"$1/packages/api/src/agent-api.ts"
    if git -C "$1" rev-parse -q --verify HEAD >/dev/null; then
        git -C "$1" commit -q -am "agent API $2"
    fi
}

# expect <pass|fail> <description> <repo> [published server versions]
expect() {
    local want="$1" what="$2" repo="$3" published="${4:-}" got
    if (cd "$repo" && PATH="$WORK/bin:$PATH" PUBLISHED="$published" scripts/check-release-order.sh) \
        >"$WORK/out" 2>&1; then
        got=pass
    else
        got=fail
    fi
    if [[ "$got" == "$want" ]]; then
        PASSED=$((PASSED + 1))
        echo "  ok: $what ($want)"
    else
        FAILED=$((FAILED + 1))
        echo "  FAIL: $what (expected $want, got $got)" >&2
        sed 's/^/      /' "$WORK/out" >&2
    fi
}

echo "=== no agent line release ==="

repo="$(new_repo tagged 0.6.0)"
git -C "$repo" tag agention-mcp-v0.6.0
contract "$repo" 4 1
expect pass "an agent line version already tagged is no release, whatever the servers" "$repo"

echo "=== an agent line release ==="

repo="$(new_repo served 0.7.0)"
git -C "$repo" tag agention-mcp-v0.6.0
git -C "$repo" tag agention-v0.6.0
expect pass "the newest server serves the version and npm has it" "$repo" "0.6.0"
expect fail "the newest server serves the version but npm does not have it yet" "$repo"

repo="$(new_repo unserved 0.7.0)"
git -C "$repo" tag agention-v0.6.0
contract "$repo" 4 1
expect fail "the newest server speaks an older agent API version" "$repo" "0.6.0"
git -C "$repo" tag agention-v0.7.0
expect pass "a server release at the new version, once published, lets it pass" "$repo" "0.6.0 0.7.0"

repo="$(new_repo oldest 0.7.0)"
contract "$repo" 4 4
git -C "$repo" tag agention-v0.7.0
contract "$repo" 3 1
expect fail "the newest server no longer serves the version" "$repo" "0.7.0"

repo="$(new_repo by-version 0.10.0)"
contract "$repo" 2 1
git -C "$repo" tag agention-v0.10.0
git -C "$repo" checkout -q -b older HEAD~1
git -C "$repo" tag agention-v0.9.0
git -C "$repo" checkout -q main
contract "$repo" 3 1
expect fail "the newest server by version, not by name or date, is the one read" "$repo" "0.9.0 0.10.0"

repo="$(new_repo unreachable 0.7.0)"
git -C "$repo" checkout -q -b server
contract "$repo" 4 1
git -C "$repo" tag agention-v0.8.0
git -C "$repo" checkout -q main
contract "$repo" 4 1
expect pass "a server tag HEAD does not reach counts, as on a re-run of an older merge" "$repo" "0.8.0"

repo="$(new_repo legacy 0.7.0)"
git -C "$repo" tag v0.6.0
expect fail "a legacy v tag is no server release, and none is fetched" "$repo" "0.6.0"

echo ""
echo "check-release-order.test.sh: $PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]]
