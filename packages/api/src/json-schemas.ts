import { z } from "zod";
import { errorBody } from "./errors.ts";
import { groupRef } from "./groups-and-tags.ts";
import { reference } from "./references.ts";
import { registration } from "./registrations.ts";
import {
  presence,
  sessionStatus,
  sessionSummary,
  sessionUpdate,
  threadPresence,
  workOutcome,
  workState,
} from "./sessions.ts";
import {
  answer,
  answerRead,
  ask,
  askRead,
  askSummary,
  author,
  cursors,
  effort,
  impact,
  marks,
  message,
  openAsks,
  priority,
  suggestion,
  threadStatus,
  threadSummary,
  withdrawal,
  writeResult,
} from "./threads.ts";

// The API's schemas described as JSON Schema, for its documentation. The
// schemas named here are described once each, as components that the
// descriptions of the others reference, so a schema that appears in many
// requests and answers is read, and changes, in one place.

// A schema of the API, as the documentation takes one.
export type ApiSchema = z.core.$ZodType;

export type JsonSchema = Record<string, unknown>;

// Which side of an exchange a schema describes: what a client sends, or what
// the server answers.
export type Direction = "input" | "output";

// The named schemas, each named for the export that holds it, capitalized.
const named: Record<string, ApiSchema> = {
  answer,
  answerRead,
  ask,
  askRead,
  askSummary,
  author,
  cursors,
  effort,
  errorBody,
  groupRef,
  impact,
  marks,
  message,
  openAsks,
  presence,
  priority,
  reference,
  registration,
  sessionStatus,
  sessionSummary,
  sessionUpdate,
  suggestion,
  threadPresence,
  threadStatus,
  threadSummary,
  withdrawal,
  workOutcome,
  workState,
  writeResult,
};

// The registry the descriptions read: each named schema's id, beside what
// zod's global registry holds for every schema, the descriptions given with
// describe among it, which a registry of its own would otherwise hide. The
// global registry carries no ids, so the agent bridge's tool schemas, which
// zod describes from it, stay whole.
class NamedSchemas extends z.core.$ZodRegistry<z.core.JSONSchemaMeta> {
  override get<S extends ApiSchema>(schema: S): z.core.JSONSchemaMeta | undefined {
    const own = super.get(schema);
    const merged = {
      ...own,
      ...z.globalRegistry.get(schema),
      ...(own?.id === undefined ? {} : { id: own.id }),
    };
    return Object.keys(merged).length === 0 ? undefined : merged;
  }
}

const registry = new NamedSchemas();
for (const [name, schema] of Object.entries(named)) {
  registry.add(schema, { id: name.charAt(0).toUpperCase() + name.slice(1) });
}

// Where the components are, in the document that holds them.
const componentsAt = "#/components/schemas/";

// An answer may gain fields within a version, so a description of one never
// forbids properties it does not list.
function allowingMore(value: JsonSchema): JsonSchema {
  return JSON.parse(
    JSON.stringify(value, (key, each: unknown) =>
      key === "additionalProperties" && each === false ? undefined : each,
    ),
  ) as JsonSchema;
}

// Each description is in the dialect of the document that holds it, and is
// found by where it is there, so its own $schema and $id are dropped.
function bodyOf(described: object, direction: Direction): JsonSchema {
  const { $schema: _, $id: __, ...body } = described as JsonSchema;
  return direction === "output" ? allowingMore(body) : body;
}

// rewritingRefs rewrites every $ref in a description through rename.
function rewritingRefs(value: JsonSchema, rename: (ref: string) => string): JsonSchema {
  return JSON.parse(
    JSON.stringify(value, (key, each: unknown) =>
      key === "$ref" && typeof each === "string" ? rename(each) : each,
    ),
  ) as JsonSchema;
}

function refsOf(value: JsonSchema): string[] {
  const found: string[] = [];
  rewritingRefs(value, (ref) => {
    found.push(ref);
    return ref;
  });
  return found;
}

// Every named schema's description, in each direction, by its id, with the
// references between them written as direction:id. A schema reads the same
// both ways unless it has defaults or reads text into values, or names one
// that does; one that reads differently has a component of its own for its
// input, its id with Input after it.
interface Named {
  output: Map<string, JsonSchema>;
  input: Map<string, JsonSchema>;
  // The ids whose input reads differently.
  differing: Set<string>;
}

let described: Named | undefined;

function namedSchemas(): Named {
  if (described !== undefined) {
    return described;
  }
  const each = (direction: Direction) => {
    const { schemas } = z.toJSONSchema(registry, {
      io: direction,
      metadata: registry,
      uri: (id) => `${direction}:${id}`,
    });
    if ("__shared" in schemas) {
      throw new Error("a named schema holds a cycle the documentation cannot name");
    }
    return new Map(Object.entries(schemas).map(([id, schema]) => [id, bodyOf(schema, direction)]));
  };
  const output = each("output");
  const input = each("input");
  const neutral = (body: JsonSchema | undefined) =>
    JSON.stringify(rewritingRefs(body ?? {}, (ref) => ref.replace(/^(input|output):/, "")));
  const differing = new Set(
    [...output.keys()].filter((id) => neutral(input.get(id)) !== neutral(output.get(id))),
  );
  // One that names a differing schema reads differently too, since its input
  // names that schema's input.
  for (let grown = true; grown;) {
    grown = false;
    for (const [id, body] of input) {
      const names = refsOf(body).map((ref) => ref.slice("input:".length));
      if (!differing.has(id) && names.some((each) => differing.has(each))) {
        differing.add(id);
        grown = true;
      }
    }
  }
  described = { output, input, differing };
  return described;
}

// A component: the named schema it describes, by its id, in a direction.
interface Component {
  id: string;
  direction: Direction;
}

// nameOf names the component describing a named schema in a direction.
function nameOf({ id, direction }: Component): string {
  return direction === "input" && namedSchemas().differing.has(id) ? `${id}Input` : id;
}

// JsonSchemas describes the schemas of one document: each one as JSON Schema
// that references the named schemas it holds, and then those named schemas
// as the document's components.
export class JsonSchemas {
  readonly #referenced = new Map<string, Component>();

  // of describes a schema, in a direction, referencing the components of the
  // named schemas it holds, itself among them when it is one.
  of(schema: ApiSchema, direction: Direction): JsonSchema {
    const { $defs: defs, ...body } = bodyOf(
      z.toJSONSchema(schema, { io: direction, metadata: registry }),
      direction,
    ) as JsonSchema & { $defs?: Record<string, unknown> };
    // Each named schema it holds must read as its component does, so the
    // reference says no more and no less than the schema would inline.
    const bare = (body: unknown) =>
      JSON.stringify(rewritingRefs(body as JsonSchema, (ref) => ref.replace(/^.*[:/]/, "")));
    for (const [id, inlined] of Object.entries(defs ?? {})) {
      const component = namedSchemas()[direction].get(id);
      if (component === undefined || bare(inlined) !== bare(component)) {
        throw new Error(`${id} reads unlike its component, or holds a cycle no name breaks`);
      }
    }
    return rewritingRefs(body, (ref) => {
      const component = { id: ref.slice("#/$defs/".length), direction };
      this.#referenced.set(nameOf(component), component);
      return componentsAt + nameOf(component);
    });
  }

  // components describes every named schema the descriptions so far
  // reference, directly or through another, each once, by name, in name
  // order.
  components(): Record<string, JsonSchema> {
    const known = namedSchemas();
    const bodies = new Map<string, JsonSchema>();
    const pending = [...this.#referenced];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
      const [name, { id, direction }] = next;
      if (bodies.has(name)) {
        continue;
      }
      const body = rewritingRefs(known[direction].get(id) ?? {}, (ref) => {
        const target = { id: ref.slice(`${direction}:`.length), direction };
        pending.push([nameOf(target), target]);
        return componentsAt + nameOf(target);
      });
      bodies.set(name, body);
    }
    return Object.fromEntries([...bodies].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
}
