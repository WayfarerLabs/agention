import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { issuePasskeyLink } from "../auth/passkey-links.ts";
import { createGroup, type Store } from "../store/index.ts";
import { Fixture, testOrigin } from "../store/test-fixture.ts";
import type { SinkKind } from "./actions.ts";
import {
  batchQuery,
  cursorsOf,
  forgetSink,
  nextOpenEnd,
  openCursor,
  openEndQuery,
} from "./cursors.ts";
import { AuditDispatcher, type Sink } from "./dispatcher.ts";
import { recordFailure } from "./record.ts";
import { pruneAuditEvents } from "./retention.ts";
import { eventsAfter, lastSeq } from "./test-events.ts";
import type { AuditRecord } from "./cursors.ts";

let fixture: Fixture;
let logged: string[];
const dispatchers: AuditDispatcher[] = [];

beforeEach(() => {
  fixture = new Fixture();
  logged = [];
});

afterEach(async () => {
  for (const dispatcher of dispatchers.splice(0)) {
    await dispatcher.stop();
  }
  fixture.close();
});

// A sink that keeps what it receives, answering each batch as told: delivered
// whole, by default, or failed by throwing.
class FakeSink implements Sink {
  readonly kind: SinkKind;
  readonly received: AuditRecord[] = [];
  answer: (batch: readonly AuditRecord[]) => void | Promise<void> = () => undefined;
  closed = false;

  constructor(kind: SinkKind = "file") {
    this.kind = kind;
  }

  async deliver(batch: readonly AuditRecord[]): Promise<void> {
    await this.answer(batch);
    this.received.push(...batch);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function start(store: Store, sinks: Sink[], options: { pollInterval?: number } = {}) {
  const dispatcher = new AuditDispatcher(store, sinks, {
    log: (message) => logged.push(message),
    pollInterval: options.pollInterval ?? 60_000,
    retryInterval: 5,
    checkInterval: 5,
    shutdownGrace: 50,
  });
  dispatcher.start();
  dispatchers.push(dispatcher);
  return dispatcher;
}

// until waits for a condition the dispatcher's loops bring about.
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !condition(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(condition()).toBe(true);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

let groups = 0;
const record = () => createGroup(fixture.store, fixture.operator, { name: `g${(groups += 1)}` });
const seqs = (sink: FakeSink) => sink.received.map((each) => each.seq);
const cursor = (kind: SinkKind) => cursorsOf(fixture.store).find((each) => each.kind === kind);
const failure = { action: "signIn" } as const;

describe("the dispatcher", () => {
  it("delivers every event retained to a new sink, then each new one as it is recorded", async () => {
    record();
    record();
    const sink = new FakeSink();
    start(fixture.store, [sink]);
    await until(() => sink.received.length === 2);
    record();
    await until(() => sink.received.length === 3);
    expect(seqs(sink)).toEqual([1, 2, 3]);
    expect(cursor("file")?.delivered).toBe(3);
    expect(JSON.parse(sink.received[2]?.json ?? "{}")).toMatchObject({ metadata: { sequence: 3 } });
  });

  it("starts a new sink at the oldest event retained, or the latest taken when none is", async () => {
    record();
    record();
    fixture.advance(400 * 24 * 60 * 60_000);
    expect(await pruneAuditEvents(fixture.store, 365)).toBe(2);
    expect(openCursor(fixture.store, "stdout")).toBe(2);
    // The browser session has long expired; the command line records still.
    issuePasskeyLink(fixture.store, "operator");
    expect(openCursor(fixture.store, "file")).toBe(2);
  });

  it("sends a failed batch again, and resumes from its cursor after a restart", async () => {
    record();
    record();
    const sink = new FakeSink();
    let failing = true;
    sink.answer = () => {
      if (failing) {
        failing = false;
        throw new Error("EIO");
      }
    };
    const first = start(fixture.store, [sink]);
    await until(() => sink.received.length === 2);
    await first.stop();
    expect(sink.closed).toBe(false);
    record();
    const again = new FakeSink();
    start(fixture.store, [again]);
    await until(() => again.received.length === 1);
    expect([seqs(sink), seqs(again)]).toEqual([[1, 2], [3]]);
  });

  it("says when a sink starts failing, every report interval while it fails, and when it recovers", async () => {
    record();
    const sink = new FakeSink();
    let failing = true;
    sink.answer = () => {
      if (failing) {
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      }
    };
    start(fixture.store, [sink]);
    await until(() => logged.length === 1);
    // Retries go on, saying nothing more until the interval has passed.
    await settle();
    expect(logged).toHaveLength(1);
    fixture.advance(15 * 60_000);
    await until(() => logged.length === 2);
    failing = false;
    await until(() => logged.length === 3);
    expect(seqs(sink)).toEqual([1]);
  });

  it("holds an open failure, and the events after it, until its minute ends", async () => {
    fixture.now = Math.floor(fixture.now / 60_000) * 60_000;
    record();
    recordFailure(fixture.store, { kind: "none", origin: testOrigin }, failure);
    record();
    const sink = new FakeSink();
    start(fixture.store, [sink], { pollInterval: 10 });
    await until(() => sink.received.length === 1);
    recordFailure(fixture.store, { kind: "none", origin: testOrigin }, failure);
    await settle();
    expect(seqs(sink)).toEqual([1]);
    fixture.advance(60_000);
    await until(() => sink.received.length === 3);
    expect(JSON.parse(sink.received[1]?.json ?? "{}")).toMatchObject({ count: 2 });
  });

  it("holds back nothing for a failure recorded before the clock stepped back", async () => {
    recordFailure(fixture.store, { kind: "none", origin: testOrigin }, failure);
    fixture.advance(-60 * 60_000);
    record();
    const sink = new FakeSink();
    start(fixture.store, [sink], { pollInterval: 10 });
    await until(() => sink.received.length === 2);
  });

  it("holds back nothing for a delivered failure that a small step back makes look open", async () => {
    fixture.now = Math.floor(fixture.now / 60_000) * 60_000 + 10_000;
    recordFailure(fixture.store, { kind: "none", origin: testOrigin }, failure);
    fixture.advance(55_000);
    const sink = new FakeSink();
    start(fixture.store, [sink], { pollInterval: 10 });
    await until(() => sink.received.length === 1);
    fixture.advance(-30_000);
    expect(nextOpenEnd(fixture.store, 1)).toBeUndefined();
    record();
    await until(() => sink.received.length === 2);
  });

  it("closes a failure once it takes it, so a count made while it is in flight starts a new event", async () => {
    fixture.now = Math.floor(fixture.now / 60_000) * 60_000 + 10_000;
    recordFailure(fixture.store, { kind: "none", origin: testOrigin }, failure);
    fixture.advance(55_000);
    const sink = new FakeSink();
    let exported: readonly AuditRecord[] = [];
    let release: (() => void) | undefined;
    sink.answer = (batch) =>
      new Promise<void>((resolve) => {
        exported = batch;
        release = resolve;
      });
    start(fixture.store, [sink]);
    await until(() => release !== undefined);
    fixture.advance(-30_000);
    recordFailure(fixture.store, { kind: "none", origin: testOrigin }, failure);
    const counts = () =>
      eventsAfter(fixture.db).map((each) => [
        each.seq,
        (JSON.parse(each.event) as { count: number }).count,
      ]);
    expect([JSON.parse(exported[0]?.json ?? "{}").count, counts()]).toEqual([
      1,
      [
        [1, 1],
        [2, 1],
      ],
    ]);
    release?.();
    await until(() => cursor("file")?.delivered === 1);
  });

  it("reads for delivery through the open events' index", () => {
    for (const [query, parameters] of [
      [batchQuery, { delivered: 0, now: 0 }],
      [openEndQuery, { delivered: 0, now: 0 }],
    ] as const) {
      const plan = fixture.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(parameters) as {
        detail: string;
      }[];
      expect(plan.map((row) => row.detail)).toContainEqual(
        expect.stringMatching(/USING (COVERING )?INDEX audit_events_open/),
      );
    }
  });

  it("names a stalled delivery without ending it, until it completes", async () => {
    record();
    const sink = new FakeSink();
    let release: (() => void) | undefined;
    sink.answer = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    start(fixture.store, [sink]);
    await until(() => release !== undefined);
    await settle();
    expect(logged).toHaveLength(0);
    fixture.advance(60_000);
    await until(() => logged.length === 1);
    await settle();
    expect(logged).toHaveLength(1);
    fixture.advance(15 * 60_000);
    await until(() => logged.length === 2);
    expect(cursor("file")?.delivered).toBe(0);
    release?.();
    await until(() => logged.length === 3);
    await until(() => cursor("file")?.delivered === 1);
  });

  it("delivers what is pending when it stops", async () => {
    const sink = new FakeSink();
    const dispatcher = start(fixture.store, [sink]);
    record();
    record();
    await dispatcher.stop();
    expect(seqs(sink)).toEqual([1, 2]);
  });

  it("never holds up a write while a sink is stalled, and stops it after the grace", async () => {
    const sink = new FakeSink();
    sink.answer = () => new Promise<void>(() => undefined);
    const dispatcher = start(fixture.store, [sink]);
    record();
    record();
    expect(lastSeq(fixture.db)).toBe(2);
    const stopping = Date.now();
    await dispatcher.stop();
    expect(Date.now() - stopping).toBeLessThan(1000);
    expect(cursor("file")?.delivered).toBe(0);
  });

  it("stops a sink whose cursor is removed while it runs, giving it no new one", async () => {
    record();
    const sink = new FakeSink();
    start(fixture.store, [sink]);
    await until(() => sink.received.length === 1);
    expect(forgetSink(fixture.store, "file")).toBe(1);
    // The forgetting's own event is delivered, and the sink then stops.
    await until(() => logged.length === 1);
    const received = sink.received.length;
    record();
    await settle();
    expect([sink.received.length, cursor("file")]).toEqual([received, undefined]);
  });
});

describe("a cursor no sink is configured for", () => {
  it("is kept, named at start and every report interval, and holds back retention until forgotten", async () => {
    record();
    openCursor(fixture.store, "stdout");
    start(fixture.store, [new FakeSink("file")]);
    expect(logged).toHaveLength(1);
    await settle();
    expect(logged).toHaveLength(1);
    fixture.advance(15 * 60_000);
    await until(() => logged.length === 2);
    expect(cursor("stdout")?.delivered).toBe(0);
    fixture.advance(400 * 24 * 60 * 60_000);
    expect(await pruneAuditEvents(fixture.store, 365)).toBe(0);
    const before = lastSeq(fixture.db);
    expect(forgetSink(fixture.store, "stdout")).toBe(0);
    expect(forgetSink(fixture.store, "stdout")).toBeUndefined();
    expect(cursor("stdout")).toBeUndefined();
    const [forgotten] = eventsAfter(fixture.db, before);
    expect(forgotten).toMatchObject({ action: "forgetSink", credential_kind: "cli" });
    expect(JSON.parse(forgotten?.event ?? "{}")).toMatchObject({
      resources: [{ type: "audit_sink", uid: "audit_sink:stdout", data: { delivered_seq: 0 } }],
    });
  });
});
