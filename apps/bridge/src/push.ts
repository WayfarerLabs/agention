import { cursor, type PublicKey, sequence, threadNumber } from "@wayfarerlabs/agention-api";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { AgentApi } from "./agent-api.ts";
import { ApiFailure, BridgeError, OlderServer } from "./errors.ts";
import {
  HostDirectory,
  pruneHostDirectories,
  type SessionAt,
  type WaitPosition,
} from "./host-directory.ts";
import type { SessionKey } from "./key-file.ts";
import type { Session } from "./session.ts";

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
  // How often a pending registration is read again.
  stateEvery: number;
  // The first pause after a failure, which doubles with each failure in a
  // row up to retryMost.
  retryFirst: number;
  retryMost: number;
}

export const pushTiming: PushTiming = {
  waitSeconds: 25,
  stateEvery: 15_000,
  retryFirst: 1_000,
  retryMost: 60_000,
};

// The least time from one wait's start to the next, in milliseconds, so a
// server or a proxy that answers at once with nothing is not asked in a
// tight loop.
export const waitFloor = 1_000;

// The most threads one wait answer lists, which bounds a notice.
const waitLimit = 50;

// A thread a notice names, with how many messages in it are unread.
export interface NoticeThread {
  number: number;
  unread: number;
}

// pushNotice is the text a wake file holds, which Claude Code shows the agent:
// fixed words and the threads' numbers and unread counts, integers the wait's
// schema checked, in thread order. Nothing else the server holds, such as a
// title or a message's text, ever reaches the agent's conversation this way:
// the agent reads the messages with the thread tools.
export function pushNotice(threads: readonly NoticeThread[]): string {
  const listed = [...threads]
    .sort((a, b) => a.number - b.number)
    .map(({ number, unread }) => `thread ${number} (${unread} ${plural(unread, "message")})`);
  return (
    `Agention: the operator wrote to you. Unread: ${listed.join(", ")}.\n` +
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

// The bytes the lapse line takes, which the size every tool declares counts
// (tools.ts toolMeta).
export const maxLapseBytes = Buffer.byteLength(lapseLine);

// The part of a wait's answer push reads: each thread's number and unread
// count, and the position to wait from next.
const waitAnswer = z.object({
  threads: z.array(z.object({ number: threadNumber, unread: sequence })),
  since: cursor,
});
type WaitAnswer = z.infer<typeof waitAnswer>;

export interface PushOptions {
  api: AgentApi;
  session: Session;
  home: string;
  // The clock pending registrations expire by, in Unix milliseconds.
  clock: () => number;
  // The name the MCP client gave, once it has initialized.
  clientName: () => string | undefined;
  // The Claude Code process the bridge runs under, if any.
  host: () => number | undefined;
  timing: PushTiming;
}

// A failure to read or write the host directory.
class HostDirectoryFailure extends Error {
  override name = "HostDirectoryFailure";
}

// What reading the registration found for the loop.
type Registration = "approved" | "pending" | "ended";

// Push is the bridge's background wait for one session. register starts it
// where push can work, as does a tool call in a bridge started again, and it
// stops when the bridge closes.
export class Push {
  readonly #api: AgentApi;
  readonly #session: Session;
  readonly #home: string;
  readonly #clock: () => number;
  readonly #clientName: () => string | undefined;
  readonly #findHost: () => number | undefined;
  readonly #timing: PushTiming;
  readonly #closed = new AbortController();
  // The Claude Code process's pid once looked for, null when there is none.
  #hostPid: number | null | undefined;
  #host: HostDirectory | undefined;
  #started = false;
  #running = false;
  // Ends the pause the loop is in, so it reads the registration at once.
  #nudge: (() => void) | undefined;
  // Whether the agent has been told its answers are pushed, whether push has
  // given up since it last worked, and whether a tool answer is to say so.
  #told = false;
  #gaveUp = false;
  #lapseDue = false;
  // Whether a round saved a position but has yet to write the notice.
  #owesNotice = false;
  // The pending key last read, and when its registration expires.
  #pending: { key: PublicKey; expires: number } | undefined;

  constructor(options: PushOptions) {
    this.#api = options.api;
    this.#session = options.session;
    this.#home = options.home;
    this.#clock = options.clock;
    this.#clientName = options.clientName;
    this.#findHost = options.host;
    this.#timing = options.timing;
  }

  // available says whether push can work for this host session: the MCP
  // client is Claude Code, and the directory of the Claude Code process the
  // bridge runs under has the watcher's mark. The first look for that process
  // also removes the directories of host processes that have ended.
  available(): boolean {
    if (this.#clientName() !== claudeCodeClient) {
      return false;
    }
    if (this.#hostPid === undefined) {
      try {
        pruneHostDirectories(this.#home);
      } catch {
        // Pruning tidies; a directory it cannot reach is no reason to stop.
      }
      this.#hostPid = this.#findHost() ?? null;
    }
    if (this.#hostPid === null) {
      return false;
    }
    if (this.#host === undefined) {
      const host = new HostDirectory(this.#home, this.#hostPid);
      try {
        if (!host.hooked()) {
          return false;
        }
      } catch {
        return false;
      }
      this.#host = host;
    }
    return true;
  }

  // start runs the background wait, once available has found the host
  // directory, or has it read the registration at once if it runs already.
  start(): void {
    if (this.#host === undefined || this.#closed.signal.aborted) {
      return;
    }
    this.#started = true;
    if (this.#running) {
      this.#nudge?.();
      return;
    }
    this.#running = true;
    void this.#run(this.#host, this.#closed.signal).finally(() => (this.#running = false));
  }

  // resume starts push, where it can work, the first time a tool acts in the
  // session without register having started it, as in a bridge started again
  // under a session whose register said answers are pushed. That agent was
  // told, so a lapse is said too.
  resume(): void {
    if (this.#started || !this.available()) {
      return;
    }
    this.#told = true;
    this.start();
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
  }

  // run is the loop: it reads the registration until it is approved, then
  // waits round after round. A failure is retried after a pause that doubles;
  // one waiting does not end, a server that does not serve the bridge's
  // version or a host directory it cannot use, is said as a lapse meanwhile.
  // The loop ends once the registration can never be approved, or a pending
  // one expires: only register, or a bridge started again, starts it anew.
  async #run(host: HostDirectory, signal: AbortSignal): Promise<void> {
    let retry = this.#timing.retryFirst;
    let approved = false;
    while (!signal.aborted) {
      try {
        if (!approved) {
          const registration = await this.#registration(signal);
          if (registration === "ended") {
            return;
          }
          if (registration === "pending") {
            await this.#pause(this.#timing.stateEvery, signal);
            continue;
          }
          approved = true;
        }
        const started = performance.now();
        const found = await this.#round(host, signal);
        this.#gaveUp = false;
        this.#lapseDue = false;
        retry = this.#timing.retryFirst;
        if (!found) {
          await this.#pause(started + waitFloor - performance.now(), signal);
        }
      } catch (error) {
        if (signal.aborted) {
          return;
        }
        if (error instanceof HostDirectoryFailure || cannotOutlast(error)) {
          this.#giveUp();
        }
        // A key that is no longer approved has its registration read again.
        if (error instanceof ApiFailure && error.body.error.code === "unauthenticated") {
          approved = false;
        }
        await this.#pause(retry, signal);
        retry = Math.min(retry * 2, this.#timing.retryMost);
      }
    }
  }

  // registration reads the state of the key on disk with the request
  // register makes. It never creates a key, and never submits one that is not
  // on disk, or a pending one past the expiry its last reading gave, which
  // the server may have pruned and would register afresh: the loop ends
  // there. A registration that can never be approved ends it with a lapse.
  async #registration(signal: AbortSignal): Promise<Registration> {
    const key = this.#session.storedKey();
    if (key === undefined) {
      return "ended";
    }
    const pending = this.#pending;
    if (pending?.key === key.publicKey && !(this.#clock() < pending.expires)) {
      return "ended";
    }
    const state = await this.#session.stateOf(key, signal);
    if (state.status === "approved") {
      return "approved";
    }
    if (state.status === "pending") {
      this.#pending = { key: key.publicKey, expires: Date.parse(state.expires_at) };
      return "pending";
    }
    this.#giveUp();
    return "ended";
  }

  // round makes one wait request from the saved position. When it finds
  // threads, it saves the new position first, so no message is pushed twice,
  // even across a restart, and then writes a notice naming every thread with
  // unread messages as a fresh read finds them. It says whether it found any.
  async #round(host: HostDirectory, signal: AbortSignal): Promise<boolean> {
    const { key, granted } = await this.#session.credential(signal);
    const at: SessionAt = { origin: this.#api.origin, ...granted };
    if (this.#owesNotice) {
      await this.#notify(host, at, signal);
      return true;
    }
    const saved = this.#hostDo(() => host.readCursor(at));
    const answer = await this.#wait(at, {
      since: belongs(saved, at) ? saved.since : undefined,
      wait: this.#timing.waitSeconds,
      signal,
      key,
    });
    if (answer.threads.length === 0) {
      return false;
    }
    this.#hostDo(() => host.saveCursor({ ...at, since: answer.since }));
    this.#owesNotice = true;
    await this.#notify(host, at, signal);
    return true;
  }

  // notify reads every thread with unread messages, from the start and at
  // once, and writes the notice naming them.
  async #notify(host: HostDirectory, at: SessionAt, signal: AbortSignal): Promise<void> {
    const { key } = await this.#session.credential(signal);
    const unread = await this.#wait(at, { since: undefined, wait: 0, signal, key });
    if (unread.threads.length > 0) {
      this.#hostDo(() => host.writeWake(at, pushNotice(unread.threads)));
    }
    this.#owesNotice = false;
  }

  async #wait(
    at: SessionAt,
    request: {
      since: string | undefined;
      wait: number;
      signal: AbortSignal;
      key: SessionKey;
    },
  ): Promise<WaitAnswer> {
    const answer = await this.#api.request(request.key, {
      method: "GET",
      path: `/s/${at.agent}/${at.session}/wait`,
      query: { since: request.since, wait: request.wait, limit: waitLimit },
      wait: request.wait * 1000,
      signal: request.signal,
    });
    const parsed = waitAnswer.safeParse(answer);
    if (!parsed.success) {
      throw new BridgeError("The server's wait answered with something other than its JSON.");
    }
    return parsed.data;
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
    if (milliseconds <= 0 || signal.aborted) {
      return Promise.resolve();
    }
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

// A saved position counts only for the server and the names the operator
// granted, since positions are per session.
function belongs(saved: WaitPosition | undefined, at: SessionAt): saved is WaitPosition {
  return (
    saved !== undefined &&
    saved.origin === at.origin &&
    saved.agent === at.agent &&
    saved.session === at.session
  );
}

// cannotOutlast says whether a failure is one waiting does not end: the
// server does not serve the bridge's version of the agent API.
function cannotOutlast(error: unknown): boolean {
  return (
    error instanceof OlderServer ||
    (error instanceof ApiFailure && error.body.error.code === "unsupported_version")
  );
}
