import {
  type ErrorCode,
  monitorAnswer,
  type MonitorAnswer,
  type MonitorNudge,
  monitorNudgeAnswer,
  monitorPollAnswer,
  type MonitorPollAnswer,
  type MonitorReport,
  type PublicKey,
  type RegistrationState,
  statusByErrorCode,
} from "@wayfarerlabs/agention-api";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { type AgentApi, type ApiRequest, tokenLifetimeSeconds } from "./agent-api.ts";
import { ApiFailure, BridgeError } from "./errors.ts";
import type { Log, Monitor } from "./monitoring.ts";
import { nudgeTexts } from "./nudge.ts";
import type { Session } from "./session.ts";

// The reporter holds a session's background connection to the server,
// reports what monitoring observes of it, and nudges the agent when the
// server says a nudge is due, claiming it first. It runs beside the agent's
// tools, which work as without it: nothing it does reaches a tool's answer.
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
  // The first pause after a failure, of a poll, a report or a nudge's claim
  // or outcome, which doubles with each failure in a row up to retryMost.
  retryFirst: number;
  retryMost: number;
  // How often a nudge that is due is tried again while the session is not
  // ready for it, which reads only the pane.
  nudgeEvery: number;
  // How long, in all, a nudge's claim is sent again before the bridge gives
  // it up as not claimed: the longer a claim takes, the likelier the pane
  // has changed once the server takes it, which spends the nudge with
  // nothing typed.
  claimWithin: number;
}

export const reporterTiming: ReporterTiming = {
  waitSeconds: 25,
  stateEvery: 15_000,
  retryFirst: 1_000,
  retryMost: 60_000,
  nudgeEvery: 1_000,
  claimWithin: 10_000,
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
  // Whether the server last said a nudge is due, which the next poll tells
  // it the bridge knows, until the nudge's tries clear it once a claim is
  // answered; whether a nudge's tries are running; and whether nudging has
  // stopped for the life of the process, the server having refused a claim
  // or an outcome as invalid (turnNudgingOff).
  #due = false;
  #nudging = false;
  #nudgeOff = false;
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
  // read before. register calls it, whatever its answer, and so does a bridge
  // that starts with its default session's key on disk.
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
  // credential and it is not running: in a bridge started before the
  // session's key was on disk, or one another bridge replaced, which claims
  // the session again.
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
    const backoff = new Backoff(this.#timing);
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
        backoff.reset();
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
        this.#due = answer.nudge;
        if (answer.nudge) {
          this.#startNudging();
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
        await this.#pause(backoff.next(), signal);
      }
    }
  }

  // end stops acting for the session and ends the loop, in one step.
  #end(): void {
    this.#stopActing();
    this.#running = false;
  }

  // registration reads the state of the key on disk with the request register
  // makes, as a background request, which registers no key the server does
  // not know. It never creates a key, and never submits one that is not on
  // disk, or one whose last reading was pending, given, once past the expiry
  // it gave, since the server has likely pruned it. The loop ends there, as it
  // does at a key the server does not know and at a registration that can
  // never be approved.
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
    let state: RegistrationState;
    try {
      state = await this.#session.stateOf(key, signal);
    } catch (error) {
      if (error instanceof ApiFailure && error.body.error.code === "not_found") {
        return { state: "ended" };
      }
      throw error;
    }
    if (state.status === "approved") {
      return { state: "approved" };
    }
    if (state.status === "pending") {
      return { state: "pending", key: key.publicKey, expires: Date.parse(state.expires_at) };
    }
    return { state: "ended" };
  }

  // poll makes one long poll on the session's background connection,
  // saying whether the bridge knows a nudge is due, so the server answers at
  // once only when that changes. A claim answers at once, so the reports that
  // follow it come only once the server has taken it.
  async #poll(claim: boolean, signal: AbortSignal): Promise<MonitorPollAnswer> {
    const wait = claim ? 0 : this.#timing.waitSeconds;
    const nudge = this.#due;
    return this.#monitorRequest(
      signal,
      (path) => ({
        method: "GET",
        path,
        query: { bridge: this.#id, ...(claim && { claim }), ...(nudge && { nudge }), wait },
        wait: wait * 1000,
      }),
      monitorPollAnswer,
    );
  }

  async #monitorRequest<A extends MonitorAnswer>(
    signal: AbortSignal,
    request: (path: string) => Omit<ApiRequest, "signal">,
    schema: { safeParse(value: unknown): { success: true; data: A } | { success: false } },
  ): Promise<A> {
    const { key, granted } = await this.#session.credential(signal, true);
    const answer = await this.#api.request(key, {
      ...request(`/s/${granted.agent}/${granted.session}/monitor`),
      signal,
    });
    const parsed = schema.safeParse(answer);
    if (!parsed.success) {
      throw new BridgeError("The server's monitoring answered with something other than its JSON.");
    }
    return parsed.data;
  }

  // startNudging tries the nudge the server says is due, while the bridge
  // acts for its session, unless its tries run already or nudging is off.
  #startNudging(): void {
    const acting = this.#acting;
    if (this.#nudging || this.#nudgeOff || acting === undefined) {
      return;
    }
    this.#nudging = true;
    void this.#nudgeWhileDue(AbortSignal.any([acting.signal, this.#closed.signal])).catch(
      () => undefined,
    );
  }

  // nudgeWhileDue asks the observer to nudge with texts of its own, that
  // nothing from the server or the screen reaches, while the server says one
  // is due, so a poll that says the next is due while the last one's outcome
  // is still being sent has it tried once that ends. While the session is
  // not ready, the observer reads only the pane, so the tries cost the server
  // nothing. Once it is, the observer asks begin, which claims the nudge,
  // sending the claim again while it fails in a way that may pass, for
  // claimWithin at most, and reads the pane again once the claim is
  // answered. A nudge the server does not let go ahead is not tried, and one
  // it claimed is logged by its step alone, never its text, and its outcome
  // sent. Where a claim was sent again, since one that failed may have
  // reached the server, and is answered no or given up, that claim's nudge
  // is sent as not sent, since nothing was typed for it. The signal ends the
  // tries, and stops a nudge under way without another key, since another
  // bridge may be nudging the session now.
  async #nudgeWhileDue(signal: AbortSignal): Promise<void> {
    try {
      while (this.#due && !signal.aborted && !this.#nudgeOff) {
        // The observer calls begin, if at all, before it resolves.
        let claim = undefined as NudgeAnswer | undefined;
        const outcome = await this.#monitor.nudge(nudgeTexts(), {
          begin: async () => (claim = await this.#nudgeRequest({ phase: "start" }, signal)).go,
          signal,
        });
        if (claim === undefined) {
          await pause(this.#timing.nudgeEvery, signal);
          continue;
        }
        this.#due = false;
        if (claim.go) {
          this.#log(
            outcome.sent
              ? "the bridge nudged the agent"
              : `a nudge was not sent: it stopped at the ${outcome.step} step`,
          );
          await this.#nudgeRequest({ phase: "done", sent: outcome.sent }, signal);
        } else if (claim.maybeTaken) {
          await this.#nudgeRequest({ phase: "done", sent: false }, signal);
        }
      }
    } finally {
      this.#nudging = false;
    }
  }

  // nudgeRequest sends a nudge's claim or outcome, and again after a pause
  // that doubles while it fails to reach the server or the server fails on
  // or rate limits it, until the server answers or refuses it or the signal
  // aborts, or for a claim until claimWithin has passed, when it gives the
  // claim up. It says whether the server answered go, and whether a request
  // before the answer failed or was given up, which the server may have
  // taken. One the server answers as replaced stops this bridge acting, as a
  // report does. A refusal as invalid input turns nudging off; any other
  // refusal, such as a credential no longer approved, is the poll's to deal
  // with.
  async #nudgeRequest(body: MonitorNudge, signal: AbortSignal): Promise<NudgeAnswer> {
    const backoff = new Backoff(this.#timing);
    let maybeTaken = false;
    const tries =
      body.phase === "start"
        ? AbortSignal.any([signal, AbortSignal.timeout(this.#timing.claimWithin)])
        : signal;
    for (;;) {
      try {
        tries.throwIfAborted();
        const answer = await this.#monitorRequest(
          tries,
          (path) => ({ method: "POST", path: `${path}/nudge`, query: { bridge: this.#id }, body }),
          monitorNudgeAnswer,
        );
        if (answer.replaced) {
          this.#stopActing();
        }
        return { go: answer.go && !answer.replaced, maybeTaken };
      } catch (error) {
        const refused = refusalOf(error);
        if (refused === "invalid_input") {
          this.#turnNudgingOff(refused);
        }
        if (signal.aborted || refused !== undefined) {
          return { go: false, maybeTaken };
        }
        maybeTaken = true;
        if (tries.aborted) {
          return { go: false, maybeTaken };
        }
        await pause(backoff.next(), tries);
      }
    }
  }

  // turnNudgingOff stops nudging for the life of the process once the server
  // refuses a claim or an outcome as invalid input: the bridge sends what
  // this server cannot take, which sending again would not change. A refused
  // claim leaves no nudge known to be due, and the next poll would learn at
  // once that one is, so without this the bridge would claim again at every
  // ready prompt. It is logged by its code alone, and the latest report goes
  // again saying the session cannot be nudged.
  #turnNudgingOff(code: ErrorCode): void {
    if (this.#nudgeOff) {
      return;
    }
    this.#nudgeOff = true;
    this.#log(`the server refused a nudge (${code}), so the bridge nudges no more`);
    if (this.#latest !== undefined) {
      this.#queue(this.#latest.report);
    }
  }

  // queue makes a report the latest, numbered after the one before, and sends
  // it, saying the session cannot be nudged once nudging is off.
  #queue(report: MonitorReport): void {
    const sent = this.#nudgeOff && report.monitored ? { ...report, nudge: false } : report;
    this.#latest = { report: sent, seq: ++this.#seq };
    this.#unsent = true;
    this.#send();
  }

  // canNudge says whether the session can be nudged now, as the monitor
  // finds, while nudging is not off.
  canNudge(): Promise<boolean> {
    return this.#nudgeOff ? Promise.resolve(false) : this.#monitor.canNudge();
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
        this.#queue(report);
      }
    })().catch(() => undefined);
  }

  #stopActing(): void {
    this.#acting?.abort();
    this.#acting = undefined;
    this.#latest = undefined;
    this.#unsent = false;
    this.#due = false;
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
      const backoff = new Backoff(this.#timing);
      while (this.#unsent && this.#latest !== undefined && !signal.aborted) {
        const { report, seq } = this.#latest;
        this.#unsent = false;
        try {
          const answer = await this.#monitorRequest(
            signal,
            (path) => ({
              method: "POST",
              path,
              query: { bridge: this.#id, seq },
              body: report,
            }),
            monitorAnswer,
          );
          backoff.reset();
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
          await delay(backoff.next(), undefined, {
            signal: AbortSignal.any([signal, wake.signal]),
            ref: false,
          }).catch(() => undefined);
          this.#retryWake = undefined;
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

// How the server answered a nudge's claim or outcome: whether the bridge may
// go ahead, and whether a request before the answer failed, which the server
// may have taken.
interface NudgeAnswer {
  go: boolean;
  maybeTaken: boolean;
}

// Backoff is the pause before a failed request is sent again, which doubles
// with each failure in a row, from the timing's retryFirst up to its
// retryMost.
class Backoff {
  readonly #timing: ReporterTiming;
  #next: number;

  constructor(timing: ReporterTiming) {
    this.#timing = timing;
    this.#next = timing.retryFirst;
  }

  // next gives the pause after one more failure in a row.
  next(): number {
    const pause = this.#next;
    this.#next = Math.min(pause * 2, this.#timing.retryMost);
    return pause;
  }

  // reset starts the next run of failures from the first pause.
  reset(): void {
    this.#next = this.#timing.retryFirst;
  }
}

// pause resolves once the time given has passed or the signal aborts. Its
// timer never holds the process open.
async function pause(milliseconds: number, signal: AbortSignal): Promise<void> {
  await delay(milliseconds, undefined, { signal, ref: false }).catch(() => undefined);
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
