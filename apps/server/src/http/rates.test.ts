import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultRates, RateBudgets, TokenBucket } from "./rates.ts";
import { type AgentKey, codeOf, Harness, newAgentKey, type Response } from "./test-harness.ts";

describe("TokenBucket", () => {
  it("spends its burst, then refills one token per interval up to the burst", () => {
    const bucket = new TokenBucket({ burst: 3, interval: 1000 }, 0);
    expect([bucket.take(0), bucket.take(0), bucket.take(0)]).toEqual([0, 0, 0]);
    expect(bucket.take(0)).toBe(1000);
    expect(bucket.take(400)).toBe(600);
    expect(bucket.take(1000)).toBe(0);
    expect([bucket.take(1_000_000), bucket.take(1_000_000), bucket.take(1_000_000)]).toEqual([
      0, 0, 0,
    ]);
    expect(bucket.take(1_000_000)).toBe(1000);
  });
});

describe("RateBudgets", () => {
  it("keeps a budget per key", () => {
    let now = 0;
    const budgets = new RateBudgets(defaultRates, () => now);
    for (let i = 0; i < defaultRates.key.burst; i++) {
      budgets.spendForKey("a");
    }
    expect(() => budgets.spendForKey("a")).toThrow(
      expect.objectContaining({ code: "rate_limited", retryAfter: 1 }),
    );
    budgets.spendForKey("b");
    now += defaultRates.key.interval;
    budgets.spendForKey("a");
  });
});

// A sign-in assertion the schema accepts but no ceremony issued.
const strayAssertion = {
  credential: {
    id: "AAAA",
    rawId: "AAAA",
    type: "public-key",
    clientExtensionResults: {},
    response: { clientDataJSON: "e30", authenticatorData: "AAAA", signature: "AAAA" },
  },
};

// The drains below run on a frozen clock, so a drained budget stays drained.
describe("draining one budget", () => {
  let harness: Harness;
  let approved: AgentKey;
  let pending: AgentKey;

  beforeEach(async () => {
    harness = new Harness();
    approved = await harness.approvedAgent("builder", "main");
    pending = newAgentKey();
    await harness.register(pending, "builder", "main");
  });

  afterEach(() => {
    harness.close();
  });

  // Each class's request, and what it answers while its budget lasts.
  const classes = {
    failedAgentAuth: () => harness.agent(newAgentKey(), "GET", "/s/builder/main/threads"),
    submit: () =>
      harness.agent(newAgentKey(), "POST", "/registrations", { agent: "a", session: "s" }),
    failedSignIn: () =>
      harness.web("POST", "/auth/signin/finish", strayAssertion, { cookie: null }),
    failedLink: () =>
      harness.web(
        "POST",
        "/auth/link/begin",
        { token: "A".repeat(43), name: "Laptop" },
        { cookie: null },
      ),
  };
  type Class = keyof typeof classes;
  const unlimited: Record<Class, string> = {
    failedAgentAuth: "unauthenticated",
    submit: "ok",
    failedSignIn: "unauthenticated",
    failedLink: "unauthenticated",
  };

  // drain sends a class's requests until one is refused, which must happen
  // within the class's burst, since setting up spent some submits.
  async function drain(name: Class): Promise<Response> {
    for (let i = 0; i <= defaultRates[name].burst; i++) {
      const response = await classes[name]();
      if (codeOf(response) !== unlimited[name]) {
        return response;
      }
    }
    throw new Error(`${name} was never refused`);
  }

  async function othersStillAnswer(drained: Class): Promise<void> {
    for (const name of Object.keys(classes) as Class[]) {
      if (name !== drained) {
        expect([name, codeOf(await classes[name]())]).toEqual([name, unlimited[name]]);
      }
    }
    expect(codeOf(await harness.agent(approved, "GET", "/s/builder/main/threads"))).toBe("ok");
    const check = await harness.agent(pending, "POST", "/registrations", {
      agent: "builder",
      session: "main",
    });
    expect(check.body).toMatchObject({ status: "pending" });
    expect(codeOf(await harness.web("GET", "/threads"))).toBe("ok");
    const begin = await harness.web("POST", "/auth/signin/begin", undefined, { cookie: null });
    expect(codeOf(begin)).toBe("ok");
  }

  it.each(Object.keys(classes) as Class[])(
    "%s leaves the other classes and registered keys answering",
    async (name) => {
      const refused = await drain(name);
      expect(refused.status).toBe(429);
      expect(codeOf(refused)).toBe("rate_limited");
      expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
      await othersStillAnswer(name);
    },
  );

  it("with tokens naming an approved key but signed by another leaves that key answering", async () => {
    const forger = newAgentKey().privateKey;
    let refused = false;
    for (let i = 0; i < defaultRates.key.burst + defaultRates.failedAgentAuth.burst; i++) {
      const forged = await harness.agent(approved, "GET", "/s/builder/main/threads", undefined, {
        signWith: forger,
      });
      refused ||= codeOf(forged) === "rate_limited";
    }
    expect(refused).toBe(true);
    expect(codeOf(await harness.agent(approved, "GET", "/s/builder/main/threads"))).toBe("ok");
  });

  it("of an approved key leaves other keys answering", async () => {
    for (let i = 0; i < defaultRates.key.burst; i++) {
      expect(codeOf(await harness.agent(approved, "GET", "/s/builder/main/threads"))).toBe("ok");
    }
    const refused = await harness.agent(approved, "GET", "/s/builder/main/threads");
    expect(codeOf(refused)).toBe("rate_limited");
    const other = await harness.approvedAgent("reviewer", "main");
    expect(codeOf(await harness.agent(other, "GET", "/s/reviewer/main/threads"))).toBe("ok");
    expect(codeOf(await classes.failedAgentAuth())).toBe("unauthenticated");
  });

  it("of a pending key leaves the approved keys answering", async () => {
    // Its first registration spent the submit budget; its checks spend its own.
    const check = () =>
      harness.agent(pending, "POST", "/registrations", { agent: "builder", session: "main" });
    for (let i = 0; i < defaultRates.key.burst; i++) {
      expect(codeOf(await check())).toBe("ok");
    }
    expect(codeOf(await check())).toBe("rate_limited");
    expect(codeOf(await harness.agent(approved, "GET", "/s/builder/main/threads"))).toBe("ok");
  });
});
