// What the reporter's and monitoring's tests share: a harness that records
// the requests bridges make, can answer them as a proxy does while the server
// is down, and starts bridges with a reporter paced for tests; and a pane a
// test draws itself.
import type { MonitorReport } from "@wayfarerlabs/agention-api";
import type { Key, Pane, Snapshot } from "@wayfarerlabs/agention-harness-observer";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { ReporterTiming } from "./reporter.ts";
import {
  agent,
  BridgeHarness,
  type BridgeTestOptions,
  session,
  type TestBridge,
} from "./test-harness.ts";

// Fast enough for tests, and a poll that ends within a second.
export const timing: ReporterTiming = {
  waitSeconds: 1,
  stateEvery: 50,
  retryFirst: 20,
  retryMost: 100,
  nudgeEvery: 200,
  claimWithin: 1000,
};

// eventually reads until read gives something, every 25 milliseconds, up to
// tries times.
export async function eventually<T>(
  read: () => T | undefined,
  what: string,
  tries = 400,
): Promise<T> {
  for (let tried = 0; tried < tries; tried++) {
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
      .prepare("SELECT monitored, profile, condition, stopped_by, nudge FROM monitor_reports")
      .get() as Record<string, unknown> | undefined;
  }

  // The session's latest nudge, as its row has it: when it was claimed, by
  // the server's clock, and whether it was sent, null while that is not
  // known; or undefined before any claim.
  nudged(): { nudged_at: number; nudge_sent: number | null } | undefined {
    const row = this.server.fixture.db
      .prepare("SELECT nudged_at, nudge_sent FROM sessions")
      .get() as { nudged_at: number | null; nudge_sent: number | null } | undefined;
    return row === undefined || row.nudged_at === null
      ? undefined
      : { nudged_at: row.nudged_at, nudge_sent: row.nudge_sent };
  }

  // The nudges' claims and outcomes bridges sent.
  nudgeRequests(): Seen[] {
    return this.seen.filter(
      (seen) => seen.method === "POST" && seen.path.endsWith("/monitor/nudge"),
    );
  }

  // operatorStarts starts a thread with the session as the operator, through
  // the web API, with the text given, and returns its number.
  async operatorStarts(text: string): Promise<number> {
    const response = await this.server.web("POST", `/s/${agent}/${session}/threads`, {
      request_id: `operator-start-${this.seen.length}`,
      title: text,
      text,
    });
    if (response.status !== 200) {
      throw new Error(`the operator's thread failed: ${JSON.stringify(response.body)}`);
    }
    return (response.body as { number: number }).number;
  }

  // When the session's bridge last made a background request, and its agent
  // last checked in, as the session's row has them.
  presence(): { background_at: number | null; last_seen_at: number | null } | undefined {
    return this.server.fixture.db
      .prepare("SELECT background_at, last_seen_at FROM sessions")
      .get() as { background_at: number | null; last_seen_at: number | null } | undefined;
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
    keysBlocked: false,
    lastTyped: undefined,
  };

  // What the pane was sent, which changes nothing on its screen.
  readonly sent: (string | Key)[] = [];

  async snapshot(): Promise<Snapshot> {
    return { ...this.screen, at: Date.now() };
  }

  async paste(line: string): Promise<void> {
    this.sent.push(line);
  }

  async key(key: Key): Promise<void> {
    this.sent.push(key);
  }
}
