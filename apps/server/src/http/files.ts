import {
  dispositionOf,
  type Disposition,
  type ErrorBody,
  fileReadQuery,
  queryNumber,
  sequence,
  servedTypeOf,
  unsatisfiableRangeStatus,
} from "@wayfarerlabs/agention-api";
import type { Context } from "hono";
import { chunkBytes, findCarriedFile, readFileChunk, type Store } from "../store/index.ts";
import { parse, parseQuery, threadTarget } from "./input.ts";
import { ownHeaders } from "./own-headers.ts";
import type { IdentityEnv } from "./thread-routes.ts";

// Reading a file: GET and HEAD /threads/:n/messages/:seq/files/:name, on
// both mounts. A file is served inert whatever its bytes are: as one of the
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

// serveFile answers a file read: the file a message carries under a name,
// and when the request gives its ref, only if the message carries that
// file. Its bytes stream a chunk at a time, each read in its own
// transaction, which checks the credential again.
export function serveFile(
  c: Context<IdentityEnv>,
  store: Store,
  log: (message: string) => void,
): Response {
  const target = threadTarget(c);
  const seq = parse(queryNumber(sequence), c.req.param("seq"), "seq");
  const { file: ref } = parseQuery(c, fileReadQuery);
  const identity = c.var.identity;
  const file = findCarriedFile(store, identity, {
    ...target,
    seq,
    name: c.req.param("name") ?? "",
    ref,
  });
  const served = servedTypeOf(file.type);
  const wanted = wantedOf(c.req.header("range"), file.size);
  if (wanted.kind === "unsatisfiable") {
    c.header("Content-Range", `bytes */${file.size}`);
    const body: ErrorBody = {
      error: { code: "invalid_input", message: "the range is outside the file" },
    };
    return c.json(body, unsatisfiableRangeStatus);
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
  ownHeaders(c, ["content-security-policy", "cache-control"]);
  const status = wanted.kind === "range" ? 206 : 200;
  if (c.req.method === "HEAD" || end < start) {
    return c.body(null, status, headers);
  }
  let index = Math.floor(start / chunkBytes);
  const lastIndex = Math.floor(end / chunkBytes);
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const data = readFileChunk(store, identity, file.id, index);
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
  return c.body(body, status, headers);
}
