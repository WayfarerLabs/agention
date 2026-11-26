import {
  type ApiKeyList,
  type ErrorBody,
  formatTimestamp,
  type Scope,
  scopes,
  threadsQuery,
} from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticateApiKey } from "../auth/api-keys.ts";
import { listThreads } from "../store/index.ts";
import { asOf } from "../store/thread-lists.ts";
import { hour, testOrigin } from "../store/test-fixture.ts";
import { operatorOperations } from "./operator-operations.ts";
import { uploaded } from "./file-test-support.ts";
import { defaultRates } from "./rates.ts";
import {
  type AgentKey,
  codeOf,
  Harness,
  newAgentKey,
  newThread,
  sessionCookie,
} from "./test-harness.ts";

let harness: Harness;
let agent: AgentKey;

beforeEach(async () => {
  harness = new Harness();
  agent = await harness.approvedAgent("builder", "main");
  await harness.agent(agent, "POST", "/s/builder/main/threads", newThread("r-1"));
  await harness.web("POST", "/s/builder/main/tags", { tags: ["infra"] });
});

afterEach(() => {
  harness.close();
});

// A request to every operator operation, with valid input and any headers
// it needs, keyed by the operation's name. Decisions on registrations use a
// pending one of their own, submitted first. The agent's thread 2 starts
// with a file, which a file read reads, and the operator holds a pending
// upload, which removing one removes.
type Call = [string, string, unknown, Record<string, string>?];

async function requests(): Promise<Record<string, Call>> {
  const pending = async (session: string) => {
    const key = newAgentKey();
    await harness.register(key, "builder", session);
    return harness.registrationId(key);
  };
  const approving = await pending("approved");
  const rejecting = await pending("rejected");
  const attached = await uploaded(harness, "agent", agent, Buffer.from("notes"));
  await harness.agent(
    agent,
    "POST",
    "/s/builder/main/threads",
    newThread("r-f", { text: "The notes.", attachments: [{ upload: attached.upload }] }),
  );
  const staged = await uploaded(harness, "web", agent, Buffer.from("draft"));
  return {
    uploadFile: [
      "POST",
      "/s/builder/main/uploads?name=notes.txt",
      Buffer.from("notes"),
      { "content-type": "text/plain", "content-length": "5" },
    ],
    removeUpload: ["POST", `/s/builder/main/uploads/${staged.upload}/remove`, undefined],
    listThreadFiles: ["GET", "/s/builder/main/threads/2/files", undefined],
    readFile: ["GET", "/s/builder/main/threads/2/messages/1/files/notes.txt", undefined],
    listThreads: ["GET", "/threads", undefined],
    countThreads: ["GET", "/threads/counts", undefined],
    findThreadNeighbors: ["GET", "/s/builder/main/threads/1/neighbors", undefined],
    waitForThreads: ["GET", "/wait", undefined],
    getThread: ["GET", "/s/builder/main/threads/1", undefined],
    sendMessage: [
      "POST",
      "/s/builder/main/threads/1/messages",
      { request_id: "o-1", seen_through: 1, text: "m" },
    ],
    markRead: ["POST", "/s/builder/main/threads/1/read", { through: 1 }],
    markUnread: ["POST", "/s/builder/main/threads/1/unread", { from: 1 }],
    archiveThread: ["POST", "/s/builder/main/threads/1/archive", { through: 1 }],
    startThread: ["POST", "/s/builder/main/threads", { request_id: "o-2", title: "t", text: "x" }],
    bulkRead: [
      "POST",
      "/reads",
      { threads: [{ agent: "builder", session: "main", thread: 1, through: 1 }] },
    ],
    bulkArchive: [
      "POST",
      "/archives",
      { threads: [{ agent: "builder", session: "main", thread: 1, through: 1 }] },
    ],
    actOnThreads: [
      "POST",
      "/threads/actions",
      {
        action: "read",
        threads: [{ agent: "builder", session: "main", thread: 1, through: 1 }],
      },
    ],
    actOnMatchingThreads: [
      "POST",
      "/threads/actions/matching",
      // A search nothing matches, so the other calls' threads leave the set as
      // expected.
      {
        action: "read",
        filters: { search: "unmatched" },
        as_of: asOf(harness.fixture.db),
        expected: 0,
      },
    ],
    listSessions: ["GET", "/sessions", undefined],
    readSessionLog: ["GET", "/s/builder/main/updates", undefined],
    markSessionLogRead: ["POST", "/s/builder/main/updates/read", { through: 0 }],
    listGroupsAndTags: ["GET", "/groups-and-tags", undefined],
    createGroup: ["POST", "/groups", { name: "Work" }],
    orderGroups: ["POST", "/groups/order", { groups: [1] }],
    renameGroup: ["POST", "/groups/1/name", { name: "Play" }],
    recolorGroup: ["POST", "/groups/1/color", { color: "teal" }],
    removeGroup: ["POST", "/groups/1/remove", undefined],
    createTag: ["POST", "/tags", { name: "billing", color: "orange" }],
    renameTag: ["POST", "/tags/infra/name", { name: "ops" }],
    recolorTag: ["POST", "/tags/ops/color", { color: "blue" }],
    removeTag: ["POST", "/tags/ops/remove", undefined],
    setSessionGroup: ["POST", "/s/builder/main/group", { group: null }],
    setSessionTags: ["POST", "/s/builder/main/tags", { tags: ["infra"] }],
    setAgentTags: ["POST", "/agents/builder/tags", { tags: [] }],
    listRegistrations: ["GET", "/registrations", undefined],
    approveRegistration: [
      "POST",
      `/registrations/${approving}/approve`,
      {
        agent: { name: "builder", existing: true },
        session: { name: "approved", existing: false },
      },
    ],
    rejectRegistration: ["POST", `/registrations/${rejecting}/reject`, undefined],
    revokeRegistration: [
      "POST",
      `/registrations/${harness.registrationId(agent)}/revoke`,
      undefined,
    ],
  };
}

// The scopes that grant each scope, itself included.
const granting: Record<Scope, Scope[]> = {
  "threads:read": ["threads:read", "threads:write"],
  "threads:write": ["threads:write"],
  "sessions:read": ["sessions:read", "sessions:write", "sessions:approve"],
  "sessions:write": ["sessions:write"],
  "sessions:approve": ["sessions:approve"],
};

describe("the operator mount", () => {
  it("lists the versions it serves, and knows no other", async () => {
    const versions = await harness.request("GET", "/api/operator");
    expect(versions.body).toEqual({ versions: [1] });
    const { secret } = await harness.createKey(["threads:read"]);
    expect(
      codeOf(
        await harness.request("GET", "/api/operator/v2/threads", {
          headers: { authorization: `Bearer ${secret}` },
        }),
      ),
    ).toBe("not_found");
    expect(codeOf(await harness.operator(secret, "GET", "/threads"))).toBe("ok");
  });

  it("serves every operator operation, each to a key holding its scope", async () => {
    const all = await requests();
    expect(Object.keys(all).sort()).toEqual(operatorOperations.map((each) => each.name).sort());
    const { secret } = await harness.createKey([...scopes]);
    for (const each of operatorOperations) {
      const [method, path, body, headers] = all[each.name] ?? ["GET", "/", undefined];
      const response = await harness.operator(secret, method, path, body, headers);
      expect([each.name, codeOf(response)]).toEqual([each.name, "ok"]);
    }
  });

  it.each(scopes)("refuses every operation %s does not grant as not_found", async (held) => {
    const all = await requests();
    const { secret } = await harness.createKey([held]);
    for (const each of operatorOperations) {
      const [method, path, body, headers] = all[each.name] ?? ["GET", "/", undefined];
      const response = await harness.operator(secret, method, path, body, headers);
      const expected = granting[each.scope].includes(held) ? "ok" : "not_found";
      expect([each.name, codeOf(response)]).toEqual([each.name, expected]);
    }
  });

  it("refuses a missing scope before reading the input", async () => {
    const { secret } = await harness.createKey(["threads:read"]);
    const response = await harness.operator(secret, "POST", "/s/BAD!/main/threads/1/read", "{");
    expect(codeOf(response)).toBe("not_found");
  });

  it("leaves a read key's targets as they were", async () => {
    const { secret } = await harness.createKey(["threads:read", "sessions:read"]);
    const before = (await harness.web("GET", "/threads")).body;
    for (const path of ["/threads", "/s/builder/main/threads/1", "/sessions"]) {
      expect(codeOf(await harness.operator(secret, "GET", path))).toBe("ok");
    }
    expect((await harness.web("GET", "/threads")).body).toEqual(before);
  });

  it("answers what the web mount answers", async () => {
    const { secret } = await harness.createKey(["threads:read", "sessions:read"]);
    for (const path of ["/threads", "/s/builder/main/threads/1", "/sessions", "/registrations"]) {
      expect((await harness.operator(secret, "GET", path)).body).toEqual(
        (await harness.web("GET", path)).body,
      );
    }
  });

  it("acts as the operator", async () => {
    const { secret } = await harness.createKey(["threads:write"]);
    const sent = await harness.operator(secret, "POST", "/s/builder/main/threads/1/messages", {
      request_id: "o-1",
      seen_through: 1,
      text: "From a client",
    });
    expect(codeOf(sent)).toBe("ok");
    const thread = (await harness.web("GET", "/s/builder/main/threads/1")).body as {
      messages: { author: unknown }[];
    };
    expect(thread.messages.at(-1)?.author).toEqual({ kind: "person", name: "operator" });
  });

  it("writes and reads a message's branches", async () => {
    const { secret } = await harness.createKey(["threads:write"]);
    const branch = { repo: "acme/agention", branch: "fix/links", url: "https://example.com/b" };
    const sent = await harness.operator(secret, "POST", "/s/builder/main/threads/1/messages", {
      request_id: "o-1",
      seen_through: 1,
      branches: [branch],
    });
    expect(codeOf(sent)).toBe("ok");
    const read = await harness.operator(secret, "GET", "/s/builder/main/threads/1");
    expect(read.body).toMatchObject({
      messages: [{ seq: 1 }, { seq: 2, branches: [branch] }],
      branches: { links: [branch], truncated: false },
    });
  });

  it("lists and counts the threads by pull request and branch, as the web mount does", async () => {
    const { secret } = await harness.createKey(["threads:read", "threads:write"]);
    const pull = { repo: "acme/agention", number: 135 };
    const sent = await harness.operator(secret, "POST", "/s/builder/main/threads/1/messages", {
      request_id: "o-1",
      seen_through: 1,
      pull_requests: [pull],
    });
    expect(codeOf(sent)).toBe("ok");
    const narrowed = `pull_request=${encodeURIComponent("Acme/Agention#135")}`;
    const listed = await harness.operator(secret, "GET", `/threads?${narrowed}`);
    expect(listed.body).toMatchObject({
      threads: [{ number: 1, links: { pull_requests: 1, branches: 0, pull_request: pull } }],
      total: 1,
    });
    const none = await harness.operator(secret, "GET", "/threads?branch=acme/agention:main");
    expect(none.body).toMatchObject({ threads: [], total: 0 });
    const counts = await harness.operator(secret, "GET", `/threads/counts?${narrowed}`);
    expect(counts.body).toMatchObject({
      pull_request: { pull_requests: [{ ...pull, total: 1 }], truncated: false },
      branch: { branches: [], truncated: false },
    });
    for (const path of [`/threads?${narrowed}`, `/threads/counts?${narrowed}`]) {
      expect((await harness.operator(secret, "GET", path)).body).toEqual(
        (await harness.web("GET", path)).body,
      );
    }
  });
});

describe("a key's credential", () => {
  // The refusal every bad key gets, whatever is wrong with it.
  async function refusalOf(authorization?: string): Promise<ErrorBody> {
    const response = await harness.request("GET", "/api/operator/v1/threads", {
      headers: authorization === undefined ? {} : { authorization },
    });
    expect(response.status).toBe(401);
    return response.body as ErrorBody;
  }

  it("is refused alike whether missing, malformed, unknown, revoked or expired", async () => {
    const revoked = await harness.createKey(["threads:read"]);
    await harness.web("POST", `/keys/${revoked.key.id}/revoke`);
    const expiring = await harness.createKey(["threads:read"], { kind: "days", days: 7 });
    harness.fixture.advance(7 * 24 * hour);
    const unknown = `agention_${"A".repeat(43)}`;
    const refusals = [
      await refusalOf(),
      await refusalOf("Bearer"),
      await refusalOf("Bearer not-a-key"),
      await refusalOf(`Bearer ${unknown}`),
      await refusalOf(`Basic ${revoked.secret}`),
      await refusalOf(`Bearer ${revoked.secret}`),
      await refusalOf(`Bearer ${expiring.secret}`),
    ];
    expect(new Set(refusals.map((each) => JSON.stringify(each))).size).toBe(1);
    expect(refusals[0]?.error.code).toBe("unauthenticated");
  });

  it("stops working at once when revoked", async () => {
    const { key, secret } = await harness.createKey(["threads:read"]);
    expect(codeOf(await harness.operator(secret, "GET", "/threads"))).toBe("ok");
    await harness.web("POST", `/keys/${key.id}/revoke`);
    expect(codeOf(await harness.operator(secret, "GET", "/threads"))).toBe("unauthenticated");
  });

  it("is refused by an operation that runs after a revocation it authenticated before", async () => {
    const { key, secret } = await harness.createKey(["threads:read"]);
    const { store } = harness.fixture;
    const { identity } = authenticateApiKey(store, `Bearer ${secret}`, testOrigin);
    await harness.web("POST", `/keys/${key.id}/revoke`);
    expect(() => listThreads(store, identity, threadsQuery.parse({}))).toThrow(
      expect.objectContaining({ code: "unauthenticated" }),
    );
  });

  it("stops working at once when it expires", async () => {
    const { secret } = await harness.createKey(["threads:read"], { kind: "days", days: 7 });
    harness.fixture.advance(7 * 24 * hour - 1);
    expect(codeOf(await harness.operator(secret, "GET", "/threads"))).toBe("ok");
    harness.fixture.advance(1);
    expect(codeOf(await harness.operator(secret, "GET", "/threads"))).toBe("unauthenticated");
  });

  it("refuses a request carrying a cookie, even with a valid key", async () => {
    const { secret } = await harness.createKey(["threads:read"]);
    const response = await harness.operator(secret, "GET", "/threads", undefined, {
      cookie: `${sessionCookie}=${harness.cookie}`,
    });
    expect(codeOf(response)).toBe("unauthenticated");
    const cookieAlone = await harness.request("GET", "/api/operator/v1/threads", {
      headers: { cookie: `${sessionCookie}=${harness.cookie}` },
    });
    expect(codeOf(cookieAlone)).toBe("unauthenticated");
  });

  it("is refused by the web mount", async () => {
    const { secret } = await harness.createKey(["threads:read"]);
    const response = await harness.web("GET", "/threads", undefined, {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(codeOf(response)).toBe("unauthenticated");
  });

  it("records its use at most hourly", async () => {
    const { key, secret } = await harness.createKey(["threads:read"]);
    const lastUsed = async () => {
      const { keys } = (await harness.web("GET", "/keys")).body as ApiKeyList;
      return keys.find((each) => each.id === key.id)?.last_used_at;
    };
    expect(await lastUsed()).toBeUndefined();
    const first = harness.fixture.now;
    await harness.operator(secret, "GET", "/threads");
    expect(await lastUsed()).toBe(formatTimestamp(first));
    harness.fixture.advance(hour - 1);
    await harness.operator(secret, "GET", "/threads");
    expect(await lastUsed()).toBe(formatTimestamp(first));
    harness.fixture.advance(1);
    await harness.operator(secret, "GET", "/threads");
    expect(await lastUsed()).toBe(formatTimestamp(first + hour));
  });
});

// The drains below run on a frozen clock, so a drained budget stays drained.
describe("rate budgets", () => {
  it("give each key its own", async () => {
    const one = await harness.createKey(["threads:read"]);
    const two = await harness.createKey(["threads:read"]);
    for (let i = 0; i < defaultRates.apiKey.burst; i++) {
      expect(codeOf(await harness.operator(one.secret, "GET", "/threads"))).toBe("ok");
    }
    expect(codeOf(await harness.operator(one.secret, "GET", "/threads"))).toBe("rate_limited");
    expect(codeOf(await harness.operator(two.secret, "GET", "/threads"))).toBe("ok");
  });

  it("spend the shared failed-key budget only on failure, never refusing a live key", async () => {
    const { secret } = await harness.createKey(["threads:read"]);
    let refused;
    for (let i = 0; i <= defaultRates.failedKeyAuth.burst && refused === undefined; i++) {
      const response = await harness.operator("agention_wrong", "GET", "/threads");
      if (codeOf(response) !== "unauthenticated") {
        refused = response;
      }
    }
    expect(refused === undefined ? "never" : codeOf(refused)).toBe("rate_limited");
    expect(codeOf(await harness.operator(secret, "GET", "/threads"))).toBe("ok");
    expect(codeOf(await harness.agent(agent, "GET", "/s/builder/main/threads"))).toBe("ok");
  });
});
