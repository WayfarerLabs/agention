import { type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { AttentionProvider, useAttention } from "./attention.tsx";
import { ErrorBoundary, PageFailed } from "./boundary.tsx";
import { Failure, focusLanding, PageHeading } from "./components.tsx";
import { plural, Spoken } from "./format.tsx";
import { KeyboardProvider } from "./keyboard.tsx";
import { refreshDevice } from "./push/subscription.ts";
import { Link, navigate, safeReturnPath, useLocation } from "./router.tsx";
import { matchRoute, type Route } from "./routes.ts";
import { serverName } from "./server-name.ts";
import { SessionProvider, useSession } from "./session.tsx";
import { LinkPage } from "./views/LinkPage.tsx";
import { NotFound } from "./views/NotFound.tsx";
import { Sessions } from "./views/Sessions.tsx";
import { Settings } from "./views/Settings.tsx";
import { sectionBySlug } from "./views/settings/sections.ts";
import { SignIn } from "./views/SignIn.tsx";
import { Threads } from "./views/Threads.tsx";

// The application: the browser's session, and the route's view.
export function App() {
  return (
    <SessionProvider>
      <Shell />
    </SessionProvider>
  );
}

// Routes anyone can open; every other route needs the operator signed in.
const isPublic = (route: Route) => route.name === "sign-in" || route.name === "link";

// routeAt reads the route at a path. The router reads a section of Settings
// by its slug alone, so a slug no section has is resolved here, to the page
// Agention does not have, as any other unknown path is.
function routeAt(pathname: string): Route {
  const route = matchRoute(pathname);
  return route.name === "settings-section" && sectionBySlug(route.section) === undefined
    ? { name: "not-found" }
    : route;
}

function Shell() {
  const session = useSession();
  const location = useLocation();
  const route = routeAt(location.pathname);
  const state = session.status.status === "ready" ? session.status.state : undefined;
  const here = location.pathname + location.search;

  // A page that has moved goes where it is now, signed in or not. Signed
  // out, a private route goes to sign-in, keeping where it was so signing in
  // comes back to it; signed in, the sign-in page goes there.
  const redirect =
    route.name === "moved"
      ? route.to + location.search
      : state === undefined
        ? undefined
        : !state.signed_in && !isPublic(route)
          ? `/sign-in?next=${encodeURIComponent(here)}`
          : state.signed_in && route.name === "sign-in"
            ? safeReturnPath(location.searchParams.get("next"))
            : undefined;
  useEffect(() => {
    if (redirect !== undefined) {
      navigate(redirect, { replace: true });
    }
  }, [redirect]);

  // While this device's notifications are on, its subscription is refreshed
  // with the server once signed in, as the page starts and after each in-app
  // sign-in, each of which brings a new CSRF token. A refresh that fails is
  // tried again at the next.
  const { csrf } = session;
  useEffect(() => {
    if (csrf !== undefined) {
      refreshDevice(csrf).catch(() => undefined);
    }
  }, [csrf]);

  if (session.status.status === "unreachable") {
    return (
      <Frame>
        <PageHeading>{serverName()}</PageHeading>
        <Failure failure={session.status.failure}>
          <button type="button" className="secondary" onClick={session.retry}>
            Try again
          </button>
        </Failure>
      </Frame>
    );
  }
  if (state === undefined || redirect !== undefined) {
    return <Frame>{null}</Frame>;
  }
  const operatorExists = state.signed_in || state.operator_exists;
  const nav = state.signed_in ? <Navigation route={route} /> : undefined;
  // Each route gets a view of its own, loaded afresh, except that the thread
  // list and the threads share one, the Threads tab, and the sessions' rows
  // and the sessions another, the Sessions tab, each mounting afresh what it
  // shows. A query alone, such as the thread list's filter, is the view's to
  // follow.
  const threadsTab = route.name === "threads" || route.name === "thread";
  const sessionsTab =
    route.name === "sessions" || route.name === "session" || route.name === "registration";
  const view = threadsTab ? "threads" : sessionsTab ? "sessions" : location.pathname;
  const frame = (
    <Frame nav={nav} view={view}>
      {route.name === "sign-in" ? (
        <SignIn operatorExists={operatorExists} />
      ) : route.name === "link" ? (
        <LinkPage operatorExists={operatorExists} />
      ) : threadsTab ? (
        <Threads thread={route.name === "thread" ? route : undefined} />
      ) : sessionsTab ? (
        <Sessions
          open={route.name === "session" || route.name === "registration" ? route : undefined}
        />
      ) : (
        <View route={route} key={view} />
      )}
    </Frame>
  );
  return state.signed_in ? (
    <AttentionProvider>
      <KeyboardProvider>{frame}</KeyboardProvider>
    </AttentionProvider>
  ) : (
    frame
  );
}

function View({ route }: { route: Route }) {
  switch (route.name) {
    case "settings":
      return <Settings />;
    case "settings-section":
      return <Settings section={route.section} />;
    default:
      return <NotFound />;
  }
}

// The sections the navigation has a tab for: each the page its tab opens,
// and the pages within it, such as a thread within the list's. A tab marks
// its own page as the page on screen, and a page within it as the current
// section only, since the tab links elsewhere.
const sections: {
  to: string;
  label: string;
  route: Route["name"];
  within: readonly Route["name"][];
}[] = [
  { to: "/", label: "Threads", route: "threads", within: ["thread"] },
  { to: "/sessions", label: "Sessions", route: "sessions", within: ["session", "registration"] },
  { to: "/settings", label: "Settings", route: "settings", within: ["settings-section"] },
];

function Navigation({ route }: { route: Route }) {
  return (
    <nav aria-label="Views">
      <ul>
        {sections.map((section) => (
          <li key={section.to}>
            <Link
              to={section.to}
              aria-current={
                section.route === route.name
                  ? "page"
                  : section.within.includes(route.name)
                    ? "true"
                    : undefined
              }
            >
              {section.label}
              {section.route === "threads" && <UnreadThreadsBadge />}
              {section.route === "sessions" && <PendingRegistrationsBadge />}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// Each tab's badge counts what waits on the operator that its view clears,
// while anything does: on Threads, the unread threads, which reading or
// archiving clears; on Sessions, the registrations waiting for approval,
// which deciding clears.
function UnreadThreadsBadge() {
  const threads = useAttention()?.data?.unread_threads ?? 0;
  return <Badge count={threads} spoken={plural(threads, "unread thread")} />;
}

function PendingRegistrationsBadge() {
  const registrations = useAttention()?.data?.pending_registrations ?? 0;
  return (
    <Badge
      count={registrations}
      spoken={`${plural(registrations, "registration")} waiting for approval`}
    />
  );
}

function Badge({ count, spoken }: { count: number; spoken: string }) {
  return count === 0 ? null : (
    <span className="badge">
      <Spoken shown={String(count)} spoken={spoken} />
    </span>
  );
}

// Frame is the page around every view, under a banner led by the server's
// name. After a navigation, focus moves to where it lands (focusLanding), so
// keyboard and screen reader users start there. view names the view on
// screen, which a page that failed to render gives way to when it changes.
function Frame({ nav, view, children }: { nav?: ReactNode; view?: string; children: ReactNode }) {
  const main = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (main.current !== null) {
      focusLanding(main.current);
    }
  }, [pathname]);
  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="banner">
        <Link to="/" className="brand">
          {serverName()}
        </Link>
        {nav}
      </header>
      <main id="main" ref={main} tabIndex={-1}>
        {/* A page that fails to render leaves the navigation standing, and
            going elsewhere starts afresh. */}
        <ErrorBoundary key={view ?? pathname} fallback={<PageFailed />}>
          {children}
        </ErrorBoundary>
      </main>
    </>
  );
}
