import {
  agentApi,
  agentApiHeader,
  type ErrorBody,
  formatTimestamp,
  monitoringAgentApiVersion,
  nudgeAgentApiVersion,
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

// The report as the operator sees it, from a bridge that does not say whether
// the session can be nudged.
const shownAtPrompt = { ...atPrompt, nudge: false };

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
    expect((await presence())?.monitor).toEqual(shownAtPrompt);
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
      monitor: shownAtPrompt,
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

describe("the nudge", () => {
  const nudging = speaking(agentApi.version);
  const { stopped_by: _, ...unlimited } = atPrompt;
  const canBeNudged = { ...unlimited, nudge: true };

  const nudgePoll = (query = "wait=0") =>
    harness.agent(
      approved,
      "GET",
      `/s/builder/main/monitor?bridge=${first}&${query}`,
      undefined,
      nudging,
    );
  const nudgeReport = (body: unknown) =>
    harness.agent(
      approved,
      "POST",
      `/s/builder/main/monitor?bridge=${first}&seq=${++sent}`,
      body,
      nudging,
    );
  // The id of the attempts the tests claim.
  const id = "0123456789ab";
  const start = { phase: "start", id };
  const done = (outcome: string) => ({ phase: "done", id, outcome });

  const nudgeClaim = (body: unknown, bridge = first) =>
    harness.agent(
      approved,
      "POST",
      `/s/builder/main/monitor/nudge?bridge=${bridge}`,
      body,
      nudging,
    );

  // The agent checks in and starts a thread; its bridge reports that the
  // session can be nudged; and the operator writes to it.
  beforeEach(async () => {
    await harness.agent(approved, "POST", "/s/builder/main/threads", newThread("r-1"), nudging);
    await nudgePoll();
    await nudgeReport(canBeNudged);
    harness.fixture.advance(1);
    await harness.web("POST", "/s/builder/main/threads/1/messages", {
      request_id: "o-1",
      seen_through: 1,
      text: "Over to you.",
    });
  });

  it("is left out of the poll's answer to a version before it", async () => {
    const before = await harness.agent(
      approved,
      "GET",
      `/s/builder/main/monitor?bridge=${first}&wait=0`,
      undefined,
      speaking(nudgeAgentApiVersion - 1),
    );
    expect(before.body).toEqual({ replaced: false });
    expect((await nudgePoll()).body).toEqual({ replaced: false, nudge: true });
  });

  it("is due to the bridge, which claims it and reports the outcome the operator then sees", async () => {
    expect((await nudgePoll()).body).toEqual({ replaced: false, nudge: true });
    // A poll that knows it is due waits while it still is.
    expect((await nudgePoll("nudge=true&wait=0")).body).toEqual({ replaced: false, nudge: true });
    const claimed = harness.fixture.now;
    expect((await nudgeClaim(start)).body).toEqual({ replaced: false, go: true });
    expect((await nudgePoll()).body).toEqual({ replaced: false, nudge: false });
    harness.fixture.advance(6_000);
    expect((await nudgeClaim(done("sent"))).body).toEqual({
      replaced: false,
      go: false,
    });
    const { secret } = await harness.createKey(["sessions:read", "threads:read"]);
    const page = (await harness.operator(secret, "GET", "/sessions")).body as SessionsPage;
    const shown = { at: formatTimestamp(claimed), id, outcome: "sent", answered: false };
    expect(page.agents[0]?.sessions[0]?.presence).toMatchObject({
      monitor: canBeNudged,
      last_nudge: shown,
    });
    const listed = (await harness.operator(secret, "GET", "/threads")).body as ThreadPage;
    expect(listed.threads[0]?.presence?.last_nudge).toEqual(shown);
    // The agent's reply to it shows at once, whatever the minute.
    await list(agentApi.version);
    expect((await presence())?.last_nudge).toMatchObject({ answered: true });
  });

  it("is due again once an attempt is deferred, the latest nudge left as it was", async () => {
    expect((await nudgeClaim(start)).body).toEqual({ replaced: false, go: true });
    expect((await nudgePoll()).body).toEqual({ replaced: false, nudge: false });
    expect((await nudgeClaim(done("deferred"))).body).toEqual({ replaced: false, go: false });
    expect((await nudgePoll()).body).toEqual({ replaced: false, nudge: true });
    expect(await presence()).not.toHaveProperty("last_nudge");
  });

  it("shows the operator why the session cannot be nudged, with since when, on its session reads", async () => {
    const unable = { reason: "nudge_text_left", since: canBeNudged.since };
    await nudgeReport({ ...canBeNudged, unable });
    const { secret } = await harness.createKey(["sessions:read", "threads:read"]);
    const page = (await harness.operator(secret, "GET", "/sessions")).body as SessionsPage;
    expect(page.agents[0]?.sessions[0]?.presence?.monitor).toEqual({ ...canBeNudged, unable });
    const listed = (await harness.operator(secret, "GET", "/threads")).body as ThreadPage;
    expect(listed.threads[0]?.presence?.monitor).toEqual({ ...canBeNudged, unable });
  });

  it("leaves the thread ignored once the agent checks in after it without reading it, until it does", async () => {
    const { secret } = await harness.createKey(["threads:read"]);
    await nudgeClaim(start);
    await nudgeClaim(done("sent"));
    // The agent checks in in answer, without reading the thread.
    await list(agentApi.version);
    harness.fixture.advance(defaultQuietAfter + hour);
    await nudgePoll();
    const listed = async (query: string) =>
      ((await harness.operator(secret, "GET", `/threads${query}`)).body as ThreadPage).threads;
    const ignored = await listed("?agent_read=ignored");
    expect(ignored.map((thread) => thread.number)).toEqual([1]);
    expect(ignored[0]).toMatchObject({ ignored: true, stranded: false });
    expect(await listed("?agent_read=stranded")).toEqual([]);
    await harness.agent(
      approved,
      "POST",
      "/s/builder/main/threads/1/read",
      { through: 2 },
      nudging,
    );
    await nudgePoll();
    expect((await listed(""))[0]).toMatchObject({ ignored: false, stranded: false });
    expect(await listed("?agent_read=ignored")).toEqual([]);
  });

  it("is claimed as a background request, never a check-in", async () => {
    const before = stamps();
    harness.fixture.advance(1_000);
    await nudgeClaim(start);
    expect(stamps()).toEqual({ ...before, background_at: harness.fixture.now });
  });

  it("is refused to a replaced bridge, and a claim or outcome it cannot read", async () => {
    await harness.agent(
      approved,
      "GET",
      `/s/builder/main/monitor?bridge=${second}&claim=true&wait=0`,
      undefined,
      nudging,
    );
    expect((await nudgeClaim(start)).body).toEqual({ replaced: true, go: false });
    for (const body of [
      {},
      { phase: "later", id },
      { phase: "start" },
      { phase: "done", id },
      { phase: "done", id, sent: true },
    ]) {
      expect(codeOf(await nudgeClaim(body, second))).toBe("invalid_input");
    }
    expect(codeOf(await nudgeClaim(start, "short"))).toBe("invalid_input");
    expect(await presence()).not.toHaveProperty("last_nudge");
  });

  it("never reaches the agent, but for the due answer and the claim's own", async () => {
    await nudgeClaim(start);
    await nudgeClaim(done("failed"));
    const answers: Response[] = [
      await list(agentApi.version),
      await harness.agent(approved, "GET", "/s/builder/main/threads/1", undefined, nudging),
      await harness.agent(approved, "GET", "/s/builder/main/wait?wait=0", undefined, nudging),
      await harness.agent(
        approved,
        "POST",
        "/registrations",
        { agent: "builder", session: "main" },
        nudging,
      ),
      await nudgeReport({
        ...canBeNudged,
        unable: { reason: "nudge_text_left", since: canBeNudged.since },
      }),
    ];
    for (const answer of answers) {
      expect(answer.status).toBe(200);
      const text = JSON.stringify(answer.body);
      for (const field of [
        "presence",
        "nudge",
        "last_nudge",
        "answered",
        "outcome",
        "unable",
        "stranded",
      ]) {
        expect(text).not.toContain(`"${field}"`);
      }
    }
    expect(Object.keys((await nudgePoll()).body as object).sort()).toEqual(["nudge", "replaced"]);
    expect(Object.keys((await nudgeClaim(start)).body as object).sort()).toEqual([
      "go",
      "replaced",
    ]);
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

  it("carries the latest report on the thread's presence while the bridge is connected", async () => {
    await writtenTo(monitoringAgentApiVersion);
    await poll(first);
    await report(first, atPrompt);
    await harness.agent(
      approved,
      "POST",
      "/s/builder/main/status",
      { state: "stopped", outcome: "stalled" },
      monitoring,
    );
    expect(await thread()).toMatchObject({
      stranded: true,
      presence: { connected: true, state: "stopped", monitor: shownAtPrompt },
    });
    // The operator API's thread reads carry it too.
    const { secret } = await harness.createKey(["threads:read"]);
    const listed = (await harness.operator(secret, "GET", "/threads")).body as ThreadPage;
    expect(listed.threads[0]?.presence?.monitor).toEqual(shownAtPrompt);
    harness.fixture.advance(connectedFor + 1);
    expect(await thread()).toMatchObject({ stranded: true, presence: { connected: false } });
    expect((await thread())?.presence).not.toHaveProperty("monitor");
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
    expect((await presence())?.monitor).toEqual(shownAtPrompt);
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
    expect((await presence())?.monitor).toEqual({ ...waiting, nudge: false });
  });
});
