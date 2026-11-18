import { describe, expect, it } from "vitest";
import { name } from "./names.ts";

describe("name", () => {
  it.each(["a", "7", "my-agent", "agent_2", "a-_-b", "a".repeat(63)])("accepts %j", (value) => {
    expect(name.safeParse(value).success).toBe(true);
  });

  it.each([
    "",
    "a".repeat(64),
    "-agent",
    "_agent",
    "Agent",
    "agent.one",
    "agent/one",
    "agent one",
    "agent%2F",
    "naïve",
    "agent\n",
    undefined,
    null,
    7,
    true,
    ["admin"],
  ])("rejects %j", (value) => {
    expect(name.safeParse(value).success).toBe(false);
  });
});
