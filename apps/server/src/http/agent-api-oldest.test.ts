import { agentApi, agentApiHeader } from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { codeOf, Harness, newAgentKey } from "./test-harness.ts";

// A server whose oldest served version is its own, as once the operator
// decides to stop serving older bridges.
vi.mock("@wayfarerlabs/agention-api", async (original) => {
  const api = await original<typeof import("@wayfarerlabs/agention-api")>();
  return { ...api, agentApi: { ...api.agentApi, oldest: api.agentApi.version } };
});

let harness: Harness;

beforeEach(() => {
  harness = new Harness();
});

afterEach(() => {
  harness.close();
});

it("refuses a version below its oldest before authenticating, a missing header included", async () => {
  const key = newAgentKey();
  const register = (headers: Record<string, string | undefined>) =>
    harness.agent(
      key,
      "POST",
      "/registrations",
      { agent: "builder", session: "main" },
      { headers },
    );
  for (const version of [undefined, String(agentApi.version - 1)]) {
    const headers = { [agentApiHeader]: version };
    const response = await register(headers);
    expect([response.status, codeOf(response)]).toEqual([400, "unsupported_version"]);
    expect(response.headers.get(agentApiHeader)).toBe(String(agentApi.version));
  }
  expect(harness.fixture.db.prepare("SELECT count(*) AS n FROM registrations").get()).toEqual({
    n: 0,
  });
  const served = await register({ [agentApiHeader]: String(agentApi.version) });
  expect(codeOf(served)).toBe("ok");
});
