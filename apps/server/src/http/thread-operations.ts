import {
  cursorsResult,
  done,
  fileParams,
  fileReadQuery,
  markInput,
  marksResult,
  messageSendInput,
  threadGetQuery,
  sessionParams,
  threadFilesPage,
  threadFilesQuery,
  threadGetResult,
  threadParams,
  unreadInput,
  uploadParams,
  uploadQuery,
  uploadResult,
  writeResult,
} from "@wayfarerlabs/agention-api";
import {
  archiveThread,
  getThread,
  listThreadFiles,
  markRead,
  markUnread,
  removeUpload,
  sendMessage,
} from "../store/index.ts";
import { fileBytes, serveFile } from "./files.ts";
import { operation } from "./operations.ts";
import { receiveUpload, uploadBytes } from "./uploads.ts";

// The operations on one thread and on its session's uploads, which every
// mount shares, so the role, message and file checks have one handler each.
// An agent's registration holds threads:write over its own session, so the
// scopes these require check the same way on every mount.
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
  operation({
    name: "uploadFile",
    method: "POST",
    path: "/s/:agent/:session/uploads",
    summary:
      "Upload a file to attach to a message in the session, which stays pending, yours " +
      "alone, until a message names it",
    scope: "threads:write",
    params: sessionParams,
    query: uploadQuery,
    body: uploadBytes,
    response: uploadResult,
    handler: ({ store, identity, params, query, request, log }) =>
      receiveUpload({ store, identity, target: params, name: query.name, request, log }),
  }),
  operation({
    name: "removeUpload",
    method: "POST",
    path: "/s/:agent/:session/uploads/:upload/remove",
    summary: "Remove one of your pending uploads, which no message has named yet",
    scope: "threads:write",
    params: uploadParams,
    response: done,
    handler: ({ store, identity, params }) => {
      removeUpload(store, identity, params, params.upload);
      return {};
    },
  }),
  operation({
    name: "listThreadFiles",
    method: "GET",
    path: "/s/:agent/:session/threads/:thread/files",
    summary: "List a thread's files, each once, with the message that brought it, in pages",
    scope: "threads:read",
    params: threadParams,
    query: threadFilesQuery,
    response: threadFilesPage,
    handler: ({ store, identity, params, query }) =>
      listThreadFiles(store, identity, params, query),
  }),
  operation({
    name: "readFile",
    method: "GET",
    path: "/s/:agent/:session/threads/:thread/messages/:seq/files/:name",
    summary:
      "Read a file a message carries, by the name it carries it under, whole or a range; " +
      "HEAD answers as GET does, without the bytes",
    scope: "threads:read",
    params: fileParams,
    query: fileReadQuery,
    response: fileBytes,
    handler: ({ store, identity, params, query, request, log }) =>
      serveFile({ store, identity, target: { ...params, ref: query.file }, request, log }),
  }),
];
