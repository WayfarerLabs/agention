import { namePattern } from "@wayfarerlabs/agention-api";
import { type ThreadsView, threadsView } from "@wayfarerlabs/agention-server-api";
import {
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  type Ref,
  useSyncExternalStore,
} from "react";
import { type QueryValues, query } from "./api.ts";
import { type PathKind, placeOf } from "./components.tsx";

// The UI's routes, over the History API. The server answers every path that is
// not an API route or a file of the build with the UI's page, so each route is
// also a URL that can be opened directly.

export type Route =
  | { name: "threads" }
  | { name: "thread"; agent: string; session: string; thread: number }
  | { name: "sessions" }
  | { name: "settings" }
  | { name: "settings-section"; section: string }
  | { name: "sign-in" }
  | { name: "link" }
  // A page that has moved, which the shell replaces with where it is now.
  | { name: "moved"; to: string }
  | { name: "not-found" };

const threadRoute = /^\/s\/([^/]+)\/([^/]+)\/threads\/([1-9]\d{0,15})$/;
// A section of Settings, by its slug, which the Settings view looks up.
const settingsSectionRoute = /^\/settings\/([^/]+)$/;

export function matchRoute(pathname: string): Route {
  switch (pathname) {
    case "/":
      return { name: "threads" };
    // The sessions view, which agents' registrations still name by the path
    // of the page it took the place of.
    case "/sessions":
    case "/registrations":
      return { name: "sessions" };
    case "/settings":
      return { name: "settings" };
    // The passkeys' page of old, now Settings' passkeys section.
    case "/passkeys":
      return { name: "moved", to: "/settings/passkeys" };
    case "/sign-in":
      return { name: "sign-in" };
    case "/link":
      return { name: "link" };
  }
  const [, section] = settingsSectionRoute.exec(pathname) ?? [];
  if (section !== undefined) {
    return { name: "settings-section", section };
  }
  const [, agent = "", session = "", thread = ""] = threadRoute.exec(pathname) ?? [];
  const number = Number(thread);
  return namePattern.test(agent) && namePattern.test(session) && Number.isSafeInteger(number)
    ? { name: "thread", agent, session, thread: number }
    : { name: "not-found" };
}

// The thread list's address is the API's query of the list without its
// page, a ThreadsView: each part not at its default, in the API's order, a
// flag as true and a filter of several values once for each, as
// /?search=release&unread=true&agent=builder&agent=reviewer&session=builder/main&topic=builder/main/auth&sort=due&reverse=true&group=session.
// With none, the list holds every thread the operator has not archived, in
// priority order, in that order's own direction, ungrouped.

// The list with no filter on, in priority order, ungrouped.
export const unfiltered = threadsView.parse({});

// queryOf gives the parts of a list's view that are not at their default, as
// the API's query takes them, of those a schema's shape names, in its order:
// by default the whole view; the counts' query names only its filters.
export function queryOf(
  view: ThreadsView,
  shape: Partial<Record<keyof ThreadsView, unknown>> = threadsView.shape,
): QueryValues {
  return Object.fromEntries(
    (Object.keys(shape) as (keyof ThreadsView)[]).flatMap((part) =>
      view[part] === unfiltered[part] ? [] : [[part, view[part]]],
    ),
  );
}

// listViewOf reads the list an address names, as the server reads the
// list's query: each part by the API's own schema for it, a name given once
// as its text and several times as a list. A part it cannot read is left at
// its default: an unknown value, a name given twice, or more names than the
// list takes.
export function listViewOf(search: URLSearchParams): ThreadsView {
  const parts = Object.fromEntries(
    Object.entries(threadsView.shape).flatMap(([part, schema]) => {
      const given = search.getAll(part);
      const read = schema.safeParse(given.length > 1 ? given : given[0]);
      return read.success ? [[part, read.data]] : [];
    }),
  );
  return threadsView.parse(parts);
}

// listHref writes the address of a list. The slashes of a session or a
// topic are left as they are, which a query may hold.
export function listHref(view: ThreadsView): string {
  return `/${query(queryOf(view)).replaceAll("%2F", "/")}`;
}

// Every change of the history entry is announced as navigated, which the
// page follows: navigate announces its own, since a same-document navigation
// does not fire popstate, and going back or forward is announced with the
// corrections registered for it (correctPoppedEntry) run in the same
// listener. A correction in a popstate listener of its own would run only
// once the page had rendered the entry as it was popped, as Chromium showed.
// Nothing else listens to popstate.
const navigated = "agention:navigate";
const corrections = new Set<() => void>();

window.addEventListener("popstate", () => {
  corrections.forEach((correct) => correct());
  window.dispatchEvent(new Event(navigated));
});

// correctPoppedEntry registers a correction to the history entry that going
// back or forward reaches, which runs before the page follows it, until the
// returned function takes it away.
export function correctPoppedEntry(correct: () => void): () => void {
  corrections.add(correct);
  return () => corrections.delete(correct);
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(navigated, onChange);
  return () => window.removeEventListener(navigated, onChange);
}

const currentPath = () => window.location.pathname + window.location.search;

// useLocation returns the current path and query, and re-renders on change.
export function useLocation(): URL {
  const path = useSyncExternalStore(subscribe, currentPath);
  return new URL(path, window.location.origin);
}

// navigate goes to a path, with state recorded in its history entry.
export function navigate(to: string, options: { replace?: boolean; state?: unknown } = {}): void {
  if (to === currentPath()) {
    return;
  }
  const state = options.state ?? null;
  if (options.replace === true) {
    window.history.replaceState(state, "", to);
  } else {
    window.history.pushState(state, "", to);
  }
  window.dispatchEvent(new Event(navigated));
}

// plainClick says whether a click on a link is a plain one, which the page
// handles itself: any other, as for a new tab or a download, is the
// browser's own.
export const plainClick = (event: MouseEvent<HTMLAnchorElement>) =>
  event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

// Link is an anchor that navigates within the page on a plain click, and
// leaves every other click (a new tab, a download) to the browser. state, when
// given, says on the click what the new history entry records. follow, when
// given, is what a plain click does in place of navigating: choosing a
// filter of the list on screen, which goes to the same address its own way,
// or moving focus to the thread already open beside the list.
export function Link({
  to,
  state,
  follow,
  ...rest
}: {
  to: string;
  state?: () => unknown;
  follow?: () => void;
  ref?: Ref<HTMLAnchorElement>;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "onClick">) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!plainClick(event)) {
      return;
    }
    event.preventDefault();
    if (follow === undefined) {
      navigate(to, { state: state?.() });
    } else {
      follow();
    }
  };
  return <a {...rest} href={to} onClick={onClick} />;
}

// A thread page returns to the list it was opened from: a link from the list
// to a thread records the list in the new history entry's state, as from, and
// a link between threads carries it on. A page opened any other way returns
// to the list with no filters.

// The parts of a list's view that are no filters: its order, its direction
// and its grouping, which turning filters off or on leaves as they are.
export const arrangementOf = ({ sort, reverse, group }: ThreadsView) => ({
  sort,
  reverse,
  group,
});

// threadPathParts gives where a thread is, its agent, session and topic,
// each linking to the list narrowed to it alone, with no other filter on, so
// it shows everything there, in the order, direction and grouping of the
// list the page returns to.
export function threadPathParts(
  thread: {
    agent: string;
    session: string;
    topic?: string | undefined;
  },
  origin: ThreadsView,
): { kind: PathKind; label: string; href: string }[] {
  const narrowed = (change: Partial<ThreadsView>) =>
    listHref({ ...unfiltered, ...arrangementOf(origin), ...change });
  const session = `${thread.agent}/${thread.session}`;
  // The one filter each part sets, to it.
  const narrowing: Record<PathKind, (name: string) => Partial<ThreadsView>> = {
    agent: (agent) => ({ agent: [agent] }),
    session: () => ({ session: [session] }),
    topic: (topic) => ({ topic: [`${session}/${topic}`] }),
  };
  return placeOf(thread).map(([kind, label]) => ({
    kind,
    label,
    href: narrowed(narrowing[kind](label)),
  }));
}

// originOf reads the list a thread page returns to from its history entry's
// state, as the list's address names it. The state outlives the page that
// wrote it, through reloads and upgrades, so only a path to the list is taken.
export function originOf(state: unknown): ThreadsView {
  const from =
    typeof state === "object" && state !== null && "from" in state ? state.from : undefined;
  if (typeof from === "string" && from.startsWith("/") && !from.startsWith("//")) {
    const url = new URL(from, window.location.origin);
    if (url.origin === window.location.origin && matchRoute(url.pathname).name === "threads") {
      return listViewOf(url.searchParams);
    }
  }
  return listViewOf(new URLSearchParams());
}

// currentListView reads the list the page is on: on the list, the one its
// address names; on a thread page, the one the page returns to, which the
// list beside the thread shows when they are side by side.
export function currentListView(): ThreadsView {
  return matchRoute(window.location.pathname).name === "threads"
    ? listViewOf(new URLSearchParams(window.location.search))
    : originOf(window.history.state);
}

// useListView returns currentListView, and re-renders when it changes.
export function useListView(): ThreadsView {
  const href = useSyncExternalStore(subscribe, () => listHref(currentListView()));
  return listViewOf(new URL(href, window.location.origin).searchParams);
}

// showList puts another list in place of the one the page is on, replacing
// the history entry, so going back leaves the list rather than stepping
// through every choice: on the list, its address; on a thread page beside
// the list, the list the page returns to, so the thread stays open.
export function showList(view: ThreadsView): void {
  if (matchRoute(window.location.pathname).name === "threads") {
    navigate(listHref(view), { replace: true });
    return;
  }
  const state: unknown = window.history.state;
  const kept = typeof state === "object" && state !== null ? state : {};
  window.history.replaceState({ ...kept, from: listHref(view) }, "", currentPath());
  window.dispatchEvent(new Event(navigated));
}

// ThreadLink links to another thread of a session, carrying on the list the
// thread page on screen returns to, as its history entry holds it when
// followed.
export function ThreadLink({
  agent,
  session,
  thread,
  children,
}: {
  agent: string;
  session: string;
  thread: number;
  children: ReactNode;
}) {
  return (
    <Link
      to={threadHref(agent, session, thread)}
      state={() => ({ from: listHref(originOf(window.history.state)) })}
    >
      {children}
    </Link>
  );
}

// safeReturnPath accepts a path to come back to after signing in only if it
// is one of the UI's own routes, so the sign-in page cannot be made to send
// the operator anywhere else.
export function safeReturnPath(value: string | null): string {
  if (value === null || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  const url = new URL(value, window.location.origin);
  const route = matchRoute(url.pathname);
  return url.origin === window.location.origin &&
    route.name !== "not-found" &&
    route.name !== "sign-in" &&
    route.name !== "link"
    ? url.pathname + url.search
    : "/";
}

export function threadHref(agent: string, session: string, thread: number): string {
  return `/s/${agent}/${session}/threads/${thread}`;
}
