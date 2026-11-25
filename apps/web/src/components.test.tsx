import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { focusLanding, PageHeading } from "./components.tsx";

// Where a navigation lands while the page it lands on is still loading: the
// landing focusLanding left pending, which the first heading to show in it
// takes focus from.

afterEach(cleanup);

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
