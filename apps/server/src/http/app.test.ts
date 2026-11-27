import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ErrorBody } from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { testDirectory } from "../test-directory.ts";
import { contentSecurityPolicy, maxBodyBytes, securityHeaders } from "./app.ts";
import { ownHeaders } from "./own-headers.ts";
import { type AgentKey, codeOf, Harness, newThread, origin } from "./test-harness.ts";
import { nameSlots } from "./web-ui.ts";

let harness: Harness;

afterEach(() => {
  harness.close();
});

describe("every response", () => {
  beforeEach(() => {
    harness = new Harness();
  });

  it("carries the security headers", async () => {
    const responses = [
      await harness.web("GET", "/session"),
      await harness.web("GET", "/threads", undefined, { cookie: null }),
      await harness.request("GET", "/"),
      await harness.request("GET", "/api/nothing"),
      await harness.request("GET", "/", { headers: { host: "elsewhere.test" } }),
    ];
    for (const response of responses) {
      expect(Object.fromEntries(response.headers)).toMatchObject({
        "content-security-policy": contentSecurityPolicy(origin),
        "strict-transport-security": "max-age=31536000",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        "cache-control": "no-store",
      });
    }
  });
});

describe("the Host check", () => {
  beforeEach(() => {
    harness = new Harness();
  });

  it("accepts the origin's host in any case", async () => {
    const response = await harness.request("GET", "/api/web/session", {
      headers: { host: "Agention.Test" },
    });
    expect(response.status).toBe(200);
  });

  it.each([
    ["another name", "elsewhere.test"],
    ["the origin's host with a port", "agention.test:8443"],
    ["an address", "127.0.0.1"],
    ["two hosts", "agention.test, agention.test"],
  ])("refuses %s on every path", async (_, host) => {
    for (const target of ["/", "/api/web/session", "/api/agent/registrations"]) {
      const response = await harness.request("GET", target, { headers: { host } });
      expect([target, response.status, codeOf(response)]).toEqual([target, 400, "invalid_input"]);
    }
  });
});

describe("request bodies", () => {
  let agent: AgentKey;

  beforeEach(async () => {
    harness = new Harness();
    agent = await harness.approvedAgent("builder", "main");
    await harness.agent(agent, "POST", "/s/builder/main/threads", newThread("r-1"));
  });

  // A JSON mark padded with an unknown field to the given size.
  function paddedMark(bytes: number): string {
    const start = '{"through":1,"pad":"';
    return `${start}${"x".repeat(bytes - start.length - 2)}"}`;
  }

  it("are accepted up to 2 MiB", async () => {
    const response = await harness.agent(
      agent,
      "POST",
      "/s/builder/main/threads/1/read",
      paddedMark(maxBodyBytes),
    );
    expect(codeOf(response)).toBe("ok");
  });

  it("hold the largest message the schemas accept, every character sent as an escape", async () => {
    const astral = (n: number, offset = 0) => String.fromCodePoint(0x1f600 + offset).repeat(n);
    const ask = (i: number) => ({
      question: astral(300, i),
      suggestions: Array.from({ length: 10 }, (_, j) => ({
        label: astral(100, j),
        description: astral(300),
      })),
      multiple: true,
      impact: "assuming",
      priority: "urgent",
      effort: "under_15m",
      answer_by: "2026-11-01T12:00:00.000+00:00",
      fallback: astral(1_000),
    });
    const message = {
      request_id: "r".repeat(64),
      seen_through: 1,
      text: astral(1_000),
      detail: astral(20_000),
      references: Array.from({ length: 20 }, (_, i) => ({
        label: astral(100, i),
        identifier: astral(200),
        url: `https://example.com/${astral(2_028)}`,
        thread: 1,
      })),
      asks: Array.from({ length: 10 }, (_, i) => ask(i)),
      answers: Array.from({ length: 10 }, (_, i) => ({
        ask: i + 1,
        picks: Array.from({ length: 10 }, (_, pick) => pick),
        text: astral(4_000),
      })),
      withdrawals: Array.from({ length: 10 }, (_, i) => ({
        ask: i + 11,
        reason: astral(300, i),
      })),
      topic: "t".repeat(63),
      replaces: 1,
    };
    const body = JSON.stringify(message).replace(
      /[\u007f-\uffff]/g,
      (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
    );
    expect(Buffer.byteLength(body)).toBeGreaterThan(0.8 * maxBodyBytes);
    // The whole body is read and every bound checked: what stops it is that a
    // session does not answer.
    const response = await harness.agent(agent, "POST", "/s/builder/main/threads/1/messages", body);
    expect(codeOf(response)).toBe("not_allowed");
    expect((response.body as ErrorBody).error.field).toBe("answers");
  });

  it("that are not UTF-8 are refused, never repaired", async () => {
    const body = (...parts: Buffer[]) => new Uint8Array(Buffer.concat(parts));
    const text = (value: string) => Buffer.from(value);
    const raw = (...values: number[]) => Buffer.from(values);
    const bodies = [
      // A byte no UTF-8 holds, an encoded surrogate, and a byte order mark.
      body(text('{"through":1,"pad":"'), raw(0xff), text('"}')),
      body(text('{"through":1,"pad":"'), raw(0xed, 0xa0, 0x80), text('"}')),
      body(raw(0xef, 0xbb, 0xbf), text('{"through":1}')),
    ];
    for (const body of bodies) {
      const response = await harness.agent(agent, "POST", "/s/builder/main/threads/1/read", body);
      expect(codeOf(response)).toBe("invalid_input");
    }
  });

  it("over 2 MiB are refused with 413, on both mounts", async () => {
    const body = paddedMark(maxBodyBytes + 1);
    const responses = [
      await harness.agent(agent, "POST", "/s/builder/main/threads/1/read", body),
      await harness.web("POST", "/s/builder/main/threads/1/read", body),
      await harness.web("POST", "/auth/signin/finish", body, { cookie: null }),
    ];
    for (const response of responses) {
      expect(response.status).toBe(413);
      expect(codeOf(response)).toBe("invalid_input");
    }
  });
});

describe("the web UI", () => {
  let root: string;
  let dir: string;

  // An index page that carries the server's name where the build's does: in
  // its title and its metadata naming the application and the home-screen
  // title.
  const indexPage = (name: string) =>
    `<!doctype html><meta name="application-name" content="${name}" />` +
    `<meta name="apple-mobile-web-app-title" content="${name}" /><title>${name}</title>`;

  beforeEach(() => {
    // The build's directory sits beside a file it must never serve.
    root = testDirectory("web");
    dir = path.join(root, "web");
    mkdirSync(path.join(dir, "assets"), { recursive: true });
    writeFileSync(path.join(root, "secret.txt"), "outside the build");
    writeFileSync(path.join(dir, "index.html"), indexPage("Agention"));
    writeFileSync(path.join(dir, "assets", "app-1.js"), "console.log(1);");
    harness = new Harness({ webRoot: dir });
  });

  it("serves the index for every other path outside the API", async () => {
    for (const target of ["/", "/s/builder/main/threads/1", "/registrations", "/link"]) {
      const response = await harness.request("GET", target);
      expect([target, response.status, response.body]).toEqual([
        target,
        200,
        indexPage("Agention"),
      ]);
      expect(response.headers.get("content-type")).toMatch(/^text\/html; charset=utf-8$/i);
    }
  });

  it("writes the server's name into the index, escaped, on every path that serves it", async () => {
    // A case-insensitive file system serves the index's file under any case
    // of its name; a file of another case beside it stands in for that here.
    writeFileSync(path.join(dir, "INDEX.HTML"), indexPage("Agention"));
    harness.close();
    harness = new Harness({ webRoot: dir, name: `Work <&"'> & co` });
    const named = indexPage("Work &lt;&amp;&quot;&#39;&gt; &amp; co");
    for (const target of ["/", "/index.html", "/INDEX.HTML", "/s/builder/main/threads/1"]) {
      const response = await harness.request("GET", target);
      expect([target, response.status, response.body]).toEqual([target, 200, named]);
      expect(response.headers.get("content-security-policy")).toBe(contentSecurityPolicy(origin));
    }
  });

  it("serves the web app manifest with its type, named for the server, on any case of its path", async () => {
    const manifest = { id: "/", name: "Agention", short_name: "Agention", display: "standalone" };
    writeFileSync(path.join(dir, "manifest.webmanifest"), JSON.stringify(manifest));
    writeFileSync(path.join(dir, "MANIFEST.WEBMANIFEST"), JSON.stringify(manifest));
    harness.close();
    const name = `Work <&"'> & co`;
    harness = new Harness({ webRoot: dir, name });
    for (const target of ["/manifest.webmanifest", "/MANIFEST.WEBMANIFEST"]) {
      const response = await harness.request("GET", target);
      expect([target, response.status]).toEqual([target, 200]);
      expect(response.headers.get("content-type")).toBe("application/manifest+json");
      expect(response.headers.get("content-security-policy")).toBe(contentSecurityPolicy(origin));
      expect(response.body).toEqual({ ...manifest, name, short_name: name });
    }
  });

  it("finds each slot for the name exactly once in the web UI's source page", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../../web/index.html", import.meta.url)),
      "utf8",
    );
    expect(nameSlots.map((slot) => source.match(slot)?.length ?? 0)).toEqual(
      nameSlots.map(() => 1),
    );
  });

  it("never serves a file outside the build", async () => {
    for (const target of [
      "/../secret.txt",
      "/assets/../../secret.txt",
      "/%2e%2e/secret.txt",
      "/assets/%2e%2e/%2e%2e/secret.txt",
      // cspell:disable-next-line
      "/..%2fsecret.txt",
    ]) {
      const response = await harness.request("GET", target);
      expect([target, response.body]).not.toEqual([target, "outside the build"]);
    }
  });

  it("answers unknown API routes with the error shape, not the index", async () => {
    for (const [method, target] of [
      ["GET", "/api"],
      ["GET", "/api/other"],
      ["GET", "/api/agent/registrations"],
      ["POST", "/somewhere"],
    ] as const) {
      const response = await harness.request(method, target);
      expect([target, response.status, codeOf(response)]).toEqual([target, 404, "not_found"]);
    }
  });

  it("is a placeholder page when the server was built without it", async () => {
    rmSync(path.join(dir, "index.html"));
    for (const webRoot of [dir, path.join(root, "missing"), undefined]) {
      harness.close();
      harness = new Harness(webRoot === undefined ? {} : { webRoot });
      for (const target of ["/", "/s/builder/main/threads/1", "/assets/app-1.js"]) {
        const response = await harness.request("GET", target);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toMatch(/^text\/html/);
        expect(response.body).not.toContain("<script");
        expect(response.body).not.toContain("console.log");
      }
    }
  });
});

// directives reads a content security policy into its directives, each
// with its values.
function directives(policy: string | null): Map<string, string[]> {
  return new Map(
    (policy ?? "").split(";").map((directive) => {
      const [name = "", ...values] = directive.trim().split(/\s+/);
      return [name, values];
    }),
  );
}

describe("the diagram frame", () => {
  let dir: string;
  const script = "assets/diagram-frame-AB12CD34.js";

  beforeEach(() => {
    dir = testDirectory("web");
    mkdirSync(path.join(dir, "assets"));
    writeFileSync(path.join(dir, "index.html"), "<!doctype html><title>Agention</title>");
    writeFileSync(path.join(dir, script), "drawDiagrams();");
    writeFileSync(path.join(dir, "diagram-frame.json"), JSON.stringify({ script }));
    harness = new Harness({ webRoot: dir });
  });

  it("is a page that loads only its script, sandboxed by its own policy", async () => {
    const response = await harness.request("GET", "/diagram-frame");
    expect(response.status).toBe(200);
    const sources = [...String(response.body).matchAll(/<script src="([^"]*)"><\/script>/g)].map(
      ([, src]) => src,
    );
    expect(sources).toEqual([`/${script}`]);
    const policy = directives(response.headers.get("content-security-policy"));
    expect(Object.fromEntries(policy)).toMatchObject({
      sandbox: ["allow-scripts"],
      "default-src": ["'none'"],
      "script-src": [`${origin}/${script}`],
      "base-uri": ["'none'"],
      "form-action": ["'none'"],
      "frame-ancestors": [origin],
    });
    expect(policy.has("connect-src")).toBe(false);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      "x-frame-options": "SAMEORIGIN",
      "cache-control": "no-store",
      "strict-transport-security": "max-age=31536000",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
  });

  it("keeps a route's own security headers only where it declares them, and only those", async () => {
    const probe = new Hono();
    probe.use(securityHeaders(origin));
    const own = {
      "Content-Security-Policy": "default-src *",
      "X-Frame-Options": "SAMEORIGIN",
      "Cache-Control": "public",
    };
    const declaring = new Map([
      ["/frame", ["content-security-policy", "x-frame-options"]],
      ["/script", ["Cache-Control"]],
      // A declared header the route did not set is still set.
      ["/unset", ["referrer-policy"]],
    ]);
    probe.get("*", (c) => {
      for (const [header, value] of Object.entries(own)) {
        c.header(header, value);
      }
      ownHeaders(c.req.raw, declaring.get(c.req.path) ?? []);
      return c.text("");
    });
    const headersOf = async (target: string) => {
      const response = await probe.request(target);
      return ["content-security-policy", "x-frame-options", "cache-control", "referrer-policy"].map(
        (header) => response.headers.get(header),
      );
    };
    expect(await headersOf("/frame")).toEqual([
      "default-src *",
      "SAMEORIGIN",
      "no-store",
      "no-referrer",
    ]);
    expect(await headersOf("/script")).toEqual([
      contentSecurityPolicy(origin),
      "DENY",
      "public",
      "no-referrer",
    ]);
    for (const target of ["/unset", "/diagram-frame", "/sessions"]) {
      expect(await headersOf(target)).toEqual([
        contentSecurityPolicy(origin),
        "DENY",
        "no-store",
        "no-referrer",
      ]);
    }
  });

  it("is the one frame the web UI may embed, and its images may be blob: URLs", async () => {
    const policy = directives(contentSecurityPolicy(origin));
    expect(policy.get("frame-src")).toEqual([`${origin}/diagram-frame`]);
    expect(policy.get("img-src")).toEqual(["'self'", "blob:"]);
    expect(policy.get("media-src")).toEqual(["'self'"]);
    expect(policy.get("manifest-src")).toEqual(["'self'"]);
    expect(policy.get("worker-src")).toEqual(["'self'"]);
    expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("is not served by a build without it, whose path serves as any other", async () => {
    rmSync(path.join(dir, "diagram-frame.json"));
    harness.close();
    harness = new Harness({ webRoot: dir });
    const response = await harness.request("GET", "/diagram-frame");
    expect(response.body).toBe("<!doctype html><title>Agention</title>");
    expect(response.headers.get("content-security-policy")).toBe(contentSecurityPolicy(origin));
    expect(response.headers.get("x-frame-options")).toBe("DENY");
  });

  it.each([
    ["a script outside the build's assets", { script: "../secret.js" }],
    ["a script the build does not hold", { script: "assets/diagram-frame-MISSING.js" }],
    ["no script", {}],
  ])("stops the server from starting when its manifest names %s", (_, manifest) => {
    writeFileSync(path.join(dir, "diagram-frame.json"), JSON.stringify(manifest));
    harness.close();
    expect(() => new Harness({ webRoot: dir })).toThrow(/diagram-frame\.json/);
    harness = new Harness();
  });
});

describe("unexpected failures", () => {
  beforeEach(() => {
    harness = new Harness();
  });

  it("answer internal, with the details only in the log", async () => {
    harness.fixture.db.close();
    const response = await harness.web("GET", "/threads");
    expect(response.status).toBe(500);
    expect(codeOf(response)).toBe("internal");
    // What the closed database says, as the request's failure did.
    let failure = "";
    try {
      harness.fixture.db.transaction(() => undefined);
    } catch (error) {
      failure = (error as Error).message;
    }
    expect(failure).not.toBe("");
    const logged = harness.logged.join("\n");
    expect(logged).toContain("/api/web/threads");
    expect(logged).toContain(failure);
    expect(JSON.stringify(response.body)).not.toContain(failure);
  });
});
