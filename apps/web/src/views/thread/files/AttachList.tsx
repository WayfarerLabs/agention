import { maxAttachments, maxFileBytes } from "@wayfarerlabs/agention-api";
import { type RefObject, useId, useLayoutEffect, useRef } from "react";
import { describeFailure } from "../../../api.ts";
import { byteSize } from "../../../format.tsx";
import type { DraftFile, DraftFiles } from "./attach.ts";

// The composer's files, above its Send row: each with its name, size and how
// it stands, waiting, uploading with its progress, uploaded, failed with why
// and Retry, expired with Upload again, refused with why, or kept from the
// message a replacement replaces; and each with Remove. The list says the
// limits once. A failure, an expiry and a refusal are announced as they
// show. Attach, in the Send row, adds files to it.

// Where focus goes once the list changes: a file's Remove, or Attach.
type FocusTarget = { id: number } | "attach";

function FileState({ file }: { file: DraftFile }) {
  if (file.kind === "kept") {
    return <span className="muted">Kept</span>;
  }
  if (file.kind === "refused") {
    return (
      <span className="field-error" role="alert">
        {file.why}
      </span>
    );
  }
  const { state } = file;
  switch (state.kind) {
    case "waiting":
      return <span className="muted">Waiting</span>;
    case "uploading":
      return <progress max={file.size} value={state.sent} aria-label={`Uploading ${file.name}`} />;
    case "uploaded":
      return <span className="muted">Uploaded</span>;
    case "failed":
      return (
        <span className="field-error" role="alert">
          Did not upload: {describeFailure(state.failure)}
        </span>
      );
    case "expired":
      return (
        <span className="field-error" role="alert">
          Expired: upload it again.
        </span>
      );
  }
}

export function AttachList({
  draft,
  attach,
  disabled,
}: {
  draft: DraftFiles;
  // Attach, where focus goes once the last file is removed.
  attach: RefObject<HTMLButtonElement | null>;
  disabled: boolean;
}) {
  const id = useId();
  const { files } = draft;
  const removes = useRef(new Map<number, HTMLButtonElement>());
  const focusNext = useRef<FocusTarget>(undefined);
  // Focus moves in the commit that removed or restarted a file, so it never
  // rests on the page between.
  useLayoutEffect(() => {
    const next = focusNext.current;
    if (next === undefined) {
      return;
    }
    focusNext.current = undefined;
    (next === "attach" ? attach.current : removes.current.get(next.id))?.focus();
  });
  if (files.length === 0) {
    return null;
  }
  // Remove moves focus to the next file's Remove, else the previous one's,
  // else Attach.
  const remove = (index: number) => {
    const neighbor = files[index + 1] ?? files[index - 1];
    focusNext.current = neighbor === undefined ? "attach" : { id: neighbor.id };
    draft.remove(files[index]!.id);
  };
  // Retry and Upload again move focus to the file's Remove, which stays
  // through the upload.
  const retry = (file: DraftFile) => {
    focusNext.current = { id: file.id };
    draft.retry(file.id);
  };
  return (
    <div className="attached">
      <p className="hint" id={`${id}-limits`}>
        Up to {maxAttachments} files, {byteSize(maxFileBytes)} each.
      </p>
      <ul aria-label="Files to send" aria-describedby={`${id}-limits`}>
        {files.map((file, index) => {
          const state = file.kind === "added" ? file.state.kind : undefined;
          return (
            <li key={file.id}>
              <p className="attached-file">
                <span className="file-name">{file.name}</span>{" "}
                <span className="muted">{byteSize(file.size)}</span>
              </p>
              <div className="attached-state">
                <FileState file={file} />
                {(state === "failed" || state === "expired") && (
                  <button
                    type="button"
                    className="secondary"
                    aria-label={`${state === "failed" ? "Retry" : "Upload again"} ${file.name}`}
                    disabled={disabled}
                    onClick={() => retry(file)}
                  >
                    {state === "failed" ? "Retry" : "Upload again"}
                  </button>
                )}
                <button
                  ref={(element) => {
                    if (element === null) {
                      removes.current.delete(file.id);
                    } else {
                      removes.current.set(file.id, element);
                    }
                  }}
                  type="button"
                  className="secondary"
                  aria-label={`Remove ${file.name}`}
                  disabled={disabled}
                  onClick={() => remove(index)}
                >
                  Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
