import type { SessionsPage } from "@wayfarerlabs/agention-api";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeApi, registration, renderAt, sessionSummary, stubWidth } from "../../test-support.tsx";

// The Sessions tab at a desktop's width, where the rows and the session open
// stand side by side, and across the breakpoint.

let api: FakeApi;
// Takes the page across the breakpoint, as a window resized does.
let resize: (toWide: boolean) => void;

beforeEach(() => {
  api = new FakeApi();
  resize = stubWidth();
  api.on("GET", "/registrations", { body: { registrations: [] } });
});

afterEach(() => {
  cleanup();
  expect(api.unhandled).toEqual([]);
});

const time = "2026-10-27T12:00:00.000Z";
const status = { state: "working", updated_at: time } as const;

const agents: SessionsPage["agents"] = [
  {
    agent: "builder",
    tags: [],
    truncated: false,
    sessions: [
      sessionSummary({ session: "main", status }),
      sessionSummary({ session: "side", status }),
    ],
  },
  {
    agent: "deployer",
    tags: [],
    truncated: false,
    sessions: [sessionSummary({ session: "main", status })],
  },
];

// serve answers the sessions and each session's log, of one entry, which
// reading it marks read.
function serve(listed: SessionsPage["agents"] = agents) {
  api.on("GET", "/sessions", { body: { agents: listed } });
  for (const entry of listed) {
    for (const session of entry.sessions) {
      const path = `/s/${entry.agent}/${session.session}/updates`;
      api.on("GET", path, {
        body: {
          updates: [{ seq: 1, created_at: time, state: "working", inferred: false }],
          read_through: 0,
        },
      });
      api.on("POST", `${path}/read`, { body: { read_through: 1 } });
    }
  }
}

const address = (path: string) => `/sessions/${path}`;
const listPane = () => screen.getByRole("region", { name: "Session list" });
const sessionPane = () => screen.getByRole("region", { name: "Session" });
// A row's link to its session, by the session's path.
const rowLink = (path: string) =>
  within(listPane())
    .getAllByRole<HTMLAnchorElement>("link")
    .find(
      (link) => link.getAttribute("href")?.split("?")[0] === address(path),
    ) as HTMLAnchorElement;
const paneHeading = () => within(sessionPane()).getByRole("heading", { level: 1 });
// Whether the session's pane holds a session's log.
const logShown = () => within(sessionPane()).queryByRole("list", { name: "Updates" }) !== null;
const logsAsked = (path: string) => api.callsTo("GET", `/s/${path}/updates`).length;

function press(key: string): void {
  fireEvent.keyDown(document.activeElement ?? document.body, { key });
}

async function openRows(path = "/sessions") {
  serve();
  renderAt(path);
  await screen.findByRole("button", { name: /^Agent builder/ });
}

async function openFromRows(path: string) {
  fireEvent.click(rowLink(path));
  await waitFor(() => expect(window.location.pathname).toBe(address(path)));
  await within(sessionPane()).findByRole("list", { name: "Updates" });
}

describe("side by side, at a desktop's width", () => {
  it("shows the rows beside an empty pane, each row a link", async () => {
    await openRows();
    expect(within(listPane()).queryByRole("button", { name: /^Session / })).toBeNull();
    expect(rowLink("builder/main").getAttribute("aria-current")).toBeNull();
    expect(logShown()).toBe(false);
    expect(within(sessionPane()).queryByRole("heading")).toBeNull();
    // The past requests stay with the rows.
    expect(within(listPane()).getByRole("button", { name: /^Credentials and past requests/ }));
    expect(logsAsked("builder/main")).toBe(0);
  });

  it("opens a session beside the rows at its own address, reading its log, its row marked and focus on its heading", async () => {
    await openRows();
    const kept = listPane();
    await openFromRows("builder/side");
    expect(rowLink("builder/side").getAttribute("aria-current")).toBe("page");
    expect(rowLink("builder/main").getAttribute("aria-current")).toBeNull();
    expect(document.activeElement).toBe(paneHeading());
    expect(listPane()).toBe(kept);
    await waitFor(() =>
      expect(api.callsTo("POST", "/s/builder/side/updates/read")).toHaveLength(1),
    );
    // The page has one level-one heading, the session's.
    expect(screen.getAllByRole("heading", { level: 1 })).toEqual([paneHeading()]);
  });

  it("goes back from one session to the one before, then onto the rows, landing on the row left", async () => {
    await openRows();
    await openFromRows("builder/main");
    await openFromRows("deployer/main");
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe(address("builder/main")));
    await waitFor(() => expect(rowLink("builder/main").getAttribute("aria-current")).toBe("page"));
    expect(document.activeElement).toBe(paneHeading());
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(document.activeElement).toBe(rowLink("builder/main"));
    expect(logShown()).toBe(false);
  });

  it("returns to the rows with u, Escape and the bar's link, focus on the row of the session left", async () => {
    await openRows();
    await openFromRows("builder/side");
    press("u");
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(document.activeElement).toBe(rowLink("builder/side"));

    await openFromRows("deployer/main");
    press("Escape");
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(document.activeElement).toBe(rowLink("deployer/main"));

    await openFromRows("builder/main");
    const bar = within(sessionPane()).getByRole("region", { name: "Session actions" });
    fireEvent.click(within(bar).getByRole("link"));
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(document.activeElement).toBe(rowLink("builder/main"));
  });

  it("moves through the rows with j and k from the open session's row, opening nothing until o", async () => {
    await openRows();
    await openFromRows("builder/side");
    press("j");
    expect(document.activeElement).toBe(rowLink("deployer/main"));
    expect(window.location.pathname).toBe(address("builder/side"));
    press("k");
    press("k");
    expect(document.activeElement).toBe(rowLink("builder/main"));
    press("o");
    await waitFor(() => expect(window.location.pathname).toBe(address("builder/main")));
    // A key of the session's pane does not act from the rows.
    rowLink("builder/main").focus();
    press("u");
    expect(window.location.pathname).toBe(address("builder/main"));
    // And o opens nothing from the session's pane, where focus stays.
    await within(sessionPane()).findByRole("list", { name: "Updates" });
    const options = within(sessionPane()).getByRole("button", { name: "Session options" });
    options.focus();
    press("o");
    expect(document.activeElement).toBe(options);
  });

  it("moves focus to the pane of the session already open when its row is followed again", async () => {
    await openRows();
    await openFromRows("builder/main");
    rowLink("builder/main").focus();
    const entries = window.history.length;
    fireEvent.click(rowLink("builder/main"));
    expect(document.activeElement).toBe(paneHeading());
    expect(window.history.length).toBe(entries);
  });

  it("keeps the arrangement with each session's address, and through Back as it was last set", async () => {
    await openRows("/sessions?group=agent");
    await openFromRows("builder/main");
    expect(window.location.search).toBe("?group=agent");
    await openFromRows("builder/side");
    fireEvent.change(within(listPane()).getByRole("combobox", { name: "Group" }), {
      target: { value: "session" },
    });
    await waitFor(() => expect(window.location.search).toBe("?group=session"));
    expect(window.location.pathname).toBe(address("builder/side"));
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe(address("builder/main")));
    expect(window.location.search).toBe("?group=session");
    expect(
      within(listPane()).getByRole<HTMLSelectElement>("combobox", { name: "Group" }).value,
    ).toBe("session");
  });

  it("opens a session's address directly, beside the rows", async () => {
    await openRows(address("deployer/main"));
    await within(sessionPane()).findByRole("list", { name: "Updates" });
    expect(rowLink("deployer/main").getAttribute("aria-current")).toBe("page");
  });

  it("holds the pane, with its way back alone, at the address of a session the view does not list", async () => {
    await openRows(address("builder/gone"));
    await waitFor(() => expect(paneHeading()).toBeTruthy());
    expect(logShown()).toBe(false);
    expect(within(sessionPane()).queryByRole("button")).toBeNull();
    const bar = within(sessionPane()).getByRole("region", { name: "Session actions" });
    expect(within(bar).getByRole("link").getAttribute("href")).toBe("/sessions");
    expect(api.callsTo("GET", "/s/builder/gone/updates")).toEqual([]);
  });

  // serveWaiting answers the registrations waiting with one.
  const serveWaiting = (waiting = registration()) =>
    api.on("GET", "/registrations", (call) => ({
      body: {
        registrations: call.url.searchParams.get("status") === "pending" ? [waiting] : [],
      },
    }));
  const registrationPane = () => screen.getByRole("region", { name: "Session" });
  const waitingRow = () =>
    within(listPane()).getByRole("link", { name: /^Registration 7KQ2M-X9DPA for / });
  const newAgentName = () =>
    screen.getByRole<HTMLInputElement>("textbox", { name: "New agent name" });

  it("opens a registration waiting from its row above the agents, at its own address", async () => {
    serveWaiting(registration({ proposed_agent: "reviewer" }));
    await openRows();
    const fold = within(listPane()).getByRole("button", { name: /^Waiting for approval/ });
    const agents = within(listPane()).getByRole("heading", { level: 2, name: "Agents" });
    expect(fold.compareDocumentPosition(agents) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(waitingRow());
    await waitFor(() => expect(window.location.pathname).toBe("/registrations/1"));
    const card = await within(registrationPane()).findByRole("article", {
      name: "Registration 7KQ2M-X9DPA",
    });
    expect(within(card).getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(waitingRow().getAttribute("aria-current")).toBe("page");
    expect(document.activeElement).toBe(paneHeading());
    window.history.back();
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(document.activeElement).toBe(waitingRow());
  });

  it("leads from a session's row to a registration waiting to be approved onto it", async () => {
    serveWaiting();
    await openRows();
    const sessionRow = rowLink("builder/main").closest("li") as HTMLElement;
    fireEvent.click(within(sessionRow).getByRole("link", { name: /^Registration 7KQ2M-X9DPA/ }));
    await waitFor(() => expect(window.location.pathname).toBe("/registrations/1"));
    // Approving onto the session it has is a button of its own.
    const card = await within(registrationPane()).findByRole("article", {
      name: "Registration 7KQ2M-X9DPA",
    });
    expect(within(card).getByRole("button", { name: "Approve as builder/main" })).toBeTruthy();
  });

  it("keeps what an approval form holds, and focus on it, across the breakpoint", async () => {
    serveWaiting(registration({ proposed_session: "nightly" }));
    await openRows("/registrations/1");
    await within(registrationPane()).findByRole("article", { name: /^Registration / });
    fireEvent.click(screen.getByRole("button", { name: "Change agent or session" }));
    fireEvent.click(screen.getByRole("radio", { name: "A new agent" }));
    fireEvent.change(newAgentName(), { target: { value: "reviewer" } });
    newAgentName().focus();
    const before = newAgentName();
    resize(false);
    expect(newAgentName()).toBe(before);
    expect(newAgentName().value).toBe("reviewer");
    expect(document.activeElement).toBe(newAgentName());
    resize(true);
    expect(newAgentName()).toBe(before);
    expect(document.activeElement).toBe(newAgentName());
  });

  it("shows no rows until the registrations waiting have loaded", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    api.on("GET", "/registrations", async () => {
      await held;
      return { body: { registrations: [registration()] } };
    });
    serve();
    renderAt("/sessions");
    await waitFor(() => expect(api.callsTo("GET", "/sessions")).toHaveLength(1));
    expect(within(listPane()).queryByRole("button", { name: /^Agent builder/ })).toBeNull();
    release();
    await within(listPane()).findByRole("button", { name: /^Agent builder/ });
    expect(waitingRow()).toBeTruthy();
  });

  it("opens the new-thread sheet from the open session's options, named apart from its row's", async () => {
    await openRows();
    await openFromRows("builder/side");
    expect(screen.getAllByRole("button", { name: "Options for builder/side" })).toHaveLength(1);
    fireEvent.click(within(sessionPane()).getByRole("button", { name: "Session options" }));
    fireEvent.click(within(sessionPane()).getByRole("button", { name: "New thread" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("revokes a credential from the open session's options, the session staying open", async () => {
    await openRows();
    await openFromRows("builder/side");
    api.on("POST", "/registrations/1/revoke", { body: { registration: registration() } });
    fireEvent.click(within(sessionPane()).getByRole("button", { name: "Session options" }));
    fireEvent.click(within(sessionPane()).getByRole("button", { name: /^Revoke / }));
    fireEvent.click(within(sessionPane()).getByRole("button", { name: "Revoke credential" }));
    await waitFor(() => expect(api.callsTo("POST", "/registrations/1/revoke")).toHaveLength(1));
    await waitFor(() =>
      expect(within(sessionPane()).queryByRole("button", { name: "Revoke credential" })).toBeNull(),
    );
    expect(window.location.pathname).toBe(address("builder/side"));
    expect(logShown()).toBe(true);
    expect(rowLink("builder/side").getAttribute("aria-current")).toBe("page");
  });
});

describe("one at a time, below a desktop's width", () => {
  // A row's link to its session, the rows alone on the page.
  const lead = (path: string) =>
    screen
      .getAllByRole<HTMLAnchorElement>("link")
      .find(
        (link) => link.getAttribute("href")?.split("?")[0] === address(path),
      ) as HTMLAnchorElement;

  it("opens a row's session on a page of its own, the rows gone", async () => {
    resize(false);
    await openRows();
    expect(screen.queryByRole("region", { name: "Session list" })).toBeNull();
    fireEvent.click(lead("builder/side"));
    await waitFor(() => expect(window.location.pathname).toBe(address("builder/side")));
    await screen.findByRole("list", { name: "Updates" });
    expect(screen.queryByRole("button", { name: /^Agent / })).toBeNull();
    expect(screen.getByRole("region", { name: "Session actions" })).toBeTruthy();
  });

  it("shows a session alone at its address, and the rows alone again on going back to them", async () => {
    resize(false);
    serve();
    renderAt(address("builder/side"));
    await screen.findByRole("list", { name: "Updates" });
    expect(screen.queryByRole("button", { name: /^Agent / })).toBeNull();
    press("u");
    await screen.findByRole("button", { name: /^Agent builder/ });
    expect(window.location.pathname).toBe("/sessions");
    expect(screen.queryByRole("list", { name: "Updates" })).toBeNull();
  });

  it("keeps the session open across the breakpoint, alone and then beside the rows again", async () => {
    await openRows();
    await openFromRows("builder/side");
    const log = within(sessionPane()).getByRole("list", { name: "Updates" });
    const asked = logsAsked("builder/side");
    resize(false);
    expect(screen.queryByRole("button", { name: /^Agent / })).toBeNull();
    expect(screen.getByRole("list", { name: "Updates" })).toBe(log);
    resize(true);
    await within(listPane()).findByRole("button", { name: /^Agent builder/ });
    expect(within(sessionPane()).getByRole("list", { name: "Updates" })).toBe(log);
    expect(rowLink("builder/side").getAttribute("aria-current")).toBe("page");
    expect(logsAsked("builder/side")).toBe(asked);
  });

  it("moves through the rows with j and k, and opens the current row's session with o", async () => {
    resize(false);
    await openRows();
    press("j");
    expect(document.activeElement).toBe(lead("builder/main"));
    press("j");
    expect(document.activeElement).toBe(lead("builder/side"));
    press("k");
    expect(document.activeElement).toBe(lead("builder/main"));
    press("o");
    await waitFor(() => expect(window.location.pathname).toBe(address("builder/main")));
  });
});
