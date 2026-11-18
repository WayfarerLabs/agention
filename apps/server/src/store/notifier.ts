export type WaitOutcome = "notified" | "timeout" | "aborted";

// SessionNotifier wakes the long polls waiting on a session. Writes notify
// after they commit, and so does revocation, so a waiter re-reads what changed
// and a revoked waiter fails its next authorization at once. It lives in the
// server process, which is the only writer of messages.
export class SessionNotifier {
  readonly #waiters = new Map<number, Set<() => void>>();

  notify(sessionId: number): void {
    const waiters = this.#waiters.get(sessionId);
    if (waiters !== undefined) {
      for (const wake of [...waiters]) {
        wake();
      }
    }
  }

  // wait resolves when the session is next notified, after timeoutMs, or when
  // signal aborts, whichever comes first.
  wait(sessionId: number, timeoutMs: number, signal?: AbortSignal): Promise<WaitOutcome> {
    if (signal?.aborted) {
      return Promise.resolve("aborted");
    }
    return new Promise((resolve) => {
      let waiters = this.#waiters.get(sessionId);
      if (waiters === undefined) {
        waiters = new Set();
        this.#waiters.set(sessionId, waiters);
      }
      const settle = (outcome: WaitOutcome) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        waiters.delete(wake);
        if (waiters.size === 0) {
          this.#waiters.delete(sessionId);
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

  // waiting counts the waiters on a session.
  waiting(sessionId: number): number {
    return this.#waiters.get(sessionId)?.size ?? 0;
  }
}
