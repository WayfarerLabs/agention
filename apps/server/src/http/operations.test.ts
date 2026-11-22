import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Agent, Fixture } from "../store/test-fixture.ts";
import { agentOperations, registration } from "./agent-operations.ts";
import { parse } from "./input.ts";
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
