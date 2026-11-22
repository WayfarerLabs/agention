import { type OperatorApiVersions, operatorApiVersions } from "@wayfarerlabs/agention-api";
import { Hono } from "hono";
import { authenticateApiKey } from "../auth/api-keys.ts";
import { unauthenticated } from "../errors.ts";
import type { Store } from "../store/index.ts";
import { operatorOperations } from "./operator-operations.ts";
import { addOperations, type Declaration, type IdentityEnv } from "./operations.ts";
import type { RateBudgets } from "./rates.ts";

// The version of the operator API this mount serves, and where. A version
// changes only additively, with new operations, new optional request fields
// and new response fields; a change that would break a client is a new
// version beside the old, by a maintainer's decision.
export const operatorApiVersion = 1;
export const operatorApiPrefix = `/api/operator/v${operatorApiVersion}`;

// The versions this server serves, which GET /api/operator answers.
export const servedVersions: OperatorApiVersions = { versions: [operatorApiVersion] };

// The route that answers them, at /api/operator, beside the versions' mounts.
export const versionsDeclaration = {
  name: "listVersions",
  method: "GET",
  path: "",
  summary: "List the versions of the operator API this server serves",
  response: operatorApiVersions,
} as const satisfies Declaration;

export interface OperatorApiOptions {
  store: Store;
  budgets: RateBudgets;
  // Aborts when the server shuts down.
  shutdown: AbortSignal;
  // Where a failure the call carries on past is written.
  log: (message: string) => void;
}

// operatorApi is version 1 of the operator API, mounted at operatorApiPrefix:
// the operations an API key may call, each within the key's scopes, with the
// same handlers the web mount runs. A key is the only credential it takes, as
// Authorization: Bearer; any request with a cookie is refused, so a browser's
// sign-in never works here, and no CSRF token or Origin is needed, since a
// browser never sends a bearer key on its own.
export function operatorApi(options: OperatorApiOptions): Hono<IdentityEnv> {
  const { store, budgets, shutdown, log } = options;
  const api = new Hono<IdentityEnv>();
  api.use(async (c, next) => {
    if (c.req.header("cookie") !== undefined) {
      throw unauthenticated("the operator API does not accept cookies; send an API key instead");
    }
    await next();
  });
  // A failed authentication spends the shared failed-key budget; a live key
  // spends only its own.
  addOperations(api, operatorOperations, {
    store,
    shutdown,
    log,
    authenticate: async (c) => {
      const { identity, keyId } = await budgets.spendOnFailure("failedKeyAuth", async () =>
        authenticateApiKey(store, c.req.header("authorization")),
      );
      budgets.spendForApiKey(keyId);
      return identity;
    },
  });
  return api;
}
