import {
  type ApproveInput,
  approveInput,
  colors,
  groupCreateInput,
  sessionsQuery,
  tagCreateInput,
  threadFilters,
} from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.ts";
import type { Identity } from "../identity.ts";
import {
  createGroup,
  createTag,
  listGroupsAndTags,
  orderGroups,
  recolorGroup,
  recolorTag,
  removeGroup,
  removeTag,
  renameTag,
  setAgentTags,
  setSessionGroup,
  setSessionTags,
} from "./groups-and-tags.ts";
import { approveRegistration, findRegistrationByKey, submitRegistration } from "./registrations.ts";
import { listSessions } from "./sessions.ts";
import { type Agent, Fixture, newPublicKey } from "./test-fixture.ts";
import { countThreads } from "./thread-lists.ts";

// The colors of groups and tags, the operator's order of groups, tags as rows
// of their own, and a session's group and tags given on its approval.

let fixture: Fixture;
let builder: Agent;

beforeEach(() => {
  fixture = new Fixture();
  builder = fixture.registerAgent("builder", "main");
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
const create = (name: string, color?: string) =>
  createGroup(store(), operator(), groupCreateInput.parse({ name, color }));
const listed = () => listGroupsAndTags(store(), operator());
const groupNames = () => listed().groups.map((group) => group.name);
const order = (groups: number[]) => orderGroups(store(), operator(), { groups });

describe("colors", () => {
  it("are given, or the palette's in turn by the order groups are made", () => {
    expect(create("Work", "teal")).toMatchObject({ name: "Work", color: "teal" });
    const made = Array.from({ length: colors.length }, (_, index) => create(`Group ${index}`));
    // The first group took the first color in turn, though it was given its
    // own, so the second takes the second.
    expect(made.map((group) => group.color)).toEqual([...colors.slice(1), colors[0]]);
  });

  it("are the palette's in turn for a tag too, however it is made", () => {
    expect(createTag(store(), operator(), tagCreateInput.parse({ name: "infra" }))).toEqual({
      name: "infra",
      color: "gray",
    });
    setSessionTags(store(), operator(), builder.target, { tags: ["urgent"] });
    setAgentTags(store(), operator(), "builder", { tags: ["billing"] });
    expect(createTag(store(), operator(), { name: "ops", color: "purple" }).color).toBe("purple");
    expect(listed().tags.map((tag) => [tag.name, tag.color])).toEqual([
      ["billing", "orange"],
      ["infra", "gray"],
      ["ops", "purple"],
      ["urgent", "red"],
    ]);
  });

  it("change, for a group or a tag that exists", () => {
    const work = create("Work");
    expect(recolorGroup(store(), operator(), work.id, { color: "green" })).toEqual({
      id: work.id,
      name: "Work",
      color: "green",
    });
    createTag(store(), operator(), { name: "infra" });
    expect(recolorTag(store(), operator(), "infra", { color: "yellow" })).toEqual({
      name: "infra",
      color: "yellow",
    });
    expect(listed()).toMatchObject({
      groups: [{ name: "Work", color: "green" }],
      tags: [{ name: "infra", color: "yellow" }],
    });
    expect(failure(() => recolorGroup(store(), operator(), 9, { color: "red" }))).toEqual({
      code: "not_found",
      field: "id",
    });
    expect(failure(() => recolorTag(store(), operator(), "nope", { color: "red" }))).toEqual({
      code: "not_found",
      field: "tag",
    });
  });

  it("are held to the palette by the database too", () => {
    createTag(store(), operator(), { name: "infra" });
    expect(() => fixture.db.prepare("UPDATE tags SET color = 'pink'").run()).toThrow();
    create("Work");
    expect(() => fixture.db.prepare("UPDATE session_groups SET color = 'pink'").run()).toThrow();
  });
});

describe("the order of groups", () => {
  it("puts a new group last, and takes a whole order", () => {
    const [work, play, home] = ["Work", "Play", "Home"].map((name) => create(name));
    expect(groupNames()).toEqual(["Work", "Play", "Home"]);
    order([home?.id ?? 0, work?.id ?? 0, play?.id ?? 0]);
    expect(groupNames()).toEqual(["Home", "Work", "Play"]);
    create("Later");
    expect(groupNames()).toEqual(["Home", "Work", "Play", "Later"]);
    // The order outlives a group's removal, and takes the rest again.
    removeGroup(store(), operator(), work?.id ?? 0);
    expect(groupNames()).toEqual(["Home", "Play", "Later"]);
    order(
      listed()
        .groups.map((group) => group.id)
        .reverse(),
    );
    expect(groupNames()).toEqual(["Later", "Play", "Home"]);
  });

  it("refuses a list that is not every group, each once, changing nothing", () => {
    const ids = ["Work", "Play", "Home"].map((name) => create(name).id);
    const [work = 0, play = 0, home = 0] = ids;
    for (const groups of [[work, play], [work, play, home, 99], [work, play, 99], []]) {
      expect(failure(() => order(groups))).toEqual({ code: "invalid_input", field: "groups" });
    }
    expect(groupNames()).toEqual(["Work", "Play", "Home"]);
  });

  it("lets the later of two whole orders stand, and refuses one read before a group was made", () => {
    const ids = ["Work", "Play", "Home"].map((name) => create(name).id);
    // Two clients read the same groups and each sends its own order.
    order([...ids].reverse());
    order([ids[1] ?? 0, ids[0] ?? 0, ids[2] ?? 0]);
    expect(groupNames()).toEqual(["Play", "Work", "Home"]);
    // A client that read the groups before another made one is refused.
    create("Later");
    expect(failure(() => order(ids)).field).toBe("groups");
    expect(groupNames()).toEqual(["Play", "Work", "Home", "Later"]);
  });

  it("is the order the thread list's counts give its groups in", () => {
    const side = fixture.registerAgent("builder", "side");
    const work = create("Work");
    const play = create("Play");
    setSessionGroup(store(), operator(), builder.target, { group: work.id });
    setSessionGroup(store(), operator(), side.target, { group: play.id });
    fixture.createThread(builder);
    fixture.createThread(side);
    const counted = () =>
      countThreads(store(), operator(), threadFilters.parse({})).session_group.groups.map(
        (group) => group.name,
      );
    expect(counted()).toEqual(["Work", "Play"]);
    order([play.id, work.id]);
    expect(counted()).toEqual(["Play", "Work"]);
  });
});

describe("tags", () => {
  it("are made directly, nothing carrying them, and refuse a name in use", () => {
    createTag(store(), operator(), { name: "infra" });
    expect(listed().tags).toEqual([{ name: "infra", color: "gray", agents: 0, sessions: 0 }]);
    expect(failure(() => createTag(store(), operator(), { name: "infra" }))).toEqual({
      code: "conflict",
      field: "name",
    });
    // A tag nothing carries is renamed and removed as any other.
    renameTag(store(), operator(), "infra", { name: "platform" });
    removeTag(store(), operator(), "platform");
    expect(listed().tags).toEqual([]);
  });

  it("are taken off every agent and session when removed, and rename everywhere", () => {
    const side = fixture.registerAgent("builder", "side");
    setAgentTags(store(), operator(), "builder", { tags: ["infra", "ops"] });
    setSessionTags(store(), operator(), builder.target, { tags: ["infra"] });
    setSessionTags(store(), operator(), side.target, { tags: ["infra", "urgent"] });
    renameTag(store(), operator(), "ops", { name: "platform" });
    removeTag(store(), operator(), "infra");
    const page = listSessions(store(), operator(), sessionsQuery.parse({}));
    expect(page.agents[0]).toMatchObject({
      tags: ["platform"],
      sessions: [
        { session: "main", tags: [] },
        { session: "side", tags: ["urgent"] },
      ],
    });
    expect(
      fixture.db.prepare("SELECT name FROM session_tags UNION SELECT name FROM agent_tags").all(),
    ).toEqual([{ name: "platform" }, { name: "urgent" }]);
  });
});

describe("approval with a group and tags", () => {
  // pending submits a registration for builder/second, answering its id.
  function pending(session = "second"): number {
    const key = newPublicKey();
    submitRegistration(store(), key, { agent: "builder", session });
    return findRegistrationByKey(fixture.db, key)?.id ?? 0;
  }

  const approve = (id: number, fields: Record<string, unknown>, identity: Identity = operator()) =>
    approveRegistration(
      store(),
      identity,
      id,
      approveInput.parse({
        agent: { name: "builder", existing: true },
        session: { name: "second", existing: false, ...fields },
      }) satisfies ApproveInput,
    );

  // The session builder/second as the sessions view shows it, if it exists.
  const second = () =>
    listSessions(store(), operator(), sessionsQuery.parse({})).agents[0]?.sessions.find(
      (each) => each.session === "second",
    );

  // What approving could have written, to show a refusal wrote none of it.
  const written = () =>
    fixture.db
      .prepare(
        `SELECT (SELECT count(*) FROM sessions) AS sessions, (SELECT count(*) FROM tags) AS tags,
           (SELECT count(*) FROM registrations WHERE status = 'pending') AS pending`,
      )
      .get();

  it("puts the new session in its group with its tags as it is granted", () => {
    const work = create("Work");
    createTag(store(), operator(), { name: "infra" });
    approve(pending(), { group: work.id, tags: ["infra", "billing"] });
    expect(second()).toMatchObject({
      group: { id: work.id, name: "Work" },
      tags: ["billing", "infra"],
    });
    // A tag it names that does not exist is made, with its color in turn.
    expect(listed().tags).toMatchObject([
      { name: "billing", color: "red", sessions: 1 },
      { name: "infra", color: "gray", sessions: 1 },
    ]);
  });

  it("leaves what it is not given, and onto an existing session sets what it is", () => {
    approve(pending(), {});
    expect(second()?.group).toBeUndefined();
    const work = create("Work");
    setSessionGroup(
      store(),
      operator(),
      { agent: "builder", session: "second" },
      {
        group: work.id,
      },
    );
    approveRegistration(
      store(),
      operator(),
      pending(),
      approveInput.parse({
        agent: { name: "builder", existing: true },
        session: { name: "second", existing: true, group: null, tags: ["ops"] },
      }),
    );
    expect(second()).toMatchObject({ tags: ["ops"] });
    expect(second()?.group).toBeUndefined();
  });

  it("applies nothing when it is refused", () => {
    const id = pending();
    const before = written();
    expect(failure(() => approve(id, { group: 99, tags: ["infra"] }))).toEqual({
      code: "not_found",
      field: "session.group",
    });
    expect(written()).toEqual(before);
    expect(second()).toBeUndefined();
  });
});
