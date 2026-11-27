import { scopes } from "@wayfarerlabs/agention-api";
import { afterEach, describe, expect, it } from "vitest";
import { issuePasskeyLink } from "../auth/passkey-links.ts";
import { agentOperations, registration } from "../http/agent-operations.ts";
import { operatorOperations } from "../http/operator-operations.ts";
import { TestAuthenticator, TestBrowser } from "../http/test-browser.ts";
import {
  type AgentKey,
  codeOf,
  Harness,
  newAgentKey,
  newThread,
  origin,
  type Response,
} from "../http/test-harness.ts";
import { asOf } from "../store/thread-lists.ts";
import { isAuditAction } from "./actions.ts";
import { eventsAfter, lastSeq, parsed, problemsOf, type StoredEvent } from "./test-events.ts";

// Every write records its event: each POST declaration on the web, operator
// and agent mounts, and each POST route of the web mount's own, is driven
// here, and must record exactly the events listed, with the credential that
// made it, or none for the read marks. A declaration or route without a
// driver fails, so a new write cannot go unrecorded unnoticed. Every event
// recorded validates against the pinned OCSF class schemas.

// The declarations that record nothing: the read marks.
const recordsNothing = new Set(["markRead", "markUnread", "bulkRead", "markSessionLogRead"]);

type CredentialKind = "browser_session" | "api_key" | "registration";

// A call as a mount takes it: method, path within the mount, body, headers.
type Call = [string, string, unknown?, Record<string, string>?];

// Who drives a declaration: the operator's browser on the web mount, an API
// key holding every scope on the operator mount, or the agent's registration
// on the agent mount.
interface Caller {
  credential: CredentialKind;
  call(...call: Call): Promise<Response>;
}

// What a driver does: its call, made once its setup is done, and the events
// it records, by action, each by the caller's credential.
interface Driven {
  call: Call;
  events: string[];
}

interface Context {
  harness: Harness;
  agent: AgentKey;
  caller: Caller;
}

type Driver = (context: Context) => Promise<Driven>;

const allHarnesses: Harness[] = [];

afterEach(() => {
  for (const harness of allHarnesses.splice(0)) {
    harness.close();
  }
});

let requestCounter = 0;
const requestId = () => `audit-${(requestCounter += 1)}`;

const thread2 = (harness: Harness) =>
  harness.fixture.lastSeq({ agent: "builder", session: "main", thread: 2 });

// A server with an approved agent, builder/main, whose thread 1 asks the
// operator a question and whose thread 2, "Plain", asks nothing, and a tag.
async function setUp(): Promise<{ harness: Harness; agent: AgentKey }> {
  const harness = new Harness();
  allHarnesses.push(harness);
  const agent = await harness.approvedAgent("builder", "main");
  await harness.agent(
    agent,
    "POST",
    "/s/builder/main/threads",
    newThread(requestId(), { asks: [{ question: "Ship it?" }] }),
  );
  await harness.agent(
    agent,
    "POST",
    "/s/builder/main/threads",
    newThread(requestId(), { title: "Plain" }),
  );
  await harness.web("POST", "/s/builder/main/tags", { tags: ["infra"] });
  return { harness, agent };
}

// The callers of each mount. An API key's first use records its activation,
// so the key is used once first.
const callers: Record<CredentialKind, (harness: Harness, agent: AgentKey) => Promise<Caller>> = {
  browser_session: async (harness) => ({
    credential: "browser_session",
    call: (method, path, body, headers) =>
      harness.web(method, path, body, { headers: headers ?? {} }),
  }),
  api_key: async (harness) => {
    const { secret } = await harness.createKey([...scopes]);
    expect(codeOf(await harness.operator(secret, "GET", "/threads"))).toBe("ok");
    return {
      credential: "api_key",
      call: (method, path, body, headers) => harness.operator(secret, method, path, body, headers),
    };
  },
  registration: async (harness, agent) => ({
    credential: "registration",
    call: (method, path, body, headers) =>
      harness.agent(agent, method, path, body, headers === undefined ? {} : { headers }),
  }),
};

const uploadCall = (): Call => [
  "POST",
  "/s/builder/main/uploads?name=notes.txt",
  Buffer.from("notes"),
  { "content-type": "text/plain", "content-length": "5" },
];

async function pending(harness: Harness, session: string): Promise<number> {
  const key = newAgentKey();
  await harness.register(key, "builder", session);
  return harness.registrationId(key);
}

async function group(context: Context, name = "Work"): Promise<number> {
  const created = await context.harness.web("POST", "/groups", { name });
  return (created.body as { id: number }).id;
}

async function savedView(context: Context): Promise<number> {
  const created = await context.harness.web("POST", "/saved-views", { name: "Overdue", view: {} });
  return (created.body as { id: number }).id;
}

const target = (thread: number, through: number) => ({
  agent: "builder",
  session: "main",
  thread,
  through,
});

// The drivers of the declarations, by name, each one or more inputs that
// record differently.
const declarations: Record<string, Driver[]> = {
  sendMessage: [
    async ({ harness }) => ({
      call: [
        "POST",
        "/s/builder/main/threads/2/messages",
        { request_id: requestId(), seen_through: thread2(harness), text: "m" },
      ],
      events: ["sendMessage"],
    }),
  ],
  markRead: [
    async () => ({ call: ["POST", "/s/builder/main/threads/2/read", { through: 1 }], events: [] }),
  ],
  markUnread: [
    async () => ({ call: ["POST", "/s/builder/main/threads/2/unread", { from: 1 }], events: [] }),
  ],
  archiveThread: [
    async ({ harness }) => ({
      call: ["POST", "/s/builder/main/threads/2/archive", { through: thread2(harness) }],
      events: ["archiveThread"],
    }),
  ],
  uploadFile: [async () => ({ call: uploadCall(), events: ["uploadFile"] })],
  removeUpload: [
    async ({ caller }) => {
      const uploaded = await caller.call(...uploadCall());
      const { upload } = uploaded.body as { upload: string };
      return {
        call: ["POST", `/s/builder/main/uploads/${upload}/remove`],
        events: ["removeUpload"],
      };
    },
  ],
  startThread: [
    async () => ({
      call: ["POST", "/s/builder/main/threads", { request_id: requestId(), title: "t", text: "x" }],
      events: ["startThread"],
    }),
  ],
  createThread: [
    async () => ({
      call: ["POST", "/s/builder/main/threads", newThread(requestId())],
      events: ["createThread"],
    }),
  ],
  updateSession: [
    async () => ({
      call: ["POST", "/s/builder/main/status", { state: "working", note: "On it." }],
      events: ["updateSession"],
    }),
    // An update that changes nothing logs nothing, and records nothing.
    async ({ caller }) => {
      await caller.call("POST", "/s/builder/main/status", { state: "idle" });
      return { call: ["POST", "/s/builder/main/status", { state: "idle" }], events: [] };
    },
  ],
  bulkRead: [async () => ({ call: ["POST", "/reads", { threads: [target(2, 1)] }], events: [] })],
  bulkArchive: [
    async ({ harness }) => ({
      call: ["POST", "/archives", { threads: [target(2, thread2(harness))] }],
      events: ["bulkArchive"],
    }),
    // A bulk archive that archives no thread records nothing.
    async () => ({ call: ["POST", "/archives", { threads: [target(1, 1)] }], events: [] }),
  ],
  actOnThreads: [
    async () => ({
      call: ["POST", "/threads/actions", { action: "read", threads: [target(2, 1)] }],
      events: [],
    }),
    async () => ({
      call: ["POST", "/threads/actions", { action: "unread", threads: [target(2, 1)] }],
      events: [],
    }),
    async ({ harness }) => ({
      call: [
        "POST",
        "/threads/actions",
        { action: "read_and_archive", threads: [target(2, thread2(harness))] },
      ],
      events: ["actOnThreads"],
    }),
    async () => ({
      call: [
        "POST",
        "/threads/actions",
        { action: "decline_read_and_archive", threads: [target(1, 1)] },
      ],
      events: ["actOnThreads"],
    }),
  ],
  actOnMatchingThreads: [
    async ({ harness }) => ({
      call: [
        "POST",
        "/threads/actions/matching",
        { action: "read", filters: {}, as_of: asOf(harness.fixture.db), expected: 2 },
      ],
      events: [],
    }),
    async ({ harness }) => ({
      call: [
        "POST",
        "/threads/actions/matching",
        {
          action: "read_and_archive",
          filters: { search: "Plain" },
          as_of: asOf(harness.fixture.db),
          expected: 1,
        },
      ],
      events: ["actOnMatchingThreads"],
    }),
  ],
  markSessionLogRead: [
    async () => ({ call: ["POST", "/s/builder/main/updates/read", { through: 0 }], events: [] }),
  ],
  createGroup: [
    async () => ({ call: ["POST", "/groups", { name: "Work" }], events: ["createGroup"] }),
  ],
  orderGroups: [
    async (context) => ({
      call: ["POST", "/groups/order", { groups: [await group(context)] }],
      events: ["orderGroups"],
    }),
  ],
  renameGroup: [
    async (context) => ({
      call: ["POST", `/groups/${await group(context)}/name`, { name: "Play" }],
      events: ["renameGroup"],
    }),
  ],
  recolorGroup: [
    async (context) => ({
      call: ["POST", `/groups/${await group(context)}/color`, { color: "teal" }],
      events: ["recolorGroup"],
    }),
  ],
  removeGroup: [
    async (context) => ({
      call: ["POST", `/groups/${await group(context)}/remove`],
      events: ["removeGroup"],
    }),
  ],
  createTag: [
    async () => ({ call: ["POST", "/tags", { name: "billing" }], events: ["createTag"] }),
  ],
  renameTag: [
    async () => ({ call: ["POST", "/tags/infra/name", { name: "ops" }], events: ["renameTag"] }),
    // A tag renamed to its own name changes nothing, and records nothing.
    async () => ({ call: ["POST", "/tags/infra/name", { name: "infra" }], events: [] }),
  ],
  recolorTag: [
    async () => ({
      call: ["POST", "/tags/infra/color", { color: "blue" }],
      events: ["recolorTag"],
    }),
  ],
  removeTag: [async () => ({ call: ["POST", "/tags/infra/remove"], events: ["removeTag"] })],
  createSavedView: [
    async () => ({
      call: ["POST", "/saved-views", { name: "Overdue", view: { overdue: true } }],
      events: ["createSavedView"],
    }),
  ],
  renameSavedView: [
    async (context) => ({
      call: ["POST", `/saved-views/${await savedView(context)}/name`, { name: "Blocked" }],
      events: ["renameSavedView"],
    }),
  ],
  replaceSavedView: [
    async (context) => ({
      call: ["POST", `/saved-views/${await savedView(context)}/view`, { view: { unread: true } }],
      events: ["replaceSavedView"],
    }),
  ],
  removeSavedView: [
    async (context) => ({
      call: ["POST", `/saved-views/${await savedView(context)}/remove`],
      events: ["removeSavedView"],
    }),
  ],
  setSessionGroup: [
    async (context) => ({
      call: ["POST", "/s/builder/main/group", { group: await group(context) }],
      events: ["setSessionGroup"],
    }),
  ],
  setSessionTags: [
    async () => ({
      call: ["POST", "/s/builder/main/tags", { tags: ["infra", "release"] }],
      events: ["setSessionTags"],
    }),
  ],
  setAgentTags: [
    async () => ({
      call: ["POST", "/agents/builder/tags", { tags: ["ops"] }],
      events: ["setAgentTags"],
    }),
  ],
  approveRegistration: [
    async ({ harness }) => ({
      call: [
        "POST",
        `/registrations/${await pending(harness, "approved")}/approve`,
        {
          agent: { name: "builder", existing: true },
          session: { name: "approved", existing: false, tags: ["infra"] },
        },
      ],
      events: ["approveRegistration"],
    }),
  ],
  rejectRegistration: [
    async ({ harness }) => ({
      call: ["POST", `/registrations/${await pending(harness, "rejected")}/reject`],
      events: ["rejectRegistration"],
    }),
  ],
  revokeRegistration: [
    async ({ harness }) => {
      const other = await harness.approvedAgent("builder", "other");
      return {
        call: ["POST", `/registrations/${harness.registrationId(other)}/revoke`],
        events: ["revokeRegistration"],
      };
    },
  ],
};

// drive runs a driver against a new server and answers the events its call
// recorded and those it lists, having checked the call succeeded.
async function drive(
  credential: CredentialKind,
  driver: Driver,
): Promise<{ recorded: StoredEvent[]; listed: string[] }> {
  const { harness, agent } = await setUp();
  const caller = await callers[credential](harness, agent);
  const { call, events } = await driver({ harness, agent, caller });
  const before = lastSeq(harness.fixture.db);
  const response = await caller.call(...call);
  expect([call[1], codeOf(response)]).toEqual([call[1], "ok"]);
  return { recorded: eventsAfter(harness.fixture.db, before), listed: events };
}

// expectRecorded checks the events a call recorded: those listed, in order,
// each a success by the credential, valid against its class's schema, and
// naming its action as its event code and, for API Activity, its operation.
function expectRecorded(events: StoredEvent[], actions: string[], credential: string): void {
  expect(events.map((event) => [event.action, event.credential_kind])).toEqual(
    actions.map((action) => [action, credential]),
  );
  for (const event of events) {
    expect([event.action, problemsOf(event.event)]).toEqual([event.action, []]);
    const ocsf = parsed(event);
    expect(event.outcome).toBe("success");
    expect(ocsf.metadata.event_code).toBe(event.action);
    if (event.class_uid === 6003) {
      expect((ocsf.api as { operation: string }).operation).toBe(event.action);
    }
  }
}

describe("every write", () => {
  it("is a declaration with a driver, an action in the table or a read mark", () => {
    const posts = [...operatorOperations, ...agentOperations, registration].filter(
      (each) => each.method === "POST",
    );
    for (const name of new Set(posts.map((each) => each.name))) {
      expect([name, recordsNothing.has(name) || isAuditAction(name)]).toEqual([name, true]);
      if (name !== registration.name) {
        expect([name, declarations[name] !== undefined]).toEqual([name, true]);
      }
    }
    expect(posts.length).toBeGreaterThan(0);
  });

  const mounts: [CredentialKind, readonly { name: string; method: string }[]][] = [
    ["browser_session", operatorOperations],
    ["api_key", operatorOperations],
    ["registration", agentOperations],
  ];
  const cases = mounts.flatMap(([credential, operations]) =>
    operations
      .filter((each) => each.method === "POST")
      .flatMap((each) =>
        (declarations[each.name] ?? []).map((driver, index) => ({
          label: `${each.name} ${index + 1}, by ${credential}`,
          credential,
          driver,
        })),
      ),
  );

  it.each(cases)("records exactly its events: $label", async ({ credential, driver }) => {
    const { recorded, listed } = await drive(credential, driver);
    expectRecorded(recorded, listed, credential);
  });

  it("records a new registration as its key's, and a known key's call as nothing", async () => {
    const { harness } = await setUp();
    const key = newAgentKey();
    const submit = () =>
      harness.agent(key, "POST", "/registrations", { agent: "builder", session: "new" });
    const before = lastSeq(harness.fixture.db);
    expect(codeOf(await submit())).toBe("ok");
    const events = eventsAfter(harness.fixture.db, before);
    expectRecorded(events, ["register"], "registration");
    expect(parsed(events[0] as StoredEvent).actor).toEqual({
      session: { credential_uid: `registration:${harness.registrationId(key)}` },
    });
    const after = lastSeq(harness.fixture.db);
    expect(codeOf(await submit())).toBe("ok");
    expect(eventsAfter(harness.fixture.db, after)).toEqual([]);
  });

  it("names the message of declines among what an archiving action wrote", async () => {
    const {
      recorded: [event],
    } = await drive("api_key", async () => ({
      call: [
        "POST",
        "/threads/actions",
        { action: "decline_read_and_archive", threads: [target(1, 1)] },
      ],
      events: [],
    }));
    expect((parsed(event as StoredEvent).resources as unknown[]).map((each) => each)).toEqual([
      expect.objectContaining({ type: "thread", name: "builder/main/1", data: { through: 2 } }),
      expect.objectContaining({
        type: "message",
        name: "builder/main/1/2",
        data: expect.objectContaining({ declined: [1], answers: [] }),
      }),
    ]);
  });
});

// The web mount's own routes, by path, each driven by a browser signed in
// with a passkey through a link, holding a passkey an authenticator answers
// for.
interface Browsing {
  harness: Harness;
  browser: TestBrowser;
  authenticator: TestAuthenticator;
}

interface WebDriven {
  // The call, made once the setup is done.
  call: () => Promise<{ status: number }>;
  events: string[];
}

type WebDriver = (browsing: Browsing) => Promise<WebDriven>;

async function signedInBrowser(harness: Harness): Promise<Browsing> {
  const browser = new TestBrowser(harness);
  const authenticator = new TestAuthenticator();
  const linked = await browser.link(
    issuePasskeyLink(harness.fixture.store, "operator"),
    authenticator,
  );
  expect(linked.status).toBe(200);
  return { harness, browser, authenticator };
}

const passkeyIds = (harness: Harness) =>
  (harness.fixture.db.prepare("SELECT id FROM passkeys ORDER BY id").all() as { id: number }[]).map(
    (row) => row.id,
  );

const webRoutes: Record<string, WebDriver> = {
  "/api/web/auth/signin/begin": async ({ browser }) => ({
    call: () => browser.post("/auth/signin/begin"),
    events: [],
  }),
  "/api/web/auth/signin/finish": async ({ browser, authenticator }) => ({
    call: () => browser.signIn(authenticator),
    events: ["signIn"],
  }),
  "/api/web/auth/link/begin": async ({ harness }) => {
    const token = issuePasskeyLink(harness.fixture.store, "operator");
    return {
      call: () => new TestBrowser(harness).post("/auth/link/begin", { token, name: "Phone" }),
      events: [],
    };
  },
  "/api/web/auth/link/finish": async ({ harness, browser }) => {
    expect(
      (
        await browser.post("/keys", {
          name: "ci",
          scopes: ["threads:read"],
          expiry: { kind: "none" },
        })
      ).status,
    ).toBe(200);
    const phone = new TestBrowser(harness);
    const authenticator = new TestAuthenticator();
    const options = await phone.begin("/auth/link/begin", {
      token: issuePasskeyLink(harness.fixture.store, "operator"),
      name: "Phone",
    });
    return {
      call: () =>
        phone.post("/auth/link/finish", {
          credential: authenticator.create(options, origin),
        }),
      events: ["usePasskeyLink", "replacePasskey", "revokeApiKey", "addPasskey"],
    };
  },
  "/api/web/auth/signout": async ({ browser }) => ({
    call: () => browser.post("/auth/signout"),
    events: ["signOut"],
  }),
  "/api/web/passkeys/register/begin": async ({ browser }) => ({
    call: () => browser.post("/passkeys/register/begin", { name: "Phone" }),
    events: [],
  }),
  "/api/web/passkeys/register/finish": async ({ browser }) => {
    const options = await browser.begin("/passkeys/register/begin", { name: "Phone" });
    return {
      call: () =>
        browser.post("/passkeys/register/finish", {
          credential: new TestAuthenticator().create(options, origin),
        }),
      events: ["addPasskey"],
    };
  },
  "/api/web/passkeys/:id/name": async ({ harness, browser }) => ({
    call: () => browser.post(`/passkeys/${passkeyIds(harness)[0]}/name`, { name: "Laptop 2" }),
    events: ["renamePasskey"],
  }),
  "/api/web/passkeys/:id/remove": async ({ harness, browser }) => {
    expect((await browser.addPasskey(new TestAuthenticator(), "Phone")).status).toBe(200);
    return {
      call: () => browser.post(`/passkeys/${passkeyIds(harness).at(-1)}/remove`),
      events: ["removePasskey"],
    };
  },
  "/api/web/settings/voice": async ({ browser }) => ({
    call: () =>
      browser.post("/settings/voice", {
        base_url: "https://stt.test/v1",
        model: "m",
        api_key: "sk-test-key-1234",
      }),
    events: ["setVoiceSettings"],
  }),
  "/api/web/settings/voice/clear": async ({ browser }) => ({
    call: () => browser.post("/settings/voice/clear"),
    events: ["clearVoiceSettings"],
  }),
  // Voice is off, so it is refused; it would write nothing either way.
  "/api/web/transcriptions": async ({ browser }) => ({
    call: async () => ({
      status: (await browser.post("/transcriptions")).status === 404 ? 200 : 500,
    }),
    events: [],
  }),
  "/api/web/keys": async ({ browser }) => ({
    call: () =>
      browser.post("/keys", { name: "ci", scopes: ["threads:read"], expiry: { kind: "none" } }),
    events: ["createApiKey"],
  }),
  "/api/web/keys/:id/revoke": async ({ browser }) => {
    const created = await browser.post("/keys", {
      name: "ci",
      scopes: ["threads:read"],
      expiry: { kind: "none" },
    });
    const { key } = created.body as { key: { id: number } };
    return { call: () => browser.post(`/keys/${key.id}/revoke`), events: ["revokeApiKey"] };
  },
};

describe("every web-only write", () => {
  const harness = new Harness();
  const operatorPaths = new Set(
    operatorOperations.map((each) => `${each.method} /api/web${each.path}`),
  );
  const routes = [
    ...new Set(
      harness.app.routes
        .filter((route) => route.method === "POST" && route.path.startsWith("/api/web/"))
        .map((route) => route.path)
        .filter((path) => !operatorPaths.has(`POST ${path}`)),
    ),
  ];
  harness.close();

  it("has a driver", () => {
    expect(routes.sort()).toEqual(Object.keys(webRoutes).sort());
  });

  it.each(routes)("records exactly its events: %s", async (route) => {
    const fresh = new Harness();
    allHarnesses.push(fresh);
    const browsing = await signedInBrowser(fresh);
    const driver = webRoutes[route];
    if (driver === undefined) {
      throw new Error(`no driver for ${route}`);
    }
    const driven = await driver(browsing);
    const before = lastSeq(fresh.fixture.db);
    expect([route, (await driven.call()).status]).toEqual([route, 200]);
    expectRecorded(eventsAfter(fresh.fixture.db, before), driven.events, "browser_session");
  });
});
