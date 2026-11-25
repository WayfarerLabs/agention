import type { ErrorBody, OperatorWaitResult } from "@wayfarerlabs/agention-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { everySession, maxOperatorWaits } from "../store/index.ts";
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

// waiting waits until count waits are held across every session.
async function waiting(count = 1): Promise<void> {
  const { notifier } = harness.fixture.store;
  for (let i = 0; i < 100 && notifier.waiting(everySession) < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(notifier.waiting(everySession)).toBe(count);
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

describe("the waits one credential holds", () => {
  // holdAll holds as many waits as a credential may, each by wait, and
  // answers them.
  async function holdAll<T>(start: (index: number) => Promise<T>): Promise<Promise<T>[]> {
    const held = Array.from({ length: maxOperatorWaits }, (_, index) => start(index));
    await waiting(maxOperatorWaits);
    return held;
  }
  const holding = (id: number) =>
    harness.fixture.store.operatorWaits.holding({ kind: "api_key", id });
  // freed waits until the key holds count places.
  async function freed(id: number, count: number): Promise<void> {
    for (let i = 0; i < 100 && holding(id) !== count; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(holding(id)).toBe(count);
  }

  it("refuses one past the limit at once, and not a wait on another key", async () => {
    const { key, secret: held } = await harness.createKey(["threads:read"]);
    const pending = await holdAll(() => wait("wait=25", held));
    const refused = await wait("wait=25", held);
    expect(refused.status).toBe(429);
    expect(codeOf(refused)).toBe("rate_limited");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    // The waits held go on, and another key waits as before.
    expect(harness.fixture.store.notifier.waiting(everySession)).toBe(maxOperatorWaits);
    expect(holding(key.id)).toBe(maxOperatorWaits);
    expect(threadsOf(await wait("wait=0"))).toEqual([]);
    // A wait of 0 on the full key answers at once, holding nothing.
    expect(threadsOf(await wait("wait=0", held))).toEqual([]);
    expect(holding(key.id)).toBe(maxOperatorWaits);
    await started(builder, "/s/builder/main", "b-1");
    for (const answer of await Promise.all(pending)) {
      expect(threadsOf(answer)).toEqual(["builder/main/1"]);
    }
  });

  it("gives a place back when a wait answers, ends or is left by its client", async () => {
    const { key, secret: held } = await harness.createKey(["threads:read"]);
    const leaving = new AbortController();
    const pending = await holdAll((index) =>
      harness
        .request("GET", `/api/operator/v1/wait?wait=${index === 0 ? 1 : 25}`, {
          headers: { authorization: `Bearer ${held}` },
          ...(index === 1 ? { signal: leaving.signal } : {}),
        })
        .catch(() => undefined),
    );
    // The first ends on its own.
    await pending[0];
    expect(holding(key.id)).toBe(maxOperatorWaits - 1);
    // The second's client goes away.
    leaving.abort();
    await pending[1];
    await freed(key.id, maxOperatorWaits - 2);
    // The rest answer once a message comes.
    await started(builder, "/s/builder/main", "b-1");
    await Promise.all(pending);
    expect(holding(key.id)).toBe(0);
    expect(threadsOf(await wait("wait=0", held))).toEqual(["builder/main/1"]);
  });

  it("gives every place back when the key is revoked", async () => {
    const { key, secret: held } = await harness.createKey(["threads:read"]);
    const pending = await holdAll(() => wait("wait=25", held));
    await harness.web("POST", `/keys/${key.id}/revoke`);
    for (const answer of await Promise.all(pending)) {
      expect(codeOf(answer)).toBe("unauthenticated");
    }
    expect(holding(key.id)).toBe(0);
  });

  it("counts each browser session's waits on the web mount apart", async () => {
    const first = harness.cookie;
    const pending = await holdAll(() =>
      harness.web("GET", "/wait?wait=25", undefined, { cookie: first }),
    );
    expect(codeOf(await harness.web("GET", "/wait?wait=25", undefined, { cookie: first }))).toBe(
      "rate_limited",
    );
    harness.signIn();
    expect(threadsOf(await harness.web("GET", "/wait?wait=0"))).toEqual([]);
    await started(builder, "/s/builder/main", "b-1");
    for (const answer of await Promise.all(pending)) {
      expect(threadsOf(answer)).toEqual(["builder/main/1"]);
    }
  });
});
