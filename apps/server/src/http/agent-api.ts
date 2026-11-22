import {
  registrationSubmitInput,
  sessionThreadsQuery,
  sessionUpdateInput,
  threadCreateInput,
  waitQuery,
} from "@wayfarerlabs/agention-api";
import { Hono, type MiddlewareHandler } from "hono";
import { authenticateAgent, verifyRegistrationToken } from "../auth/agent-tokens.ts";
import { unauthenticated } from "../errors.ts";
import {
  createThread,
  findRegistrationByKey,
  listSessionThreads,
  markSeen,
  type Store,
  submitRegistration,
  updateSession,
  waitForThreads,
} from "../store/index.ts";
import { requireServedAgentApiVersion } from "./agent-api-version.ts";
import { parseBody, parseQuery, sessionTarget } from "./input.ts";
import type { RateBudgets } from "./rates.ts";
import { type IdentityEnv, threadRoutes } from "./thread-routes.ts";

export interface AgentApiOptions {
  store: Store;
  origin: string;
  budgets: RateBudgets;
  // Aborts when the server shuts down, ending the long polls.
  shutdown: AbortSignal;
  // Where a failure the call carries on past is written.
  log: (message: string) => void;
  // The bytes free where the database lives, which uploads leave room in.
  freeBytes: (directory: string) => Promise<number>;
}

// The least time between two logged failures to mark a session seen.
export const seenFailureLogInterval = 60_000;

// agentApi is the agent bridge's API, mounted at /api/agent. A request
// stating an agent API version the server does not serve is refused first.
// Every request carries a token signed by its session's key; cookies are
// refused, so a browser's sign-in never works here.
export function agentApi(options: AgentApiOptions): Hono<IdentityEnv> {
  const { store, origin, budgets, log } = options;
  const api = new Hono<IdentityEnv>();

  // seen marks the session an approved registration acts for as seen. Last
  // seen is advisory, so a failure to stamp it is logged and the call goes on.
  // A failure that lasts, such as a full or busy database, recurs on every
  // call, so it is logged at most once a minute, by the store's clock.
  let failureLoggedAt: number | undefined;
  const seen = (registrationId: number): void => {
    try {
      markSeen(store, registrationId);
    } catch (error) {
      const now = store.clock();
      if (failureLoggedAt === undefined || now - failureLoggedAt >= seenFailureLogInterval) {
        failureLoggedAt = now;
        log(`cannot mark a session seen: ${(error as Error).stack ?? String(error)}`);
      }
    }
  };

  api.use(requireServedAgentApiVersion);
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
  api.post("/registrations", async (c) => {
    const key = await budgets.spendOnFailure("failedAgentAuth", () =>
      verifyRegistrationToken(c.req.header("authorization"), origin, store.clock()),
    );
    const known = findRegistrationByKey(store.db, key);
    if (known === undefined) {
      budgets.spend("submit");
    } else {
      budgets.spendForKey(key);
      seen(known.id);
    }
    const input = await parseBody(c, registrationSubmitInput);
    return c.json(submitRegistration(store, key, input));
  });

  // A failed authentication spends the shared failed-authentication budget;
  // a key that verifies spends only its own. Every authenticated call marks
  // its session seen before its own work, so one refused later counts too.
  const authenticate: MiddlewareHandler<IdentityEnv> = async (c, next) => {
    const { identity, publicKey } = await budgets.spendOnFailure("failedAgentAuth", () =>
      authenticateAgent(store.db, c.req.header("authorization"), origin, store.clock()),
    );
    budgets.spendForKey(publicKey);
    if (identity.credential.kind === "registration") {
      seen(identity.credential.registrationId);
    }
    c.set("identity", identity);
    await next();
  };
  api.use("/s/*", authenticate);

  api.post("/s/:agent/:session/status", async (c) => {
    const target = sessionTarget(c);
    const input = await parseBody(c, sessionUpdateInput);
    return c.json(updateSession(store, c.var.identity, target, input));
  });
  api.post("/s/:agent/:session/threads", async (c) => {
    const target = sessionTarget(c);
    const input = await parseBody(c, threadCreateInput);
    return c.json(createThread(store, c.var.identity, target, input));
  });
  api.get("/s/:agent/:session/threads", (c) =>
    c.json(
      listSessionThreads(
        store,
        c.var.identity,
        sessionTarget(c),
        parseQuery(c, sessionThreadsQuery),
      ),
    ),
  );
  // The long poll ends when a message it reports commits, the credential is
  // revoked, the client disconnects, the server shuts down or the wait ends.
  api.get("/s/:agent/:session/wait", async (c) => {
    const target = sessionTarget(c);
    const query = parseQuery(c, waitQuery);
    const signal = AbortSignal.any([c.req.raw.signal, options.shutdown]);
    return c.json(await waitForThreads(store, c.var.identity, target, query, signal));
  });
  api.route("/s/:agent/:session", threadRoutes({ store, freeBytes: options.freeBytes, log }));
  return api;
}
