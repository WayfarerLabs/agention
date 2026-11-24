import type { GroupsAndTags, SessionsPage, SessionSummary } from "@wayfarerlabs/agention-api";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeApi, failure, type Reply, renderAt, sessionSummary } from "../../test-support.tsx";

let api: FakeApi;

beforeEach(() => {
  window.localStorage.clear();
  api = new FakeApi();
  api.on("GET", "/registrations", { body: { registrations: [] } });
});

afterEach(() => {
  cleanup();
  expect(api.unhandled).toEqual([]);
});

type Agents = SessionsPage["agents"];

const billing = { id: 4, name: "Billing" };
const archive = { id: 7, name: "archive" };

// A session in a group, or in none, approved on a day of October 2026, or
// of September for day 0.
const session = (
  name: string,
  group: { id: number; name: string } | undefined,
  day: number,
): SessionSummary =>
  sessionSummary({
    session: name,
    ...(group === undefined ? {} : { group }),
    created_at: day === 0 ? "2026-09-01T00:00:00.000Z" : `2026-10-0${day}T00:00:00.000Z`,
  });

// builder runs main in Billing, side in none and old in archive, the oldest
// of all; reviewer runs main in Billing. Billing comes first in the
// operator's order, though archive comes first by name and by its earliest
// session.
const agents: Agents = [
  {
    agent: "builder",
    tags: [],
    sessions: [
      session("side", undefined, 5),
      session("main", billing, 2),
      session("old", archive, 0),
    ],
    truncated: false,
  },
  { agent: "reviewer", tags: [], sessions: [session("main", billing, 3)], truncated: false },
];

const known: GroupsAndTags = {
  groups: [
    { ...billing, color: "blue", sessions: 2 },
    { id: 9, name: "Empty", color: "gray", sessions: 0 },
    { ...archive, color: "green", sessions: 1 },
  ],
  tags: [],
  truncated: false,
};

// serve answers the sessions and the groups, whose order a move changes.
function serve(listed: Agents) {
  const state = { known };
  api.on("GET", "/sessions", { body: { agents: listed } });
  api.on("GET", "/groups-and-tags", () => ({ body: state.known }));
  return state;
}

async function open(path = "/sessions", listed = agents) {
  const state = serve(listed);
  renderAt(path);
  await screen.findAllByRole("combobox", { name: "Group" });
  await screen.findAllByRole("button", { name: /^(Agent|Session|Group) / });
  return state;
}

const select = (name: string) => screen.getByRole<HTMLSelectElement>("combobox", { name });
const choose = (name: string, value: string) =>
  fireEvent.change(select(name), { target: { value } });
const offered = (name: string) => Array.from(select(name).options).map((each) => each.text);
const direction = () => screen.queryByRole("button", { name: /, reverse to / });
const address = () => window.location.pathname + window.location.search;
// The folds' names at a level: the groups', the agents' under a group, or
// the sessions' rows standing alone.
const heads = (level: "groups" | "agents" | "sessions", within_: HTMLElement = document.body) =>
  Array.from(
    within_.querySelectorAll(
      level === "groups"
        ? ".group-head > .fold-main > h3 > .fold-toggle"
        : level === "agents"
          ? ".fold-toggle"
          : ".session-fold",
    ),
  )
    .map((each) => each.getAttribute("aria-label") ?? "")
    .filter((label) =>
      level === "agents"
        ? label.startsWith("Agent ")
        : level === "groups"
          ? label.startsWith("Group ") || label === "No group"
          : true,
    );
const inGroup = (name: string) => {
  const button = screen.getByRole("button", { name: new RegExp(`^${name}(,|$)`) });
  return document.getElementById(button.getAttribute("aria-controls") ?? "") as HTMLElement;
};

describe("the sessions view's arrangement", () => {
  it("groups by group in the operator's order by default, agents and sessions by name", async () => {
    await open();
    expect(select("Group").value).toBe("session_group");
    expect(select("Sort").value).toBe("manual");
    expect(offered("Sort")).toEqual(["Manual", "Alphabetic", "Registration time"]);
    // Manual has no direction.
    expect(direction()).toBeNull();
    expect(heads("groups")).toEqual(["Group Billing", "Group archive", "No group"]);
    expect(heads("agents", inGroup("Group Billing"))).toEqual(["Agent builder", "Agent reviewer"]);
    expect(address()).toBe("/sessions");
  });

  it("lists an agent's sessions in a group A to Z by default", async () => {
    await open("/sessions", [
      {
        agent: "builder",
        tags: [],
        sessions: [session("zed", billing, 1), session("main", billing, 2)],
        truncated: false,
      },
    ]);
    expect(heads("sessions", inGroup("Group Billing"))).toEqual(["Session main", "Session zed"]);
  });

  it("sorts groups and agents by name, either way, no group last", async () => {
    await open();
    choose("Sort", "alphabetic");
    await waitFor(() =>
      expect(heads("groups")).toEqual(["Group archive", "Group Billing", "No group"]),
    );
    expect(address()).toBe("/sessions?sort=alphabetic");
    fireEvent.click(screen.getByRole("button", { name: "A to Z, reverse to z to a" }));
    await waitFor(() =>
      expect(heads("groups")).toEqual(["Group Billing", "Group archive", "No group"]),
    );
    expect(heads("agents", inGroup("Group Billing"))).toEqual(["Agent reviewer", "Agent builder"]);
    expect(address()).toBe("/sessions?sort=alphabetic&reverse=true");
    expect(direction()?.textContent).toBe("Z to A");
  });

  it("sorts by registration time, a group or an agent by its earliest session", async () => {
    await open();
    choose("Sort", "registered");
    // Newest first, as the thread list's Created starts.
    await waitFor(() =>
      expect(heads("groups")).toEqual(["Group Billing", "Group archive", "No group"]),
    );
    expect(direction()?.textContent).toBe("Newest first");
    expect(heads("agents", inGroup("Group Billing"))).toEqual(["Agent reviewer", "Agent builder"]);
    fireEvent.click(screen.getByRole("button", { name: "Newest first, reverse to oldest first" }));
    await waitFor(() =>
      expect(heads("groups")).toEqual(["Group archive", "Group Billing", "No group"]),
    );
    expect(heads("agents", inGroup("Group Billing"))).toEqual(["Agent builder", "Agent reviewer"]);
  });

  it("groups by agent, offering no manual order, each agent's sessions sorted", async () => {
    await open();
    choose("Group", "agent");
    // Manual is not offered grouped by agent, so the sort turns alphabetic.
    await waitFor(() => expect(select("Sort").value).toBe("alphabetic"));
    expect(offered("Sort")).toEqual(["Alphabetic", "Registration time"]);
    expect(address()).toBe("/sessions?group=agent");
    expect(heads("groups")).toEqual([]);
    expect(heads("agents")).toEqual(["Agent builder", "Agent reviewer"]);
    expect(heads("sessions")).toEqual([
      "Session main",
      "Session old",
      "Session side",
      "Session main",
    ]);
    choose("Sort", "registered");
    await waitFor(() => expect(heads("agents")).toEqual(["Agent reviewer", "Agent builder"]));
    expect(heads("sessions")).toEqual([
      "Session main",
      "Session side",
      "Session main",
      "Session old",
    ]);
    // Grouped by group again, the sort holds.
    choose("Group", "session_group");
    await waitFor(() =>
      expect(heads("groups")).toEqual(["Group Billing", "Group archive", "No group"]),
    );
    expect(address()).toBe("/sessions?sort=registered");
  });

  it("lists the sessions alone, grouped by session, each naming its agent", async () => {
    await open("/sessions?group=session");
    expect(heads("agents")).toEqual([]);
    expect(heads("sessions")).toEqual([
      "Session builder/main",
      "Session builder/old",
      "Session builder/side",
      "Session reviewer/main",
    ]);
    choose("Sort", "registered");
    await waitFor(() =>
      expect(heads("sessions")).toEqual([
        "Session builder/side",
        "Session reviewer/main",
        "Session builder/main",
        "Session builder/old",
      ]),
    );
    // Each still links to its threads.
    expect(
      screen.getByRole("link", { name: "Threads of session builder/old" }).getAttribute("href"),
    ).toBe("/?session=builder/old");
  });

  it("reads its arrangement from the address, a sort the grouping does not offer at its default", async () => {
    await open("/sessions?group=agent&sort=registered&reverse=true");
    expect(select("Group").value).toBe("agent");
    expect(select("Sort").value).toBe("registered");
    expect(direction()?.textContent).toBe("Oldest first");
    cleanup();
    await open("/sessions?group=session&sort=manual&reverse=true");
    expect(select("Sort").value).toBe("alphabetic");
    expect(direction()?.textContent).toBe("Z to A");
  });

  it("keeps its arrangement when Back returns to it", async () => {
    await open();
    choose("Group", "agent");
    await waitFor(() => expect(address()).toBe("/sessions?group=agent"));
    // Choosing replaced the address, so the entry Back returns to is it.
    fireEvent.click(screen.getByRole("link", { name: "Threads of agent builder" }));
    await screen.findByRole("heading", { level: 1, name: "Threads" });
    window.history.back();
    await waitFor(() => expect(address()).toBe("/sessions?group=agent"));
    await screen.findByRole("heading", { name: "Agents" });
    expect(select("Group").value).toBe("agent");
    expect(heads("groups")).toEqual([]);
  });
});

// A drag's data as a browser carries it, by type.
function transfer() {
  const data = new Map<string, string>();
  return {
    effectAllowed: "",
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
    get types() {
      return [...data.keys()];
    },
  };
}

// A group's head, which takes a drop, by its fold's name.
const headOf = (name: string) =>
  screen
    .getByRole("button", { name: new RegExp(`^${name}(,|$)`) })
    .closest(".fold-head") as HTMLElement;

// groupOf is the group of an id among those the server holds.
const groupOf = (state: { known: GroupsAndTags }, id: number) =>
  state.known.groups.filter((group) => group.id === id);

// orderBy has POST /groups/order take an order, the groups reloading in it.
function orderBy(state: { known: GroupsAndTags }) {
  api.on("POST", "/groups/order", (call) => {
    const ids = (call.body as { groups: number[] }).groups;
    state.known = {
      ...state.known,
      groups: ids.flatMap((id) => state.known.groups.filter((group) => group.id === id)),
    };
    return { body: {} };
  });
}

describe("the sessions view's manual order", () => {
  it("moves a group by its buttons, sending the whole order, groups it does not show among it", async () => {
    const state = await open();
    orderBy(state);
    const up = screen.getByRole("button", { name: "Move archive up" });
    // The first group shown cannot move up.
    expect(
      screen.getByRole<HTMLButtonElement>("button", { name: "Move Billing up" }).disabled,
    ).toBe(true);
    up.focus();
    fireEvent.click(up);
    await waitFor(() =>
      expect(api.callsTo("POST", "/groups/order").map((call) => call.body)).toEqual([
        { groups: [7, 4, 9] },
      ]),
    );
    await waitFor(() =>
      expect(heads("groups")).toEqual(["Group archive", "Group Billing", "No group"]),
    );
    // At the top, focus goes on to its Move down, and the move is said.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move archive down" }));
    expect(screen.getByRole("status").textContent).not.toBe("");
    // No group does not move, and no other sort moves groups.
    expect(screen.queryByRole("button", { name: /^Move No group/ })).toBeNull();
    choose("Sort", "alphabetic");
    await waitFor(() => expect(screen.queryByRole("button", { name: /^Move / })).toBeNull());
    // What the move said is gone once Manual is chosen again.
    choose("Sort", "manual");
    await screen.findByRole("button", { name: "Move archive down" });
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("keeps the order a move sent while a reload that started before it lands after", async () => {
    const state = await open();
    orderBy(state);
    // Each reload answers the groups as the server has them when it reads
    // them, and waits to be let through.
    const held: (() => void)[] = [];
    api.on("GET", "/groups-and-tags", async () => {
      const body = state.known;
      await new Promise<void>((resolve) => held.push(resolve));
      return { body };
    });
    const loads = () => api.callsTo("GET", "/groups-and-tags").length;
    const loaded = loads();
    // A poll starts before the move, then the move starts its own reload.
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(loads()).toBe(loaded + 1));
    const up = screen.getByRole("button", { name: "Move archive up" });
    up.focus();
    fireEvent.click(up);
    await waitFor(() => expect(loads()).toBe(loaded + 2));
    // The poll lands after the move was taken, with the order from before.
    held[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heads("groups")).toEqual(["Group archive", "Group Billing", "No group"]);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move archive down" }));
    // Then the move's own reload lands, with the order it sent.
    held[1]?.();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heads("groups")).toEqual(["Group archive", "Group Billing", "No group"]);
  });

  it("shows the server's order once the move's own reload lands", async () => {
    const state = await open();
    // Another client puts Billing back first just after the move is taken.
    api.on("POST", "/groups/order", () => {
      state.known = {
        ...state.known,
        groups: [4, 9, 7].flatMap((id) => state.known.groups.filter((group) => group.id === id)),
      };
      return { body: {} };
    });
    fireEvent.click(screen.getByRole("button", { name: "Move archive up" }));
    await waitFor(() => expect(api.callsTo("POST", "/groups/order")).toHaveLength(1));
    await waitFor(() =>
      expect(heads("groups")).toEqual(["Group Billing", "Group archive", "No group"]),
    );
  });

  it("keeps the order a move saved when its reload fails, until one brings the groups", async () => {
    const state = await open();
    orderBy(state);
    let failing = true;
    api.on("GET", "/groups-and-tags", () =>
      failing ? failure("internal", "internal error") : { body: state.known },
    );
    fireEvent.click(screen.getByRole("button", { name: "Move archive up" }));
    await waitFor(() => expect(api.callsTo("POST", "/groups/order")).toHaveLength(1));
    // The reload fails: the order saved still shows, and the failure says
    // so, with a retry.
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(heads("groups")).toEqual(["Group archive", "Group Billing", "No group"]);
    // Another client puts Billing back first before the retry, which the
    // list then follows.
    failing = false;
    state.known = { ...state.known, groups: [4, 9, 7].flatMap((id) => groupOf(state, id)) };
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Try again" })).toBeNull());
    await waitFor(() =>
      expect(heads("groups")).toEqual(["Group Billing", "Group archive", "No group"]),
    );
  });

  it("keeps the order a move saved when a poll from before it lands as its reload fails", async () => {
    const state = await open();
    orderBy(state);
    // Each read waits to be let through, the poll answering the groups as
    // they were when it read them, and the move's own reload failing.
    const held: (() => void)[] = [];
    let failing = false;
    api.on("GET", "/groups-and-tags", async () => {
      const reply = failing ? failure("internal", "internal error") : { body: state.known };
      await new Promise<void>((resolve) => held.push(resolve));
      return reply;
    });
    const loads = () => api.callsTo("GET", "/groups-and-tags").length;
    const loaded = loads();
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(loads()).toBe(loaded + 1));
    failing = true;
    fireEvent.click(screen.getByRole("button", { name: "Move archive up" }));
    await waitFor(() => expect(loads()).toBe(loaded + 2));
    // Both land in the same tick.
    held[0]?.();
    held[1]?.();
    await screen.findByRole("button", { name: "Try again" });
    expect(heads("groups")).toEqual(["Group archive", "Group Billing", "No group"]);
    // A later load brings the groups as the server holds them now.
    failing = false;
    state.known = { ...state.known, groups: [4, 9, 7].flatMap((id) => groupOf(state, id)) };
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(loads()).toBe(loaded + 3));
    held.at(-1)?.();
    await waitFor(() =>
      expect(heads("groups")).toEqual(["Group Billing", "Group archive", "No group"]),
    );
  });

  it("follows the groups once two moves' reloads land out of order, the newer failing", async () => {
    const state = await open();
    orderBy(state);
    // Each read waits for the answer the test gives it.
    const held: ((reply: Reply) => void)[] = [];
    api.on("GET", "/groups-and-tags", () => new Promise<Reply>((resolve) => held.push(resolve)));
    const loads = () => api.callsTo("GET", "/groups-and-tags").length;
    const loaded = loads();
    fireEvent.click(screen.getByRole("button", { name: "Move archive up" }));
    await waitFor(() => expect(loads()).toBe(loaded + 1));
    const afterFirst = state.known;
    // The first move is saved, so the second goes while its reload waits.
    const down = screen.getByRole("button", { name: "Move archive down" });
    await waitFor(() => expect(down.hasAttribute("aria-disabled")).toBe(false));
    fireEvent.click(down);
    await waitFor(() => expect(loads()).toBe(loaded + 2));
    // The second move's reload fails, then the first's lands.
    held[1]?.(failure("internal", "internal error"));
    await screen.findByRole("button", { name: "Try again" });
    held[0]?.({ body: afterFirst });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Another client puts archive first, which a retry brings.
    state.known = { ...state.known, groups: [7, 9, 4].flatMap((id) => groupOf(state, id)) };
    api.on("GET", "/groups-and-tags", () => ({ body: state.known }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Try again" })).toBeNull());
    await waitFor(() =>
      expect(heads("groups")).toEqual(["Group archive", "Group Billing", "No group"]),
    );
  });

  it("moves no group until the groups load, nor one they no longer list", async () => {
    let answer = () => undefined as void;
    api.on("GET", "/sessions", {
      body: {
        agents: [
          {
            agent: "builder",
            tags: [],
            sessions: [
              session("main", billing, 1),
              session("old", archive, 2),
              session("gone", { id: 12, name: "Gone" }, 3),
            ],
            truncated: false,
          },
        ],
      },
    });
    api.on("GET", "/groups-and-tags", async () => {
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return { body: known };
    });
    renderAt("/sessions");
    await screen.findByRole("button", { name: /^Group Billing/ });
    expect(screen.queryByRole("button", { name: /^Move / })).toBeNull();
    answer();
    await screen.findByRole("button", { name: "Move Billing down" });
    expect(screen.queryByRole("button", { name: /^Move Gone/ })).toBeNull();
    expect(
      screen
        .getByRole("button", { name: /^Group Gone/ })
        .closest("section")
        ?.querySelector(".drag-handle"),
    ).toBeNull();
  });

  it("takes no group dropped on an unfolded group's body", async () => {
    await open();
    const dragged = transfer();
    fireEvent.dragStart(headOf("Group archive").querySelector(".drag-handle") as HTMLElement, {
      dataTransfer: dragged,
    });
    const body = inGroup("Group Billing");
    expect(body.hidden).toBe(false);
    expect(fireEvent.dragOver(body, { dataTransfer: dragged })).toBe(true);
    fireEvent.drop(body, { dataTransfer: dragged });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(api.callsTo("POST", "/groups/order")).toHaveLength(0);
  });

  it("drags a group by its handle onto another's head, taking no other drag", async () => {
    await open();
    api.on("POST", "/groups/order", { body: {} });
    // Text dragged in is not taken: the head lets it pass.
    const text = transfer();
    text.setData("text/plain", "archive");
    expect(fireEvent.dragOver(headOf("Group Billing"), { dataTransfer: text })).toBe(true);
    fireEvent.drop(headOf("Group Billing"), { dataTransfer: text });
    const dragged = transfer();
    fireEvent.dragStart(headOf("Group archive").querySelector(".drag-handle") as HTMLElement, {
      dataTransfer: dragged,
    });
    expect(fireEvent.dragOver(headOf("Group Billing"), { dataTransfer: dragged })).toBe(false);
    fireEvent.drop(headOf("Group Billing"), { dataTransfer: dragged });
    await waitFor(() =>
      expect(api.callsTo("POST", "/groups/order").map((call) => call.body)).toEqual([
        { groups: [7, 4, 9] },
      ]),
    );
  });
});
