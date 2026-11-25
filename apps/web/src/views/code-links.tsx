import { type CodeLink, shortForm, type SummaryLinks } from "@wayfarerlabs/agention-api";
import { type ThreadsView } from "@wayfarerlabs/agention-server-api";
import { plural } from "../format.tsx";
import { Icon, Mark } from "../icons.tsx";
import { ExternalLink, liveUrl } from "../markdown/Markdown.tsx";
import { Link, narrowedHref } from "../router.tsx";
import { FilterLink, type ListShown } from "./filter-links.tsx";

// The pull requests and branches shown anywhere, on a message, under a
// thread's head or on a row: each by its short form, leading to the thread
// list filtered by it, and, on a thread page, when its URL passes the link
// rule, a small link beside it to the forge's page. They are what their
// writer declared, never fetched.

// narrowingOf is the filter keeping the threads that name an entry.
export function narrowingOf(link: CodeLink): Partial<ThreadsView> {
  return "number" in link ? { pull_request: [shortForm(link)] } : { branch: [shortForm(link)] };
}

// countOf says how many of each there are, in words: "2 pull requests, 1
// branch".
export function countOf(pullRequests: number, branches: number): string {
  return [
    ...(pullRequests > 0 ? [plural(pullRequests, "pull request")] : []),
    ...(branches > 0 ? [plural(branches, "branch", "branches")] : []),
  ].join(", ");
}

// CodeLinkEntry is one entry on a thread page, from a message or the head's
// fold: its short form, leading to the list filtered by it alone, in the
// order and grouping of the list the page returns to, so the threads of every
// session naming it show, as the thread's agent, session, and topic lead to
// theirs; and its URL beside it, when it has one that passes the link rule,
// followed by its host.
export function CodeLinkEntry({ link, origin }: { link: CodeLink; origin: ThreadsView }) {
  const text = shortForm(link);
  const url = link.url === undefined ? undefined : liveUrl(link.url);
  return (
    <span className="code-link-entry">
      <Link to={narrowedHref(origin, narrowingOf(link))} aria-label={`Threads naming ${text}`}>
        <span className="code-link">{text}</span>
      </Link>
      {url !== undefined && (
        <ExternalLink url={url} text={text}>
          <Icon name="external" />
          <span className="visually-hidden">
            Open {text} at {url.host}
          </span>
        </ExternalLink>
      )}
    </span>
  );
}

// RowCodeLink is a thread list row's one pull request or branch, when its
// thread's live messages name only one, beneath the row's link: its short
// form, adding its filter to the list on screen, as a grouped header's label
// adds its group. A row stays compact, so it carries no forge link; the
// thread's head lists the entry with it.
export function RowCodeLink({ links, list }: { links: SummaryLinks; list: ListShown }) {
  const only = links.pull_request ?? links.branch;
  if (only === undefined) {
    return null;
  }
  const text = shortForm(only);
  return (
    <p className="row-code-links">
      <Icon name="branch" />
      <FilterLink list={list} narrowing={narrowingOf(only)} spoken={`Threads naming ${text}`}>
        <span className="code-link">{text}</span>
      </FilterLink>
    </p>
  );
}

// CodeLinksMark is a row's mark among its others, inside its link, while its
// thread's live messages name more than one pull request or branch: how many,
// said in full. It lists none; the thread's head does.
export function CodeLinksMark({ links }: { links: SummaryLinks }) {
  const count = links.pull_requests + links.branches;
  return count > 1 ? (
    <Mark icon="branch" label={countOf(links.pull_requests, links.branches)} shown={count} />
  ) : null;
}
