import {
  type AttachmentRead,
  fileNameKey,
  type FileTotals,
  type Message,
  type ThreadFilesPage,
} from "@wayfarerlabs/agention-api";
import { type MouseEvent, type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { fileUrl, query, request, threadPath } from "../../../api.ts";
import { Loadable, MoreButton } from "../../../components.tsx";
import { usePages } from "../../../data.ts";
import { authorName, byteSize, Time } from "../../../format.tsx";
import { Icon } from "../../../icons.tsx";
import type { FileLinks } from "../../../markdown/Markdown.tsx";
import type { ThreadTarget } from "../writer.ts";
import { displayOfFile, FileView, opensOnDemand } from "./FileView.tsx";

// A message's files, listed under its text, detail and references, and the
// thread's, folded in its head: each with its name, type and size, shown in
// place where it can be, and a Download link while its contents are there.

// What a file is said to be beside its name: its type and size.
const facts = (file: AttachmentRead) => `${file.type} · ${byteSize(file.size)}`;

// Missing marks a file whose contents are gone.
function Missing() {
  return <span className="file-missing">Missing</span>;
}

// Download downloads a file under its name, and is named by it.
function Download({ url, name }: { url: string; name: string }) {
  return (
    <a href={url} download={name} aria-label={`Download ${name}`}>
      Download
    </a>
  );
}

// Open opens a PDF in a tab of its own, in the browser's viewer, since a
// browser may show no PDF in a frame.
function Open({ url, name }: { url: string; name: string }) {
  return (
    <a href={url} target="_blank" rel="noopener" aria-label={`Open ${name}`}>
      Open
    </a>
  );
}

function FileEntry({
  file,
  url,
  shown,
  toggle,
  entry,
}: {
  file: AttachmentRead;
  url: string;
  shown: boolean;
  toggle: () => void;
  entry: (element: HTMLLIElement | null) => void;
}) {
  const id = useId();
  return (
    <li ref={entry} tabIndex={-1} className="file">
      <p className="file-head">
        <span id={id} className="file-name">
          {file.name}
        </span>{" "}
        <span className="muted">{facts(file)}</span>
        {file.missing === true && (
          <>
            {" "}
            <Missing />
          </>
        )}
      </p>
      {file.missing !== true && (
        <FileView
          file={file}
          url={url}
          shown={shown}
          toggle={toggle}
          describedBy={id}
          actions={
            <>
              {displayOfFile(file) === "pdf" && <Open url={url} name={file.name} />}
              <Download url={url} name={file.name} />
            </>
          }
        />
      )}
    </li>
  );
}

// useMessageFiles gives a message's list of files, and the links its text
// and detail may make to them by name. A link to a file that shows in place
// shows it, and moves focus to its entry in the list; one to a PDF opens it
// in a new tab, and one to anything else downloads it. A missing file has
// no link.
export function useMessageFiles(
  message: Message,
  target: ThreadTarget,
): { links: FileLinks | undefined; list: ReactNode } {
  const files = message.attachments;
  // The files shown on demand, by name.
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  // The file a link last opened, focused once it shows.
  const [opened, setOpened] = useState<{ name: string }>();
  const entries = useRef(new Map<string, HTMLLIElement>());
  useLayoutEffect(() => {
    if (opened !== undefined) {
      entries.current.get(opened.name)?.focus();
    }
  }, [opened]);
  if (files === undefined) {
    return { links: undefined, list: null };
  }
  const urlOf = (file: AttachmentRead) => fileUrl(target, message.seq, file.name, file.file);
  const toggle = (name: string) =>
    setShown((current) => {
      const next = new Set(current);
      if (!next.delete(name)) {
        next.add(name);
      }
      return next;
    });
  const links: FileLinks = (name) => {
    const file = files.find((each) => fileNameKey(each.name) === fileNameKey(name));
    if (file === undefined || file.missing === true) {
      return undefined;
    }
    const href = urlOf(file);
    const display = displayOfFile(file);
    if (display === "pdf") {
      return { href, newTab: true };
    }
    if (display === "download") {
      return { href, download: file.name };
    }
    return {
      href,
      open: () => {
        if (opensOnDemand(file)) {
          setShown((current) => new Set([...current, file.name]));
        }
        setOpened({ name: file.name });
      },
    };
  };
  const list = (
    <ul className="files" aria-label={`Files of message ${message.seq}`}>
      {files.map((file) => (
        <FileEntry
          key={file.name}
          file={file}
          url={urlOf(file)}
          shown={shown.has(file.name)}
          toggle={() => toggle(file.name)}
          entry={(element) => {
            if (element === null) {
              entries.current.delete(file.name);
            } else {
              entries.current.set(file.name, element);
            }
          }}
        />
      ))}
    </ul>
  );
  return { links, list };
}

// ThreadFiles is the thread's files, folded under its head on every visit,
// saying how many there are and the space they take. Unfolded, it lists
// them, newest first, a page at a time, each with who attached it, when its
// message was written, and a link to the message that carries it.
export function ThreadFiles({
  target,
  totals,
  showMessage,
}: {
  target: ThreadTarget;
  totals: FileTotals;
  // Shows a message, loading it when needed, and moves focus to it.
  showMessage: (seq: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (totals.count === 0) {
    return null;
  }
  return (
    <section className="thread-files" aria-label="Files">
      <button
        type="button"
        className="fold"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        <Icon name="attach" />
        <span className="fold-label">
          Files ({totals.count}, {byteSize(totals.bytes)})
        </span>
        <Icon name="expand" />
      </button>
      {open && (
        <div id={id}>
          <ThreadFileList target={target} showMessage={showMessage} />
        </div>
      )}
    </section>
  );
}

// ThreadFileList reads the thread's files while it shows, and again as the
// thread refreshes, on the same interval and on the page regaining focus.
function ThreadFileList({
  target,
  showMessage,
}: {
  target: ThreadTarget;
  showMessage: (seq: number) => void;
}) {
  const path = threadPath(target.agent, target.session, target.number, "/files");
  const pages = usePages(async (cursor) => {
    const page = await request<ThreadFilesPage>("GET", `${path}${query({ cursor })}`);
    return { rows: page.files, next: page.next };
  });
  return (
    <Loadable data={pages.data} failure={pages.failure} retry={pages.refresh}>
      {(data) => (
        <>
          <ul className="files">
            {data.rows.map((file) => {
              const url = fileUrl(target, file.seq, file.name, file.file);
              const go = (event: MouseEvent<HTMLAnchorElement>) => {
                event.preventDefault();
                showMessage(file.seq);
              };
              return (
                <li key={`${file.seq}/${file.name}`} className="file">
                  <ThreadFileEntry file={file} url={url} go={go} />
                </li>
              );
            })}
          </ul>
          <MoreButton next={data.next} loading={pages.loading} more={pages.more} />
        </>
      )}
    </Loadable>
  );
}

function ThreadFileEntry({
  file,
  url,
  go,
}: {
  file: ThreadFilesPage["files"][number];
  url: string;
  go: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <>
      <p className="file-head">
        <span className="file-name">{file.name}</span> <span className="muted">{facts(file)}</span>
        {file.missing === true && (
          <>
            {" "}
            <Missing />
          </>
        )}
      </p>
      <p className="file-from muted">
        {authorName(file.author)} · <Time value={file.created_at} /> ·{" "}
        <a href={`#message-${file.seq}`} onClick={go}>
          #{file.seq}
        </a>
      </p>
      {file.missing !== true && (
        <div className="file-actions">
          <Download url={url} name={file.name} />
        </div>
      )}
    </>
  );
}
