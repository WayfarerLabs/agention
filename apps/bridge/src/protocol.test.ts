import { InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { createBridge } from "./bridge.ts";

// The protocol as each agent host speaks it, message by message: Codex opens
// with initialize at 2025-06-18, and Claude Code probes server/discover, then
// opens with initialize at 2025-11-25.

interface Reply {
  id?: number;
  result?: { protocolVersion?: string; serverInfo?: { name: string; version: string } };
  error?: { code: number };
}

async function connected() {
  const bridge = createBridge({
    environment: { AGENTION_URL: "https://agention.example.com" },
    home: "/nonexistent",
  });
  const [client, server] = InMemoryTransport.createLinkedPair();
  await bridge.connect(server);
  const replies = new Map<number, (reply: Reply) => void>();
  client.onmessage = (message) => {
    const reply = message as Reply;
    if (reply.id !== undefined) {
      replies.get(reply.id)?.(reply);
    }
  };
  await client.start();
  let next = 0;
  const ask = (method: string, params: Record<string, unknown>): Promise<Reply> => {
    const id = ++next;
    const answered = new Promise<Reply>((resolve) => replies.set(id, resolve));
    void client.send({ jsonrpc: "2.0", id, method, params });
    return answered;
  };
  return { ask, close: () => bridge.close() };
}

const clientInfo = { name: "host", version: "1.0.0" };

describe("the bridge", () => {
  it.each(["2025-06-18", "2025-11-25"])("opens with initialize at %s", async (version) => {
    const { ask, close } = await connected();
    const reply = await ask("initialize", {
      protocolVersion: version,
      capabilities: {},
      clientInfo,
    });
    expect(reply.result).toMatchObject({
      protocolVersion: version,
      serverInfo: { name: "agention", version: packageJson.version },
    });
    await close();
  });

  it("answers server/discover as a method it does not have", async () => {
    const { ask, close } = await connected();
    expect((await ask("server/discover", {})).error?.code).toBe(-32601);
    const reply = await ask("initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo,
    });
    expect(reply.result?.protocolVersion).toBe("2025-11-25");
    await close();
  });
});
