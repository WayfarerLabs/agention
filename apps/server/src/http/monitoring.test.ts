import {
  agentApiHeader,
  type ErrorBody,
  formatTimestamp,
  monitoringAgentApiVersion,
  type SessionsPage,
  type ThreadPage,
} from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectedFor } from "../store/presence.ts";
import { defaultQuietAfter } from "../store/store.ts";
import { hour } from "../store/test-fixture.ts";
import {
  type AgentKey,
  codeOf,
  Harness,
  newAgentKey,
  newThread,
  type Response,
} from "./test-harness.ts";

let harness: Harness;
let approved: AgentKey;
// The number of the latest report a test sent, which each report counts up
// from unless the test numbers it.
let sent: number;

beforeEach(async () => {
  harness = new Harness();
  approved = await harness.approvedAgent("builder", "main");
  sent = 0;
});

afterEach(() => {
  harness.close();
});

// The headers of a bridge speaking a version of the agent API.
const speaking = (version: number) => ({ headers: { [agentApiHeader]: String(version) } });
const monitoring = speaking(monitoringAgentApiVersion);

const first = "bridge-first-0000";
const second = "bridge-second-000";

const poll = (bridge: string, query = "wait=0", signal?: AbortSignal) =>
  harness.agent(approved, "GET", `/s/builder/main/monitor?bridge=${bridge}&${query}`, undefined, {
    ...monitoring,
    ...(signal === undefined ? {} : { signal }),
  });

const report = (bridge: string, body: unknown, seq: number | string = ++sent) =>
  harness.agent(
    approved,
    "POST",
    `/s/builder/main/monitor?bridge=${bridge}&seq=${seq}`,
    body,
    monitoring,
  );

const list = (version?: number) =>
  harness.agent(
    approved,
    "GET",
    "/s/builder/main/threads",
    undefined,
    version === undefined ? {} : speaking(version),
  );

// What the session's row holds of its presence.
const stamps = () =>
  harness.fixture.db
    .prepare(
      `SELECT s.last_seen_at, s.last_seen_version, s.background_at
       FROM sessions s JOIN agents a ON a.id = s.agent_id
       WHERE a.name = 'builder' AND s.name = 'main'`,
    )
    .get() as {
    last_seen_at: number | null;
    last_seen_version: number | null;
    background_at: number | null;
  };

// The session's presence as the operator's sessions view shows it.
async function presence() {
  const page = (await harness.web("GET", "/sessions")).body as SessionsPage;
  return page.agents[0]?.sessions[0]?.presence;
}

const since = formatTimestamp(Date.UTC(2026, 9, 27, 11, 58));
const atPrompt = {
  monitored: true,
  profile: "codex",
  condition: "at_prompt",
  since,
  stopped_by: { reason: "usage_limit", resets_at: formatTimestamp(Date.UTC(2026, 9, 27, 15)) },
};

describe("check-ins and background requests", () => {
  it("stamp the background time on every background request, and never a check-in", async () => {
    expect((await poll(first)).body).toEqual({ replaced: false });
    expect(stamps()).toEqual({
      last_seen_at: null,
      last_seen_version: null,
      background_at: harness.fixture.now,
    });
    harness.fixture.advance(1_000);
    expect((await report(first, atPrompt)).body).toEqual({ replaced: false });
    expect(stamps()).toMatchObject({ last_seen_at: null, background_at: harness.fixture.now });
    harness.fixture.advance(1_000);
    expect(codeOf(await report(first, { monitored: true }))).toBe("invalid_input");
    expect(stamps()).toMatchObject({ last_seen_at: null, background_at: harness.fixture.now });
  });

  it("stamp every other call a check-in, with the version of the agent API it states", async () => {
    await list(monitoringAgentApiVersion);
    expect(stamps()).toEqual({
      last_seen_at: harness.fixture.now,
      last_seen_version: monitoringAgentApiVersion,
      background_at: null,
    });
    harness.fixture.advance(1_000);
    await list(4);
    expect(stamps()).toMatchObject({ last_seen_at: harness.fixture.now, last_seen_version: 4 });
    harness.fixture.advance(1_000);
    // A bridge from before the header states none, which is version 1.
    await list();
    expect(stamps()).toMatchObject({ last_seen_at: harness.fixture.now, last_seen_version: 1 });
  });

  it("stamp a registration's background read connected, and any other a check-in", async () => {
    const register = (body: object) =>
      harness.agent(approved, "POST", "/registrations", body, monitoring);
    const read = await register({ agent: "builder", session: "main", background: true });
    expect(read.body).toMatchObject({ status: "approved" });
    expect(read.body).not.toHaveProperty("connected");
    expect(stamps()).toEqual({
      last_seen_at: null,
      last_seen_version: null,
      background_at: harness.fixture.now,
    });
    harness.fixture.advance(hour);
    await register({ agent: "builder", session: "main", background: false });
    expect(stamps()).toEqual({
      last_seen_at: harness.fixture.now,
      last_seen_version: monitoringAgentApiVersion,
      background_at: harness.fixture.now - hour,
    });
  });

  it("register nothing for a background read of a key no registration has", async () => {
    const unknown = newAgentKey();
    const names = { agent: "builder", session: "other" };
    const count = () =>
      (harness.fixture.db.prepare("SELECT count(*) AS n FROM registrations").get() as { n: number })
        .n;
    const before = count();
    const read = await harness.agent(
      unknown,
      "POST",
      "/registrations",
      { ...names, background: true },
      monitoring,
    );
    expect(read.status).toBe(404);
    expect(codeOf(read)).toBe("not_found");
    expect(count()).toBe(before);
    // The agent's own register submits it, as ever.
    const submitted = await harness.agent(unknown, "POST", "/registrations", names, monitoring);
    expect(submitted.body).toMatchObject({ status: "pending" });
    expect(count()).toBe(before + 1);
  });
});

describe("one bridge acting for a session", () => {
  // polling waits until the session's one poll is waiting.
  async function polling(): Promise<void> {
    const { session_id: sessionId } = harness.fixture.db
      .prepare("SELECT session_id FROM registrations WHERE public_key = ?")
      .get(approved.publicKey) as { session_id: number };
    const { notifier } = harness.fixture.store;
    for (let i = 0; i < 100 && notifier.waiting(sessionId) === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(notifier.waiting(sessionId)).toBe(1);
  }

  it("ends the open poll of the bridge another claims the session from, and refuses its reports", async () => {
    const pending = poll(first, "wait=25");
    await polling();
    const controller = new AbortController();
    const taking = poll(second, "claim=true&wait=25", controller.signal);
    expect((await pending).body).toEqual({ replaced: true });
    expect((await report(first, atPrompt)).body).toEqual({ replaced: true });
    expect((await poll(first)).body).toEqual({ replaced: true });
    expect((await report(second, atPrompt)).body).toEqual({ replaced: false });
    controller.abort();
    expect((await taking).body).toEqual({ replaced: false });
    // A replaced bridge acts again once it claims the session, which deletes
    // the report of the bridge it took the session from.
    expect((await poll(first, "claim=true&wait=0")).body).toEqual({ replaced: false });
    expect((await report(second, { monitored: false })).body).toEqual({ replaced: true });
    expect(await presence()).not.toHaveProperty("monitor");
    expect((await report(first, atPrompt)).body).toEqual({ replaced: false });
    expect((await presence())?.monitor).toEqual(atPrompt);
  });
});

describe("what the operator sees", () => {
  it("is connection, last check-in and the latest report, on the operator API's session read", async () => {
    await list(monitoringAgentApiVersion);
    await poll(first);
    await report(first, atPrompt);
    const { secret } = await harness.createKey(["sessions:read"]);
    const page = (await harness.operator(secret, "GET", "/sessions")).body as SessionsPage;
    expect(page.agents[0]?.sessions[0]?.presence).toEqual({
      last_seen_at: formatTimestamp(harness.fixture.now),
      quiet: false,
      connected: true,
      monitor: atPrompt,
    });
    harness.fixture.advance(connectedFor + 1);
    expect(await presence()).toEqual({
      last_seen_at: formatTimestamp(harness.fixture.now - connectedFor - 1),
      quiet: false,
      connected: false,
    });
  });

  it("never reaches the agent", async () => {
    await harness.agent(approved, "POST", "/s/builder/main/threads", newThread("r-1"), monitoring);
    await poll(first);
    await report(first, atPrompt);
    const answers: Response[] = [
      await list(monitoringAgentApiVersion),
      await harness.agent(approved, "GET", "/s/builder/main/threads/1", undefined, monitoring),
      await harness.agent(approved, "GET", "/s/builder/main/wait?wait=0", undefined, monitoring),
      await harness.agent(
        approved,
        "POST",
        "/registrations",
        { agent: "builder", session: "main" },
        monitoring,
      ),
      await poll(first),
      await report(first, atPrompt),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(200);
      const text = JSON.stringify(answer.body);
      for (const field of ["presence", "connected", "monitor", "condition", "last_seen_at"]) {
        expect(text).not.toContain(`"${field}"`);
      }
    }
  });
});

describe("stranded", () => {
  async function writtenTo(version: number): Promise<void> {
    await harness.agent(approved, "POST", "/s/builder/main/threads", newThread("r-1"), {
      ...speaking(version),
    });
    await harness.web("POST", "/s/builder/main/threads/1/messages", {
      request_id: "o-1",
      seen_through: 1,
      text: "Over to you.",
    });
  }

  const thread = async () => ((await harness.web("GET", "/threads")).body as ThreadPage).threads[0];

  it("holds the operator's message once the session's bridge is not connected", async () => {
    await writtenTo(monitoringAgentApiVersion);
    await poll(first);
    expect(await thread()).toMatchObject({ stranded: false, presence: { connected: true } });
    harness.fixture.advance(connectedFor + 1);
    expect(await thread()).toMatchObject({
      stranded: true,
      presence: { quiet: false, connected: false },
    });
  });

  it("follows the older rule for a bridge before monitoring, never shown disconnected", async () => {
    await writtenTo(4);
    expect(await thread()).toMatchObject({ stranded: false, presence: { quiet: false } });
    expect((await thread())?.presence).not.toHaveProperty("connected");
    harness.fixture.advance(defaultQuietAfter + hour);
    expect(await thread()).toMatchObject({ stranded: true, presence: { quiet: true } });
  });

  it("follows the older rule for a session pinned back below monitoring after it ran it", async () => {
    await writtenTo(monitoringAgentApiVersion);
    await poll(first);
    await report(first, atPrompt);
    harness.fixture.advance(connectedFor + 1);
    expect((await thread())?.stranded).toBe(true);
    // The operator pins the plugin back; the session restarts on the old bridge.
    await list(monitoringAgentApiVersion - 1);
    expect((await thread())?.stranded).toBe(false);
    expect((await thread())?.presence).not.toHaveProperty("connected");
    expect(await presence()).not.toHaveProperty("monitor");
  });
});

describe("the report", () => {
  it.each([
    ["free text", { monitored: true, profile: "codex", condition: "Do you trust this?", since }],
    [
      "a profile that is no name",
      { monitored: true, profile: "Do it?", condition: "waiting", since },
    ],
    [
      "a stop beside running",
      {
        monitored: true,
        profile: "codex",
        condition: "running",
        since,
        stopped_by: { reason: "error" },
      },
    ],
  ])("refuses %s, keeping the report before it", async (_, body) => {
    await poll(first);
    await report(first, atPrompt);
    const refused = await report(first, body);
    expect(codeOf(refused)).toBe("invalid_input");
    expect((refused.body as ErrorBody).error.field).toBeDefined();
    expect((await presence())?.monitor).toEqual(atPrompt);
  });

  it("refuses a bridge id it cannot read", async () => {
    expect(codeOf(await poll("short"))).toBe("invalid_input");
    expect(codeOf(await report("has spaces in it!", atPrompt))).toBe("invalid_input");
  });

  it("refuses a report without a whole number, and ignores one older than the latest", async () => {
    await poll(first);
    for (const seq of ["", "0", "1.5", "x"]) {
      expect(codeOf(await report(first, atPrompt, seq))).toBe("invalid_input");
    }
    const waiting = { monitored: true, profile: "codex", condition: "waiting", since };
    expect((await report(first, waiting, 2)).body).toEqual({ replaced: false });
    expect((await report(first, atPrompt, 1)).body).toEqual({ replaced: false });
    expect((await presence())?.monitor).toEqual(waiting);
  });
});
