import { formatTimestamp } from "@wayfarerlabs/agention-api";
import type { Store } from "../store/store.ts";
import type { SinkKind } from "./actions.ts";
import {
  advanceCursor,
  type AuditRecord,
  cursorsOf,
  lagOf,
  nextOpenEnd,
  openCursor,
  readBatch,
} from "./cursors.ts";

// The dispatcher delivers the audit log to its sinks, at least once and in
// sequence: one loop per sink, from the sink's cursor, waking when a
// transaction records events and polling for what the command line records.
// A sink that fails or stalls falls behind and says so on stderr; nothing
// waits for it.

// A sink delivers events in sequence order to one destination, named by its
// kind. A delivery that resolves has delivered the whole batch; one that
// throws has failed, and its batch is sent again.
export interface Sink {
  readonly kind: SinkKind;
  deliver(batch: readonly AuditRecord[]): Promise<void>;
  close(): Promise<void>;
}

export interface DispatcherOptions {
  log: (message: string) => void;
  // How long a loop with nothing to deliver waits before reading again,
  // unless woken: what the command line records is found this way.
  pollInterval?: number;
  // How long a failed delivery waits before it is tried again.
  retryInterval?: number;
  // How often the dispatcher checks for a stalled delivery and a report due.
  checkInterval?: number;
  // How long a sink has at shutdown to deliver what is pending.
  shutdownGrace?: number;
}

export const defaultPollInterval = 30_000;
export const defaultRetryInterval = 5_000;
export const defaultCheckInterval = 5_000;
export const defaultShutdownGrace = 5_000;
// How often a sink failing or stalled, or a cursor no sink is configured for,
// is named on stderr again, by the store's clock.
export const reportInterval = 15 * 60_000;
// How long a delivery may take before its sink is named as stalled.
export const stallAfter = 60_000;

// What the dispatcher keeps of each sink, in memory: its cursor, since when
// it has been failing, since when the delivery under way began, and when its
// trouble was last said.
interface SinkState {
  sink: Sink;
  delivered: number;
  failingSince: number | undefined;
  deliveringSince: number | undefined;
  stalled: boolean;
  reportedAt: number;
}

const at = (time: number | undefined) => (time === undefined ? "none" : formatTimestamp(time));

const reasonOf = (error: unknown) => {
  const { code, message } = error as NodeJS.ErrnoException;
  return code ?? message;
};

export class AuditDispatcher {
  readonly #store: Store;
  readonly #sinks: readonly Sink[];
  readonly #log: (message: string) => void;
  readonly #poll: number;
  readonly #retry: number;
  readonly #check: number;
  readonly #grace: number;
  readonly #abort = new AbortController();
  readonly #sleepers = new Set<() => void>();
  #states: SinkState[] = [];
  #stopping = false;
  #loops: Promise<void>[] = [];
  #checker: ReturnType<typeof setInterval> | undefined;
  #notConfiguredAt: number | undefined;

  constructor(store: Store, sinks: readonly Sink[], options: DispatcherOptions) {
    this.#store = store;
    this.#sinks = sinks;
    this.#log = options.log;
    this.#poll = options.pollInterval ?? defaultPollInterval;
    this.#retry = options.retryInterval ?? defaultRetryInterval;
    this.#check = options.checkInterval ?? defaultCheckInterval;
    this.#grace = options.shutdownGrace ?? defaultShutdownGrace;
  }

  // start gives each sink new to the database its cursor, names on stderr
  // every cursor no sink is configured for, now and every report interval,
  // since each holds back retention, and starts each sink's loop.
  start(): void {
    this.#states = this.#sinks.map((sink) => ({
      sink,
      delivered: openCursor(this.#store, sink.kind),
      failingSince: undefined,
      deliveringSince: undefined,
      stalled: false,
      reportedAt: 0,
    }));
    this.#checkSinks();
    this.#checker = setInterval(() => this.#checkSinks(), this.#check);
    this.#checker.unref();
    this.#store.auditWake.listen(() => this.#wakeAll());
    this.#loops = this.#states.map((state) => this.#run(state));
  }

  // stop has every sink deliver what is pending, for up to the shutdown
  // grace, and then stops waiting for what is still under way; whatever is
  // undelivered waits in the table. Closing the sinks is left to their owner,
  // since closing one waits for its write under way.
  async stop(): Promise<void> {
    this.#stopping = true;
    clearInterval(this.#checker);
    this.#store.auditWake.listen(undefined);
    this.#wakeAll();
    const grace = setTimeout(() => this.#abort.abort(), this.#grace);
    try {
      await Promise.all(this.#loops);
    } finally {
      clearTimeout(grace);
    }
  }

  #wakeAll(): void {
    for (const wake of [...this.#sleepers]) {
      wake();
    }
  }

  // sleep waits for ms, or until a wake or the stop, whichever comes first.
  #sleep(ms: number): Promise<void> {
    if (this.#stopping) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#sleepers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      timer.unref();
      this.#sleepers.add(done);
    });
  }

  // run delivers a sink's batches until the stop, and then what is pending,
  // until none is or a delivery fails. A sink whose cursor is removed while it
  // runs stops.
  async #run(state: SinkState): Promise<void> {
    const { sink } = state;
    for (;;) {
      let failure: string | undefined;
      try {
        const batch = readBatch(this.#store, state.delivered);
        if (batch.length === 0) {
          if (this.#stopping) {
            return;
          }
          // An open failure holds back what follows it until its minute ends.
          const opens = nextOpenEnd(this.#store, state.delivered);
          const wait = opens === undefined ? this.#poll : opens - this.#store.clock() + 1;
          await this.#sleep(Math.max(1, Math.min(this.#poll, wait)));
          continue;
        }
        failure = await this.#deliver(state, batch);
        if (failure === undefined) {
          const through = batch.at(-1)?.seq ?? state.delivered;
          if (!advanceCursor(this.#store, sink.kind, through)) {
            this.#log(
              `audit sink ${sink.kind} stops: its cursor was removed while the server ran; ` +
                "the next start gives it a new one",
            );
            return;
          }
          state.delivered = through;
        }
      } catch (error) {
        failure = reasonOf(error);
      }
      if (failure === undefined) {
        this.#recovered(state);
      } else if (this.#stopping) {
        return;
      } else {
        this.#failed(state, failure);
        await this.#sleep(this.#retry);
      }
    }
  }

  // deliver hands a batch to its sink and answers why it failed, if it did.
  // The stop's abort ends it, whether or not the sink can stop its write: what
  // it wrote is delivered again.
  #deliver(state: SinkState, batch: readonly AuditRecord[]): Promise<string | undefined> {
    const { signal } = this.#abort;
    state.deliveringSince = this.#store.clock();
    return new Promise<string | undefined>((resolve) => {
      const aborted = () => resolve("the server is stopping");
      signal.addEventListener("abort", aborted, { once: true });
      state.sink
        .deliver(batch)
        .then(
          () => resolve(undefined),
          (error: unknown) => resolve(reasonOf(error)),
        )
        .finally(() => {
          signal.removeEventListener("abort", aborted);
        });
    }).finally(() => {
      state.deliveringSince = undefined;
      if (state.stalled) {
        state.stalled = false;
        this.#log(`audit sink ${state.sink.kind} is no longer stalled`);
      }
    });
  }

  #recovered(state: SinkState): void {
    if (state.failingSince !== undefined) {
      state.failingSince = undefined;
      this.#log(
        `audit sink ${state.sink.kind} recovered; delivered through sequence ${state.delivered}`,
      );
    }
  }

  // failed notes a failed delivery, saying so when the sink starts failing
  // and every report interval while it goes on failing.
  #failed(state: SinkState, reason: string): void {
    const now = this.#store.clock();
    const starting = state.failingSince === undefined;
    if (!starting && now - state.reportedAt < reportInterval) {
      return;
    }
    state.failingSince ??= now;
    state.reportedAt = now;
    const lag = lagOf(this.#store, state.delivered);
    this.#log(
      starting
        ? `audit sink ${state.sink.kind} is failing: ${reason}; ${lag.behind} events behind`
        : `audit sink ${state.sink.kind} is still failing, since ${at(state.failingSince)}: ` +
            `${reason}; ${lag.behind} events behind, the oldest recorded ${at(lag.oldest)}`,
    );
  }

  // checkSinks names each delivery that has stalled, once it has run longer
  // than stallAfter and every report interval after, without ending it; and
  // each cursor no sink is configured for, every report interval.
  #checkSinks(): void {
    const now = this.#store.clock();
    try {
      for (const state of this.#states) {
        const since = state.deliveringSince;
        if (since === undefined || now - since < stallAfter) {
          continue;
        }
        if (state.stalled && now - state.reportedAt < reportInterval) {
          continue;
        }
        state.stalled = true;
        state.reportedAt = now;
        const lag = lagOf(this.#store, state.delivered);
        this.#log(
          `audit sink ${state.sink.kind} is stalled: a delivery under way since ${at(since)}; ` +
            `${lag.behind} events behind, the oldest recorded ${at(lag.oldest)}`,
        );
      }
      if (this.#notConfiguredAt !== undefined && now - this.#notConfiguredAt < reportInterval) {
        return;
      }
      this.#notConfiguredAt = now;
      const configured = new Set(this.#sinks.map((sink) => sink.kind));
      for (const cursor of cursorsOf(this.#store)) {
        if (configured.has(cursor.kind)) {
          continue;
        }
        const lag = lagOf(this.#store, cursor.delivered);
        this.#log(
          `audit sink ${cursor.kind} is not configured but keeps its cursor, which holds back ` +
            `retention: ${lag.behind} events behind, the oldest recorded ${at(lag.oldest)}; ` +
            `agention audit forget-sink removes it`,
        );
      }
    } catch (error) {
      this.#log(`cannot read the audit log's sinks: ${(error as Error).message}`);
    }
  }
}
