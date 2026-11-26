import { threadsQuery } from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.ts";
import { countAttention } from "./attention.ts";
import { archiveThread, markRead } from "./marks.ts";
import {
  approveRegistration,
  findRegistrationByKey,
  rejectRegistration,
  submitRegistration,
} from "./registrations.ts";
import {
  type Agent,
  Fixture,
  hour,
  newPublicKey,
  threadTarget,
  testOrigin,
} from "./test-fixture.ts";
import { listThreads } from "./thread-lists.ts";

let fixture: Fixture;
let agent: Agent;

beforeEach(() => {
  fixture = new Fixture();
  agent = fixture.registerAgent("builder", "main");
});

afterEach(() => {
  fixture.close();
});

const counts = () => countAttention(fixture.store, fixture.operator);

// The total the thread list shows with only Unread on, which the count
// reuses.
const unreadListed = () =>
  listThreads(fixture.store, fixture.operator, threadsQuery.parse({ unread: "true" })).total;

// submit submits a registration for a new key, giving its id.
function submit(session = "side"): number {
  const key = newPublicKey();
  submitRegistration(fixture.store, key, { agent: "builder", session }, testOrigin);
  return findRegistrationByKey(fixture.db, key)?.id ?? 0;
}

describe("the operator's attention counts", () => {
  it("count the unread threads as the thread list does with only Unread on", () => {
    const read = threadTarget(agent, fixture.createThread(agent).number);
    const archived = threadTarget(agent, fixture.createThread(agent).number);
    fixture.createThread(agent);
    const both = () => [counts().unread_threads, unreadListed()];
    expect(both()).toEqual([3, 3]);
    markRead(fixture.store, fixture.operator, read, { through: fixture.lastSeq(read) });
    expect(both()).toEqual([2, 2]);
    archiveThread(fixture.store, fixture.operator, archived, {
      through: fixture.lastSeq(archived),
    });
    expect(both()).toEqual([1, 1]);
  });

  it("count the registrations waiting for approval, not those decided or expired", () => {
    expect(counts().pending_registrations).toBe(0);
    const approved = submit("side");
    const rejected = submit("spare");
    submit("third");
    expect(counts().pending_registrations).toBe(3);
    approveRegistration(fixture.store, fixture.operator, approved, {
      agent: { name: "builder", existing: true },
      session: { name: "side", existing: false },
    });
    rejectRegistration(fixture.store, fixture.operator, rejected);
    expect(counts().pending_registrations).toBe(1);
    fixture.advance(hour);
    expect(counts().pending_registrations).toBe(0);
  });

  it("refuse an agent, to which they do not exist", () => {
    let code: string | undefined;
    try {
      countAttention(fixture.store, agent.identity);
    } catch (error) {
      code = error instanceof ApiError ? error.code : undefined;
    }
    expect(code).toBe("not_found");
  });
});
