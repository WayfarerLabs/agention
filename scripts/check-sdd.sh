#!/usr/bin/env bash

# ============================================================================
# check-sdd.sh: enforce SDD completed-checkbox immutability and locks.
#
# Spec directories live at docs/sdd/<date>-<slug>/. The script compares HEAD
# with the merge-base of HEAD and a base ref (main), so it judges only what a
# branch changes relative to what it inherited:
#
#   Completed checkboxes. Every completed checkbox in a spec directory's
#   Markdown files at the merge-base (a list item starting "- [x]", "* [x]",
#   or "+ [x]", together with its continuation lines indented deeper than the
#   item) must still exist at HEAD with the same text and in the same relative
#   order. Re-wrapping a line is not a change; editing, unchecking, moving, or
#   deleting a completed box is. New, unchecked, and newly checked boxes are
#   unrestricted. Numbered-list checkboxes are not recognized.
#
#   Locks. A spec directory whose locked.md exists at the merge-base is
#   locked: nothing under it may be added or modified except locked.md itself,
#   and the only allowed deletion is a full wipe down to the locked.md
#   tombstone. A locked.md introduced by the branch does not lock anything yet.
#   A locked.md nested deeper than docs/sdd/<dir>/ is always rejected: saga
#   children are sibling spec directories, never nested ones.
#
# Only committed history is compared; uncommitted edits are not seen. Run from
# anywhere inside the repository to check.
#
# Usage:
#   ./scripts/check-sdd.sh [BASE]
#       BASE is the ref or SHA to take the merge-base with (default:
#       origin/main, falling back to main). CI needs full history.
#
#       CI checks a pull request's merge commit against its first parent
#       (HEAD^1, the base side), so a lock that landed on main after the
#       branch forked still applies. A local run at a branch tip compares
#       against the fork point and can miss such a lock; CI catches it.
#
# Exit codes: 0 no violations, 1 violations or an unusable base, 2 usage error.
# ============================================================================

set -uo pipefail

SDD_ROOT="docs/sdd"
LOCKFILE="locked.md"

if ! REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    echo "Error: run check-sdd.sh from inside a git repository." >&2
    exit 1
fi
cd "$REPO_ROOT" || exit 1

BASE_ARG=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        -h|--help)
            sed -n '/^# Usage:/,/^# Exit codes:/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        -*)
            echo "Error: unknown option '$1'. Run with --help for usage." >&2
            exit 2
            ;;
        *)
            [[ -z "$BASE_ARG" ]] || { echo "Error: unexpected argument '$1'." >&2; exit 2; }
            BASE_ARG="$1"
            ;;
    esac
    shift
done

if [[ -n "$BASE_ARG" ]]; then
    BASE="$BASE_ARG"
elif git rev-parse --verify -q origin/main >/dev/null; then
    BASE="origin/main"
else
    BASE="main"
fi

if ! git rev-parse --verify -q "$BASE^{commit}" >/dev/null; then
    echo "Error: base ref '$BASE' is not a valid commit. Fetch it first (CI needs fetch-depth: 0)." >&2
    exit 1
fi
if ! MERGE_BASE="$(git merge-base "$BASE" HEAD)"; then
    echo "Error: could not compute the merge-base of '$BASE' and HEAD." >&2
    exit 1
fi

GIT=(git -c core.quotepath=false)
VIOLATIONS=""
add_violation() {
    VIOLATIONS+="  - $1"$'\n'
}

# Print each completed checkbox in Markdown on stdin as one line: the item and
# its continuation lines joined, with runs of whitespace collapsed.
completed_items() {
    awk '
        function flush() { if (item != "") { gsub(/[ \t]+/, " ", item); print item; item = "" } }
        {
            line = $0
            match(line, /^[ \t]*/); indent = RLENGTH
            if (line ~ /^[ \t]*[-*+][ \t]+\[[xX]\][ \t]+/) {
                flush(); item = line; item_indent = indent; next
            }
            if (item != "" && line ~ /[^ \t]/ && indent > item_indent && line !~ /^[ \t]*([-*+]|[0-9]+[.)])[ \t]/) {
                sub(/^[ \t]+/, "", line); item = item " " line; next
            }
            flush()
        }
        END { flush() }
    '
}

# True when every line of file $1 appears in file $2 in the same relative order.
is_subsequence() {
    awk 'NR == FNR { want[++n] = $0; next } (i < n && $0 == want[i + 1]) { i++ } END { exit (i == n) ? 0 : 1 }' "$1" "$2"
}

# A lockfile nested below a spec directory is never valid.
while IFS= read -r nested; do
    [[ -n "$nested" ]] && add_violation "$nested: locked.md is nested below a spec directory; saga children and other efforts are sibling spec directories in docs/sdd/."
done < <("${GIT[@]}" ls-tree -r --name-only HEAD -- "$SDD_ROOT/" | grep -E "^$SDD_ROOT/[^/]+/.+/$LOCKFILE\$" || true)

# Spec directories touched between the merge-base and HEAD.
changed_dirs=()
while IFS= read -r changed_dir; do
    [[ -n "$changed_dir" ]] && changed_dirs+=("$changed_dir")
done < <(
    "${GIT[@]}" diff --name-only --no-renames "$MERGE_BASE" HEAD -- "$SDD_ROOT/" |
        sed -n "s#^\($SDD_ROOT/[^/]*\)/.*#\1#p" |
        sort -u
)

if [[ ${#changed_dirs[@]} -eq 0 && -z "$VIOLATIONS" ]]; then
    echo "check-sdd: no SDD changes since $(git rev-parse --short "$MERGE_BASE")."
    exit 0
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

for dir in ${changed_dirs[@]+"${changed_dirs[@]}"}; do
    locked=0
    "${GIT[@]}" cat-file -e "$MERGE_BASE:$dir/$LOCKFILE" 2>/dev/null && locked=1
    head_files="$("${GIT[@]}" ls-tree -r --name-only HEAD -- "$dir/")"

    # A locked directory wiped down to its tombstone is the one allowed bulk change.
    tombstone=0
    if [[ $locked -eq 1 && "$head_files" == "$dir/$LOCKFILE" ]]; then
        tombstone=1
    fi

    if [[ $locked -eq 1 && $tombstone -eq 0 ]]; then
        deleted_any=0
        while IFS=$'\t' read -r status path; do
            [[ -n "$status" ]] || continue
            if [[ "$path" == "$dir/$LOCKFILE" ]]; then
                [[ "$status" != D* ]] ||
                    add_violation "$path: the lockfile must remain as a tombstone; deleting it is not allowed."
                continue
            fi
            case "$status" in
                D*) deleted_any=1 ;;
                *) add_violation "$path: a locked SDD artifact was added or modified (status $status)." ;;
            esac
        done < <("${GIT[@]}" diff --name-status --no-renames "$MERGE_BASE" HEAD -- "$dir/")
        if [[ $deleted_any -eq 1 && -n "$head_files" ]]; then
            add_violation "$dir: partial deletion of a locked SDD; delete every artifact except $LOCKFILE, or none."
        fi
    fi

    [[ $tombstone -eq 0 ]] || continue

    # Completed checkboxes in every Markdown file that existed at the merge-base.
    while IFS= read -r file; do
        [[ "$file" == *.md ]] || continue
        "${GIT[@]}" show "$MERGE_BASE:$file" | completed_items >"$TMP_DIR/before"
        [[ -s "$TMP_DIR/before" ]] || continue
        if ! "${GIT[@]}" cat-file -e "HEAD:$file" 2>/dev/null; then
            add_violation "$file: deleted, but it held completed checkboxes, which must be preserved."
            continue
        fi
        "${GIT[@]}" show "HEAD:$file" | completed_items >"$TMP_DIR/after"
        if ! is_subsequence "$TMP_DIR/before" "$TMP_DIR/after"; then
            add_violation "$file: a completed checkbox was edited, unchecked, moved, or deleted; completed boxes are immutable."
        fi
    done < <("${GIT[@]}" ls-tree -r --name-only "$MERGE_BASE" -- "$dir/")
done

if [[ -n "$VIOLATIONS" ]]; then
    echo "ERROR: SDD records were changed in ways the sdd skill forbids:" >&2
    printf '%s' "$VIOLATIONS" >&2
    echo "Completed checkboxes are immutable once merged, and a merged locked.md freezes its" >&2
    echo "spec directory except for lockfile updates or a full wipe to the tombstone." >&2
    exit 1
fi

echo "check-sdd: ${#changed_dirs[@]} changed spec director$([[ ${#changed_dirs[@]} -eq 1 ]] && echo y || echo ies) checked; no violations."
exit 0
