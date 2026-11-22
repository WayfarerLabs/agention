import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type JsonSchema, JsonSchemas } from "./json-schemas.ts";
import { message, messageSendInput, threadGetResult, threadSummary } from "./threads.ts";

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

  it("names an input that reads unlike its answer apart, and one that reads alike once", () => {
    const schemas = new JsonSchemas();
    const sent = refsIn(schemas.of(messageSendInput, "input"));
    schemas.of(message, "output");
    const read = refsIn(schemas.components().Message);
    expect(sent).toContain("#/components/schemas/AskInput");
    expect(read).toContain("#/components/schemas/AskRead");
    // A reference reads the same both ways, so both name the one component.
    expect(sent).toContain("#/components/schemas/Reference");
    expect(read).toContain("#/components/schemas/Reference");
  });

  it("keeps the ids out of zod's global registry, which the bridge's tool schemas read", () => {
    new JsonSchemas().of(threadSummary, "output");
    const described = z.toJSONSchema(threadSummary) as JsonSchema;
    expect(described.$defs).toBeUndefined();
    expect(refsIn(described)).toEqual([]);
  });
});
