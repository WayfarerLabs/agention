import {
  messageSendInput,
  registrationsQuery,
  sessionsQuery,
  sessionThreadsQuery,
  threadCreateInput,
  threadGetQuery,
  threadsQuery,
  waitQuery,
} from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.ts";
import { type Identity, identityForBrowserSession, identityForRegistration } from "../identity.ts";
import { archiveThread, bulkArchive, bulkRead, markRead, markUnread } from "./marks.ts";
import {
  approveRegistration,
  listRegistrations,
  rejectRegistration,
  revokeRegistration,
  submitRegistration,
} from "./registrations.ts";
import { listSessions } from "./sessions.ts";
import {
  type Agent,
  Fixture,
  hour,
  newPublicKey,
  requestId,
  threadTarget,
} from "./test-fixture.ts";
import { listSessionThreads, listThreads } from "./thread-lists.ts";
import { createThread, getThread, sendMessage } from "./threads.ts";
import { pollThreads, waitForThreads } from "./wait.ts";

let fixture: Fixture;
let mine: Agent;
let theirs: Agent;

beforeEach(() => {
  fixture = new Fixture();
  mine = fixture.registerAgent("builder", "main");
  theirs = fixture.registerAgent("reviewer", "main");
  fixture.createThread(mine);
  fixture.createThread(theirs);
});

afterEach(() => {
  fixture.close();
});

async function codeOf(fn: () => unknown): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return error.code;
    }
    throw error;
  }
  return "ok";
}

// Every operation on a session or thread, run by identity against target.
function sessionOperations(identity: Identity, target: { agent: string; session: string }) {
  const thread = { ...target, thread: 1 };
  const marked = [{ ...target, thread: 1, through: 1 }];
  return {
    createThread: () =>
      createThread(
        fixture.store,
        identity,
        target,
        threadCreateInput.parse({ request_id: requestId(), title: "t" }),
      ),
    sendMessage: () =>
      sendMessage(
        fixture.store,
        identity,
        thread,
        messageSendInput.parse({ request_id: requestId(), seen_through: 1, text: "m" }),
      ),
    markRead: () => markRead(fixture.store, identity, thread, { through: 1 }),
    markUnread: () => markUnread(fixture.store, identity, thread, { from: 1 }),
    archiveThread: () => archiveThread(fixture.store, identity, thread, { through: 1 }),
    getThread: () => getThread(fixture.store, identity, thread, threadGetQuery.parse({})),
    listSessionThreads: () =>
      listSessionThreads(fixture.store, identity, target, sessionThreadsQuery.parse({})),
    pollThreads: () => pollThreads(fixture.store, identity, target, 0, 50),
    waitForThreads: () =>
      waitForThreads(fixture.store, identity, target, waitQuery.parse({ wait: "0" })),
    bulkRead: () => bulkRead(fixture.store, identity, { threads: marked }),
    bulkArchive: () => bulkArchive(fixture.store, identity, { threads: marked }),
  };
}

function administrationOperations(identity: Identity) {
  const pending = () => {
    const publicKey = newPublicKey();
    submitRegistration(fixture.store, publicKey, { agent: "new", session: "one" });
    return (
      fixture.db.prepare("SELECT id FROM registrations WHERE public_key = ?").get(publicKey) as {
        id: number;
      }
    ).id;
  };
  return {
    listRegistrations: () =>
      listRegistrations(fixture.store, identity, registrationsQuery.parse({})),
    approveRegistration: () =>
      approveRegistration(fixture.store, identity, pending(), {
        agent: { name: "new", existing: false },
        session: { name: "one", existing: false },
      }),
    rejectRegistration: () => rejectRegistration(fixture.store, identity, pending()),
    revokeRegistration: () => revokeRegistration(fixture.store, identity, theirs.registrationId),
    listSessions: () => listSessions(fixture.store, identity, sessionsQuery.parse({})),
  };
}

describe("a foreign session", () => {
  it.each(Object.keys(sessionOperations({} as Identity, { agent: "", session: "" })))(
    "is not_found to %s",
    async (name) => {
      const operation = sessionOperations(mine.identity, theirs.target)[name as "getThread"];
      expect(await codeOf(operation)).toBe("not_found");
    },
  );

  it.each(Object.keys(sessionOperations({} as Identity, { agent: "", session: "" })))(
    "is indistinguishable from a missing one to %s",
    async (name) => {
      const missing = sessionOperations(mine.identity, { agent: "nobody", session: "main" });
      expect(await codeOf(missing[name as "getThread"])).toBe("not_found");
    },
  );

  it("is absent from the thread list of an identity that does not reach it", () => {
    // A message mine has not read, on a thread mine cannot reach.
    fixture.write(fixture.operator, threadTarget(theirs, 1), { text: "for them" });
    const all = threadsQuery.parse({ include_archived: "true" });
    expect(listThreads(fixture.store, mine.identity, all).threads).toEqual([
      expect.objectContaining({ agent: "builder" }),
    ]);
    expect(listThreads(fixture.store, mine.identity, all).total).toBe(1);
    const sessions = listThreads(fixture.store, fixture.operator, all).threads.map(
      (thread) => thread.agent,
    );
    expect(sessions.sort()).toEqual(["builder", "reviewer"]);
  });

  it("is never found by another identity's search, nor counted for it", () => {
    for (const agent of [mine, theirs]) {
      fixture.createThread(agent, { title: "Release notes", asks: [{ question: "Ship?" }] });
    }
    const search = { search: "release" };
    const own = listSessionThreads(
      fixture.store,
      mine.identity,
      mine.target,
      sessionThreadsQuery.parse(search),
    );
    expect(own.threads.map((thread) => thread.agent)).toEqual(["builder"]);
    const reached = listThreads(fixture.store, mine.identity, threadsQuery.parse(search));
    expect(reached.threads.map((thread) => thread.agent)).toEqual(["builder"]);
    expect(reached.total).toBe(1);
    expect(listThreads(fixture.store, fixture.operator, threadsQuery.parse(search)).total).toBe(2);
  });
});

describe("administration", () => {
  it.each(Object.keys(administrationOperations({} as Identity)))(
    "is not_found to an agent for %s",
    async (name) => {
      const operation = administrationOperations(mine.identity)[name as "listSessions"];
      expect(await codeOf(operation)).toBe("not_found");
    },
  );

  it.each(Object.keys(administrationOperations({} as Identity)))(
    "is available to the operator for %s",
    async (name) => {
      const operation = administrationOperations(fixture.operator)[name as "listSessions"];
      expect(await codeOf(operation)).toBe("ok");
    },
  );
});

describe("a credential revoked after authentication", () => {
  it.each(Object.keys(sessionOperations({} as Identity, { agent: "", session: "" })))(
    "fails %s as unauthenticated, even on its own session",
    async (name) => {
      revokeRegistration(fixture.store, fixture.operator, mine.registrationId);
      const operation = sessionOperations(mine.identity, mine.target)[name as "getThread"];
      expect(await codeOf(operation)).toBe("unauthenticated");
    },
  );

  it("fails the thread list as unauthenticated", async () => {
    revokeRegistration(fixture.store, fixture.operator, mine.registrationId);
    expect(
      await codeOf(() => listThreads(fixture.store, mine.identity, threadsQuery.parse({}))),
    ).toBe("unauthenticated");
  });

  it("is an identity no more once its registration is gone from approval", () => {
    const publicKey = newPublicKey();
    submitRegistration(fixture.store, publicKey, { agent: "builder", session: "main" });
    const { id } = fixture.db
      .prepare("SELECT id FROM registrations WHERE public_key = ?")
      .get(publicKey) as { id: number };
    expect(identityForRegistration(fixture.db, id)).toBeUndefined();
    rejectRegistration(fixture.store, fixture.operator, id);
    expect(identityForRegistration(fixture.db, id)).toBeUndefined();
  });
});

describe("an expired browser session", () => {
  function setExpiry(column: "idle_expires_at" | "absolute_expires_at", at: number) {
    fixture.db
      .prepare(`UPDATE browser_sessions SET ${column} = ? WHERE hash = ?`)
      .run(at, fixture.browserSession);
  }

  it.each(["idle_expires_at", "absolute_expires_at"] as const)(
    "fails every operation as unauthenticated past %s",
    async (column) => {
      setExpiry(column, fixture.now + hour);
      expect(await codeOf(sessionOperations(fixture.operator, mine.target).getThread)).toBe("ok");
      fixture.advance(hour);
      for (const operation of Object.values(sessionOperations(fixture.operator, mine.target))) {
        expect(await codeOf(operation)).toBe("unauthenticated");
      }
      for (const operation of Object.values(administrationOperations(fixture.operator))) {
        expect(await codeOf(operation)).toBe("unauthenticated");
      }
    },
  );

  it("fails as unauthenticated once deleted", async () => {
    fixture.db.prepare("DELETE FROM browser_sessions").run();
    expect(await codeOf(sessionOperations(fixture.operator, mine.target).getThread)).toBe(
      "unauthenticated",
    );
    // A browser is not told to call register, which only agents have.
    const refusal = await Promise.resolve()
      .then(sessionOperations(fixture.operator, mine.target).getThread)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ApiError);
    expect((refusal as ApiError).message).not.toMatch(/\bregister\b/);
    expect(identityForBrowserSession(fixture.db, fixture.browserSession)).toBeUndefined();
  });
});

describe("the actor", () => {
  it("comes from authentication, with the credential recorded for sessions", () => {
    const second = fixture.registerAgent("builder", "main");
    fixture.write(second.identity, threadTarget(mine, 1), { text: "from the second key" });
    fixture.write(fixture.operator, threadTarget(mine, 1), { text: "from the operator" });
    const rows = fixture.db
      .prepare(
        `SELECT m.seq, m.actor_id, m.registration_id FROM messages m
         WHERE m.session_id = ? ORDER BY m.seq`,
      )
      .all(mine.sessionId);
    expect(rows).toEqual([
      { seq: 1, actor_id: mine.identity.actor, registration_id: mine.registrationId },
      { seq: 2, actor_id: mine.identity.actor, registration_id: second.registrationId },
      { seq: 3, actor_id: fixture.operator.actor, registration_id: null },
    ]);
    const { messages } = fixture.thread(fixture.operator, threadTarget(mine, 1));
    expect(messages.map((message) => message.author)).toEqual([
      { kind: "session", agent: "builder", session: "main" },
      { kind: "session", agent: "builder", session: "main" },
      { kind: "person", name: "operator" },
    ]);
  });
});
