import { posix } from "node:path";
import { type Definition, type Sources, unscopedName } from "./definition.ts";
import type { FileContent } from "./output.ts";

// Repository-relative locations of the generated outputs.
export const claudePluginDir = "out/claude-plugin";
export const codexPluginDir = "out/codex-plugin";
export const claudeCatalogPath = ".claude-plugin/marketplace.json";
export const codexCatalogPath = ".agents/plugins/marketplace.json";

// Generated is the complete generated state. Paths are slash-separated.
export interface Generated {
  // Each generator-owned directory, relative to the repository root, mapped to
  // its files, relative to that directory. Writing replaces a directory's
  // contents; checking fails on anything it does not expect.
  dirs: Map<string, Map<string, FileContent>>;
  // Standalone files, relative to the repository root.
  files: Map<string, FileContent>;
}

// render produces the generated state from validated sources. It is pure, so
// writing and checking compare against exactly the same bytes. Each catalog
// lists the one plugin and takes its name and owner from the plugin.
//
// packageFile, an absolute path to a tarball of the MCP server's package as
// npm pack writes it, makes the plugins run that tarball in place of the
// published package. It is for trying an unreleased server, so outputs
// rendered with it never belong in the repository.
export function render(
  { definition: def, skills, claudeHooks }: Sources,
  packageFile?: string,
): Generated {
  // Both hosts read the same plugin manifest. Optional fields the definition
  // leaves out are undefined here, so JSON.stringify omits them.
  const manifest = encodeJSON({
    name: def.name,
    version: def.version,
    description: def.description,
    skills: "./skills/",
    author: { name: def.author.name },
    homepage: def.homepage,
    repository: def.repository,
    license: def.license,
    keywords: def.keywords,
  });
  // Both hosts read a plugin's MCP servers from .mcp.json at its root. Claude
  // Code passes a server its whole environment; Codex passes only a few
  // common variables, such as HOME and PATH, and those the server lists.
  // Codex also reads a limit on each tool call's time there, which Claude
  // Code's plugin format has no field for.
  const server = def.mcpServer;
  const launch = { command: "npx", args: npxArgs(def, packageFile) };
  const claudeMcp = encodeJSON({ mcpServers: { [server.name]: launch } });
  const codexMcp = encodeJSON({
    mcpServers: {
      [server.name]: {
        ...launch,
        env_vars: server.environment,
        tool_timeout_sec: server.toolTimeoutSeconds,
      },
    },
  });
  // Only Claude Code offers a plugin a hook that wakes an open session, so
  // only its plugin carries the hooks.
  const plugin = (manifestDir: string, mcp: FileContent, hooks = new Map<string, FileContent>()) =>
    new Map([
      [posix.join(manifestDir, "plugin.json"), manifest],
      [".mcp.json", mcp],
      ...[...skills].map(([path, file]): [string, FileContent] => [
        posix.join("skills", path),
        file,
      ]),
      ...[...hooks].map(([name, file]): [string, FileContent] => [posix.join("hooks", name), file]),
    ]);

  const claudeCatalog = encodeJSON({
    name: def.name,
    owner: { name: def.author.name },
    plugins: [{ name: def.name, description: def.description, source: `./${claudePluginDir}` }],
  });
  const codexCatalog = encodeJSON({
    name: def.name,
    plugins: [{ name: def.name, source: { source: "local", path: `./${codexPluginDir}` } }],
  });

  return {
    dirs: new Map([
      [claudePluginDir, plugin(".claude-plugin", claudeMcp, claudeHooks)],
      [codexPluginDir, plugin(".codex-plugin", codexMcp)],
    ]),
    files: new Map([
      [claudeCatalogPath, claudeCatalog],
      [codexCatalogPath, codexCatalog],
    ]),
  };
}

// npxArgs are the arguments that run the MCP server with npx, without a
// prompt to install it: its package at the plugin's version. npm runs a bare
// tarball path as a command rather than a package, so a package file is named
// with --package, followed by the command, which this takes to be named after
// the package without its scope.
function npxArgs({ mcpServer, version }: Definition, packageFile: string | undefined): string[] {
  if (packageFile === undefined) {
    return ["-y", `${mcpServer.package}@${version}`];
  }
  return ["-y", `--package=${packageFile}`, unscopedName(mcpServer.package)];
}

// encodeJSON renders a value as a JSON file with two-space indentation and a
// trailing newline. This is the layout release-please writes when it bumps a
// version in a JSON file, so a release bump leaves the generated files exactly
// as the generator would write them.
function encodeJSON(value: unknown): FileContent {
  return { data: Buffer.from(`${JSON.stringify(value, null, 2)}\n`), executable: false };
}
