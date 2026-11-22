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
import { query, sessionPath, uploadFile } from "../../../api.ts";
import { useUnauthenticatedCheck } from "../../../data.ts";
import { byteSize } from "../../../format.tsx";
import { useSession } from "../../../session.tsx";
import type { ThreadTarget } from "../writer.ts";

// The files of the composer's draft: those the operator chose or pasted,
// each uploaded as soon as it is added, and, on a replacement, the files of
// the message it replaces, kept unless removed. The draft keeps each File, so
// a failed or expired upload can be sent again. Nothing is uploaded for good
// until the message is sent: an upload no message names expires on the
// server, which says so when a write names it.
//
// Uploads run one at a time, in the order added. A browser opens only a few
// connections to one host, and the page's long poll and every read share
// them, so several uploads at once would hold the rest of the page up behind
// them; one at a time also leaves a file still waiting free to remove.

// How an added file's upload stands. An uploaded file waits on the server
// until a message names it; expired, the server no longer holds it.
export type UploadState =
  | { kind: "waiting" }
  | { kind: "uploading"; sent: number }
  | { kind: "uploaded"; upload: string }
  | { kind: "failed"; failure: unknown }
  | { kind: "expired" };

// A file of the draft: kept from the message a replacement replaces, by its
// name there; added, with its upload; or refused as it was added, saying
// why, without uploading.
export type DraftFile =
  | { id: number; kind: "kept"; name: string; size: number }
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

// The types a pasted image is attached as, with the extension its name takes.
const pastedTypes: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

// pastedImages gives the image files a paste of images alone holds, such as
// a screenshot's, which it attaches in place of inserting anything. A paste
// that carries text as well stays text, since some programs, such as a
// spreadsheet's cells, put a picture of what was copied beside its text.
export function pastedImages(data: DataTransfer | null): File[] {
  if (data === null || Array.from(data.types).includes("text/plain")) {
    return [];
  }
  return Array.from(data.files).filter((file) => Object.hasOwn(pastedTypes, file.type));
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

// What keeps the draft's files from being sent: a file refused, which the
// operator removes; one that did not upload, which they retry or remove; or
// uploads still to finish, the first of those under way counted among them.
export type FilesHold =
  | { kind: "refused" }
  | { kind: "failed" }
  | { kind: "uploading"; at: number; of: number }
  | undefined;

export function filesHold(files: readonly DraftFile[]): FilesHold {
  if (files.some((file) => file.kind === "refused")) {
    return { kind: "refused" };
  }
  const added = files.flatMap((file) => (file.kind === "added" ? [file.state.kind] : []));
  if (added.some((kind) => kind === "failed" || kind === "expired")) {
    return { kind: "failed" };
  }
  const done = added.filter((kind) => kind === "uploaded").length;
  return done === added.length ? undefined : { kind: "uploading", at: done + 1, of: added.length };
}

// holdWords says what keeps Send waiting on the draft's files.
export function holdWords(hold: NonNullable<FilesHold>): string {
  switch (hold.kind) {
    case "refused":
      return "A file cannot be attached: remove it.";
    case "failed":
      return "A file did not upload: retry or remove it.";
    case "uploading":
      return hold.of === 1 ? "Uploading the file." : `Uploading ${hold.at} of ${hold.of} files.`;
  }
}

// Why a file is refused as it is added, without uploading, if it is.
function refusal(name: string, size: number, count: number): string | undefined {
  if (!fileName.safeParse(name).success) {
    return "Its name cannot be used: rename the file and choose it again.";
  }
  if (size > maxFileBytes) {
    return `Over the ${byteSize(maxFileBytes)} a file may be.`;
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
  // keep loads a message's files as kept: the whole list, since a
  // replacement starts only from an empty composer.
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
  // The upload under way, if any.
  const running = useRef<{ id: number; controller: AbortController }>(undefined);

  const update = useCallback((id: number, state: UploadState) => {
    setFiles((current) =>
      current.map((file) => (file.id === id && file.kind === "added" ? { ...file, state } : file)),
    );
  }, []);

  // The next upload starts once none is under way: the first waiting.
  useEffect(() => {
    if (running.current !== undefined) {
      return;
    }
    const next = files.find((file) => file.kind === "added" && file.state.kind === "waiting");
    if (next?.kind !== "added") {
      return;
    }
    const controller = new AbortController();
    running.current = { id: next.id, controller };
    const done = () => {
      if (running.current?.id === next.id) {
        running.current = undefined;
      }
    };
    update(next.id, { kind: "uploading", sent: 0 });
    const path = sessionPath(target.agent, target.session, `/uploads${query({ name: next.name })}`);
    uploadFile(path, next.file, {
      type: next.type,
      csrf,
      signal: controller.signal,
      onProgress: (sent) => update(next.id, { kind: "uploading", sent }),
    }).then(
      (result) => {
        done();
        update(next.id, { kind: "uploaded", upload: result.upload });
      },
      (failure: unknown) => {
        done();
        // A removed file's upload was stopped, and is gone from the list.
        if (controller.signal.aborted) {
          return;
        }
        onFailure(failure);
        update(next.id, { kind: "failed", failure });
      },
    );
  }, [files, target.agent, target.session, csrf, update, onFailure]);

  // Leaving the page stops what is under way.
  useEffect(
    () => () => {
      running.current?.controller.abort();
      running.current = undefined;
    },
    [],
  );

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
    if (running.current?.id === id) {
      running.current.controller.abort();
      running.current = undefined;
    }
    setFiles((current) => current.filter((file) => file.id !== id));
  }, []);

  const retry = useCallback((id: number) => update(id, { kind: "waiting" }), [update]);
  const expire = useCallback((id: number) => update(id, { kind: "expired" }), [update]);

  const keep = useCallback((message: Message) => {
    setFiles(
      (message.attachments ?? []).map((each) => ({
        id: nextId.current++,
        kind: "kept",
        name: each.name,
        size: each.size,
      })),
    );
  }, []);

  const dropKept = useCallback(() => {
    setFiles((current) => current.filter((file) => file.kind !== "kept"));
  }, []);

  const sent = useCallback((ids: readonly number[]) => {
    setFiles((current) => current.filter((file) => !ids.includes(file.id)));
  }, []);

  return { files, add, remove, retry, keep, dropKept, expire, sent };
}
