import { holdsScope, type Scope, scopes } from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.ts";
import type { Identity } from "../identity.ts";
import { createGroup, setSessionTags, submitRegistration } from "../store/index.ts";
import { type Agent, Fixture, newPublicKey } from "../store/test-fixture.ts";
import { agentOperations, registration } from "./agent-operations.ts";
import { parse } from "./input.ts";
import type { Operation } from "./operations.ts";
import { operatorOperations } from "./operator-operations.ts";

let fixture: Fixture;
let agent: Agent;

beforeEach(() => {
  fixture = new Fixture();
  agent = fixture.registerAgent("builder", "main");
  fixture.createThread(agent);
});

afterEach(() => {
  fixture.close();
});

// The rows written on the database's connection so far.
const changes = () =>
  (fixture.db.prepare("SELECT total_changes() AS changes").get() as { changes: number }).changes;

// A value for each path parameter the operations take, naming what the
// fixture holds.
const pathValues: Record<string, string> = {
  agent: "builder",
  session: "main",
  thread: "1",
  id: "1",
  tag: "infra",
};

const reads = operatorOperations.filter((each) => each.scope.endsWith(":read"));

describe("an operation a read scope grants", () => {
  it.each(reads.map((each) => [each.name, each] as const))(
    "%s is a GET whose store work writes nothing",
    async (_, operation) => {
      expect(operation.method).toBe("GET");
      expect(operation.body).toBeUndefined();
      const before = changes();
      await operation.handler({
        store: fixture.store,
        identity: fixture.operator,
        params: operation.params === undefined ? undefined : parse(operation.params, pathValues),
        query: operation.query === undefined ? undefined : parse(operation.query, {}),
        body: undefined,
        signal: new AbortController().signal,
      });
      expect(changes()).toBe(before);
    },
  );
});

describe("the declarations", () => {
  it.each([
    ["operator", operatorOperations],
    ["agent", [registration, ...agentOperations]],
  ] as const)("name each %s operation once, and each method and path once", (_, list) => {
    const names = list.map((each) => each.name);
    const routes = list.map((each) => `${each.method} ${each.path}`);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(routes).size).toBe(routes.length);
  });

  it("declare each path parameter in the path's schema", () => {
    for (const each of [...operatorOperations, ...agentOperations]) {
      const inPath = [...each.path.matchAll(/:([a-z]+)/g)].map((match) => match[1]);
      const declared =
        each.params === undefined ? [] : Object.keys(parse(each.params, pathValues) as object);
      expect([each.name, declared.sort()]).toEqual([each.name, inPath.sort()]);
    }
  });
});

// A valid body for each operation taking one, against what the fixture holds.
const bodies: Record<string, unknown> = {
  updateSession: { state: "working" },
  createThread: { request_id: "a-1", title: "t" },
  startThread: { request_id: "o-1", title: "t", text: "m" },
  sendMessage: { request_id: "m-1", seen_through: 1, text: "m" },
  markRead: { through: 1 },
  markUnread: { from: 1 },
  archiveThread: { through: 1 },
  bulkRead: { threads: [{ agent: "builder", session: "main", thread: 1, through: 1 }] },
  bulkArchive: { threads: [{ agent: "builder", session: "main", thread: 1, through: 1 }] },
  markSessionLogRead: { through: 0 },
  createGroup: { name: "Home" },
  renameGroup: { name: "Play" },
  renameTag: { name: "ops" },
  setSessionGroup: { group: 1 },
  setSessionTags: { tags: [] },
  setAgentTags: { tags: [] },
  approveRegistration: {
    agent: { name: "builder", existing: true },
    session: { name: "second", existing: false },
  },
};

// The fixture's pending registration, which approving and rejecting decide.
const pendingRegistration: Record<string, string> = {
  approveRegistration: "2",
  rejectRegistration: "2",
};

// run calls the operation's handler, and so its store work, as identity.
async function run(operation: Operation, identity: Identity): Promise<string> {
  const path = { ...pathValues, id: pendingRegistration[operation.name] ?? pathValues.id };
  try {
    await operation.handler({
      store: fixture.store,
      identity,
      params: operation.params === undefined ? undefined : parse(operation.params, path),
      query: operation.query === undefined ? undefined : parse(operation.query, {}),
      body:
        operation.body === undefined ? undefined : parse(operation.body, bodies[operation.name]),
      signal: new AbortController().signal,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return error.code;
    }
    throw error;
  }
  return "ok";
}

// holding gives identity exactly the scopes chosen, over what it reaches.
const holding = (identity: Identity, chosen: readonly Scope[]): Identity => ({
  ...identity,
  grants: { ...identity.grants, scopes: chosen },
});

// The store, not only the mount, refuses an identity without an operation's
// scope, so every adapter over the store is held to it. Each operation runs
// first with every scope but those granting its own, which is refused and
// writes nothing, then with its scope alone, which succeeds, so the refusal
// is the scope's and not the input's.
describe("the store work of an operation", () => {
  beforeEach(() => {
    createGroup(fixture.store, fixture.operator, { name: "Work" });
    setSessionTags(fixture.store, fixture.operator, agent.target, { tags: ["infra"] });
    submitRegistration(fixture.store, newPublicKey(), { agent: "builder", session: "second" });
  });

  it.each([
    ...operatorOperations.map((each) => ["operator", each.name, each] as const),
    ...agentOperations.map((each) => ["agent", each.name, each] as const),
  ])("on the %s mount, %s, refuses an identity without its scope", async (mount, _, operation) => {
    const { scope } = operation;
    const identity = mount === "operator" ? fixture.operator : agent.identity;
    const before = changes();
    const lacking = scopes.filter((each) => !holdsScope([each], scope));
    expect(await run(operation, holding(identity, lacking))).toBe("not_found");
    expect(changes()).toBe(before);
    expect(await run(operation, holding(identity, [scope]))).toBe("ok");
  });
});
