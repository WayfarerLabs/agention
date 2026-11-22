import type { Hono } from "hono";
import { apiDocument, apiDocumentText } from "./openapi.ts";
import { escapeHtml } from "./web-ui.ts";

// The API's documentation, which agention serve --api-docs serves without
// sign-in, since it describes the contract and no data: the OpenAPI document
// at /docs/api/openapi.json, and a page a person reads at /docs/api/, which
// the server renders from the same document. The page is static HTML with no
// script or style, so the content security policy holds as it is, and
// everything it shows from the document is escaped.

export const apiDocsPath = "/docs/api/";

type JsonObject = Record<string, unknown>;

const methods = ["get", "post"] as const;

// A schema's section on the page, by the name it has under
// components.schemas, which are letters and digits only.
const schemaAnchor = (name: string) => `schema-${name}`;

// json writes a value as formatted JSON, each reference to a schema under
// components.schemas a link to that schema's section.
const json = (value: unknown) =>
  `<pre>${escapeHtml(JSON.stringify(value, null, 2)).replace(
    /&quot;\$ref&quot;: &quot;#\/components\/schemas\/([A-Za-z0-9]+)&quot;/g,
    (_, name: string) =>
      `&quot;$ref&quot;: &quot;<a href="#${schemaAnchor(name)}">#/components/schemas/${name}</a>&quot;`,
  )}</pre>`;
const text = (value: unknown) => escapeHtml(String(value ?? ""));

// refOf resolves a local $ref, such as #/components/responses/error, in the
// document.
function refOf(document: JsonObject, value: unknown): JsonObject {
  const ref = (value as { $ref?: unknown }).$ref;
  if (typeof ref !== "string") {
    return value as JsonObject;
  }
  return ref
    .slice(2)
    .split("/")
    .reduce<JsonObject>((at, key) => at[key] as JsonObject, document);
}

function parametersTable(document: JsonObject, parameters: unknown[]): string {
  const rows = parameters.map((each) => {
    const parameter = refOf(document, each);
    return (
      `<tr><td><code>${text(parameter.name)}</code></td><td>${text(parameter.in)}</td>` +
      `<td>${parameter.required === true ? "yes" : "no"}</td>` +
      `<td>${text(parameter.description)}</td><td>${json(parameter.schema)}</td></tr>`
    );
  });
  return (
    "<h4>Parameters</h4><table><thead><tr><th>Name</th><th>In</th><th>Required</th>" +
    `<th>Description</th><th>Schema</th></tr></thead><tbody>${rows.join("")}</tbody></table>`
  );
}

function operationSection(
  document: JsonObject,
  method: string,
  path: string,
  operation: JsonObject,
): string {
  const security = (operation.security ?? []) as Record<string, string[]>[];
  const schemes = security.flatMap((each) =>
    Object.entries(each).map(([scheme, scopes]) =>
      scopes.length === 0
        ? `<code>${text(scheme)}</code>`
        : `<code>${text(scheme)}</code> with scope <code>${text(scopes.join(", "))}</code>`,
    ),
  );
  const parameters = (operation.parameters ?? []) as unknown[];
  const body = (operation.requestBody as JsonObject | undefined)?.content as
    Record<string, JsonObject> | undefined;
  const responses = operation.responses as Record<string, unknown>;
  const answer = refOf(document, responses["200"]).content as Record<string, JsonObject>;
  return [
    `<section id="${text(operation.operationId)}">`,
    `<h3><code>${text(method.toUpperCase())} ${text(path)}</code></h3>`,
    `<p>${text(operation.summary)}</p>`,
    `<p>Authentication: ${schemes.length === 0 ? "none" : schemes.join("; ")}</p>`,
    parameters.length === 0 ? "" : parametersTable(document, parameters),
    body === undefined ? "" : `<h4>Request body</h4>${json(body["application/json"]?.schema)}`,
    `<h4>Response</h4>${json(answer["application/json"]?.schema)}`,
    "</section>",
  ].join("\n");
}

// apiDocsPage renders the page from the document.
export function apiDocsPage(document: JsonObject): string {
  const info = document.info as JsonObject;
  const tags = document.tags as JsonObject[];
  const paths = document.paths as Record<string, Record<string, JsonObject>>;
  const components = document.components as JsonObject;
  const schemes = components.securitySchemes as Record<string, JsonObject>;
  const error = (components.responses as Record<string, JsonObject>).error as JsonObject;
  const sections = tags.map((tag) => {
    const operations = Object.entries(paths).flatMap(([path, item]) =>
      methods.flatMap((method) => {
        const operation = item[method];
        return operation !== undefined && (operation.tags as string[]).includes(String(tag.name))
          ? [operationSection(document, method, path, operation)]
          : [];
      }),
    );
    return `<h2>${text(tag.name)}</h2>\n<p>${text(tag.description)}</p>\n${operations.join("\n")}`;
  });
  // The schemas the operations reference, each in a section of its own that
  // the references link to.
  const named = Object.entries((components.schemas ?? {}) as Record<string, unknown>).map(
    ([name, schema]) =>
      `<section id="${text(schemaAnchor(name))}">\n<h3><code>${text(name)}</code></h3>\n` +
      `${json(schema)}\n</section>`,
  );
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${text(info.title)}</title>`,
    "</head>",
    "<body>",
    `<h1>${text(info.title)}</h1>`,
    `<p>${text(info.description)}</p>`,
    `<p>Version: ${text(info.version)}. The machine-readable description: ` +
      `<a href="${apiDocsPath}openapi.json">openapi.json</a>.</p>`,
    "<h2>Authentication</h2>",
    "<dl>",
    ...Object.entries(schemes).map(
      ([name, scheme]) => `<dt><code>${text(name)}</code></dt><dd>${text(scheme.description)}</dd>`,
    ),
    "</dl>",
    "<h2>Errors</h2>",
    `<p>${text(error.description)}</p>`,
    json((error.content as Record<string, JsonObject>)["application/json"]?.schema),
    ...sections,
    "<h2>Schemas</h2>",
    "<p>The schemas the operations above reference, each described once.</p>",
    ...named,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

// serveApiDocs adds the documentation's routes, built once as the server
// starts. The page's address without its trailing slash leads to it.
export function serveApiDocs(app: Hono): void {
  const document = apiDocument();
  const documentText = apiDocumentText(document);
  const page = apiDocsPage(document);
  app.get(`${apiDocsPath}openapi.json`, (c) =>
    c.body(documentText, 200, { "content-type": "application/json; charset=utf-8" }),
  );
  app.get(apiDocsPath, (c) => c.html(page));
  app.get(apiDocsPath.slice(0, -1), (c) => c.redirect(apiDocsPath, 301));
}
