import {
  type Attachment,
  fileName,
  fileNameKey,
  maxAttachments,
  maxFileBytes,
  type Message,
  typeOfName,
} from "@wayfarerlabs/agention-api";
import { useCallback, useEffect, useRef, useState } from "react";
import { sessionPath, uploadFile, query } from "../../../api.ts";
import { useUnauthenticatedCheck } from "../../../data.ts";
import { useSession } from "../../../session.tsx";
import type { ThreadTarget } from "../writer.ts";

// The files of the composer's draft: those the operator chose or pasted,
// each uploaded as soon as it is added, one at a time in the order added, so
// one file fills the link at once; and, on a replacement, the files of the
// message it replaces, kept unless removed. The draft keeps each File, so a
// failed or expired upload can be sent again. Nothing is uploaded for good
// until the message is sent: an upload no message names expires on the
// server.

// How an added file's upload stands. An uploaded file waits on the server
// until expiresAt, in milliseconds, and expires there after it.
export type UploadState =
  | { kind: "waiting" }
  | { kind: "uploading"; sent: number }
  | { kind: "uploaded"; upload: string; expiresAt: number }
  | { kind: "failed"; failure: unknown }
  | { kind: "expired" };

// A file of the draft: kept from the message a replacement replaces, by its
// name there; added, with its upload; or refused as it was added, saying
// why, without uploading.
export type DraftFile =
  | { id: number; kind: "kept"; name: string; size: number; type: string }
  | {
      id: number;
      kind: "added";
      name: string;
      size: number;
      type: string;
      file: File;
      state: UploadState;
    }
  | { id: number; kind: "refused"; name: string; size: number; why: string };

// stateOf says how an added file's upload stands now: an upload past its
// expiry has expired, though the draft last heard it uploaded.
export function stateOf(state: UploadState, now = Date.now()): UploadState {
  return state.kind === "uploaded" && state.expiresAt <= now ? { kind: "expired" } : state;
}

// The types a pasted image is attached as, with the extension its name takes.
const pastedTypes: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

// pastedImages gives the image files a paste holds, which it attaches in
// place of inserting anything.
export function pastedImages(data: DataTransfer | null): File[] {
  return Array.from(data?.files ?? []).filter((file) => Object.hasOwn(pastedTypes, file.type));
}

const twoDigits = (value: number) => String(value).padStart(2, "0");

// pastedName names a pasted image by when it was pasted, in local time, as
// pasted-YYYYMMDD-HHMMSS with its type's extension.
export function pastedName(type: string, at: Date): string {
  const date = `${at.getFullYear()}${twoDigits(at.getMonth() + 1)}${twoDigits(at.getDate())}`;
  const time = `${twoDigits(at.getHours())}${twoDigits(at.getMinutes())}${twoDigits(at.getSeconds())}`;
  return `pasted-${date}-${time}.${pastedTypes[type] ?? "bin"}`;
}

// uniqueName gives name, or when another file of the draft has it, the name
// with -2, -3 and so on before its extension, since a message carries one
// file of each name.
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(fileNameKey(name))) {
    return name;
  }
  const dot = name.lastIndexOf(".");
  const [stem, extension] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let count = 2; ; count++) {
    const candidate = `${stem}-${count}${extension}`;
    if (!taken.has(fileNameKey(candidate))) {
      return candidate;
    }
  }
}

// attachmentsOf gives what a message sends of the draft's files, kept files
// as {keep}, then uploads as {upload, name}, in the list's order, and the ids
// of the files it sends, in the same order, which a refusal names by place.
export function attachmentsOf(files: readonly DraftFile[]): {
  attachments: Attachment[];
  ids: number[];
} {
  const kept = files.flatMap((file) => (file.kind === "kept" ? [file] : []));
  const uploaded = files.flatMap((file) =>
    file.kind === "added" && file.state.kind === "uploaded"
      ? [{ id: file.id, upload: file.state.upload, name: file.name }]
      : [],
  );
  return {
    attachments: [
      ...kept.map((file) => ({ keep: file.name })),
      ...uploaded.map(({ upload, name }) => ({ upload, name })),
    ],
    ids: [...kept.map((file) => file.id), ...uploaded.map((file) => file.id)],
  };
}

// What keeps the draft's files from being sent: uploads still to finish, the
// first of those under way counted among them, or a file that did not
// upload, which the operator retries or removes.
export type FilesHold =
  { kind: "uploading"; at: number; of: number } | { kind: "problem" } | undefined;

export function filesHold(files: readonly DraftFile[], now = Date.now()): FilesHold {
  const added = files.flatMap((file) =>
    file.kind === "added" ? [stateOf(file.state, now).kind] : [],
  );
  if (
    files.some((file) => file.kind === "refused") ||
    added.some((kind) => kind === "failed" || kind === "expired")
  ) {
    return { kind: "problem" };
  }
  const done = added.filter((kind) => kind === "uploaded").length;
  return done === added.length ? undefined : { kind: "uploading", at: done + 1, of: added.length };
}

// The largest file, in MiB, as the limits are said.
export const maxFileMiB = maxFileBytes / 1024 / 1024;

// Why a file is refused as it is added, without uploading, if it is.
function refusal(name: string, size: number, count: number): string | undefined {
  if (!fileName.safeParse(name).success) {
    return "Its name cannot be used: rename the file and choose it again.";
  }
  if (size > maxFileBytes) {
    return `Over the ${maxFileMiB} MiB a file may be.`;
  }
  if (count >= maxAttachments) {
    return `Over the ${maxAttachments} files a message carries.`;
  }
  return undefined;
}

export interface DraftFiles {
  files: DraftFile[];
  // add adds files, each under the name given, made unique in the draft,
  // and uploads them in turn; one that breaks a limit is refused.
  add(added: { file: File; name: string }[]): void;
  // remove drops a file, stopping its upload under way, which the server
  // then removes; an upload finished is left to expire.
  remove(id: number): void;
  // retry sends a failed or expired upload again.
  retry(id: number): void;
  // keep loads a message's files as kept, in place of any kept before.
  keep(message: Message): void;
  // dropKept drops every kept file, leaving those added.
  dropKept(): void;
  // expire marks an upload the server no longer holds as expired.
  expire(id: number): void;
  // sent drops the files a message that landed sent.
  sent(ids: readonly number[]): void;
}

// useDraftFiles holds the draft's files for a thread's composer and uploads
// those added, one at a time, to the thread's session.
export function useDraftFiles(target: ThreadTarget): DraftFiles {
  const { csrf } = useSession();
  const onFailure = useUnauthenticatedCheck();
  const [files, setFiles] = useState<DraftFile[]>([]);
  const nextId = useRef(1);
  const uploads = useRef(new Map<number, AbortController>());

  const update = useCallback((id: number, state: UploadState) => {
    setFiles((current) =>
      current.map((file) => (file.id === id && file.kind === "added" ? { ...file, state } : file)),
    );
  }, []);

  // The next upload starts once none is under way: the first waiting.
  useEffect(() => {
    if (uploads.current.size > 0) {
      return;
    }
    const next = files.find((file) => file.kind === "added" && file.state.kind === "waiting");
    if (next?.kind !== "added") {
      return;
    }
    const controller = new AbortController();
    uploads.current.set(next.id, controller);
    update(next.id, { kind: "uploading", sent: 0 });
    const path = sessionPath(target.agent, target.session, `/uploads${query({ name: next.name })}`);
    uploadFile(path, next.file, {
      type: next.type,
      csrf,
      signal: controller.signal,
      onProgress: (sent) => update(next.id, { kind: "uploading", sent }),
    }).then(
      (result) => {
        uploads.current.delete(next.id);
        update(next.id, {
          kind: "uploaded",
          upload: result.upload,
          expiresAt: Date.parse(result.expires_at),
        });
      },
      (failure: unknown) => {
        uploads.current.delete(next.id);
        if (controller.signal.aborted) {
          return;
        }
        onFailure(failure);
        update(next.id, { kind: "failed", failure });
      },
    );
  }, [files, target.agent, target.session, csrf, update, onFailure]);

  // Leaving the page stops what is under way.
  useEffect(() => {
    const running = uploads.current;
    return () => {
      for (const controller of running.values()) {
        controller.abort();
      }
      running.clear();
    };
  }, []);

  const add = useCallback((added: { file: File; name: string }[]) => {
    setFiles((current) => {
      const listed = [...current];
      for (const { file, name: given } of added) {
        const taken = new Set(
          listed.flatMap((each) => (each.kind === "refused" ? [] : [fileNameKey(each.name)])),
        );
        const name = uniqueName(given, taken);
        const count = listed.filter((each) => each.kind !== "refused").length;
        const why = refusal(name, file.size, count);
        const id = nextId.current++;
        listed.push(
          why === undefined
            ? {
                id,
                kind: "added",
                name,
                size: file.size,
                type: file.type === "" ? typeOfName(name) : file.type,
                file,
                state: { kind: "waiting" },
              }
            : { id, kind: "refused", name: given, size: file.size, why },
        );
      }
      return listed;
    });
  }, []);

  // Removing the file under way frees the queue at once, so the next starts
  // as the list changes.
  const remove = useCallback((id: number) => {
    uploads.current.get(id)?.abort();
    uploads.current.delete(id);
    setFiles((current) => current.filter((file) => file.id !== id));
  }, []);

  const retry = useCallback((id: number) => update(id, { kind: "waiting" }), [update]);
  const expire = useCallback((id: number) => update(id, { kind: "expired" }), [update]);

  const keep = useCallback((message: Message) => {
    setFiles((current) => [
      ...(message.attachments ?? []).map((each): DraftFile => ({
        id: nextId.current++,
        kind: "kept",
        name: each.name,
        size: each.size,
        type: each.type,
      })),
      ...current.filter((file) => file.kind !== "kept"),
    ]);
  }, []);

  const dropKept = useCallback(() => {
    setFiles((current) => current.filter((file) => file.kind !== "kept"));
  }, []);

  const sent = useCallback((ids: readonly number[]) => {
    setFiles((current) => current.filter((file) => !ids.includes(file.id)));
  }, []);

  return { files, add, remove, retry, keep, dropKept, expire, sent };
}
