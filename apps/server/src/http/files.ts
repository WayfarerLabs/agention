import {
  dispositionOf,
  type Disposition,
  type ErrorBody,
  servedTypeOf,
  servedTypes,
  unsatisfiableRangeStatus,
} from "@wayfarerlabs/agention-api";
import { ApiError } from "../errors.ts";
import type { Identity } from "../identity.ts";
import {
  chunkBytes,
  findCarriedFile,
  readFileChunk,
  type Store,
  type ThreadTarget,
} from "../store/index.ts";
import type { BytesAnswer } from "./operations.ts";
import { ownHeaders } from "./own-headers.ts";

// Reading a file: GET and HEAD /threads/:thread/messages/:seq/files/:name,
// on every mount. A file is served inert whatever its bytes are: as one of the
// allowlisted types, under a sandbox policy that lets it load and run
// nothing, readable only by the server's own pages, and cached privately for
// good, since the bytes at a URL never change.

// The policy every file response carries, which sandboxes a file opened on
// its own as a document of a unique origin that loads nothing.
export const filePolicy = "sandbox; default-src 'none'; frame-ancestors 'none'";

// How a browser may keep a file: privately, for good.
export const fileCaching = "private, max-age=31536000, immutable";

// The bytes RFC 5987's attr-char leaves as they are in an extended value.
const attrChar = /^[A-Za-z0-9!#$&+\-.^_`|~]$/;

// contentDisposition writes a file's disposition and name per RFC 6266, with
// a fallback name in printable ASCII for clients that read only that, and
// the name itself in RFC 5987's extended value, its UTF-8 percent-encoded
// wherever attr-char does not allow a byte as it is.
export function contentDisposition(disposition: Disposition, name: string): string {
  const fallback = Array.from(name, (character) =>
    /^[\x20-\x7e]$/.test(character) && !/["\\%]/.test(character) ? character : "_",
  ).join("");
  const encoded = Array.from(Buffer.from(name, "utf8"), (byte) => {
    const character = String.fromCharCode(byte);
    return attrChar.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// The part of a file a request asks for: all of it, a range of it from start
// to end inclusive, or a range outside it.
export type Wanted =
  | { kind: "whole" }
  | { kind: "range"; start: number; end: number }
  | {
      kind: "unsatisfiable";
    };

// wantedOf reads a Range header for a file of size bytes. One range of bytes,
// a-b, a- or -n, is answered as asked; several ranges, another unit and
// anything malformed are ignored, so the file is answered whole. A range
// starting at or beyond the end, or of nothing, is outside the file, as is
// every range of an empty file.
export function wantedOf(header: string | undefined, size: number): Wanted {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null || (match[1] === "" && match[2] === "")) {
    return { kind: "whole" };
  }
  const [, first = "", last = ""] = match;
  if (first === "") {
    const suffix = Number(last);
    return suffix === 0 || size === 0
      ? { kind: "unsatisfiable" }
      : { kind: "range", start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  if (last !== "" && Number(last) < start) {
    return { kind: "whole" };
  }
  if (start >= size) {
    return { kind: "unsatisfiable" };
  }
  return { kind: "range", start, end: last === "" ? size - 1 : Math.min(Number(last), size - 1) };
}

// The answer a file read declares: the file's bytes.
export const fileBytes: BytesAnswer<Response> = {
  bytes: "answer",
  description:
    "The file's bytes, as the type it is served as, which follows from its declared type " +
    "and is never a script or style. Content-Disposition names the file, inline or as an " +
    "attachment to download. A file is served inert: its Content-Security-Policy sandboxes " +
    "it and loads nothing, Cross-Origin-Resource-Policy is same-origin, and it may be " +
    "cached privately for good, since the bytes at an address never change; ETag is the " +
    "hex SHA-256 of its bytes. HEAD answers the same headers without the bytes.",
  types: servedTypes,
  ranges: true,
};

// The file a read names: the thread's message, the name it carries the file
// under, and the file's ref when the request gives it.
export interface FileRead {
  store: Store;
  identity: Identity;
  target: ThreadTarget & { seq: number; name: string; ref: string | undefined };
  request: Request;
  log: (message: string) => void;
}

// serveFile answers a file read: the file a message carries under a name,
// and when the request gives its ref, only if the message carries that
// file. Its bytes stream a chunk at a time, each read in its own
// transaction, which checks the credential and its scope again.
export function serveFile(read: FileRead): Response {
  const { store, identity, target, request, log } = read;
  const file = findCarriedFile(store, identity, target);
  const served = servedTypeOf(file.type);
  const wanted = wantedOf(request.headers.get("range") ?? undefined, file.size);
  if (wanted.kind === "unsatisfiable") {
    const body: ErrorBody = {
      error: { code: "invalid_input", message: "the range is outside the file" },
    };
    return Response.json(body, {
      status: unsatisfiableRangeStatus,
      headers: { "Content-Range": `bytes */${file.size}` },
    });
  }
  const [start, end] = wanted.kind === "range" ? [wanted.start, wanted.end] : [0, file.size - 1];
  const headers: Record<string, string> = {
    "Content-Type": served,
    "Content-Length": String(end - start + 1),
    "Content-Disposition": contentDisposition(dispositionOf(served), file.name),
    "Accept-Ranges": "bytes",
    ETag: `"${Buffer.from(file.sha256).toString("hex")}"`,
    "Content-Security-Policy": filePolicy,
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": fileCaching,
    ...(wanted.kind === "range" ? { "Content-Range": `bytes ${start}-${end}/${file.size}` } : {}),
  };
  ownHeaders(request, ["content-security-policy", "cache-control"]);
  const status = wanted.kind === "range" ? 206 : 200;
  if (request.method === "HEAD" || end < start) {
    return new Response(null, { status, headers });
  }
  let index = Math.floor(start / chunkBytes);
  const lastIndex = Math.floor(end / chunkBytes);
  // The first chunk is read before the answer starts, so a credential revoked
  // since the file was found, or a chunk that is gone, is answered as any
  // refusal is, with the app's headers, rather than as a broken body.
  let first = readFileChunk(store, identity, file.id, index);
  if (first === undefined) {
    log(`file ${file.id} is missing its chunk ${index}, so its read was refused`);
    throw new ApiError("not_found", "this file's contents are missing");
  }
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const data = first ?? readFileChunk(store, identity, file.id, index);
        first = undefined;
        if (data === undefined) {
          log(`file ${file.id} is missing its chunk ${index}, so its read was cut short`);
          controller.error(new Error("a chunk of the file is missing"));
          return;
        }
        const offset = index * chunkBytes;
        const from = Math.max(start - offset, 0);
        const to = Math.min(end - offset + 1, data.length);
        controller.enqueue(data.subarray(from, to));
        index += 1;
        if (index > lastIndex) {
          controller.close();
        }
      },
    },
    // Nothing is read until the response is.
    { highWaterMark: 0 },
  );
  return new Response(body, { status, headers });
}
