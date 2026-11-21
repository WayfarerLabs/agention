import { registrationCode } from "@wayfarerlabs/agention-api/registration-code";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, it } from "vitest";
import { BridgeHarness } from "./test-harness.ts";

// The bridge run as an agent host runs it: its own process, started from
// source, speaking MCP on standard input and output, configured only by its
// environment, and trusting the server's private certificate authority
// through NODE_EXTRA_CA_CERTS.

let harness: BridgeHarness;

beforeEach(async () => {
  harness = await new BridgeHarness().start();
});

afterEach(async () => {
  await harness.close();
});

it("serves an agent host over standard input and output", async () => {
  const { bridge, stderr } = await harness.process();
  const { tools } = await bridge.client.listTools();
  expect(tools).toHaveLength(9);
  expect(await bridge.ok("register")).toMatchObject({
    status: "pending",
    code: registrationCode(harness.keyOnDisk()),
  });
  await bridge.close();
  expect(stderr()).toBe("");
});

it("says to set NODE_EXTRA_CA_CERTS for a server whose authority Node does not trust", async () => {
  const { bridge } = await harness.process({ trust: false });
  const answer = await bridge.call("register");
  expect(answer.isError).toBe(true);
  expect(answer.text).toContain("NODE_EXTRA_CA_CERTS");
});

it("exits once the host closes its input, even while a call waits on the server", async () => {
  const { bridge } = await harness.process();
  const { client } = bridge;
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
