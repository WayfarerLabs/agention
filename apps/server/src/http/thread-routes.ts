import {
  markInput,
  messageSendInput,
  threadGetQuery,
  unreadInput,
} from "@wayfarerlabs/agention-api";
import { Hono } from "hono";
import type { Identity } from "../identity.ts";
import {
  archiveThread,
  getThread,
  markRead,
  markUnread,
  sendMessage,
  type Store,
} from "../store/index.ts";
import { parseBody, parseQuery, threadTarget } from "./input.ts";

// The variables every authenticated route reads: who is acting, as the mount's
// authentication established.
export interface IdentityEnv {
  Variables: { identity: Identity };
}

// threadRoutes are the routes on one thread, the same handlers on both mounts,
// so the role and message checks are shared. Each mount authenticates before
// these run and mounts them under /s/:agent/:session.
export function threadRoutes(store: Store): Hono<IdentityEnv> {
  const routes = new Hono<IdentityEnv>();
  routes.get("/threads/:n", (c) =>
    c.json(getThread(store, c.var.identity, threadTarget(c), parseQuery(c, threadGetQuery))),
  );
  routes.post("/threads/:n/messages", async (c) => {
    const target = threadTarget(c);
    const input = await parseBody(c, messageSendInput);
    return c.json(sendMessage(store, c.var.identity, target, input));
  });
  routes.post("/threads/:n/read", async (c) => {
    const target = threadTarget(c);
    const input = await parseBody(c, markInput);
    return c.json(markRead(store, c.var.identity, target, input));
  });
  routes.post("/threads/:n/unread", async (c) => {
    const target = threadTarget(c);
    const input = await parseBody(c, unreadInput);
    return c.json(markUnread(store, c.var.identity, target, input));
  });
  routes.post("/threads/:n/archive", async (c) => {
    const target = threadTarget(c);
    const input = await parseBody(c, markInput);
    return c.json(archiveThread(store, c.var.identity, target, input));
  });
  return routes;
}
