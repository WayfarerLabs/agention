import {
  agentApi,
  agentApiHeader,
  errorBody,
  oversizedBodyStatus,
  statusByErrorCode,
  unsatisfiableRangeStatus,
  unsizedBodyStatus,
} from "@wayfarerlabs/agention-api";
import { JsonSchemas } from "@wayfarerlabs/agention-api/json-schemas";
import { maxTokenLifetime } from "../auth/agent-tokens.ts";
import { agentOperations, registration } from "./agent-operations.ts";
import {
  type BytesAnswer,
  type BytesBody,
  type Declaration,
  type DescribedSchema,
  isBytes,
} from "./operations.ts";
import { operatorOperations } from "./operator-operations.ts";
import { operatorApiPrefix, operatorApiVersion, versionsDeclaration } from "./operator-api.ts";

// The API's documentation: one OpenAPI 3.1 document of the operator API and
// the agent API, built from the same declarations the mounts build their
// routes from, so it cannot describe a route, field or bound the server does
// not have. Rules a schema enforces only in code (zod refinements) are absent
// from the JSON Schema, so the document may describe less than the server
// checks, never more; a request breaking such a rule answers invalid_input,
// naming the field when the rule concerns one. docs/api/openapi.json holds
// the document as committed, which a test keeps equal to what this builds.

type JsonObject = Record<string, unknown>;

// A documented mount: where it is, the tag its operations are listed under,
// how a caller authenticates on it, if at all, and its declarations. A mount
// listed under another's tag leaves the tag's description to that one.
interface Mount {
  tag: string;
  description?: string;
  prefix: string;
  security: "apiKey" | "agentToken" | undefined;
  versionHeader: boolean;
  declarations: readonly Declaration[];
}

const mounts: readonly Mount[] = [
  // The versions the server serves, beside the versions' mounts, which any
  // client may ask without a key.
  {
    tag: "operator",
    prefix: "/api/operator",
    security: undefined,
    versionHeader: false,
    declarations: [versionsDeclaration],
  },
  {
    tag: "operator",
    description:
      `Version ${operatorApiVersion} of the operator API, which a client calls as the operator ` +
      "with an API key the operator created in Settings. Each operation requires one scope, " +
      "which the key must hold; an operation whose scope the key lacks answers not_found. " +
      "A version changes only additively, with new operations, new optional request fields " +
      "and new response fields, so a client ignores response fields it does not know.",
    prefix: operatorApiPrefix,
    security: "apiKey",
    versionHeader: false,
    declarations: operatorOperations,
  },
  {
    tag: "agent",
    description:
      "The agent API, which the Agention bridge calls for an agent's session. Every request " +
      `and every answer states in ${agentApiHeader} the version its sender speaks.`,
    prefix: "/api/agent",
    security: "agentToken",
    versionHeader: true,
    declarations: [registration, ...agentOperations],
  },
];

// parametersOf describes each property of a path or query schema as an
// OpenAPI parameter, its description lifted from the property's schema.
function parametersOf(
  schemas: JsonSchemas,
  schema: DescribedSchema<unknown>,
  where: "path" | "query",
): JsonObject[] {
  const described = schemas.of(schema, "input");
  const properties = (described.properties ?? {}) as Record<string, JsonObject>;
  const required = new Set((described.required ?? []) as string[]);
  return Object.entries(properties).map(([name, property]) => {
    const { description, ...rest } = property;
    return {
      name,
      in: where,
      required: where === "path" || required.has(name),
      ...(description === undefined ? {} : { description }),
      schema: rest,
      // A parameter taking several values repeats, once for each.
      ...(rest.type === "array" ? { style: "form", explode: true } : {}),
    };
  });
}

// pathOf writes a declared path as OpenAPI's path template.
const pathOf = (mount: Mount, declaration: Declaration) =>
  mount.prefix + declaration.path.replace(/:([a-z]+)/g, "{$1}");

// requestBodyOf describes a body: JSON its schema reads, or bytes as they
// are, which the body's description says how to send.
function requestBodyOf(schemas: JsonSchemas, body: DescribedSchema<unknown> | BytesBody) {
  return isBytes(body)
    ? {
        description: body.description,
        required: true,
        // Any type at all, which Content-Type declares.
        content: { "*/*": {} },
      }
    : { required: true, content: { "application/json": { schema: schemas.of(body, "input") } } };
}

// answersOf describes an operation's answers: JSON its schema reads, or
// bytes in any of their types, a range of them, 206, or 416 for a range
// outside them, which carries the bytes' length in Content-Range and an
// error.
function answersOf(
  schemas: JsonSchemas,
  response: DescribedSchema<unknown> | BytesAnswer,
  headers: JsonObject | undefined,
): JsonObject {
  if (!isBytes(response)) {
    return {
      "200": {
        description: "Done",
        ...(headers === undefined ? {} : { headers }),
        content: { "application/json": { schema: schemas.of(response, "output") } },
      },
    };
  }
  const content = Object.fromEntries(response.types.map((type) => [type, {}]));
  const contentRange = (description: string) => ({
    "Content-Range": { description, schema: { type: "string" } },
  });
  return {
    "200": {
      description: response.description,
      ...(headers === undefined ? {} : { headers }),
      content,
    },
    "206": {
      description: "The range asked for, of the same bytes, with the same headers.",
      headers: { ...headers, ...contentRange("bytes first-last/length") },
      content,
    },
    [unsatisfiableRangeStatus]: {
      description: "The range lies outside the bytes, or the bytes are empty; invalid_input.",
      headers: { ...headers, ...contentRange("bytes */length") },
      content: { "application/json": { schema: schemas.of(errorBody, "output") } },
    },
  };
}

// The Range header a request for bytes may send.
const rangeHeader = {
  name: "Range",
  in: "header",
  required: false,
  description:
    "One range of bytes, as bytes=first-last, bytes=first- or bytes=-suffix, answered 206. " +
    "Several ranges, another unit and anything malformed are ignored, and the bytes are " +
    "answered whole.",
  schema: { type: "string" },
};

function operationOf(schemas: JsonSchemas, mount: Mount, declaration: Declaration): JsonObject {
  const versionHeader = { $ref: "#/components/parameters/agentApiVersion" };
  const parameters = [
    ...(mount.versionHeader ? [versionHeader] : []),
    ...(declaration.params === undefined ? [] : parametersOf(schemas, declaration.params, "path")),
    ...(declaration.query === undefined ? [] : parametersOf(schemas, declaration.query, "query")),
    ...(isBytes(declaration.response) ? [rangeHeader] : []),
  ];
  const name = declaration.name.charAt(0).toUpperCase() + declaration.name.slice(1);
  // A key's scope is listed; an agent's token always holds what every agent
  // operation requires, so none is.
  const scopes =
    mount.security === "apiKey" && declaration.scope !== undefined ? [declaration.scope] : [];
  return {
    operationId: `${mount.tag}${name}`,
    summary: declaration.summary,
    ...(declaration.description === undefined ? {} : { description: declaration.description }),
    tags: [mount.tag],
    security: mount.security === undefined ? [] : [{ [mount.security]: scopes }],
    ...(parameters.length === 0 ? {} : { parameters }),
    ...(declaration.body === undefined
      ? {}
      : { requestBody: requestBodyOf(schemas, declaration.body) }),
    responses: {
      ...answersOf(
        schemas,
        declaration.response,
        mount.versionHeader
          ? { [agentApiHeader]: { $ref: "#/components/headers/agentApiVersion" } }
          : undefined,
      ),
      default: { $ref: "#/components/responses/error" },
    },
  };
}

// The statuses the error codes are sent with, for the error response's
// description.
const statuses =
  Object.entries(statusByErrorCode)
    .map(([code, status]) => `${code} ${status}`)
    .join(", ") +
  `; a body over the server's size limit is invalid_input with ${oversizedBodyStatus}, and ` +
  `one sent without a Content-Length is invalid_input with ${unsizedBodyStatus}`;

// apiDocument builds the OpenAPI document. Each named schema is described
// once, under components.schemas, and referenced wherever it appears.
export function apiDocument(): JsonObject {
  const schemas = new JsonSchemas();
  const paths: Record<string, JsonObject> = {};
  for (const mount of mounts) {
    for (const declaration of mount.declarations) {
      const path = pathOf(mount, declaration);
      paths[path] = {
        ...paths[path],
        [declaration.method.toLowerCase()]: operationOf(schemas, mount, declaration),
      };
    }
  }
  const error = {
    description: `Refused. The status follows error.code: ${statuses}.`,
    content: { "application/json": { schema: schemas.of(errorBody, "output") } },
  };
  return {
    openapi: "3.1.0",
    info: {
      title: "Agention API",
      version: `operator v${operatorApiVersion}, agent v${agentApi.version}`,
      description:
        "The operator API, for a client acting as the operator, and the agent API, for the " +
        "Agention bridge. Every body is JSON but a file's bytes, which an upload sends and a " +
        "file read answers, and every refusal is the shared error shape. " +
        `GET /api/operator lists the operator API versions the server serves; the agent API ` +
        `serves versions ${agentApi.oldest} to ${agentApi.version}.`,
    },
    tags: mounts.flatMap(({ tag, description }) =>
      description === undefined ? [] : [{ name: tag, description }],
    ),
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: "http",
          scheme: "bearer",
          description:
            "An API key the operator created in Agention's Settings, as Authorization: " +
            "Bearer with the secret Settings showed once. A request carrying a cookie is " +
            "refused. The scope an operation lists is the one it requires; a write " +
            "scope includes its resource's read, and sessions:approve includes sessions:read.",
        },
        agentToken: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description:
            "A compact JWS the bridge mints for each request, signed with EdDSA by the " +
            "session's Ed25519 key, whose kid is that key's base64url public key, whose aud " +
            "is the server's origin and whose exp is at most " +
            `${maxTokenLifetime / 1000} seconds away. A request carrying a cookie is refused.`,
        },
      },
      parameters: {
        agentApiVersion: {
          name: agentApiHeader,
          in: "header",
          required: false,
          description:
            `The agent API version the bridge speaks, ${agentApi.oldest} when absent; a ` +
            "version the server does not serve is refused as unsupported_version.",
          schema: { type: "string", pattern: "^[1-9][0-9]*$" },
        },
      },
      headers: {
        agentApiVersion: {
          description: "The agent API version the server speaks.",
          schema: { type: "string", const: String(agentApi.version) },
        },
      },
      responses: { error },
      // Last, once every schema above has named the ones it references.
      schemas: schemas.components(),
    },
  };
}

// apiDocumentText writes the document, by default the one apiDocument builds,
// as docs/api/openapi.json holds it.
export function apiDocumentText(document: JsonObject = apiDocument()): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
