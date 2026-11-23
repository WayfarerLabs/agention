import {
  agentApi,
  name,
  type PublicKey,
  quoted,
  type RegistrationState,
  registrationState,
  type RegistrationStatus,
} from "@wayfarerlabs/agention-api";
import type { AgentApi } from "./agent-api.ts";
import { ApiFailure, BridgeError, settingProblem } from "./errors.ts";
import { KeyFile, type SessionKey } from "./key-file.ts";

// An agent and session by name.
export interface SessionNames {
  agent: string;
  session: string;
}

// Names a register call gives, either of which may be left out.
export interface GivenNames {
  agent?: string | undefined;
  session?: string | undefined;
}

// The variables an agent host may set to name the session it runs.
export interface SessionEnvironment {
  AGENTWORKS_AGENT?: string | undefined;
  AGENTWORKS_SESSION?: string | undefined;
}

export interface SessionOptions {
  api: AgentApi;
  home: string;
  environment: SessionEnvironment;
}

// The statuses of a registration that can never be approved, after which
// register replaces the key. A server deletes a pending registration that
// expired once another registration or a decision writes its table, after
// which the same key registers afresh instead.
type RefusedStatus = Exclude<RegistrationStatus, "pending" | "approved">;

const refusals: Record<RefusedStatus, string> = {
  rejected: "The operator rejected this session's key",
  expired: "This session's registration expired before the operator approved it",
  revoked: "The operator revoked this session's key",
};

function isRefused(status: RegistrationStatus): status is RefusedStatus {
  return status in refusals;
}

// What register adds to its message when the server states a newer agent API
// version than the bridge's: the server offers what this plugin cannot use,
// which only the operator can change.
const pluginBehind =
  "The Agention server offers features this session's Agention plugin cannot use, so tell " +
  "the operator at your terminal to update the Agention plugin on this host to its newest " +
  "release and restart this session, resuming it to keep this conversation; carry on " +
  "meanwhile.";

// A registration's state as the server answered it, with the agent API
// version the server stated.
interface Submitted {
  state: RegistrationState;
  serverVersion: bigint;
}

// Session is the one agent session a bridge serves. Its names come from the
// first register call that names them, else from the environment, and
// whichever the bridge uses first fixes them for the life of the process.
// Those are the names the session proposes when it registers, which also
// select its key file; the operator may grant others, which the thread routes
// take.
export class Session {
  readonly #api: AgentApi;
  readonly #home: string;
  readonly #environment: SessionEnvironment;
  #proposed: { names: SessionNames; keyFile: KeyFile } | undefined;
  // The names the operator granted, and the key they were granted to. Another
  // bridge sharing the session may replace the key, so names learned for one
  // key are never used with another.
  #granted: { key: PublicKey; names: SessionNames } | undefined;

  constructor(options: SessionOptions) {
    this.#api = options.api;
    this.#home = options.home;
    this.#environment = options.environment;
  }

  // register submits the session's key, or reports the state of its
  // registration if the server knows the key already, and answers with that
  // state and what the agent should do next. It creates the key if there is
  // none, and replaces it once the server says its registration can never be
  // approved. It is the only call that creates or replaces a key. When the
  // server states a newer agent API version than the bridge's, the message
  // asks the agent to have the operator update the plugin, whatever the
  // registration's state.
  async register(given: GivenNames, signal?: AbortSignal): Promise<object> {
    const { names, keyFile } = this.#fix(given);
    let key = keyFile.read() ?? keyFile.create();
    let submitted = await this.#submit(key, names, signal);
    let replaced: RefusedStatus | undefined;
    if (isRefused(submitted.state.status)) {
      replaced = submitted.state.status;
      key = keyFile.replace(key.publicKey);
      submitted = await this.#submit(key, names, signal);
      // Another bridge sharing the session may have replaced the key since,
      // in which case its key is the one bridges now sign with, and the code
      // to relay is that key's.
      const onDisk = keyFile.read();
      if (onDisk !== undefined && onDisk.publicKey !== key.publicKey) {
        key = onDisk;
        submitted = await this.#submit(key, names, signal);
      }
    }
    const { state, serverVersion } = submitted;
    this.#learn(key, state);
    // The expiry is the pending registration's. Passed on once the
    // registration is decided, it could be read as the credential's.
    const answer: Partial<RegistrationState> = { ...state };
    if (state.status !== "pending") {
      delete answer.expires_at;
    }
    return {
      ...answer,
      ...(replaced === undefined ? {} : { replaced }),
      message:
        this.#nextStep(names, state, replaced) +
        (serverVersion > BigInt(agentApi.version) ? ` ${pluginBehind}` : ""),
    };
  }

  // credential returns the key to sign a thread request with and the names of
  // the session the request acts in, as the operator granted them. When the
  // bridge does not know the names granted to the key on disk, it asks with
  // the request register makes, which for a key the server knows creates
  // nothing. It never creates or replaces a key.
  async credential(signal?: AbortSignal): Promise<{ key: SessionKey; granted: SessionNames }> {
    const { names, keyFile } = this.#fix({});
    const key = keyFile.read();
    if (key === undefined) {
      throw ApiFailure.of("unauthenticated", "This session has no key yet; call register.");
    }
    if (this.#granted?.key === key.publicKey) {
      return { key, granted: this.#granted.names };
    }
    const { state } = await this.#submit(key, names, signal);
    const granted = this.#learn(key, state);
    if (granted === undefined) {
      throw ApiFailure.of("unauthenticated", this.#notApproved(names, state));
    }
    return { key, granted };
  }

  // fix returns the session's names, fixing them on first use from the names
  // given, else the environment's. Once fixed, naming another session is an
  // error: one bridge process serves one session.
  #fix(given: GivenNames): { names: SessionNames; keyFile: KeyFile } {
    if (this.#proposed !== undefined) {
      const { names } = this.#proposed;
      for (const field of ["agent", "session"] as const) {
        const value = given[field];
        if (value !== undefined && value !== names[field]) {
          throw ApiFailure.of(
            "invalid_input",
            `This bridge serves ${names.agent}/${names.session}, and one bridge serves one ` +
              "session; start another bridge for another session.",
            field,
          );
        }
      }
      return this.#proposed;
    }
    const agent = given.agent ?? this.#fromEnvironment("AGENTWORKS_AGENT");
    const session = given.session ?? this.#fromEnvironment("AGENTWORKS_SESSION");
    if (agent === undefined || session === undefined) {
      const unset = [
        ...(agent === undefined ? ["AGENTWORKS_AGENT"] : []),
        ...(session === undefined ? ["AGENTWORKS_SESSION"] : []),
      ];
      throw new BridgeError(
        `Call register with agent and session names, since ${unset.join(" and ")} ` +
          `${unset.length === 1 ? "is" : "are"} not set.`,
      );
    }
    const names = { agent, session };
    this.#proposed = { names, keyFile: new KeyFile(this.#home, this.#api.origin, names) };
    return this.#proposed;
  }

  #fromEnvironment(variable: keyof SessionEnvironment): string | undefined {
    const value = this.#environment[variable];
    if (value === undefined || value === "") {
      return undefined;
    }
    const parsed = name.safeParse(value);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? "is not a name";
      throw new BridgeError(
        `Call register with agent and session names, or correct ${variable}, whose value ` +
          `${quoted(value)} ${message}.`,
      );
    }
    return parsed.data;
  }

  async #submit(key: SessionKey, names: SessionNames, signal?: AbortSignal): Promise<Submitted> {
    const { body, serverVersion } = await this.#api.answered(key, {
      method: "POST",
      path: "/registrations",
      body: names,
      ...(signal === undefined ? {} : { signal }),
    });
    const parsed = registrationState.safeParse(body);
    if (!parsed.success) {
      throw settingProblem(
        `The server at ${this.#api.origin} answered the registration with something other ` +
          "than Agention's JSON",
        "set AGENTION_URL to the Agention server's origin",
      );
    }
    return { state: parsed.data, serverVersion };
  }

  // learn records the names granted to a key once its registration is
  // approved, and forgets earlier ones otherwise.
  #learn(key: SessionKey, state: RegistrationState): SessionNames | undefined {
    const { agent, session } = state;
    this.#granted =
      state.status === "approved" && agent !== undefined && session !== undefined
        ? { key: key.publicKey, names: { agent, session } }
        : undefined;
    return this.#granted?.names;
  }

  // What the operator approves: the code, the proposed names and where.
  #approval(names: SessionNames, state: RegistrationState): string {
    return (
      `code ${state.code} for ${names.agent}/${names.session} at ` +
      `${this.#api.origin}/registrations`
    );
  }

  // nextStep tells the agent what to do next, including the names that select
  // this session's key when it calls register again, which are the proposed
  // ones even when the operator granted others.
  #nextStep(names: SessionNames, state: RegistrationState, replaced?: RefusedStatus): string {
    const again = `call register with agent "${names.agent}" and session "${names.session}"`;
    const why =
      replaced === undefined
        ? ""
        : `${refusals[replaced]}, so the bridge made a new key and registered it. `;
    if (state.status === "approved") {
      return (
        `${why}Registered as ${state.agent}/${state.session}, where every Agention tool now ` +
        `acts; to come back to this session later, ${again}. Answers reach you only when you ` +
        "check: check with message_wait as you work, and once your other work is done, keep " +
        "checking while you have open asks or unread messages."
      );
    }
    if (state.status === "pending") {
      return (
        `${why}Tell the operator to approve ${this.#approval(names, state)}, carry on with ` +
        `work that does not need Agention, and ${again} later.`
      );
    }
    return `${why}${refusals[state.status]}; ${again} to make a new key.`;
  }

  #notApproved(names: SessionNames, state: RegistrationState): string {
    if (state.status === "pending") {
      return (
        "This session is not approved yet: tell the operator to approve " +
        `${this.#approval(names, state)}, carry on with work that does not need Agention, ` +
        "and call register again later."
      );
    }
    if (isRefused(state.status)) {
      return `${refusals[state.status]}; call register to make a new key and register it.`;
    }
    return "This session's registration is not approved; call register.";
  }
}
