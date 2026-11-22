import type { ErrorBody, OperatorWaitResult } from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { everySession } from "../store/index.ts";
import { hour } from "../store/test-fixture.ts";
import { type AgentKey, codeOf, Harness, newThread, type Response } from "./test-harness.ts";

let harness: Harness;
let builder: AgentKey;
let reviewer: AgentKey;
let secret: string;

beforeEach(async () => {
  harness = new Harness();
  builder = await harness.approvedAgent("builder", "main");
  reviewer = await harness.approvedAgent("reviewer", "other");
  ({ secret } = await harness.createKey(["threads:read"]));
});

afterEach(() => {
  harness.close();
});

const wait = (query = "", key = secret) => harness.operator(key, "GET", `/wait?${query}`);

// threadsOf names the threads an answer reports, each with its session.
function threadsOf(response: Response): string[] {
  expect(response.status).toBe(200);
  return (response.body as OperatorWaitResult).threads.map(
    (thread) => `${thread.agent}/${thread.session}/${thread.number}`,
  );
}

const sinceOf = (response: Response) => (response.body as OperatorWaitResult).since;

// An agent starts a thread in its own session, whose first message the
// operator has not read.
async function started(key: AgentKey, path: string, requestId: string): Promise<void> {
  const response = await harness.agent(key, "POST", `${path}/threads`, newThread(requestId));
  expect(response.status).toBe(200);
}

async function waiting(): Promise<void> {
  const { notifier } = harness.fixture.store;
  for (let i = 0; i < 100 && notifier.waiting(everySession) === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(notifier.waiting(everySession)).toBe(1);
}

// settled reports whether a promise has settled after pending callbacks run.
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  void promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  return done;
}

describe("the operator's wait", () => {
  it("answers at once with every session's threads holding unread messages", async () => {
    await started(builder, "/s/builder/main", "b-1");
    await started(reviewer, "/s/reviewer/other", "r-1");
    const before = Date.now();
    const answer = await wait("wait=25");
    expect(threadsOf(answer)).toEqual(["builder/main/1", "reviewer/other/1"]);
    expect(Date.now() - before).toBeLessThan(5000);
  });

  it("is open to a key holding threads:read alone, and to the web UI", async () => {
    await started(builder, "/s/builder/main", "b-1");
    const { secret: readOnly } = await harness.createKey(["threads:read"]);
    expect(threadsOf(await wait("", readOnly))).toEqual(["builder/main/1"]);
    expect(threadsOf(await harness.web("GET", "/wait"))).toEqual(["builder/main/1"]);
  });

  it("wakes when an agent in another session writes", async () => {
    await started(builder, "/s/builder/main", "b-1");
    const first = await wait();
    expect(threadsOf(first)).toEqual(["builder/main/1"]);
    const pending = wait(`since=${sinceOf(first)}&wait=25`);
    await waiting();
    await started(reviewer, "/s/reviewer/other", "r-1");
    expect(threadsOf(await pending)).toEqual(["reviewer/other/1"]);
    expect(harness.fixture.store.notifier.waiting(everySession)).toBe(0);
  });

  it("never wakes twice for one message", async () => {
    await started(builder, "/s/builder/main", "b-1");
    const first = await wait();
    expect(threadsOf(first)).toEqual(["builder/main/1"]);
    const pending = wait(`since=${sinceOf(first)}&wait=1`);
    await waiting();
    // The operator's own message wakes the wait, which finds nothing new.
    await harness.web("POST", "/s/reviewer/other/threads", {
      request_id: "o-1",
      title: "From the operator",
      text: "Anything?",
    });
    expect(await settled(pending)).toBe(false);
    expect(threadsOf(await pending)).toEqual([]);
  });

  it("continues a full page with the threads it left out", async () => {
    await started(builder, "/s/builder/main", "b-1");
    await started(reviewer, "/s/reviewer/other", "r-1");
    const first = await wait("limit=1");
    expect(threadsOf(first)).toEqual(["builder/main/1"]);
    const rest = await wait(`since=${sinceOf(first)}`);
    expect(threadsOf(rest)).toEqual(["reviewer/other/1"]);
    expect(threadsOf(await wait(`since=${sinceOf(rest)}`))).toEqual([]);
  });

  it("does not report threads the operator has read", async () => {
    await started(builder, "/s/builder/main", "b-1");
    await started(reviewer, "/s/reviewer/other", "r-1");
    await harness.web("POST", "/s/builder/main/threads/1/read", { through: 1 });
    expect(threadsOf(await wait())).toEqual(["reviewer/other/1"]);
  });

  it("answers with no threads when the wait ends", async () => {
    const before = Date.now();
    const answer = await wait("wait=1");
    expect(threadsOf(answer)).toEqual([]);
    expect(Date.now() - before).toBeGreaterThanOrEqual(900);
  });

  it("refuses a since that is not its own", async () => {
    expect(codeOf(await wait("since=bogus"))).toBe("invalid_input");
  });

  it("ends with the key's refusal when the key is revoked", async () => {
    const { key, secret: held } = await harness.createKey(["threads:read"]);
    const before = Date.now();
    const pending = wait("wait=25", held);
    await waiting();
    await harness.web("POST", `/keys/${key.id}/revoke`);
    const answer = await pending;
    expect(answer.status).toBe(401);
    const refused = await wait("", held);
    expect(answer.body as ErrorBody).toEqual(refused.body);
    expect(Date.now() - before).toBeLessThan(5000);
  });

  it("ends with the key's refusal when the key expires", async () => {
    const { secret: held } = await harness.createKey(["threads:read"], { kind: "days", days: 7 });
    harness.fixture.advance(7 * 24 * hour - 50);
    const before = Date.now();
    const pending = wait("wait=25", held);
    await waiting();
    harness.fixture.advance(50);
    const answer = await pending;
    expect(codeOf(answer)).toBe("unauthenticated");
    expect(Date.now() - before).toBeLessThan(5000);
  });
});
