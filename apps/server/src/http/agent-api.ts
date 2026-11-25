import type { RegistrationState } from "@wayfarerlabs/agention-api";
import { Hono, type MiddlewareHandler } from "hono";
import { authenticateAgent, verifyRegistrationToken } from "../auth/agent-tokens.ts";
import { unauthenticated } from "../errors.ts";
import { findRegistrationByKey, markSeen, type Store, submitRegistration } from "../store/index.ts";
import { agentOperations, registration } from "./agent-operations.ts";
import {
  type AgentApiVersionEnv,
  answerAsStatedVersion,
  requireServedAgentApiVersion,
} from "./agent-api-version.ts";
import { parseBody } from "./input.ts";
import { addOperations, type IdentityEnv } from "./operations.ts";
import type { RateBudgets } from "./rates.ts";

export interface AgentApiOptions {
  store: Store;
  origin: string;
  budgets: RateBudgets;
  // Aborts when the server shuts down, ending the long polls.
  shutdown: AbortSignal;
  // Where a failure the call carries on past is written.
  log: (message: string) => void;
}

// The least time between two logged failures to mark a session seen.
export const seenFailureLogInterval = 60_000;

// agentApi is the agent bridge's API, mounted at /api/agent. A request
// stating an agent API version the server does not serve is refused first,
// and an answer to one it serves is the answer of the version it states.
// Every request carries a token signed by its session's key; cookies are
// refused, so a browser's sign-in never works here.
export function agentApi(options: AgentApiOptions): Hono<IdentityEnv & AgentApiVersionEnv> {
  const { store, origin, budgets, log } = options;
  const api = new Hono<IdentityEnv & AgentApiVersionEnv>();

  // seen marks the session an approved registration acts for as seen,
  // speaking the agent API version the call states, which the mount's first
  // middleware has checked it serves. Presence is advisory, so a failure to
  // mark it is logged and the call goes on. A failure that lasts, such as a
  // full or busy database, recurs on every call, so it is logged at most once
  // a minute, by the store's clock.
  let failureLoggedAt: number | undefined;
  const seen = (registrationId: number, agentApiVersion: bigint): void => {
    try {
      markSeen(store, registrationId, Number(agentApiVersion));
    } catch (error) {
      const now = store.clock();
      if (failureLoggedAt === undefined || now - failureLoggedAt >= seenFailureLogInterval) {
        failureLoggedAt = now;
        log(`cannot mark a session seen: ${(error as Error).stack ?? String(error)}`);
      }
    }
  };

  api.use(requireServedAgentApiVersion);
  api.use(answerAsStatedVersion);
  api.use(async (c, next) => {
    if (c.req.header("cookie") !== undefined) {
      throw unauthenticated("the agent API does not accept cookies");
    }
    await next();
  });

  // Registration is the one route a key the operator has not approved may
  // call: the token must be signed by the key it registers. It is the first
  // call of every conversation, so an approved key's call marks its session
  // seen.
  api.on(registration.method, registration.path, async (c) => {
    const key = await budgets.spendOnFailure("failedAgentAuth", () =>
      verifyRegistrationToken(c.req.header("authorization"), origin, store.clock()),
    );
    const known = findRegistrationByKey(store.db, key);
    if (known === undefined) {
      budgets.spend("submit");
    } else {
      budgets.spendForKey(key);
      seen(known.id, c.var.agentApiVersion);
    }
    const input = await parseBody(c, registration.body);
    const state: RegistrationState = submitRegistration(store, key, input);
    return c.json(state);
  });

  // A failed authentication spends the shared failed-authentication budget;
  // a key that verifies spends only its own. Every authenticated call marks
  // its session seen before its own work, so one refused later counts too.
  const authenticate: MiddlewareHandler<IdentityEnv & AgentApiVersionEnv> = async (c, next) => {
    const { identity, publicKey } = await budgets.spendOnFailure("failedAgentAuth", () =>
      authenticateAgent(store.db, c.req.header("authorization"), origin, store.clock()),
    );
    budgets.spendForKey(publicKey);
    if (identity.credential.kind === "registration") {
      seen(identity.credential.registrationId, c.var.agentApiVersion);
    }
    c.set("identity", identity);
    await next();
  };
  api.use("/s/*", authenticate);
  addOperations(api, agentOperations, {
    store,
    shutdown: options.shutdown,
    log,
    authenticate: (c) => c.var.identity,
  });
  return api;
}
