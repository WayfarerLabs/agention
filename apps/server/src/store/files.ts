import {
  type FileTotals,
  formatTimestamp,
  maxPendingBytes,
  maxPendingFiles,
  pendingLifetime,
  servedTypeOf,
  type UploadResult,
} from "@wayfarerlabs/agention-api";
import { randomBytes } from "node:crypto";
import type { Database } from "../database/database.ts";
import { invalidInput, notFound } from "../errors.ts";
import { authorize, authorizeScope, type Identity } from "../identity.ts";
import { resolveSession } from "./directory.ts";
import type { Store } from "./store.ts";
import type { SessionTarget } from "./threads.ts";

// Uploads: a file's bytes arrive a chunk per transaction, so other requests
// run between them and a revoked credential stops an upload within a chunk.
// Uploading is writing to a thread's session, so every step requires
// threads:write. An upload is pending until a message names it, and is
// removed by Abort
// when it fails, by its writer, or by the sweep once it expires or was left
// incomplete.

// Every file is stored in chunks of this many bytes, all full but its last.
// A release that changes it adds a per-file column in a migration of its own,
// defaulting to this value, so every older row still reads right.
export const chunkBytes = 1024 * 1024;

// An upload in progress: the file row Begin made, and who is uploading it.
export interface Upload {
  id: number;
  ref: string;
  name: string;
  type: string;
  size: number;
  identity: Identity;
}

// beginUpload authorizes the session and starts an upload of a file of the
// declared size, refusing it while the writer holds maxPendingFiles pending
// uploads or would hold more than maxPendingBytes with it, counting those
// still arriving and not those expired. Its id joins the uploads in flight,
// which the sweep never removes.
export function beginUpload(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  file: { name: string; type: string; size: number },
): Upload {
  const { db } = store;
  const upload = db.transaction(() => {
    const now = store.clock();
    const sessionId = authorize(
      db,
      identity,
      "threads:write",
      resolveSession(db, target.agent, target.session),
      now,
    );
    const held = db
      .prepare(
        `SELECT count(*) AS files, COALESCE(SUM(size), 0) AS bytes FROM files
         WHERE actor_id = ? AND attached_at IS NULL
           AND (completed_at IS NULL OR completed_at > ?)`,
      )
      .get(identity.actor, now - pendingLifetime) as { files: number; bytes: number };
    if (held.files >= maxPendingFiles) {
      throw invalidInput(
        undefined,
        `you hold ${maxPendingFiles} uploads that no message names yet, the most a writer may: ` +
          "name them in a message first, or upload again once they expire",
      );
    }
    if (held.bytes + file.size > maxPendingBytes) {
      throw invalidInput(
        undefined,
        `with this file, your uploads that no message names yet would take more than ` +
          `${maxPendingBytes / 1024 ** 3} GiB, the most a writer may hold: name them in a message ` +
          "first, or upload again once they expire",
      );
    }
    const ref = randomBytes(16).toString("base64url");
    const { id } = db
      .prepare(
        `INSERT INTO files (ref, name, type, size, actor_id, session_id, registration_id,
           created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .get(
        ref,
        file.name,
        file.type,
        file.size,
        identity.actor,
        sessionId,
        identity.credential.kind === "registration" ? identity.credential.registrationId : null,
        now,
      ) as { id: number };
    return { id, ref, ...file, identity };
  });
  store.uploadsInFlight.add(upload.id);
  return upload;
}

// writeChunk stores one chunk of an upload's bytes, at its index, once the
// credential and its scope are checked again.
export function writeChunk(store: Store, upload: Upload, index: number, data: Uint8Array): void {
  store.db.transaction(() => {
    authorizeScope(store.db, upload.identity, "threads:write", store.clock());
    store.db
      .prepare("INSERT INTO file_chunks (file_id, idx, data) VALUES (?, ?, ?)")
      .run(upload.id, index, data);
  });
}

// completeUpload completes an upload whose bytes received number its
// declared size, with their SHA-256, and answers with the pending file.
export function completeUpload(
  store: Store,
  upload: Upload,
  received: number,
  sha256: Uint8Array,
): UploadResult {
  const completedAt = store.db.transaction(() => {
    const now = store.clock();
    authorizeScope(store.db, upload.identity, "threads:write", now);
    if (received !== upload.size) {
      throw invalidInput(
        undefined,
        `the body held ${received} bytes, but its Content-Length said ${upload.size}`,
      );
    }
    store.db
      .prepare("UPDATE files SET sha256 = ?, completed_at = ? WHERE id = ?")
      .run(sha256, now, upload.id);
    return now;
  });
  store.uploadsInFlight.delete(upload.id);
  return {
    upload: upload.ref,
    name: upload.name,
    size: upload.size,
    type: upload.type,
    served_type: servedTypeOf(upload.type),
    expires_at: formatTimestamp(completedAt + pendingLifetime),
  };
}

// removeUpload removes one of the writer's own completed uploads that no
// message names, uploaded in the session named, with its bytes, so it leaves
// the writer's pending limits at once. Any other reference, another writer's
// upload, another session's, one attached, one still arriving or one that
// names nothing, is not_found in the same words, so a reference learned
// elsewhere tells nothing. An upload still arriving has not yet answered with
// its reference: its writer stops it by ending the request.
export function removeUpload(
  store: Store,
  identity: Identity,
  target: SessionTarget,
  ref: string,
): void {
  const { db } = store;
  db.transaction(() => {
    const sessionId = authorize(
      db,
      identity,
      "threads:write",
      resolveSession(db, target.agent, target.session),
      store.clock(),
    );
    const file = db
      .prepare(
        `SELECT id FROM files
         WHERE ref = ? AND actor_id = ? AND session_id = ?
           AND completed_at IS NOT NULL AND attached_at IS NULL`,
      )
      .get(ref, identity.actor, sessionId) as { id: number } | undefined;
    if (file === undefined) {
      throw notFound("upload");
    }
    deletePending(db, file.id);
  });
}

// removePending removes a file no message names, with its bytes, in one
// transaction.
export function removePending(db: Database, id: number): void {
  db.transaction(() => deletePending(db, id));
}

// deletePending deletes a file no message names, with its bytes, inside the
// caller's transaction. The triggers refuse it for a file a message names.
function deletePending(db: Database, id: number): void {
  db.prepare("DELETE FROM file_chunks WHERE file_id = ?").run(id);
  db.prepare("DELETE FROM files WHERE id = ?").run(id);
}

// abortUpload removes an upload that failed after it began, whatever the
// failure. An Abort that itself fails is logged and leaves the rows for the
// sweep, which the upload's leaving the uploads in flight allows.
export function abortUpload(store: Store, upload: Upload, log: (message: string) => void): void {
  try {
    removePending(store.db, upload.id);
  } catch (error) {
    log(`cannot remove a failed upload, which the sweep will: ${(error as Error).message}`);
  } finally {
    store.uploadsInFlight.delete(upload.id);
  }
}

// bytesArriving sums the bytes still to arrive across every incomplete
// upload. An incomplete file's chunks are all full ones, its last being
// written only at the end, so the sum is exact.
export function bytesArriving(store: Store): number {
  return store.db.transaction(() => {
    const { bytes } = store.db
      .prepare(
        `SELECT COALESCE(SUM(
           f.size - (SELECT count(*) FROM file_chunks c WHERE c.file_id = f.id) * ${chunkBytes}
         ), 0) AS bytes FROM files f WHERE f.completed_at IS NULL`,
      )
      .get() as { bytes: number };
    return bytes;
  });
}

// storageTotals counts every file the database holds, pending uploads
// included, since that is the disk they take, and their bytes. An upload
// still arriving is not yet a file.
export function storageTotals(db: Database): FileTotals {
  return db
    .prepare(
      `SELECT count(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM files
       WHERE completed_at IS NOT NULL`,
    )
    .get() as unknown as FileTotals;
}
