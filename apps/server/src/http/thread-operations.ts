import {
  cursorsResult,
  markInput,
  marksResult,
  messageSendInput,
  threadGetQuery,
  threadGetResult,
  threadParams,
  unreadInput,
  writeResult,
} from "@wayfarerlabs/agention-api";
import { archiveThread, getThread, markRead, markUnread, sendMessage } from "../store/index.ts";
import { operation } from "./operations.ts";

// The operations on one thread, which every mount shares, so the role and
// message checks have one handler each. An agent's registration holds
// threads:write over its own session, so the scopes these require check the
// same way on every mount.
export const threadOperations = [
  operation({
    name: "getThread",
    method: "GET",
    path: "/s/:agent/:session/threads/:thread",
    summary: "Read a thread with a page of its messages",
    scope: "threads:read",
    params: threadParams,
    query: threadGetQuery,
    response: threadGetResult,
    handler: ({ store, identity, params, query }) => getThread(store, identity, params, query),
  }),
  operation({
    name: "sendMessage",
    method: "POST",
    path: "/s/:agent/:session/threads/:thread/messages",
    summary: "Write a message in a thread: asks, answers, withdrawals, text and references",
    scope: "threads:write",
    params: threadParams,
    body: messageSendInput,
    response: writeResult,
    handler: ({ store, identity, params, body }) => sendMessage(store, identity, params, body),
  }),
  operation({
    name: "markRead",
    method: "POST",
    path: "/s/:agent/:session/threads/:thread/read",
    summary: "Mark a thread read through a message",
    scope: "threads:write",
    params: threadParams,
    body: markInput,
    response: cursorsResult,
    handler: ({ store, identity, params, body }) => markRead(store, identity, params, body),
  }),
  operation({
    name: "markUnread",
    method: "POST",
    path: "/s/:agent/:session/threads/:thread/unread",
    summary: "Mark a thread unread from a message on",
    scope: "threads:write",
    params: threadParams,
    body: unreadInput,
    response: cursorsResult,
    handler: ({ store, identity, params, body }) => markUnread(store, identity, params, body),
  }),
  operation({
    name: "archiveThread",
    method: "POST",
    path: "/s/:agent/:session/threads/:thread/archive",
    summary: "Archive a thread through a message",
    scope: "threads:write",
    params: threadParams,
    body: markInput,
    response: marksResult,
    handler: ({ store, identity, params, body }) => archiveThread(store, identity, params, body),
  }),
];
