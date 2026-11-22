import { type AttachmentRead, type ServedType, servedTypeOf } from "@wayfarerlabs/agention-api";
import { type ReactNode, useEffect, useId, useState } from "react";
import { describeFailure, readTextStart } from "../../../api.ts";
import { useUnauthenticatedCheck } from "../../../data.ts";
import { byteSize } from "../../../format.tsx";

// How a file of a message shows in place, by the type it is served as. No
// file's bytes ever become a blob: or data: URL: every element loads the
// file's own URL, with the headers the server serves it with.

// Images up to this size show at once; larger ones, such as a phone's
// photos, on demand.
export const inlineImageBytes = 2 * 1024 * 1024;

// How much of a text file shows in place, read with a range request.
export const textPreviewBytes = 256 * 1024;

// How a served type shows: drawn as an image, played as video or audio, read
// as text, opened in a tab of its own as a PDF is, or downloaded alone.
export type Display = "image" | "video" | "audio" | "text" | "pdf" | "download";

function displayOf(served: ServedType): Display {
  if (served.startsWith("image/")) {
    return "image";
  }
  if (served.startsWith("video/")) {
    return "video";
  }
  if (served.startsWith("audio/")) {
    return "audio";
  }
  if (served.startsWith("text/")) {
    return "text";
  }
  return served === "application/pdf" ? "pdf" : "download";
}

export const displayOfFile = (file: AttachmentRead): Display => displayOf(servedTypeOf(file.type));

// opensOnDemand says whether a file shows in place only once asked: a text
// file, and an image too large to show at once.
export const opensOnDemand = (file: AttachmentRead): boolean => {
  const display = displayOfFile(file);
  return display === "text" || (display === "image" && file.size > inlineImageBytes);
};

// TextStart shows the start of a text file, read once as it shows. An empty
// file has nothing to read: a range of it is outside it.
function TextStart({ url, size }: { url: string; size: number }) {
  const onFailure = useUnauthenticatedCheck();
  const [read, setRead] = useState<{ text: string } | { failure: unknown }>();
  useEffect(() => {
    if (size === 0) {
      return;
    }
    let current = true;
    readTextStart(url, textPreviewBytes).then(
      (text) => current && setRead({ text }),
      (failure: unknown) => {
        if (current) {
          onFailure(failure);
          setRead({ failure });
        }
      },
    );
    return () => {
      current = false;
    };
  }, [url, size, onFailure]);
  if (size === 0) {
    return <pre className="file-text" />;
  }
  if (read === undefined) {
    return <p className="muted">Loading…</p>;
  }
  if ("failure" in read) {
    return (
      <p className="field-error" role="alert">
        The text could not be read: {describeFailure(read.failure)}
      </p>
    );
  }
  return (
    <>
      <pre className="file-text">{read.text}</pre>
      {size > textPreviewBytes && (
        <p className="hint">
          Showing the first {byteSize(textPreviewBytes)}; download it for the rest.
        </p>
      )}
    </>
  );
}

// FileView shows a file in place under its row of controls: an image at
// once, or behind Show image when large; video and audio as their players,
// loading nothing until played; text behind Show text. shown says whether
// what shows on demand is showing, and toggle shows or hides it. The control
// keeps focus as its words change to Hide. actions follow it in the row.
export function FileView({
  file,
  url,
  shown,
  toggle,
  describedBy,
  actions,
}: {
  file: AttachmentRead;
  url: string;
  shown: boolean;
  toggle: () => void;
  // The element naming the file, which names its players and describes its
  // controls.
  describedBy: string;
  actions: ReactNode;
}) {
  const id = useId();
  const display = displayOfFile(file);
  const onDemand = opensOnDemand(file);
  const content =
    display === "image" ? (
      <img className="file-image" src={url} alt={file.name} loading="lazy" />
    ) : display === "video" ? (
      <video
        className="file-media"
        src={url}
        controls
        preload="none"
        aria-labelledby={describedBy}
      />
    ) : display === "audio" ? (
      <audio
        className="file-media"
        src={url}
        controls
        preload="none"
        aria-labelledby={describedBy}
      />
    ) : display === "text" ? (
      <TextStart url={url} size={file.size} />
    ) : undefined;
  return (
    <>
      <div className="file-actions">
        {onDemand && (
          <button
            type="button"
            className="secondary"
            aria-expanded={shown}
            aria-controls={shown ? id : undefined}
            aria-describedby={describedBy}
            onClick={toggle}
          >
            {shown ? "Hide" : display === "image" ? "Show image" : "Show text"}
          </button>
        )}
        {actions}
      </div>
      {content !== undefined && (!onDemand || shown) && (
        <div id={id} className="file-shown">
          {content}
        </div>
      )}
    </>
  );
}
