import { type SavedView, threadsView } from "@wayfarerlabs/agention-api";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeApi, failure, renderAt } from "../../test-support.tsx";

let api: FakeApi;

beforeEach(() => {
  api = new FakeApi();
});

afterEach(() => {
  cleanup();
  expect(api.unhandled).toEqual([]);
});

const saved = (id: number, name: string, view: Record<string, unknown>): SavedView => ({
  id,
  name,
  view: threadsView.parse(view),
});

const blocking = saved(1, "Blocking me", { impact: "blocking" });
const overdue = saved(2, "Overdue", { overdue: true, sort: "due" });

// serve answers the saved views from a list the test can change.
function serve(views: SavedView[] = [blocking, overdue]): { views: SavedView[] } {
  const state = { views };
  api.on("GET", "/saved-views", () => ({ body: { views: state.views } }));
  return state;
}

async function open(views?: SavedView[]) {
  const state = serve(views);
  renderAt("/settings/saved-views");
  await screen.findByRole("article", { name: "Saved view Blocking me" });
  return state;
}

const row = (name: string) => screen.getByRole("article", { name: `Saved view ${name}` });
const posted = (path: string) => api.callsTo("POST", path).map((call) => call.body);

describe("Settings' saved views", () => {
  it("is listed under Features, and lists each view by name, linking to its list", async () => {
    await open();
    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(
      within(within(nav).getByRole("list", { name: "Features" })).getByRole("link", {
        name: "Saved views",
      }),
    ).toBeTruthy();
    expect(
      screen
        .getAllByRole("article")
        .map((each) => [
          each.getAttribute("aria-label"),
          within(each).getByRole("link").getAttribute("href"),
        ]),
    ).toEqual([
      ["Saved view Blocking me", "/?impact=blocking"],
      ["Saved view Overdue", "/?overdue=true&sort=due"],
    ]);
  });

  it("renames a view, focus returning to its Rename", async () => {
    const state = await open();
    api.on("POST", "/saved-views/1/name", () => {
      state.views = [{ ...blocking, name: "Blocked" }, overdue];
      return { body: state.views[0] };
    });
    fireEvent.click(within(row("Blocking me")).getByRole("button", { name: "Rename" }));
    fireEvent.change(within(row("Blocking me")).getByRole("textbox", { name: "New name" }), {
      target: { value: "Blocked" },
    });
    fireEvent.click(within(row("Blocking me")).getByRole("button", { name: "Save" }));
    await screen.findByRole("article", { name: "Saved view Blocked" });
    expect(posted("/saved-views/1/name")).toEqual([{ name: "Blocked" }]);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(row("Blocked")).getByRole("button", { name: "Rename" }),
      ),
    );
  });

  it("says why a rename was refused, keeping the field", async () => {
    await open();
    api.on(
      "POST",
      "/saved-views/1/name",
      failure("conflict", "another saved view already has this name", { field: "name" }),
    );
    fireEvent.click(within(row("Blocking me")).getByRole("button", { name: "Rename" }));
    fireEvent.change(within(row("Blocking me")).getByRole("textbox", { name: "New name" }), {
      target: { value: "overdue" },
    });
    fireEvent.click(within(row("Blocking me")).getByRole("button", { name: "Save" }));
    await within(row("Blocking me")).findByRole("alert");
    expect(within(row("Blocking me")).getByRole("textbox", { name: "New name" })).toBeTruthy();
  });

  it("removes a view once asked, focus moving to the next, and to the heading once none is left", async () => {
    const state = await open();
    api.on("POST", "/saved-views/1/remove", () => {
      state.views = [overdue];
      return { body: {} };
    });
    api.on("POST", "/saved-views/2/remove", () => {
      state.views = [];
      return { body: {} };
    });
    fireEvent.click(within(row("Blocking me")).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(row("Blocking me")).getByRole("button", { name: "Cancel" }));
    expect(posted("/saved-views/1/remove")).toEqual([]);
    fireEvent.click(within(row("Blocking me")).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(row("Blocking me")).getByRole("button", { name: "Remove this view" }));
    await waitFor(() =>
      expect(screen.queryByRole("article", { name: "Saved view Blocking me" })).toBeNull(),
    );
    expect(document.activeElement).toBe(row("Overdue"));
    fireEvent.click(within(row("Overdue")).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(row("Overdue")).getByRole("button", { name: "Remove this view" }));
    await screen.findByText(/No saved views yet/);
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { level: 2, name: "Saved views" }),
    );
  });

  it("reads the views again when a remove fails, as for a view removed elsewhere", async () => {
    const state = await open();
    api.on("POST", "/saved-views/1/remove", () => {
      state.views = [overdue];
      return failure("not_found", "saved view not found");
    });
    fireEvent.click(within(row("Blocking me")).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(row("Blocking me")).getByRole("button", { name: "Remove this view" }));
    await waitFor(() =>
      expect(screen.queryByRole("article", { name: "Saved view Blocking me" })).toBeNull(),
    );
    expect(row("Overdue")).toBeTruthy();
  });
});
