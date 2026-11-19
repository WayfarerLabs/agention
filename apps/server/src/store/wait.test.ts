import { waitQuery, type WaitResult } from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../errors.ts";
import { archiveThread, markRead, markUnread } from "./marks.ts";
import { encodeCursor } from "./opaque-cursors.ts";
import { revokeRegistration } from "./registrations.ts";
import { type Agent, Fixture, threadTarget } from "./test-fixture.ts";
import { waitForThreads } from "./wait.ts";

let fixture: Fixture;
let agent: Agent;

beforeEach(() => {
  fixture = new Fixture();
  agent = fixture.registerAgent("builder", "main");
});

afterEach(() => {
  fixture.close();
});

function wait(query: Record<string, string> = {}, signal?: AbortSignal): Promise<WaitResult> {
  return waitForThreads(
    fixture.store,
    agent.identity,
    agent.target,
    waitQuery.parse(query),
    signal,
  );
}

function numbers(result: WaitResult): number[] {
  return result.threads.map((thread) => thread.number);
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

describe("waitForThreads", () => {
  it("answers at once with the threads that have unread messages", async () => {
    fixture.startThread(agent);
    fixture.startThread(agent);
    expect(numbers(await wait({ wait: "0" }))).toEqual([]);
    fixture.write(fixture.operator, threadTarget(agent, 2), { text: "answer" });
    const result = await wait({ wait: "20" });
    expect(numbers(result)).toEqual([2]);
    expect(result.threads[0]?.unread).toBe(1);
  });

  it("checks at once by default, with nothing to report", async () => {
    fixture.startThread(agent);
    expect(await settled(wait())).toBe(true);
  });

  it("waits from since for a newer message, and wakes when one commits", async () => {
    fixture.startThread(agent);
    fixture.startThread(agent);
    fixture.write(fixture.operator, threadTarget(agent, 1), { text: "left unread" });
    const first = await wait();
    expect(numbers(first)).toEqual([1]);
    const pending = wait({ since: first.since, wait: "20" });
    expect(await settled(pending)).toBe(false);
    fixture.write(agent.identity, threadTarget(agent, 2), { text: "my own message" });
    expect(await settled(pending)).toBe(false);
    fixture.write(fixture.operator, threadTarget(agent, 2), { text: "new" });
    expect(numbers(await pending)).toEqual([2]);
    expect(fixture.store.notifier.waiting(agent.sessionId)).toBe(0);
  });

  it("is not woken by the operator reading, marking unread or archiving", async () => {
    fixture.startThread(agent);
    fixture.write(agent.identity, threadTarget(agent, 1), { text: "More." });
    const pending = wait({ wait: "20" });
    const position = () =>
      fixture.db.prepare("SELECT last_pos FROM sessions WHERE id = ?").get(agent.sessionId);
    const before = position();
    const notify = vi.spyOn(fixture.store.notifier, "notify");
    markRead(fixture.store, fixture.operator, threadTarget(agent, 1), { through: 2 });
    markUnread(fixture.store, fixture.operator, threadTarget(agent, 1), { from: 2 });
    archiveThread(fixture.store, fixture.operator, threadTarget(agent, 1), { through: 2 });
    expect(notify).not.toHaveBeenCalled();
    expect(position()).toEqual(before);
    expect(await settled(pending)).toBe(false);
    notify.mockRestore();
    fixture.write(fixture.operator, threadTarget(agent, 1), { text: "now" });
    expect(numbers(await pending)).toEqual([1]);
  });

  it("is not woken again by messages the agent archived without reading", async () => {
    fixture.startThread(agent);
    fixture.write(fixture.operator, threadTarget(agent, 1), { text: "Done here." });
    expect(numbers(await wait({ wait: "0" }))).toEqual([1]);
    archiveThread(fixture.store, agent.identity, threadTarget(agent, 1), { through: 2 });
    expect(numbers(await wait({ wait: "0" }))).toEqual([]);
    fixture.write(fixture.operator, threadTarget(agent, 1), { text: "One more thing." });
    const result = await wait({ wait: "0" });
    expect(numbers(result)).toEqual([1]);
    expect(result.threads[0]?.unread).toBe(1);
  });

  it("delivers a withdrawal, which the agent has not read", async () => {
    fixture.startThread(agent);
    fixture.write(fixture.operator, threadTarget(agent, 1), { text: "Hold on." });
    markRead(fixture.store, agent.identity, threadTarget(agent, 1), { through: 2 });
    const pending = wait({ wait: "20" });
    fixture.write(fixture.operator, threadTarget(agent, 1), { replaces: 2 });
    expect(numbers(await pending)).toEqual([1]);
  });

  it("ends with nothing when the wait runs out", async () => {
    fixture.startThread(agent);
    const result = await wait({ wait: "1" });
    expect(result.threads).toEqual([]);
    expect(fixture.store.notifier.waiting(agent.sessionId)).toBe(0);
    fixture.write(fixture.operator, threadTarget(agent, 1), { text: "after" });
    expect(numbers(await wait({ since: result.since, wait: "0" }))).toEqual([1]);
  });

  it("ends when aborted", async () => {
    const controller = new AbortController();
    const pending = wait({ wait: "20" }, controller.signal);
    controller.abort();
    expect((await pending).threads).toEqual([]);
    expect(fixture.store.notifier.waiting(agent.sessionId)).toBe(0);
  });

  it("ends as unauthenticated when its credential is revoked", async () => {
    const pending = wait({ wait: "20" });
    revokeRegistration(fixture.store, fixture.operator, agent.registrationId);
    await expect(pending).rejects.toSatisfy(
      (error) =>
        error instanceof ApiError &&
        error.code === "unauthenticated" &&
        /\bregister\b/.test(error.message),
    );
  });

  it("continues a full page from the threads it left out", async () => {
    for (let i = 0; i < 5; i++) {
      fixture.startThread(agent);
    }
    for (const number of [4, 2, 5, 1, 3]) {
      fixture.write(fixture.operator, threadTarget(agent, number), { text: "news" });
    }
    const first = await wait({ limit: "2" });
    expect(numbers(first)).toEqual([4, 2]);
    const second = await wait({ limit: "2", since: first.since });
    expect(numbers(second)).toEqual([5, 1]);
    const third = await wait({ limit: "2", since: second.since });
    expect(numbers(third)).toEqual([3]);
    expect(numbers(await wait({ since: third.since, wait: "0" }))).toEqual([]);
  });

  it("treats a since beyond the session's latest position as none", async () => {
    fixture.startThread(agent);
    fixture.write(fixture.operator, threadTarget(agent, 1), { text: "unread" });
    const beyond = encodeCursor("since", [1000]);
    expect(numbers(await wait({ since: beyond, wait: "0" }))).toEqual([1]);
  });

  it("refuses a since it did not give out", async () => {
    await expect(wait({ since: "nonsense" })).rejects.toSatisfy(
      (error) =>
        error instanceof ApiError && error.code === "invalid_input" && error.field === "since",
    );
  });
});
