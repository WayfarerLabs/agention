import {
  createContext,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ErrorBoundary, PageFailed } from "../boundary.tsx";
import { focusLanding } from "../components.tsx";
import { ShortcutArea } from "../keyboard.tsx";
import { useMedia } from "../media.ts";

// A tab's list and what is open from it, side by side at a desktop's width
// and one at a time on a narrower screen, as on a phone: the Threads tab's
// thread list and thread (Threads.tsx), and the Sessions tab's rows and
// session (Sessions.tsx).

// At a desktop's width a tab shows its list and what is open side by side,
// on the list's address and on each opened thing's alike. 64rem is 1024px at
// the browser's default text size, the narrowest common desktop width: there
// a list pane of at least 20rem, about as wide as a phone shows the list,
// fits beside a pane of at least 36rem, a comfortable reading width, with
// the page's padding and the gap between (styles.css, .side-by-side). Like
// the 40rem at which the banner's tabs join its row, it is in rem, so larger
// text brings back one pane at a time before either grows cramped. The width
// is read in the script, not in CSS alone, since it decides what is mounted:
// one at a time, the list is not mounted while something is open.
const sideBySideQuery = "(min-width: 64rem)";

// useSideBySide says whether the window is wide enough for both panes.
export const useSideBySide = (): boolean => useMedia(sideBySideQuery);

// A list as it stands beside what is open from it, side by side, where it
// stays mounted while things open and close beside it; undefined while the
// list is on screen alone. open is the address of what is open beside it,
// and left, once nothing is, the address of what was last open, so going
// back to the list lands on that one's row.
export interface Beside {
  open: string | undefined;
  left: string | undefined;
}

export const ListBeside = createContext<Beside | undefined>(undefined);

// landFrom moves focus to where a navigation lands on the page holding an
// element, as a row does when what it opens is open beside it already.
export function landFrom(element: Element | null): void {
  const page = element?.closest("main");
  if (page !== null && page !== undefined) {
    focusLanding(page);
  }
}

// Panes is a tab's two panes, on the list's address and on each opened
// thing's: the list's pane, then the pane of what is open, which is in the
// same place at every width, so crossing the breakpoint keeps it as it is,
// with what it holds and focus. Side by side, the list's pane stays mounted,
// with its filters, folds and scroll, while things open and close beside it
// (ListBeside); the other pane mounts afresh for each address, holding what
// the caller gives it while nothing is open; each pane is named, the area of
// its shortcuts, and fails on its own. A navigation to something lands in
// its pane, as on a phone in the page's content, and one back to the list on
// the row of what it left (focusLanding). Clicking within a pane gives it
// focus, so a key both bind acts where the operator is.
export function Panes({
  sideBySide,
  open,
  list,
  detail,
}: {
  sideBySide: boolean;
  // The address of what is open, if anything is.
  open: string | undefined;
  // Each pane's name, side by side, and what it holds: the detail's while
  // nothing is open is shown side by side alone.
  list: { label: string; content: ReactNode };
  detail: { label: string; content: ReactNode };
}) {
  // What was last open, whose row going back to the list lands on.
  const [last, setLast] = useState<string>();
  if (open !== undefined && open !== last) {
    setLast(open);
  }
  const left = open === undefined ? last : undefined;
  const beside = useMemo(() => (sideBySide ? { open, left } : undefined), [sideBySide, open, left]);
  const layout = useRef<HTMLDivElement>(null);
  const listPane = useRef<HTMLElement>(null);
  const detailPane = useRef<HTMLElement>(null);
  useFocusKept(sideBySide, layout);
  usePaneTop(sideBySide, listPane);
  // A pane's own name and focus, side by side alone.
  const pane = (name: string) => (sideBySide ? { "aria-label": name, tabIndex: -1 } : {});
  return (
    <div ref={layout} className={sideBySide ? "side-by-side" : undefined}>
      {(sideBySide || open === undefined) && (
        <section ref={listPane} className="list-pane" {...pane(list.label)}>
          <ShortcutArea.Provider value={listPane}>
            <ListBeside.Provider value={beside}>
              {/* A list that fails to render leaves the other pane
                  standing. */}
              <ErrorBoundary fallback={<PageFailed />}>{list.content}</ErrorBoundary>
            </ListBeside.Provider>
          </ShortcutArea.Provider>
        </section>
      )}
      {(sideBySide || open !== undefined) && (
        <section
          ref={detailPane}
          key={open ?? ""}
          {...pane(detail.label)}
          data-landing={sideBySide && open !== undefined ? "" : undefined}
        >
          <ShortcutArea.Provider value={detailPane}>
            {/* What is open leaves the list standing when it fails to
                render, and another starts afresh. */}
            <ErrorBoundary fallback={<PageFailed />}>{detail.content}</ErrorBoundary>
          </ShortcutArea.Provider>
        </section>
      )}
    </div>
  );
}

// useFocusKept moves focus to where a navigation lands when crossing the
// breakpoint took away what held it: the list's pane, which goes below it
// while something is open, or a pane itself, which one at a time takes no
// focus.
function useFocusKept(sideBySide: boolean, layout: RefObject<HTMLElement | null>): void {
  const was = useRef(sideBySide);
  useLayoutEffect(() => {
    if (was.current === sideBySide) {
      return;
    }
    was.current = sideBySide;
    const page = layout.current?.closest("main");
    const focus = document.activeElement;
    const lost =
      focus === null || focus === document.body || focus.parentElement === layout.current;
    if (page !== null && page !== undefined && lost) {
      focusLanding(page);
    }
  }, [sideBySide, layout]);
}

// The list's pane's property holding how far below the top of the screen
// the pane starts, which its height leaves out (styles.css, .side-by-side).
const paneTop = "--pane-top";

// usePaneTop sets, side by side, how far below the top of the screen the
// list's pane starts, which its height leaves out so the pane, and the bar
// at its foot, stay within the screen: until the page scrolls the banner
// away, the pane starts below it. It measures again as the page scrolls, as
// the window resizes and as what stands above the page's content, such as
// the banner, changes in height.
function usePaneTop(sideBySide: boolean, pane: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const shown = pane.current;
    if (!sideBySide || shown === null) {
      return;
    }
    let frame: number | undefined;
    const measure = () => {
      frame = undefined;
      // The pane sticks at the top of the screen, so its top is where it
      // starts until the page scrolls past it, and 0 after.
      const top = Math.max(0, shown.getBoundingClientRect().top);
      shown.style.setProperty(paneTop, `${top}px`);
    };
    const soon = () => {
      frame ??= requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", soon, { passive: true });
    window.addEventListener("resize", soon);
    const above = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(soon);
    const page = shown.closest("main");
    for (
      let before = page?.previousElementSibling;
      before;
      before = before.previousElementSibling
    ) {
      above?.observe(before);
    }
    return () => {
      above?.disconnect();
      window.removeEventListener("scroll", soon);
      window.removeEventListener("resize", soon);
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
      }
      shown.style.removeProperty(paneTop);
    };
  }, [sideBySide, pane]);
}
