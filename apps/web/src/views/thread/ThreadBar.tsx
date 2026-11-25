import type { ThreadsView } from "@wayfarerlabs/agention-server-api";
import { useEffect, useId, useRef, useState } from "react";
import { ActionBar, BarButton, BarCaption, BarLink, BarSlots } from "../../action-bar.tsx";
import { listHref } from "../../router.tsx";

// The root's property holding how tall the thread's bar is, which the
// composer's Send row stands above and the page's scroll padding keeps
// clear.
const threadBarHeight = "--thread-bar-height";

// The reason Archive all waits while an ask is open to the operator.
const archiveAllWaits =
  "Archive all is available once every ask open to you is answered or declined.";

// How long the bar's status region stays empty before it says why Archive
// all waits again, in milliseconds, so a screen reader hears the same words
// as a change once more.
const sayAgainAfter = 100;

// ThreadBar is the bar at the foot of a thread's page, last in it, after the
// composer: the ways off the page, Threads, back to the list as the operator
// left it (origin), and Above and Below, the threads beside it in that list,
// held back while the page is busy leaving; and Archive all, at its end,
// disabled while the page is leaving, whose press the page decides
// (onArchive), as it does e's. While an ask is open to the operator
// (asksOpen) Archive all waits: it is unavailable, though it keeps focus, and
// once the operator has asked why, as whyAsked counts, the bar's caption says
// so, and its status region announces it on each asking.
export function ThreadBar({
  origin,
  busy,
  leaving,
  asksOpen,
  openNeighbor,
  onArchive,
  whyAsked,
}: {
  origin: ThreadsView;
  busy: boolean;
  leaving: boolean;
  asksOpen: boolean;
  openNeighbor: (direction: "above" | "below") => void;
  onArchive: () => void;
  whyAsked: number;
}) {
  const bar = useRef<HTMLElement>(null);
  const why = useId();
  const shown = whyAsked > 0;
  // What the status region says: nothing, then, a moment after each asking,
  // why Archive all waits.
  const [said, setSaid] = useState("");
  useEffect(() => {
    setSaid("");
    if (whyAsked === 0) {
      return;
    }
    const saying = setTimeout(() => setSaid(archiveAllWaits), sayAgainAfter);
    return () => clearTimeout(saying);
  }, [whyAsked]);
  return (
    <ActionBar label="Thread actions" height={threadBarHeight} bar={bar}>
      {asksOpen && (
        // Present while it applies, as Archive all's description, and shown
        // once asked for; the status region beside it announces its words,
        // so the caption is hidden from assistive technology.
        <>
          <BarCaption id={why} ownLine reason hidden={!shown} aria-hidden>
            {archiveAllWaits}
          </BarCaption>
          <p className="visually-hidden" role="status">
            {said}
          </p>
        </>
      )}
      <BarSlots>
        <BarLink to={listHref(origin)} icon="arrow-left" label="Threads" name="Back to threads" />
        <BarButton
          icon="arrow-up"
          label="Above"
          name="Thread above"
          disabled={busy}
          onClick={() => openNeighbor("above")}
        />
        <BarButton
          icon="arrow-down"
          label="Below"
          name="Thread below"
          disabled={busy}
          onClick={() => openNeighbor("below")}
        />
        <BarButton
          icon="archive"
          label="Archive all"
          trailing
          disabled={leaving}
          waitsOn={asksOpen ? why : undefined}
          onClick={onArchive}
        />
      </BarSlots>
    </ActionBar>
  );
}
