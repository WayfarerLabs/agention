import { setTimeout as sleep } from "node:timers/promises";
import {
  checkNotification,
  clearNotified,
  forgetDevice,
  markAccepted,
  type Notification,
  type PushTarget,
  stillWanted,
} from "../store/notifications.ts";
import type { AgentMessage, Store } from "../store/store.ts";
import { endpointProblem } from "./endpoint.ts";
import { encryptPush } from "./encryption.ts";
import { type PushKey, VapidTokens } from "./vapid.ts";

// The sender: after an agent's message commits, the check decides whether its
// thread notifies, and the sender encrypts the notification to each device and
// posts it to the device's push service, in the background, so no send holds
// up the agent's write. A send that fails for a reason that may pass is tried
// again, three tries in all; when no device accepted it, the thread's mark is
// cleared so its next agent message tries again. There is no durable queue:
// a notification the server stops in the middle of is treated as one no
// device accepted, and one a crash interrupts keeps its mark until the
// operator reads or archives the thread.

// The transport a send goes through: fetch, or a local test push service.
export type Transport = (url: string, init: RequestInit) => Promise<Response>;

// How long a push service has to answer one request.
export const sendTimeout = 10_000;

// The waits before the second try and the third, each after the try before
// it ended.
export const retryWaits = [10_000, 45_000] as const;

// A notification may wait on its push service for a day, and should wake the
// device: a person is needed.
const pushHeaders = {
  "Content-Encoding": "aes128gcm",
  "Content-Type": "application/octet-stream",
  TTL: "86400",
  Urgency: "high",
};

export interface SenderOptions {
  store: Store;
  key: PushKey;
  log: (message: string) => void;
  // Aborts when the server shuts down: waits and sends in flight end, and
  // every notification not yet settled clears its mark.
  shutdown: AbortSignal;
  transport?: Transport;
  // How long a push service has to answer, sendTimeout unless given.
  timeout?: number;
  // Waits before a retry, until the shutdown signal aborts; the tests give
  // their own clock.
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}

// How one try went: accepted, the subscription gone, failed in a way that
// may pass, not made because it was no longer wanted, or failed for good,
// and why.
type Outcome = "accepted" | "gone" | "retry" | "cancelled" | { failed: string };

function outcomeOf(status: number): Outcome {
  if (status === 200 || status === 201 || status === 202) {
    return "accepted";
  }
  if (status === 404 || status === 410) {
    return "gone";
  }
  return status === 429 || (status >= 500 && status <= 599) ? "retry" : { failed: String(status) };
}

export class PushSender {
  readonly #store: Store;
  readonly #log: (message: string) => void;
  readonly #shutdown: AbortSignal;
  readonly #transport: Transport;
  readonly #timeout: number;
  readonly #wait: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly #tokens: VapidTokens;
  // The notifications whose sends have not all settled.
  readonly #pending = new Set<Notification>();

  constructor(options: SenderOptions) {
    this.#store = options.store;
    this.#log = options.log;
    this.#shutdown = options.shutdown;
    this.#transport = options.transport ?? fetch;
    this.#timeout = options.timeout ?? sendTimeout;
    this.#wait =
      options.wait ?? ((milliseconds, signal) => sleep(milliseconds, undefined, { signal }));
    this.#tokens = new VapidTokens(options.key, options.store.clock);
    // The server fires this before it closes the database, so each
    // notification it stops in the middle of lets its thread notify again.
    this.#shutdown.addEventListener(
      "abort",
      () => {
        for (const notification of this.#pending) {
          this.#clear(notification);
        }
        this.#pending.clear();
      },
      { once: true },
    );
  }

  // clear clears a notification's mark, logging a failure rather than
  // throwing it: nothing awaits a background send, and a database write that
  // fails there must not stop the server.
  #clear(notification: Notification): void {
    try {
      clearNotified(this.#store, notification);
    } catch (error) {
      this.#log(
        `clearing the notified mark of thread ${notification.threadId} failed: ${(error as Error).message}`,
      );
    }
  }

  // afterAgentMessage is the store's hook after an agent's message commits:
  // the check, then the sends, in the background. It never throws into the
  // write, which has committed: a failure is logged, and the agent's answer
  // stands.
  readonly afterAgentMessage = (message: AgentMessage): void => {
    let notification: Notification | undefined;
    try {
      notification = checkNotification(this.#store, message);
    } catch (error) {
      this.#log(
        `the notification check of thread ${message.threadId} failed: ${(error as Error).message}`,
      );
      return;
    }
    if (notification !== undefined) {
      this.send(notification).catch((error: unknown) => {
        this.#log(
          `the notification of thread ${message.threadId} failed: ${(error as Error).message}`,
        );
      });
    }
  };

  // send sends a notification to every device it names, in parallel, and
  // resolves once each has settled.
  async send(notification: Notification): Promise<void> {
    this.#pending.add(notification);
    const data = Buffer.from(JSON.stringify(notification.payload));
    const accepted = await Promise.all(
      notification.targets.map((target) => this.#sendTo(notification, target, data)),
    );
    if (!this.#pending.delete(notification)) {
      // Shutdown has settled it already.
      return;
    }
    if (!accepted.includes(true)) {
      this.#clear(notification);
    }
  }

  // sendTo tries a device up to three times, answering whether its push
  // service accepted the notification.
  async #sendTo(notification: Notification, target: PushTarget, data: Buffer): Promise<boolean> {
    const host = hostOf(target.endpoint);
    const said = (what: string) => this.#log(`push to device ${target.id} (${host}) ${what}`);
    try {
      for (let attempt = 0; attempt <= retryWaits.length; attempt++) {
        const before = retryWaits[attempt - 1];
        if (before !== undefined) {
          await this.#wait(before, this.#shutdown);
        }
        if (this.#shutdown.aborted) {
          return false;
        }
        const outcome = await this.#try(notification, target, data);
        if (this.#shutdown.aborted || outcome === "cancelled") {
          return false;
        }
        switch (outcome) {
          case "accepted":
            markAccepted(this.#store, target.id);
            return true;
          case "gone":
            forgetDevice(this.#store, target.id);
            said("found the device gone; it is removed");
            return false;
          case "retry":
            continue;
          default:
            said(`failed: ${outcome.failed}`);
            return false;
        }
      }
      said("failed after three tries");
      return false;
    } catch (error) {
      if (!this.#shutdown.aborted) {
        said(`failed: ${(error as Error).message}`);
      }
      return false;
    }
  }

  // try makes one request, once it is still wanted: the device's
  // subscription and the thread's mark are as the check left them. Between
  // that read and the request starting nothing waits, so no change to either
  // can come between.
  async #try(notification: Notification, target: PushTarget, data: Buffer): Promise<Outcome> {
    const problem = endpointProblem(target.endpoint);
    if (problem !== undefined) {
      return { failed: `its endpoint ${problem}` };
    }
    const authorization = await this.#tokens.authorization(new URL(target.endpoint).origin);
    if (this.#shutdown.aborted || !stillWanted(this.#store, notification, target)) {
      return "cancelled";
    }
    let response: Response;
    try {
      response = await this.#transport(target.endpoint, {
        method: "POST",
        headers: { ...pushHeaders, Authorization: authorization },
        body: encryptPush(data, target),
        // A redirect is answered as it is and never followed.
        redirect: "manual",
        signal: AbortSignal.any([this.#shutdown, AbortSignal.timeout(this.#timeout)]),
      });
    } catch {
      return "retry";
    }
    await response.body?.cancel().catch(() => undefined);
    return outcomeOf(response.status);
  }
}

// hostOf names an endpoint's host for the log, never its path, which is the
// secret part.
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "an endpoint that is not a URL";
  }
}
