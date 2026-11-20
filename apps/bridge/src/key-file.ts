import { type PublicKey, publicKey } from "@wayfarerlabs/agention-api";
import {
  createPrivateFile,
  ensurePrivateDirectory,
  openPrivateFile,
  PrivateFileError,
  shellQuoted,
} from "@wayfarerlabs/agention-private-files";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
} from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { BridgeError, operatorProblem, settingProblem } from "./errors.ts";
import type { SessionNames } from "./session.ts";

const keyName = "key.pem";

// A session's key: the Ed25519 private key the bridge signs with, and the raw
// public key that names it everywhere.
export interface SessionKey {
  privateKey: KeyObject;
  publicKey: PublicKey;
}

// KeyFile is a session's key file, the bridge's only state: an Ed25519
// private key in PKCS #8 PEM at
// ~/.config/agention/<server>/<agent>/<session>/key.pem, where the server is
// the origin's host, with its port when not 443, and the names are the ones
// the session proposed. The path is fixed, so every host that runs the bridge
// for the session finds the same key whatever environment it passes.
//
// The key file obeys the private-file rule, which every read and write
// applies again: a refusal under it is a BridgeError that says what to change
// and keeps the PrivateFileError as its cause. The home directory must exist;
// only the directories below it are created. The file is read for every use,
// so bridges sharing a session always sign with the key now on disk. A new key
// is written to a temporary file in the session directory's real path and
// then linked or renamed into place there, so the key file is never seen half
// written. Every operation is synchronous, so no other call in this process
// runs in the middle of one.
export class KeyFile {
  readonly #home: string;
  readonly path: string;

  constructor(home: string, origin: string, names: SessionNames) {
    const parts = [new URL(origin).host, names.agent, names.session];
    // The host and the names have passed checks that admit no separator, but
    // the key must never land outside the bridge's own directory.
    if (parts.some((part) => part === "." || part === ".." || part !== path.basename(part))) {
      throw new BridgeError(
        `Use another AGENTION_URL or other session names, since ${parts.join("/")} would put ` +
          "the session's key outside ~/.config/agention.",
      );
    }
    this.#home = home;
    this.path = path.join(home, ".config", "agention", ...parts, keyName);
  }

  // read returns the key on disk, or undefined when there is none.
  read(): SessionKey | undefined {
    if (!this.#homeIsDirectory()) {
      return undefined;
    }
    let fd: number | undefined;
    try {
      fd = openPrivateFile(this.path);
    } catch (error) {
      throw this.#refusal(error);
    }
    if (fd === undefined) {
      return undefined;
    }
    let pem: string;
    try {
      pem = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
    const privateKey = parsePrivateKey(pem);
    if (privateKey === undefined) {
      throw new BridgeError(
        `Remove ${this.path}, which does not hold an Ed25519 private key in PKCS #8 PEM, and ` +
          "call register to make a new key.",
      );
    }
    return { privateKey, publicKey: publicKeyOf(privateKey) };
  }

  // create makes the session's first key. Linking the new file into place
  // fails if a key already exists, so when two bridges start together the
  // first key linked wins and both use it; create returns the key in place.
  create(retried = false): SessionKey {
    const directory = this.#directory();
    const key = newSessionKey();
    const temporary = this.#writeTemporary(directory, key);
    try {
      linkSync(temporary, path.join(directory, keyName));
      return key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw this.#unusable(error);
      }
    } finally {
      rmSync(temporary, { force: true });
    }
    const existing = this.read();
    if (existing !== undefined) {
      return existing;
    }
    // A key was in place, but is gone: another bridge removed it in between.
    // Trying once more covers that.
    if (retried) {
      throw new BridgeError(
        `Call register again, since ${this.path} was removed twice while this bridge was ` +
          "creating it.",
      );
    }
    return this.create(true);
  }

  // replace puts a new key in place of one the server refused, but only while
  // the file still holds that key: if another bridge sharing the session has
  // replaced it already, its key stays, and replace returns the key in place.
  // The new key is written first, so nothing but the rename follows the
  // check. Another process could still replace the file in that instant; the
  // caller reads the file again after submitting the key and reports the key
  // it finds there, so a registration left behind is never relayed. Only two
  // replacements interleaving within one round trip can relay a code whose
  // key was overwritten.
  replace(refused: PublicKey): SessionKey {
    const directory = this.#directory();
    const key = newSessionKey();
    const temporary = this.#writeTemporary(directory, key);
    try {
      const current = this.read();
      if (current === undefined) {
        return this.create();
      }
      if (current.publicKey !== refused) {
        return current;
      }
      try {
        renameSync(temporary, path.join(directory, keyName));
      } catch (error) {
        throw this.#unusable(error);
      }
      return key;
    } finally {
      // Once renamed, the temporary file is gone; otherwise it goes unused.
      rmSync(temporary, { force: true });
    }
  }

  // directory makes the session's directory below the home directory, which
  // must exist, and returns its real path, where the key file is written.
  #directory(): string {
    if (!this.#homeIsDirectory()) {
      throw settingProblem(
        `HOME, ${this.#home}, is not an existing directory, and the bridge creates only the ` +
          "directories below it",
        "set HOME to an existing directory",
      );
    }
    try {
      return ensurePrivateDirectory(path.dirname(this.path));
    } catch (error) {
      throw this.#refusal(error);
    }
  }

  #homeIsDirectory(): boolean {
    try {
      return statSync(this.#home).isDirectory();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        return false;
      }
      throw this.#unusable(error);
    }
  }

  // writeTemporary writes a key to a new file in the session's directory,
  // given by its real path, and returns its path. A write that fails leaves
  // no file behind.
  #writeTemporary(directory: string, key: SessionKey): string {
    const temporary = path.join(directory, `${keyName}.${randomBytes(8).toString("hex")}.new`);
    const pem = key.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    let fd: number | undefined;
    try {
      fd = createPrivateFile(temporary);
    } catch (error) {
      throw this.#refusal(error);
    }
    if (fd === undefined) {
      throw new BridgeError(
        `Remove ${temporary}, which is in the way of a new key, and call register again.`,
      );
    }
    try {
      writeSync(fd, pem);
      fsyncSync(fd);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw this.#unusable(error);
    } finally {
      closeSync(fd);
    }
    return temporary;
  }

  // refusal says what to change when the key file or a directory on its path
  // breaks the private-file rule, and what to check when anything else
  // fails.
  #refusal(error: unknown): BridgeError {
    if (!(error instanceof PrivateFileError)) {
      return this.#unusable(error);
    }
    return refusalOf(error);
  }

  #unusable(error: unknown): BridgeError {
    const code = (error as NodeJS.ErrnoException).code ?? (error as Error).message;
    return new BridgeError(`Check that this user can read and write ${this.path} (${code}).`);
  }
}

// refusalOf says what to change about a path that breaks the private-file
// rule, so that only this user can read or replace the session's key, and
// keeps the refusal as its cause. A directory above the bridge's own, such as
// the home directory, is the operator's to change.
function refusalOf(error: PrivateFileError): BridgeError {
  const { reason, path: at, code } = error;
  const quoted = shellQuoted(at);
  const cause = { cause: error };
  switch (reason) {
    case "unsupported_platform":
      return new BridgeError(
        "This system does not report who owns a file, so the bridge cannot keep the session's " +
          "key private. Only the operator can fix that, so tell them at your terminal that the " +
          "bridge needs a system that does, such as Linux or macOS. Carry on without Agention.",
        cause,
      );
    case "inaccessible":
      return new BridgeError(
        `Check that this user can search every directory down to ${at}, and read and write ` +
          `the session's key there (${code ?? "unknown error"}).`,
        cause,
      );
    case "not_a_directory":
      return new BridgeError(
        `Replace ${at} with a directory, or a symlink to one, since the session's key is kept ` +
          "below it.",
        cause,
      );
    case "foreign_ancestor":
      return operatorProblem(
        `Another user owns ${at}, a directory above the session's key, and could replace the key`,
        `have an administrator give ${at} to this user or to root`,
        cause,
      );
    case "writable_ancestor":
      return operatorProblem(
        `Other users can write to ${at}, a directory above the session's key, and could ` +
          "replace the key",
        `run chmod go-w ${quoted}`,
        cause,
      );
    case "directory_not_private":
      return new BridgeError(
        `${at} must belong to you, with mode 700, so that only you can reach the session's ` +
          `key; if it is yours, run chmod 700 ${quoted}.`,
        cause,
      );
    case "not_a_file":
      return new BridgeError(
        `Replace ${at} with the session's key file, or remove it and call register to make ` +
          "a new key, since the bridge never reads a key through a symlink.",
        cause,
      );
    case "file_not_private":
      return new BridgeError(
        `${at} must belong to you, with mode 600, so that only you can read the session's ` +
          `key; if it is yours, run chmod 600 ${quoted}.`,
        cause,
      );
  }
}

function parsePrivateKey(pem: string): KeyObject | undefined {
  try {
    const key = createPrivateKey(pem);
    return key.asymmetricKeyType === "ed25519" ? key : undefined;
  } catch {
    return undefined;
  }
}

function newSessionKey(): SessionKey {
  const { privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, publicKey: publicKeyOf(privateKey) };
}

function publicKeyOf(privateKey: KeyObject): PublicKey {
  return publicKey.parse(createPublicKey(privateKey).export({ format: "jwk" }).x);
}
