import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { apiDocsPage } from "./api-docs.ts";
import { agentOperations } from "./agent-operations.ts";
import { apiDocument, apiDocumentText } from "./openapi.ts";
import { operatorOperations } from "./operator-operations.ts";
import { codeOf, Harness } from "./test-harness.ts";

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

describe("the documentation page", () => {
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
