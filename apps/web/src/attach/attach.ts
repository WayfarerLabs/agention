import {
  type Attachment,
  fileName,
  fileNameKey,
  maxAttachments,
  maxFileBytes,
  type Message,
  typeOfName,
} from "@wayfarerlabs/agention-api";
import { type ClipboardEvent, useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure, query, request, sessionPath, uploadFile } from "../api.ts";
import { useUnauthenticatedCheck } from "../data.ts";
import { byteSize } from "../format.tsx";
import { useSession } from "../session.tsx";

// The files of a message the operator is writing, in a thread's composer or
// the sheet that starts a thread: those the operator chose or pasted, each
// uploaded to the session as soon as it is added, and, on a replacement, the
// files of the message it replaces, kept unless removed. The draft keeps each File, so
// a failed or expired upload can be sent again. Nothing is uploaded for good
// until the message is sent: removing a file removes its upload from the
// server too, and so does leaving the writer without sending it, so an unsent
// upload stops counting against the operator's pending uploads. One left
// behind all the same, as when its removal fails, expires there, which the
// server says when a write names it.
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

// attachPasted gives a message box's paste handler: a paste holding images
// attaches them to the draft, named by when they were pasted, and inserts
// nothing; any other paste is the browser's own.
export function attachPasted(draft: DraftFiles) {
  return (event: ClipboardEvent<HTMLElement>) => {
    const images = pastedImages(event.clipboardData);
    if (images.length === 0) {
      return;
    }
    event.preventDefault();
    const at = new Date();
    draft.add(images.map((file) => ({ file, name: pastedName(file.type, at) })));
  };
}

// uniqueName gives name, or when another file of the draft has it, the name
// with -2, -3 and so on before its extension, since a message carries one
// file of each name.
function uniqueName(name: string, taken: ReadonlySet<string>): string {
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

// expireRefused marks the file a refusal of a write names as not uploaded,
// by its place among the ids of the files the write sent, as expired: the
// server no longer holds its upload, to upload again.
export function expireRefused(draft: DraftFiles, failure: unknown, sent: readonly number[]): void {
  const match =
    failure instanceof ApiFailure ? /^attachments\.(\d+)\.upload$/.exec(failure.field ?? "") : null;
  const id = match === null ? undefined : sent[Number(match[1])];
  if (id !== undefined) {
    draft.expire(id);
  }
}

// What keeps the draft's files from being sent: a file refused, which the
// operator removes; one that did not upload, which they retry or remove; or
// uploads still to finish, the first of those under way counted among them.
type FilesHold =
  | { kind: "refused" }
  | { kind: "failed" }
  | { kind: "uploading"; at: number; of: number }
  | undefined;

function filesHold(files: readonly DraftFile[]): FilesHold {
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
function holdWords(hold: NonNullable<FilesHold>): string {
  switch (hold.kind) {
    case "refused":
      return "A file cannot be attached: remove it.";
    case "failed":
      return "A file did not upload: retry or remove it.";
    case "uploading":
      return hold.of === 1 ? "Uploading the file." : `Uploading ${hold.at} of ${hold.of} files.`;
  }
}

// sendWait says what keeps Send waiting on a message the operator is
// writing, wherever they write it, or undefined when nothing does: its files,
// until each has uploaded, or a recording for it, until its text is in or it
// is discarded, so dictated words are never lost under a send. A recording
// counts while its microphone opens, and while it records, transcribes or
// awaits Retry.
export function sendWait(files: readonly DraftFile[], recording: boolean): string | undefined {
  const hold = filesHold(files);
  return hold !== undefined
    ? holdWords(hold)
    : recording
      ? "Finish or cancel dictation first."
      : undefined;
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
  // remove drops a file and its upload: it stops an upload with bytes still
  // to send, which the server then removes, and removes one the server may
  // have completed through its remove route, once it answers if it is still
  // under way, so it no longer counts against the operator's pending uploads.
  remove(id: number): void;
  // retry sends a failed or expired upload again.
  retry(id: number): void;
  // keep loads a message's files as kept: the whole list, since a
  // replacement starts only from an empty composer.
  keep(message: Message): void;
  // dropKept drops the kept files, which only the replacement staged
  // loaded, leaving those added.
  dropKept(): void;
  // expire marks an upload the server no longer holds as expired.
  expire(id: number): void;
  // carry runs send, a send of the files with these ids, and resolves to
  // what it resolves to. Leaving the writer leaves their uploads alone while
  // the send is on its way, since the server may yet attach them, and for
  // good once landed says it landed, and remove refuses them while the send
  // is on its way; a send that did not land frees them, unless another send
  // on its way carries them too, removing their uploads should the writer be
  // gone by then.
  carry<T>(
    ids: readonly number[],
    send: () => Promise<T>,
    landed: (result: T) => boolean,
  ): Promise<T>;
  // sent drops the files a message that landed sent.
  sent(ids: readonly number[]): void;
  // The ids of the files a send on its way carries, whose Remove waits.
  carried: ReadonlySet<number>;
}

// The upload under way. Removed once every byte has gone, it is left to
// answer, and its upload is then removed from the server.
interface Running {
  id: number;
  controller: AbortController;
  removed: boolean;
  // The bytes sent of the file's size, as the upload reports them, before
  // the list shows them.
  sent: number;
  size: number;
}

// stop stops the upload under way: while bytes remain it is aborted, so the
// server never completes it; once every byte has gone the server may have,
// so it is left to answer and then removed.
function stop(running: Running): void {
  if (running.sent >= running.size) {
    running.removed = true;
  } else {
    running.controller.abort();
  }
}

// useDraftFiles holds the draft's files for a message to a session, in one
// of its threads or starting one, and uploads those added, one at a time, to
// the session.
export function useDraftFiles(target: { agent: string; session: string }): DraftFiles {
  const { csrf } = useSession();
  const onFailure = useUnauthenticatedCheck();
  const [files, setFiles] = useState<DraftFile[]>([]);
  const nextId = useRef(1);
  const running = useRef<Running>(undefined);
  // How many sends carry each file, by its id: while each is on its way, and
  // for good once one landed. The list follows them, for Remove to wait.
  const carried = useRef(new Map<number, number>());
  const [carriedIds, setCarriedIds] = useState<ReadonlySet<number>>(new Set());
  // The upload each file holds on the server once its answer arrives, by the
  // file's id, before the list shows it, so a Remove or leaving the writer in
  // between still finds it.
  const finished = useRef(new Map<number, string>());
  // Whether the writer has gone: its page left, or its sheet closed.
  const left = useRef(false);

  // A removal that fails leaves the upload to expire, and says nothing: the
  // server refuses one a message attached, or one already gone, as not found.
  const removeUpload = useCallback(
    (upload: string) => {
      request("POST", sessionPath(target.agent, target.session, `/uploads/${upload}/remove`), {
        csrf,
      }).catch(onFailure);
    },
    [target.agent, target.session, csrf, onFailure],
  );

  // The removal leaving uses, as the writer last had it, since it runs after.
  const latestRemove = useRef(removeUpload);
  useEffect(() => {
    latestRemove.current = removeUpload;
  }, [removeUpload]);

  // removeUnsent removes from the server the finished uploads no send
  // carries, of the files with these ids, or of every file.
  const removeUnsent = useCallback((ids?: readonly number[]) => {
    for (const [id, upload] of finished.current) {
      if (!carried.current.has(id) && (ids === undefined || ids.includes(id))) {
        finished.current.delete(id);
        latestRemove.current(upload);
      }
    }
  }, []);

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
    const under: Running = {
      id: next.id,
      controller,
      removed: false,
      sent: 0,
      size: next.size,
    };
    running.current = under;
    const done = () => {
      if (running.current === under) {
        running.current = undefined;
      }
    };
    update(next.id, { kind: "uploading", sent: 0 });
    const path = sessionPath(target.agent, target.session, `/uploads${query({ name: next.name })}`);
    uploadFile(path, next.file, {
      type: next.type,
      csrf,
      signal: controller.signal,
      onProgress: (sent) => {
        under.sent = sent;
        update(next.id, { kind: "uploading", sent });
      },
    }).then(
      (result) => {
        done();
        // Stopped as its answer arrived, by Remove or leaving the writer,
        // the upload is the server's all the same, so it is removed.
        if (under.removed || controller.signal.aborted) {
          removeUpload(result.upload);
          return;
        }
        finished.current.set(next.id, result.upload);
        update(next.id, { kind: "uploaded", upload: result.upload });
      },
      (failure: unknown) => {
        done();
        // A removed file is gone from the list, its upload stopped or left
        // to answer.
        if (controller.signal.aborted || under.removed) {
          return;
        }
        onFailure(failure);
        update(next.id, { kind: "failed", failure });
      },
    );
  }, [files, target.agent, target.session, csrf, update, removeUpload, onFailure]);

  // Leaving the writer, by any way its page or sheet goes, stops the upload
  // under way and removes the finished uploads no send carries, so a draft
  // left unsent holds none of the operator's pending uploads. Kept files are
  // a sent message's, and a kept draft keeps no files. React's StrictMode
  // unmounts and mounts the writer once more as it first mounts, before any
  // file is added, so that removes nothing, and mounting again marks the
  // writer as not gone.
  useEffect(() => {
    left.current = false;
    return () => {
      left.current = true;
      const under = running.current;
      if (under !== undefined) {
        stop(under);
        running.current = undefined;
      }
      removeUnsent();
    };
  }, [removeUnsent]);

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
  // as the list changes. While bytes remain its upload is stopped, so the
  // server never completes it; once every byte has gone the server may have,
  // so it is left to answer and then removed, as a finished upload is when
  // its file leaves the list. Should a removal fail, the upload counts until
  // it expires, as the server's refusal of another upload then says.
  // A file a send on its way carries stays: the server may yet attach it.
  const remove = useCallback(
    (id: number) => {
      if (carried.current.has(id)) {
        return;
      }
      const upload = finished.current.get(id);
      finished.current.delete(id);
      if (running.current?.id === id) {
        stop(running.current);
        running.current = undefined;
      } else if (upload !== undefined) {
        removeUpload(upload);
      }
      setFiles((current) => current.filter((each) => each.id !== id));
    },
    [removeUpload],
  );

  const retry = useCallback((id: number) => update(id, { kind: "waiting" }), [update]);
  const expire = useCallback(
    (id: number) => {
      finished.current.delete(id);
      update(id, { kind: "expired" });
    },
    [update],
  );

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

  const carry = useCallback(
    async <T>(ids: readonly number[], send: () => Promise<T>, landed: (result: T) => boolean) => {
      const follow = () => setCarriedIds(new Set(carried.current.keys()));
      for (const id of ids) {
        carried.current.set(id, (carried.current.get(id) ?? 0) + 1);
      }
      follow();
      let kept = false;
      try {
        const result = await send();
        kept = landed(result);
        return result;
      } finally {
        if (!kept) {
          for (const id of ids) {
            const count = (carried.current.get(id) ?? 1) - 1;
            if (count > 0) {
              carried.current.set(id, count);
            } else {
              carried.current.delete(id);
            }
          }
          follow();
          if (left.current) {
            removeUnsent(ids);
          }
        }
      }
    },
    [removeUnsent],
  );

  const sent = useCallback((ids: readonly number[]) => {
    for (const id of ids) {
      finished.current.delete(id);
    }
    setFiles((current) => current.filter((file) => !ids.includes(file.id)));
  }, []);

  return {
    files,
    add,
    remove,
    retry,
    keep,
    dropKept,
    expire,
    carry,
    sent,
    carried: carriedIds,
  };
}
