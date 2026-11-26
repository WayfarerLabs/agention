import { Icon } from "../icons.tsx";
import { Link, sessionHref } from "../router.tsx";

// SessionPageLink leads to a session's own page, on the Sessions tab, from a
// place that names the session and whose name leads elsewhere, as to the
// session's threads on the thread list: a small link beside the name, an
// arrow pointing on, unlike the chevrons that fold and the one opening a
// session from its row. It goes as any link does, so Back returns to the
// place it was followed from. The tab's arrangement, which
// its address carries as a query, is the tab's own, so the link carries none
// and the rows show as they do by default.
export function SessionPageLink({
  agent,
  session,
  className,
}: {
  agent: string;
  session: string;
  className?: string;
}) {
  const name = `Open session ${agent}/${session}`;
  return (
    <Link
      to={sessionHref(agent, session)}
      className={className === undefined ? "session-page-link" : `session-page-link ${className}`}
      aria-label={name}
      title={name}
    >
      <Icon name="arrow-right" />
    </Link>
  );
}
