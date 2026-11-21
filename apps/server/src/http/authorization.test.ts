import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentKey, codeOf, Harness, newThread, sessionCookie } from "./test-harness.ts";

let harness: Harness;
let mine: AgentKey;
let theirs: AgentKey;

beforeEach(async () => {
  harness = new Harness();
  mine = await harness.approvedAgent("builder", "main");
  theirs = await harness.approvedAgent("reviewer", "main");
  for (const [key, session] of [
    [mine, "builder/main"],
    [theirs, "reviewer/main"],
  ] as const) {
    const response = await harness.agent(key, "POST", `/s/${session}/threads`, newThread("r-1"));
    expect(response.status).toBe(200);
  }
});

afterEach(() => {
  harness.close();
});

// Every agent route on a session, with a valid body, for the session given:
// first those only the agent mount has, then the routes on a thread, which
// both mounts share.
function agentRoutes(session: string): [string, string, unknown][] {
  return [
    ["POST", `/s/${session}/status`, { state: "working" }],
    ["POST", `/s/${session}/threads`, newThread("r-2")],
    ["GET", `/s/${session}/threads`, undefined],
    ["GET", `/s/${session}/wait?wait=0`, undefined],
    ["GET", `/s/${session}/threads/1`, undefined],
    ["POST", `/s/${session}/threads/1/messages`, { request_id: "r-3", seen_through: 1, text: "m" }],
    ["POST", `/s/${session}/threads/1/read`, { through: 1 }],
    ["POST", `/s/${session}/threads/1/unread`, { from: 1 }],
    ["POST", `/s/${session}/threads/1/archive`, { through: 1 }],
  ];
}

// The operator's routes for their groups and tags, with a valid body.
const groupAndTagRoutes: [string, string, unknown][] = [
  ["GET", "/groups-and-tags", undefined],
  ["POST", "/groups", { name: "Work" }],
  ["POST", "/groups/1/name", { name: "Play" }],
  ["POST", "/groups/1/remove", undefined],
  ["POST", "/tags/infra/name", { name: "ops" }],
  ["POST", "/tags/infra/remove", undefined],
  ["POST", "/s/builder/main/group", { group: null }],
  ["POST", "/s/builder/main/tags", { tags: [] }],
  ["POST", "/agents/builder/tags", { tags: [] }],
];

// Every web route, with a valid body.
const webRoutes: [string, string, unknown][] = [
  ["GET", "/session", undefined],
  ["POST", "/auth/signin/begin", undefined],
  ["POST", "/auth/signin/finish", { credential: {} }],
  ["POST", "/auth/link/begin", { token: "x", name: "Laptop" }],
  ["POST", "/auth/link/finish", { credential: {} }],
  ["POST", "/auth/signout", undefined],
  ["GET", "/threads", undefined],
  ["POST", "/reads", { threads: [{ agent: "builder", session: "main", thread: 1, through: 1 }] }],
  [
    "POST",
    "/archives",
    { threads: [{ agent: "builder", session: "main", thread: 1, through: 1 }] },
  ],
  ["GET", "/registrations", undefined],
  ["POST", "/registrations/1/approve", undefined],
  ["POST", "/registrations/1/reject", undefined],
  ["POST", "/registrations/1/revoke", undefined],
  ["GET", "/sessions", undefined],
  ["GET", "/sessions/unread-updates", undefined],
  ["GET", "/passkeys", undefined],
  ["POST", "/passkeys/register/begin", { name: "Phone" }],
  ["POST", "/passkeys/register/finish", { credential: {} }],
  ["POST", "/passkeys/1/name", { name: "Laptop" }],
  ["POST", "/passkeys/1/remove", undefined],
  ["GET", "/s/builder/main/threads/1", undefined],
  ["POST", "/s/builder/main/threads/1/messages", { request_id: "r", seen_through: 1, text: "m" }],
  ["POST", "/s/builder/main/threads/1/read", { through: 1 }],
  ["POST", "/s/builder/main/threads/1/unread", { from: 1 }],
  ["POST", "/s/builder/main/threads/1/archive", { through: 1 }],
  ["POST", "/s/builder/main/threads", { request_id: "o-1", title: "t", text: "m" }],
  ["GET", "/s/builder/main/updates", undefined],
  ["POST", "/s/builder/main/updates/read", { through: 0 }],
  ...groupAndTagRoutes,
];

// The web routes on a session, with a valid body, for the session given.
function webSessionRoutes(session: string): [string, string, unknown][] {
  return [
    ["POST", `/s/${session}/threads`, { request_id: "o-2", title: "t", text: "m" }],
    ["GET", `/s/${session}/updates`, undefined],
    ["POST", `/s/${session}/updates/read`, { through: 0 }],
    ["POST", `/s/${session}/group`, { group: null }],
    ["POST", `/s/${session}/tags`, { tags: ["infra"] }],
  ];
}

describe("authorization over HTTP", () => {
  it("answers every agent route on another session as not_found", async () => {
    for (const [method, path, body] of agentRoutes("reviewer/main")) {
      const response = await harness.agent(mine, method, path, body);
      expect([path, codeOf(response)]).toEqual([path, "not_found"]);
    }
    for (const [method, path, body] of agentRoutes("builder/main")) {
      const response = await harness.agent(mine, method, path, body);
      expect([path, codeOf(response)]).toEqual([path, "ok"]);
    }
  });

  it("answers a session that does not exist as it answers another's", async () => {
    for (const [method, path, body] of agentRoutes("builder/nowhere")) {
      const response = await harness.agent(mine, method, path, body);
      expect([path, codeOf(response)]).toEqual([path, "not_found"]);
    }
    for (const [method, path, body] of [
      ...agentRoutes("nobody/main").slice(4),
      ...webSessionRoutes("nobody/main"),
    ]) {
      const response = await harness.web(method, path, body);
      expect([path, codeOf(response)]).toEqual([path, "not_found"]);
    }
    for (const [method, path, body] of webSessionRoutes("builder/main")) {
      const response = await harness.web(method, path, body);
      expect([path, codeOf(response)]).toEqual([path, "ok"]);
    }
  });

  it("takes the actor from the token, never from the request", async () => {
    const response = await harness.agent(mine, "POST", "/s/builder/main/threads/1/messages", {
      request_id: "r-4",
      seen_through: 1,
      text: "from me",
      actor: { kind: "person", name: "operator" },
    });
    expect(response.status).toBe(200);
    const thread = await harness.web("GET", "/s/builder/main/threads/1");
    expect(thread.body).toMatchObject({
      messages: [{}, { author: { kind: "session", agent: "builder", session: "main" } }],
    });
  });
});

describe("the operator's own routes", () => {
  it("are none of the agent mount's", async () => {
    for (const [method, path, body] of [
      ["GET", "/sessions", undefined],
      ["GET", "/sessions/unread-updates", undefined],
      ["GET", "/s/builder/main/updates", undefined],
      ["POST", "/s/builder/main/updates/read", { through: 0 }],
      ...groupAndTagRoutes,
    ] as const) {
      const response = await harness.agent(mine, method, path, body);
      expect([path, codeOf(response)]).toEqual([path, "not_found"]);
    }
  });
});

describe("credentials on the other mount", () => {
  it("refuse an agent token on every web route", async () => {
    const authorization = `Bearer ${await harness.token(mine)}`;
    for (const [method, path, body] of webRoutes) {
      const response = await harness.web(method, path, body, {
        cookie: null,
        headers: { authorization },
      });
      expect([path, codeOf(response)]).toEqual([path, "unauthenticated"]);
    }
  });

  it("refuse an agent token beside a valid browser session", async () => {
    const authorization = `Bearer ${await harness.token(mine)}`;
    const response = await harness.web("GET", "/threads", undefined, {
      headers: { authorization },
    });
    expect(codeOf(response)).toBe("unauthenticated");
  });

  it("refuse the browser session on every agent route, even beside a valid token", async () => {
    const cookie = `${sessionCookie}=${harness.cookie}`;
    const routes: [string, string, unknown][] = [
      ["POST", "/registrations", { agent: "builder", session: "main" }],
      ...agentRoutes("builder/main"),
    ];
    for (const [method, path, body] of routes) {
      const withToken = await harness.agent(mine, method, path, body, { headers: { cookie } });
      expect([path, codeOf(withToken)]).toEqual([path, "unauthenticated"]);
      const alone = await harness.request(method, `/api/agent${path}`, {
        body,
        headers: { cookie },
      });
      expect([path, codeOf(alone)]).toEqual([path, "unauthenticated"]);
    }
  });
});
