import { declaredTypeOf, type UploadResult } from "@wayfarerlabs/agention-api";
import { createHash } from "node:crypto";
import { statfs } from "node:fs/promises";
import path from "node:path";
import { ApiError, invalidInput } from "../errors.ts";
import type { Identity } from "../identity.ts";
import {
  abortUpload,
  beginUpload,
  bytesArriving,
  chunkBytes,
  completeUpload,
  type Store,
  type SessionTarget,
  writeChunk,
} from "../store/index.ts";
import type { BytesBody } from "./operations.ts";

// Uploads: POST /s/:agent/:session/uploads?name=, on every mount, whose body
// is the file's bytes, with its length and declared type. The bytes are
// stored a chunk at a time as they arrive; a failure at any point after the
// upload begins removes what arrived.

// The disk space an upload must leave free beyond every upload still
// arriving, for the database and its log.
export const freeSpaceFloor = 1024 ** 3;

// The path of an upload on each mount: the agent's, the web UI's and the
// operator API's version.
const uploadPath = /^\/api\/(agent|web|operator\/v1)\/s\/[^/?#]+\/[^/?#]+\/uploads$/;

// isUploadRequest says whether a request is an upload, from its method and
// its URL as the adapter hands it to Hono, by the path Hono routes: dot
// segments resolved and the query ignored. The listener's deadlines and the
// body's bound both decide by it, so they always agree.
export function isUploadRequest(method: string, url: string): boolean {
  return method === "POST" && uploadPath.test(URL.parse(url)?.pathname ?? "");
}

// freeBytes reads how many bytes the server may still write in a directory:
// the blocks an unprivileged user may take.
async function freeBytes(directory: string): Promise<number> {
  const stats = await statfs(directory);
  return stats.bavail * stats.bsize;
}

// The body an upload declares: the file's bytes.
export const uploadBytes: BytesBody<undefined> = {
  bytes: "body",
  description:
    "The file's bytes, exactly as they are, with a Content-Length, which is required. " +
    "Content-Type declares the file's type, any type at all: its essence, lowercased, is " +
    "stored, and without one, or with one that is not a type, the file is " +
    "application/octet-stream. The upload's answer gives the type it is served as.",
};

export interface UploadRequest {
  store: Store;
  identity: Identity;
  target: SessionTarget;
  // The name the file is attached under unless a message names another.
  name: string;
  request: Request;
  log: (message: string) => void;
}

// receiveUpload takes an upload: the free-space floor, which counts every
// writer's uploads still arriving, then the upload's limits as it begins,
// then its bytes, a chunk at a time, and its completion. Its length is its
// Content-Length, which the app requires and bounds before authentication.
export async function receiveUpload(upload: UploadRequest): Promise<UploadResult> {
  const { store, identity, target, name, request } = upload;
  const size = Number(request.headers.get("content-length") ?? "0");
  const type = declaredTypeOf(request.headers.get("content-type") ?? undefined);
  const free = await freeBytes(path.dirname(store.db.file));
  if (free - bytesArriving(store) - size < freeSpaceFloor) {
    throw new ApiError(
      "storage_full",
      "the server's disk is too full to take this file until space is freed on it",
    );
  }
  const begun = beginUpload(store, identity, target, { name, type, size });
  try {
    const hash = createHash("sha256");
    const chunk = new Uint8Array(Math.min(chunkBytes, size));
    let filled = 0;
    let index = 0;
    let received = 0;
    const reader = request.body?.getReader();
    for (;;) {
      const next = await readBody(reader);
      if (next === undefined) {
        break;
      }
      received += next.length;
      if (received > size) {
        break;
      }
      hash.update(next);
      for (let at = 0; at < next.length;) {
        const taken = Math.min(chunkBytes - filled, next.length - at);
        chunk.set(next.subarray(at, at + taken), filled);
        filled += taken;
        at += taken;
        if (filled === chunkBytes) {
          writeChunk(store, begun, index++, chunk);
          filled = 0;
        }
      }
    }
    if (filled > 0) {
      writeChunk(store, begun, index++, chunk.subarray(0, filled));
    }
    return completeUpload(store, begun, received, hash.digest());
  } catch (error) {
    abortUpload(store, begun, upload.log);
    throw error;
  }
}

// readBody reads the next piece of a body, or undefined at its end. A body
// that fails to arrive, because its client went or the listener cut it off,
// is the request's fault, not the server's.
async function readBody(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
): Promise<Uint8Array | undefined> {
  if (reader === undefined) {
    return undefined;
  }
  try {
    const { done, value } = await reader.read();
    return done ? undefined : value;
  } catch {
    throw invalidInput(undefined, "the file's bytes stopped arriving before the upload finished");
  }
}
