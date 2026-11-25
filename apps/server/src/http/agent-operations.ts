import {
  agentMessageSendInput,
  monitorAnswer,
  monitorPollQuery,
  monitorReport,
  monitorReportQuery,
  registrationState,
  registrationSubmitInput,
  sessionParams,
  sessionStatus,
  sessionThreadsQuery,
  sessionUpdateInput,
  threadCreateInput,
  threadPage,
  waitQuery,
  waitResult,
  writeResult,
} from "@wayfarerlabs/agention-api";
import {
  createThread,
  listSessionThreads,
  pollMonitor,
  reportMonitor,
  updateSession,
  waitForThreads,
} from "../store/index.ts";
import { type Declaration, operation } from "./operations.ts";
import { threadOperations } from "./thread-operations.ts";

// The agent mount's operations, each on the session the agent's token is
// approved for. Each names its scope as every operation does, and each is
// within the threads:write a registration holds; the store refuses any other
// session as not_found.
export const agentOperations = [
  operation({
    name: "updateSession",
    method: "POST",
    path: "/s/:agent/:session/status",
    summary: "Report the session's status: its state, title, goal, progress and a note",
    scope: "threads:write",
    params: sessionParams,
    body: sessionUpdateInput,
    response: sessionStatus,
    handler: ({ store, identity, params, body }) => updateSession(store, identity, params, body),
  }),
  operation({
    name: "createThread",
    method: "POST",
    path: "/s/:agent/:session/threads",
    summary: "Start a thread in the session, with its first message",
    scope: "threads:write",
    params: sessionParams,
    body: threadCreateInput,
    response: writeResult,
    handler: ({ store, identity, params, body }) => createThread(store, identity, params, body),
  }),
  operation({
    name: "listSessionThreads",
    method: "GET",
    path: "/s/:agent/:session/threads",
    summary: "List the session's threads, filtered and in pages",
    scope: "threads:read",
    params: sessionParams,
    query: sessionThreadsQuery,
    response: threadPage,
    handler: ({ store, identity, params, query }) =>
      listSessionThreads(store, identity, params, query),
  }),
  // The long poll ends when a message it reports commits, the credential is
  // revoked, the client disconnects, the server shuts down or the wait ends.
  operation({
    name: "waitForThreads",
    method: "GET",
    path: "/s/:agent/:session/wait",
    summary: "Wait for messages from others on the session's threads since a cursor",
    scope: "threads:read",
    params: sessionParams,
    query: waitQuery,
    response: waitResult,
    handler: ({ store, identity, params, query, signal }) =>
      waitForThreads(store, identity, params, query, signal),
  }),
  ...threadOperations(agentMessageSendInput),
  // The bridge's background connection and its report of what it observes,
  // which never mark the agent checked in (backgroundOperations).
  operation({
    name: "pollMonitor",
    method: "GET",
    path: "/s/:agent/:session/monitor",
    summary: "Hold the session's background connection until the wait ends or another bridge acts",
    scope: "threads:read",
    params: sessionParams,
    query: monitorPollQuery,
    response: monitorAnswer,
    handler: ({ store, identity, params, query, signal }) =>
      pollMonitor(store, identity, params, query, signal),
  }),
  operation({
    name: "reportMonitor",
    method: "POST",
    path: "/s/:agent/:session/monitor",
    summary: "Report what the bridge observes of the session, replacing its latest report",
    scope: "threads:write",
    params: sessionParams,
    query: monitorReportQuery,
    body: monitorReport,
    response: monitorAnswer,
    handler: ({ store, identity, params, query, body }) =>
      reportMonitor(store, identity, params, query, body),
  }),
];

// The operations a session's bridge calls in the background, on its own: each
// marks the session connected, and none marks its agent checked in, which
// every other call by an approved key does.
export const backgroundOperations: ReadonlySet<string> = new Set(["pollMonitor", "reportMonitor"]);

// Registration is the one agent route a key the operator has not approved may
// call, so it authenticates in its own way, against the key its token
// carries, and its route is built by hand from this declaration.
export const registration = {
  name: "register",
  method: "POST",
  path: "/registrations",
  summary: "Submit the session key's registration, or read its state once submitted",
  body: registrationSubmitInput,
  response: registrationState,
} as const satisfies Declaration;
