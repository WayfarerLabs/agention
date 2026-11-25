import {
  type ErrorCode,
  monitorAnswer,
  type MonitorAnswer,
  type MonitorReport,
  type PublicKey,
  statusByErrorCode,
} from "@wayfarerlabs/agention-api";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { type AgentApi, type ApiRequest, tokenLifetimeSeconds } from "./agent-api.ts";
import { ApiFailure, BridgeError } from "./errors.ts";
import type { Log, Monitor } from "./monitoring.ts";
import type { Session } from "./session.ts";

// The reporter holds a session's background connection to the server and
// reports what monitoring observes of it. It runs beside the agent's tools,
// which work as without it: nothing it does reaches a tool's answer.
//
// Several bridges may run for one session, as Codex starts new ones without
// ending the old, and one of them acts for it: the latest to claim it. A
// reporter claims the session when it starts, and a replaced one stands down,
// monitoring and reporting nothing, until the bridge next handles a tool call
// or register, since the bridge the host is using is the one that should
// report.

// How the reporter is paced, in seconds for the poll's wait and milliseconds
// for the rest.
export interface ReporterTiming {
  // How long each poll waits, at most the API's 25 seconds.
  waitSeconds: number;
  // How often a pending registration is read again.
  stateEvery: number;
  // The first pause after a failure, of a poll or of a report, which doubles
  // with each failure in a row up to retryMost.
  retryFirst: number;
  retryMost: number;
}

export const reporterTiming: ReporterTiming = {
  waitSeconds: 25,
  stateEvery: 15_000,
  retryFirst: 1_000,
  retryMost: 60_000,
};

// The least time from one poll's start to the next, in milliseconds, so a
// server or a proxy that answers at once is not asked in a tight loop.
export const pollFloor = 1_000;

// How long before a pending registration's expiry, by the bridge's clock,
// the reporter reads it last, in milliseconds: the clock skew the agent API
// tolerates, a token's lifetime, so a bridge whose clock is behind the
// server's by up to that never reads one past its expiry, which the server
// may have pruned and would register afresh.
const expiryMargin = tokenLifetimeSeconds * 1000;

export interface ReporterOptions {
  api: AgentApi;
  session: Session;
  monitor: Monitor;
  // The clock pending registrations expire by, in Unix milliseconds.
  clock: () => number;
  timing: ReporterTiming;
  log: Log;
}

// What reading the registration found: approved, ended, or pending, with the
// key it read and when that key's registration expires.
type Registration =
  { state: "approved" | "ended" } | { state: "pending"; key: PublicKey; expires: number };

export class Reporter {
  readonly #api: AgentApi;
  readonly #session: Session;
  readonly #monitor: Monitor;
  readonly #clock: () => number;
  readonly #timing: ReporterTiming;
  readonly #log: Log;
  // The id the server tells this bridge from the session's others by, drawn
  // once for the life of the process.
  readonly #id = randomBytes(16).toString("base64url");
  readonly #closed = new AbortController();
  #running = false;
  // Whether start was called while the loop ran, since the loop last read
  // the registration, so a loop about to end reads it again instead.
  #restart = false;
  // Ends the pause the loop is in, so it goes on at once.
  #wake: (() => void) | undefined;
  // While the bridge acts for its session: what ends its watch of the
  // monitor, the latest report with its number, and whether it is still to
  // be sent; and what ends the pause before a failed report is sent again.
  #acting: AbortController | undefined;
  #latest: { report: MonitorReport; seq: number } | undefined;
  #unsent = false;
  #sending = false;
  #retryWake: AbortController | undefined;
  // The code the server last refused a report with, until it takes one, so
  // a run of refusals for the same reason is logged once.
  #refused: ErrorCode | undefined;
  // The number of the latest report the bridge made, which counts up with
  // each for the life of the process, so the server ignores a report that
  // arrives after a later one.
  #seq = 0;

  constructor(options: ReporterOptions) {
    this.#api = options.api;
    this.#session = options.session;
    this.#monitor = options.monitor;
    this.#clock = options.clock;
    this.#timing = options.timing;
    this.#log = options.log;
  }

  // start runs the reporter, which reads the registration until it is
  // approved and then claims the session, or has it read the registration at
  // once if it runs already, as it is, without the expiry of a pending one it
  // read before. register calls it, whatever its answer.
  start(): void {
    if (this.#closed.signal.aborted) {
      return;
    }
    if (this.#running) {
      this.#restart = true;
      this.#wake?.();
      return;
    }
    this.#running = true;
    this.#run(this.#closed.signal).catch(() => (this.#running = false));
  }

  // resume starts the reporter when a tool call finds the session's
  // credential and it is not running: in a bridge started again without
  // register, or one another bridge replaced, which claims the session again.
  resume(): void {
    if (!this.#running) {
      this.start();
    }
  }

  close(): void {
    this.#closed.abort();
    this.#stopActing();
  }

  // run is the loop: it reads the registration until it is approved, then
  // polls round after round, the first claiming the session. A failure is
  // retried after a pause that doubles. The loop ends once the registration
  // can never be approved, a pending one expires, or another bridge acts for
  // the session; only register or a tool call starts it anew.
  //
  // The loop decides to end and clears #running in one step, with nothing
  // awaited between, so a start that comes while it runs is never lost: it
  // either sets #restart before that step, which the step sees, or finds the
  // loop no longer running and runs a new one. While the loop polls, a poll
  // the server answers without replacing the bridge consumes #restart.
  async #run(signal: AbortSignal): Promise<void> {
    let retry = this.#timing.retryFirst;
    let approved = false;
    let claim = true;
    // The pending registration the loop last read, while the last reading
    // was pending.
    let pending: { key: PublicKey; expires: number } | undefined;
    for (;;) {
      if (signal.aborted) {
        this.#end();
        return;
      }
      try {
        if (!approved) {
          if (this.#restart) {
            pending = undefined;
          }
          this.#restart = false;
          const registration = await this.#registration(signal, pending);
          if (registration.state === "ended") {
            if (this.#restart || signal.aborted) {
              continue;
            }
            this.#end();
            return;
          }
          if (registration.state === "pending") {
            // The last reading comes just before the expiry, so an approval
            // given then is still seen.
            pending = registration;
            const left = registration.expires - expiryMargin - this.#clock();
            await this.#pause(Math.min(this.#timing.stateEvery, left), signal);
            continue;
          }
          pending = undefined;
          approved = true;
          claim = true;
        }
        const started = performance.now();
        const answer = await this.#poll(claim, signal);
        retry = this.#timing.retryFirst;
        if (answer.replaced) {
          // A register call since the last poll the server answered claims
          // the session again.
          if (this.#restart) {
            this.#restart = false;
            this.#stopActing();
            claim = true;
            continue;
          }
          this.#end();
          return;
        }
        this.#restart = false;
        if (claim) {
          claim = false;
          this.#startActing();
        } else {
          // A report a failure left unsent goes now that the server answers,
          // rather than at the end of its pause.
          this.#retryWake?.abort();
        }
        await this.#pause(started + pollFloor - performance.now(), signal);
      } catch (error) {
        if (signal.aborted) {
          continue;
        }
        // A key that is no longer approved has its registration read again,
        // and claims the session once it is approved.
        if (error instanceof ApiFailure && error.body.error.code === "unauthenticated") {
          approved = false;
          this.#stopActing();
        }
        await this.#pause(retry, signal);
        retry = Math.min(retry * 2, this.#timing.retryMost);
      }
    }
  }

  // end stops acting for the session and ends the loop, in one step.
  #end(): void {
    this.#stopActing();
    this.#running = false;
  }

  // registration reads the state of the key on disk with the request register
  // makes, as a background request. It never creates a key, and never
  // submits one that is not on disk, or one whose last reading was pending,
  // given, once past the expiry it gave, since the server may have pruned it
  // and would register it afresh: the loop ends there, as it does at a
  // registration that can never be approved.
  async #registration(
    signal: AbortSignal,
    pending: { key: PublicKey; expires: number } | undefined,
  ): Promise<Registration> {
    const key = this.#session.storedKey();
    if (key === undefined) {
      return { state: "ended" };
    }
    if (pending?.key === key.publicKey && !(this.#clock() < pending.expires - expiryMargin)) {
      return { state: "ended" };
    }
    const state = await this.#session.stateOf(key, signal);
    if (state.status === "approved") {
      return { state: "approved" };
    }
    if (state.status === "pending") {
      return { state: "pending", key: key.publicKey, expires: Date.parse(state.expires_at) };
    }
    return { state: "ended" };
  }

  // poll makes one long poll on the session's background connection. A
  // claim answers at once, so the reports that follow it come only once the
  // server has taken it.
  async #poll(claim: boolean, signal: AbortSignal): Promise<MonitorAnswer> {
    const wait = claim ? 0 : this.#timing.waitSeconds;
    return this.#monitorRequest(signal, (path) => ({
      method: "GET",
      path,
      query: { bridge: this.#id, ...(claim && { claim }), wait },
      wait: wait * 1000,
    }));
  }

  async #monitorRequest(
    signal: AbortSignal,
    request: (path: string) => Omit<ApiRequest, "signal">,
  ): Promise<MonitorAnswer> {
    const { key, granted } = await this.#session.credential(signal, true);
    const answer = await this.#api.request(key, {
      ...request(`/s/${granted.agent}/${granted.session}/monitor`),
      signal,
    });
    const parsed = monitorAnswer.safeParse(answer);
    if (!parsed.success) {
      throw new BridgeError("The server's monitoring answered with something other than its JSON.");
    }
    return parsed.data;
  }

  // startActing watches the monitor while the bridge acts for its session,
  // sending each report it yields. Its first is the report on taking over.
  #startActing(): void {
    this.#stopActing();
    const acting = new AbortController();
    this.#acting = acting;
    const signal = AbortSignal.any([acting.signal, this.#closed.signal]);
    void (async () => {
      for await (const report of this.#monitor.reports(signal)) {
        if (signal.aborted) {
          return;
        }
        this.#latest = { report, seq: ++this.#seq };
        this.#unsent = true;
        this.#send();
      }
    })().catch(() => undefined);
  }

  #stopActing(): void {
    this.#acting?.abort();
    this.#acting = undefined;
    this.#latest = undefined;
    this.#unsent = false;
  }

  // send sends the latest report, one request at a time, and each report
  // that comes meanwhile once the one before is answered. A report that fails
  // to reach the server, or that the server fails on or rate limits, is sent
  // again, or the one that replaced it, after a pause that doubles with each
  // failure in a row, or as soon as a poll is answered. One the server
  // refuses, which sending again would not change, is logged by its error's
  // code and dropped. One the server answers as replaced, because another
  // bridge acts for the session, stops this one acting, and its next poll
  // learns it is replaced.
  #send(): void {
    const acting = this.#acting;
    if (this.#sending || !this.#unsent || acting === undefined) {
      return;
    }
    this.#sending = true;
    const signal = AbortSignal.any([acting.signal, this.#closed.signal]);
    void (async () => {
      let retry = this.#timing.retryFirst;
      while (this.#unsent && this.#latest !== undefined && !signal.aborted) {
        const { report, seq } = this.#latest;
        this.#unsent = false;
        try {
          const answer = await this.#monitorRequest(signal, (path) => ({
            method: "POST",
            path,
            query: { bridge: this.#id, seq },
            body: report,
          }));
          retry = this.#timing.retryFirst;
          this.#refused = undefined;
          if (answer.replaced) {
            this.#stopActing();
            return;
          }
        } catch (error) {
          if (signal.aborted) {
            return;
          }
          const refused = refusalOf(error);
          if (refused !== undefined) {
            this.#noteRefusal(refused);
            continue;
          }
          this.#unsent = true;
          const wake = new AbortController();
          this.#retryWake = wake;
          await delay(retry, undefined, {
            signal: AbortSignal.any([signal, wake.signal]),
            ref: false,
          }).catch(() => undefined);
          this.#retryWake = undefined;
          retry = Math.min(retry * 2, this.#timing.retryMost);
        }
      }
    })()
      .finally(() => {
        this.#sending = false;
        // Acting again since, the new watch's report goes now.
        if (this.#acting !== acting) {
          this.#send();
        }
      })
      .catch(() => undefined);
  }

  // noteRefusal logs a refused report by its error's code alone, never the
  // report or the server's message, once for each run of the same refusal.
  #noteRefusal(code: ErrorCode): void {
    if (this.#refused !== code) {
      this.#refused = code;
      this.#log(`a monitoring report was refused (${code}), so the bridge dropped it`);
    }
  }

  // pause resolves once the time given has passed, the reporter closes or
  // start wakes it. Its timer never holds the process open.
  #pause(milliseconds: number, signal: AbortSignal): Promise<void> {
    if (milliseconds <= 0 || signal.aborted) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const end = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", end);
        this.#wake = undefined;
        resolve();
      };
      const timer = setTimeout(end, milliseconds).unref();
      signal.addEventListener("abort", end);
      this.#wake = end;
    });
  }
}

// refusalOf is the code of a failure that refuses a report for good: an
// answer in the 4xx range other than rate_limited, which passes with time.
// Anything else, a 5xx answer or a request that never reached the server,
// may succeed when sent again.
function refusalOf(error: unknown): ErrorCode | undefined {
  if (!(error instanceof ApiFailure)) {
    return undefined;
  }
  const { code } = error.body.error;
  const status = statusByErrorCode[code];
  return status >= 400 && status < 500 && code !== "rate_limited" ? code : undefined;
}
