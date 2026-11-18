import { afterEach, beforeEach, expect, it } from "vitest";
import { ApiError } from "../errors.ts";
import type { Identity } from "../identity.ts";
import { archiveThread } from "./marks.ts";
import { type Agent, Fixture, threadTarget } from "./test-fixture.ts";

let fixture: Fixture;

beforeEach(() => {
  fixture = new Fixture();
});

afterEach(() => {
  fixture.close();
});

// A small deterministic generator, so a failure reproduces.
function generator(seed: number) {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2 ** 31;
    return state / 2 ** 31;
  };
  return {
    pick<T>(values: readonly T[]): T {
      return values[Math.floor(next() * values.length)] as T;
    },
    chance(probability: number): boolean {
      return next() < probability;
    },
  };
}

interface Logged {
  seq: number;
  actor: number;
  replaces: number | null;
  topic: string | null;
  // The numbers of the asks the message carries, of those it answers and of
  // those it withdraws.
  asks: number[];
  answers: number[];
  withdrawals: number[];
}

type Entry = Pick<Logged, "seq" | "actor" | "replaces">;

// liveOf keeps the messages of a log that no message in it replaces.
function liveOf<T extends Entry>(log: T[]): T[] {
  const replaced = new Set(log.flatMap((m) => (m.replaces === null ? [] : [m.replaces])));
  return log.filter((m) => !replaced.has(m.seq));
}

// archivedIn says whether a thread is archived for an actor whose archive
// mark is at mark, as no live message by another actor following it. The
// store asks instead that the mark reach the latest message; archiving
// carried on over the actor's own replies and writing moving the mark make
// the two agree, which the fold checks.
function archivedIn(log: Entry[], actor: number, mark: number): boolean {
  return mark > 0 && !liveOf(log).some((m) => m.actor !== actor && m.seq > mark);
}

// fold derives a thread's state from its log the obvious way, message by
// message, as the views must, for a viewer with the given marks. Its status
// rolls up the asks on live messages and those a live message withdraws:
// open while any is open; otherwise withdrawn when every one is withdrawn,
// naming the latest such withdrawal, and answered when there are any; none
// when there are none.
function fold(log: Logged[], viewer: number, marks: { read: number; archived: number }) {
  const live = liveOf(log);
  const isLive = (seq: number) => live.some((m) => m.seq === seq);
  const answerOf = new Map(live.flatMap((m) => m.answers.map((ask) => [ask, m.seq] as const)));
  const withdrawalOf = new Map(
    live.flatMap((m) => m.withdrawals.map((ask) => [ask, m.seq] as const)),
  );
  const asks = log.flatMap((m) => m.asks.map((number) => ({ number, live: isLive(m.seq) })));
  const open = asks.filter((a) => a.live && !answerOf.has(a.number) && !withdrawalOf.has(a.number));
  const rolled = asks.filter((a) => a.live || withdrawalOf.has(a.number));
  const withdrawn = rolled.length > 0 && rolled.every((a) => withdrawalOf.has(a.number));
  // The latest live withdrawal, the first of its message's.
  const latest = rolled
    .map((a) => ({ ask: a.number, seq: withdrawalOf.get(a.number) ?? 0 }))
    .sort((a, b) => b.seq - a.seq || a.ask - b.ask)
    .at(0);
  return {
    live: log.map((m) => isLive(m.seq)),
    open: open.map((a) => a.number),
    answers: asks.map((a) => answerOf.get(a.number)),
    withdrawals: asks.map((a) => withdrawalOf.get(a.number)),
    status:
      open.length > 0
        ? "open"
        : rolled.length === 0
          ? "none"
          : withdrawn
            ? "withdrawn"
            : "answered",
    withdrawal: withdrawn ? latest : undefined,
    topic: live.findLast((m) => m.topic !== null)?.topic ?? undefined,
    // An archived message is never unread.
    unread: live.filter((m) => m.actor !== viewer && m.seq > Math.max(marks.read, marks.archived))
      .length,
    // Every live message counts, either party's, archived or not.
    message_count: live.length,
    archived: archivedIn(log, viewer, marks.archived),
  };
}

it("derives what a fold over each thread's log derives", () => {
  const random = generator(20261031);
  const agents: Agent[] = [
    fixture.registerAgent("builder", "main"),
    fixture.registerAgent("builder", "side"),
  ];
  const ask = { question: "q", suggestions: [{ label: "a" }, { label: "b" }], multiple: true };
  const someAsks = () =>
    random.chance(0.6) ? [ask] : random.chance(0.5) ? [ask, ask] : [ask, ask, ask];
  // Each actor's archive mark on each thread, as archiving and writing move
  // it: a write keeps a thread archived for its writer by moving the mark to
  // the writer's own message.
  const archiveMarks = new Map<string, number>();
  const markKey = (threadId: number, actor: number) => `${threadId}:${actor}`;
  const rawLog = (threadId: number) =>
    fixture.db
      .prepare(
        `SELECT seq, actor_id AS actor, replaces_seq AS replaces FROM messages
         WHERE thread_id = ? ORDER BY seq`,
      )
      .all(threadId) as unknown as Entry[];
  let landed = 0;
  let archived = 0;
  let keptByWriting = 0;
  for (let step = 0; step < 600; step++) {
    const agent = random.pick(agents);
    const count = (
      fixture.db
        .prepare("SELECT count(*) AS n FROM threads WHERE session_id = ?")
        .get(agent.sessionId) as { n: number }
    ).n;
    if (count === 0 || random.chance(0.05)) {
      fixture.startThread(agent, random.chance(0.5) ? { asks: someAsks(), topic: "start" } : {});
      continue;
    }
    const target = threadTarget(agent, 1 + Math.floor(random.pick([0, 0.3, 0.6, 0.9]) * count));
    const operator = random.chance(0.5);
    const identity: Identity = operator ? fixture.operator : agent.identity;
    const last = fixture.lastSeq(target);
    const { id: threadId } = fixture.db
      .prepare("SELECT id FROM threads WHERE session_id = ? AND number = ?")
      .get(agent.sessionId, target.thread) as { id: number };
    const key = markKey(threadId, identity.actor);
    if (random.chance(0.1)) {
      const through = 1 + Math.floor(random.pick([0.5, 0.9, 0.99]) * last);
      try {
        archiveThread(fixture.store, identity, target, { through });
        // The mark carries on over the actor's own messages right after it.
        const log = rawLog(threadId);
        const next = log.find((m) => m.seq > through && m.actor !== identity.actor);
        const carried = next === undefined ? log.length : next.seq - 1;
        archiveMarks.set(key, Math.max(archiveMarks.get(key) ?? 0, carried));
        archived++;
      } catch (error) {
        if (!(error instanceof ApiError) || error.code !== "invalid_input") {
          throw error;
        }
      }
      continue;
    }
    const thread = `JOIN threads t ON t.id = m.thread_id WHERE t.session_id = ? AND t.number = ?`;
    const numbers = (sql: string, column: string, ...more: unknown[]) =>
      (
        fixture.db
          .prepare(`SELECT m.${column} AS value FROM ${sql}`)
          .all(agent.sessionId, target.thread, ...(more as number[])) as { value: number }[]
      ).map((row) => row.value);
    const highestAsk = Math.max(0, ...numbers(`asks m ${thread}`, "number"));
    // Mostly what the write may name, sometimes anything, which may be refused.
    const one = (candidates: number[], bound: number) =>
      candidates.length > 0 && random.chance(0.8)
        ? random.pick(candidates)
        : 1 + Math.floor(random.pick([0, 0.25, 0.5, 0.75, 0.99]) * Math.max(bound, 1));
    const fields: Record<string, unknown> = {};
    if (random.chance(0.4)) fields.text = `note ${step}`;
    if (!operator && random.chance(0.4)) fields.asks = someAsks();
    if (!operator && random.chance(0.2)) fields.topic = random.pick(["auth", "billing"]);
    // The agent's withdrawing messages are replaced often enough to show that
    // their withdrawals hold.
    const mine = numbers(`live_messages m ${thread} AND m.actor_id = ?`, "seq", identity.actor);
    const withdrawing = numbers(
      `live_messages m ${thread} AND m.actor_id = ? AND EXISTS (
         SELECT 1 FROM withdrawals w WHERE w.thread_id = m.thread_id AND w.seq = m.seq)`,
      "seq",
      identity.actor,
    );
    const replaces = random.chance(0.3)
      ? one(withdrawing.length > 0 && random.chance(0.4) ? withdrawing : mine, last)
      : undefined;
    if (!operator) {
      // A replacement of an asking message mostly withdraws some of the open
      // asks it holds by name and asks the rest again, and one of a
      // withdrawing message mostly withdraws again what it withdrew; the agent
      // withdraws open asks now and then.
      const stillOpen =
        replaces === undefined
          ? []
          : numbers(`open_asks m ${thread} AND m.seq = ?`, "number", replaces);
      const byName = stillOpen.filter(() => random.chance(0.3));
      if (stillOpen.length > 0 && random.chance(0.8)) {
        const asked = stillOpen.length - byName.length + (random.chance(0.3) ? 1 : 0);
        if (asked > 0) {
          fields.asks = Array(asked).fill(ask);
        } else {
          delete fields.asks;
        }
      }
      const again =
        replaces !== undefined && random.chance(0.8)
          ? numbers(`withdrawals m ${thread} AND m.seq = ?`, "ask", replaces)
          : [];
      const open = numbers(`open_asks m ${thread}`, "number");
      const fresh = random.chance(0.25) ? [one(open, highestAsk)] : [];
      const withdrawn = [...new Set([...again, ...byName, ...fresh])];
      if (withdrawn.length > 0) {
        fields.withdrawals = withdrawn.map((number) => ({ ask: number, reason: `why ${step}` }));
      }
    }
    if (operator) {
      // A replacement answers again what its message answered, most of the time.
      const again =
        replaces !== undefined && random.chance(0.8)
          ? numbers(`answers m ${thread} AND m.seq = ?`, "ask", replaces)
          : [];
      const open = numbers(`open_asks m ${thread}`, "number");
      const fresh = random.chance(0.5) ? [one(open, highestAsk)] : [];
      if (random.chance(0.3)) fresh.push(one(open, highestAsk));
      const answered = [...new Set([...again, ...fresh])];
      if (answered.length > 0) {
        fields.answers = answered.map((number) =>
          random.pick([
            { ask: number, declined: true },
            { ask: number, picks: [1, 0] },
            { ask: number, picks: [1], text: "And more." },
          ]),
        );
      }
    }
    if (replaces !== undefined) fields.replaces = replaces;
    if (Object.keys(fields).length === 0) fields.text = `note ${step}`;
    // A write keeps a thread archived for its writer while the writer's mark
    // reaches its latest message.
    const mark = archiveMarks.get(key) ?? 0;
    const keptArchived = mark > 0 && mark === last;
    try {
      const { seq } = fixture.write(identity, target, fields);
      if (keptArchived) {
        archiveMarks.set(key, seq);
        keptByWriting++;
      }
      landed++;
    } catch (error) {
      if (!(error instanceof ApiError) || !["invalid_input", "not_allowed"].includes(error.code)) {
        throw error;
      }
    }
  }
  expect(landed).toBeGreaterThan(200);
  expect(archived).toBeGreaterThan(20);

  const threads = fixture.db
    .prepare(
      `SELECT t.id, t.number, s.name AS session FROM threads t
       JOIN sessions s ON s.id = t.session_id`,
    )
    .all() as { id: number; number: number; session: string }[];
  let replacements = 0;
  let answers = 0;
  let changed = 0;
  let withdrawals = 0;
  let withdrawnAgain = 0;
  let withdrawnByReplacement = 0;
  const statuses = new Set<string>();
  for (const { id, number, session } of threads) {
    const agent = agents.find((a) => a.target.session === session) as Agent;
    const column = (table: string, value: string, seq: number) =>
      (
        fixture.db
          .prepare(
            `SELECT ${value} AS value FROM ${table} WHERE thread_id = ? AND seq = ? ORDER BY 1`,
          )
          .all(id, seq) as { value: number }[]
      ).map((row) => row.value);
    const log: Logged[] = (
      fixture.db
        .prepare(
          `SELECT seq, actor_id AS actor, replaces_seq AS replaces, topic
           FROM messages WHERE thread_id = ? ORDER BY seq`,
        )
        .all(id) as unknown as Omit<Logged, "asks" | "answers" | "withdrawals">[]
    ).map((m) => ({
      ...m,
      asks: column("asks", "number", m.seq),
      answers: column("answers", "ask", m.seq),
      withdrawals: column("withdrawals", "ask", m.seq),
    }));
    replacements += log.filter((m) => m.replaces !== null).length;
    answers += log.filter((m) => m.answers.length > 0).length;
    changed += log.filter(
      (m) => m.replaces !== null && m.answers.length > 0 && log[m.replaces - 1]?.answers.length,
    ).length;
    withdrawals += log.filter((m) => m.withdrawals.length > 0).length;
    withdrawnAgain += log.filter(
      (m) => m.replaces !== null && log[m.replaces - 1]?.withdrawals.length,
    ).length;
    withdrawnByReplacement += log.filter(
      (m) =>
        m.replaces !== null &&
        m.withdrawals.some((ask) => log[(m.replaces ?? 0) - 1]?.asks.includes(ask)),
    ).length;
    // The thread's latest sequence is its log's.
    expect(fixture.lastSeq(threadTarget(agent, number))).toBe(log.length);
    for (const identity of [fixture.operator, agent.identity]) {
      const { thread, messages, marks } = fixture.thread(identity, threadTarget(agent, number));
      expect(messages).toHaveLength(log.length);
      const mark = archiveMarks.get(markKey(id, identity.actor)) ?? 0;
      expect(marks.archived_through).toBe(mark);
      const expected = fold(log, identity.actor, {
        read: marks.read_through,
        archived: mark,
      });
      const asks = messages.flatMap((m) => m.asks ?? []);
      expect({
        live: messages.map((m) => m.live),
        open: asks.filter((a) => a.open).map((a) => a.number),
        answers: asks.map((a) => a.answer?.seq),
        withdrawals: asks.map((a) => a.withdrawal?.seq),
        status: thread.status,
        withdrawal:
          thread.withdrawal === undefined
            ? undefined
            : { ask: thread.withdrawal.ask, seq: thread.withdrawal.seq },
        topic: thread.topic,
        unread: thread.unread,
        message_count: thread.message_count,
        archived: thread.archived,
      }).toEqual(expected);
      expect(thread.open_asks.asks.map((a) => a.number).sort((a, b) => a - b)).toEqual(
        expected.open,
      );
      statuses.add(thread.status);
    }
  }
  // Each session's latest position counts its messages, which hold the
  // positions from 1 on, each once.
  for (const agent of agents) {
    const positions = (
      fixture.db
        .prepare("SELECT session_pos AS pos FROM messages WHERE session_id = ? ORDER BY 1")
        .all(agent.sessionId) as { pos: number }[]
    ).map((row) => row.pos);
    const { last_pos: lastPos } = fixture.db
      .prepare("SELECT last_pos FROM sessions WHERE id = ?")
      .get(agent.sessionId) as { last_pos: number };
    expect(positions).toEqual(Array.from({ length: lastPos }, (_, index) => index + 1));
  }
  expect(keptByWriting).toBeGreaterThan(5);
  expect(replacements).toBeGreaterThan(20);
  expect(answers).toBeGreaterThan(20);
  expect(changed).toBeGreaterThan(5);
  expect(withdrawals).toBeGreaterThan(20);
  expect(withdrawnAgain).toBeGreaterThan(3);
  expect(withdrawnByReplacement).toBeGreaterThan(3);
  expect([...statuses].sort()).toEqual(["answered", "none", "open", "withdrawn"]);
});
