#!/usr/bin/env bash

# ============================================================================
# check.sh: every gate CI requires, in the order CI runs them.
#
# CI runs this script, so a local pass means the same checks pass in CI.
# Prerequisites: Node at the version in .node-version, with the npm it
# bundles, the repository's release tags, and network access for the
# install, signature, vulnerability and agent compatibility checks. The first
# gate installs the locked dependencies with `npm ci`. The browser gate needs
# Chromium's headless shell, installed once with
# `npx playwright install --only-shell chromium`. --fast skips the agent
# compatibility gate, which installs the released bridges, the builds and the
# browser gate, which drives them. --packages DIR runs only the install
# and the build gate, which builds the published packages and checks each as
# npm would publish it, and keeps the tarballs it checked in DIR, which must
# be empty or missing; the release workflow publishes those. The SDD gate
# compares the branch with SDD_BASE, which CI sets, or with origin/main.
# ============================================================================

set -euo pipefail

usage="Usage: scripts/check.sh [--fast | --packages DIR]"
mode=all
packages_dir=""
case "$#:${1:-}" in
    0:) ;;
    1:--fast) mode=fast ;;
    2:--packages) mode=packages packages_dir="$2" ;;
    1:-h | 1:--help) echo "$usage" && exit 0 ;;
    *) echo "$usage" >&2 && exit 2 ;;
esac
if [[ -n "$packages_dir" ]]; then
    if [[ -e "$packages_dir" && -n "$(ls -A "$packages_dir")" ]]; then
        echo "check.sh: $packages_dir must be empty, so it holds only the packages checked now." >&2
        exit 2
    fi
    mkdir -p "$packages_dir"
    # Absolute, since the checks run from the repository root.
    packages_dir="$(cd "$packages_dir" && pwd)"
fi

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
require_command node "Install the version in .node-version."
require_command npm "Install Node at the version in .node-version, which bundles npm."

cd "$REPO_ROOT"

step() {
    echo ""
    echo "=== $* ==="
}

# check_package packs a workspace as npm would publish it and checks the
# result: the package declares no dependencies, since its bundle includes them;
# it ships the repository's LICENSE, a README for its npm page, and the
# license notices the build writes beside the bundle; and, installed from the
# tarball into a directory of its own, its command starts through
# node_modules/.bin and prints the version in its package.json. It leaves the
# unpacked and installed package in $package_dir for further checks, and
# copies the tarball it checked into $packages_dir when one is given.
check_package() {
    local workspace="$1" command="$2" version_arg="$3"
    local dir tarball manifest declared bin want got status=0
    dir="$(mktemp -d "$scratch/package.XXXXXX")"
    package_dir="$dir"
    tarball="$(npm pack --silent --workspace "$workspace" --pack-destination "$dir")"
    tar -xzf "$dir/$tarball" -C "$dir"
    manifest="$dir/package/package.json"

    declared="$(node -p '
        const fields = ["dependencies", "optionalDependencies", "peerDependencies",
            "bundleDependencies", "bundledDependencies"];
        const manifest = require(process.argv[1]);
        fields.filter((field) => field in manifest).join(" ")' "$manifest")"
    if [[ -n "$declared" ]]; then
        echo "$workspace declares $declared. A published package lists what its bundle includes under devDependencies." >&2
        return 1
    fi
    bin="$(node -p 'require(process.argv[1]).bin?.[process.argv[2]] ?? ""' "$manifest" "$command")"
    if [[ -z "$bin" ]]; then
        echo "$workspace declares no '$command' command." >&2
        return 1
    fi
    if ! cmp -s LICENSE "$dir/package/LICENSE"; then
        echo "$workspace does not ship the repository's LICENSE." >&2
        return 1
    fi
    if [[ ! -s "$dir/package/README.md" ]]; then
        echo "$workspace does not ship a README.md, which npm shows as the package's page." >&2
        return 1
    fi
    # The notices file name is the one packages/build writes.
    if [[ ! -f "$dir/package/$(dirname "$bin")/THIRD-PARTY-NOTICES.txt" ]]; then
        echo "$workspace does not ship THIRD-PARTY-NOTICES.txt beside $bin." >&2
        return 1
    fi

    npm install --silent --prefix "$dir/install" --ignore-scripts --no-audit --no-fund "$dir/$tarball"
    want="$command $(node -p 'require(process.argv[1]).version' "$manifest")"
    got="$("$dir/install/node_modules/.bin/$command" "$version_arg" 2>&1)" || status=$?
    if [[ $status -ne 0 || "$got" != "$want" ]]; then
        echo "$workspace: '$command $version_arg' exited with status $status and printed '$got', want '$want'." >&2
        return 1
    fi
    if [[ -n "$packages_dir" ]]; then
        cp "$dir/$tarball" "$packages_dir/"
    fi
    echo "$workspace: $want"
}

# check_server_serves runs the server installed by check_package on a free
# loopback port and checks that it serves the web UI its package ships, not
# the placeholder for a build without one, sends that UI's script as Brotli to
# be kept for good, and begins a passkey sign-in.
check_server_serves() {
    local dir="$package_dir" pid port="" status=0
    if [[ ! -f "$dir/package/web/index.html" ]]; then
        echo "apps/server does not ship the web UI in web/." >&2
        return 1
    fi
    mkdir -m 700 "$dir/data"
    # The background job opens the log itself, so create it before reading it.
    : >"$dir/serve.log"
    "$dir/install/node_modules/.bin/agention" serve --data "$dir/data" \
        --origin https://agention.invalid --listen 127.0.0.1:0 2>"$dir/serve.log" &
    pid=$!
    for _ in {1..100}; do
        port="$(sed -n 's|.* on http://127\.0\.0\.1:\([0-9]*\)$|\1|p' "$dir/serve.log")"
        [[ -n "$port" ]] && break
        sleep 0.1
    done
    node -e '
        const { readFileSync } = require("node:fs");
        const http = require("node:http");
        const { brotliDecompressSync } = require("node:zlib");
        const [port, web] = process.argv.slice(1);
        const send = (method, path, headers = {}) => new Promise((resolve, reject) => {
            const request = http.request(
                { host: "127.0.0.1", port, method, path,
                  headers: { host: "agention.invalid", ...headers } },
                (response) => {
                    const chunks = [];
                    response.on("data", (chunk) => chunks.push(chunk));
                    response.on("end", () => resolve({ response, body: Buffer.concat(chunks) }));
                });
            request.on("error", reject);
            request.end();
        });
        (async () => {
            const page = await send("GET", "/s/agent/session/threads/1");
            const index = readFileSync(`${web}/index.html`, "utf8");
            if (page.body.toString() !== index) {
                throw new Error("the server did not serve the web UI it ships");
            }
            const script = /<script [^>]*src="([^"]+)"/.exec(index)?.[1];
            if (script === undefined) {
                throw new Error("the web UI it ships loads no script");
            }
            const sent = await send("GET", script, { "accept-encoding": "br" });
            const { "content-encoding": encoding, "cache-control": caching } = sent.response.headers;
            if (encoding !== "br" || !/\bimmutable\b/.test(caching)
                || !brotliDecompressSync(sent.body).equals(readFileSync(web + script))) {
                throw new Error(
                    `the server did not send ${script} as Brotli, to be kept for good: ` +
                        `content-encoding ${encoding}, cache-control ${caching}`);
            }
            // Beginning a passkey sign-in runs the bundled WebAuthn library and
            // seals the challenge with the instance key.
            const begin = await send("POST", "/api/web/auth/signin/begin",
                { origin: "https://agention.invalid" });
            const cookie = begin.response.headers["set-cookie"]?.[0] ?? "";
            if (begin.response.statusCode !== 200
                || typeof JSON.parse(begin.body).options?.challenge !== "string"
                || !cookie.startsWith("__Host-agention-443-challenge=")) {
                throw new Error(`passkey sign-in did not begin: ${begin.body}`);
            }
        })().catch((error) => { console.error(error.message); process.exit(1); });
    ' "$port" "$dir/package/web" || status=$?
    kill "$pid" && wait "$pid" || true
    if [[ $status -ne 0 || -z "$port" ]]; then
        echo "apps/server: the installed server did not serve its web UI or begin a sign-in:" >&2
        cat "$dir/serve.log" >&2
        return 1
    fi
    echo "apps/server: serves its web UI and begins a passkey sign-in"
}

# CI checks on the pinned version, and its oldest-Node job on the oldest
# supported one; anywhere else a mismatch is worth knowing about.
node_pin="$(read_pin .node-version)"
if [[ "$(node --version)" != "v$node_pin" ]]; then
    echo "Warning: Node is $(node --version) but .node-version pins $node_pin." >&2
fi

step "Dependency integrity"
# --ignore-scripts on the command line also overrides an npm_config_*
# environment variable, which would otherwise take precedence over .npmrc.
# The audit runs as its own gate below.
npm ci --ignore-scripts --no-audit --no-fund
npm audit signatures

if [[ $mode != packages ]]; then
    step "Format and lint"
    scripts/lint-files.sh

    step "Types"
    npm run --workspaces typecheck

    step "Tests"
    npm run --workspaces test

    step "Vulnerabilities"
    npm audit --audit-level=high

    step "Plugin drift"
    scripts/generate-plugins.sh --check

    step "SDD records"
    scripts/check-sdd.test.sh
    scripts/check-sdd.sh ${SDD_BASE:+"$SDD_BASE"}
fi

if [[ $mode == all ]]; then
    step "Agent compatibility"
    # Every released bridge against the agent routes at HEAD, as
    # CONTRIBUTING.md "The agent API" describes.
    scripts/check-agent-compatibility.sh
fi

if [[ $mode != fast ]]; then
    step "Build"
    scratch="$(mktemp -d)"
    trap 'rm -rf "$scratch"' EXIT
    # The server's build runs the web UI's build first and ships it.
    npm run --silent --workspace apps/server build
    npm run --silent --workspace apps/bridge build
    check_package apps/server agention version
    check_server_serves
    check_package apps/bridge agention-mcp --version

    if [[ $mode == all ]]; then
        step "Browser"
        # Chromium drives the web UI the built server serves, over TLS.
        npm run --silent --workspace apps/web test:browser
    fi
fi

echo ""
echo "All checks passed."
