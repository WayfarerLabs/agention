import { z } from "zod";
import { errorBody } from "./errors.ts";
import { groupRef } from "./groups-and-tags.ts";
import {
  monitorCondition,
  monitorProfile,
  monitorReport,
  monitorState,
  nudgeState,
} from "./monitoring.ts";
import { reference } from "./references.ts";
import { registration } from "./registrations.ts";
import {
  presence,
  sessionPresence,
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
  monitorCondition,
  monitorProfile,
  monitorReport,
  monitorState,
  nudgeState,
  openAsks,
  presence,
  priority,
  reference,
  registration,
  sessionPresence,
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

// The registry the descriptions read each named schema's id from. zod reads
// one registry's metadata, so the descriptions given with describe, which
// zod's global registry holds, are added back as each schema is described.
// The global registry carries no ids, so the agent bridge's tool schemas,
// which zod describes from it, stay whole.
const registry = new z.core.$ZodRegistry<z.core.JSONSchemaMeta>();
for (const [name, schema] of Object.entries(named)) {
  registry.add(schema, { id: name.charAt(0).toUpperCase() + name.slice(1) });
}

type Override = NonNullable<NonNullable<Parameters<typeof z.toJSONSchema>[1]>["override"]>;

const withDescriptions: Override = ({ zodSchema, jsonSchema }) => {
  const { id: _, ...meta } = z.globalRegistry.get(zodSchema) ?? {};
  Object.assign(jsonSchema, meta);
};

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

// inDirection describes a schema as the direction reads it, pointing each
// reference to a named schema at its component. zod references the schema
// it describes as "#" when that schema holds itself, which in the document
// would be the document, so that throws.
function inDirection(value: JsonSchema, direction: Direction): JsonSchema {
  return JSON.parse(
    JSON.stringify(direction === "output" ? allowingMore(value) : value, (key, each: unknown) => {
      if (key !== "$ref" || typeof each !== "string") {
        return each;
      }
      if (!each.startsWith("#/$defs/")) {
        throw new Error(`a cycle that no named schema breaks references ${each}`);
      }
      return each.replace("#/$defs/", componentsAt);
    }),
  ) as JsonSchema;
}

// JsonSchemas describes the schemas of one document: each one as JSON Schema
// that references the named schemas it holds, and then those named schemas
// as the document's components. zod describes the named schemas a schema
// holds under its $defs, by id, and those are the components. A component
// reads the same wherever it is referenced, so a named schema that reads
// differently as input than as output, such as one with defaults, may be
// described in only one direction; describing it in both throws, as does a
// schema holding a cycle that no named schema breaks.
export class JsonSchemas {
  // Each component by its id, as JSON text, so another description of it
  // compares as text.
  readonly #components = new Map<string, string>();

  // of describes a schema, in a direction, referencing the components of the
  // named schemas it holds, itself among them when it is one.
  of(schema: ApiSchema, direction: Direction): JsonSchema {
    const {
      $schema: _,
      $id: __,
      $defs: defs,
      ...body
    } = z.toJSONSchema(schema, {
      io: direction,
      metadata: registry,
      override: withDescriptions,
    }) as JsonSchema & { $defs?: Record<string, JsonSchema> };
    for (const [id, def] of Object.entries(defs ?? {})) {
      if (!(id.charAt(0).toLowerCase() + id.slice(1) in named)) {
        throw new Error(`${id} is a cycle that no named schema breaks`);
      }
      const text = JSON.stringify(inDirection(def, direction));
      const known = this.#components.get(id);
      if (known !== undefined && known !== text) {
        throw new Error(`${id} reads differently as input than as output`);
      }
      this.#components.set(id, text);
    }
    return inDirection(body, direction);
  }

  // components describes every named schema the descriptions so far hold,
  // directly or through another, each once, by id, in id order.
  components(): Record<string, JsonSchema> {
    return Object.fromEntries(
      [...this.#components]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([id, text]) => [id, JSON.parse(text) as JsonSchema]),
    );
  }
}
