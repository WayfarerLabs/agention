import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Fold, type FoldDepth, focusLanding, PageHeading } from "./components.tsx";

// Where a navigation lands while the page it lands on is still loading: the
// landing focusLanding left pending, which the first heading to show in it
// takes focus from.

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Page stands in for a page with a landing marked, whose headings show as
// its parts load: the landing's own, a second one in it, and one beside it,
// as the thread list's pane shows when it fails to render beside a thread.
function Page({ shown }: { shown: { own?: boolean; second?: boolean; beside?: boolean } }) {
  return (
    <main tabIndex={-1}>
      <section data-landing="" tabIndex={-1} aria-label="Landing">
        {shown.own === true && <PageHeading>Own</PageHeading>}
        {shown.second === true && <PageHeading>Second</PageHeading>}
      </section>
      <section aria-label="Beside">
        {shown.beside === true && <PageHeading>Beside</PageHeading>}
      </section>
    </main>
  );
}

// landOn renders the page with no heading shown yet and lands on it.
function landOn() {
  const page = render(<Page shown={{}} />);
  act(() => focusLanding(screen.getByRole("main")));
  expect(document.activeElement).toBe(screen.getByRole("region", { name: "Landing" }));
  return page;
}

const heading = (name: string) => screen.getByRole("heading", { level: 1, name });

it("leaves focus on the landing when a heading shows outside it, which its own then takes", () => {
  const { rerender } = landOn();
  rerender(<Page shown={{ beside: true }} />);
  expect(document.activeElement).toBe(screen.getByRole("region", { name: "Landing" }));
  rerender(<Page shown={{ beside: true, own: true }} />);
  expect(document.activeElement).toBe(heading("Own"));
});

it("gives focus to the first heading to show in the landing, and no other after it", () => {
  const { rerender } = landOn();
  rerender(<Page shown={{ own: true }} />);
  expect(document.activeElement).toBe(heading("Own"));
  rerender(<Page shown={{ own: true, second: true }} />);
  expect(document.activeElement).toBe(heading("Own"));
});

// Folds whose headers stand at the top of the list: an outer fold's stays
// there while the fold scrolls under it, so the fold holds its height for the
// stylesheet, which keeps what scrolls into view clear of it; an inner one's
// scrolls with its fold, and holds none, so the folds within an outer one keep
// its height.

// Nested is a fold of the depth given holding an inner one, as a session's
// fold holds its topics'.
function Nested({ depth }: { depth: FoldDepth }) {
  const fold = { folded: false, toggle: () => {} };
  return (
    <Fold level={2} depth={depth} label="Outer" {...fold}>
      <Fold level={3} depth="inner" label="Inner" {...fold}>
        <p>A row</p>
      </Fold>
    </Fold>
  );
}

it("gives an outer fold its header's height, as long as it is outer, and an inner fold none", () => {
  // Every fold's header 40 pixels tall, measured as soon as it is observed.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.classList.contains("fold-head") ? 40 : 0;
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      readonly changed: () => void;
      constructor(changed: () => void) {
        this.changed = changed;
      }
      observe() {
        this.changed();
      }
      disconnect() {}
    },
  );
  const height = (name: string) =>
    screen
      .getByRole("button", { name })
      .closest("section")
      ?.style.getPropertyValue("--fold-head-height");
  const { rerender } = render(<Nested depth="outer" />);
  expect(height("Outer")).toBe("40px");
  expect(height("Inner")).toBe("");
  rerender(<Nested depth="inner" />);
  expect(height("Outer")).toBe("");
});
