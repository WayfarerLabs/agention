import {
  groupNameInput,
  maxGroups,
  sessionsQuery,
  sessionThreadsQuery,
  tagsInput,
  threadsQuery,
} from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.ts";
import type { Identity } from "../identity.ts";
import {
  createGroup,
  listGroupsAndTags,
  removeGroup,
  removeTag,
  renameGroup,
  renameTag,
  setAgentTags,
  setSessionGroup,
  setSessionTags,
} from "./groups-and-tags.ts";
import { listSessions } from "./sessions.ts";
import { listSessionThreads, listThreads } from "./thread-lists.ts";
import { type Agent, Fixture } from "./test-fixture.ts";

let fixture: Fixture;
let builder: Agent;
let side: Agent;
let reviewer: Agent;

beforeEach(() => {
  fixture = new Fixture();
  builder = fixture.registerAgent("builder", "main");
  side = fixture.registerAgent("builder", "side");
  reviewer = fixture.registerAgent("reviewer", "main");
});

afterEach(() => {
  fixture.close();
});

function failure(fn: () => unknown): { code: string; field: string | undefined } {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return { code: error.code, field: error.field };
    }
    throw error;
  }
  throw new Error("expected the operation to fail");
}

const store = () => fixture.store;
const operator = () => fixture.operator;
const create = (name: string, identity: Identity = operator()) =>
  createGroup(store(), identity, groupNameInput.parse({ name }));
const group = (session: Agent, id: number | null) =>
  setSessionGroup(store(), operator(), session.target, { group: id });
const sessionTags = (session: Agent, tags: string[]) =>
  setSessionTags(store(), operator(), session.target, tagsInput.parse({ tags }));
const agentTags = (agent: string, tags: string[]) =>
  setAgentTags(store(), operator(), agent, tagsInput.parse({ tags }));
const listed = () => listGroupsAndTags(store(), operator());

// What the sessions view shows of each agent's tags, and of each session's
// group and tags.
function organized() {
  return listSessions(store(), operator(), sessionsQuery.parse({})).agents.map((agent) => ({
    agent: agent.agent,
    tags: agent.tags,
    sessions: agent.sessions.map((session) => ({
      session: session.session,
      group: session.group?.name,
      tags: session.tags,
    })),
  }));
}

describe("groups", () => {
  it("are listed in name order with the sessions each holds, empty ones included", () => {
    const work = create("Work: billing");
    const play = create("personal");
    const archive = create("Archive");
    group(builder, work.id);
    group(side, work.id);
    group(reviewer, play.id);
    expect(listed().groups).toEqual([
      { id: archive.id, name: "Archive", sessions: 0 },
      { id: play.id, name: "personal", sessions: 1 },
      { id: work.id, name: "Work: billing", sessions: 2 },
    ]);
    expect(organized()).toEqual([
      {
        agent: "builder",
        tags: [],
        sessions: [
          { session: "main", group: "Work: billing", tags: [] },
          { session: "side", group: "Work: billing", tags: [] },
        ],
      },
      { agent: "reviewer", tags: [], sessions: [{ session: "main", group: "personal", tags: [] }] },
    ]);
  });

  it("are named uniquely, ignoring the case of ASCII letters, and trimmed", () => {
    const work = create("  Work  ");
    expect(work.name).toBe("Work");
    expect(failure(() => create("WORK"))).toEqual({ code: "conflict", field: "name" });
    const play = create("Play");
    expect(failure(() => renameGroup(store(), operator(), play.id, { name: "work" }))).toEqual({
      code: "conflict",
      field: "name",
    });
    // A group may take its own name in another case.
    expect(renameGroup(store(), operator(), work.id, { name: "WORK" })).toEqual({
      id: work.id,
      name: "WORK",
    });
    expect(listed().groups.map((each) => each.name)).toEqual(["Play", "WORK"]);
  });

  it("keep their sessions and their id when renamed", () => {
    const work = create("Work");
    group(builder, work.id);
    renameGroup(store(), operator(), work.id, { name: "Billing" });
    expect(listed().groups).toEqual([{ id: work.id, name: "Billing", sessions: 1 }]);
  });

  it("leave their sessions in no group when removed", () => {
    const work = create("Work");
    const play = create("Play");
    group(builder, work.id);
    group(side, play.id);
    removeGroup(store(), operator(), work.id);
    expect(listed().groups).toEqual([{ id: play.id, name: "Play", sessions: 1 }]);
    expect(fixture.db.prepare("SELECT session_id FROM session_group_members").all()).toEqual([
      { session_id: side.sessionId },
    ]);
    expect(failure(() => removeGroup(store(), operator(), work.id))).toEqual({
      code: "not_found",
      field: "id",
    });
  });

  it("never give a removed group's id to a group made after it", () => {
    const work = create("Work");
    group(builder, work.id);
    fixture.createThread(builder);
    const kept = (id: number) =>
      listThreads(store(), operator(), threadsQuery.parse({ session_group: String(id) })).total;
    expect(kept(work.id)).toBe(1);
    removeGroup(store(), operator(), work.id);
    expect(kept(work.id)).toBe(0);
    const play = create("Play");
    group(builder, play.id);
    expect(play.id).not.toBe(work.id);
    expect(kept(work.id)).toBe(0);
    expect(kept(play.id)).toBe(1);
  });

  it("hold a session in at most one, and let it leave", () => {
    const work = create("Work");
    const play = create("Play");
    group(builder, work.id);
    group(builder, play.id);
    expect(listed().groups.map((each) => each.sessions)).toEqual([1, 0]);
    group(builder, null);
    expect(listed().groups.map((each) => each.sessions)).toEqual([0, 0]);
    expect(organized()[0]?.sessions[0]?.group).toBeUndefined();
  });

  it("refuse an unknown group, session or id", () => {
    expect(failure(() => group(builder, 7))).toEqual({ code: "not_found", field: "group" });
    expect(
      failure(() =>
        setSessionGroup(
          store(),
          operator(),
          { agent: "builder", session: "gone" },
          { group: null },
        ),
      ).code,
    ).toBe("not_found");
    expect(failure(() => renameGroup(store(), operator(), 7, { name: "Seven" }))).toEqual({
      code: "not_found",
      field: "id",
    });
  });

  it(`number at most ${maxGroups}`, () => {
    for (let index = 0; index < maxGroups; index++) {
      create(`Group ${index}`);
    }
    expect(failure(() => create("One more")).code).toBe("invalid_input");
  });
});

describe("tags", () => {
  it("are listed in name order with the agents and sessions carrying each", () => {
    agentTags("builder", ["infra", "billing"]);
    sessionTags(builder, ["urgent", "infra"]);
    sessionTags(reviewer, ["infra"]);
    expect(listed()).toMatchObject({
      tags: [
        { name: "billing", agents: 1, sessions: 0 },
        { name: "infra", agents: 1, sessions: 2 },
        { name: "urgent", agents: 0, sessions: 1 },
      ],
      truncated: false,
    });
    expect(organized()).toEqual([
      {
        agent: "builder",
        tags: ["billing", "infra"],
        sessions: [
          { session: "main", group: undefined, tags: ["infra", "urgent"] },
          { session: "side", group: undefined, tags: [] },
        ],
      },
      {
        agent: "reviewer",
        tags: [],
        sessions: [{ session: "main", group: undefined, tags: ["infra"] }],
      },
    ]);
  });

  it("are set whole, so a tag left out comes off and none clears them", () => {
    sessionTags(builder, ["a", "b"]);
    sessionTags(builder, ["b", "c"]);
    expect(organized()[0]?.sessions[0]?.tags).toEqual(["b", "c"]);
    sessionTags(builder, []);
    expect(organized()[0]?.sessions[0]?.tags).toEqual([]);
    expect(listed().tags).toEqual([]);
  });

  it("are renamed everywhere they are carried, onto a name no tag has", () => {
    agentTags("builder", ["infra"]);
    sessionTags(reviewer, ["infra", "ops"]);
    renameTag(store(), operator(), "infra", { name: "platform" });
    expect(listed().tags).toEqual([
      { name: "ops", agents: 0, sessions: 1 },
      { name: "platform", agents: 1, sessions: 1 },
    ]);
    expect(failure(() => renameTag(store(), operator(), "ops", { name: "platform" }))).toEqual({
      code: "conflict",
      field: "name",
    });
    expect(failure(() => renameTag(store(), operator(), "infra", { name: "x" }))).toEqual({
      code: "not_found",
      field: "tag",
    });
    // Renaming a tag to its own name changes nothing.
    renameTag(store(), operator(), "ops", { name: "ops" });
    expect(listed().tags.map((each) => each.name)).toEqual(["ops", "platform"]);
  });

  it("are removed from everything carrying them", () => {
    agentTags("builder", ["infra", "billing"]);
    sessionTags(builder, ["infra"]);
    removeTag(store(), operator(), "infra");
    expect(listed().tags).toEqual([{ name: "billing", agents: 1, sessions: 0 }]);
    expect(failure(() => removeTag(store(), operator(), "infra"))).toEqual({
      code: "not_found",
      field: "tag",
    });
  });

  it("refuse an unknown agent or session", () => {
    expect(failure(() => agentTags("nobody", ["x"])).code).toBe("not_found");
    expect(
      failure(() =>
        setSessionTags(store(), operator(), { agent: "builder", session: "gone" }, { tags: [] }),
      ).code,
    ).toBe("not_found");
  });
});

describe("an agent", () => {
  it("finds that no group or tag exists for it", () => {
    const work = create("Work");
    agentTags("builder", ["infra"]);
    const agent = builder.identity;
    for (const fn of [
      () => listGroupsAndTags(store(), agent),
      () => create("Mine", agent),
      () => renameGroup(store(), agent, work.id, { name: "Mine" }),
      () => removeGroup(store(), agent, work.id),
      () => renameTag(store(), agent, "infra", { name: "mine" }),
      () => removeTag(store(), agent, "infra"),
      () => setSessionGroup(store(), agent, builder.target, { group: work.id }),
      () => setSessionTags(store(), agent, builder.target, { tags: ["mine"] }),
      () => setAgentTags(store(), agent, "builder", { tags: ["mine"] }),
    ]) {
      expect(failure(fn).code).toBe("not_found");
    }
    expect(listed()).toEqual({
      groups: [{ id: work.id, name: "Work", sessions: 0 }],
      tags: [{ name: "infra", agents: 1, sessions: 0 }],
      truncated: false,
    });
  });

  it("lists its threads without the operator's group, which the operator's list shows", () => {
    const work = create("Work");
    group(builder, work.id);
    fixture.createThread(builder);
    const own = listSessionThreads(
      store(),
      builder.identity,
      builder.target,
      sessionThreadsQuery.parse({}),
    );
    expect(own.threads).toHaveLength(1);
    expect(own.threads[0]).not.toHaveProperty("group");
    const operators = listThreads(store(), operator(), threadsQuery.parse({}));
    expect(operators.threads[0]?.group).toEqual({ id: work.id, name: "Work" });
  });
});
