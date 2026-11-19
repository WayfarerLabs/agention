import { createHash } from "node:crypto";

// canonicalJson encodes a JSON value with object keys sorted and undefined
// members left out, so equal values always encode to the same text.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((element) => canonicalJson(element)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const members = Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value);
}

// writeDigest identifies a write's content for request-id replay: the
// operation, its target and its payload. Two requests with one request id are
// the same write exactly when their digests match.
export function writeDigest(operation: string, target: object, payload: object): Uint8Array {
  return createHash("sha256").update(canonicalJson({ operation, target, payload })).digest();
}
