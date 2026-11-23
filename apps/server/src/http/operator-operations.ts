import { writeResult } from "@wayfarerlabs/agention-api";
import {
  agentParams,
  approveInput,
  bulkArchiveResult,
  bulkMarkInput,
  bulkReadResult,
  done,
  groupNameInput,
  groupParams,
  groupRef,
  groupsAndTags,
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
  tagNameInput,
  tagParams,
  tagsInput,
  threadCounts,
  threadFilters,
  threadList,
  threadStartInput,
  threadsQuery,
} from "@wayfarerlabs/agention-server-api";
import {
  approveRegistration,
  bulkArchive,
  bulkRead,
  countThreads,
  createGroup,
  listGroupsAndTags,
  listRegistrations,
  listSessions,
  listThreads,
  readSessionLog,
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
import { threadOperations } from "./thread-operations.ts";

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
  // The operator's long poll, the agent's waitForThreads across every
  // session. It ends when a message it reports commits, the credential is
  // revoked or expires, the client disconnects, the server shuts down or the
  // wait ends.
  operation({
    name: "waitForThreads",
    method: "GET",
    path: "/wait",
    summary: "Wait for messages you have not read, in any session, since a cursor",
    scope: "threads:read",
    query: operatorWaitQuery,
    response: operatorWaitResult,
    handler: ({ store, identity, query, signal }) =>
      waitForEverySession(store, identity, query, signal),
  }),
  ...threadOperations,
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
    summary: "List the session groups and the tags in use",
    scope: "sessions:read",
    response: groupsAndTags,
    handler: ({ store, identity }) => listGroupsAndTags(store, identity),
  }),
  operation({
    name: "createGroup",
    method: "POST",
    path: "/groups",
    summary: "Create an empty session group",
    scope: "sessions:write",
    body: groupNameInput,
    response: groupRef,
    handler: ({ store, identity, body }) => createGroup(store, identity, body),
  }),
  operation({
    name: "renameGroup",
    method: "POST",
    path: "/groups/:id/name",
    summary: "Rename a session group",
    scope: "sessions:write",
    params: groupParams,
    body: groupNameInput,
    response: groupRef,
    handler: ({ store, identity, params, body }) => renameGroup(store, identity, params.id, body),
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
    name: "renameTag",
    method: "POST",
    path: "/tags/:tag/name",
    summary: "Rename a tag on every agent and session carrying it",
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
    name: "removeTag",
    method: "POST",
    path: "/tags/:tag/remove",
    summary: "Remove a tag from every agent and session carrying it",
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
      "for; approving onto an existing session grants the key that session's whole history",
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
