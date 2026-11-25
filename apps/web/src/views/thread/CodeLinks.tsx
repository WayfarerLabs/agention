import {
  type BranchLink,
  type BranchRollup,
  type CodeLink,
  linkKey,
  maxListed,
  type PullRequestLink,
  type PullRequestRollup,
  type ThreadsView,
} from "@wayfarerlabs/agention-api";
import { useId, useState } from "react";
import { Icon } from "../../icons.tsx";
import { CodeLinkEntry, countOf } from "../code-links.tsx";

// The pull requests and branches a message names, and those its thread's
// live messages name, shown compactly, each leading to the thread list
// filtered by it alone, in the arrangement of the list the page returns to.

// CodeLinkList lists entries, pull requests first, each in the order given.
function CodeLinkList({
  links,
  origin,
  id,
}: {
  links: CodeLink[];
  origin: ThreadsView;
  id?: string | undefined;
}) {
  return (
    <ul id={id} className="code-links-list">
      {links.map((link) => (
        <li key={linkKey(link)}>
          <CodeLinkEntry link={link} origin={origin} />
        </li>
      ))}
    </ul>
  );
}

// MessageCodeLinks is a message's pull requests and branches on one short line
// under its text: the one entry itself, or, with more, a count that unfolds
// to the list in place.
export function MessageCodeLinks({
  pullRequests = [],
  branches = [],
  origin,
}: {
  pullRequests?: PullRequestLink[] | undefined;
  branches?: BranchLink[] | undefined;
  origin: ThreadsView;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const links: CodeLink[] = [...pullRequests, ...branches];
  const [only] = links;
  if (only === undefined) {
    return null;
  }
  if (links.length === 1) {
    return (
      <p className="code-links">
        <Icon name="branch" />
        <CodeLinkEntry link={only} origin={origin} />
      </p>
    );
  }
  return (
    <div className="code-links">
      <button
        type="button"
        className="quiet detail-fold"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        <Icon name="expand" />
        <Icon name="branch" />
        {countOf(pullRequests.length, branches.length)}
      </button>
      {open && <CodeLinkList links={links} origin={origin} id={id} />}
    </div>
  );
}

// ThreadCodeLinks is the pull requests and branches a thread's live messages
// name, each once, folded under its head beside its files and hidden while
// there are none. Unfolded, it lists them, pull requests first, each kind the
// most recently named first, and says when the oldest were left out.
export function ThreadCodeLinks({
  pullRequests,
  branches,
  origin,
}: {
  pullRequests: PullRequestRollup;
  branches: BranchRollup;
  origin: ThreadsView;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const links: CodeLink[] = [...pullRequests.links, ...branches.links];
  if (links.length === 0) {
    return null;
  }
  return (
    <section className="thread-code-links" aria-label="Pull requests and branches">
      <button
        type="button"
        className="fold"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        <Icon name="branch" />
        <span className="fold-label">Pull requests and branches ({links.length})</span>
        <Icon name="expand" />
      </button>
      {open && (
        <div id={id}>
          <CodeLinkList links={links} origin={origin} />
          {(pullRequests.truncated || branches.truncated) && (
            <p className="hint">Only the {maxListed} most recently named of each are listed.</p>
          )}
        </div>
      )}
    </section>
  );
}
