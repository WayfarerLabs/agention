import {
  cursor,
  type PublicKey,
  type RegistrationState,
  sequence,
  threadNumber,
} from "@wayfarerlabs/agention-api";
import { z } from "zod";
import type { AgentApi } from "./agent-api.ts";
import { ApiFailure, BridgeError, OlderServer } from "./errors.ts";
import {
  findHostDirectory,
  type HostDirectory,
  type NoticeThread,
  pruneHostDirectories,
  type WaitPosition,
} from "./host-directory.ts";
import type { Session, SessionNames } from "./session.ts";

// Push brings what the operator writes to an agent at Claude Code's prompt.
// The bridge holds the session's wait in the background and, when it finds
// the operator's messages, writes a notice to a wake file in its host
// directory; the plugin's watcher, a hook Claude Code runs in the background,
// takes the file, prints the notice and exits 2, which wakes the agent.

// The name Claude Code gives as the MCP client's in its initialize request.
// Only that client has the hooks that take a wake file, so only for it does
// push run.
export const claudeCodeClient = "claude-code";

// How the background wait is paced, in seconds for the wait and milliseconds
// for the rest.
export interface PushTiming {
  // How long each wait request waits, at most the API's 25 seconds.
  waitSeconds: number;
  // How often a registration that is not approved is read again.
  stateEvery: number;
  // The first pause after a failure the bridge can outlast, which doubles
  // with each failure in a row up to retryMost.
  retryFirst: number;
  retryMost: number;
}

export const pushTiming: PushTiming = {
  waitSeconds: 25,
  stateEvery: 15_000,
  retryFirst: 1_000,
  retryMost: 60_000,
};

// The most threads one wait answer lists. A fuller page continues at once.
const waitLimit = 50;

// The most threads a notice names; it counts the rest.
export const maxNoticeThreads = 10;

// pushNotice is the text a wake file holds, which Claude Code shows the agent.
// It is fixed words and integers only, so nothing the server holds, such as a
// title or a message's text, ever reaches the agent's conversation by this
// way: the agent reads the messages with the thread tools.
export function pushNotice(threads: readonly NoticeThread[]): string {
  for (const { thread, unread } of threads) {
    if (!Number.isSafeInteger(thread) || !Number.isSafeInteger(unread)) {
      throw new Error("a notice names threads and counts by integers only");
    }
  }
  const listed = threads
    .slice(0, maxNoticeThreads)
    .map(({ thread, unread }) => `thread ${thread} (${unread} ${plural(unread, "message")})`);
  const more = threads.length - listed.length;
  const rest = more > 0 ? `, and ${more} more ${plural(more, "thread")}` : "";
  return (
    `Agention: the operator wrote to you. Unread: ${listed.join(", ")}${rest}.\n` +
    "Read them with thread_get, then carry on as the agention skill describes.\n"
  );
}

function plural(count: number, noun: string): string {
  return count === 1 ? noun : `${noun}s`;
}

// The line a tool answer ends with once push has given up, after the agent
// was told its answers are pushed.
export const lapseLine =
  "Agention no longer wakes this session when the operator writes: answers now reach you only " +
  "when you check, so check with message_wait as you work, and keep checking while you have " +
  "open asks or unread messages. A later register says whether answers are pushed again.";

// The most the lapse line takes, in bytes of UTF-8 text, which the size every
// tool declares counts (tools.ts toolMeta).
export const maxLapseBytes = 400;

// The part of a wait's answer push reads: each thread's number and unread
// count, and the position to wait from next.
const waitAnswer = z.object({
  threads: z.array(z.object({ number: threadNumber, unread: sequence })),
  since: cursor,
});

export interface PushOptions {
  api: AgentApi;
  session: Session;
  home: string;
  // The name the MCP client gave, once it has initialized.
  clientName: () => string | undefined;
  // The bridge's ancestor processes, its parent first.
  ancestors: () => number[];
  timing: PushTiming;
}

// A failure to read or write the host directory, which the background wait
// cannot work without.
class HostDirectoryFailure extends Error {
  override name = "HostDirectoryFailure";
}

// Push is the bridge's background wait for one session. It runs only once
// register finds that push can work, and stops when the bridge closes.
export class Push {
  readonly #api: AgentApi;
  readonly #session: Session;
  readonly #home: string;
  readonly #clientName: () => string | undefined;
  readonly #ancestors: () => number[];
  readonly #timing: PushTiming;
  readonly #closed = new AbortController();
  #pruned = false;
  #host: HostDirectory | undefined;
  #running = false;
  // Ends the pause the loop is in, so it reads the registration at once.
  #nudge: (() => void) | undefined;
  // Whether register has told the agent its answers are pushed, whether the
  // loop has given up since, and whether a tool answer is still to say so.
  #told = false;
  #gaveUp = false;
  #lapseDue = false;
  // A key whose registration the server refused, which the loop never
  // submits again: only register replaces it.
  #refusedKey: PublicKey | undefined;

  constructor(options: PushOptions) {
    this.#api = options.api;
    this.#session = options.session;
    this.#home = options.home;
    this.#clientName = options.clientName;
    this.#ancestors = options.ancestors;
    this.#timing = options.timing;
  }

  // available says whether push can work for this host session: the MCP
  // client is Claude Code, and one of the bridge's ancestors has a host
  // directory with the watcher's mark. The first call removes the
  // directories of host processes that have ended.
  available(): boolean {
    if (this.#clientName() !== claudeCodeClient) {
      return false;
    }
    if (!this.#pruned) {
      this.#pruned = true;
      try {
        pruneHostDirectories(this.#home);
      } catch {
        // Pruning tidies; a directory it cannot reach is no reason to stop.
      }
    }
    if (this.#host === undefined) {
      try {
        this.#host = findHostDirectory(this.#home, this.#ancestors());
      } catch {
        return false;
      }
    }
    return this.#host !== undefined;
  }

  // start runs the background wait, once available has found the host
  // directory, or has it read the registration at once if it runs already.
  start(): void {
    if (this.#host === undefined || this.#closed.signal.aborted) {
      return;
    }
    if (this.#running) {
      this.#nudge?.();
      return;
    }
    this.#running = true;
    void this.#run(this.#host, this.#closed.signal).finally(() => (this.#running = false));
  }

  // told records that register has told the agent its answers are pushed.
  told(): void {
    this.#told = true;
    this.#lapseDue = false;
  }

  // takeLapse says whether a tool answer is to end with the lapse line, and
  // counts it as said.
  takeLapse(): boolean {
    const due = this.#lapseDue;
    this.#lapseDue = false;
    return due;
  }

  close(): void {
    this.#closed.abort();
    this.#nudge?.();
  }

  async #run(host: HostDirectory, signal: AbortSignal): Promise<void> {
    let retry = this.#timing.retryFirst;
    let approved = false;
    while (!signal.aborted) {
      try {
        if (!approved) {
          approved = await this.#approved(signal);
          if (!approved) {
            await this.#pause(this.#timing.stateEvery, signal);
            continue;
          }
          this.#gaveUp = false;
          this.#lapseDue = false;
        }
        await this.#round(host, signal);
        retry = this.#timing.retryFirst;
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        if (error instanceof HostDirectoryFailure) {
          this.#giveUp();
          return;
        }
        if (cannotOutlast(error)) {
          approved = false;
          this.#giveUp();
          await this.#pause(this.#timing.stateEvery, signal);
          continue;
        }
        // An unapproved key reads the registration again, after a pause, so
        // a server that keeps refusing a key it calls approved is not asked
        // in a tight loop.
        if (error instanceof ApiFailure && error.body.error.code === "unauthenticated") {
          approved = false;
        }
        await this.#pause(retry, signal);
        retry = Math.min(retry * 2, this.#timing.retryMost);
      }
    }
  }

  // approved reads the registration of the key on disk, and gives up on one
  // the server refused. It never creates a key, and never submits one that
  // is not on disk or that the server refused.
  async #approved(signal: AbortSignal): Promise<boolean> {
    const key = this.#session.storedKey();
    if (key === undefined || key.publicKey === this.#refusedKey) {
      return false;
    }
    const state: RegistrationState = await this.#session.stateOf(key, signal);
    if (state.status === "approved") {
      return true;
    }
    if (state.status !== "pending") {
      this.#refusedKey = key.publicKey;
      this.#giveUp();
    }
    return false;
  }

  // round makes one wait request from the saved position, and when it finds
  // threads, saves the new position before writing the wake file, so no
  // message is pushed twice, even across a restart.
  async #round(host: HostDirectory, signal: AbortSignal): Promise<void> {
    const { key, granted } = await this.#session.credential(signal);
    const saved = this.#hostDo(() => host.readCursor());
    const position = this.#belongs(saved, granted) ? saved : undefined;
    const sessionPath = `/s/${granted.agent}/${granted.session}`;
    const answer = await this.#api.request(key, {
      method: "GET",
      path: `${sessionPath}/wait`,
      query: { since: position?.since, wait: this.#timing.waitSeconds, limit: waitLimit },
      wait: this.#timing.waitSeconds * 1000,
      signal,
    });
    const parsed = waitAnswer.safeParse(answer);
    if (!parsed.success) {
      throw new BridgeError("The server's wait answered with something other than its JSON.");
    }
    const { threads, since } = parsed.data;
    const where = { origin: this.#api.origin, ...granted };
    if (threads.length === 0) {
      if (since !== position?.since) {
        this.#hostDo(() => host.saveCursor({ ...where, since, notice: position?.notice ?? [] }));
      }
      return;
    }
    this.#hostDo(() => {
      // A wake file the watcher has not taken yet is taken back, and the new
      // one names its threads too, with the newer counts.
      const named = new Map<number, number>();
      if (host.reclaimWake()) {
        for (const { thread, unread } of position?.notice ?? []) {
          named.set(thread, unread);
        }
      }
      for (const { number, unread } of threads) {
        named.set(number, unread);
      }
      const listed = [...named].map(([thread, unread]) => ({ thread, unread }));
      host.saveCursor({ ...where, since, notice: listed });
      host.writeWake(pushNotice(listed));
    });
  }

  // A saved position counts only for the server and the names the operator
  // granted, since positions are per session.
  #belongs(saved: WaitPosition | undefined, granted: SessionNames): saved is WaitPosition {
    return (
      saved !== undefined &&
      saved.origin === this.#api.origin &&
      saved.agent === granted.agent &&
      saved.session === granted.session
    );
  }

  #hostDo<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      throw new HostDirectoryFailure((error as Error).message, { cause: error });
    }
  }

  #giveUp(): void {
    if (!this.#gaveUp) {
      this.#gaveUp = true;
      this.#lapseDue = this.#told;
    }
  }

  // pause resolves once the time given has passed, the bridge closes or
  // start nudges it. Its timer never holds the process open.
  #pause(milliseconds: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const end = (): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", end);
        this.#nudge = undefined;
        resolve();
      };
      const timer = setTimeout(end, milliseconds).unref();
      signal.addEventListener("abort", end);
      this.#nudge = end;
    });
  }
}

// cannotOutlast says whether a failure is one waiting does not end: the
// server does not serve the bridge's version of the agent API.
function cannotOutlast(error: unknown): boolean {
  return (
    error instanceof OlderServer ||
    (error instanceof ApiFailure && error.body.error.code === "unsupported_version")
  );
}
