#!/usr/bin/env bash

# ============================================================================
# check-sdd.test.sh: fixture tests for scripts/check-sdd.sh.
#
# Each case builds a throwaway git repository in a temporary directory, commits
# a base state on main, commits a change on a branch, runs the real
# check-sdd.sh from inside that repository, and asserts whether it passes.
#
# Usage:
#   ./scripts/check-sdd.test.sh
#
# Exit codes: 0 every case behaved as expected, 1 otherwise.
# ============================================================================

set -euo pipefail

# Fixtures commit with the repository-local settings below alone, so a
# contributor's signing, hooks or other global git settings never apply.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$SCRIPT_DIR/check-sdd.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PASSED=0
FAILED=0
SPEC="docs/sdd/2026-01-01-thing"

PLAN_BASE='# Plan

- [x] First completed item.
- [x] Second completed item that wraps onto a
      continuation line.
- [ ] Open item.
'

# new_repo <name>: create a fixture repository with the base plan on main.
new_repo() {
    local repo="$WORK/$1"
    git -c init.defaultBranch=main init -q "$repo"
    git -C "$repo" config user.name fixture
    git -C "$repo" config user.email fixture@example.invalid
    mkdir -p "$repo/$SPEC"
    printf '%s' "$PLAN_BASE" >"$repo/$SPEC/plan.md"
    printf '# FRD\n' >"$repo/$SPEC/frd.md"
    git -C "$repo" add -A
    git -C "$repo" commit -q -m base
    echo "$repo"
}

commit_all() {
    git -C "$1" add -A
    git -C "$1" commit -q --allow-empty -m "$2"
}

# expect <pass|fail> <description> <repo> [base]
expect() {
    local want="$1" what="$2" repo="$3" base="${4:-main}" got
    if (cd "$repo" && "$CHECK" "$base") >"$WORK/out" 2>&1; then got=pass; else got=fail; fi
    if [[ "$got" == "$want" ]]; then
        PASSED=$((PASSED + 1))
        echo "  ok: $what ($want)"
    else
        FAILED=$((FAILED + 1))
        echo "  FAIL: $what (expected $want, got $got)" >&2
        sed 's/^/      /' "$WORK/out" >&2
    fi
}

# branch_repo <name>: a fixture repository already on a work branch.
branch_repo() {
    local repo
    repo="$(new_repo "$1")"
    git -C "$repo" checkout -q -b work
    echo "$repo"
}

echo "=== completed checkboxes ==="

r="$(branch_repo no-change)"
expect pass "no SDD change" "$r"

r="$(branch_repo additive)"
cat >"$r/$SPEC/plan.md" <<'EOF'
# Plan

- [x] First completed item.
- [x] Second completed item that wraps onto a continuation line.
- [x] Open item, now done.
- [ ] A new open item.
EOF
commit_all "$r" "check a box, add a box, re-wrap a completed box"
expect pass "checking, adding, and re-wrapping boxes" "$r"

r="$(branch_repo edit-completed)"
sed -i.bak 's/First completed item./First completed item, reworded./' "$r/$SPEC/plan.md" && rm "$r/$SPEC/plan.md.bak"
commit_all "$r" "edit a completed box"
expect fail "editing a completed checkbox" "$r"

r="$(branch_repo edit-continuation)"
sed -i.bak 's/continuation line./continuation line, reworded./' "$r/$SPEC/plan.md" && rm "$r/$SPEC/plan.md.bak"
commit_all "$r" "edit a completed box's continuation"
expect fail "editing a completed checkbox's continuation line" "$r"

r="$(branch_repo uncheck)"
sed -i.bak 's/- \[x\] First/- [ ] First/' "$r/$SPEC/plan.md" && rm "$r/$SPEC/plan.md.bak"
commit_all "$r" "uncheck a completed box"
expect fail "unchecking a completed checkbox" "$r"

r="$(branch_repo reorder)"
cat >"$r/$SPEC/plan.md" <<'EOF'
# Plan

- [x] Second completed item that wraps onto a
      continuation line.
- [x] First completed item.
- [ ] Open item.
EOF
commit_all "$r" "reorder completed boxes"
expect fail "moving a completed checkbox" "$r"

r="$(branch_repo shallower-line)"
git -C "$r" checkout -q main
cat >"$r/$SPEC/plan.md" <<'EOF'
# Plan

- [x] First completed item.
Lazy text at the item's own indent is not part of it.
- [x] Second completed item that wraps onto a
      continuation line.
- [ ] Open item.
EOF
commit_all "$r" "base with lazy text"
git -C "$r" checkout -q work
git -C "$r" rebase -q main
sed -i.bak 's/not part of it\./not part of it, edited./' "$r/$SPEC/plan.md" && rm "$r/$SPEC/plan.md.bak"
commit_all "$r" "edit text that is not indented under the item"
expect pass "editing a line that is not indented deeper than a completed item" "$r"

r="$(branch_repo delete-plan)"
git -C "$r" rm -q "$SPEC/plan.md"
commit_all "$r" "delete the plan"
expect fail "deleting a plan with completed checkboxes" "$r"

echo "=== locks ==="

# locked_repo <name>: base on main includes locked.md; returns a work branch.
locked_repo() {
    local repo
    repo="$(new_repo "$1")"
    printf '# Locked\n' >"$repo/$SPEC/locked.md"
    commit_all "$repo" "lock"
    git -C "$repo" checkout -q -b work
    echo "$repo"
}

r="$(branch_repo lock-introduced)"
printf '# Locked\n' >"$r/$SPEC/locked.md"
printf '# FRD\n\nFinal edit.\n' >"$r/$SPEC/frd.md"
commit_all "$r" "lock alongside the final edit"
expect pass "introducing locked.md alongside final edits" "$r"

r="$(locked_repo edit-locked)"
printf '# FRD\n\nPost-lock edit.\n' >"$r/$SPEC/frd.md"
commit_all "$r" "edit a locked artifact"
expect fail "editing an artifact under a locked SDD" "$r"

r="$(locked_repo add-locked)"
printf '# Message\n' >"$r/$SPEC/message-2026-02-01-late.md"
commit_all "$r" "add a file to a locked SDD"
expect fail "adding a file to a locked SDD" "$r"

r="$(locked_repo update-lock)"
printf '# Locked\n\n2026-02-01: noted a later change.\n' >"$r/$SPEC/locked.md"
commit_all "$r" "update locked.md"
expect pass "updating locked.md" "$r"

r="$(locked_repo tombstone)"
git -C "$r" rm -q "$SPEC/plan.md" "$SPEC/frd.md"
printf '# Locked\n\nArtifacts removed; see the parent commit.\n' >"$r/$SPEC/locked.md"
commit_all "$r" "wipe to the tombstone"
expect pass "wiping a locked SDD down to its tombstone" "$r"

r="$(locked_repo partial)"
git -C "$r" rm -q "$SPEC/frd.md"
commit_all "$r" "partial deletion"
expect fail "partially deleting a locked SDD" "$r"

r="$(locked_repo delete-lock)"
git -C "$r" rm -q "$SPEC/locked.md"
commit_all "$r" "delete the lockfile"
expect fail "deleting locked.md" "$r"

r="$(locked_repo outside-spec-dirs)"
git -C "$r" checkout -q main
printf '# Locked\n\nUpdated on main after the branch started.\n' >"$r/$SPEC/locked.md"
commit_all "$r" "main moves on"
git -C "$r" checkout -q work
printf 'notes\n' >"$r/docs/sdd/README.md"
commit_all "$r" "change outside any spec directory"
expect pass "a change outside spec directories while main moves on" "$r"

r="$(branch_repo nested-lock)"
mkdir -p "$r/$SPEC/child"
printf '# Child plan\n' >"$r/$SPEC/child/plan.md"
printf '# Locked\n' >"$r/$SPEC/child/locked.md"
commit_all "$r" "nest a locked child inside a spec directory"
expect fail "a locked.md nested below a spec directory" "$r"

r="$(new_repo nested-item)"
printf -- '- [x] Parent item.\n  - [ ] Nested step.\n' >>"$r/$SPEC/plan.md"
commit_all "$r" "a completed box with an open item nested under it"
git -C "$r" checkout -q -b work
sed -i.bak 's/  - \[ \] Nested step\./  - [x] Nested step./' "$r/$SPEC/plan.md" && rm "$r/$SPEC/plan.md.bak"
commit_all "$r" "check the nested item"
expect pass "checking an item nested under a completed box" "$r"

echo "=== CI invocation (merge commit against its first parent) ==="

# pr_merge <repo>: merge the work branch into main as CI's synthetic merge commit does.
pr_merge() {
    git -C "$1" checkout -q main
    git -C "$1" merge -q --no-ff -m "Merge work" work
}

r="$(branch_repo ci-clean)"
printf '# FRD\n\nRevised.\n' >"$r/$SPEC/frd.md"
commit_all "$r" "ordinary edit"
pr_merge "$r"
expect pass "CI run on a clean pull request" "$r" HEAD^1

r="$(branch_repo ci-violation)"
sed -i.bak 's/First completed item./First completed item, reworded./' "$r/$SPEC/plan.md" && rm "$r/$SPEC/plan.md.bak"
commit_all "$r" "edit a completed box"
pr_merge "$r"
expect fail "CI run on a pull request that edits a completed box" "$r" HEAD^1

r="$(branch_repo ci-late-lock)"
printf '# FRD\n\nBranch edit.\n' >"$r/$SPEC/frd.md"
commit_all "$r" "edit before the lock"
git -C "$r" checkout -q main
printf '# Locked\n' >"$r/$SPEC/locked.md"
commit_all "$r" "lock lands on main after the fork"
git -C "$r" checkout -q work
expect pass "a local run at the branch tip misses a lock that landed after the fork" "$r"
pr_merge "$r"
expect fail "CI catches a lock that landed after the fork" "$r" HEAD^1

echo ""
echo "$PASSED passed, $FAILED failed."
[[ $FAILED -eq 0 ]]
