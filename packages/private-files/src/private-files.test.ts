import { execFileSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendToPrivateFile,
  checkAncestor,
  checkPrivateFile,
  createPrivateFile,
  ensurePrivateDirectory,
  openPrivateFile,
  PrivateFileError,
  type PrivateFileReason,
  shellQuoted,
} from "./private-files.ts";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "agention-private-files-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function mode(target: string): number {
  return statSync(target).mode & 0o7777;
}

// refusalOf returns the PrivateFileError fn throws, or undefined if it throws none.
function refusalOf(fn: () => unknown): PrivateFileError | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(PrivateFileError);
    return error as PrivateFileError;
  }
  return undefined;
}

function reasonOf(fn: () => unknown): PrivateFileReason | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof PrivateFileError) {
      return error.reason;
    }
    throw error;
  }
  return undefined;
}

function withUmask(umask: string, fn: () => void): void {
  const previous = process.umask(parseInt(umask, 8));
  try {
    fn();
  } finally {
    process.umask(previous);
  }
}

// A file private to the user, with the text given.
function privateFile(file: string, text = "secret"): string {
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

describe("checkAncestor", () => {
  const user = { uid: 1000 };
  const directory = (uid: number, mode: number, isDirectory = true) => ({
    uid,
    mode,
    isDirectory: () => isDirectory,
  });

  it.each([
    ["the user's own directory", directory(1000, 0o755), undefined],
    ["a directory of root", directory(0, 0o755), undefined],
    ["a sticky directory anyone can write to", directory(0, 0o1777), undefined],
    ["a directory the user's own group can write to", directory(1000, 0o775), "writable_ancestor"],
    ["a directory others can write to", directory(1000, 0o757), "writable_ancestor"],
    ["another user's directory", directory(1001, 0o755), "foreign_ancestor"],
    ["a symlink or file", directory(1000, 0o755, false), "not_a_directory"],
  ])("judges %s", (_, status, reason) => {
    expect(reasonOf(() => checkAncestor("/some/dir", status, user))).toBe(reason);
  });
});

describe("ensurePrivateDirectory", () => {
  it.each(["000", "022", "077", "700"])(
    "creates directories with mode 0700 under umask %s",
    (umask) => {
      withUmask(umask, () => {
        const directory = path.join(root, "a", "b");
        ensurePrivateDirectory(directory);
        expect([mode(path.join(root, "a")), mode(directory)]).toEqual([0o700, 0o700]);
      });
    },
  );

  it("leaves the modes of directories that exist as they are", () => {
    const parent = path.join(root, "parent");
    mkdirSync(parent);
    chmodSync(parent, 0o755);
    ensurePrivateDirectory(path.join(parent, "data"));
    expect(mode(parent)).toBe(0o755);
  });

  it("resolves a symlinked directory on the path, and returns the real path", () => {
    const target = path.join(root, "target");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, path.join(root, "link"));
    expect(ensurePrivateDirectory(path.join(root, "link", "data"))).toBe(path.join(target, "data"));
    expect(mode(path.join(target, "data"))).toBe(0o700);
  });

  it("accepts a sticky directory others can write to above it", () => {
    const shared = path.join(root, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o1777);
    ensurePrivateDirectory(path.join(shared, "data"));
    expect(mode(path.join(shared, "data"))).toBe(0o700);
  });

  describe("refuses, creating nothing below the fault and changing nothing", () => {
    it.each([
      ["its group", 0o775],
      ["others", 0o757],
    ])("a directory above it that %s can write to", (_, writable) => {
      const parent = path.join(root, "parent");
      mkdirSync(parent);
      chmodSync(parent, writable);
      expect(reasonOf(() => ensurePrivateDirectory(path.join(parent, "a", "b")))).toBe(
        "writable_ancestor",
      );
      expect([mode(parent), readdirSync(parent)]).toEqual([writable, []]);
    });

    it.each([
      ["its group", 0o770],
      ["others", 0o707],
    ])("a symlink into a directory that %s can write to", (_, writable) => {
      const target = path.join(root, "target");
      mkdirSync(target);
      chmodSync(target, writable);
      symlinkSync(target, path.join(root, "link"));
      expect(reasonOf(() => ensurePrivateDirectory(path.join(root, "link", "data")))).toBe(
        "writable_ancestor",
      );
      expect(readdirSync(target)).toEqual([]);
    });

    it("a symlink that leads nowhere, in the place of a directory", () => {
      symlinkSync(path.join(root, "nowhere"), path.join(root, "link"));
      expect(reasonOf(() => ensurePrivateDirectory(path.join(root, "link", "data")))).toBe(
        "not_a_directory",
      );
      expect(existsSync(path.join(root, "nowhere"))).toBe(false);
    });

    it("a file in the place of a directory", () => {
      privateFile(path.join(root, "file"));
      expect(reasonOf(() => ensurePrivateDirectory(path.join(root, "file", "data")))).toBe(
        "not_a_directory",
      );
    });

    it.each([
      ["read", 0o750],
      ["write to", 0o775],
    ])("a directory that others can %s, as itself not private", (_, open) => {
      const directory = path.join(root, "data");
      mkdirSync(directory);
      chmodSync(directory, open);
      expect(reasonOf(() => ensurePrivateDirectory(directory))).toBe("directory_not_private");
      expect(mode(directory)).toBe(open);
    });
  });

  describe("refuses, with the error code, a path it cannot reach", () => {
    it("through a symlink loop", () => {
      symlinkSync("loop", path.join(root, "loop"));
      const refusal = refusalOf(() => ensurePrivateDirectory(path.join(root, "loop", "data")));
      expect([refusal?.reason, refusal?.code]).toEqual(["inaccessible", "ELOOP"]);
    });

    it("with a name too long for the file system", () => {
      const refusal = refusalOf(() => ensurePrivateDirectory(path.join(root, "x".repeat(300))));
      expect([refusal?.reason, refusal?.code]).toEqual(["inaccessible", "ENAMETOOLONG"]);
    });

    // The superuser can search any directory.
    it.skipIf(process.geteuid?.() === 0)("below a directory this user cannot search", () => {
      const locked = path.join(root, "locked");
      mkdirSync(locked, { mode: 0o700 });
      chmodSync(locked, 0o600);
      try {
        for (const operation of [
          () => ensurePrivateDirectory(path.join(locked, "data")),
          () => openPrivateFile(path.join(locked, "data", "secret")),
          () => checkPrivateFile(path.join(locked, "secret")),
        ]) {
          const refusal = refusalOf(operation);
          expect([refusal?.reason, refusal?.code]).toEqual(["inaccessible", "EACCES"]);
        }
      } finally {
        chmodSync(locked, 0o700);
      }
    });
  });
});

describe("createPrivateFile", () => {
  it.each(["000", "022", "077", "700"])(
    "creates an empty file with mode 0600 under umask %s",
    (umask) => {
      withUmask(umask, () => {
        const file = path.join(root, "secret");
        const fd = createPrivateFile(file);
        expect(fd).toEqual(expect.any(Number));
        closeSync(fd as number);
        expect([mode(file), readFileSync(file, "utf8")]).toEqual([0o600, ""]);
      });
    },
  );

  it("creates the file in the real directory, and no directory", () => {
    const target = path.join(root, "target");
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, path.join(root, "link"));
    closeSync(createPrivateFile(path.join(root, "link", "secret")) as number);
    expect(readdirSync(target)).toEqual(["secret"]);
    const refusal = refusalOf(() => createPrivateFile(path.join(root, "data", "secret")));
    expect([refusal?.reason, refusal?.code]).toEqual(["inaccessible", "ENOENT"]);
    expect(existsSync(path.join(root, "data"))).toBe(false);
  });

  it("creates nothing where a file is already", () => {
    const file = privateFile(path.join(root, "secret"));
    expect(createPrivateFile(file)).toBeUndefined();
    expect(readFileSync(file, "utf8")).toBe("secret");
  });

  it("creates nothing through a symlink to a missing file", () => {
    const target = path.join(root, "target");
    symlinkSync(target, path.join(root, "secret"));
    expect(createPrivateFile(path.join(root, "secret"))).toBeUndefined();
    expect(existsSync(target)).toBe(false);
  });
});

// A group the user is in, for a directory shared with a group: another than
// the user's own, where there is one, so a file left in the user's own group
// is seen not to be in it.
const ownGroup = process.getegid?.() ?? 0;
const sharedGid = process.getgroups?.().find((gid) => gid !== ownGroup) ?? ownGroup;
const groupOf = (target: string) => statSync(target).gid;

describe("a directory shared with a group", () => {
  it.each(["022", "077"])("is made with mode 0750 in the group under umask %s", (umask) => {
    withUmask(umask, () => {
      const directory = path.join(root, "audit", "files");
      expect(ensurePrivateDirectory(directory, sharedGid)).toBe(directory);
      for (const made of [path.join(root, "audit"), directory]) {
        expect([mode(made), groupOf(made)]).toEqual([0o750, sharedGid]);
      }
    });
  });

  it("is refused, never repaired, with any other mode or as a private one", () => {
    const directory = path.join(root, "audit");
    mkdirSync(directory, { mode: 0o700 });
    chmodSync(directory, 0o700);
    expect(reasonOf(() => ensurePrivateDirectory(directory, sharedGid))).toBe(
      "directory_not_private",
    );
    chownSync(directory, process.geteuid?.() ?? 0, sharedGid);
    for (const refused of [0o700, 0o755, 0o770]) {
      chmodSync(directory, refused);
      expect(reasonOf(() => ensurePrivateDirectory(directory, sharedGid))).toBe(
        "directory_not_private",
      );
      expect(mode(directory)).toBe(refused);
    }
    chmodSync(directory, 0o750);
    expect(ensurePrivateDirectory(directory, sharedGid)).toBe(directory);
    // Shared, it is no private directory.
    expect(reasonOf(() => ensurePrivateDirectory(directory))).toBe("directory_not_private");
  });
});

describe("appendToPrivateFile", () => {
  const append = (file: string, text: string, shared?: number) => {
    const fd = appendToPrivateFile(file, shared);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
  };

  it.each(["000", "077"])(
    "creates a file with mode 0600, or 0640 in a group, under umask %s",
    (umask) => {
      withUmask(umask, () => {
        append(path.join(root, "audit.jsonl"), "one\n");
        expect(mode(path.join(root, "audit.jsonl"))).toBe(0o600);
        const shared = ensurePrivateDirectory(path.join(root, "shared"), sharedGid);
        append(path.join(shared, "audit.jsonl"), "one\n", sharedGid);
        const file = path.join(shared, "audit.jsonl");
        expect([mode(file), groupOf(file)]).toEqual([0o640, sharedGid]);
      });
    },
  );

  it("appends to the file there, leaving what it held", () => {
    const file = path.join(root, "audit.jsonl");
    append(file, "one\n");
    append(file, "two\n");
    expect(readFileSync(file, "utf8")).toBe("one\ntwo\n");
  });

  it("refuses a file there with another mode, or through a symlink, changing nothing", () => {
    const file = path.join(root, "audit.jsonl");
    writeFileSync(file, "kept", { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(reasonOf(() => appendToPrivateFile(file))).toBe("file_not_private");
    chmodSync(file, 0o600);
    const shared = ensurePrivateDirectory(path.join(root, "shared"), sharedGid);
    const sharedFile = privateFile(path.join(shared, "audit.jsonl"));
    expect(reasonOf(() => appendToPrivateFile(sharedFile, sharedGid))).toBe("file_not_private");
    symlinkSync(file, path.join(root, "linked.jsonl"));
    expect(reasonOf(() => appendToPrivateFile(path.join(root, "linked.jsonl")))).toBe("not_a_file");
    expect(readFileSync(file, "utf8")).toBe("kept");
  });
});

describe("openPrivateFile", () => {
  it("opens a private file for reading", () => {
    const fd = openPrivateFile(privateFile(path.join(root, "secret")));
    expect(fd).toEqual(expect.any(Number));
    try {
      expect(readFileSync(fd as number, "utf8")).toBe("secret");
    } finally {
      closeSync(fd as number);
    }
  });

  it("answers undefined for a missing file or directory, creating nothing", () => {
    expect(openPrivateFile(path.join(root, "secret"))).toBeUndefined();
    expect(openPrivateFile(path.join(root, "data", "secret"))).toBeUndefined();
    expect(readdirSync(root)).toEqual([]);
  });

  it("refuses a missing file below a directory others can write to", () => {
    chmodSync(root, 0o777);
    expect(reasonOf(() => openPrivateFile(path.join(root, "data", "secret")))).toBe(
      "writable_ancestor",
    );
  });

  it("opens a file through a symlinked directory whose real path obeys the rule", () => {
    const target = path.join(root, "target");
    mkdirSync(target, { mode: 0o700 });
    privateFile(path.join(target, "secret"));
    symlinkSync(target, path.join(root, "link"));
    const fd = openPrivateFile(path.join(root, "link", "secret"));
    expect(fd).toEqual(expect.any(Number));
    closeSync(fd as number);
  });

  it("refuses a file through a symlink into a directory others can write to", () => {
    const shared = path.join(root, "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    const target = path.join(shared, "target");
    mkdirSync(target, { mode: 0o700 });
    privateFile(path.join(target, "secret"));
    symlinkSync(target, path.join(root, "link"));
    expect(reasonOf(() => openPrivateFile(path.join(root, "link", "secret")))).toBe(
      "writable_ancestor",
    );
  });

  it.each<[string, (file: string) => void, PrivateFileReason]>([
    [
      "a symlink to a private file",
      (file) => symlinkSync(privateFile(`${file}.real`), file),
      "not_a_file",
    ],
    ["a symlink to a missing file", (file) => symlinkSync(`${file}.missing`, file), "not_a_file"],
    ["a directory", (file) => mkdirSync(file), "not_a_file"],
    [
      "a FIFO, without waiting for a writer",
      (file) => execFileSync("mkfifo", ["-m", "600", file]),
      "not_a_file",
    ],
    [
      "a file its group can read",
      (file) => chmodSync(privateFile(file), 0o640),
      "file_not_private",
    ],
    ["a file others can read", (file) => chmodSync(privateFile(file), 0o604), "file_not_private"],
  ])("refuses %s", (_, make, reason) => {
    const file = path.join(root, "secret");
    make(file);
    expect(reasonOf(() => openPrivateFile(file))).toBe(reason);
  });
});

describe("checkPrivateFile", () => {
  it("passes a missing file and a private one", () => {
    expect(reasonOf(() => checkPrivateFile(path.join(root, "secret")))).toBeUndefined();
    expect(reasonOf(() => checkPrivateFile(path.join(root, "data", "secret")))).toBeUndefined();
    expect(
      reasonOf(() => checkPrivateFile(privateFile(path.join(root, "secret")))),
    ).toBeUndefined();
  });

  it.each<[string, (file: string) => void, PrivateFileReason]>([
    ["a symlink", (file) => symlinkSync(privateFile(`${file}.real`), file), "not_a_file"],
    ["a file others can read", (file) => chmodSync(privateFile(file), 0o644), "file_not_private"],
  ])("refuses %s", (_, make, reason) => {
    const file = path.join(root, "secret");
    make(file);
    expect(reasonOf(() => checkPrivateFile(file))).toBe(reason);
  });

  it("refuses a file in a directory others can read", () => {
    chmodSync(root, 0o755);
    expect(reasonOf(() => checkPrivateFile(path.join(root, "secret")))).toBe(
      "directory_not_private",
    );
  });
});

describe("shellQuoted", () => {
  it.each(["/home/jane doe/.config", "/srv/[::1]:8080/agent", "/tmp/it's here", "/a/$HOME/`x`"])(
    "quotes %s so that a shell reads it back unchanged",
    (value) => {
      expect(
        execFileSync("sh", ["-c", `printf %s ${shellQuoted(value)}`], { encoding: "utf8" }),
      ).toBe(value);
    },
  );
});
