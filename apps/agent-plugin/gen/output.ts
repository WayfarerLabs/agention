import { randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import type { Generated } from "./render.ts";

// FileContent is a file's bytes and whether it is executable, the one mode bit
// git records.
export interface FileContent {
  data: Buffer;
  executable: boolean;
}

export function isExecutable(mode: number): boolean {
  return (mode & 0o100) !== 0;
}

// requireRealDirs checks that every existing component of the slash-separated
// directory rel below root is a real directory, not a symlink or a file.
export function requireRealDirs(root: string, rel: string): void {
  let current = root;
  for (const part of rel.split("/")) {
    current = join(current, part);
    const stats = lstatSync(current, { throwIfNoEntry: false });
    if (stats === undefined) {
      return; // nothing below a missing component exists either
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${current} is a symlink`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`${current} is not a directory`);
    }
  }
}

// guardOutputs refuses to touch the outputs if any existing component of an
// output path below root is a symlink or not a directory, or if a directory
// stands where a catalog file goes. A checked-out branch can commit symlinks,
// and following one would let generation delete or overwrite files outside
// the repository. A symlinked catalog file is allowed: writeFile replaces it.
function guardOutputs(root: string, generated: Generated): void {
  try {
    for (const dir of generated.dirs.keys()) {
      requireRealDirs(root, dir);
    }
    for (const path of generated.files.keys()) {
      requireRealDirs(root, posix.dirname(path));
      const name = join(root, path);
      if (lstatSync(name, { throwIfNoEntry: false })?.isDirectory()) {
        throw new Error(`${name} is a directory`);
      }
    }
  } catch (error) {
    throw new Error(`refusing to generate: ${(error as Error).message}`);
  }
}

// write replaces the generated state under root. Nothing is removed or written
// unless every output path passes the guard.
export function write(root: string, generated: Generated): void {
  guardOutputs(root, generated);
  for (const [dir, files] of generated.dirs) {
    // rmSync deletes symlinks inside the directory without following them.
    rmSync(join(root, dir), { recursive: true, force: true });
    for (const [path, file] of files) {
      writeFile(join(root, dir, path), file);
    }
  }
  for (const [path, file] of generated.files) {
    writeFile(join(root, path), file);
  }
}

// writeFile replaces name with the file, mode 0755 if it is executable and
// 0644 otherwise. It writes a new file in the same directory and renames it
// over name, so if name is a symlink the link itself is replaced and its
// target is never written.
function writeFile(name: string, file: FileContent): void {
  const mode = file.executable ? 0o755 : 0o644;
  const dir = dirname(name);
  mkdirSync(dir, { recursive: true, mode: 0o755 });
  const temp = join(dir, `.gen-${randomBytes(8).toString("hex")}`);
  try {
    // "wx" fails rather than open anything already at the temporary name.
    const fd = openSync(temp, "wx", mode);
    try {
      writeFileSync(fd, file.data);
      fchmodSync(fd, mode);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, name);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

// check compares the generated state under root with the expected one without
// writing anything, and returns one description per difference.
export function check(root: string, generated: Generated): string[] {
  guardOutputs(root, generated);
  const drift: string[] = [];
  for (const [dir, files] of generated.dirs) {
    drift.push(...diffDir(root, dir, files));
  }
  for (const [path, file] of generated.files) {
    const difference = compareFile(root, path, file);
    if (difference !== undefined) {
      drift.push(difference);
    }
  }
  return drift;
}

// diffDir reports unexpected files and directories (empty ones included), and
// missing and changed files, in the generator-owned directory rel.
function diffDir(root: string, rel: string, want: Map<string, FileContent>): string[] {
  const wantDirs = new Set<string>();
  for (const path of want.keys()) {
    for (let dir = posix.dirname(path); dir !== "."; dir = posix.dirname(dir)) {
      wantDirs.add(dir);
    }
  }
  const drift: string[] = [];
  const walk = (current: string, prefix: string): void => {
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (!entry.isDirectory()) {
        if (!want.has(path)) {
          drift.push(`unexpected: ${rel}/${path}`);
        }
      } else if (wantDirs.has(path)) {
        walk(join(current, entry.name), path);
      } else {
        drift.push(`unexpected directory: ${rel}/${path}`);
      }
    }
  };
  // A missing directory is not walked; every expected file is reported
  // missing below.
  if (lstatSync(join(root, rel), { throwIfNoEntry: false }) !== undefined) {
    walk(join(root, rel), "");
  }
  for (const [path, file] of want) {
    const difference = compareFile(root, `${rel}/${path}`, file);
    if (difference !== undefined) {
      drift.push(difference);
    }
  }
  return drift;
}

// compareFile describes how the file at the repository-relative path differs
// from the expected one, or returns undefined when it matches. Of the mode,
// only the executable bit is compared, since it is the only bit git records.
function compareFile(root: string, path: string, file: FileContent): string | undefined {
  const name = join(root, path);
  let got: FileContent;
  try {
    const stats = lstatSync(name, { throwIfNoEntry: false });
    if (stats === undefined) {
      return `missing: ${path}`;
    }
    if (!stats.isFile()) {
      return `not a regular file: ${path}`;
    }
    got = { data: readFileSync(name), executable: isExecutable(stats.mode) };
  } catch (error) {
    return `unreadable: ${path}: ${(error as Error).message}`;
  }
  if (!got.data.equals(file.data)) {
    return `changed: ${path}`;
  }
  return got.executable === file.executable ? undefined : `executable bit changed: ${path}`;
}
