import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDirectory } from "../test-directory.ts";
import { contentSecurityPolicy } from "./app.ts";
import { Harness, host, origin } from "./test-harness.ts";

const assetCaching = "public, max-age=31536000, immutable";
const script = "console.log(1);\n".repeat(200);
const asset = "/assets/app-AB12CD34.js";

let harness: Harness;

beforeEach(() => {
  const dir = testDirectory("web");
  mkdirSync(path.join(dir, "assets"));
  const write = (name: string, content: string | Buffer) =>
    writeFileSync(path.join(dir, name), content);
  write("index.html", "<!doctype html><title>Agention</title>");
  write(asset, script);
  write(`${asset}.br`, brotliCompressSync(script));
  // A Brotli copy beside a file outside assets/, which the build never writes.
  write("favicon.svg", "<svg/>");
  write("favicon.svg.br", brotliCompressSync("<svg/>"));
  harness = new Harness({ webRoot: dir });
});

afterEach(() => {
  harness.close();
});

// send makes a request and returns its answer's bytes as they were sent.
async function send(target: string, headers: Record<string, string> = {}) {
  const response = await harness.app.request(target, { headers: { host, ...headers } });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers),
    bytes: Buffer.from(await response.arrayBuffer()),
  };
}

describe("a file under assets/", () => {
  it("is sent as its Brotli copy to a browser that accepts it, kept for good", async () => {
    const response = await send(asset, { "accept-encoding": "gzip, deflate, br, zstd" });
    expect(response.status).toBe(200);
    expect(brotliDecompressSync(response.bytes).toString()).toBe(script);
    expect(response.headers).toMatchObject({
      "content-encoding": "br",
      "content-type": "text/javascript; charset=utf-8",
      vary: "Accept-Encoding",
      "cache-control": assetCaching,
      "content-security-policy": contentSecurityPolicy(origin),
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    });
  });

  it("is sent as it is to one that does not, kept for good", async () => {
    const response = await send(asset, { "accept-encoding": "gzip, deflate" });
    expect([response.status, response.bytes.toString()]).toEqual([200, script]);
    expect(response.headers).not.toHaveProperty("content-encoding");
    expect(response.headers).toMatchObject({
      "content-type": "text/javascript; charset=utf-8",
      vary: "Accept-Encoding",
      "cache-control": assetCaching,
    });
  });

  it("is kept from a range of it, but not from an answer that carries none of it", async () => {
    const part = await send(asset, { range: "bytes=2-9" });
    expect([part.status, part.bytes.toString()]).toEqual([206, script.slice(2, 10)]);
    expect(part.headers["cache-control"]).toBe(assetCaching);
    const none = await send(asset, { range: "bytes=99999999-" });
    expect([none.status, none.headers["cache-control"]]).toEqual([416, "no-store"]);
  });
});

it.each(["/assets/missing-AB12CD34.js", "/assets", "/assets/", "/assets/..%2f", `${asset}/`])(
  "a path under assets/ that names no file is not_found, not kept (%s)",
  async (target) => {
    const response = await send(target, { "accept-encoding": "br" });
    expect([
      response.status,
      JSON.parse(response.bytes.toString()).error.code,
      response.headers["cache-control"],
    ]).toEqual([404, "not_found", "no-store"]);
  },
);

it("a file outside assets/ is sent as it is, not kept", async () => {
  const response = await send("/favicon.svg", { "accept-encoding": "br" });
  expect([response.status, response.bytes.toString()]).toEqual([200, "<svg/>"]);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.headers).not.toHaveProperty("content-encoding");
});
