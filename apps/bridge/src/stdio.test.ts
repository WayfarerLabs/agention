import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { registrationCode } from "@wayfarerlabs/agention-api/registration-code";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";
import { agent, BridgeHarness, certificate, session } from "./test-harness.ts";

// The bridge run as an agent host runs it: its own process, started from
// source, speaking MCP on standard input and output, configured only by its
// environment, and trusting the server's private certificate authority
// through NODE_EXTRA_CA_CERTS.

let harness: BridgeHarness;

beforeEach(async () => {
  harness = await new BridgeHarness().start();
  // The bridge's process signs with the real clock.
  harness.server.fixture.now = Date.now();
});

afterEach(async () => {
  await harness.close();
});

// startBridge starts the bridge, trusting the server's certificate through
// NODE_EXTRA_CA_CERTS unless told not to.
async function startBridge(trust = true): Promise<{ client: Client; stderr: () => string }> {
  const authority = path.join(harness.home, "authority.pem");
  writeFileSync(authority, certificate.cert);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("main.ts", import.meta.url))],
    env: {
      PATH: process.env.PATH ?? "",
      HOME: harness.home,
      AGENTION_URL: harness.origin,
      AGENTWORKS_AGENT: agent,
      AGENTWORKS_SESSION: session,
      ...(trust ? { NODE_EXTRA_CA_CERTS: authority } : {}),
    },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const client = new Client({ name: "agention-stdio-test", version: "0.0.0" });
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

it("serves an agent host over standard input and output", async () => {
  const { client, stderr } = await startBridge();
  const { tools } = await client.listTools();
  expect(tools).toHaveLength(8);
  const result = await client.callTool({ name: "register", arguments: {} });
  const [content] = result.content as { text: string }[];
  expect(JSON.parse(content?.text ?? "")).toMatchObject({
    status: "pending",
    code: registrationCode(harness.keyOnDisk()),
  });
  await client.close();
  expect(stderr()).toBe("");
});

it("says to set NODE_EXTRA_CA_CERTS for a server whose authority Node does not trust", async () => {
  const { client } = await startBridge(false);
  const result = await client.callTool({ name: "register", arguments: {} });
  const [content] = result.content as { text: string }[];
  expect(result.isError).toBe(true);
  expect(content?.text).toContain("NODE_EXTRA_CA_CERTS");
  await client.close();
});

it("exits once the host closes its input, even while a call waits on the server", async () => {
  const { client } = await startBridge();
  let release = () => {};
  harness.beforeRequest = () => new Promise<void>((resolve) => (release = resolve));
  const pending = client.callTool({ name: "register", arguments: {} }).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const started = performance.now();
  // The client waits two seconds for the process to exit before signalling it.
  await client.close();
  expect(performance.now() - started).toBeLessThan(1_500);
  release();
  await pending;
});
