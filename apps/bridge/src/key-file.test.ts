import { PrivateFileError, type PrivateFileReason } from "@wayfarerlabs/agention-private-files";
import type * as fs from "node:fs";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BridgeError } from "./errors.ts";
import { KeyFile } from "./key-file.ts";

// The file system calls the key file makes, in order, and a write that fails
// on demand.
const watch = vi.hoisted(() => ({
  calls: [] as { name: string; target: unknown }[],
  failWrites: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  const watched =
    <F extends (...args: never[]) => unknown>(name: string, call: F) =>
    (...args: Parameters<F>): ReturnType<F> => {
      watch.calls.push({ name, target: args[0] });
      if (name === "writeSync" && watch.failWrites) {
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      }
      return call(...args) as ReturnType<F>;
    };
  return {
    ...actual,
    openSync: watched("openSync", actual.openSync),
    fstatSync: watched("fstatSync", actual.fstatSync),
    readFileSync: watched("readFileSync", actual.readFileSync),
    closeSync: watched("closeSync", actual.closeSync),
    writeSync: watched("writeSync", actual.writeSync),
    fsyncSync: watched("fsyncSync", actual.fsyncSync),
    linkSync: watched("linkSync", actual.linkSync),
    renameSync: watched("renameSync", actual.renameSync),
  };
});

const origin = "https://agention.example.com";
const names = { agent: "builder", session: "main" };
let home: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(tmpdir(), "agention-key-")));
  watch.calls.length = 0;
  watch.failWrites = false;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("a key file", () => {
  it("lives under the home directory's .config/agention", () => {
    const file = new KeyFile("/home/agent", "https://agention.example.com:8443", names);
    expect(file.path).toBe(
      "/home/agent/.config/agention/agention.example.com:8443/builder/main/key.pem",
    );
  });

  it.each([
    ["an agent", { agent: "..", session: "main" }],
    ["a session", { agent: "builder", session: "." }],
    ["a separator", { agent: "a/b", session: "main" }],
  ])("refuses names that would leave that directory, such as %s", (_, given) => {
    expect(() => new KeyFile("/home/agent", origin, given)).toThrow(BridgeError);
  });

  it("is replaced with nothing but the rename after checking it holds the refused key", () => {
    const file = new KeyFile(home, origin, names);
    const refused = file.create().publicKey;
    watch.calls.length = 0;
    expect(file.replace(refused).publicKey).not.toBe(refused);
    const calls = watch.calls.map((call) => call.name);
    const rename = calls.lastIndexOf("renameSync");
    const check = watch.calls.findLastIndex(
      (call, i) => i < rename && call.name === "openSync" && call.target === file.path,
    );
    expect(check).toBeGreaterThan(-1);
    expect(calls.slice(check + 1, rename)).toEqual(["fstatSync", "readFileSync", "closeSync"]);
  });

  it("leaves no temporary file when writing a new key fails", () => {
    const file = new KeyFile(home, origin, names);
    watch.failWrites = true;
    let refusal: unknown;
    try {
      file.create();
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(BridgeError);
    expect((refusal as Error).message).toContain(file.path);
    expect(watch.calls.some((call) => call.name === "writeSync")).toBe(true);
    expect(readdirSync(path.dirname(file.path))).toEqual([]);
  });
});

describe("a key file below a home that is not a directory", () => {
  it.each<[string, (at: string) => void, string[]]>([
    ["missing", () => undefined, []],
    ["a file", (at) => writeFileSync(at, "notes"), ["home"]],
  ])("is not created, nor the home, when the home is %s", (_, make, left) => {
    const notHome = path.join(home, "home");
    make(notHome);
    const file = new KeyFile(notHome, origin, names);
    expect(file.read()).toBeUndefined();
    expect(() => file.create()).toThrow(BridgeError);
    expect(readdirSync(home)).toEqual(left);
  });
});

// The private-file reason a key file operation was refused for, which the
// BridgeError it throws keeps as its cause.
function refusalOf(operation: () => unknown): PrivateFileReason | undefined {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(BridgeError);
    const cause = (error as BridgeError).cause;
    expect(cause).toBeInstanceOf(PrivateFileError);
    return (cause as PrivateFileError).reason;
  }
  return undefined;
}

// The private-file rule is the package's to test; here, each path the key
// file's operations open is refused once, as a BridgeError that keeps the
// rule's refusal as its cause.
describe("a key file that is not private to the user", () => {
  it("is refused when it is a symlink, even to a private key", () => {
    const file = new KeyFile(home, origin, names);
    file.create();
    const moved = path.join(home, "moved.pem");
    renameSync(file.path, moved);
    symlinkSync(moved, file.path);
    const pem = readFileSync(moved, "utf8");
    expect(refusalOf(() => file.read())).toBe("not_a_file");
    expect(refusalOf(() => file.create())).toBe("not_a_file");
    expect(readFileSync(moved, "utf8")).toBe(pem);
  });

  it("is refused when others can read the session's directory", () => {
    const file = new KeyFile(home, origin, names);
    file.create();
    const directory = path.dirname(file.path);
    chmodSync(directory, 0o750);
    expect(refusalOf(() => file.read())).toBe("directory_not_private");
    expect(refusalOf(() => file.create())).toBe("directory_not_private");
    expect(readdirSync(directory)).toEqual(["key.pem"]);
  });
});
