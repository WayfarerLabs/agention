import type { ThreadsView } from "@wayfarerlabs/agention-api";
import type { ReactNode } from "react";
import { plural } from "../format.tsx";
import { UnreadCount } from "../icons.tsx";
import { Link, listHref, unfiltered } from "../router.tsx";

// The links the sessions view's and the thread list's headers share, each
// opening the thread list narrowed to the threads one of their marks stands
// for. The sessions view's start from the list with no filters and add a
// history entry, as any link does; the thread list's add to the list on
// screen and choose that view in place, as its own filters do.

// The list on screen, which a header's links narrow: the view they add to,
// and choosing a change to it, as the list's own filters choose theirs.
export interface ListShown {
  view: ThreadsView;
  choose: (change: Partial<ThreadsView>) => void;
}

// FilterLink opens the thread list narrowed to the threads a mark stands
// for, named with what the mark shows and what those threads are of, such as
// "Blocked on you: threads of builder". Without a list it opens them with no
// other filter; with one, it adds the narrowing to that list's view, and a
// plain click chooses it there.
export function FilterLink({
  narrowing,
  spoken,
  list,
  className,
  children,
}: {
  narrowing: Partial<ThreadsView>;
  spoken: string;
  list?: ListShown | undefined;
  className?: string | undefined;
  children: ReactNode;
}) {
  return (
    <Link
      className={className}
      to={listHref({ ...(list?.view ?? unfiltered), ...narrowing })}
      {...(list === undefined ? {} : { follow: () => list.choose(narrowing) })}
      aria-label={spoken}
    >
      {children}
    </Link>
  );
}

// What a mark's threads are under, for its link: the narrowing of what it
// sits on, what that is said as, such as "builder", and the list on screen
// it adds to, if any.
export interface Scope {
  narrowing: Partial<ThreadsView>;
  label: string;
  list?: ListShown | undefined;
}

// BlockedFlag says that a blocking ask is open on the operator, in the
// thread list's words and its danger tone.
export const BlockedFlag = () => <span className="flag danger">Blocked on you</span>;

// BlockedLink is a BlockedFlag linking to the threads holding a blocking
// ask.
export function BlockedLink({ narrowing, label, list }: Scope) {
  return (
    <FilterLink
      narrowing={{ ...narrowing, impact: "blocking" }}
      spoken={`Blocked on you: threads of ${label}`}
      list={list}
    >
      <BlockedFlag />
    </FilterLink>
  );
}

// UnreadLink is the envelope: closed with how many threads are unread,
// linking to those, or open, and no link, while none is.
export function UnreadLink({ unread, narrowing, label, list }: Scope & { unread: number }) {
  return unread === 0 ? (
    <UnreadCount unread={0} />
  ) : (
    <FilterLink
      narrowing={{ ...narrowing, unread: true }}
      spoken={`${plural(unread, "unread thread")} of ${label}`}
      list={list}
    >
      <UnreadCount unread={unread} />
    </FilterLink>
  );
}
