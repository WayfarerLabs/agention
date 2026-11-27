import { hostname, userInfo } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issuePasskeyLink } from "../auth/passkey-links.ts";
import { boundedUserAgent, peerAddress } from "../http/origin.ts";
import { createApiKey } from "../auth/api-keys.ts";
import { createGroup, createStore } from "../store/index.ts";
import { type Agent, Fixture, testOrigin, threadTarget } from "../store/test-fixture.ts";
import { openFailureQuery, recordFailure } from "./record.ts";
import { eventsAfter, lastSeq, parsed, problemsOf } from "./test-events.ts";

let fixture: Fixture;
let agent: Agent;

beforeEach(() => {
  fixture = new Fixture();
  agent = fixture.registerAgent("builder", "main");
});

afterEach(() => {
  fixture.close();
});

const events = (after = 0) => eventsAfter(fixture.db, after);

describe("recording", () => {
  it("leaves no event for a write that fails", () => {
    fixture.createThread(agent, { asks: [{ question: "Ship it?" }] });
    const before = lastSeq(fixture.db);
    const target = threadTarget(agent, 1);
    fixture.write(agent.identity, target, { text: "m" });
    expect(() =>
      fixture.write(agent.identity, target, { text: "stale", seen_through: 1 }),
    ).toThrow();
    expect(events(before).map((event) => event.action)).toEqual(["sendMessage"]);
  });

  it("fails the write when its event cannot be saved", () => {
    fixture.db
      .prepare(
        `CREATE TRIGGER audit_full BEFORE INSERT ON audit_events
         BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END`,
      )
      .run();
    expect(() => createGroup(fixture.store, fixture.operator, { name: "Work" })).toThrow(/full/);
    expect(fixture.db.prepare("SELECT count(*) AS n FROM session_groups").get()).toEqual({ n: 0 });
  });

  it("wakes the dispatcher once the transaction has ended", async () => {
    let woken = 0;
    fixture.store.auditWake.listen(() => {
      woken += 1;
    });
    createGroup(fixture.store, fixture.operator, { name: "Work" });
    expect(woken).toBe(0);
    await Promise.resolve();
    expect(woken).toBe(1);
  });

  it("times an event as its write, by the clock the write read", () => {
    // A clock that moves on every read, so a second read tells.
    let ticks = fixture.now;
    const store = createStore(fixture.db, { clock: () => (ticks += 1) });
    createApiKey(store, fixture.operator, {
      name: "ci",
      scopes: ["threads:read"],
      expiry: { kind: "none" },
    });
    const { created_at } = fixture.db.prepare("SELECT created_at FROM api_keys").get() as {
      created_at: number;
    };
    const [event] = events().filter((each) => each.action === "createApiKey");
    expect(event?.time).toBe(created_at);
  });

  it("writes an event on one line for every reader, whatever its text holds", () => {
    const userAgent = "agent\u0085one\u2028two\u2029three";
    recordFailure(
      fixture.store,
      { kind: "none", origin: { ...testOrigin, userAgent } },
      { action: "signIn" },
    );
    const [event] = events().filter((each) => each.outcome === "failure");
    expect(event?.event).not.toMatch(/[\u0085\u2028\u2029]/);
    expect(parsed(event as never).http_request).toMatchObject({ user_agent: userAgent });
    recordFailure(
      fixture.store,
      { kind: "none", origin: { ...testOrigin, userAgent } },
      { action: "signIn" },
    );
    const [counted] = events().filter((each) => each.outcome === "failure");
    expect([counted?.event, parsed(counted as never).count]).toEqual([
      expect.not.stringMatching(/[\u0085\u2028\u2029]/),
      2,
    ]);
  });

  it("names the command line's user, process and host, and no request", () => {
    const before = lastSeq(fixture.db);
    issuePasskeyLink(fixture.store, "operator");
    const [event] = events(before);
    expect(problemsOf(event?.event ?? "")).toEqual([]);
    const ocsf = parsed(event as never);
    const user = userInfo();
    expect(ocsf.actor).toEqual({
      user: { uid: `os_user:${user.uid}`, name: user.username, type_id: 99, type: "OS user" },
      process: { pid: process.pid, name: "agention", cmd_line: "agention passkey-link" },
    });
    expect(ocsf.src_endpoint).toEqual({ hostname: hostname() });
    expect(ocsf.http_request).toBeUndefined();
    expect([event?.credential_kind, event?.credential_id]).toEqual(["cli", null]);
  });
});

describe("coalescing", () => {
  const refused = (code: "key_revoked" | "key_expired", keyId = 1) =>
    recordFailure(
      fixture.store,
      { kind: "refused_key", keyId, origin: testOrigin },
      { action: "authenticateApiKey", code },
    );

  beforeEach(() => {
    fixture.db
      .prepare(
        `INSERT INTO api_keys (id, person_id, name, scopes, hash, created_at, revoked_at)
         VALUES (1, 1, 'ci', '[]', randomblob(32), 0, 0), (2, 1, 'cd', '[]', randomblob(32), 0, 0)`,
      )
      .run();
  });

  const failures = () => events().filter((event) => event.outcome === "failure");

  const counts = () =>
    failures().map((event) => {
      const ocsf = parsed(event) as unknown as { count: number; status_detail: string };
      return [event.credential_id, ocsf.status_detail, ocsf.count];
    });

  it("folds one kind's failures in a minute into one event, and keeps kinds apart", () => {
    refused("key_revoked");
    refused("key_revoked");
    refused("key_expired");
    refused("key_revoked", 2);
    expect(counts()).toEqual([
      ["1", "key_revoked", 2],
      ["1", "key_expired", 1],
      ["2", "key_revoked", 1],
    ]);
  });

  it("opens a new event once the minute of the first ends", () => {
    fixture.now = Math.floor(fixture.now / 60_000) * 60_000 + 59_999;
    refused("key_revoked");
    fixture.advance(1);
    refused("key_revoked");
    const [first, second] = failures();
    expect([first?.open_until, second?.open_until]).toEqual([fixture.now, fixture.now + 60_000]);
    expect(counts().map(([, , count]) => count)).toEqual([1, 1]);
  });

  it("never counts into an event a sink has passed, as when the clock stepped back", () => {
    fixture.now = Math.floor(fixture.now / 60_000) * 60_000 + 10_000;
    refused("key_revoked");
    fixture.advance(50_000);
    fixture.db
      .prepare("INSERT INTO audit_sinks (name, delivered_seq, created_at) VALUES ('file', ?, 0)")
      .run(lastSeq(fixture.db));
    fixture.advance(-30_000);
    refused("key_revoked");
    expect(counts()).toEqual([
      ["1", "key_revoked", 1],
      ["1", "key_revoked", 1],
    ]);
  });

  it("counts an event whose minute ends more than a minute ahead as closed", () => {
    refused("key_revoked");
    fixture.advance(-60 * 60_000);
    refused("key_revoked");
    expect(counts().map(([, , count]) => count)).toEqual([1, 1]);
  });

  it("finds the open event through the open events' index", () => {
    const plan = fixture.db
      .prepare(`EXPLAIN QUERY PLAN ${openFailureQuery}`)
      .all({ now: 0, action: "signIn", kind: "none", id: null, detail: null, answer: null }) as {
      detail: string;
    }[];
    expect(plan.map((row) => row.detail)).toContainEqual(
      expect.stringMatching(/USING (COVERING )?INDEX audit_events_open/),
    );
  });

  it("keeps an event's window from moving back with the clock", () => {
    fixture.advance(30_000);
    refused("key_revoked");
    fixture.advance(-10_000);
    refused("key_revoked");
    const ocsf = parsed(failures()[0] as never) as unknown as {
      end_time: number;
      start_time: number;
    };
    expect(ocsf.end_time).toBe(ocsf.start_time);
  });
});

describe("the schema", () => {
  // A valid event, and the same with each shape the class schemas refuse,
  // which the builder must never write.
  it("refuses the shapes the builder never writes", () => {
    fixture.createThread(agent);
    issuePasskeyLink(fixture.store, "operator");
    recordFailure(fixture.store, { kind: "none", origin: testOrigin }, { action: "signIn" });
    const [created, linked, failed] = events(lastSeq(fixture.db) - 3).map((event) => event.event);
    for (const valid of [created, linked, failed]) {
      expect(problemsOf(valid ?? "")).toEqual([]);
    }
    const broken = (json: string | undefined, change: (event: Record<string, any>) => void) => {
      const event = JSON.parse(json ?? "{}") as Record<string, any>;
      change(event);
      return problemsOf(JSON.stringify(event));
    };
    for (const change of [
      (event: Record<string, any>) => {
        event.src_endpoint = {};
      },
      (event: Record<string, any>) => {
        event.actor = {};
      },
      (event: Record<string, any>) => {
        event.metadata.reporter = {};
      },
      (event: Record<string, any>) => {
        event.unknown = 1;
      },
      (event: Record<string, any>) => {
        event.type_uid += 1;
      },
      (event: Record<string, any>) => {
        event.src_endpoint = { ip: "::ffff:not-an-address" };
      },
    ]) {
      expect(broken(created, change)).not.toEqual([]);
    }
    expect(
      broken(failed, (event) => {
        delete event.service;
      }),
    ).not.toEqual([]);
    expect(
      broken(failed, (event) => {
        event.user = { type_id: 0 };
      }),
    ).not.toEqual([]);
  });
});

describe("a request's origin", () => {
  it("keeps a usable peer address, an IPv4-mapped one as IPv4", () => {
    expect(
      ["::ffff:127.0.0.1", "127.0.0.1", "::1", "fe80::1%eth0", "not an address", undefined].map(
        peerAddress,
      ),
    ).toEqual(["127.0.0.1", "127.0.0.1", "::1", "fe80::1%eth0", undefined, undefined]);
  });

  it("cuts a user agent to 256 code units, never splitting a surrogate pair", () => {
    expect(boundedUserAgent("a".repeat(300))).toHaveLength(256);
    const paired = `${"a".repeat(255)}\u{1F600}`;
    expect(boundedUserAgent(paired)).toBe("a".repeat(255));
    expect(boundedUserAgent("curl/8.9.1")).toBe("curl/8.9.1");
  });
});
