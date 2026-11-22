export type WaitOutcome = "notified" | "timeout" | "aborted";

// The channel of the waits across every session, such as the operator's: every
// session's notification wakes it too, and so does ending a credential that
// reaches every session, which no one session's notification would.
export const everySession = "every session";

// A channel is one session's, by its id, or everySession.
export type Channel = number | typeof everySession;

// SessionNotifier wakes the long polls waiting on a channel. Writes notify
// their session after they commit, and so does revocation, so a waiter
// re-reads what changed and a revoked waiter fails its next authorization at
// once. It lives in the server process, which is the only writer of messages.
export class SessionNotifier {
  readonly #waiters = new Map<Channel, Set<() => void>>();

  // notify wakes the waiters on a channel. A session's notification also wakes
  // the waiters across every session; notifying everySession wakes only those.
  notify(channel: Channel): void {
    const woken = [this.#waiters.get(channel)];
    if (channel !== everySession) {
      woken.push(this.#waiters.get(everySession));
    }
    for (const wake of woken.flatMap((waiters) => [...(waiters ?? [])])) {
      wake();
    }
  }

  // wait resolves when the channel is next notified, after timeoutMs, or when
  // signal aborts, whichever comes first.
  wait(channel: Channel, timeoutMs: number, signal?: AbortSignal): Promise<WaitOutcome> {
    if (signal?.aborted) {
      return Promise.resolve("aborted");
    }
    return new Promise((resolve) => {
      let waiters = this.#waiters.get(channel);
      if (waiters === undefined) {
        waiters = new Set();
        this.#waiters.set(channel, waiters);
      }
      const settle = (outcome: WaitOutcome) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        waiters.delete(wake);
        if (waiters.size === 0) {
          this.#waiters.delete(channel);
        }
        resolve(outcome);
      };
      const wake = () => settle("notified");
      const onAbort = () => settle("aborted");
      // A wait never keeps the process alive on its own.
      const timer = setTimeout(() => settle("timeout"), timeoutMs).unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      waiters.add(wake);
    });
  }

  // waiting counts the waiters on a channel.
  waiting(channel: Channel): number {
    return this.#waiters.get(channel)?.size ?? 0;
  }
}
