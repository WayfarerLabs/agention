import {
  type BranchLink,
  type BranchRollup,
  type CodeLink,
  linkKey,
  maxListed,
  type PullRequestLink,
  type PullRequestRollup,
  shortForm,
} from "@wayfarerlabs/agention-api";
import { useId, useState } from "react";
import { plural } from "../../format.tsx";
import { Icon } from "../../icons.tsx";
import { ExternalLink, liveUrl } from "../../markdown/Markdown.tsx";

// The pull requests and branches a message names, and those its thread's
// live messages name, shown compactly: each by its short form, a live link
// when its URL passes the link rule, and plain text otherwise. They are what
// their writer declared, never fetched.

// CodeLinkText is one entry: its short form, as a link when it has a URL that
// passes the link rule.
function CodeLinkText({ link }: { link: CodeLink }) {
  const text = shortForm(link);
  const url = link.url === undefined ? undefined : liveUrl(link.url);
  return url === undefined ? (
    <span className="code-link">{text}</span>
  ) : (
    <ExternalLink url={url} text={text}>
      <span className="code-link">{text}</span>
    </ExternalLink>
  );
}

// CodeLinkList lists entries, pull requests first, each in the order given.
function CodeLinkList({ links, id }: { links: CodeLink[]; id?: string | undefined }) {
  return (
    <ul id={id} className="code-links-list">
      {links.map((link) => (
        <li key={linkKey(link)}>
          <CodeLinkText link={link} />
        </li>
      ))}
    </ul>
  );
}

// countOf says how many of each there are, in words: "2 pull requests, 1
// branch".
function countOf(pullRequests: number, branches: number): string {
  return [
    ...(pullRequests > 0 ? [plural(pullRequests, "pull request")] : []),
    ...(branches > 0 ? [branches === 1 ? "1 branch" : `${branches} branches`] : []),
  ].join(", ");
}

// MessageCodeLinks is a message's pull requests and branches on one short line
// under its text: the one entry itself, or, with more, a count that unfolds
// to the list in place.
export function MessageCodeLinks({
  pullRequests = [],
  branches = [],
}: {
  pullRequests?: PullRequestLink[] | undefined;
  branches?: BranchLink[] | undefined;
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
        <CodeLinkText link={only} />
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
      {open && <CodeLinkList links={links} id={id} />}
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
}: {
  pullRequests: PullRequestRollup;
  branches: BranchRollup;
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
          <CodeLinkList links={links} />
          {(pullRequests.truncated || branches.truncated) && (
            <p className="hint">Only the {maxListed} most recently named of each are listed.</p>
          )}
        </div>
      )}
    </section>
  );
}
