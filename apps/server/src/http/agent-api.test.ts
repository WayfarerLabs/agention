import {
  agentApi,
  agentApiHeader,
  codeLinksAgentApiVersion,
  type ErrorBody,
  formatTimestamp,
  summaryLinksAgentApiVersion,
  type ThreadGetResult,
  type ThreadPage,
  type WaitResult,
} from "@wayfarerlabs/agention-api";
import { registrationCode } from "@wayfarerlabs/agention-server-api/registration-code";
import { SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hour } from "../store/test-fixture.ts";
import { seenFailureLogInterval } from "./agent-api.ts";
import {
  type AgentKey,
  codeOf,
  Harness,
  newAgentKey,
  newThread,
  origin,
  type Response,
} from "./test-harness.ts";

let harness: Harness;
let approved: AgentKey;

beforeEach(async () => {
  harness = new Harness();
  approved = await harness.approvedAgent("builder", "main");
});

afterEach(() => {
  harness.close();
});

const list = (key: AgentKey, options = {}) =>
  harness.agent(key, "GET", "/s/builder/main/threads", undefined, options);

function messageOf(response: Response): string {
  return (response.body as ErrorBody).error.message;
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

describe("agent tokens", () => {
  it("authenticate an approved key's session calls", async () => {
    const response = await list(approved);
    expect(response.status).toBe(200);
    expect((response.body as ThreadPage).threads).toEqual([]);
  });

  it("refuse a request without a token", async () => {
    const response = await harness.request("GET", "/api/agent/s/builder/main/threads");
    expect(response.status).toBe(401);
    expect(codeOf(response)).toBe("unauthenticated");
  });

  it.each([
    ["another scheme", (token: string) => `Basic ${token}`],
    ["a token that is not a JWS", () => "Bearer not-a-token"],
    ["two tokens", (token: string) => `Bearer ${token} ${token}`],
  ])("refuse %s", async (_, header) => {
    const token = await harness.token(approved);
    const response = await harness.request("GET", "/api/agent/s/builder/main/threads", {
      headers: { authorization: header(token) },
    });
    expect(codeOf(response)).toBe("unauthenticated");
  });

  it("refuse a token signed by another key than the one it names", async () => {
    const response = await list(approved, { signWith: newAgentKey().privateKey });
    expect(codeOf(response)).toBe("unauthenticated");
  });

  it("refuse a key the server does not know", async () => {
    expect(codeOf(await list(newAgentKey()))).toBe("unauthenticated");
  });

  it("refuse a token for another audience, naming this server's origin", async () => {
    const response = await list(approved, { claims: { aud: "https://other.test" } });
    expect(response.status).toBe(401);
    expect(codeOf(response)).toBe("unauthenticated");
    expect(messageOf(response)).toContain(origin);
  });

  it.each([
    ["an audience list", { aud: [origin] }],
    ["no audience", { aud: undefined }],
    ["no expiry", { exp: undefined }],
    ["an expiry that is not a number", { exp: "soon" }],
  ])("refuse %s", async (_, claims) => {
    expect(codeOf(await list(approved, { claims }))).toBe("unauthenticated");
  });

  it("accept an expiry up to 300 seconds ahead and refuse one further or past", async () => {
    const now = Math.floor(harness.fixture.now / 1000);
    const at = async (exp: number) => codeOf(await list(approved, { claims: { exp } }));
    expect(await at(now + 300)).toBe("ok");
    expect(await at(now + 301)).toBe("unauthenticated");
    expect(await at(now)).toBe("unauthenticated");
    expect(await at(now - 60)).toBe("unauthenticated");
  });

  it("refuse an algorithm other than EdDSA", async () => {
    const claims = { aud: origin, exp: Math.floor(harness.fixture.now / 1000) + 120 };
    const hmac = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", kid: approved.publicKey })
      .sign(new TextEncoder().encode("a shared secret of thirty-two bytes!"));
    const ed25519 = await new SignJWT(claims)
      .setProtectedHeader({ alg: "Ed25519", kid: approved.publicKey })
      .sign(approved.privateKey);
    const unsigned = `${base64url({ alg: "none", kid: approved.publicKey })}.${base64url(claims)}.`;
    for (const token of [hmac, ed25519, unsigned]) {
      const response = await harness.request("GET", "/api/agent/s/builder/main/threads", {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(codeOf(response)).toBe("unauthenticated");
    }
  });

  it("refuse a key whose registration is pending, expired, rejected or revoked", async () => {
    const pending = newAgentKey();
    await harness.register(pending, "builder", "main");
    expect(codeOf(await list(pending))).toBe("unauthenticated");

    const rejected = newAgentKey();
    await harness.register(rejected, "builder", "main");
    await harness.web("POST", `/registrations/${harness.registrationId(rejected)}/reject`);
    expect(codeOf(await list(rejected))).toBe("unauthenticated");

    await harness.web("POST", `/registrations/${harness.registrationId(approved)}/revoke`);
    expect(codeOf(await list(approved))).toBe("unauthenticated");

    harness.fixture.advance(hour);
    expect(codeOf(await list(pending))).toBe("unauthenticated");
  });

  it("refuse cookies, even beside a valid token", async () => {
    const response = await list(approved, { headers: { cookie: "anything=1" } });
    expect(codeOf(response)).toBe("unauthenticated");
  });
});

describe("registration", () => {
  it("records a new key as pending with its code, and reports the same state again", async () => {
    const key = newAgentKey();
    const state = await harness.register(key, "reviewer", "main");
    expect(state).toEqual({
      status: "pending",
      code: registrationCode(key.publicKey),
      expires_at: formatTimestamp(harness.fixture.now + hour),
    });
    expect(await harness.register(key, "other", "names")).toEqual(state);
    const { count } = harness.fixture.db
      .prepare("SELECT count(*) AS count FROM registrations WHERE public_key = ?")
      .get(key.publicKey) as { count: number };
    expect(count).toBe(1);
  });

  it("refuses a token not signed by the key it registers", async () => {
    const key = newAgentKey();
    const response = await harness.agent(
      key,
      "POST",
      "/registrations",
      { agent: "a", session: "s" },
      { signWith: newAgentKey().privateKey },
    );
    expect(codeOf(response)).toBe("unauthenticated");
    expect(
      harness.fixture.db
        .prepare("SELECT 1 FROM registrations WHERE public_key = ?")
        .get(key.publicKey),
    ).toBeUndefined();
  });

  it("refuses a token for another audience, naming this server's origin", async () => {
    const response = await harness.agent(
      newAgentKey(),
      "POST",
      "/registrations",
      { agent: "a", session: "s" },
      { claims: { aud: "https://agention.test:8443" } },
    );
    expect(codeOf(response)).toBe("unauthenticated");
    expect(messageOf(response)).toContain(origin);
  });

  it("refuses names outside the grammar", async () => {
    const response = await harness.agent(newAgentKey(), "POST", "/registrations", {
      agent: "Builder",
      session: "main",
    });
    expect(codeOf(response)).toBe("invalid_input");
    expect((response.body as ErrorBody).error.field).toBe("agent");
  });

  it("reports the granted names once the operator approves other names than proposed", async () => {
    const key = newAgentKey();
    await harness.register(key, "proposed", "names");
    const approval = await harness.web(
      "POST",
      `/registrations/${harness.registrationId(key)}/approve`,
      { agent: { name: "builder", existing: true }, session: { name: "side", existing: false } },
    );
    expect(approval.status).toBe(200);
    expect(await harness.register(key, "proposed", "names")).toMatchObject({
      status: "approved",
      agent: "builder",
      session: "side",
    });
    expect(codeOf(await harness.agent(key, "GET", "/s/builder/side/threads"))).toBe("ok");
  });

  it("approves onto an existing session only when the request says it exists", async () => {
    const key = newAgentKey();
    await harness.register(key, "builder", "main");
    const id = harness.registrationId(key);
    const asNew = await harness.web("POST", `/registrations/${id}/approve`, {
      agent: { name: "builder", existing: true },
      session: { name: "main", existing: false },
    });
    expect(codeOf(asNew)).toBe("invalid_input");
    expect((asNew.body as ErrorBody).error.field).toBe("session.name");
    const asExisting = await harness.web("POST", `/registrations/${id}/approve`, {
      agent: { name: "builder", existing: true },
      session: { name: "main", existing: true },
    });
    expect(asExisting.status).toBe(200);
    expect(codeOf(await list(key))).toBe("ok");
  });

  it("rejects for good, and revocation keeps the session's threads", async () => {
    const created = await harness.agent(
      approved,
      "POST",
      "/s/builder/main/threads",
      newThread("r-1"),
    );
    expect(created.status).toBe(200);

    const key = newAgentKey();
    await harness.register(key, "builder", "main");
    const rejected = await harness.web(
      "POST",
      `/registrations/${harness.registrationId(key)}/reject`,
    );
    expect(rejected.status).toBe(200);
    expect((await harness.register(key, "builder", "main")).status).toBe("rejected");

    const revoked = await harness.web(
      "POST",
      `/registrations/${harness.registrationId(approved)}/revoke`,
    );
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({
      registration: { status: "revoked", granted: { credential_active: false } },
    });
    expect((await harness.register(approved, "builder", "main")).status).toBe("revoked");
    const thread = await harness.web("GET", "/s/builder/main/threads/1");
    expect(thread.status).toBe(200);
  });
});

describe("the long poll", () => {
  const wait = (key: AgentKey, query: string, signal?: AbortSignal) =>
    harness.agent(key, "GET", `/s/builder/main/wait?${query}`, undefined, {
      ...(signal === undefined ? {} : { signal }),
    });

  async function created(): Promise<void> {
    const response = await harness.agent(
      approved,
      "POST",
      "/s/builder/main/threads",
      newThread("r-1"),
    );
    expect(response.status).toBe(200);
  }

  function sessionId(): number {
    const row = harness.fixture.db
      .prepare("SELECT session_id FROM registrations WHERE public_key = ?")
      .get(approved.publicKey) as { session_id: number };
    return row.session_id;
  }

  async function waiting(): Promise<void> {
    for (let i = 0; i < 100 && harness.fixture.store.notifier.waiting(sessionId()) === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(harness.fixture.store.notifier.waiting(sessionId())).toBe(1);
  }

  it("ends when a message it reports commits", async () => {
    await created();
    const pending = wait(approved, "wait=25");
    await waiting();
    const answer = await harness.web("POST", "/s/builder/main/threads/1/messages", {
      request_id: "w-1",
      seen_through: 1,
      text: "here",
    });
    expect(answer.status).toBe(200);
    const result = await pending;
    expect((result.body as WaitResult).threads.map((thread) => thread.number)).toEqual([1]);
  });

  it("ends as unauthenticated when its credential is revoked", async () => {
    const started = Date.now();
    const pending = wait(approved, "wait=25");
    await waiting();
    await harness.web("POST", `/registrations/${harness.registrationId(approved)}/revoke`);
    const result = await pending;
    expect(codeOf(result)).toBe("unauthenticated");
    // The agent is told how to recover, just as authentication tells it.
    const refused = await list(approved);
    expect(codeOf(refused)).toBe("unauthenticated");
    expect(messageOf(result)).toBe(messageOf(refused));
    expect(messageOf(result)).toMatch(/\bregister\b/);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("ends when the client disconnects", async () => {
    const controller = new AbortController();
    const pending = wait(approved, "wait=25", controller.signal).catch(() => undefined);
    await waiting();
    controller.abort();
    await pending;
    expect(harness.fixture.store.notifier.waiting(sessionId())).toBe(0);
  });

  it("ends when the server shuts down", async () => {
    const pending = wait(approved, "wait=25");
    await waiting();
    harness.shutdown.abort();
    expect((await pending).status).toBe(200);
  });
});

describe("presence", () => {
  const lastSeen = () =>
    (
      harness.fixture.db
        .prepare(
          `SELECT s.last_seen_at FROM sessions s JOIN agents a ON a.id = s.agent_id
           WHERE a.name = 'builder' AND s.name = 'main'`,
        )
        .get() as { last_seen_at: number | null }
    ).last_seen_at;

  it("stamp the session seen on every call, a refused one too, to the minute", async () => {
    expect(lastSeen()).toBeNull();
    await list(approved);
    const first = harness.fixture.now;
    expect(lastSeen()).toBe(first);
    harness.fixture.advance(30_000);
    expect(codeOf(await harness.agent(approved, "GET", "/s/builder/main/threads/9"))).toBe(
      "not_found",
    );
    expect(lastSeen()).toBe(first);
    harness.fixture.advance(30_000);
    expect(codeOf(await harness.agent(approved, "GET", "/s/builder/main/threads?limit=0"))).toBe(
      "invalid_input",
    );
    expect(lastSeen()).toBe(first + 60_000);
  });

  it("stamp the session when its approved key registers, the first call of a conversation", async () => {
    harness.fixture.advance(hour);
    expect((await harness.register(approved, "builder", "main")).status).toBe("approved");
    expect(lastSeen()).toBe(harness.fixture.now);
  });

  it("log a stamp that fails, at most once a minute, and answer the calls all the same", async () => {
    harness.fixture.db
      .prepare(
        `CREATE TRIGGER sessions_unseen BEFORE UPDATE OF last_seen_at ON sessions
         BEGIN SELECT RAISE(ABORT, 'unseen'); END`,
      )
      .run();
    expect((await list(approved)).status).toBe(200);
    expect(lastSeen()).toBeNull();
    expect(harness.logged).toHaveLength(1);
    harness.fixture.advance(seenFailureLogInterval - 1);
    expect((await list(approved)).status).toBe(200);
    expect(harness.logged).toHaveLength(1);
    harness.fixture.advance(1);
    await list(approved);
    expect(harness.logged).toHaveLength(2);
  });

  it("stamp nothing for a key not approved", async () => {
    const pending = newAgentKey();
    await harness.register(pending, "builder", "main");
    expect(codeOf(await list(pending))).toBe("unauthenticated");
    expect(lastSeen()).toBeNull();
  });

  it("show to the operator alone, with whether a thread is stranded", async () => {
    await harness.agent(approved, "POST", "/s/builder/main/threads", newThread("r-1"));
    await harness.web("POST", "/s/builder/main/threads/1/messages", {
      request_id: "o-1",
      seen_through: 1,
      text: "Over to you.",
    });
    const seen = { last_seen_at: formatTimestamp(harness.fixture.now), quiet: false };
    expect((await harness.web("GET", "/threads")).body).toMatchObject({
      threads: [{ presence: seen, stranded: false }],
    });
    harness.fixture.advance(hour);
    expect((await harness.web("GET", "/threads?agent_read=stranded")).body).toMatchObject({
      threads: [{ presence: { ...seen, quiet: true }, stranded: true }],
    });
    const own = (await list(approved)).body as ThreadPage;
    expect(own.threads[0]).not.toHaveProperty("presence");
    expect(own.threads[0]).not.toHaveProperty("stranded");
  });
});

describe("agent session routes", () => {
  const thread = "/s/builder/main/threads/1";

  it("start, list, read, write to, mark and archive a thread", async () => {
    const created = await harness.agent(
      approved,
      "POST",
      "/s/builder/main/threads",
      newThread("r-1", { asks: [{ question: "Ship it?" }] }),
    );
    expect(created.body).toEqual({ number: 1, seq: 1 });
    const listed = await harness.agent(
      approved,
      "GET",
      "/s/builder/main/threads?status=open&search=quest",
    );
    expect((listed.body as ThreadPage).threads.map((t) => t.number)).toEqual([1]);
    expect((await harness.agent(approved, "GET", thread)).status).toBe(200);
    const sent = await harness.agent(approved, "POST", `${thread}/messages`, {
      request_id: "r-2",
      seen_through: 1,
      text: "more detail",
    });
    expect(sent.body).toEqual({ number: 1, seq: 2 });
    const read = await harness.agent(approved, "POST", `${thread}/read`, { through: 2 });
    expect(read.body).toEqual({ cursors: { requester: 2, audience: 0 } });
    const archived = await harness.agent(approved, "POST", `${thread}/archive`, { through: 2 });
    expect(archived.body).toEqual({ marks: { read_through: 2, archived_through: 2 } });
  });

  it("mark a thread unread from the operator's message", async () => {
    await harness.agent(approved, "POST", "/s/builder/main/threads", newThread("r-1"));
    await harness.web("POST", `${thread}/messages`, {
      request_id: "o-1",
      seen_through: 1,
      text: "Answered.",
    });
    await harness.agent(approved, "POST", `${thread}/read`, { through: 2 });
    const unread = await harness.agent(approved, "POST", `${thread}/unread`, { from: 2 });
    expect(unread.body).toEqual({ cursors: { requester: 1, audience: 2 } });
    for (const from of [undefined, 0, 3]) {
      const refused = await harness.agent(approved, "POST", `${thread}/unread`, { from });
      expect(codeOf(refused)).toBe("invalid_input");
      expect((refused.body as ErrorBody).error.field).toBe("from");
    }
  });

  it("refuses input outside the schemas as invalid_input, naming the field", async () => {
    const cases: [string, string, unknown, string | undefined][] = [
      ["POST", "/s/builder/main/threads", newThread("r-1", { title: "" }), "title"],
      ["GET", "/s/builder/main/threads?limit=101", undefined, "limit"],
      ["GET", "/s/builder/main/threads?search=", undefined, "search"],
      ["GET", "/s/builder/main/threads?status=closed", undefined, "status"],
      ["GET", "/s/builder/main/threads?status=open&status=none", undefined, "status"],
      ["POST", "/s/builder/main/threads", newThread("r-1", { topic: "Auth" }), "topic"],
      ["POST", `${thread}/messages`, { request_id: "m", seen_through: 1, topic: "a/b" }, "topic"],
      ["GET", "/s/builder/main/threads?topic=builder/main/auth", undefined, "topic"],
      ["GET", "/s/builder/main/threads?pull_request=acme/agention", undefined, "pull_request"],
      ["GET", "/s/builder/main/threads?branch=acme/agention:a..b", undefined, "branch"],
      [
        "POST",
        `${thread}/messages`,
        { request_id: "m", seen_through: 1, branches: [{ repo: "acme", branch: "main" }] },
        "branches.0.repo",
      ],
      ["GET", "/s/builder/main/wait?wait=26", undefined, "wait"],
      ["GET", "/s/builder/main/threads/x", undefined, "thread"],
      ["GET", "/s/Builder/main/threads", undefined, "agent"],
    ];
    for (const [method, path, body, field] of cases) {
      const response = await harness.agent(approved, method, path, body);
      expect(codeOf(response)).toBe("invalid_input");
      expect((response.body as ErrorBody).error.field).toBe(field);
    }
  });

  it("take a message's text and detail at their bounds on both mounts, and read them back", async () => {
    await harness.agent(approved, "POST", "/s/builder/main/threads", newThread("r-0"));
    const text = "\u{1F600}".repeat(1_000);
    const detail = "\u{1F600}".repeat(20_000);
    const created = await harness.agent(
      approved,
      "POST",
      "/s/builder/main/threads",
      newThread("r-1", { text, detail }),
    );
    expect(created.body).toEqual({ number: 2, seq: 1 });
    const sent = await harness.agent(approved, "POST", `${thread}/messages`, {
      request_id: "a-1",
      seen_through: 1,
      text,
      detail,
    });
    expect(sent.body).toEqual({ number: 1, seq: 2 });
    const answered = await harness.web("POST", `${thread}/messages`, {
      request_id: "o-1",
      seen_through: 2,
      text,
      detail,
    });
    expect(answered.body).toEqual({ number: 1, seq: 3 });
    for (const read of [harness.agent(approved, "GET", thread), harness.web("GET", thread)]) {
      const { messages } = (await read).body as ThreadGetResult;
      expect(messages.slice(1).map((message) => [message.text, message.detail])).toEqual([
        [text, detail],
        [text, detail],
      ]);
    }
  });

  it("list the threads naming a pull request or branch, its short form escaped in the query", async () => {
    const pull = { repo: "acme/agention", number: 135 };
    const branch = { repo: "acme/agention", branch: "feat/a#1" };
    await harness.agent(
      approved,
      "POST",
      "/s/builder/main/threads",
      newThread("r-1", { pull_requests: [pull], branches: [branch] }),
    );
    await harness.agent(approved, "POST", "/s/builder/main/threads", newThread("r-2"));
    const numbers = async (query: string) =>
      (
        (await harness.agent(approved, "GET", `/s/builder/main/threads?${query}`)).body as {
          threads: { number: number }[];
        }
      ).threads.map((each) => each.number);
    expect(await numbers(`pull_request=${encodeURIComponent("Acme/Agention#135")}`)).toEqual([1]);
    expect(await numbers(`branch=${encodeURIComponent("acme/agention:feat/a#1")}`)).toEqual([1]);
    expect(await numbers(`branch=${encodeURIComponent("acme/agention:feat/a")}`)).toEqual([]);
    const read = await harness.agent(approved, "GET", "/s/builder/main/threads/1", undefined, {
      headers: { [agentApiHeader]: String(agentApi.version) },
    });
    expect(read.body).toMatchObject({
      messages: [{ pull_requests: [pull], branches: [branch] }],
      pull_requests: { links: [pull], truncated: false },
      branches: { links: [branch], truncated: false },
    });
  });

  it("refuses a body that is not JSON", async () => {
    const asText = await harness.agent(approved, "POST", `${thread}/read`, "{}", {
      headers: { "content-type": "text/plain" },
    });
    expect(codeOf(asText)).toBe("invalid_input");
    const malformed = await harness.agent(approved, "POST", `${thread}/read`, "{");
    expect(codeOf(malformed)).toBe("invalid_input");
  });

  it("answers not_found for a route the server lacks", async () => {
    expect(codeOf(await harness.agent(approved, "GET", "/s/builder/main/topics"))).toBe(
      "not_found",
    );
  });
});

describe("the agent API version", () => {
  const stated = (response: Response) => response.headers.get(agentApiHeader);

  it("is stated on every answer, refusals and unknown routes included", async () => {
    const responses = [
      await list(approved),
      await harness.agent(newAgentKey(), "POST", "/registrations", {
        agent: "reviewer",
        session: "main",
      }),
      await harness.agent(approved, "POST", "/registrations", {
        agent: "builder",
        session: "main",
      }),
      await harness.request("GET", "/api/agent/s/builder/main/threads"),
      await harness.agent(approved, "GET", "/s/builder/main/threads?limit=0"),
      await harness.agent(approved, "GET", "/s/builder/main/topics"),
      await harness.agent(approved, "GET", "/s/builder/main/threads", undefined, {
        headers: { [agentApiHeader]: String(agentApi.version + 1) },
      }),
      await harness.request("GET", "/api/agent/registrations", {
        headers: { host: "elsewhere.test" },
      }),
    ];
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200, 401, 400, 404, 400, 400,
    ]);
    for (const response of responses) {
      expect(stated(response)).toBe(String(agentApi.version));
    }
  });

  it("is never stated on the web mount, which ignores the header", async () => {
    const response = await harness.web("GET", "/threads", undefined, {
      headers: { [agentApiHeader]: String(agentApi.version + 1) },
    });
    expect(response.status).toBe(200);
    expect(stated(response)).toBeNull();
  });

  it("serves a request without the header as version 1, and one stating its own", async () => {
    for (const version of [undefined, "1", String(agentApi.version)]) {
      const headers = version === undefined ? {} : { [agentApiHeader]: version };
      expect([version, codeOf(await list(approved, { headers }))]).toEqual([version, "ok"]);
    }
  });

  it("leaves pull requests and branches out of answers to a version before them", async () => {
    const pull = { repo: "acme/agention", number: 135 };
    const branch = { repo: "acme/agention", branch: "feat/links" };
    await harness.agent(
      approved,
      "POST",
      "/s/builder/main/threads",
      newThread("r-1", { pull_requests: [pull], branches: [branch] }),
    );
    // What a bridge stating the version reads: the thread, its first message
    // and the first message a stale write missed.
    const answers = async (version: string | undefined) => {
      const headers = version === undefined ? {} : { [agentApiHeader]: version };
      const read = await harness.agent(approved, "GET", "/s/builder/main/threads/1", undefined, {
        headers,
      });
      const stale = await harness.agent(
        approved,
        "POST",
        "/s/builder/main/threads/1/messages",
        { request_id: `r-${version ?? "none"}`, seen_through: 0, text: "Late." },
        { headers },
      );
      const { messages, ...thread } = read.body as { messages: object[] };
      return [thread, messages[0], (stale.body as ErrorBody).error.missed?.[0]];
    };
    for (const version of [undefined, String(codeLinksAgentApiVersion - 1)]) {
      for (const answer of await answers(version)) {
        expect([version, answer]).toEqual([version, expect.objectContaining({})]);
        expect(answer).not.toHaveProperty("pull_requests");
        expect(answer).not.toHaveProperty("branches");
      }
    }
    const [thread, message, missed] = await answers(String(agentApi.version));
    expect(thread).toMatchObject({
      pull_requests: { links: [pull] },
      branches: { links: [branch] },
    });
    for (const answer of [message, missed]) {
      expect(answer).toMatchObject({ seq: 1, pull_requests: [pull], branches: [branch] });
    }
  });

  it("leaves links out of the thread summaries answered to a version before them", async () => {
    const pull = { repo: "acme/agention", number: 135 };
    await harness.agent(
      approved,
      "POST",
      "/s/builder/main/threads",
      newThread("r-1", { pull_requests: [pull] }),
    );
    await harness.web("POST", "/s/builder/main/threads/1/messages", {
      request_id: "o-1",
      seen_through: 1,
      text: "Seen it.",
    });
    // The summaries a bridge stating the version reads: a thread's, and those
    // of a list and a wait.
    const summaries = async (version: string | undefined) => {
      const headers = version === undefined ? {} : { [agentApiHeader]: version };
      const read = async (path: string) =>
        (await harness.agent(approved, "GET", `/s/builder/main${path}`, undefined, { headers }))
          .body as { thread?: object; threads?: object[] };
      return [
        (await read("/threads/1")).thread,
        ...((await read("/threads")).threads ?? []),
        ...((await read("/wait")).threads ?? []),
      ];
    };
    for (const version of [undefined, String(summaryLinksAgentApiVersion - 1)]) {
      const read = await summaries(version);
      expect([version, read.length]).toEqual([version, 3]);
      for (const summary of read) {
        expect(summary).toMatchObject({ number: 1 });
        expect(summary).not.toHaveProperty("links");
      }
    }
    for (const summary of await summaries(String(agentApi.version))) {
      expect(summary).toMatchObject({
        number: 1,
        links: { pull_requests: 1, branches: 0, pull_request: pull },
      });
    }
  });

  it("refuses a newer version before authenticating, so the call spends and stamps nothing", async () => {
    const headers = { [agentApiHeader]: String(agentApi.version + 1) };
    const unsigned = await harness.request("GET", "/api/agent/s/builder/main/threads", { headers });
    expect([unsigned.status, codeOf(unsigned)]).toEqual([400, "unsupported_version"]);
    const signed = await list(approved, { headers });
    expect(codeOf(signed)).toBe("unsupported_version");
    const registering = await harness.agent(
      newAgentKey(),
      "POST",
      "/registrations",
      { agent: "builder", session: "main" },
      { headers },
    );
    expect(codeOf(registering)).toBe("unsupported_version");
    const seen = harness.fixture.db.prepare("SELECT last_seen_at FROM sessions").get();
    expect(seen).toEqual({ last_seen_at: null });
    expect(harness.fixture.db.prepare("SELECT count(*) AS n FROM registrations").get()).toEqual({
      n: 1,
    });
  });

  it("refuses a version above the server's however many digits it has", async () => {
    const headers = { [agentApiHeader]: "99999999999999999999" };
    const response = await list(approved, { headers });
    expect([response.status, codeOf(response)]).toEqual([400, "unsupported_version"]);
  });

  it.each(["0", "02", "two", "1.0", ""])(
    "refuses %j as a version, naming the header",
    async (value) => {
      const response = await list(approved, { headers: { [agentApiHeader]: value } });
      expect(codeOf(response)).toBe("invalid_input");
      expect((response.body as ErrorBody).error.field).toBe(agentApiHeader);
    },
  );
});

describe("session status", () => {
  const status = (body: unknown) => harness.agent(approved, "POST", "/s/builder/main/status", body);

  it("answers with the session's status after each update", async () => {
    expect((await status({ state: "working", title: "Retire invoices" })).body).toEqual({
      state: "working",
      title: "Retire invoices",
    });
    expect((await status({ goal: "Drop the table", percent: 40 })).body).toEqual({
      state: "working",
      title: "Retire invoices",
      goal: "Drop the table",
      percent: 40,
    });
    expect((await status({ state: "stopped", outcome: "completed", note: "Done." })).body).toEqual({
      state: "stopped",
      outcome: "completed",
      title: "Retire invoices",
      goal: "Drop the table",
      percent: 40,
    });
  });

  it("refuses input outside the schema as invalid_input, naming the field", async () => {
    const response = await status({ state: "stopped" });
    expect(codeOf(response)).toBe("invalid_input");
    expect((response.body as ErrorBody).error.field).toBe("outcome");
  });
});

describe("a write's status", () => {
  const status = (body: unknown) => harness.agent(approved, "POST", "/s/builder/main/status", body);
  // The session's status as the operator's sessions view shows it.
  const viewed = async () => {
    const page = (await harness.web("GET", "/sessions")).body as {
      agents: { sessions: { status?: { state: string; note?: string } }[] }[];
    };
    return page.agents[0]?.sessions[0]?.status;
  };

  it("is reported beside a message, on the agent mount alone", async () => {
    await harness.agent(approved, "POST", "/s/builder/main/threads", newThread("r-1"));
    const sent = await harness.agent(approved, "POST", "/s/builder/main/threads/1/messages", {
      request_id: "r-2",
      seen_through: 1,
      text: "Over to you.",
      state: "idle",
      note: "Asked.",
    });
    expect(sent.body).toEqual({ number: 1, seq: 2 });
    expect(await viewed()).toMatchObject({ state: "idle", note: "Asked." });
    // The operator's mount takes no status, so it drops one sent beside a
    // message, as any field it does not know.
    const written = await harness.web("POST", "/s/builder/main/threads/1/messages", {
      request_id: "o-1",
      seen_through: 2,
      text: "Thanks.",
      state: "stopped",
      outcome: "completed",
    });
    expect(codeOf(written)).toBe("ok");
    expect(await viewed()).toMatchObject({ state: "idle", note: "Asked." });
  });

  it("is working once an idle session writes, from a bridge of any version served", async () => {
    for (const version of [undefined, String(agentApi.version - 1)]) {
      await status({ state: "idle", note: "Waiting." });
      const headers = version === undefined ? {} : { [agentApiHeader]: version };
      const created = await harness.agent(
        approved,
        "POST",
        "/s/builder/main/threads",
        newThread(`r-${version ?? "none"}`),
        { headers },
      );
      expect([version, codeOf(created)]).toEqual([version, "ok"]);
      const seen = await viewed();
      expect([version, seen?.state, seen?.note]).toEqual([version, "working", undefined]);
    }
  });
});
