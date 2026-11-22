import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { apiDocsPage } from "./api-docs.ts";
import { contentSecurityPolicy } from "./app.ts";
import { agentOperations } from "./agent-operations.ts";
import { apiDocument, apiDocumentText } from "./openapi.ts";
import { operatorOperations } from "./operator-operations.ts";
import { codeOf, Harness, origin } from "./test-harness.ts";

const committed = new URL("../../../../docs/api/openapi.json", import.meta.url);

let harness: Harness | undefined;

afterEach(() => {
  harness?.close();
  harness = undefined;
});

describe("the OpenAPI document", () => {
  it("is committed as generated; run scripts/generate-api-docs.sh after changing the API", () => {
    expect(readFileSync(committed, "utf8") === apiDocumentText()).toBe(true);
  });

  it("documents every operation of both mounts, with its scope", () => {
    const paths = apiDocument().paths as Record<string, Record<string, Record<string, unknown>>>;
    const documented = Object.values(paths).flatMap((item) => Object.values(item));
    const byId = new Map(documented.map((each) => [each.operationId, each]));
    for (const each of operatorOperations) {
      const name = `operator${each.name.charAt(0).toUpperCase()}${each.name.slice(1)}`;
      expect([name, byId.get(name)?.security]).toEqual([name, [{ apiKey: [each.scope] }]]);
    }
    for (const each of agentOperations) {
      const name = `agent${each.name.charAt(0).toUpperCase()}${each.name.slice(1)}`;
      expect(byId.has(name)).toBe(true);
    }
  });
});

// The names of the schemas a value references under components.schemas.
function schemaRefsIn(value: unknown): string[] {
  const found: string[] = [];
  JSON.stringify(value, (key, each: unknown) => {
    if (key === "$ref" && typeof each === "string" && each.startsWith("#/components/schemas/")) {
      found.push(each.slice("#/components/schemas/".length));
    }
    return each;
  });
  return found;
}

describe("the document's shared schemas", () => {
  it("are each described once, and each referenced", () => {
    const document = apiDocument();
    const { schemas } = document.components as { schemas: Record<string, unknown> };
    expect(Object.keys(schemas).length).toBeGreaterThan(0);
    expect([...new Set(schemaRefsIn(document))].sort()).toEqual(Object.keys(schemas).sort());
  });
});

describe("the documentation page", () => {
  it("gives each shared schema a section, which each reference to it links to", () => {
    const document = apiDocument();
    const page = apiDocsPage(document);
    const { schemas } = document.components as { schemas: Record<string, unknown> };
    const sections = [...page.matchAll(/<section id="schema-([A-Za-z0-9]+)">/g)].map(
      (match) => match[1],
    );
    const links = new Set(
      [...page.matchAll(/<a href="#schema-([A-Za-z0-9]+)">/g)].map((match) => match[1]),
    );
    expect(sections.sort()).toEqual(Object.keys(schemas).sort());
    expect([...links].sort()).toEqual(Object.keys(schemas).sort());
  });

  it("carries no script and escapes what it shows", () => {
    const hostile = "<script>alert(1)</script>";
    const document = apiDocument();
    const page = apiDocsPage({
      ...document,
      info: { ...(document.info as object), title: hostile, description: hostile },
    });
    expect(page).not.toMatch(/<script/i);
    expect(page).toContain("&lt;script&gt;");
  });
});

describe("serving the documentation", () => {
  const paths = ["/docs/api/", "/docs/api/openapi.json"];

  it("serves the page and the document with --api-docs, without sign-in", async () => {
    harness = new Harness({ apiDocs: true });
    const document = await harness.request("GET", "/docs/api/openapi.json");
    expect([document.status, document.headers.get("content-type")]).toEqual([
      200,
      "application/json; charset=utf-8",
    ]);
    expect(document.body).toEqual(JSON.parse(apiDocumentText()));
    const page = await harness.request("GET", "/docs/api/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/^text\/html/);
    expect(page.body).toBe(apiDocsPage(apiDocument()));
  });

  it("serves the page under a policy of its own that loads, runs and submits nothing", async () => {
    harness = new Harness({ apiDocs: true });
    const page = await harness.request("GET", "/docs/api/");
    const policy = new Map(
      (page.headers.get("content-security-policy") ?? "").split(";").map((directive) => {
        const [name = "", ...values] = directive.trim().split(/\s+/);
        return [name, values];
      }),
    );
    expect(Object.fromEntries(policy)).toEqual({
      "default-src": ["'none'"],
      "base-uri": ["'none'"],
      "form-action": ["'none'"],
      "frame-ancestors": ["'none'"],
    });
    expect(Object.fromEntries(page.headers)).toMatchObject({
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    const document = await harness.request("GET", "/docs/api/openapi.json");
    expect(document.headers.get("content-security-policy")).toBe(contentSecurityPolicy(origin));
  });

  it("leads from /docs/api to the page with --api-docs", async () => {
    harness = new Harness({ apiDocs: true });
    const response = await harness.request("GET", "/docs/api");
    expect([response.status, response.headers.get("location")]).toEqual([301, "/docs/api/"]);
  });

  it("answers not_found there without the flag, not the web UI", async () => {
    harness = new Harness();
    for (const path of [...paths, "/docs/api", "/docs/api/other"]) {
      expect([path, codeOf(await harness.request("GET", path))]).toEqual([path, "not_found"]);
    }
  });
});
