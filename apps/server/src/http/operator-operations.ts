import { messageSendInput, writeResult } from "@wayfarerlabs/agention-api";
import {
  agentParams,
  approveInput,
  bulkArchiveResult,
  bulkMarkInput,
  bulkReadResult,
  colorInput,
  done,
  groupCreateInput,
  groupNameInput,
  groupOrderInput,
  groupParams,
  groupRead,
  groupsAndTags,
  matchingThreadActionInput,
  operatorWaitQuery,
  operatorWaitResult,
  registrationParams,
  registrationResult,
  registrationsPage,
  registrationsQuery,
  type Scope,
  sessionGroupInput,
  sessionLog,
  sessionLogMark,
  sessionLogMarkInput,
  sessionLogQuery,
  sessionParams,
  sessionsPage,
  sessionsQuery,
  tagCreateInput,
  tagNameInput,
  tagParams,
  tagRead,
  tagsInput,
  threadActionInput,
  threadActionResult,
  threadCounts,
  threadFilters,
  threadList,
  threadNeighbors,
  threadParams,
  threadStartInput,
  threadsQuery,
  threadsView,
} from "@wayfarerlabs/agention-server-api";
import {
  actOnMatchingThreads,
  actOnThreads,
  approveRegistration,
  bulkArchive,
  bulkRead,
  countThreads,
  createGroup,
  createTag,
  findThreadNeighbors,
  listGroupsAndTags,
  listRegistrations,
  listSessions,
  listThreads,
  maxOperatorWaits,
  orderGroups,
  readSessionLog,
  recolorGroup,
  recolorTag,
  rejectRegistration,
  removeGroup,
  removeTag,
  renameGroup,
  renameTag,
  revokeRegistration,
  sessionLog as readLog,
  setAgentTags,
  setSessionGroup,
  setSessionTags,
  startThread,
  waitForEverySession,
} from "../store/index.ts";
import { type Operation, operation } from "./operations.ts";
import { RateLimitedError } from "./rates.ts";
import { threadOperations } from "./thread-operations.ts";

// How soon a wait refused for want of a place may try again, in
// milliseconds: a held wait answers within its own wait, and a client polling
// in a loop frees its place between waits.
const operatorWaitRetry = 1000;

// OperatorOperation is an operation an API key may call, which always names
// the one scope it requires.
export type OperatorOperation = Operation & { scope: Scope };

// The operator's operations: every one an API key may call, each requiring
// its scope. Being in this list is what puts an operation on the operator
// mount, so one left out is simply not there. The web mount serves the same
// list to the browser session, which holds every scope.
export const operatorOperations: readonly OperatorOperation[] = [
  // threads:read and threads:write
  operation({
    name: "listThreads",
    method: "GET",
    path: "/threads",
    summary: "List the threads of every session, filtered, sorted, grouped and in pages",
    scope: "threads:read",
    query: threadsQuery,
    response: threadList,
    handler: ({ store, identity, query }) => listThreads(store, identity, query),
  }),
  operation({
    name: "countThreads",
    method: "GET",
    path: "/threads/counts",
    summary: "Count the threads each filter of the thread list would keep",
    scope: "threads:read",
    query: threadFilters,
    response: threadCounts,
    handler: ({ store, identity, query }) => countThreads(store, identity, query),
  }),
  operation({
    name: "findThreadNeighbors",
    method: "GET",
    path: "/s/:agent/:session/threads/:thread/neighbors",
    summary:
      "Find the threads just above and below a thread in the thread list, filtered, sorted " +
      "and grouped, with the thread at its own place though the filters would leave it out",
    scope: "threads:read",
    params: threadParams,
    query: threadsView,
    response: threadNeighbors,
    handler: ({ store, identity, params, query }) =>
      findThreadNeighbors(store, identity, params, query),
  }),
  // The operator's long poll, the agent's waitForThreads across every
  // session. It ends when a message it reports commits, the credential is
  // revoked or expires, the client disconnects, the server shuts down or the
  // wait ends.
  operation({
    name: "waitForThreads",
    method: "GET",
    path: "/wait",
    summary: "Wait for messages you have not read, in any session, since a cursor",
    description:
      `One credential, an API key or a browser session, holds at most ${maxOperatorWaits} ` +
      "of these waits at once. Another is refused at once as rate_limited (429), with " +
      "Retry-After; the waits already held go on. A wait of 0 answers at once and counts " +
      "toward none.",
    scope: "threads:read",
    query: operatorWaitQuery,
    response: operatorWaitResult,
    handler: async ({ store, identity, query, signal }) => {
      // A wait of 0 answers at once, holding nothing.
      if (query.wait === 0) {
        return waitForEverySession(store, identity, query, signal);
      }
      const release = store.operatorWaits.take(identity.credential);
      if (release === undefined) {
        throw new RateLimitedError(
          operatorWaitRetry,
          `this credential holds ${maxOperatorWaits} waits already`,
        );
      }
      try {
        return await waitForEverySession(store, identity, query, signal);
      } finally {
        release();
      }
    },
  }),
  ...threadOperations(messageSendInput),
  operation({
    name: "startThread",
    method: "POST",
    path: "/s/:agent/:session/threads",
    summary: "Start a thread with a session, with its first message",
    scope: "threads:write",
    params: sessionParams,
    body: threadStartInput,
    response: writeResult,
    handler: ({ store, identity, params, body }) => startThread(store, identity, params, body),
  }),
  operation({
    name: "bulkRead",
    method: "POST",
    path: "/reads",
    summary: "Mark several threads read, each through a message",
    scope: "threads:write",
    body: bulkMarkInput,
    response: bulkReadResult,
    handler: ({ store, identity, body }) => bulkRead(store, identity, body),
  }),
  operation({
    name: "bulkArchive",
    method: "POST",
    path: "/archives",
    summary: "Archive several threads, each through a message",
    scope: "threads:write",
    body: bulkMarkInput,
    response: bulkArchiveResult,
    handler: ({ store, identity, body }) => bulkArchive(store, identity, body),
  }),
  operation({
    name: "actOnThreads",
    method: "POST",
    path: "/threads/actions",
    summary:
      "Mark several threads read or unread, or archive them, declining their open asks first " +
      "if asked, each through a message",
    scope: "threads:write",
    body: threadActionInput,
    response: threadActionResult,
    handler: ({ store, identity, body }) => actOnThreads(store, identity, body),
  }),
  operation({
    name: "actOnMatchingThreads",
    method: "POST",
    path: "/threads/actions/matching",
    summary:
      "Mark every thread the thread list's filters keep read or unread, or archive them, " +
      "declining their open asks first if asked",
    scope: "threads:write",
    body: matchingThreadActionInput,
    response: threadActionResult,
    handler: ({ store, identity, body }) => actOnMatchingThreads(store, identity, body),
  }),

  // sessions:read and sessions:write
  operation({
    name: "listSessions",
    method: "GET",
    path: "/sessions",
    summary: "List the agents with their sessions, statuses, groups and tags, in pages",
    scope: "sessions:read",
    query: sessionsQuery,
    response: sessionsPage,
    handler: ({ store, identity, query }) => listSessions(store, identity, query),
  }),
  operation({
    name: "readSessionLog",
    method: "GET",
    path: "/s/:agent/:session/updates",
    summary: "Read a page of a session's log, newest first, with how far it has been read",
    scope: "sessions:read",
    params: sessionParams,
    query: sessionLogQuery,
    response: sessionLog,
    handler: ({ store, identity, params, query }) => readLog(store, identity, params, query),
  }),
  operation({
    name: "markSessionLogRead",
    method: "POST",
    path: "/s/:agent/:session/updates/read",
    summary: "Mark a session's log read through an update",
    scope: "sessions:write",
    params: sessionParams,
    body: sessionLogMarkInput,
    response: sessionLogMark,
    handler: ({ store, identity, params, body }) => readSessionLog(store, identity, params, body),
  }),
  operation({
    name: "listGroupsAndTags",
    method: "GET",
    path: "/groups-and-tags",
    summary: "List the session groups, in the operator's order, and the tags, with their colors",
    scope: "sessions:read",
    response: groupsAndTags,
    handler: ({ store, identity }) => listGroupsAndTags(store, identity),
  }),
  operation({
    name: "createGroup",
    method: "POST",
    path: "/groups",
    summary: "Create an empty session group, last in the order, with a color",
    scope: "sessions:write",
    body: groupCreateInput,
    response: groupRead,
    handler: ({ store, identity, body }) => createGroup(store, identity, body),
  }),
  operation({
    name: "orderGroups",
    method: "POST",
    path: "/groups/order",
    summary: "Put the session groups in an order, naming every group once",
    scope: "sessions:write",
    body: groupOrderInput,
    response: done,
    handler: ({ store, identity, body }) => {
      orderGroups(store, identity, body);
      return {};
    },
  }),
  operation({
    name: "renameGroup",
    method: "POST",
    path: "/groups/:id/name",
    summary: "Rename a session group",
    scope: "sessions:write",
    params: groupParams,
    body: groupNameInput,
    response: groupRead,
    handler: ({ store, identity, params, body }) => renameGroup(store, identity, params.id, body),
  }),
  operation({
    name: "recolorGroup",
    method: "POST",
    path: "/groups/:id/color",
    summary: "Give a session group another color",
    scope: "sessions:write",
    params: groupParams,
    body: colorInput,
    response: groupRead,
    handler: ({ store, identity, params, body }) => recolorGroup(store, identity, params.id, body),
  }),
  operation({
    name: "removeGroup",
    method: "POST",
    path: "/groups/:id/remove",
    summary: "Remove a session group, leaving its sessions in none",
    scope: "sessions:write",
    params: groupParams,
    response: done,
    handler: ({ store, identity, params }) => {
      removeGroup(store, identity, params.id);
      return {};
    },
  }),
  operation({
    name: "createTag",
    method: "POST",
    path: "/tags",
    summary: "Create a tag that nothing carries yet, with a color",
    scope: "sessions:write",
    body: tagCreateInput,
    response: tagRead,
    handler: ({ store, identity, body }) => createTag(store, identity, body),
  }),
  operation({
    name: "renameTag",
    method: "POST",
    path: "/tags/:tag/name",
    summary: "Rename a tag, and so on every agent and session carrying it",
    scope: "sessions:write",
    params: tagParams,
    body: tagNameInput,
    response: done,
    handler: ({ store, identity, params, body }) => {
      renameTag(store, identity, params.tag, body);
      return {};
    },
  }),
  operation({
    name: "recolorTag",
    method: "POST",
    path: "/tags/:tag/color",
    summary: "Give a tag another color",
    scope: "sessions:write",
    params: tagParams,
    body: colorInput,
    response: tagRead,
    handler: ({ store, identity, params, body }) => recolorTag(store, identity, params.tag, body),
  }),
  operation({
    name: "removeTag",
    method: "POST",
    path: "/tags/:tag/remove",
    summary: "Remove a tag, taking it off every agent and session carrying it",
    scope: "sessions:write",
    params: tagParams,
    response: done,
    handler: ({ store, identity, params }) => {
      removeTag(store, identity, params.tag);
      return {};
    },
  }),
  operation({
    name: "setSessionGroup",
    method: "POST",
    path: "/s/:agent/:session/group",
    summary: "Put a session in a group, or in none",
    scope: "sessions:write",
    params: sessionParams,
    body: sessionGroupInput,
    response: done,
    handler: ({ store, identity, params, body }) => {
      setSessionGroup(store, identity, params, body);
      return {};
    },
  }),
  operation({
    name: "setSessionTags",
    method: "POST",
    path: "/s/:agent/:session/tags",
    summary: "Set a session's tags",
    scope: "sessions:write",
    params: sessionParams,
    body: tagsInput,
    response: done,
    handler: ({ store, identity, params, body }) => {
      setSessionTags(store, identity, params, body);
      return {};
    },
  }),
  operation({
    name: "setAgentTags",
    method: "POST",
    path: "/agents/:agent/tags",
    summary: "Set an agent's tags",
    scope: "sessions:write",
    params: agentParams,
    body: tagsInput,
    response: done,
    handler: ({ store, identity, params, body }) => {
      setAgentTags(store, identity, params.agent, body);
      return {};
    },
  }),

  // sessions:read and sessions:approve
  operation({
    name: "listRegistrations",
    method: "GET",
    path: "/registrations",
    summary: "List agents' registrations, newest first, in pages",
    scope: "sessions:read",
    query: registrationsQuery,
    response: registrationsPage,
    handler: ({ store, identity, query }) => listRegistrations(store, identity, query),
  }),
  operation({
    name: "approveRegistration",
    method: "POST",
    path: "/registrations/:id/approve",
    summary:
      "Approve a pending registration for a new or existing session, which its key then acts " +
      "for, with the session's group and tags if given; approving onto an existing session " +
      "grants the key that session's whole history",
    scope: "sessions:approve",
    params: registrationParams,
    body: approveInput,
    response: registrationResult,
    handler: ({ store, identity, params, body }) =>
      approveRegistration(store, identity, params.id, body),
  }),
  operation({
    name: "rejectRegistration",
    method: "POST",
    path: "/registrations/:id/reject",
    summary: "Reject a pending registration",
    scope: "sessions:approve",
    params: registrationParams,
    response: registrationResult,
    handler: ({ store, identity, params }) => rejectRegistration(store, identity, params.id),
  }),
  operation({
    name: "revokeRegistration",
    method: "POST",
    path: "/registrations/:id/revoke",
    summary: "Revoke an approved registration, whose key then acts for no session",
    scope: "sessions:approve",
    params: registrationParams,
    response: registrationResult,
    handler: ({ store, identity, params }) => revokeRegistration(store, identity, params.id),
  }),
];
