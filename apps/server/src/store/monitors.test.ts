import {
  type MonitorAnswer,
  type MonitorNudgeAnswer,
  type MonitorPollAnswer,
  monitorPollQuery,
  monitorReport,
  sessionsQuery,
  threadFilters,
  threadsQuery,
} from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../errors.ts";
import { archiveThread, markRead } from "./marks.ts";
import { claimNudge, pollMonitor, recordNudgeOutcome, reportMonitor } from "./monitors.ts";
import { connectedFor, seenStep } from "./presence.ts";
import { revokeRegistration } from "./registrations.ts";
import { listSessions } from "./sessions.ts";
import { createStore, defaultQuietAfter, type Store } from "./store.ts";
import { type Agent, Fixture, threadTarget } from "./test-fixture.ts";
import { countThreads, listThreads } from "./thread-lists.ts";

let fixture: Fixture;
let agent: Agent;
// The number of the latest report a test sent, which each report counts up
// from unless the test numbers it.
let sent: number;

beforeEach(() => {
  fixture = new Fixture();
  agent = fixture.registerAgent("builder", "main");
  sent = 0;
});

afterEach(() => {
  fixture.close();
});

const first = "bridge-first-0000";
const second = "bridge-second-000";

function poll(
  bridge: string,
  query: Record<string, string> = {},
  signal?: AbortSignal,
  as: Agent = agent,
  store: Store = fixture.store,
): Promise<MonitorPollAnswer> {
  return pollMonitor(
    store,
    as.identity,
    as.target,
    monitorPollQuery.parse({ bridge, ...query }),
    signal,
  );
}

function report(bridge: string, body: unknown, seq = ++sent, as: Agent = agent): MonitorAnswer {
  return reportMonitor(
    fixture.store,
    as.identity,
    as.target,
    { bridge, seq },
    monitorReport.parse(body),
  );
}

// settled reports whether a promise has settled after pending callbacks run.
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

// The session's presence as the operator's sessions view shows it.
const presence = () =>
  listSessions(fixture.store, fixture.operator, sessionsQuery.parse({})).agents[0]?.sessions[0]
    ?.presence;

// shown is a monitored report as the operator sees it: with whether the
// session can be nudged.
const shown = (sent: Record<string, unknown>) => ({ ...sent, nudge: sent.nudge === true });

// claim claims the nudge due for the session, or with sent reports how the
// nudge claimed ended.
function claim(
  bridge: string,
  sent?: boolean,
  as: Agent = agent,
  store: Store = fixture.store,
): MonitorNudgeAnswer {
  return sent === undefined
    ? claimNudge(store, as.identity, as.target, { bridge })
    : recordNudgeOutcome(store, as.identity, as.target, { bridge }, sent);
}

const since = new Date(Date.UTC(2026, 9, 27, 11, 58)).toISOString();
const hour = 60 * 60 * 1000;
const running = { monitored: true, profile: "claude-code", condition: "running", since };

describe("the background poll", () => {
  it("answers once its wait ends, the bridge still acting for the session", async () => {
    expect(await poll(first, { wait: "0" })).toEqual({ replaced: false, nudge: false });
    const pending = poll(first, { wait: "1" });
    expect(await settled(pending)).toBe(false);
    expect(await pending).toEqual({ replaced: false, nudge: false });
    expect(fixture.store.notifier.waiting(agent.sessionId)).toBe(0);
  });

  it("is not answered by a message on the session's threads, and ends when aborted", async () => {
    fixture.createThread(agent);
    const controller = new AbortController();
    const pending = poll(first, { wait: "20" }, controller.signal);
    fixture.write(fixture.operator, threadTarget(agent, 1), { text: "Over to you." });
    expect(await settled(pending)).toBe(false);
    controller.abort();
    expect(await pending).toEqual({ replaced: false, nudge: false });
    expect(fixture.store.notifier.waiting(agent.sessionId)).toBe(0);
  });

  it("ends the open poll of the bridge another claims the session from, at once", async () => {
    const pending = poll(first, { wait: "20" });
    expect(await settled(pending)).toBe(false);
    const taking = poll(second, { claim: "true", wait: "20" });
    expect(await pending).toEqual({ replaced: true, nudge: false });
    expect(await settled(taking)).toBe(false);
    // The replaced bridge's later polls and reports are refused until it
    // claims the session again.
    expect(await poll(first, { wait: "20" })).toEqual({ replaced: true, nudge: false });
    expect(report(first, { monitored: false })).toEqual({ replaced: true });
    const controller = new AbortController();
    const retaking = poll(first, { claim: "true", wait: "20" }, controller.signal);
    expect(await taking).toEqual({ replaced: true, nudge: false });
    expect(report(first, running)).toEqual({ replaced: false });
    controller.abort();
    expect(await retaking).toEqual({ replaced: false, nudge: false });
  });

  it("never gives the session back to the bridge a claim replaced, at its routine poll", async () => {
    expect(await poll(first, { wait: "0" })).toEqual({ replaced: false, nudge: false });
    expect(await poll(second, { claim: "true", wait: "0" })).toEqual({
      replaced: false,
      nudge: false,
    });
    // The replaced bridge's poll that crossed the claim does not claim, so
    // it learns it is replaced and leaves the session with the claimer.
    expect(await poll(first, { wait: "0" })).toEqual({ replaced: true, nudge: false });
    expect(await poll(second, { wait: "0" })).toEqual({ replaced: false, nudge: false });
    expect(report(first, running)).toEqual({ replaced: true });
    expect(report(second, running)).toEqual({ replaced: false });
  });

  it("leaves the holder as it was when the claim's write fails", async () => {
    expect(await poll(first, { wait: "0" })).toEqual({ replaced: false, nudge: false });
    fixture.db.prepare("ALTER TABLE monitor_reports RENAME TO kept_reports").run();
    await expect(poll(second, { claim: "true", wait: "0" })).rejects.toThrow();
    fixture.db.prepare("ALTER TABLE kept_reports RENAME TO monitor_reports").run();
    expect(await poll(first, { wait: "0" })).toEqual({ replaced: false, nudge: false });
    expect(await poll(second, { wait: "0" })).toEqual({ replaced: true, nudge: false });
  });

  it("forgets the session's bridge once a credential of the session is revoked", async () => {
    const another = fixture.registerAgent("builder", "main");
    expect(await poll(first, { wait: "0" })).toEqual({ replaced: false, nudge: false });
    revokeRegistration(fixture.store, fixture.operator, agent.registrationId);
    // A bridge on the session's other credential takes it without claiming.
    expect(await poll(second, { wait: "0" }, undefined, another)).toEqual({
      replaced: false,
      nudge: false,
    });
    expect(report(second, running, 1, another)).toEqual({ replaced: false });
  });

  it("lets the first bridge to poll act for the session without claiming it", async () => {
    expect(await poll(second, { wait: "0" })).toEqual({ replaced: false, nudge: false });
    expect(await poll(first, { wait: "0" })).toEqual({ replaced: true, nudge: false });
    expect(await poll(second, { claim: "true", wait: "0" })).toEqual({
      replaced: false,
      nudge: false,
    });
  });

  it("keeps each session's bridge apart", async () => {
    const other = fixture.registerAgent("builder", "side");
    expect(await poll(first, { wait: "0" })).toEqual({ replaced: false, nudge: false });
    expect(await poll(second, { wait: "0" }, undefined, other)).toEqual({
      replaced: false,
      nudge: false,
    });
    expect(await poll(first, { wait: "0" })).toEqual({ replaced: false, nudge: false });
  });

  it("ends as unauthenticated when its credential is revoked", async () => {
    const pending = poll(first, { wait: "20" });
    revokeRegistration(fixture.store, fixture.operator, agent.registrationId);
    await expect(pending).rejects.toSatisfy(
      (error) => error instanceof ApiError && error.code === "unauthenticated",
    );
  });

  it("refuses another session as one that does not exist", async () => {
    const other = fixture.registerAgent("reviewer", "main");
    await expect(
      pollMonitor(
        fixture.store,
        agent.identity,
        other.target,
        monitorPollQuery.parse({ bridge: first, wait: "0" }),
      ),
    ).rejects.toSatisfy((error) => error instanceof ApiError && error.code === "not_found");
    expect(() =>
      reportMonitor(
        fixture.store,
        agent.identity,
        other.target,
        { bridge: first, seq: 1 },
        {
          monitored: false,
        },
      ),
    ).toThrow(expect.objectContaining({ code: "not_found" }) as Error);
  });
});

describe("the report", () => {
  it("shows the operator the latest report while the session is connected", () => {
    fixture.connect(agent);
    expect(presence()).toEqual({ quiet: true, connected: true });
    report(first, running);
    expect(presence()?.monitor).toEqual(shown(running));
    const limited = {
      monitored: true,
      profile: "claude-code",
      condition: "at_prompt",
      since,
      stopped_by: { reason: "usage_limit", resets_at: "2026-10-27T15:00:00.000Z" },
    };
    report(first, limited);
    expect(presence()?.monitor).toEqual(shown(limited));
    report(first, { ...limited, stopped_by: { reason: "block" } });
    expect(presence()?.monitor).toEqual(shown({ ...limited, stopped_by: { reason: "block" } }));
    report(first, { monitored: false });
    expect(presence()?.monitor).toEqual({ monitored: false });
  });

  it("is never shown once the bridge is no longer connected, and again once it is", () => {
    fixture.connect(agent);
    report(first, running);
    fixture.advance(connectedFor + 1);
    expect(presence()).toEqual({ quiet: true, connected: false });
    fixture.connect(agent);
    expect(presence()?.monitor).toEqual(shown(running));
  });

  it("is never shown for a session following the older bridges' rule", () => {
    report(first, running);
    fixture.seen(agent, 4);
    expect(presence()).not.toHaveProperty("monitor");
  });

  it("is deleted when another bridge claims the session, and kept from the bridge it replaced", async () => {
    fixture.connect(agent);
    report(first, running);
    expect(await poll(second, { claim: "true", wait: "0" })).toEqual({
      replaced: false,
      nudge: false,
    });
    expect(presence()).toEqual({ quiet: true, connected: true });
    expect(report(first, { monitored: false })).toEqual({ replaced: true });
    expect(presence()).not.toHaveProperty("monitor");
    // The claimer's own reports are numbered from wherever its bridge is.
    expect(report(second, running, 1)).toEqual({ replaced: false });
    expect(presence()?.monitor).toEqual(shown(running));
  });

  it("stays when the bridge that acts for the session claims it again", async () => {
    fixture.connect(agent);
    report(first, running);
    expect(await poll(first, { claim: "true", wait: "0" })).toEqual({
      replaced: false,
      nudge: false,
    });
    expect(presence()?.monitor).toEqual(shown(running));
  });

  it("ignores a report that arrives after a later one from the same bridge", () => {
    fixture.connect(agent);
    const waiting = { ...running, condition: "waiting" };
    expect(report(first, waiting, 2)).toEqual({ replaced: false });
    expect(report(first, running, 1)).toEqual({ replaced: false });
    expect(presence()?.monitor).toEqual(shown(waiting));
    expect(report(first, running, 2)).toEqual({ replaced: false });
    expect(presence()?.monitor).toEqual(shown(waiting));
    expect(report(first, running, 3)).toEqual({ replaced: false });
    expect(presence()?.monitor).toEqual(shown(running));
  });

  it("leaves the holder as it was when the report's write fails", async () => {
    fixture.db.prepare("ALTER TABLE monitor_reports RENAME TO kept_reports").run();
    expect(() => report(first, running)).toThrow();
    fixture.db.prepare("ALTER TABLE kept_reports RENAME TO monitor_reports").run();
    // No bridge acts for the session yet, so another may take it.
    expect(await poll(second, { wait: "0" })).toEqual({ replaced: false, nudge: false });
    expect(report(first, running)).toEqual({ replaced: true });
  });
});

describe("the nudge", () => {
  // The session's agent checked in, and its bridge acts for it and reports
  // it at its prompt, able to be nudged.
  const canBeNudged = { ...running, condition: "at_prompt", nudge: true };

  beforeEach(async () => {
    fixture.seen(agent);
    fixture.connect(agent);
    await poll(first, { claim: "true", wait: "0" });
    report(first, canBeNudged);
    fixture.advance(1);
  });

  const due = async (bridge = first, store?: Store) =>
    (await poll(bridge, { wait: "0" }, undefined, agent, store)).nudge;

  // A poll by a bridge that knows a nudge is due, held for 20 seconds unless
  // the signal ends it.
  const held = (signal?: AbortSignal) => poll(first, { nudge: "true", wait: "20" }, signal);

  // The operator writes to the session, in a thread of its own.
  const written = () => fixture.startThread(agent);

  const lastNudge = () => presence()?.last_nudge;

  // The session's latest nudge, as its row has it.
  const nudgeRow = () =>
    fixture.db
      .prepare("SELECT nudged_at, nudge_sent FROM sessions WHERE id = ?")
      .get(agent.sessionId);

  it("is due once the operator writes after the agent's last check-in, at once", async () => {
    expect(await due()).toBe(false);
    const pending = poll(first, { wait: "20" });
    expect(await settled(pending)).toBe(false);
    written();
    expect(await pending).toEqual({ replaced: false, nudge: true });
  });

  it("is never due for what the agent has read, or wrote itself", async () => {
    fixture.createThread(agent);
    expect(await due()).toBe(false);
    const { number } = written();
    markRead(fixture.store, agent.identity, threadTarget(agent, number), { through: 1 });
    expect(await due()).toBe(false);
  });

  it("is never due for a message written before the agent last checked in", async () => {
    written();
    fixture.advance(seenStep);
    fixture.seen(agent);
    expect(await due()).toBe(false);
  });

  it("holds a poll that knows one is due while it still is, a report leaving it due included", async () => {
    written();
    const controller = new AbortController();
    const pending = held(controller.signal);
    expect(await settled(pending)).toBe(false);
    // A report that leaves it due wakes the poll, which holds on.
    report(first, canBeNudged);
    expect(await settled(pending)).toBe(false);
    controller.abort();
    expect(await pending).toEqual({ replaced: false, nudge: true });
  });

  it.each([
    [
      "checks in",
      () => {
        fixture.advance(seenStep);
        fixture.seen(agent);
      },
    ],
    [
      "reads the thread",
      (number: number) =>
        markRead(fixture.store, agent.identity, threadTarget(agent, number), { through: 1 }),
    ],
  ])("refuses the claim of a bridge still told one is due once the agent %s", async (_, lapse) => {
    const { number } = written();
    const controller = new AbortController();
    const pending = held(controller.signal);
    expect(await settled(pending)).toBe(false);
    lapse(number);
    // Nothing wakes the poll, so its bridge still believes one is due; the
    // claim, which checks again, is what stops it.
    expect(await settled(pending)).toBe(false);
    expect(claim(first)).toEqual({ replaced: false, go: false });
    expect(nudgeRow()).toEqual({ nudged_at: null, nudge_sent: null });
    // Ended, the poll answers what it last found.
    controller.abort();
    expect(await pending).toEqual({ replaced: false, nudge: true });
  });

  it("writes nothing to say whether one is due", async () => {
    written();
    const rows = () => [
      fixture.db.prepare("SELECT * FROM sessions").all(),
      fixture.db.prepare("SELECT * FROM monitor_reports").all(),
    ];
    const before = rows();
    expect(await due()).toBe(true);
    expect(await due()).toBe(true);
    expect(rows()).toEqual(before);
  });

  it("is never due while a usage limit stops the session, until its reset passes", async () => {
    written();
    report(first, { ...canBeNudged, stopped_by: { reason: "usage_limit" } });
    expect(await due()).toBe(false);
    const resetsAt = new Date(fixture.now + hour).toISOString();
    report(first, { ...canBeNudged, stopped_by: { reason: "usage_limit", resets_at: resetsAt } });
    expect(await due()).toBe(false);
    fixture.advance(hour);
    expect(await due()).toBe(true);
    // Another reason the session stopped is no reason to wait.
    report(first, { ...canBeNudged, stopped_by: { reason: "error" } });
    expect(await due()).toBe(true);
  });

  it("is claimed only while it is due, by the bridge that acts for the session", async () => {
    expect(claim(first)).toEqual({ replaced: false, go: false });
    expect(nudgeRow()).toEqual({ nudged_at: null, nudge_sent: null });
    written();
    await poll(second, { claim: "true", wait: "0" });
    report(second, canBeNudged, 1);
    expect(claim(first)).toEqual({ replaced: true, go: false });
    expect(claim(first, true)).toEqual({ replaced: true, go: false });
    expect(nudgeRow()).toEqual({ nudged_at: null, nudge_sent: null });
    expect(claim(second)).toEqual({ replaced: false, go: true });
    expect(nudgeRow()).toEqual({ nudged_at: fixture.now, nudge_sent: null });
    expect(claim(second)).toEqual({ replaced: false, go: false });
  });

  it("is due at most once until the agent checks in, sent or not", async () => {
    written();
    expect(await due()).toBe(true);
    expect(claim(first)).toMatchObject({ go: true });
    expect(await due()).toBe(false);
    claim(first, false);
    // The operator writing again changes nothing until the agent checks in.
    fixture.advance(1);
    written();
    expect(await due()).toBe(false);
    // A check-in stamps at once after a claim, however soon; only what the
    // operator writes after it is due.
    fixture.advance(1);
    fixture.seen(agent);
    expect(await due()).toBe(false);
    fixture.advance(1);
    written();
    expect(await due()).toBe(true);
  });

  it("is due to none once claimed, across a takeover and a server restart, until a check-in", async () => {
    written();
    expect(claim(first)).toMatchObject({ go: true });
    // Another bridge takes over mid-nudge, as a restarted one does.
    expect(await poll(second, { claim: "true", wait: "0" })).toEqual({
      replaced: false,
      nudge: false,
    });
    report(second, canBeNudged, 1);
    expect(await due(second)).toBe(false);
    expect(claim(second)).toEqual({ replaced: false, go: false });
    const restarted = createStore(fixture.db, { clock: () => fixture.now });
    expect(await due(first, restarted)).toBe(false);
    expect(claim(first, undefined, agent, restarted)).toEqual({ replaced: false, go: false });
    fixture.advance(1);
    fixture.seen(agent);
    fixture.advance(1);
    written();
    expect(await due(first, restarted)).toBe(true);
  });

  it("takes a claimed nudge's outcome once, and shows it to the operator", () => {
    written();
    const claimed = fixture.now;
    claim(first);
    // Under way, it shows as sent.
    const shownAt = new Date(claimed).toISOString();
    expect(lastNudge()).toEqual({ at: shownAt, sent: true, answered: false });
    fixture.advance(8_000);
    expect(claim(first, false)).toEqual({ replaced: false, go: false });
    expect(lastNudge()).toEqual({ at: shownAt, sent: false, answered: false });
    // Sending it again, or another, changes nothing.
    expect(claim(first, false)).toEqual({ replaced: false, go: false });
    claim(first, true);
    expect(nudgeRow()).toEqual({ nudged_at: claimed, nudge_sent: 0 });
    // It stays once the bridge is gone, as the session's.
    fixture.advance(connectedFor + 1);
    expect(presence()).toMatchObject({
      connected: false,
      last_nudge: { at: shownAt, sent: false, answered: false },
    });
  });

  it("takes no outcome before any claim", () => {
    expect(claim(first, true)).toEqual({ replaced: false, go: false });
    expect(nudgeRow()).toEqual({ nudged_at: null, nudge_sent: null });
    expect(lastNudge()).toBeUndefined();
  });

  it("shows a claimed nudge unanswered until the agent checks in, during the nudge included", () => {
    written();
    claim(first);
    fixture.advance(2_000);
    // The agent takes its turn and checks in before the bridge reports.
    fixture.seen(agent);
    fixture.advance(3_000);
    claim(first, true);
    expect(lastNudge()).toMatchObject({ sent: true, answered: true });
    fixture.advance(seenStep);
    fixture.seen(agent);
    fixture.advance(1);
    written();
    claim(first);
    fixture.advance(5_000);
    claim(first, true);
    expect(lastNudge()).toMatchObject({ sent: true, answered: false });
    fixture.advance(1_000);
    fixture.seen(agent);
    expect(lastNudge()).toMatchObject({ sent: true, answered: true });
  });

  it.each(["running", "waiting", "permission_prompt", "other_prompt", "unknown"])(
    "is never due while the session's condition is %s, away from its prompt",
    async (condition) => {
      report(first, { ...canBeNudged, condition });
      written();
      expect(await due()).toBe(false);
      expect(claim(first)).toMatchObject({ go: false });
      // Back at its prompt, the same nudge is due.
      report(first, canBeNudged);
      expect(await due()).toBe(true);
    },
  );

  it("is never due for a session that cannot be nudged", async () => {
    written();
    report(first, { ...canBeNudged, nudge: false });
    expect(await due()).toBe(false);
    // As for a bridge older than the nudge, which never says.
    report(first, running);
    expect(await due()).toBe(false);
    report(first, { monitored: false });
    expect(await due()).toBe(false);
  });

  it("wakes the poll once the session reaches its prompt, a nudge due already", async () => {
    report(first, { ...canBeNudged, condition: "running" });
    written();
    const pending = poll(first, { wait: "20" });
    expect(await settled(pending)).toBe(false);
    report(first, { ...canBeNudged, condition: "waiting" });
    expect(await settled(pending)).toBe(false);
    report(first, canBeNudged);
    expect(await pending).toEqual({ replaced: false, nudge: true });
  });

  it("wakes the poll once the session can be nudged, a nudge due already", async () => {
    report(first, { ...canBeNudged, nudge: false });
    written();
    const pending = poll(first, { wait: "20" });
    expect(await settled(pending)).toBe(false);
    report(first, canBeNudged);
    expect(await pending).toEqual({ replaced: false, nudge: true });
  });
});

describe("stranded and ignored, for a session that can be nudged", () => {
  const canBeNudged = { ...running, condition: "at_prompt", nudge: true };
  const quiet = defaultQuietAfter + seenStep + 1;

  beforeEach(async () => {
    fixture.seen(agent);
    fixture.connect(agent);
    await poll(first, { claim: "true", wait: "0" });
    report(first, canBeNudged);
    fixture.advance(1);
    fixture.startThread(agent);
  });

  // thread reads the thread numbered number as the operator's list shows it.
  const thread = (number = 1) => {
    fixture.connect(agent);
    return listThreads(fixture.store, fixture.operator, threadsQuery.parse({})).threads.find(
      (each) => each.number === number,
    );
  };

  // standing says whether the thread numbered number is stranded or ignored,
  // never both, or neither.
  const standing = (number = 1) => {
    const shown = thread(number);
    if (shown?.stranded === true && shown.ignored === true) {
      throw new Error(`thread ${number} is both stranded and ignored`);
    }
    if (shown?.stranded === true) {
      return "stranded";
    }
    return shown?.ignored === true ? "ignored" : "neither";
  };

  // claimed claims the nudge due, and reports its outcome where one is given.
  const claimed = async (sent?: boolean) => {
    expect((await poll(first, { wait: "0" })).nudge).toBe(true);
    expect(claim(first)).toMatchObject({ go: true });
    if (sent !== undefined) {
      claim(first, sent);
    }
  };

  it("is neither for waiting at its prompt or having stopped, until the quiet time passes", () => {
    fixture.report(agent, { state: "stopped", outcome: "completed" });
    expect(standing()).toBe("neither");
    fixture.advance(quiet - 2);
    expect(standing()).toBe("neither");
    // No nudge was tried since the message within the quiet time.
    fixture.advance(2);
    expect(standing()).toBe("stranded");
  });

  it("is ignored, once the quiet time passes after the message, where the agent checked in since without reading it", () => {
    fixture.advance(seenStep);
    fixture.seen(agent);
    // The agent checked in after the message, so no nudge is due for it.
    fixture.advance(quiet - seenStep - 1);
    expect(standing()).toBe("neither");
    fixture.advance(1);
    expect(presence()?.quiet).toBe(false);
    expect(standing()).toBe("ignored");
  });

  it("is stranded once the latest nudge since the message was not sent", async () => {
    await claimed(false);
    expect(standing()).toBe("stranded");
  });

  it.each([
    ["a sent nudge", true],
    ["a claimed nudge whose outcome never came", undefined],
  ])(
    "is stranded once %s goes the quiet time, and ignored once the agent checks in without reading the thread, until it does",
    async (_, sent) => {
      await claimed(sent);
      fixture.advance(quiet - 1);
      expect(standing()).toBe("neither");
      fixture.advance(1);
      expect(standing()).toBe("stranded");
      // Checking in late, without reading the thread, does not bring it.
      fixture.seen(agent);
      expect(standing()).toBe("ignored");
      markRead(fixture.store, agent.identity, threadTarget(agent, 1), { through: 1 });
      expect(standing()).toBe("neither");
    },
  );

  it("is ignored once a sent nudge goes the quiet time, where the agent checked in after it without reading the thread, and is not nudged again", async () => {
    fixture.advance(1);
    await claimed(true);
    fixture.seen(agent);
    expect(presence()?.last_nudge).toMatchObject({ sent: true, answered: true });
    fixture.advance(quiet - 1);
    fixture.seen(agent);
    expect(standing()).toBe("neither");
    fixture.advance(1);
    expect(presence()?.quiet).toBe(false);
    expect(standing()).toBe("ignored");
    expect((await poll(first, { wait: "0" })).nudge).toBe(false);
  });

  it("is stranded, not ignored, where the agent checked in after the message but not since a later nudge", async () => {
    fixture.advance(seenStep);
    fixture.seen(agent);
    fixture.advance(1);
    fixture.startThread(agent);
    await claimed(true);
    fixture.advance(quiet);
    // The agent is not responding to the nudge, which would bring it here too.
    expect(presence()?.last_nudge).toMatchObject({ sent: true, answered: false });
    expect(standing()).toBe("stranded");
    expect(standing(2)).toBe("stranded");
  });

  it("is stranded, not ignored, where the session has no active credential", () => {
    fixture.advance(seenStep);
    fixture.seen(agent);
    fixture.advance(quiet);
    expect(standing()).toBe("ignored");
    revokeRegistration(fixture.store, fixture.operator, agent.registrationId);
    expect(standing()).toBe("stranded");
  });

  // followedUp has the operator write again in the thread, a millisecond on.
  const followedUp = () => {
    fixture.advance(1);
    fixture.write(fixture.operator, threadTarget(agent, 1), { text: "Any news?" });
  };

  it.each([
    [
      "after the agent checked in since a nudge",
      async () => {
        await claimed(true);
        fixture.seen(agent);
      },
    ],
    [
      "after the agent checked in since the message, with no nudge",
      () => {
        fixture.advance(seenStep);
        fixture.seen(agent);
      },
    ],
  ])(
    "is neither, where the operator wrote again %s, until the quiet time passes after that with no nudge, then stranded",
    async (_, checkedIn) => {
      await checkedIn();
      fixture.advance(quiet);
      expect(standing()).toBe("ignored");
      followedUp();
      // A nudge is due for the later message, so it will bring the thread.
      expect(standing()).toBe("neither");
      expect((await poll(first, { wait: "0" })).nudge).toBe(true);
      fixture.advance(quiet - 1);
      expect(standing()).toBe("neither");
      fixture.advance(1);
      // The nudge due never came, which is the nudge failing, not the agent
      // ignoring the thread, though it checked in after the earlier message.
      expect(standing()).toBe("stranded");
    },
  );

  it("is neither, where the operator started another thread after the agent checked in since a nudge, until the quiet time passes after that with no nudge", async () => {
    await claimed(true);
    fixture.seen(agent);
    fixture.advance(quiet);
    expect(standing()).toBe("ignored");
    fixture.advance(1);
    fixture.startThread(agent);
    // The nudge due for the other thread brings the agent to this one too.
    expect(standing()).toBe("neither");
    expect((await poll(first, { wait: "0" })).nudge).toBe(true);
    fixture.advance(quiet - 1);
    expect(standing()).toBe("neither");
    fixture.advance(1);
    // The nudge due for both never came.
    expect(standing()).toBe("stranded");
    expect(standing(2)).toBe("stranded");
  });

  it("is stranded, never ignored, where the agent passed a message over and a nudge due for a later one goes the quiet time unclaimed", async () => {
    fixture.advance(seenStep);
    fixture.seen(agent);
    followedUp();
    expect((await poll(first, { wait: "0" })).nudge).toBe(true);
    for (const step of [quiet - 1, 1, quiet]) {
      fixture.advance(step);
      expect(standing()).not.toBe("ignored");
    }
    expect(standing()).toBe("stranded");
  });

  it("is ignored once the agent archives the operator's later message without reading the thread", async () => {
    await claimed(true);
    fixture.seen(agent);
    fixture.advance(quiet);
    followedUp();
    expect(standing()).toBe("neither");
    const target = threadTarget(agent, 1);
    archiveThread(fixture.store, agent.identity, target, { through: fixture.lastSeq(target) });
    // No nudge is due for an archived message, so nothing will bring it.
    expect((await poll(first, { wait: "0" })).nudge).toBe(false);
    expect(standing()).toBe("ignored");
  });

  it("is ignored where the agent archived it without reading it, though a nudge is due for another thread", async () => {
    await claimed(true);
    fixture.seen(agent);
    fixture.advance(quiet);
    followedUp();
    const target = threadTarget(agent, 1);
    archiveThread(fixture.store, agent.identity, target, { through: fixture.lastSeq(target) });
    fixture.seen(agent);
    fixture.advance(1);
    fixture.startThread(agent);
    expect((await poll(first, { wait: "0" })).nudge).toBe(true);
    // The nudge brings the agent to the other thread, never to an archived one.
    expect(standing()).toBe("ignored");
    expect(standing(2)).toBe("neither");
  });

  it("is neither where the agent read the thread after the nudge, however long since", async () => {
    await claimed(true);
    fixture.seen(agent);
    markRead(fixture.store, agent.identity, threadTarget(agent, 1), { through: 1 });
    fixture.advance(quiet);
    expect(standing()).toBe("neither");
  });

  it("lists and counts the ignored threads apart from the stranded ones", async () => {
    await claimed(true);
    fixture.seen(agent);
    // The agent archives the first thread unread, so the nudge due for the
    // second never brings it there.
    const target = threadTarget(agent, 1);
    archiveThread(fixture.store, agent.identity, target, { through: fixture.lastSeq(target) });
    fixture.advance(1);
    fixture.startThread(agent);
    fixture.advance(quiet);
    expect([standing(1), standing(2)]).toEqual(["ignored", "stranded"]);
    const listed = (agent_read: string) =>
      listThreads(fixture.store, fixture.operator, threadsQuery.parse({ agent_read })).threads.map(
        (each) => each.number,
      );
    expect(listed("ignored")).toEqual([1]);
    expect(listed("stranded")).toEqual([2]);
    expect(listed("unread").sort()).toEqual([1, 2]);
    const counts = countThreads(fixture.store, fixture.operator, threadFilters.parse({}));
    expect(counts.agent_read).toEqual({ any: 2, unread: 2, stranded: 1, ignored: 1 });
    const session = listSessions(fixture.store, fixture.operator, sessionsQuery.parse({})).agents[0]
      ?.sessions[0];
    expect(session?.threads).toEqual({ total: 2, unread: 0, stranded: 1, ignored: 1 });
  });

  it("follows the rule of a session that cannot be nudged once its bridge says so, never ignored", () => {
    fixture.advance(seenStep);
    fixture.seen(agent);
    report(first, { ...canBeNudged, nudge: false });
    fixture.advance(quiet);
    fixture.seen(agent);
    expect(standing()).toBe("neither");
    fixture.report(agent, { state: "stopped", outcome: "completed" });
    expect(standing()).toBe("stranded");
  });

  it("is stranded while its bridge is not connected, whatever it last said", () => {
    fixture.advance(seenStep);
    fixture.seen(agent);
    fixture.advance(connectedFor + 1);
    const thread = listThreads(fixture.store, fixture.operator, threadsQuery.parse({})).threads[0];
    expect(thread).toMatchObject({ stranded: true, ignored: false });
  });
});
