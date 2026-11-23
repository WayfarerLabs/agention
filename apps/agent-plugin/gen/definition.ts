import { type Dirent, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { type FileContent, isExecutable, requireRealDirs } from "./output.ts";

// Repository-relative locations of the canonical sources.
export const definitionPath = "apps/agent-plugin/plugin.json";
export const skillsPath = "apps/agent-plugin/skills";
export const hooksPath = "apps/agent-plugin/hooks";

// Plugin and skill names are lowercase words joined by hyphens, which every
// host accepts as a directory name and an identifier.
const namePattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// A hook script is named like a plugin, as a POSIX shell script.
const scriptPattern = /^[a-z0-9]+(-[a-z0-9]+)*\.sh$/;
// Claude Code names its hook events in PascalCase, such as SessionStart.
const eventPattern = /^[A-Z][a-z]+([A-Z][a-z]+)*$/;
// Release versions are plain semantic versions; release-please writes them.
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$/;
// npm package names, optionally scoped, in the lowercase form npm publishes.
const packageNamePattern = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

// The canonical plugin definition. Its metadata exists once here and is
// rendered into every host's plugin and catalog.
export interface Definition {
  name: string;
  version: string;
  description: string;
  // The plugin author, who is also the catalogs' owner.
  author: { name: string };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  mcpServer: McpServer;
  // The hook that wakes an agent at Claude Code's prompt when the MCP server
  // writes a wake file, which only the Claude Code plugin carries: Codex
  // offers a plugin no way to wake an open session.
  claudeWakeHook?: WakeHook;
}

// A command hook Claude Code runs in the background (asyncRewake), which
// wakes the agent by exiting 2.
export interface WakeHook {
  // The script, a file in apps/agent-plugin/hooks/, which the plugin carries
  // at hooks/ with its executable bit.
  script: string;
  // The Claude Code hook events that start it.
  events: string[];
  // How long Claude Code lets one run, in seconds.
  timeoutSeconds: number;
}

// The MCP server the plugin starts, an npm package that every host runs with
// npx at the plugin's version, so each release's plugins run the server
// released with them.
export interface McpServer {
  // The server's name in each host's MCP configuration.
  name: string;
  // The npm package name, such as "@scope/server".
  package: string;
  // The server's configuration variables. A host that passes a server only
  // the environment variables it lists is given these.
  environment: string[];
  // How long one tool call may take, in seconds, written for a host whose
  // plugin configuration sets a limit of its own (Codex's tool_timeout_sec),
  // so a large file's transfer is not cut off by the host's default.
  toolTimeoutSeconds?: number;
}

const definitionFields = new Set([
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "mcpServer",
  "claudeWakeHook",
]);

const mcpServerFields = new Set(["name", "package", "environment", "toolTimeoutSeconds"]);

const wakeHookFields = new Set(["script", "events", "timeoutSeconds"]);

// Everything rendering needs, loaded and validated.
export interface Sources {
  definition: Definition;
  // Each skill file's slash-separated path under skills/, mapped to its
  // content and executable bit, both copied into each host's plugin.
  skills: Map<string, FileContent>;
  // The wake hook's script, when the definition has a wake hook.
  wakeHookScript?: FileContent;
}

// loadSources reads and validates the canonical definition and skills under
// root. Both are contributor-authored input, so this is the trust boundary:
// rendering assumes what it receives is well formed.
export function loadSources(root: string): Sources {
  // The sources must live in the tree itself: a symlinked source directory or
  // definition would pull content from outside the repository.
  for (const rel of [posix.dirname(definitionPath), skillsPath, hooksPath]) {
    try {
      requireRealDirs(root, rel);
    } catch (error) {
      throw new Error(`plugin sources: ${(error as Error).message}`);
    }
  }
  const definitionFile = join(root, definitionPath);
  if (lstatSync(definitionFile, { throwIfNoEntry: false })?.isFile() === false) {
    throw new Error(`plugin sources: ${definitionFile} is not a regular file`);
  }
  const definition = loadDefinition(definitionFile);
  const hook = definition.claudeWakeHook;
  return {
    definition,
    skills: loadSkills(join(root, skillsPath)),
    ...(hook === undefined ? {} : { wakeHookScript: loadHookScript(root, hook.script) }),
  };
}

// loadHookScript reads a hook's script: a regular, executable file in the
// hooks directory, never a symlink, which could pull content from outside the
// tree.
function loadHookScript(root: string, script: string): FileContent {
  const file = join(root, hooksPath, script);
  const stats = lstatSync(file, { throwIfNoEntry: false });
  if (stats === undefined || !stats.isFile()) {
    throw new Error(`plugin sources: hook script ${file} is not a regular file`);
  }
  if (!isExecutable(stats.mode)) {
    throw new Error(`plugin sources: hook script ${file} is not executable`);
  }
  return { data: readFileSync(file), executable: true };
}

function loadDefinition(file: string): Definition {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`read plugin definition ${file}: ${(error as Error).message}`);
  }
  const problems = definitionProblems(raw);
  if (problems.length > 0) {
    throw new Error(`plugin definition ${file}: ${problems.join("; ")}`);
  }
  return raw as Definition;
}

// definitionProblems describes everything wrong with a parsed definition. An
// optional field that is present must have a value: an empty one would render
// a manifest entry that says nothing.
function definitionProblems(raw: unknown): string[] {
  if (!isRecord(raw)) {
    return ["the definition must be a JSON object"];
  }
  const problems = Object.keys(raw)
    .filter((key) => !definitionFields.has(key))
    .map((key) => `unknown field ${JSON.stringify(key)}`);
  const { name, version, description, author, keywords } = raw;
  if (typeof name !== "string" || !namePattern.test(name)) {
    problems.push(`name ${JSON.stringify(name)} must be lowercase words joined by hyphens`);
  }
  if (typeof version !== "string" || !versionPattern.test(version)) {
    problems.push(`version ${JSON.stringify(version)} must be a semantic version`);
  }
  if (!isText(description)) {
    problems.push("description is required");
  }
  if (!isRecord(author) || !isText(author.name)) {
    problems.push("author.name is required");
  } else {
    for (const key of Object.keys(author).filter((key) => key !== "name")) {
      problems.push(`unknown field ${JSON.stringify(`author.${key}`)}`);
    }
  }
  for (const key of ["homepage", "repository", "license"]) {
    if (raw[key] !== undefined && !isText(raw[key])) {
      problems.push(`${key} must be a non-empty string when present`);
    }
  }
  if (
    keywords !== undefined &&
    !(Array.isArray(keywords) && keywords.length > 0 && keywords.every(isText))
  ) {
    problems.push("keywords must be a non-empty list of non-empty strings when present");
  }
  problems.push(...mcpServerProblems(raw.mcpServer));
  if (raw.claudeWakeHook !== undefined) {
    problems.push(...wakeHookProblems(raw.claudeWakeHook));
  }
  return problems;
}

// wakeHookProblems describes everything wrong with the wake hook.
function wakeHookProblems(raw: unknown): string[] {
  if (!isRecord(raw)) {
    return ["claudeWakeHook must be an object when present"];
  }
  const problems = Object.keys(raw)
    .filter((key) => !wakeHookFields.has(key))
    .map((key) => `unknown field ${JSON.stringify(`claudeWakeHook.${key}`)}`);
  if (typeof raw.script !== "string" || !scriptPattern.test(raw.script)) {
    problems.push(
      `claudeWakeHook.script ${JSON.stringify(raw.script)} must be lowercase words joined by ` +
        "hyphens, ending in .sh",
    );
  }
  const { events } = raw;
  if (!(
    Array.isArray(events) &&
    events.length > 0 &&
    events.every((event) => typeof event === "string" && eventPattern.test(event)) &&
    new Set(events).size === events.length
  )) {
    problems.push("claudeWakeHook.events must be a non-empty list of distinct hook event names");
  }
  const { timeoutSeconds } = raw;
  if (!(Number.isSafeInteger(timeoutSeconds) && (timeoutSeconds as number) > 0)) {
    problems.push("claudeWakeHook.timeoutSeconds must be a positive whole number");
  }
  return problems;
}

// mcpServerProblems describes everything wrong with the MCP server.
function mcpServerProblems(raw: unknown): string[] {
  if (!isRecord(raw)) {
    return ["mcpServer is required"];
  }
  const problems = Object.keys(raw)
    .filter((key) => !mcpServerFields.has(key))
    .map((key) => `unknown field ${JSON.stringify(`mcpServer.${key}`)}`);
  if (typeof raw.name !== "string" || !namePattern.test(raw.name)) {
    problems.push(
      `mcpServer.name ${JSON.stringify(raw.name)} must be lowercase words joined by hyphens`,
    );
  }
  if (typeof raw.package !== "string" || !packageNamePattern.test(raw.package)) {
    problems.push(
      `mcpServer.package ${JSON.stringify(raw.package)} must be an npm package name without a version`,
    );
  }
  const { environment } = raw;
  if (!(Array.isArray(environment) && environment.length > 0 && environment.every(isText))) {
    problems.push("mcpServer.environment must be a non-empty list of non-empty strings");
  }
  const { toolTimeoutSeconds } = raw;
  if (
    toolTimeoutSeconds !== undefined &&
    !(Number.isSafeInteger(toolTimeoutSeconds) && (toolTimeoutSeconds as number) > 0)
  ) {
    problems.push("mcpServer.toolTimeoutSeconds must be a positive whole number when present");
  }
  return problems;
}

// unscopedName returns a package name without its scope: "@scope/server"
// gives "server".
export function unscopedName(name: string): string {
  return name.slice(name.indexOf("/") + 1);
}

// loadSkills reads every skill directory. Each top-level entry must be a
// directory with a valid name and a SKILL.md. Only regular, non-hidden files
// are accepted: a symlink could pull content from outside the source tree, and
// a dotfile would ship in a plugin without showing in a listing.
function loadSkills(dir: string): Map<string, FileContent> {
  const top = readDir(dir);
  if (top.length === 0) {
    throw new Error(`skills directory ${dir} has no skills`);
  }
  for (const entry of top) {
    if (!entry.isDirectory() || !namePattern.test(entry.name)) {
      throw new Error(
        `skills directory ${dir}: ${entry.name} must be a directory named in lowercase words joined by hyphens`,
      );
    }
    if (!lstatSync(join(dir, entry.name, "SKILL.md"), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`skill ${entry.name} has no SKILL.md file`);
    }
  }

  const skills = new Map<string, FileContent>();
  const walk = (current: string, prefix: string): void => {
    for (const entry of readDir(current)) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const name = join(current, entry.name);
      if (entry.name.startsWith(".")) {
        throw new Error(`skill source ${rel} is hidden`);
      } else if (entry.isDirectory()) {
        walk(name, rel);
      } else if (!entry.isFile()) {
        throw new Error(`skill source ${rel} is not a regular file`);
      } else {
        const executable = isExecutable(lstatSync(name).mode);
        skills.set(rel, { data: readFileSync(name), executable });
      }
    }
  };
  walk(dir, "");
  return skills;
}

// readDir lists a directory's entries in name order. Entries describe what is
// on disk, so a symlink is reported as a symlink, never as its target.
function readDir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  } catch (error) {
    throw new Error(`read skills: ${(error as Error).message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}
