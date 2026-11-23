import {
  ask,
  message,
  messageSendInput,
  threadGetResult,
  threadSummary,
} from "@wayfarerlabs/agention-api";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type JsonSchema, JsonSchemas } from "./json-schemas.ts";

// refsIn lists every $ref a description holds.
function refsIn(value: unknown): string[] {
  const found: string[] = [];
  JSON.stringify(value, (key, each: unknown) => {
    if (key === "$ref" && typeof each === "string") {
      found.push(each);
    }
    return each;
  });
  return found;
}

describe("JsonSchemas", () => {
  it("references a named schema, itself included, rather than repeating it", () => {
    const schemas = new JsonSchemas();
    expect(schemas.of(threadSummary, "output")).toEqual({
      $ref: "#/components/schemas/ThreadSummary",
    });
    const result = schemas.of(threadGetResult, "output");
    expect(refsIn(result).sort()).toEqual([
      "#/components/schemas/Cursors",
      "#/components/schemas/Marks",
      "#/components/schemas/Message",
      "#/components/schemas/ThreadSummary",
    ]);
  });

  it("describes every component referenced, directly or through another, and no other", () => {
    const schemas = new JsonSchemas();
    const described = schemas.of(threadGetResult, "output");
    const components = schemas.components();
    const referenced = new Set(
      [described, ...Object.values(components)]
        .flatMap(refsIn)
        .map((ref) => ref.replace("#/components/schemas/", "")),
    );
    expect(Object.keys(components).sort()).toEqual([...referenced].sort());
  });

  it("names a schema that reads alike both ways once, for input and output", () => {
    const schemas = new JsonSchemas();
    const sent = refsIn(schemas.of(messageSendInput, "input"));
    schemas.of(message, "output");
    const read = refsIn(schemas.components().Message);
    expect(sent).toContain("#/components/schemas/Reference");
    expect(read).toContain("#/components/schemas/Reference");
  });

  it("refuses a named schema whose one id would need two bodies", () => {
    const schemas = new JsonSchemas();
    schemas.of(ask, "input");
    expect(() => schemas.of(ask, "output")).toThrow(/Ask reads differently/);
  });

  it("refuses a cycle that no named schema breaks, at the top or within", () => {
    const node: z.ZodType = z.object({ children: z.array(z.lazy(() => node)) });
    expect(() => new JsonSchemas().of(node, "output")).toThrow(/no named schema breaks/);
    const holding = z.object({ tree: node });
    expect(() => new JsonSchemas().of(holding, "output")).toThrow(/no named schema breaks/);
  });

  it("keeps the ids out of zod's global registry, which the bridge's tool schemas read", () => {
    new JsonSchemas().of(threadSummary, "output");
    const described = z.toJSONSchema(threadSummary) as JsonSchema;
    expect(described.$defs).toBeUndefined();
    expect(refsIn(described)).toEqual([]);
  });
});
