import type { ErrorBody } from "@wayfarerlabs/agention-api";
import type { z } from "zod";

// What unknownField reads of a schema's definition: its kind, and the
// schemas it wraps or holds.
interface Definition {
  type: string;
  innerType?: z.ZodType;
  in?: z.ZodType;
  out?: z.ZodType;
  element?: z.ZodType;
  shape?: Record<string, z.ZodType>;
}

const definitionOf = (schema: z.ZodType) => schema._zod.def as unknown as Definition;

// unknownField finds a field in a tool's arguments that its schema does not
// know, at any depth, and names it as a dotted path. The API's schemas drop
// fields they do not know, so a server keeps working with a newer bridge;
// a tool refuses them instead, so a misspelled field never goes missing
// silently. Only objects and lists are looked into: what else a schema
// holds carries no fields.
export function unknownField(
  schema: z.ZodType,
  value: unknown,
  path: readonly (string | number)[] = [],
): string | undefined {
  const definition = definitionOf(schema);
  const within = (inner: z.ZodType | undefined, held: unknown, at = path) =>
    inner === undefined ? undefined : unknownField(inner, held, at);
  switch (definition.type) {
    case "optional":
    case "default":
      return within(definition.innerType, value);
    case "pipe":
      return within(definition.in, value) ?? within(definition.out, value);
    case "array":
      if (!Array.isArray(value)) {
        return undefined;
      }
      for (const [index, element] of value.entries()) {
        const found = within(definition.element, element, [...path, index]);
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return undefined;
      }
      const shape = definition.shape ?? {};
      for (const [key, held] of Object.entries(value)) {
        const found = Object.hasOwn(shape, key)
          ? within(shape[key], held, [...path, key])
          : [...path, key].join(".");
        if (found !== undefined) {
          return found;
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

// unknownFieldBody is the refusal of an unknown field, in the API's error
// shape.
export function unknownFieldBody(field: string): ErrorBody {
  return {
    error: { code: "invalid_input", message: "is not a field this tool takes", field },
  };
}
