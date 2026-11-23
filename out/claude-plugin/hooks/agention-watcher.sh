#!/bin/sh
# agention-watcher: the Claude Code hook that wakes an agent at its prompt
# when the Agention bridge finds messages from the operator.
#
# Claude Code runs it in the background (asyncRewake) on SessionStart and on
# every Stop. It waits in the host directory it shares with the bridge,
# ~/.config/agention/_hosts/claude/<pid>/, named for the Claude Code process
# in CLAUDE_PID, for the wake file the bridge writes. It takes the file,
# prints the notice in it to stderr and exits 2, which wakes the agent. Every
# other outcome exits 0 or 1, so nothing but a taken wake file wakes the
# agent, and a broken watcher cannot loop the session through turns.
#
# One watcher runs per host process: each new one takes the lock, and the one
# it replaces exits 0, so the watcher running is the one the last turn
# started. It touches no key and no server, and writes nothing but the host
# directory, under the private-file rule the bridge keeps there too.

# Claude Code hands a hook its input on stdin, which the watcher has no use
# for.
[ -t 0 ] || cat >/dev/null 2>&1

# A session that does not use Agention, or a host that gives no pid, keeps
# nothing running. The pid becomes a path component, so it is digits only.
[ -n "${AGENTION_URL:-}" ] || exit 0
host=${CLAUDE_PID:-}
case $host in
    '' | 0* | *[!0-9]*) exit 0 ;;
esac
[ "${#host}" -le 10 ] || exit 0
case ${HOME:-} in
    /*) ;;
    *) exit 0 ;;
esac

# alive says whether a process of this user runs with the pid given.
alive() {
    kill -0 "$1" 2>/dev/null
}

alive "$host" || exit 0

umask 077
uid=$(id -u) || exit 1
mkdir -p "$HOME/.config/agention/_hosts/claude/$host" 2>/dev/null || exit 1
dir=$(cd -P -- "$HOME/.config/agention/_hosts/claude/$host" 2>/dev/null && pwd -P) || exit 1

# The private-file rule, as the bridge applies it: the host directory belongs
# to this user with mode 700, every directory above its real path belongs to
# this user or root and no other user can write to it unless it is sticky,
# and a file the watcher reads belongs to this user with mode 600 and is no
# symlink. Each check reads the mode and owner ls -n prints.
private_directory() {
    ls -ldn -- "$1" 2>/dev/null | (
        read -r mode _ owner _ || exit 1
        case $mode in
            drwx------*) [ "$owner" = "$uid" ] ;;
            *) exit 1 ;;
        esac
    )
}

safe_ancestor() {
    ls -ldn -- "$1" 2>/dev/null | (
        read -r mode _ owner _ || exit 1
        case $mode in
            d*) ;;
            *) exit 1 ;;
        esac
        [ "$owner" = "$uid" ] || [ "$owner" = 0 ] || exit 1
        case $mode in
            ?????w* | ????????w*)
                case $mode in
                    ?????????[tT]*) ;;
                    *) exit 1 ;;
                esac
                ;;
        esac
    )
}

private_file() {
    ls -ln -- "$1" 2>/dev/null | (
        read -r mode _ owner _ || exit 1
        case $mode in
            -rw-------*) [ "$owner" = "$uid" ] ;;
            *) exit 1 ;;
        esac
    )
}

private_directory "$dir" || exit 1
above=$dir
while [ "$above" != / ]; do
    above=${above%/*}
    [ -n "$above" ] || above=/
    safe_ancestor "$above" || exit 1
done

# The directories of host processes that have ended are removed.
for entry in "${dir%/*}"/*; do
    name=${entry##*/}
    case $name in
        '' | 0* | *[!0-9]*) continue ;;
    esac
    if [ "$name" != "$host" ] && [ -d "$entry" ] && [ ! -h "$entry" ] && ! alive "$name"; then
        rm -rf -- "$entry"
    fi
done

# The mark tells the bridge that the plugin's hooks run in this host process.
[ -e "$dir/hooked" ] || : >"$dir/hooked" || exit 1

# The lock holds the running watcher's pid. Taking it replaces the file
# whole, so it never holds half a pid.
lock=$dir/watcher
printf '%s\n' "$$" >"$lock.$$" && mv -f -- "$lock.$$" "$lock" || exit 1

release() {
    [ "$(cat -- "$lock" 2>/dev/null)" = "$$" ] && rm -f -- "$lock"
}
trap 'release; exit 0' HUP INT TERM

while :; do
    if ! alive "$host"; then
        release
        exit 0
    fi
    # A newer watcher holds the lock: it is the one that waits now.
    holder=$(cat -- "$lock" 2>/dev/null)
    case $holder in
        '' | "$$") ;;
        *) exit 0 ;;
    esac
    if [ -e "$dir/wake" ] || [ -h "$dir/wake" ]; then
        # Renaming takes the file; if the bridge took it back first to write
        # a fuller one, the next look finds that.
        taken=$dir/wake.$$
        if mv -f -- "$dir/wake" "$taken" 2>/dev/null; then
            release
            if private_file "$taken" && cat -- "$taken" >&2; then
                rm -f -- "$taken"
                exit 2
            fi
            rm -f -- "$taken"
            exit 1
        fi
    fi
    sleep 1
done
