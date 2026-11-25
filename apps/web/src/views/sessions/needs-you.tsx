import { plain, plural } from "../../format.tsx";
import { Link } from "../../router.tsx";
import { Chips } from "../list/Chips.tsx";
import { type SessionsView, sessionsQuery } from "./arrangement.ts";

// The marks of the sessions view's one filter, Needs you, which keeps the
// sessions whose terminal shows a permission prompt or another prompt, or
// something that stopped them (arrangement.ts, sessionNeedsYou). A session's
// row flags it, as a session's or an agent's stranded threads are flagged,
// and each agent's header and group's head counts its sessions that need the
// operator; each flag and count links to the view with the filter on,
// keeping its arrangement, and a chip beneath the head removes it, as the
// thread list's chips remove its filters.

// The view on screen, which the filter's links and chip change: its
// arrangement and filter, and choosing another in its place.
export interface ViewShown {
  view: SessionsView;
  choose: (view: SessionsView) => void;
}

// NeedsYouLink flags sessions that need the operator, in the warning's tone
// as stranded threads are flagged, linking to the view with the filter on:
// how many of a header's sessions do, such as "2 need you", or "Needs you"
// while that is not known, as when sessions were left out.
export function NeedsYouLink({
  count,
  label,
  shown,
}: {
  // How many sessions need the operator, or undefined while that is not
  // known.
  count: number | undefined;
  // What the flag sits on, for assistive technology, such as "builder".
  label: string;
  shown: ViewShown;
}) {
  const [flag, spoken] =
    count === undefined
      ? ["Needs you", `Sessions of ${label} need you`]
      : [
          `${count} ${count === 1 ? "needs" : "need"} you`,
          `${plural(count, "session")} of ${label} ${count === 1 ? "needs" : "need"} you`,
        ];
  return <FilterOn shown={shown} flag={flag} spoken={spoken} />;
}

// NeedsYouFlag flags a session's row, linking as NeedsYouLink does.
export function NeedsYouFlag({ path, shown }: { path: string; shown: ViewShown }) {
  return <FilterOn shown={shown} flag="Needs you" spoken={`${path} needs you`} />;
}

// FilterOn is a flag linking to the view with the filter on. With it on
// already, the flag is still the link, marked as leading to the page shown,
// so focus stays on it once the filter it turned on is on.
function FilterOn({ shown, flag, spoken }: { shown: ViewShown; flag: string; spoken: string }) {
  const filtered = { ...shown.view, needsYou: true };
  const on = shown.view.needsYou;
  return (
    <Link
      to={`/sessions${sessionsQuery(filtered)}`}
      follow={() => shown.choose(filtered)}
      aria-current={on ? "page" : undefined}
      aria-label={on ? spoken : `${spoken}: list the sessions that need you`}
    >
      <span className="flag warning">{flag}</span>
    </Link>
  );
}

// The filter's one chip.
const needsYouChip = [{ key: "needs_you", label: plain("Needs you") }];

// NeedsYouChip, while the filter is on, is its chip beneath the head, which
// removes it, as the thread list's chips do.
export function NeedsYouChip({ shown }: { shown: ViewShown }) {
  return (
    <Chips
      chips={shown.view.needsYou ? needsYouChip : []}
      remove={() => shown.choose({ ...shown.view, needsYou: false })}
    />
  );
}
