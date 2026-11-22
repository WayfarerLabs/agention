import {
  markInput,
  messageSendInput,
  threadFilesQuery,
  threadGetQuery,
  unreadInput,
} from "@wayfarerlabs/agention-api";
import { Hono } from "hono";
import type { Identity } from "../identity.ts";
import {
  archiveThread,
  getThread,
  listThreadFiles,
  markRead,
  markUnread,
  sendMessage,
} from "../store/index.ts";
import { serveFile } from "./files.ts";
import { parseBody, parseQuery, threadTarget } from "./input.ts";
import { receiveUpload, type UploadOptions } from "./uploads.ts";

// The variables every authenticated route reads: who is acting, as the mount's
// authentication established.
export interface IdentityEnv {
  Variables: { identity: Identity };
}

// threadRoutes are the routes on one thread and on its session's uploads, the
// same handlers on both mounts, so the role, message and file checks are
// shared. Each mount authenticates before these run and mounts them under
// /s/:agent/:session.
export function threadRoutes(options: UploadOptions): Hono<IdentityEnv> {
  const { store, log } = options;
  const routes = new Hono<IdentityEnv>();
  routes.post("/uploads", (c) => receiveUpload(c, options));
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
  routes.get("/threads/:n/files", (c) =>
    c.json(
      listThreadFiles(store, c.var.identity, threadTarget(c), parseQuery(c, threadFilesQuery)),
    ),
  );
  // HEAD answers as GET does, reading no chunk.
  routes.get("/threads/:n/messages/:seq/files/:name", (c) => serveFile(c, store, log));
  return routes;
}
