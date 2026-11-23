#!/usr/bin/env bash

# ============================================================================
# check-release-tag.sh: refuses a release tag that is not its line's version
# everywhere that line's release pull request writes it.
#
# A tag names its line by the component of one release-please configuration,
# agention-vX.Y.Z for release-please-config.json and agention-mcp-vX.Y.Z for
# release-please-config.agent.json. The places checked are the ones that
# configuration's release pull request writes: its manifest, the files its
# release type writes (the root package.json and package-lock.json for the
# node type, nothing for the simple type) and each of its extra-files, read
# from the configuration itself, so a file added there is checked here too.
# The release workflow runs it before building a release.
#
# Usage:
#   scripts/check-release-tag.sh TAG
#
# Exit codes: 0 every place holds the tag's version, 1 a place does not or
# the tag names no line, 2 usage error.
# ============================================================================

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"
require_command node "Install the version in .node-version."

usage="Usage: scripts/check-release-tag.sh TAG"
case "$#:${1:-}" in
    1:-h | 1:--help) echo "$usage" && exit 0 ;;
    1:?*) ;;
    *) echo "$usage" >&2 && exit 2 ;;
esac

cd "$REPO_ROOT"

node - "$1" <<'EOF'
const fs = require("node:fs");
const [tag] = process.argv.slice(2);
const lines = [
  ["release-please-config.json", ".release-please-manifest.json"],
  ["release-please-config.agent.json", ".release-please-manifest.agent.json"],
];
const readJson = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
const fail = (message) => {
  console.error(`check-release-tag.sh: ${message}`);
  process.exit(1);
};

// The same pattern release-please's JSON updater replaces: the first version
// in the string.
const versionPattern = /\d+\.\d+\.\d+(-[\w.]+)?(\+[-\w.]+)?/;

// read evaluates the jsonpath forms extra-files use here: $, .name,
// ['name'] and [n].
function read(data, jsonpath) {
  const step = /\.([A-Za-z_$][\w$]*)|\['([^']*)'\]|\[(\d+)\]/y;
  if (!jsonpath.startsWith("$")) {
    fail(`cannot read the jsonpath ${jsonpath}; extend this script to read it.`);
  }
  let value = data;
  step.lastIndex = 1;
  while (step.lastIndex < jsonpath.length) {
    const match = step.exec(jsonpath);
    if (match === null) {
      fail(`cannot read the jsonpath ${jsonpath}; extend this script to read it.`);
    }
    const key = match[1] ?? match[2] ?? Number(match[3]);
    value = value?.[key];
  }
  return value;
}

const found = lines
  .map(([config, manifest]) => ({ config, manifest, settings: readJson(config).packages["."] }))
  .filter(({ settings }) => tag.startsWith(`${settings.component}-v`));
if (found.length !== 1) {
  fail(`${tag} names no release line: a line's tags are its component, -v and its version.`);
}
const [{ config, manifest, settings }] = found;
const version = tag.slice(`${settings.component}-v`.length);
if (version.match(versionPattern)?.[0] !== version) {
  fail(`${tag} does not end in a version.`);
}

const places = [{ path: manifest, jsonpath: "$['.']" }];
if (settings["release-type"] === "node") {
  places.push(
    { path: "package.json", jsonpath: "$.version" },
    { path: "package-lock.json", jsonpath: "$.version" },
    { path: "package-lock.json", jsonpath: "$.packages[''].version" },
  );
} else if (settings["release-type"] !== "simple") {
  fail(`${config} has release type ${settings["release-type"]}, whose files this script does not know.`);
}
for (const file of settings["extra-files"] ?? []) {
  if (typeof file !== "object" || file.type !== "json") {
    fail(`${config} has an extra file this script cannot read: ${JSON.stringify(file)}.`);
  }
  places.push(file);
}

let mismatched = 0;
for (const { path, jsonpath } of places) {
  const value = read(readJson(path), jsonpath);
  const stated = typeof value === "string" ? value.match(versionPattern)?.[0] : undefined;
  if (stated !== version) {
    console.error(`${path} ${jsonpath} is ${JSON.stringify(value)}, not the version of ${tag}.`);
    mismatched += 1;
  }
}
if (mismatched > 0) {
  fail(`${tag} is not ${config}'s version everywhere its release pull request writes it.`);
}
console.log(`${tag}: ${places.length} places in ${config}'s line hold ${version}.`);
EOF
