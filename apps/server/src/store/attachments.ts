import {
  type Attachment,
  type AttachmentRead,
  fileNameKey,
  type FileTotals,
  pendingLifetime,
} from "@wayfarerlabs/agention-api";
import type { Database } from "../database/database.ts";
import { invalidInput } from "../errors.ts";
import { chunkBytes } from "./files.ts";

// The files a message carries: the rules a write's attachments obey, writing
// them, and reading them back as a message, a thread and the server count
// them.

// missingFile is the SQL condition that a file of the files table, under the
// alias given, has lost its contents: its last chunk is gone. A purge removes
// every chunk of a file, so that one lookup finds what it leaves; a zero-byte
// file is never missing.
export function missingFile(alias: string): string {
  return (
    `(${alias}.size > 0 AND NOT EXISTS (SELECT 1 FROM file_chunks c ` +
    `WHERE c.file_id = ${alias}.id AND c.idx = (${alias}.size - 1) / ${chunkBytes}))`
  );
}

// A file a write attaches, under the name it carries it by.
export interface ResolvedAttachment {
  name: string;
  fileId: number;
}

// What a write's attachments are checked against: the session the message
// is written in, the message it replaces, if any, and the time.
export interface AttachmentContext {
  sessionId: number;
  replaced: { threadId: number; seq: number } | undefined;
  actor: number;
  now: number;
}

// checkAttachments resolves a write's attachments to the files they name,
// in order: each upload one of the writer's own, uploaded in the message's
// session, complete, not yet attached and not expired; each kept file one
// the replaced message carries, under its name there. Any other upload,
// another writer's or another session's included, is refused in the same
// words, so a reference learned elsewhere tells nothing. The names resolved
// are distinct after NFC normalization.
export function checkAttachments(
  db: Database,
  context: AttachmentContext,
  attachments: Attachment[] | undefined,
): ResolvedAttachment[] {
  if (attachments === undefined) {
    return [];
  }
  const kept =
    context.replaced === undefined
      ? []
      : (db
          .prepare(
            `SELECT name, file_id FROM attachments WHERE thread_id = ? AND seq = ?
             ORDER BY position`,
          )
          .all(context.replaced.threadId, context.replaced.seq) as {
          name: string;
          file_id: number;
        }[]);
  const pending = db.prepare(
    `SELECT id, name FROM files
     WHERE ref = :ref AND actor_id = :actor AND session_id = :session
       AND completed_at IS NOT NULL AND attached_at IS NULL AND completed_at > :expired`,
  );
  const names = new Set<string>();
  return attachments.map((attachment, index) => {
    const field = `attachments.${index}`;
    let resolved: ResolvedAttachment;
    if (attachment.upload !== undefined) {
      const file = pending.get({
        ref: attachment.upload,
        actor: context.actor,
        session: context.sessionId,
        expired: context.now - pendingLifetime,
      }) as { id: number; name: string } | undefined;
      if (file === undefined) {
        throw invalidInput(
          `${field}.upload`,
          "names no upload of yours waiting to be attached in this session: upload the file again",
        );
      }
      resolved = { name: attachment.name ?? file.name, fileId: file.id };
    } else {
      const keep = attachment.keep ?? "";
      if (context.replaced === undefined) {
        throw invalidInput(`${field}.keep`, "keeps a file only on a message that replaces another");
      }
      const carried = kept.find((each) => fileNameKey(each.name) === fileNameKey(keep));
      if (carried === undefined) {
        throw invalidInput(`${field}.keep`, `names no file of message ${context.replaced.seq}`);
      }
      resolved = { name: carried.name, fileId: carried.file_id };
    }
    const key = fileNameKey(resolved.name);
    if (names.has(key)) {
      throw invalidInput(`${field}.name`, "another file of this message has this name");
    }
    names.add(key);
    return resolved;
  });
}

// insertAttachments writes a message's attachments in order, which marks
// each file attached as its message names it.
export function insertAttachments(
  db: Database,
  threadId: number,
  seq: number,
  attachments: ResolvedAttachment[],
): void {
  const insert = db.prepare(
    `INSERT INTO attachments (thread_id, seq, position, name, file_id)
     VALUES (?, ?, ?, ?, ?)`,
  );
  attachments.forEach((attachment, position) => {
    insert.run(threadId, seq, position, attachment.name, attachment.fileId);
  });
}

// readAttachments reads the attachments of a thread's messages after one
// sequence through another, by message, each message's in its order.
export function readAttachments(
  db: Database,
  span: { thread: number; after: number; last: number },
): Map<number, AttachmentRead[]> {
  const rows = db
    .prepare(
      `SELECT a.seq, a.name, f.ref, f.size, f.type, ${missingFile("f")} AS missing
       FROM attachments a JOIN files f ON f.id = a.file_id
       WHERE a.thread_id = :thread AND a.seq > :after AND a.seq <= :last
       ORDER BY a.seq, a.position`,
    )
    .all(span) as unknown as {
    seq: number;
    name: string;
    ref: string;
    size: number;
    type: string;
    missing: number;
  }[];
  const bySeq = new Map<number, AttachmentRead[]>();
  for (const row of rows) {
    bySeq.set(row.seq, [...(bySeq.get(row.seq) ?? []), attachmentRead(row)]);
  }
  return bySeq;
}

export function attachmentRead(row: {
  name: string;
  ref: string;
  size: number;
  type: string;
  missing: number;
}): AttachmentRead {
  return {
    name: row.name,
    file: row.ref,
    size: row.size,
    type: row.type,
    ...(row.missing === 1 ? { missing: true as const } : {}),
  };
}

// threadFileTotals counts a thread's distinct files, each once however many
// of its messages carry it, and their bytes.
export function threadFileTotals(db: Database, threadId: number): FileTotals {
  return db
    .prepare(
      `SELECT count(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM files
       WHERE id IN (SELECT file_id FROM attachments WHERE thread_id = ?)`,
    )
    .get(threadId) as unknown as FileTotals;
}
