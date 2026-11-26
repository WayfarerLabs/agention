import { type OperatorApiVersions, operatorApiVersions } from "@wayfarerlabs/agention-api";
import { Hono } from "hono";
import type { FailureRecorder } from "../audit/record.ts";
import { authenticateApiKey } from "../auth/api-keys.ts";
import { unauthenticated } from "../errors.ts";
import type { Store } from "../store/index.ts";
import { operatorOperations } from "./operator-operations.ts";
import { addOperations, type Declaration, type IdentityEnv } from "./operations.ts";
import { requestOrigin } from "./origin.ts";
import type { RateBudgets } from "./rates.ts";

// The version of the operator API this mount serves, and where. A version
// changes only additively, with new operations, new optional request fields
// and new response fields; a change that would break a client is a new
// version beside the old, by a maintainer's decision. Until 1.0, a change in
// what a field or value means may land in place, marked breaking.
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
  // The server's origin, which a key's refusal names as the service it was
  // presented to.
  origin: string;
  budgets: RateBudgets;
  recordFailure: FailureRecorder;
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
  const { store, origin: serverOrigin, budgets, shutdown, log, recordFailure } = options;
  const api = new Hono<IdentityEnv>();
  api.use(async (c, next) => {
    if (c.req.header("cookie") !== undefined) {
      throw unauthenticated("the operator API does not accept cookies; send an API key instead");
    }
    await next();
  });
  // A failed authentication spends the shared failed-key budget; a live key
  // spends only its own. A key the server found but refused, as revoked or
  // expired, is recorded once it has spent its token; any other failure names
  // no key, and is not.
  addOperations(api, operatorOperations, {
    store,
    shutdown,
    log,
    recordFailure,
    authenticate: async (c) => {
      const origin = requestOrigin(c, "operator/v1", serverOrigin);
      const { identity, keyId } = await budgets.spendOnFailure(
        "failedKeyAuth",
        async () => authenticateApiKey(store, c.req.header("authorization"), origin),
        (error) => {
          const { refusal } = error;
          if (refusal !== undefined && refusal.code !== "scope") {
            recordFailure(
              { kind: "refused_key", keyId: refusal.key, origin },
              { action: "authenticateApiKey", code: refusal.code },
            );
          }
        },
      );
      budgets.spendForApiKey(keyId);
      return identity;
    },
  });
  return api;
}
