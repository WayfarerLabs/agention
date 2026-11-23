#!/usr/bin/env bash

# ============================================================================
# check-server-compatibility.test.sh: fixture tests for the releases
# scripts/check-server-compatibility.sh selects.
#
# Each case builds a throwaway git repository holding a copy of the gate,
# commits agent API contracts on it, tags commits as the server line would,
# and runs the gate's --list there, which reads only the tags, so no case
# needs the network or the repository's own tags.
#
# Usage:
#   ./scripts/check-server-compatibility.test.sh
#
# Exit codes: 0 every case behaved as expected, 1 otherwise.
# ============================================================================

set -euo pipefail

# Fixtures commit with the repository-local settings below alone, so a
# contributor's signing, hooks or other global git settings never apply.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASSED=0
FAILED=0

# new_repo <name>: a fixture repository whose first commit holds the gate
# and no agent API contract, as a release before 0.3.0 does.
new_repo() {
    local repo="$WORK/$1"
    git -c init.defaultBranch=main init -q "$repo"
    git -C "$repo" config user.name fixture
    git -C "$repo" config user.email fixture@example.invalid
    mkdir -p "$repo/scripts" "$repo/packages/api/src"
    cp "$SCRIPT_DIR/check-server-compatibility.sh" "$SCRIPT_DIR/_common.sh" "$repo/scripts/"
    git -C "$repo" add -A
    git -C "$repo" commit -q -m base
    echo "$repo"
}

# contract <repo> <version>: commit an agent API contract.
contract() {
    printf 'export const agentApi = { version: %s, oldest: 1 } as const;\n' "$2" \
        >"$1/packages/api/src/agent-api.ts"
    git -C "$1" add -A
    git -C "$1" commit -q -m "agent API $2"
}

# expect <description> <repo> <fail | the lines --list prints>
expect() {
    local what="$1" repo="$2" want="$3" got
    if got="$(cd "$repo" && scripts/check-server-compatibility.sh --list 2>"$WORK/err")"; then
        :
    else
        got=fail
    fi
    if [[ "$got" == "$want" ]]; then
        PASSED=$((PASSED + 1))
        echo "  ok: $what"
    else
        FAILED=$((FAILED + 1))
        echo "  FAIL: $what (expected '$want', got '$got')" >&2
        sed 's/^/      /' "$WORK/err" >&2
    fi
}

echo "=== selection ==="

repo="$(new_repo releases)"
git -C "$repo" tag agention-v0.1.0
git -C "$repo" tag agention-v0.2.0
contract "$repo" 2
git -C "$repo" tag agention-v0.3.0
git -C "$repo" tag agention-v0.4.0
contract "$repo" 3
git -C "$repo" tag agention-v0.5.0
expect "the newest of each older version, a release stating none among them" "$repo" \
    "$(printf '0.4.0 2\n0.2.0 none')"
git -C "$repo" tag agention-v0.4.1-rc.1 agention-v0.4.0
expect "a prerelease is skipped" "$repo" "$(printf '0.4.0 2\n0.2.0 none')"

echo "=== failures ==="

repo="$(new_repo current)"
contract "$repo" 3
git -C "$repo" tag agention-v0.6.0
expect "no older release reachable fails" "$repo" fail

repo="$(new_repo reformatted)"
printf 'export const agentApi = {\n  version: 2,\n  oldest: 1,\n} as const;\n' \
    >"$repo/packages/api/src/agent-api.ts"
git -C "$repo" add -A
git -C "$repo" commit -q -m "agent API reformatted"
git -C "$repo" tag agention-v0.3.0
contract "$repo" 3
expect "a release's agentApi written another way fails rather than reading as none" "$repo" fail

echo ""
echo "check-server-compatibility.test.sh: $PASSED passed, $FAILED failed"
[[ $FAILED -eq 0 ]]
