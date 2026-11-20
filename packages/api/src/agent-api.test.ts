import { describe, expect, it } from "vitest";
import { agentApiVersion } from "./agent-api.ts";

describe("agentApiVersion", () => {
  it("reads a missing header as 1 and a positive integer as itself, however long", () => {
    expect(agentApiVersion.parse(undefined)).toBe(1n);
    expect(agentApiVersion.parse("1")).toBe(1n);
    expect(agentApiVersion.parse("12")).toBe(12n);
    expect(agentApiVersion.parse("99999999999999999999")).toBe(99999999999999999999n);
  });

  it.each(["", "0", "-1", "1.5", "02", " 2", "two", "1e3"])("refuses %j", (value) => {
    expect(agentApiVersion.safeParse(value).success).toBe(false);
  });
});
