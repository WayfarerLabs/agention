import {
  agentsQuery,
  approveInput,
  bulkMarkInput,
  newPasskeyInput,
  passkeyLinkBeginInput,
  passkeyNameInput,
  registrationsQuery,
  sessionLogMarkInput,
  sessionLogQuery,
  sessionsQuery,
  type SessionState,
  signInFinishInput,
  threadFilters,
  threadStartInput,
  threadsQuery,
} from "@wayfarerlabs/agention-api";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { closeBrowserSession, resumeBrowserSession } from "../auth/browser-sessions.ts";
import { listPasskeys, removePasskey, renamePasskey } from "../auth/operator-passkeys.ts";
import {
  beginAdding,
  beginLink,
  beginSignIn,
  type Ceremony,
  finishAdding,
  finishLink,
  finishSignIn,
  relyingParty,
  type SignedIn,
} from "../auth/passkeys.ts";
import { challengeLifetime } from "../auth/sealed-challenges.ts";
import { sameSecret } from "../auth/secrets.ts";
import { unauthenticated } from "../errors.ts";
import {
  approveRegistration,
  bulkArchive,
  bulkRead,
  countThreads,
  findOperator,
  listAgents,
  listRegistrations,
  listSessions,
  listThreads,
  readSessionLog,
  rejectRegistration,
  revokeRegistration,
  sessionLog,
  startThread,
  type Store,
} from "../store/index.ts";
import { parseBody, parseQuery, passkeyOf, registrationOf, sessionTarget } from "./input.ts";
import type { RateBudgets } from "./rates.ts";
import { type IdentityEnv, threadRoutes } from "./thread-routes.ts";

// The cookies a server sets: its browser session and a passkey ceremony's
// sealed challenge. A browser keeps one set of cookies for a host whatever its
// port, so each is named for the port of the server's origin, 443 when it
// names none, and servers sharing a host under different ports each read only
// their own.
export function cookieNames(origin: string): { session: string; challenge: string } {
  const port = new URL(origin).port || "443";
  return {
    session: `__Host-agention-${port}-session`,
    challenge: `__Host-agention-${port}-challenge`,
  };
}

const cookieAttributes = {
  secure: true,
  httpOnly: true,
  sameSite: "Strict",
  path: "/",
} as const;

export interface WebApiOptions {
  store: Store;
  origin: string;
  // The server's name, the relying party's name a new passkey carries.
  name: string;
  budgets: RateBudgets;
}

const isMutation = (c: Context) => !["GET", "HEAD", "OPTIONS"].includes(c.req.method);

function signedIn(operatorName: string, csrfToken: string): SessionState {
  return { signed_in: true, operator: { name: operatorName }, csrf_token: csrfToken };
}

// webApi is the web UI's API, mounted at /api/web. The operator authenticates
// with the browser session a passkey opens, held in a cookie the page's
// scripts cannot read. Every mutation must also come from the exact origin
// and carry the session's CSRF token, and any request with an Authorization
// header is refused, so an agent's token never works here.
export function webApi(options: WebApiOptions): Hono<IdentityEnv> {
  const { store, origin, name, budgets } = options;
  const rp = relyingParty(origin, name);
  const { session: sessionCookie, challenge: challengeCookie } = cookieNames(origin);
  const api = new Hono<IdentityEnv>();

  api.use(async (c, next) => {
    if (c.req.header("authorization") !== undefined) {
      throw unauthenticated("the web API does not accept an Authorization header");
    }
    if (isMutation(c) && c.req.header("origin") !== origin) {
      throw unauthenticated(`a change must come from ${origin}`);
    }
    await next();
  });

  // The operator's routes need a live browser session, and changes need its
  // CSRF token too.
  const requireSession: MiddlewareHandler<IdentityEnv> = async (c, next) => {
    const session = resumeBrowserSession(store, getCookie(c, sessionCookie));
    if (session === undefined) {
      throw unauthenticated("sign in first");
    }
    if (isMutation(c) && !sameSecret(c.req.header("x-csrf-token") ?? "", session.csrfToken)) {
      throw unauthenticated("the CSRF token is missing or does not match the session");
    }
    c.set("identity", session.identity);
    await next();
  };

  api.get("/session", (c) => {
    const session = resumeBrowserSession(store, getCookie(c, sessionCookie));
    const state: SessionState =
      session === undefined
        ? { signed_in: false, operator_exists: findOperator(store.db) !== undefined }
        : signedIn(session.operatorName, session.csrfToken);
    return c.json(state);
  });

  // Passkey ceremonies. Begin stores nothing: it sets the cookie that seals
  // the challenge. Finish reads and clears that cookie, and on success sets
  // the session cookie. Only failures spend the ceremony's budget, after they
  // are checked, so no flood can refuse a valid passkey or link.
  const started = (c: Context, ceremony: Ceremony) => {
    setCookie(c, challengeCookie, ceremony.sealedChallenge, {
      ...cookieAttributes,
      maxAge: challengeLifetime / 1000,
    });
    return c.json({ options: ceremony.options });
  };
  const takeChallengeCookie = (c: Context) => {
    const sealed = getCookie(c, challengeCookie);
    deleteCookie(c, challengeCookie, cookieAttributes);
    return sealed;
  };
  const opened = (c: Context, result: SignedIn) => {
    setCookie(c, sessionCookie, result.session.token, {
      ...cookieAttributes,
      maxAge: result.session.maxAge,
    });
    return c.json(signedIn(result.operatorName, result.session.csrfToken));
  };

  api.post("/auth/signin/begin", async (c) => started(c, await beginSignIn(store, rp)));
  api.post("/auth/signin/finish", async (c) => {
    const sealed = takeChallengeCookie(c);
    const input = await parseBody(c, signInFinishInput);
    const previous = getCookie(c, sessionCookie);
    const result = await budgets.spendOnFailure("failedSignIn", () =>
      finishSignIn(store, rp, sealed, input, previous),
    );
    return opened(c, result);
  });
  api.post("/auth/link/begin", async (c) => {
    const { token, name } = await parseBody(c, passkeyLinkBeginInput);
    return started(
      c,
      await budgets.spendOnFailure("failedLink", () => beginLink(store, rp, token, name)),
    );
  });
  api.post("/auth/link/finish", async (c) => {
    const sealed = takeChallengeCookie(c);
    const input = await parseBody(c, newPasskeyInput);
    return opened(
      c,
      await budgets.spendOnFailure("failedLink", () => finishLink(store, rp, sealed, input)),
    );
  });
  api.post("/auth/signout", requireSession, (c) => {
    store.db.transaction(() => {
      closeBrowserSession(store.db, getCookie(c, sessionCookie), store.clock());
    });
    deleteCookie(c, sessionCookie, cookieAttributes);
    const state: SessionState = { signed_in: false, operator_exists: true };
    return c.json(state);
  });

  // The operator's passkeys. Adding one on this device is a ceremony like the
  // others, run by a signed-in browser.
  api.get("/passkeys", requireSession, (c) => c.json(listPasskeys(store, c.var.identity)));
  api.post("/passkeys/register/begin", requireSession, async (c) => {
    const { name } = await parseBody(c, passkeyNameInput);
    return started(c, await beginAdding(store, rp, c.var.identity, name));
  });
  api.post("/passkeys/register/finish", requireSession, async (c) => {
    const sealed = takeChallengeCookie(c);
    const input = await parseBody(c, newPasskeyInput);
    await finishAdding(store, rp, sealed, c.var.identity, input);
    return c.json({});
  });
  api.post("/passkeys/:id/name", requireSession, async (c) => {
    const id = passkeyOf(c);
    const { name } = await parseBody(c, passkeyNameInput);
    renamePasskey(store, c.var.identity, id, name);
    return c.json({});
  });
  api.post("/passkeys/:id/remove", requireSession, (c) => {
    const removed = removePasskey(store, c.var.identity, passkeyOf(c));
    if (removed.signed_out) {
      deleteCookie(c, sessionCookie, cookieAttributes);
    }
    return c.json(removed);
  });

  api.use("/s/*", requireSession);
  api.route("/s/:agent/:session", threadRoutes(store));
  api.post("/s/:agent/:session/threads", async (c) => {
    const target = sessionTarget(c);
    const input = await parseBody(c, threadStartInput);
    return c.json(startThread(store, c.var.identity, target, input));
  });
  api.get("/s/:agent/:session/updates", (c) =>
    c.json(sessionLog(store, c.var.identity, sessionTarget(c), parseQuery(c, sessionLogQuery))),
  );
  api.post("/s/:agent/:session/updates/read", async (c) => {
    const target = sessionTarget(c);
    const input = await parseBody(c, sessionLogMarkInput);
    return c.json(readSessionLog(store, c.var.identity, target, input));
  });

  api.get("/threads", requireSession, (c) =>
    c.json(listThreads(store, c.var.identity, parseQuery(c, threadsQuery))),
  );
  api.get("/threads/counts", requireSession, (c) =>
    c.json(countThreads(store, c.var.identity, parseQuery(c, threadFilters))),
  );
  api.post("/reads", requireSession, async (c) =>
    c.json(bulkRead(store, c.var.identity, await parseBody(c, bulkMarkInput))),
  );
  api.post("/archives", requireSession, async (c) =>
    c.json(bulkArchive(store, c.var.identity, await parseBody(c, bulkMarkInput))),
  );
  api.get("/registrations", requireSession, (c) =>
    c.json(listRegistrations(store, c.var.identity, parseQuery(c, registrationsQuery))),
  );
  api.post("/registrations/:id/approve", requireSession, async (c) => {
    const id = registrationOf(c);
    const input = await parseBody(c, approveInput);
    return c.json(approveRegistration(store, c.var.identity, id, input));
  });
  api.post("/registrations/:id/reject", requireSession, (c) =>
    c.json(rejectRegistration(store, c.var.identity, registrationOf(c))),
  );
  api.post("/registrations/:id/revoke", requireSession, (c) =>
    c.json(revokeRegistration(store, c.var.identity, registrationOf(c))),
  );
  api.get("/sessions", requireSession, (c) =>
    c.json(listSessions(store, c.var.identity, parseQuery(c, sessionsQuery))),
  );
  api.get("/agents", requireSession, (c) =>
    c.json(listAgents(store, c.var.identity, parseQuery(c, agentsQuery))),
  );
  return api;
}
