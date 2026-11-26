import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issuePasskeyLink } from "../auth/passkey-links.ts";
import { defaultRates } from "../http/rates.ts";
import { TestAuthenticator, TestBrowser } from "../http/test-browser.ts";
import { type AgentKey, codeOf, Harness, newAgentKey } from "../http/test-harness.ts";
import { everySession } from "../store/index.ts";
import { hour } from "../store/test-fixture.ts";
import { eventsAfter, lastSeq, type OcsfEvent, parsed, problemsOf } from "./test-events.ts";

// Failures the audit log records: failed sign-ins and links with no actor,
// and refusals of an API key the server found, each in a transaction of its
// own once it has spent its rate budget, coalesced to one event per kind a
// minute, with the caller's answer unchanged.

let harness: Harness;

beforeEach(() => {
  harness = new Harness({ name: "Work" });
});

afterEach(() => {
  harness.close();
});

const failures = (after = 0) =>
  eventsAfter(harness.fixture.db, after).filter((event) => event.outcome === "failure");

const fields = (event: { event: string }) =>
  parsed({ event: event.event } as never) as OcsfEvent & {
    count: number;
    start_time: number;
    end_time: number;
    status_detail?: string;
    api?: { operation: string };
    service?: { name: string; uid: string };
    http_request: { url: { path: string } };
  };

// A sign-in answered by a passkey the server does not know.
async function failSignIn(): Promise<number> {
  const browser = new TestBrowser(harness);
  return (await browser.signIn(new TestAuthenticator())).status;
}

describe("a failed sign-in", () => {
  it("is one event a minute, counting each failure, by no one", async () => {
    expect(await failSignIn()).toBe(401);
    harness.fixture.advance(1000);
    expect(await failSignIn()).toBe(401);
    let [event, ...rest] = failures();
    expect(rest).toEqual([]);
    expect(event).toMatchObject({ action: "signIn", credential_kind: "none", credential_id: null });
    expect(problemsOf(event?.event ?? "")).toEqual([]);
    const counted = fields(event as never);
    expect([counted.count, counted.end_time - counted.start_time]).toEqual([2, 1000]);
    expect(counted.actor).toBeUndefined();
    expect(counted.service).toEqual({ name: "Work", uid: harness.origin });
    expect(counted.http_request.url.path).toBe("/api/web/auth/signin/finish");
    // Once the minute ends, the event is final, and the next failure opens
    // another.
    harness.fixture.advance(60_000);
    expect(await failSignIn()).toBe(401);
    [event, ...rest] = failures();
    expect(fields(event as never).count).toBe(2);
    expect(rest.map((each) => fields(each).count)).toEqual([1]);
  });

  it("is recorded only within its budget", async () => {
    harness.close();
    harness = new Harness({
      rates: { ...defaultRates, failedSignIn: { burst: 2, interval: hour } },
    });
    expect([await failSignIn(), await failSignIn(), await failSignIn()]).toEqual([401, 401, 429]);
    expect(failures().map((each) => fields(each).count)).toEqual([2]);
  });

  it("of a link is recorded at its begin and its finish alike", async () => {
    const browser = new TestBrowser(harness);
    // Issuing a link revokes every unused one.
    const replaced = issuePasskeyLink(harness.fixture.store, "operator");
    issuePasskeyLink(harness.fixture.store, "operator");
    expect(
      (await browser.post("/auth/link/begin", { token: replaced, name: "Phone" })).status,
    ).toBe(401);
    const options = await browser.begin("/auth/link/begin", {
      token: issuePasskeyLink(harness.fixture.store, "operator"),
      name: "Phone",
    });
    // A second link revokes the first, so its finish fails.
    issuePasskeyLink(harness.fixture.store, "operator");
    const finished = await browser.post("/auth/link/finish", {
      credential: new TestAuthenticator().create(options, harness.origin),
    });
    expect(finished.status).toBe(401);
    expect(failures().map((each) => [each.action, fields(each).count])).toEqual([
      ["usePasskeyLink", 2],
    ]);
  });
});

describe("a refused API key", () => {
  it("found revoked or expired is recorded under the key, by code", async () => {
    const { key: revoked, secret: revokedSecret } = await harness.createKey(["threads:read"]);
    const { key: expiring, secret: expiringSecret } = await harness.createKey(["threads:read"], {
      kind: "days",
      days: 7,
    });
    await harness.web("POST", `/keys/${revoked.id}/revoke`);
    harness.fixture.advance(7 * 24 * hour);
    const before = lastSeq(harness.fixture.db);
    for (const secret of [revokedSecret, revokedSecret, expiringSecret]) {
      expect(codeOf(await harness.operator(secret, "GET", "/threads"))).toBe("unauthenticated");
    }
    const recorded = failures(before);
    expect(
      recorded.map((each) => [
        each.action,
        each.credential_id,
        fields(each).status_detail,
        fields(each).count,
      ]),
    ).toEqual([
      ["authenticateApiKey", String(revoked.id), "key_revoked", 2],
      ["authenticateApiKey", String(expiring.id), "key_expired", 1],
    ]);
    for (const each of recorded) {
      expect(problemsOf(each.event)).toEqual([]);
      expect(fields(each).service?.name).toBe("Work");
      expect(fields(each).http_request.url.path).toBe("/api/operator/v1/threads");
    }
  });

  it("unknown or malformed records nothing", async () => {
    const before = lastSeq(harness.fixture.db);
    for (const authorization of ["Bearer agk_unknown", "Bearer", "Basic x"]) {
      const response = await harness.request("GET", "/api/operator/v1/threads", {
        headers: { authorization },
      });
      expect(codeOf(response)).toBe("unauthenticated");
    }
    expect(eventsAfter(harness.fixture.db, before)).toEqual([]);
  });

  it("revoked or expired is recorded only within the failed-key budget", async () => {
    harness.close();
    harness = new Harness({
      rates: { ...defaultRates, failedKeyAuth: { burst: 1, interval: hour } },
    });
    const { key, secret } = await harness.createKey(["threads:read"]);
    await harness.web("POST", `/keys/${key.id}/revoke`);
    expect(codeOf(await harness.operator(secret, "GET", "/threads"))).toBe("unauthenticated");
    expect(codeOf(await harness.operator(secret, "GET", "/threads"))).toBe("rate_limited");
    expect(failures().map((each) => fields(each).count)).toEqual([1]);
  });

  it("for a scope is recorded under the operation refused, by its route, answered as before", async () => {
    const { secret } = await harness.createKey(["threads:read"]);
    const agent = await harness.approvedAgent("builder", "main");
    await harness.agent(agent, "POST", "/s/builder/main/threads", {
      request_id: "r-1",
      title: "A question",
    });
    const before = lastSeq(harness.fixture.db);
    const refused = await harness.operator(secret, "POST", "/s/builder/main/threads/1/messages", {
      request_id: "o-1",
      seen_through: 1,
      text: "m",
    });
    expect(codeOf(refused)).toBe("not_found");
    expect(refused.body).toEqual({ error: { code: "not_found", message: "not found" } });
    const [event, ...rest] = failures(before);
    expect(rest).toEqual([]);
    expect(problemsOf(event?.event ?? "")).toEqual([]);
    const ocsf = fields(event as never);
    // The step that failed is the action; the operation refused, its own.
    expect([ocsf.metadata.event_code, ocsf.api?.operation, ocsf.activity_id]).toEqual([
      "authorizeScope",
      "sendMessage",
      1,
    ]);
    expect(ocsf.http_request.url.path).toBe(
      "/api/operator/v1/s/:agent/:session/threads/:thread/messages",
    );
    // A read refused is a Read.
    const { secret: sessionsOnly } = await harness.createKey(["sessions:read"]);
    await harness.operator(sessionsOnly, "GET", "/threads");
    const read = failures(before).at(-1);
    expect([read?.action, fields(read as never).activity_id]).toEqual(["authorizeScope", 2]);
  });

  it("for an approval's group or tags is recorded once the approval has rolled back", async () => {
    const { secret } = await harness.createKey(["sessions:approve"]);
    const key = newAgentKey();
    await harness.register(key, "builder", "main");
    const id = harness.registrationId(key);
    await harness.operator(secret, "GET", "/registrations");
    const before = lastSeq(harness.fixture.db);
    const refused = await harness.operator(secret, "POST", `/registrations/${id}/approve`, {
      agent: { name: "builder", existing: false },
      session: { name: "main", existing: false, tags: ["infra"] },
    });
    expect(codeOf(refused)).toBe("not_found");
    expect(
      eventsAfter(harness.fixture.db, before).map((each) => [
        each.action,
        each.outcome,
        fields(each).api?.operation,
      ]),
    ).toEqual([["authorizeScope", "failure", "approveRegistration"]]);
  });

  it("revoked during a long poll is recorded once, as revoked", async () => {
    const { key, secret } = await harness.createKey(["threads:read"]);
    await harness.operator(secret, "GET", "/threads");
    const before = lastSeq(harness.fixture.db);
    const pending = harness.operator(secret, "GET", "/wait?wait=25");
    const { notifier } = harness.fixture.store;
    for (let i = 0; i < 100 && notifier.waiting(everySession) < 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await harness.web("POST", `/keys/${key.id}/revoke`);
    expect(codeOf(await pending)).toBe("unauthenticated");
    expect(
      eventsAfter(harness.fixture.db, before).map((each) => [
        each.action,
        fields(each).status_detail,
        fields(each).count,
      ]),
    ).toEqual([
      ["revokeApiKey", undefined, undefined],
      ["authenticateApiKey", "key_revoked", 1],
    ]);
  });
});

describe("an agent's refused credential", () => {
  it("records nothing", async () => {
    const agent: AgentKey = newAgentKey();
    const before = lastSeq(harness.fixture.db);
    expect(codeOf(await harness.agent(agent, "GET", "/s/builder/main/threads"))).toBe(
      "unauthenticated",
    );
    expect(eventsAfter(harness.fixture.db, before)).toEqual([]);
  });
});

describe("a failure that cannot be recorded", () => {
  it("is logged at most once a minute, and the request refused as before", async () => {
    harness.fixture.db
      .prepare(
        `CREATE TRIGGER audit_full BEFORE INSERT ON audit_events
         BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`,
      )
      .run();
    expect([await failSignIn(), await failSignIn()]).toEqual([401, 401]);
    const logged = () => harness.logged.filter((line) => line.includes("audit log"));
    expect(logged()).toHaveLength(1);
    harness.fixture.advance(60_000);
    expect(await failSignIn()).toBe(401);
    expect(logged()).toHaveLength(2);
  });
});
