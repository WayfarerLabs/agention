import {
  fileNameKey,
  formatTimestamp,
  type ThreadFilesPage,
  type ThreadFilesQuery,
} from "@wayfarerlabs/agention-api";
import { ApiError, notFound } from "../errors.ts";
import { checkCredential, type Identity } from "../identity.ts";
import { attachmentOfRow, missingFile } from "./attachments.ts";
import { authorOf } from "./directory.ts";
import { decodeCursor, encodeCursor } from "./opaque-cursors.ts";
import type { Store } from "./store.ts";
import { authorizeSession, requireThread, type ThreadTarget } from "./threads.ts";
import { pageOf } from "./thread-reads.ts";

// Reads of a thread's files: its list, and a file's bytes by its message and
// name, for whoever may read the thread.

// listThreadFiles reads a page of a thread's files, each once, with the
// first message that carried it, which brought it: newest first by that
// message, then in that message's order.
export function listThreadFiles(
  store: Store,
  identity: Identity,
  target: ThreadTarget,
  query: ThreadFilesQuery,
): ThreadFilesPage {
  const { db } = store;
  return db.transaction(() => {
    const sessionId = authorizeSession(db, identity, target, store.clock());
    const thread = requireThread(db, sessionId, target.thread);
    const [seq, position] =
      query.cursor === undefined
        ? [Number.MAX_SAFE_INTEGER, -1]
        : (decodeCursor("thread_files", query.cursor, ["number", "number"], "cursor") as [
            number,
            number,
          ]);
    const rows = db
      .prepare(
        `SELECT a.seq, a.position, a.name, f.ref, f.size, f.type, ${missingFile("f")} AS missing,
           m.actor_id, m.created_at
         FROM attachments a
         JOIN files f ON f.id = a.file_id
         JOIN messages m ON m.thread_id = a.thread_id AND m.seq = a.seq
         WHERE a.thread_id = :thread
           AND NOT EXISTS (SELECT 1 FROM attachments e
             WHERE e.file_id = a.file_id AND e.thread_id = a.thread_id AND e.seq < a.seq)
           AND (a.seq < :seq OR (a.seq = :seq AND a.position > :position))
         ORDER BY a.seq DESC, a.position
         LIMIT :limit`,
      )
      .all({ thread: thread.id, seq, position, limit: query.limit + 1 }) as unknown as {
      seq: number;
      position: number;
      name: string;
      ref: string;
      size: number;
      type: string;
      missing: number;
      actor_id: number;
      created_at: number;
    }[];
    const page = pageOf(rows, query.limit);
    const last = page.rows.at(-1);
    return {
      files: page.rows.map((row) => ({
        ...attachmentOfRow(row),
        seq: row.seq,
        author: authorOf(db, row.actor_id),
        created_at: formatTimestamp(row.created_at),
      })),
      ...(page.more && last !== undefined
        ? { next: encodeCursor("thread_files", [last.seq, last.position]) }
        : {}),
    };
  });
}

// A file as a message carries it, ready to serve.
export interface CarriedFile {
  id: number;
  name: string;
  size: number;
  type: string;
  sha256: Uint8Array;
}

// findCarriedFile finds the file a thread's message carries under a name,
// compared as names are, all in one snapshot: an unknown thread, message or
// name is not_found, as is a ref that does not name that file, and so is a
// file whose contents are gone, saying so.
export function findCarriedFile(
  store: Store,
  identity: Identity,
  target: ThreadTarget & { seq: number; name: string; ref: string | undefined },
): CarriedFile {
  const { db } = store;
  return db.transaction(() => {
    const sessionId = authorizeSession(db, identity, target, store.clock());
    const thread = requireThread(db, sessionId, target.thread);
    const carried = (
      db
        .prepare(
          `SELECT f.id, a.name, f.ref, f.size, f.type, f.sha256, ${missingFile("f")} AS missing
           FROM attachments a JOIN files f ON f.id = a.file_id
           WHERE a.thread_id = ? AND a.seq = ?`,
        )
        .all(thread.id, target.seq) as unknown as (CarriedFile & {
        ref: string;
        missing: number;
      })[]
    ).find((each) => fileNameKey(each.name) === fileNameKey(target.name));
    if (carried === undefined || (target.ref !== undefined && carried.ref !== target.ref)) {
      throw notFound();
    }
    if (carried.missing === 1) {
      throw new ApiError("not_found", "this file's contents are missing");
    }
    const { id, name, size, type, sha256 } = carried;
    return { id, name, size, type, sha256 };
  });
}

// readFileChunk reads one chunk of a file, at its index, once the credential
// is checked again, or undefined when that chunk is gone.
export function readFileChunk(
  store: Store,
  identity: Identity,
  fileId: number,
  index: number,
): Uint8Array | undefined {
  return store.db.transaction(() => {
    checkCredential(store.db, identity, store.clock());
    const row = store.db
      .prepare("SELECT data FROM file_chunks WHERE file_id = ? AND idx = ?")
      .get(fileId, index) as { data: Uint8Array } | undefined;
    return row?.data;
  });
}
