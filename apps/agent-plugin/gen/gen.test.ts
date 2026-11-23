import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { run } from "./cli.ts";
import { definitionPath, hooksPath, loadSources, skillsPath, unscopedName } from "./definition.ts";
import { check, write } from "./output.ts";
import {
  claudeCatalogPath,
  claudePluginDir,
  codexCatalogPath,
  codexPluginDir,
  type Generated,
  render,
} from "./render.ts";

const validDefinition = `{
  "name": "example",
  "version": "1.2.3",
  "description": "An example plugin.",
  "author": {"name": "Example Author"},
  "license": "MIT",
  "keywords": ["one", "two"],
  "mcpServer": {
    "name": "example-server",
    "package": "@example/server",
    "environment": ["EXAMPLE_URL", "EXAMPLE_NAME"]
  }
}
`;

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agention-gen-"));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function mustWrite(name: string, content: string): void {
  mkdirSync(dirname(name), { recursive: true });
  writeFileSync(name, content);
}

function mustSymlink(target: string, name: string): void {
  mkdirSync(dirname(name), { recursive: true });
  symlinkSync(target, name);
}

// newRepo builds a minimal repository with a valid definition and one skill.
function newRepo(definition = validDefinition): string {
  const root = tempDir();
  mustWrite(join(root, definitionPath), definition);
  mustWrite(join(root, skillsPath, "example", "SKILL.md"), "---\nname: example\n---\n");
  mustWrite(join(root, skillsPath, "example", "references", "more.md"), "more\n");
  return root;
}

function generate(root: string): Generated {
  return render(loadSources(root));
}

// snapshot captures every entry under dir (files with content, directories and
// symlinks by kind), to prove a step changed nothing.
function snapshot(dir: string): Map<string, string> {
  const entries = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const name = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        entries.set(name, `symlink ${readlinkSync(name)}`);
      } else if (entry.isDirectory()) {
        entries.set(name, "dir");
        walk(name);
      } else {
        entries.set(name, `file ${readFileSync(name, "utf8")}`);
      }
    }
  };
  walk(dir);
  return entries;
}

function readJSON(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(name, "utf8")) as Record<string, unknown>;
}

const discard = { write: () => true };

// newTarball creates a file standing in for a tarball npm pack wrote.
function newTarball(): string {
  const tarball = join(tempDir(), "example-server-1.2.3.tgz");
  mustWrite(tarball, "not really a tarball\n");
  return tarball;
}

describe("generation", () => {
  it("writes outputs that then check clean, and rewriting them changes nothing", () => {
    const root = newRepo();
    write(root, generate(root));
    expect(check(root, generate(root))).toEqual([]);

    const before = snapshot(root);
    write(root, generate(root));
    expect(snapshot(root)).toEqual(before);
  });

  it("reports changed, unexpected and missing outputs without writing", () => {
    const root = newRepo();
    write(root, generate(root));
    mustWrite(join(root, claudePluginDir, "skills", "example", "SKILL.md"), "edited by hand\n");
    mustWrite(join(root, codexPluginDir, "stray.txt"), "stray\n");
    mkdirSync(join(root, codexPluginDir, "skills", "empty"), { recursive: true });
    unlinkSync(join(root, claudeCatalogPath));

    const before = snapshot(root);
    expect(check(root, generate(root)).sort()).toEqual(
      [
        `changed: ${claudePluginDir}/skills/example/SKILL.md`,
        `unexpected: ${codexPluginDir}/stray.txt`,
        `unexpected directory: ${codexPluginDir}/skills/empty`,
        `missing: ${claudeCatalogPath}`,
      ].sort(),
    );
    expect(snapshot(root)).toEqual(before);
  });

  it("reports the files of a missing output directory as missing", () => {
    const root = newRepo();
    expect(check(root, generate(root))).toContain(
      `missing: ${claudePluginDir}/.claude-plugin/plugin.json`,
    );
  });

  it("removes stale outputs", () => {
    const root = newRepo();
    mustWrite(join(root, claudePluginDir, "skills", "retired", "SKILL.md"), "old\n");
    mkdirSync(join(root, codexPluginDir, "empty"), { recursive: true });
    write(root, generate(root));
    expect(check(root, generate(root))).toEqual([]);
  });

  // A branch can commit symlinks where outputs go. Generation must refuse a
  // symlinked or non-directory path component before removing or writing
  // anything, and must never write through a symlink.
  it.each<[string, (root: string, outside: string) => void]>([
    ["out is a symlink", (root, outside) => mustSymlink(outside, join(root, "out"))],
    [
      "the plugin directory is a symlink",
      (root, outside) => mustSymlink(outside, join(root, claudePluginDir)),
    ],
    [
      "the Claude catalog directory is a symlink",
      (root, outside) => mustSymlink(outside, join(root, ".claude-plugin")),
    ],
    [
      "the Codex catalog directory is a symlink",
      (root, outside) => mustSymlink(outside, join(root, ".agents", "plugins")),
    ],
    [
      "the catalog parent is a file",
      (root) => mustWrite(join(root, ".agents"), "not a directory\n"),
    ],
    [
      "the plugin directory is a file",
      (root) => mustWrite(join(root, claudePluginDir), "not a directory\n"),
    ],
    [
      "the catalog path is a directory",
      (root) => mustWrite(join(root, claudeCatalogPath, "inside.txt"), "a directory\n"),
    ],
  ])("refuses to generate when %s", (_, setup) => {
    const root = newRepo();
    const outside = tempDir();
    mustWrite(join(outside, "precious.txt"), "keep me\n");
    setup(root, outside);
    // A stale output that a write would delete if it got that far.
    mustWrite(join(root, codexPluginDir, "stale.txt"), "stale\n");
    const generated = generate(root);

    const rootBefore = snapshot(root);
    const outsideBefore = snapshot(outside);
    expect(() => write(root, generated)).toThrow();
    expect(() => check(root, generated)).toThrow();
    expect(snapshot(root)).toEqual(rootBefore);
    expect(snapshot(outside)).toEqual(outsideBefore);
  });

  // Git records whether a file is executable, so a skill's script must keep its
  // executable bit in the plugins, and a drifted bit is drift.
  it("carries each skill file's executable bit into the outputs and checks it", () => {
    const root = newRepo();
    const script = "skills/example/scripts/run.sh";
    mustWrite(join(root, "apps/agent-plugin", script), "#!/bin/sh\n");
    chmodSync(join(root, "apps/agent-plugin", script), 0o755);
    write(root, generate(root));
    for (const dir of [claudePluginDir, codexPluginDir]) {
      expect(statSync(join(root, dir, script)).mode & 0o777).toBe(0o755);
      expect(statSync(join(root, dir, "skills/example/SKILL.md")).mode & 0o777).toBe(0o644);
    }
    expect(check(root, generate(root))).toEqual([]);

    chmodSync(join(root, claudePluginDir, script), 0o644);
    expect(check(root, generate(root))).toEqual([
      `executable bit changed: ${claudePluginDir}/${script}`,
    ]);
  });

  it("replaces symlinked output files instead of following them", () => {
    const root = newRepo();
    const outside = tempDir();
    mustWrite(join(outside, "bashrc"), "keep me\n");
    mustWrite(join(outside, "dir", "precious.txt"), "keep me\n");
    mustSymlink(join(outside, "bashrc"), join(root, claudeCatalogPath));
    mustSymlink(join(outside, "dir"), join(root, codexPluginDir, "skills"));

    const outsideBefore = snapshot(outside);
    write(root, generate(root));
    expect(snapshot(outside)).toEqual(outsideBefore);
    expect(check(root, generate(root))).toEqual([]);
  });

  // The release process bumps the definition's version, so every rendered
  // manifest must carry it. Each catalog must take its name and owner from the
  // plugin and point at a directory holding that host's manifest.
  it("renders outputs consistent with the definition", () => {
    const root = newRepo();
    write(root, generate(root));

    for (const manifest of [
      join(claudePluginDir, ".claude-plugin", "plugin.json"),
      join(codexPluginDir, ".codex-plugin", "plugin.json"),
    ]) {
      expect(readJSON(join(root, manifest))).toMatchObject({ name: "example", version: "1.2.3" });
    }

    const claude = readJSON(join(root, claudeCatalogPath));
    expect(claude).toMatchObject({
      name: "example",
      owner: { name: "Example Author" },
      plugins: [{ name: "example" }],
    });
    const claudeSource = (claude["plugins"] as [{ source: string }])[0].source;
    expect(statSync(join(root, claudeSource, ".claude-plugin", "plugin.json")).isFile()).toBe(true);

    const codex = readJSON(join(root, codexCatalogPath));
    expect(codex).toMatchObject({
      name: "example",
      plugins: [{ name: "example", source: { source: "local" } }],
    });
    const codexSource = (codex["plugins"] as [{ source: { path: string } }])[0].source.path;
    expect(statSync(join(root, codexSource, ".codex-plugin", "plugin.json")).isFile()).toBe(true);
  });

  // Each host reads .mcp.json at the plugin root. Claude Code passes a server
  // its whole environment, while Codex passes only the variables it lists.
  it("declares the MCP server for each host", () => {
    const root = newRepo();
    write(root, generate(root));
    const launch = { command: "npx", args: ["-y", "@example/server@1.2.3"] };
    expect(readJSON(join(root, claudePluginDir, ".mcp.json"))).toEqual({
      mcpServers: { "example-server": launch },
    });
    expect(readJSON(join(root, codexPluginDir, ".mcp.json"))).toEqual({
      mcpServers: { "example-server": { ...launch, env_vars: ["EXAMPLE_URL", "EXAMPLE_NAME"] } },
    });
  });

  // Codex reads a limit on each tool call's time from the plugin; Claude
  // Code's plugin format has no such field.
  it("gives Codex the tool timeout the definition sets", () => {
    const root = newRepo(
      validDefinition.replace(
        `"environment": ["EXAMPLE_URL", "EXAMPLE_NAME"]`,
        `"environment": ["EXAMPLE_URL", "EXAMPLE_NAME"], "toolTimeoutSeconds": 600`,
      ),
    );
    write(root, generate(root));
    const launch = { command: "npx", args: ["-y", "@example/server@1.2.3"] };
    expect(readJSON(join(root, claudePluginDir, ".mcp.json"))).toEqual({
      mcpServers: { "example-server": launch },
    });
    expect(readJSON(join(root, codexPluginDir, ".mcp.json"))).toEqual({
      mcpServers: {
        "example-server": {
          ...launch,
          env_vars: ["EXAMPLE_URL", "EXAMPLE_NAME"],
          tool_timeout_sec: 600,
        },
      },
    });
  });
});

// Only Claude Code offers a plugin a hook that wakes an open session, so only
// its plugin carries the hooks: hooks.json and the scripts, executable, and
// nothing else of the hooks directory.
describe("hooks", () => {
  it("are copied into the Claude Code plugin alone", () => {
    const plain = newRepo();
    const hooked = newRepo();
    const hooks = join(hooked, hooksPath);
    mustWrite(join(hooks, "hooks.json"), '{"hooks": {}}\n');
    mustWrite(join(hooks, "watch.sh"), "#!/bin/sh\n");
    chmodSync(join(hooks, "watch.sh"), 0o755);
    mustWrite(join(hooks, "watch.test.ts"), "// a test\n");
    write(plain, generate(plain));
    write(hooked, generate(hooked));
    expect(readdirSync(join(hooked, claudePluginDir, "hooks")).sort()).toEqual([
      "hooks.json",
      "watch.sh",
    ]);
    expect(statSync(join(hooked, claudePluginDir, "hooks", "watch.sh")).mode & 0o777).toBe(0o755);
    const codex = (root: string) =>
      new Map(
        [...snapshot(join(root, codexPluginDir))].map(([name, entry]) => [
          relative(root, name),
          entry,
        ]),
      );
    expect(codex(hooked)).toEqual(codex(plain));
    expect(check(hooked, generate(hooked))).toEqual([]);
  });
});

describe("sources", () => {
  it.each([
    ["an unknown field", validDefinition.replace(`"license"`, `"licence"`)],
    [
      "an unknown author field",
      validDefinition.replace(`"Example Author"}`, `"Example Author", "email": "a@b.c"}`),
    ],
    ["a bad name", validDefinition.replace(`"example"`, `"Example Plugin"`)],
    ["a bad version", validDefinition.replace(`"1.2.3"`, `"v1.2"`)],
    ["no description", validDefinition.replace(`"An example plugin."`, `""`)],
    ["no author", validDefinition.replace(`"Example Author"`, `""`)],
    ["an empty optional field", validDefinition.replace(`"MIT"`, `""`)],
    ["an empty keyword list", validDefinition.replace(`["one", "two"]`, `[]`)],
    ["an empty keyword", validDefinition.replace(`["one", "two"]`, `[""]`)],
    ["a wrongly typed field", validDefinition.replace(`["one", "two"]`, `"one, two"`)],
    ["no MCP server", validDefinition.replace(/,\s*"mcpServer": \{[^}]*\}/, "")],
    [
      "an unknown MCP server field",
      validDefinition.replace(`"environment"`, `"env": {}, "environment"`),
    ],
    [
      "a tool timeout that is not a positive whole number",
      validDefinition.replace(`"environment"`, `"toolTimeoutSeconds": 0.5, "environment"`),
    ],
    ["a bad MCP server name", validDefinition.replace(`"example-server"`, `"Example Server"`)],
    [
      "an MCP server package with a version",
      validDefinition.replace(`"@example/server"`, `"@example/server@1.2.3"`),
    ],
    [
      "an MCP server package with a bad name",
      validDefinition.replace(`"@example/server"`, `"@Example/Server"`),
    ],
    ["no MCP server environment", validDefinition.replace(`["EXAMPLE_URL", "EXAMPLE_NAME"]`, `[]`)],
    ["an empty environment variable", validDefinition.replace(`"EXAMPLE_NAME"`, `""`)],
    ["trailing data", `${validDefinition}{}\n`],
    ["no JSON", "name: example\n"],
    ["a JSON array", "[]\n"],
  ])("rejects a definition with %s", (_, content) => {
    const root = newRepo();
    mustWrite(join(root, definitionPath), content);
    expect(() => loadSources(root)).toThrow();
  });

  it.each<[string, (skills: string) => void]>([
    [
      "a skill without SKILL.md",
      (skills) => mustWrite(join(skills, "empty", "notes.md"), "notes\n"),
    ],
    ["a file at the top level", (skills) => mustWrite(join(skills, "README.md"), "readme\n")],
    ["a badly named skill", (skills) => mustWrite(join(skills, "Bad_Name", "SKILL.md"), "skill\n")],
    [
      "a symlinked skill file",
      (skills) => {
        const target = join(tempDir(), "secret");
        mustWrite(target, "outside the tree\n");
        mustSymlink(target, join(skills, "example", "linked.md"));
      },
    ],
    ["a dotfile", (skills) => mustWrite(join(skills, "example", ".env"), "TOKEN=x\n")],
    [
      "a dot directory",
      (skills) => mustWrite(join(skills, "example", ".cache", "notes.md"), "notes\n"),
    ],
  ])("rejects skills with %s", (_, setup) => {
    const root = newRepo();
    setup(join(root, skillsPath));
    expect(() => loadSources(root)).toThrow();
  });

  // The sources are contributor-authored and must live in the tree: a
  // symlinked skills directory or definition would render content from outside
  // it.
  it.each([
    ["skills directory", skillsPath],
    ["definition", definitionPath],
  ])("rejects a symlinked %s", (_, rel) => {
    const root = newRepo();
    const source = join(root, rel);
    const moved = join(tempDir(), "moved");
    renameSync(source, moved);
    mustSymlink(moved, source);
    expect(() => loadSources(root)).toThrow();
  });
});

describe("command line", () => {
  it("exits 1 on drift, 0 when clean, and 2 on a usage error", () => {
    const root = newRepo();
    const tarball = newTarball();
    const out = join(tempDir(), "plugins");
    const steps: [string[], number][] = [
      [["--root", root, "--check"], 1],
      [["--root", root], 0],
      [["--root", root, "--check"], 0],
      [["--no-such-flag"], 2],
      [["extra"], 2],
      [["--root", root, "--bridge-package", tarball], 2],
      [["--root", root, "--out", out], 2],
      [["--root", root, "--check", "--bridge-package", tarball, "--out", out], 2],
      [["--root", root, "--bridge-package", tarball, "--out", ""], 2],
      [["--help", "--out", out], 0],
    ];
    for (const [args, want] of steps) {
      expect(run(args, discard, discard), args.join(" ")).toBe(want);
    }
  });
});

// A development render runs the MCP server from a package tarball, and is
// written only to a directory it creates, so it can never overwrite the
// committed outputs or anything else.
describe("development render", () => {
  it("writes plugins that run the tarball, differing only in the package arguments", () => {
    const root = newRepo();
    write(root, generate(root));
    const repository = snapshot(root);
    const tarball = newTarball();
    const out = join(tempDir(), "plugins");

    // A relative path is resolved, since hosts start servers in a directory
    // of their own choosing.
    const args = ["--root", root, "--bridge-package", relative(process.cwd(), tarball)];
    expect(run([...args, "--out", out], discard, discard)).toBe(0);
    expect(snapshot(root)).toEqual(repository);

    const local = ["-y", `--package=${tarball}`, "server"];
    expect(readJSON(join(out, claudePluginDir, ".mcp.json"))).toEqual({
      mcpServers: { "example-server": { command: "npx", args: local } },
    });
    expect(readJSON(join(out, codexPluginDir, ".mcp.json"))).toEqual({
      mcpServers: {
        "example-server": {
          command: "npx",
          args: local,
          env_vars: ["EXAMPLE_URL", "EXAMPLE_NAME"],
        },
      },
    });
    const mcpFiles = [claudePluginDir, codexPluginDir].map((dir) => join(dir, ".mcp.json"));
    expect(check(out, generate(root)).sort()).toEqual(
      mcpFiles.map((path) => `changed: ${path}`).sort(),
    );
  });

  // Each case returns the --out path, made under base or, for the repository,
  // the repository itself.
  it.each<[string, (root: string, base: string) => string]>([
    ["an empty directory", (_, base) => base],
    [
      "a directory holding catalogs and plugins",
      (_, base) => {
        mustWrite(join(base, claudeCatalogPath), "someone else's catalog\n");
        mustWrite(join(base, claudePluginDir, "notes.txt"), "keep me\n");
        return base;
      },
    ],
    ["the repository", (root) => root],
    [
      "a symlink to a directory",
      (_, base) => {
        mustWrite(join(base, "target", "keep.txt"), "keep me\n");
        symlinkSync(join(base, "target"), join(base, "link"));
        return join(base, "link");
      },
    ],
    [
      "a dangling symlink",
      (_, base) => {
        symlinkSync(join(base, "missing"), join(base, "link"));
        return join(base, "link");
      },
    ],
  ])("refuses %s as --out and changes nothing", (_, outFor) => {
    const root = newRepo();
    write(root, generate(root));
    const base = tempDir();
    const out = outFor(root, base);
    const before = [snapshot(root), snapshot(base)];
    const args = ["--root", root, "--bridge-package", newTarball(), "--out", out];
    expect(run(args, discard, discard)).toBe(1);
    expect([snapshot(root), snapshot(base)]).toEqual(before);
  });

  it.each<[string, () => string]>([
    ["a missing file", () => join(tempDir(), "missing.tgz")],
    [
      "a file npm would take for a package directory",
      () => {
        const file = join(tempDir(), "server.zip");
        mustWrite(file, "zip\n");
        return file;
      },
    ],
    [
      "a directory",
      () => {
        const dir = join(tempDir(), "server.tgz");
        mkdirSync(dir);
        return dir;
      },
    ],
  ])("refuses %s as the package tarball", (_, tarball) => {
    const root = newRepo();
    const out = join(tempDir(), "plugins");
    const args = ["--root", root, "--bridge-package", tarball(), "--out", out];
    expect(run(args, discard, discard)).toBe(1);
    expect(readdirSync(dirname(out))).toEqual([]);
  });
});

// The plugins run the bridge by its package name at the plugin's version, and
// a packed bridge by its command, so the bridge's package must agree on all
// three. release-please sets both versions together.
describe("the repository's plugin definition", () => {
  it("names the bridge's package and command, at the bridge's version", () => {
    const repository = join(import.meta.dirname, "..", "..", "..");
    const { mcpServer, version } = loadSources(repository).definition;
    const bridge = readJSON(join(repository, "apps", "bridge", "package.json"));
    expect(bridge["name"]).toBe(mcpServer.package);
    expect(Object.keys(bridge["bin"] as object)).toContain(unscopedName(mcpServer.package));
    expect(bridge["version"]).toBe(version);
  });
});
