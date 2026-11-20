import {
  agentsQuery,
  type ApproveInput,
  maxListed,
  type PublicKey,
  publicKey,
  registrationsQuery,
  threadGetQuery,
} from "@wayfarerlabs/agention-api";
import { registrationCode } from "@wayfarerlabs/agention-api/registration-code";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.ts";
import { identityForRegistration } from "../identity.ts";
import {
  approveRegistration,
  findRegistrationByKey,
  listAgents,
  listRegistrations,
  registrationLifetime,
  rejectRegistration,
  revokeRegistration,
  submitRegistration,
} from "./registrations.ts";
import { Fixture, hour, newPublicKey, start, threadTarget } from "./test-fixture.ts";
import { getThread } from "./threads.ts";

let fixture: Fixture;

beforeEach(() => {
  fixture = new Fixture();
});

afterEach(() => {
  fixture.close();
});

function submit(publicKey = newPublicKey(), agent = "builder", session = "main") {
  const state = submitRegistration(fixture.store, publicKey, { agent, session });
  const id = findRegistrationByKey(fixture.db, publicKey)?.id ?? 0;
  return { publicKey, state, id };
}

function approval(agent: [string, boolean], session: [string, boolean]): ApproveInput {
  return {
    agent: { name: agent[0], existing: agent[1] },
    session: { name: session[0], existing: session[1] },
  };
}

function failure(fn: () => unknown): [string, string | undefined] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) {
      return [error.code, error.field];
    }
    throw error;
  }
  throw new Error("expected the operation to fail");
}

function count(): number {
  return (fixture.db.prepare("SELECT count(*) AS n FROM registrations").get() as { n: number }).n;
}

describe("submitRegistration", () => {
  it("records a new key as pending, with the code the bridge derives and an hour to live", () => {
    const { publicKey, state } = submit();
    expect(state).toEqual({
      status: "pending",
      code: registrationCode(publicKey),
      expires_at: new Date(start + registrationLifetime).toISOString(),
    });
    expect(registrationLifetime).toBe(hour);
  });

  it("creates nothing for a known key and reports its state", () => {
    const { publicKey, state } = submit();
    expect(submit(publicKey, "other", "names").state).toEqual(state);
    expect(count()).toBe(1);
  });

  it("expires a pending registration after an hour", () => {
    const { publicKey, id } = submit();
    fixture.advance(hour - 1);
    expect(submit(publicKey).state.status).toBe("pending");
    fixture.advance(1);
    expect(submit(publicKey).state.status).toBe("expired");
    expect(
      failure(() =>
        approveRegistration(
          fixture.store,
          fixture.operator,
          id,
          approval(["a", false], ["s", false]),
        ),
      ),
    ).toEqual(["invalid_input", undefined]);
    expect(failure(() => rejectRegistration(fixture.store, fixture.operator, id))).toEqual([
      "invalid_input",
      undefined,
    ]);
  });
});

describe("expired pending registrations", () => {
  it("are deleted when the table is next written, and decided ones are kept", () => {
    const decided = submit(newPublicKey(), "decided", "main");
    rejectRegistration(fixture.store, fixture.operator, decided.id);
    const expired = submit(newPublicKey(), "expired", "main");
    fixture.advance(hour);
    // Reporting a known key's state writes nothing.
    expect(submit(expired.publicKey).state.status).toBe("expired");
    expect(count()).toBe(2);
    const fresh = submit(newPublicKey(), "fresh", "main");
    expect(findRegistrationByKey(fixture.db, expired.publicKey)).toBeUndefined();
    // A deleted registration's id is never given to another.
    expect(fresh.id).toBeGreaterThan(expired.id);
    expect(findRegistrationByKey(fixture.db, decided.publicKey)?.status).toBe("rejected");

    const another = submit(newPublicKey(), "another", "main");
    fixture.advance(hour);
    const pending = submit(newPublicKey(), "pending", "main");
    rejectRegistration(fixture.store, fixture.operator, pending.id);
    expect(findRegistrationByKey(fixture.db, another.publicKey)).toBeUndefined();
  });
});

describe("approveRegistration", () => {
  it("grants a new agent and session, under other names than proposed", () => {
    const { publicKey, id } = submit(newPublicKey(), "proposed", "names");
    const { registration } = approveRegistration(
      fixture.store,
      fixture.operator,
      id,
      approval(["granted", false], ["session", false]),
    );
    expect(registration).toMatchObject({
      status: "approved",
      proposed_agent: "proposed",
      proposed_session: "names",
      granted: { agent: "granted", session: "session", credential_active: true },
      decided_at: new Date(start).toISOString(),
    });
    expect(submit(publicKey).state).toMatchObject({
      status: "approved",
      agent: "granted",
      session: "session",
    });
  });

  it("adds a session to an existing agent", () => {
    fixture.registerAgent("builder", "main");
    const { id } = submit(newPublicKey(), "builder", "side");
    approveRegistration(
      fixture.store,
      fixture.operator,
      id,
      approval(["builder", true], ["side", false]),
    );
    expect(identityForRegistration(fixture.db, id)).toBeDefined();
  });

  it("grants an existing session with its whole history to a further credential", () => {
    const first = fixture.registerAgent("builder", "main");
    fixture.createThread(first, { title: "Earlier work" });
    const { id } = submit();
    approveRegistration(
      fixture.store,
      fixture.operator,
      id,
      approval(["builder", true], ["main", true]),
    );
    const second = identityForRegistration(fixture.db, id);
    if (second === undefined) {
      throw new Error("no identity");
    }
    expect(second.actor).toBe(first.identity.actor);
    const { thread } = getThread(
      fixture.store,
      second,
      threadTarget(first, 1),
      threadGetQuery.parse({}),
    );
    expect(thread.title).toBe("Earlier work");
  });

  it.each([
    ["a new agent that exists", ["builder", false], ["other", false], "agent.name"],
    ["an existing agent that does not", ["nobody", true], ["main", false], "agent.name"],
    ["a new session that exists", ["builder", true], ["main", false], "session.name"],
    ["an existing session that does not", ["builder", true], ["other", true], "session.name"],
    ["an existing session of a new agent", ["fresh", false], ["main", true], "session.name"],
  ] as const)("refuses %s", (_, agent, session, field) => {
    fixture.registerAgent("builder", "main");
    const { id } = submit();
    expect(
      failure(() =>
        approveRegistration(
          fixture.store,
          fixture.operator,
          id,
          approval([...agent], [...session]),
        ),
      ),
    ).toEqual(["invalid_input", field]);
    expect(submit(findKey(id)).state.status).toBe("pending");
    expect((fixture.db.prepare("SELECT count(*) AS n FROM agents").get() as { n: number }).n).toBe(
      1,
    );
  });

  it("refuses a registration already decided", () => {
    const agent = fixture.registerAgent("builder", "main");
    expect(
      failure(() =>
        approveRegistration(
          fixture.store,
          fixture.operator,
          agent.registrationId,
          approval(["x", false], ["y", false]),
        ),
      ),
    ).toEqual(["invalid_input", undefined]);
  });

  it("answers not_found for an unknown registration", () => {
    expect(
      failure(() =>
        approveRegistration(
          fixture.store,
          fixture.operator,
          999,
          approval(["x", false], ["y", false]),
        ),
      ),
    ).toEqual(["not_found", undefined]);
  });
});

function findKey(id: number): PublicKey {
  const row = fixture.db.prepare("SELECT public_key FROM registrations WHERE id = ?").get(id);
  return publicKey.parse(row?.public_key);
}

describe("rejectRegistration", () => {
  it("rejects a pending registration for good", () => {
    const { publicKey, id } = submit();
    expect(rejectRegistration(fixture.store, fixture.operator, id).registration.status).toBe(
      "rejected",
    );
    expect(submit(publicKey).state.status).toBe("rejected");
    expect(
      failure(() =>
        approveRegistration(
          fixture.store,
          fixture.operator,
          id,
          approval(["a", false], ["s", false]),
        ),
      ),
    ).toEqual(["invalid_input", undefined]);
    expect(identityForRegistration(fixture.db, id)).toBeUndefined();
  });
});

describe("revokeRegistration", () => {
  it("ends the credential and keeps the session, its threads and its other credentials", () => {
    const first = fixture.registerAgent("builder", "main");
    const second = fixture.registerAgent("builder", "main");
    fixture.createThread(first, { title: "Kept" });
    fixture.advance(hour);
    const { registration } = revokeRegistration(
      fixture.store,
      fixture.operator,
      first.registrationId,
    );
    expect(registration).toMatchObject({
      status: "revoked",
      decided_at: new Date(start).toISOString(),
      revoked_at: new Date(start + hour).toISOString(),
      granted: { agent: "builder", session: "main", credential_active: true },
    });
    expect(submit(first.publicKey).state.status).toBe("revoked");
    expect(fixture.thread(second.identity, threadTarget(first, 1)).thread.title).toBe("Kept");
    revokeRegistration(fixture.store, fixture.operator, second.registrationId);
    expect(fixture.thread(fixture.operator, threadTarget(first, 1)).thread).toMatchObject({
      title: "Kept",
      credential_active: false,
    });
    fixture.write(fixture.operator, threadTarget(first, 1), { text: "Still answerable." });
  });

  it("refuses a registration that is not approved", () => {
    const { id } = submit();
    expect(failure(() => revokeRegistration(fixture.store, fixture.operator, id))).toEqual([
      "invalid_input",
      undefined,
    ]);
  });

  it("wakes the session's waiters", async () => {
    const agent = fixture.registerAgent("builder", "main");
    const woken = fixture.store.notifier.wait(agent.sessionId, 5000);
    revokeRegistration(fixture.store, fixture.operator, agent.registrationId);
    expect(await woken).toBe("notified");
  });
});

describe("listRegistrations", () => {
  it("pages newest first and filters by the status shown", () => {
    const approved = fixture.registerAgent("builder", "main");
    const expired = submit();
    fixture.advance(hour - 1);
    const pending = submit();
    const rejected = submit();
    rejectRegistration(fixture.store, fixture.operator, rejected.id);
    // Expired, and not yet deleted, since nothing has written the table since.
    fixture.advance(1);
    const list = (query: Record<string, string>) =>
      listRegistrations(fixture.store, fixture.operator, registrationsQuery.parse(query));
    const statuses = (query: Record<string, string>) =>
      list(query).registrations.map((registration) => [registration.id, registration.status]);
    expect(statuses({})).toEqual([
      [rejected.id, "rejected"],
      [pending.id, "pending"],
      [expired.id, "expired"],
      [approved.registrationId, "approved"],
    ]);
    expect(statuses({ status: "expired" })).toEqual([[expired.id, "expired"]]);
    expect(statuses({ status: "pending" })).toEqual([[pending.id, "pending"]]);
    const first = list({ limit: "3" });
    expect(first.registrations).toHaveLength(3);
    const second = list({ limit: "3", cursor: first.next ?? "" });
    expect(second.registrations.map((registration) => registration.id)).toEqual([
      approved.registrationId,
    ]);
    expect(second.next).toBeUndefined();
    expect(list({}).registrations[1]?.code).toBe(registrationCode(pending.publicKey));
  });
});

describe("listAgents", () => {
  it("pages agents by name, each with its sessions by name, marking those without a credential", () => {
    fixture.registerAgent("zeta", "one");
    const revoked = fixture.registerAgent("alpha", "two");
    fixture.registerAgent("alpha", "one");
    fixture.registerAgent("mu", "one");
    revokeRegistration(fixture.store, fixture.operator, revoked.registrationId);
    const first = listAgents(fixture.store, fixture.operator, agentsQuery.parse({ limit: "2" }));
    expect(first.agents).toEqual([
      {
        agent: "alpha",
        sessions: [
          { session: "one", credential_active: true },
          { session: "two", credential_active: false },
        ],
        truncated: false,
      },
      { agent: "mu", sessions: [{ session: "one", credential_active: true }], truncated: false },
    ]);
    const second = listAgents(
      fixture.store,
      fixture.operator,
      agentsQuery.parse({ limit: "2", cursor: first.next }),
    );
    expect(second).toEqual({
      agents: [
        {
          agent: "zeta",
          sessions: [{ session: "one", credential_active: true }],
          truncated: false,
        },
      ],
    });
  });

  // Registering past the bound through the real paths takes seconds.
  it(
    `lists at most ${maxListed} sessions of an agent, saying when it leaves any out`,
    { timeout: 30_000 },
    () => {
      for (let index = 0; index <= maxListed; index++) {
        fixture.registerAgent("builder", `session-${String(index).padStart(3, "0")}`);
      }
      const [builder] = listAgents(fixture.store, fixture.operator, agentsQuery.parse({})).agents;
      expect(builder?.sessions.length).toBe(maxListed);
      expect(builder?.sessions[0]?.session).toBe("session-000");
      expect(builder?.truncated).toBe(true);
    },
  );
});
