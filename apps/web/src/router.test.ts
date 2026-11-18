import { describe, expect, it } from "vitest";
import { listHref, listViewOf } from "./router.tsx";

// roundTrip reads the list an address names and writes its address again.
const roundTrip = (address: string) =>
  listHref(listViewOf(new URL(address, "https://agention.test").searchParams));

describe("a list's address", () => {
  it("names every part of the list as the API's query does, and is written back as it was", () => {
    const address =
      "/?search=release+notes&status=open&priority=high&impact=blocking&overdue=true" +
      "&effort=quick&unread=true&agent_read=stranded&agent=builder&agent=reviewer" +
      "&session=builder/main&topic=builder/main/auth&topic=reviewer/side/billing" +
      "&include_archived=true&sort=due&reverse=true&group=session";
    expect(listViewOf(new URL(address, "https://agention.test").searchParams)).toEqual({
      search: "release notes",
      status: "open",
      priority: "high",
      impact: "blocking",
      overdue: true,
      effort: "quick",
      unread: true,
      agent_read: "stranded",
      agent: ["builder", "reviewer"],
      session: ["builder/main"],
      topic: ["builder/main/auth", "reviewer/side/billing"],
      include_archived: true,
      sort: "due",
      reverse: true,
      group: "session",
    });
    expect(roundTrip(address)).toBe(address);
    expect(roundTrip("/")).toBe("/");
  });

  const agents = Array.from({ length: 51 }, (_, i) => `agent=agent-${i}`).join("&");
  it.each([
    ["an unknown value", "/?priority=low&sort=oldest&group=topic&unread=true", "/?unread=true"],
    ["a malformed name", "/?agent=Builder&unread=true", "/?unread=true"],
    ["a name given twice", "/?agent=builder&agent=builder&unread=true", "/?unread=true"],
    ["more names than the list takes", `/?${agents}&unread=true`, "/?unread=true"],
    ["a part given twice that takes one value", "/?sort=due&sort=latest", "/"],
    ["a direction that is not a flag", "/?sort=due&reverse=yes", "/?sort=due"],
    ["the order's own direction", "/?sort=due&reverse=false", "/?sort=due"],
    ["a topic without its session", "/?topic=auth&unread=true", "/?unread=true"],
    ["a topic outside the name grammar", "/?topic=builder/main/Auth&unread=true", "/?unread=true"],
  ])("leaves out %s, keeping the rest", (_, address, kept) => {
    expect(roundTrip(address)).toBe(kept);
  });
});
