import type { ErrorBody, GroupRead, GroupsAndTags, SessionsPage } from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { codeOf, Harness, newAgentKey } from "./test-harness.ts";

// The groups' colors and order and the tags' rows on the operator's mounts,
// and a session's group and tags given on its approval.

let harness: Harness;

beforeEach(() => {
  harness = new Harness();
});

afterEach(() => {
  harness.close();
});

const fieldOf = (response: { body: unknown }) => (response.body as ErrorBody).error.field;
const listed = async () => (await harness.web("GET", "/groups-and-tags")).body as GroupsAndTags;

async function create(name: string): Promise<GroupRead> {
  return (await harness.web("POST", "/groups", { name })).body as GroupRead;
}

describe("colors", () => {
  it("are refused off the palette, naming the field", async () => {
    const work = await create("Work");
    for (const [path, body] of [
      ["/groups", { name: "Play", color: "pink" }],
      [`/groups/${work.id}/color`, { color: "#ff0000" }],
      ["/tags", { name: "infra", color: "Red" }],
    ] as const) {
      const refused = await harness.web("POST", path, body);
      expect([path, codeOf(refused), fieldOf(refused)]).toEqual([path, "invalid_input", "color"]);
    }
    expect((await listed()).groups).toEqual([{ ...work, sessions: 0 }]);
    expect((await listed()).tags).toEqual([]);
  });
});

describe("the order of groups", () => {
  it("refuses a partial list as invalid_input on groups", async () => {
    const [work] = await Promise.all(["Work", "Play"].map(create));
    const refused = await harness.web("POST", "/groups/order", { groups: [work?.id] });
    expect([codeOf(refused), fieldOf(refused)]).toEqual(["invalid_input", "groups"]);
  });
});

describe("approval", () => {
  // pending submits a registration for builder/main, answering its id.
  async function pending(): Promise<number> {
    const key = newAgentKey();
    await harness.register(key, "builder", "main");
    return harness.registrationId(key);
  }

  const approval = (session: Record<string, unknown>) => ({
    agent: { name: "builder", existing: false },
    session: { name: "main", existing: false, ...session },
  });

  it("puts the session in its group with its tags", async () => {
    const work = await create("Work");
    const id = await pending();
    const approved = await harness.web(
      "POST",
      `/registrations/${id}/approve`,
      approval({ group: work.id, tags: ["infra"] }),
    );
    expect(codeOf(approved)).toBe("ok");
    const page = (await harness.web("GET", "/sessions")).body as SessionsPage;
    expect(page.agents[0]?.sessions[0]).toMatchObject({
      group: { id: work.id, name: "Work" },
      tags: ["infra"],
    });
  });

  it("with a group or tags, needs a key holding sessions:write too, and applies nothing without", async () => {
    const work = await create("Work");
    const id = await pending();
    const { secret } = await harness.createKey(["sessions:approve"]);
    const path = `/registrations/${id}/approve`;
    for (const [session, field] of [
      [{ group: work.id }, "session.group"],
      [{ tags: ["infra"] }, "session.tags"],
    ] as const) {
      const refused = await harness.operator(secret, "POST", path, approval(session));
      expect([codeOf(refused), fieldOf(refused)]).toEqual(["not_found", field]);
    }
    expect((await harness.web("GET", "/registrations")).body).toMatchObject({
      registrations: [{ id, status: "pending" }],
    });
    expect((await listed()).tags).toEqual([]);
    const { secret: both } = await harness.createKey(["sessions:approve", "sessions:write"]);
    expect(codeOf(await harness.operator(both, "POST", path, approval({ group: work.id })))).toBe(
      "ok",
    );
  });
});
