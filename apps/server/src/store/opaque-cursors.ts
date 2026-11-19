import { invalidInput } from "../errors.ts";

type Value = number | string;
type Kind = "number" | "string";

// A list position handed to clients as an opaque string: the list's name and
// its keyset values, base64url-encoded JSON. Clients pass it back unchanged.
export function encodeCursor(list: string, values: readonly Value[]): string {
  return Buffer.from(JSON.stringify([list, ...values])).toString("base64url");
}

// decodeCursor reads a cursor that encodeCursor wrote for the same list, with
// values of the given kinds. Anything else is invalid_input naming the field,
// which reveals nothing: the cursor depends on no stored state.
export function decodeCursor(
  list: string,
  text: string,
  kinds: readonly Kind[],
  field: string,
): Value[] {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    decoded = undefined;
  }
  if (
    !Array.isArray(decoded) ||
    decoded.length !== kinds.length + 1 ||
    decoded[0] !== list ||
    !kinds.every((kind, i) => {
      const value: unknown = decoded[i + 1];
      return kind === "number" ? Number.isSafeInteger(value) : typeof value === "string";
    })
  ) {
    throw invalidInput(field, "is not a position this list gave out");
  }
  return decoded.slice(1) as Value[];
}
