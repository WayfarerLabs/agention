import { type SavedView, threadsView } from "@wayfarerlabs/agention-api";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { csrf, FakeApi, failure, renderAt, threadSummary } from "../../test-support.tsx";

// The thread list's Saved views: the head's button, its sheet, and g v.

// The thread list, which fails to render while a test says so.
const failing = vi.hoisted(() => ({ list: false }));

vi.mock("../ThreadList.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ThreadList.tsx")>();
  return {
    ThreadList: () => {
      if (failing.list) {
        throw new Error("the list failed");
      }
      return <actual.ThreadList />;
    },
  };
});

let api: FakeApi;

beforeEach(() => {
  api = new FakeApi();
  failing.list = false;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  expect(api.unhandled).toEqual([]);
});

const saved = (id: number, name: string, view: Record<string, unknown>): SavedView => ({
  id,
  name,
  view: threadsView.parse(view),
});

const blocking = saved(1, "Blocking me", { impact: "blocking" });
const billing = saved(2, "Billing, by session", { agent: ["billing", "api"], group: "session" });

// serve answers the saved views from a list the test can change.
function serve(views: SavedView[] = [billing, blocking]): { views: SavedView[] } {
  const state = { views };
  api.on("GET", "/saved-views", () => ({ body: { views: state.views } }));
  return state;
}

const button = () => screen.getByRole("button", { name: /^Saved views/ });
const sheet = () => screen.getByRole("dialog", { name: "Saved views" });
const viewLink = (name: string) => within(sheet()).getByRole("link", { name });
const rowOf = (name: string) => viewLink(name).closest("li") as HTMLElement;
const posted = (path: string) => api.callsTo("POST", path).map((call) => call.body);

// openSheet opens the sheet from the head's button, once the views load.
async function openSheet(path = "/") {
  renderAt(path);
  await screen.findByRole("heading", { level: 1 });
  await waitFor(() => expect(api.callsTo("GET", "/saved-views")).not.toEqual([]));
  fireEvent.click(button());
  await within(sheet()).findByRole("link", { name: blocking.name });
  return sheet();
}

describe("Saved views in the list's head", () => {
  it("is named by the views whose list is on screen, values chosen in another order alike", async () => {
    serve();
    renderAt("/?agent=api&agent=billing&group=session");
    await waitFor(() =>
      expect(button().getAttribute("aria-label")).toBe("Saved views, Billing, by session"),
    );
    expect(button().getAttribute("title")).toBe("Saved views, Billing, by session");
    expect(button().getAttribute("aria-haspopup")).toBe("dialog");
    // Nothing set, it holds no choice, so it carries no mark.
    expect(button().querySelector(".set-mark, .badge")).toBeNull();
  });

  it("names no view once the list on screen changes from its list", async () => {
    serve();
    renderAt("/?impact=blocking&unread=true");
    await screen.findByRole("heading", { level: 1 });
    await waitFor(() => expect(api.callsTo("GET", "/saved-views")).not.toEqual([]));
    expect(button().getAttribute("aria-label")).toBe("Saved views");
  });
});

describe("the Saved views sheet", () => {
  it("lists the views by name, each linking to its list's address, the current one checked", async () => {
    serve();
    await openSheet("/?impact=blocking");
    const links = within(sheet()).getAllByRole("link", { name: /^(?!Manage)/ });
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Billing, by session", "/?agent=billing&agent=api&group=session"],
      ["Blocking me", "/?impact=blocking"],
    ]);
    expect(viewLink("Blocking me").getAttribute("aria-current")).toBe("true");
    expect(rowOf("Blocking me").querySelector("svg")).not.toBeNull();
    expect(viewLink("Billing, by session").getAttribute("aria-current")).toBeNull();
    expect(
      within(sheet()).getByRole("link", { name: "Manage saved views" }).getAttribute("href"),
    ).toBe("/settings/saved-views");
  });

  it("opens a view's list as a new entry of the history, closing the sheet and changing no view", async () => {
    serve();
    await openSheet("/?unread=true");
    const before = window.history.length;
    fireEvent.click(viewLink("Billing, by session"));
    expect(window.location.pathname + window.location.search).toBe(
      "/?agent=billing&agent=api&group=session",
    );
    expect(window.history.length).toBe(before + 1);
    expect(screen.queryByRole("dialog", { name: "Saved views" })).toBeNull();
    expect(document.activeElement).toBe(button());
    expect(api.calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("replaces another view's list with the list on screen once asked, and no other way", async () => {
    const state = serve();
    await openSheet("/?status=open&sort=due");
    // The current view offers none; each other asks first.
    expect(within(rowOf("Billing, by session")).queryByRole("button")).not.toBeNull();
    fireEvent.click(
      within(rowOf("Blocking me")).getByRole("button", { name: "Replace with this list" }),
    );
    fireEvent.click(within(rowOf("Blocking me")).getByRole("button", { name: "Cancel" }));
    expect(posted("/saved-views/1/view")).toEqual([]);
    const replaced = saved(1, "Blocking me", { status: "open", sort: "due" });
    api.on("POST", "/saved-views/1/view", (call) => {
      state.views = [billing, replaced];
      expect(call.headers["x-csrf-token"]).toBe(csrf);
      return { body: replaced };
    });
    fireEvent.click(
      within(rowOf("Blocking me")).getByRole("button", { name: "Replace with this list" }),
    );
    fireEvent.click(within(rowOf("Blocking me")).getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(viewLink("Blocking me").getAttribute("aria-current")).toBe("true"));
    expect(posted("/saved-views/1/view")).toEqual([
      { view: threadsView.parse({ status: "open", sort: "due" }) },
    ]);
    expect(within(rowOf("Blocking me")).queryByRole("button")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(viewLink("Blocking me")));
    expect(button().getAttribute("aria-label")).toBe("Saved views, Blocking me");
  });

  it("reads the views again when a replace fails, as for a view removed elsewhere", async () => {
    const state = serve();
    await openSheet("/?unread=true");
    api.on("POST", "/saved-views/1/view", () => {
      state.views = [billing];
      return failure("not_found", "saved view not found");
    });
    fireEvent.click(
      within(rowOf("Blocking me")).getByRole("button", { name: "Replace with this list" }),
    );
    fireEvent.click(within(rowOf("Blocking me")).getByRole("button", { name: "Replace" }));
    await within(sheet()).findByRole("alert");
    await waitFor(() =>
      expect(within(sheet()).queryByRole("link", { name: "Blocking me" })).toBeNull(),
    );
    expect(viewLink("Billing, by session")).toBeTruthy();
  });

  it("saves the list on screen as a new view under the name given", async () => {
    const state = serve();
    await openSheet("/?overdue=true&reverse=true");
    const overdue = saved(3, "Overdue", { overdue: true, reverse: true });
    api.on("POST", "/saved-views", () => {
      state.views = [billing, blocking, overdue];
      return { body: overdue };
    });
    fireEvent.click(within(sheet()).getByRole("button", { name: "Save as new view" }));
    const name = within(sheet()).getByRole("textbox", { name: "New view's name" });
    expect(document.activeElement).toBe(name);
    fireEvent.change(name, { target: { value: "  Overdue " } });
    fireEvent.click(within(sheet()).getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(viewLink("Overdue").getAttribute("aria-current")).toBe("true"));
    expect(posted("/saved-views")).toEqual([
      { name: "Overdue", view: threadsView.parse({ overdue: true, reverse: true }) },
    ]);
  });

  it("says why a name cannot be used, saving nothing", async () => {
    serve([]);
    renderAt("/");
    await screen.findByRole("heading", { level: 1 });
    fireEvent.click(button());
    await within(sheet()).findByText(/No saved views yet/);
    fireEvent.click(within(sheet()).getByRole("button", { name: "Save as new view" }));
    fireEvent.click(within(sheet()).getByRole("button", { name: "Save view" }));
    expect(
      within(sheet())
        .getByRole("textbox", { name: "New view's name" })
        .getAttribute("aria-invalid"),
    ).toBe("true");
    expect(posted("/saved-views")).toEqual([]);
  });
});

describe("g v", () => {
  // press presses a key where focus is, as the keyboard does.
  const press = (key: string) =>
    fireEvent.keyDown(document.activeElement ?? document.body, { key });

  it("opens the sheet on the list", async () => {
    serve();
    api.on("GET", "/threads", { body: { threads: [threadSummary()], total: 1 } });
    renderAt("/?unread=true");
    await screen.findByRole("heading", { level: 2 });
    press("g");
    press("v");
    await within(sheet()).findByRole("link", { name: blocking.name });
    expect(window.location.search).toBe("?unread=true");
  });

  it("goes to the list first from elsewhere, and opens the sheet there", async () => {
    serve();
    api.on("GET", "/registrations", { body: { registrations: [] } });
    renderAt("/sessions");
    await screen.findByRole("heading", { level: 1, name: "Sessions" });
    press("g");
    press("v");
    await within(sheet()).findByRole("link", { name: blocking.name });
    expect(window.location.pathname).toBe("/");
  });

  it.each([
    ["elsewhere", "/sessions"],
    ["on the list's own address", "/"],
  ])("forgets a press %s once the page moves on, the list never there for it", async (_, path) => {
    serve();
    // React reports the error it caught.
    vi.spyOn(console, "error").mockImplementation(() => {});
    failing.list = true;
    api.on("GET", "/registrations", { body: { registrations: [] } });
    renderAt(path);
    await screen.findAllByRole("heading");
    press("g");
    press("v");
    await screen.findByRole("heading", { name: "Something went wrong" });
    expect(window.location.pathname).toBe("/");
    failing.list = false;
    fireEvent.click(screen.getByRole("link", { name: "Sessions" }));
    await screen.findByRole("heading", { level: 1, name: "Sessions" });
    fireEvent.click(screen.getByRole("link", { name: /^Threads/ }));
    await screen.findByRole("button", { name: /^Saved views/ });
    await waitFor(() => expect(api.callsTo("GET", "/saved-views")).not.toEqual([]));
    expect(screen.queryByRole("dialog", { name: "Saved views" })).toBeNull();
  });
});
