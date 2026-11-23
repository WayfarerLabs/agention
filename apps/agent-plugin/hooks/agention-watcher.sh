#!/bin/sh
# agention-watcher: the Claude Code hook that wakes an agent at its prompt
# when the Agention bridge finds messages from the operator.
#
# Claude Code runs it in the background (asyncRewake) on SessionStart, on
# UserPromptSubmit, and at every turn's end, Stop or StopFailure. It waits in
# the host directory it shares with the bridge,
# ~/.config/agention/_hosts/claude/<host name>/<pid>/, named for the machine
# and the Claude Code process in CLAUDE_PID, for the wake files the bridge
# writes, one per session. It
# takes them, prints their notices to stderr and exits 2, which wakes the
# agent. Every other outcome exits 0 or 1, and nothing else ever reaches
# stderr, so nothing but a taken wake file wakes the agent, and a broken
# watcher cannot loop the session through turns or put text before it.
#
# One watcher runs per host process: each new one takes the lock, and the one
# it replaces exits 0, so the watcher running is the one the last hook
# started. It touches no key and no server, and writes nothing but the host
# directory, under the private-file rule the bridge keeps there too.

# Only the notice goes to stderr, by descriptor 3; everything else, the
# shell's own errors included, goes nowhere. A hook always has stderr, so
# without one there is nothing to do.
true >&2 || exit 0
exec 3>&2 2>/dev/null

# Claude Code hands a hook its input on stdin, which the watcher has no use
# for.
[ -t 0 ] || cat >/dev/null

# A session that does not use Agention, one that is not an interactive
# session in the terminal, such as claude -p or an SDK run, which no one
# waits on at a prompt, and a host that gives no pid keep nothing running,
# and so are never told they are pushed. The pid and the host name become
# path components, so they are checked as the bridge checks them.
[ -n "${AGENTION_URL:-}" ] || exit 0
[ "${CLAUDE_CODE_ENTRYPOINT:-}" = cli ] || exit 0
host=${CLAUDE_PID:-}
case $host in
    '' | 0* | *[!0-9]*) exit 0 ;;
esac
[ "${#host}" -le 10 ] || exit 0
case ${HOME:-} in
    /*) ;;
    *) exit 0 ;;
esac
name=$(uname -n) || exit 0
case $name in
    '' | . | .. | *[!A-Za-z0-9._-]*) exit 0 ;;
esac
[ "${#name}" -le 255 ] || exit 0

# alive says whether a process of this user runs with the pid given.
alive() {
    kill -0 "$1"
}

alive "$host" || exit 0

umask 077
uid=$(id -u) || exit 1
mkdir -p "$HOME/.config/agention/_hosts/claude/$name/$host" || exit 1
dir=$(cd -P -- "$HOME/.config/agention/_hosts/claude/$name/$host" && pwd -P) || exit 1

# The private-file rule, as the bridge applies it: the host directory belongs
# to this user, with no group or other permissions, and every directory
# above its real path belongs to this user or root, with no group or other
# write permission unless it is sticky. Every file in the directory is then
# this user's to write.
private_directory() {
    [ -n "$(find "$1" -prune -type d -user "$uid" \
        ! -perm -0040 ! -perm -0020 ! -perm -0010 \
        ! -perm -0004 ! -perm -0002 ! -perm -0001 -print)" ]
}

safe_ancestor() {
    [ -n "$(find "$1" -prune -type d \( -user "$uid" -o -user 0 \) \
        \( -perm -1000 -o \( ! -perm -0020 ! -perm -0002 \) \) -print)" ]
}

private_directory "$dir" || exit 1
above=$dir
while [ "$above" != / ]; do
    above=${above%/*}
    [ -n "$above" ] || above=/
    safe_ancestor "$above" || exit 1
done

# The mark tells the bridge that the plugin's hooks run in this host process.
# true, unlike :, is no special builtin, so a mark that cannot be written
# fails the command rather than ending the shell with status 2.
[ -e "$dir/hooked" ] || true >"$dir/hooked" || exit 1

# The lock holds the running watcher's pid. Taking it replaces the file
# whole, so it never holds half a pid.
lock=$dir/watcher
release() {
    [ "$(cat -- "$lock")" = "$$" ] && rm -f -- "$lock"
}
trap 'release; exit 0' HUP INT TERM
if ! { printf '%s\n' "$$" >"$lock.$$" && mv -f -- "$lock.$$" "$lock"; }; then
    rm -f -- "$lock.$$"
    exit 1
fi

while :; do
    if ! alive "$host"; then
        release
        exit 0
    fi
    # A newer watcher holds the lock: it is the one that waits now.
    holder=$(cat -- "$lock")
    case $holder in
        '' | "$$") ;;
        *) exit 0 ;;
    esac
    # Renaming takes a file, so the bridge's next one is never lost. A
    # notice that cannot be printed goes back for the next watcher, unless
    # the bridge has written a newer one, which supersedes it.
    taken=0
    for wake in "$dir"/wake-*; do
        mine=$dir/taken.$$
        if [ -f "$wake" ] && mv -f -- "$wake" "$mine"; then
            if ! cat -- "$mine" >&3; then
                if [ -e "$wake" ]; then
                    rm -f -- "$mine"
                else
                    mv -f -- "$mine" "$wake"
                fi
                release
                exit 1
            fi
            taken=1
            rm -f -- "$mine"
        fi
    done
    if [ "$taken" = 1 ]; then
        release
        exit 2
    fi
    sleep 1
done
