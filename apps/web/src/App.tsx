import type { SessionState } from "@wayfarerlabs/agention-api";
import { type ReactNode, useEffect, useRef } from "react";
import { describeFailure, request } from "./api.ts";
import { ErrorBoundary } from "./boundary.tsx";
import { Failure, PageHeading, usePageTitle } from "./components.tsx";
import { useAction } from "./data.ts";
import { Link, matchRoute, navigate, type Route, safeReturnPath, useLocation } from "./router.tsx";
import { serverName } from "./server-name.ts";
import { SessionProvider, useSession } from "./session.tsx";
import { LinkPage } from "./views/LinkPage.tsx";
import { Passkeys } from "./views/Passkeys.tsx";
import { Sessions } from "./views/Sessions.tsx";
import { SignIn } from "./views/SignIn.tsx";
import { ThreadList } from "./views/ThreadList.tsx";
import { ThreadView } from "./views/thread/ThreadView.tsx";

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

function Shell() {
  const session = useSession();
  const location = useLocation();
  const route = matchRoute(location.pathname);
  const state = session.status.status === "ready" ? session.status.state : undefined;
  const here = location.pathname + location.search;

  // Signed out, a private route goes to sign-in, keeping where it was so
  // signing in comes back to it; signed in, the sign-in page goes there.
  const redirect =
    state === undefined
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
  return (
    <Frame nav={nav}>
      {route.name === "sign-in" ? (
        <SignIn operatorExists={operatorExists} />
      ) : route.name === "link" ? (
        <LinkPage operatorExists={operatorExists} />
      ) : (
        // Each route gets a view of its own, loaded afresh. A query alone,
        // such as the thread list's filter, is the view's to follow.
        <View route={route} key={location.pathname} />
      )}
    </Frame>
  );
}

function View({ route }: { route: Route }) {
  switch (route.name) {
    case "threads":
      return <ThreadList />;
    case "thread":
      return <ThreadView agent={route.agent} session={route.session} thread={route.thread} />;
    case "sessions":
      return <Sessions />;
    case "passkeys":
      return <Passkeys />;
    default:
      return <NotFound />;
  }
}

function NotFound() {
  usePageTitle("Not found");
  return (
    <>
      <PageHeading>Not found</PageHeading>
      <p>
        Agention has no page here. <Link to="/">Go to your threads.</Link>
      </p>
    </>
  );
}

// The sections the navigation has a tab for: each the page its tab opens,
// and the pages within it, such as a thread within the list's. A tab marks
// its own page as the page on screen, and a page within it as the current
// section only, since the tab links elsewhere.
const sections: { to: string; label: string; route: Route["name"]; within?: Route["name"] }[] = [
  { to: "/", label: "Threads", route: "threads", within: "thread" },
  { to: "/sessions", label: "Sessions", route: "sessions" },
  { to: "/passkeys", label: "Passkeys", route: "passkeys" },
];

function Navigation({ route }: { route: Route }) {
  const session = useSession();
  const signOut = useAction();
  const leave = async () => {
    const state = await signOut.run((csrf) =>
      request<SessionState>("POST", "/auth/signout", { csrf }),
    );
    if (state !== undefined) {
      navigate("/sign-in", { replace: true });
      session.update(state);
    }
  };
  return (
    <>
      <nav aria-label="Views">
        <ul>
          {sections.map((section) => (
            <li key={section.to}>
              <Link
                to={section.to}
                aria-current={
                  section.route === route.name
                    ? "page"
                    : section.within === route.name
                      ? "true"
                      : undefined
                }
              >
                {section.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <button type="button" className="quiet" disabled={signOut.pending} onClick={leave}>
        Sign out
      </button>
      {signOut.failure !== undefined && (
        <p className="banner-failure" role="alert">
          Signing out failed: {describeFailure(signOut.failure)}
        </p>
      )}
    </>
  );
}

// Frame is the page around every view, under a banner led by the server's
// name. After a navigation, focus moves to the new view's heading, or to the
// content while it loads, so keyboard and screen reader users start there.
function Frame({ nav, children }: { nav?: ReactNode; children: ReactNode }) {
  const main = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    (main.current?.querySelector("h1") ?? main.current)?.focus();
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
        <ErrorBoundary key={pathname} fallback={<PageFailed />}>
          {children}
        </ErrorBoundary>
      </main>
    </>
  );
}

function PageFailed() {
  return (
    <>
      <PageHeading>Something went wrong</PageHeading>
      <p>Agention could not show this page.</p>
      <div className="actions">
        <button type="button" onClick={() => window.location.reload()}>
          Reload
        </button>
      </div>
    </>
  );
}
