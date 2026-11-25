// What the reporter's and monitoring's tests share: a harness that records
// the requests bridges make, can answer them as a proxy does while the server
// is down, and starts bridges with a reporter paced for tests; and a pane a
// test draws itself.
import type { MonitorReport } from "@wayfarerlabs/agention-api";
import type { Pane, Snapshot } from "@wayfarerlabs/agention-harness-observer";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { ReporterTiming } from "./reporter.ts";
import { BridgeHarness, type BridgeTestOptions, type TestBridge } from "./test-harness.ts";

// Fast enough for tests, and a poll that ends within a second.
export const timing: ReporterTiming = {
  waitSeconds: 1,
  stateEvery: 50,
  retryFirst: 20,
  retryMost: 100,
};

export async function eventually<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let tries = 0; tries < 400; tries++) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await delay(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// One request a bridge made: its method, path and query, its JSON body, and
// when it came, by performance.now().
export interface Seen {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  at: number;
}

export class MonitorHarness extends BridgeHarness {
  readonly seen: Seen[] = [];
  // Says which requests, by path, answer as a proxy does while the server
  // behind it is down.
  down: ((path: string) => boolean) | undefined;
  // Answers a request in place of the server, after it is recorded.
  answer: ((seen: Seen) => Response | undefined) | undefined;

  constructor() {
    super();
    this.beforeRequest = async (request) => {
      const url = new URL(request.url);
      const body: unknown =
        request.method === "POST"
          ? await request
              .clone()
              .json()
              .catch(() => undefined)
          : undefined;
      const seen = {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        body,
        at: performance.now(),
      };
      this.seen.push(seen);
      if (this.down?.(url.pathname)) {
        return new Response("Bad gateway", { status: 502 });
      }
      return this.answer?.(seen);
    };
  }

  // The monitoring polls bridges made, and the reports they sent.
  polls(): Seen[] {
    return this.seen.filter((seen) => seen.method === "GET" && seen.path.endsWith("/monitor"));
  }

  reports(): MonitorReport[] {
    return this.seen
      .filter((seen) => seen.method === "POST" && seen.path.endsWith("/monitor"))
      .map((seen) => seen.body as MonitorReport);
  }

  // The report the server holds for the session, as its row has it.
  held(): Record<string, unknown> | undefined {
    return this.server.fixture.db
      .prepare("SELECT monitored, profile, condition, stopped_by FROM monitor_reports")
      .get() as Record<string, unknown> | undefined;
  }

  // monitored starts a bridge whose reporter is paced for tests.
  monitored(environment: Record<string, string> = {}, options: BridgeTestOptions = {}) {
    return this.bridge(environment, this.home, { reporterTiming: timing, ...options });
  }

  // registered starts such a bridge, registers its session and approves it,
  // and returns it once its reporter has claimed the session.
  async registered(
    environment: Record<string, string> = {},
    options: BridgeTestOptions = {},
  ): Promise<TestBridge> {
    const bridge = await this.monitored(environment, options);
    await bridge.ok("register");
    const claims = this.claims().length;
    await this.approve(this.keyOnDisk());
    await eventually(
      () => (this.claims().length > claims ? true : undefined),
      "the reporter's claim",
    );
    return bridge;
  }

  // The polls that claimed the session.
  claims(): Seen[] {
    return this.polls().filter((seen) => seen.query.get("claim") === "true");
  }
}

// A pane whose screen a test sets: a prompt, ">" with the cursor after it,
// until the test changes it.
export class DrawnPane implements Pane {
  screen: Omit<Snapshot, "at"> = {
    lines: [">"],
    width: 80,
    cursor: { x: 2, y: 0, visible: true },
    hostHasTerminal: true,
    onePane: true,
  };

  async snapshot(): Promise<Snapshot> {
    return { ...this.screen, at: Date.now() };
  }
}
