import type { GroupsAndTags } from "@wayfarerlabs/agention-server-api";
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

const start: GroupsAndTags = {
  groups: [
    { id: 4, name: "Billing", color: "blue", sessions: 2 },
    { id: 5, name: "Personal", color: "green", sessions: 0 },
    { id: 7, name: "Website", color: "orange", sessions: 1 },
  ],
  tags: [
    { name: "infra", color: "teal", agents: 1, sessions: 1 },
    { name: "spare", color: "gray", agents: 0, sessions: 0 },
  ],
  truncated: false,
};

// serve answers the groups and tags from a state the test can change.
function serve(known: GroupsAndTags = start): { known: GroupsAndTags } {
  const state = { known };
  api.on("GET", "/groups-and-tags", () => ({ body: state.known }));
  return state;
}

async function open(known?: GroupsAndTags) {
  const state = serve(known);
  renderAt("/settings/groups-and-tags");
  await screen.findByRole("article", { name: "Group Billing" });
  return state;
}

const list = (name: string) => screen.getByRole("region", { name });
const row = (name: string) => screen.getByRole("article", { name });
const groupNames = () =>
  within(list("Groups"))
    .getAllByRole("article")
    .map((each) => each.getAttribute("aria-label"));
const posted = (path: string) => api.callsTo("POST", path).map((call) => call.body);

describe("Settings' groups and tags", () => {
  it("lists the groups in the operator's order and the tags, each linking to its threads", async () => {
    await open();
    expect(groupNames()).toEqual(["Group Billing", "Group Personal", "Group Website"]);
    expect(row("Group Billing").querySelector(".group-chip.tone-blue")).not.toBeNull();
    const holds = (name: string) =>
      within(row(name))
        .queryAllByRole("link")
        .map((link) => link.getAttribute("href"));
    expect(holds("Group Billing")).toEqual(["/?session_group=4"]);
    // What holds nothing links nowhere.
    expect(holds("Group Personal")).toEqual([]);
    expect(holds("Tag infra")).toEqual(["/?tag=infra"]);
    expect(holds("Tag spare")).toEqual([]);
    // Each link's name holds the words it shows, so speech can name it.
    for (const link of screen.getAllByRole("link").filter((each) => each.closest("article"))) {
      expect(link.getAttribute("aria-label")).toContain(link.textContent);
    }
    // Each list's search narrows it.
    fireEvent.change(within(list("Groups")).getByRole("searchbox"), { target: { value: "bil" } });
    expect(groupNames()).toEqual(["Group Billing"]);
    fireEvent.change(within(list("Tags")).getByRole("searchbox"), { target: { value: "sp" } });
    expect(
      within(list("Tags"))
        .getAllByRole("article")
        .map((each) => each.getAttribute("aria-label")),
    ).toEqual(["Tag spare"]);
  });

  it("creates a group and a tag", async () => {
    const state = await open();
    api.on("POST", "/groups", () => {
      state.known = {
        ...state.known,
        groups: [...state.known.groups, { id: 8, name: "Release", color: "purple", sessions: 0 }],
      };
      return { body: { id: 8, name: "Release", color: "purple" } };
    });
    api.on("POST", "/tags", { body: { name: "ops", color: "red" } });
    fireEvent.click(within(list("Groups")).getByRole("button", { name: "New group" }));
    fireEvent.change(within(list("Groups")).getByRole("textbox", { name: "New group's name" }), {
      target: { value: " Release " },
    });
    fireEvent.click(within(list("Groups")).getByRole("button", { name: "Create group" }));
    await waitFor(() => expect(posted("/groups")).toEqual([{ name: "Release" }]));
    await screen.findByRole("article", { name: "Group Release" });
    fireEvent.click(within(list("Tags")).getByRole("button", { name: "New tag" }));
    fireEvent.change(within(list("Tags")).getByRole("textbox", { name: "New tag's name" }), {
      target: { value: "Ops" },
    });
    fireEvent.click(within(list("Tags")).getByRole("button", { name: "Create tag" }));
    await waitFor(() => expect(posted("/tags")).toEqual([{ name: "ops" }]));
  });

  it("renames, saying why a name was refused, and recolors at once", async () => {
    const state = await open();
    api.on("POST", "/groups/4/name", failure("conflict", "another group already has this name"));
    api.on("POST", "/groups/4/color", { body: { id: 4, name: "Billing", color: "red" } });
    api.on("POST", "/tags/infra/name", () => {
      state.known = {
        ...state.known,
        tags: state.known.tags.map((tag) =>
          tag.name === "infra" ? { ...tag, name: "platform" } : tag,
        ),
      };
      return { body: {} };
    });
    const group = row("Group Billing");
    fireEvent.click(within(group).getByRole("button", { name: "Rename" }));
    fireEvent.change(within(group).getByRole("textbox", { name: "New name" }), {
      target: { value: "Personal" },
    });
    fireEvent.click(within(group).getByRole("button", { name: "Save" }));
    await within(group).findByRole("alert");
    expect(posted("/groups/4/name")).toEqual([{ name: "Personal" }]);
    fireEvent.click(within(group).getByRole("button", { name: "Cancel" }));
    fireEvent.change(within(group).getByRole("combobox", { name: "Color of Billing" }), {
      target: { value: "red" },
    });
    await waitFor(() => expect(posted("/groups/4/color")).toEqual([{ color: "red" }]));
    // A tag is renamed in a tag's lowercase.
    const tag = row("Tag infra");
    fireEvent.click(within(tag).getByRole("button", { name: "Rename" }));
    fireEvent.change(within(tag).getByRole("textbox", { name: "New name" }), {
      target: { value: "Platform" },
    });
    fireEvent.click(within(tag).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posted("/tags/infra/name")).toEqual([{ name: "platform" }]));
    // The tag shows under its new name once the list reloads, focus on its
    // Rename there.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(row("Tag platform")).getByRole("button", { name: "Rename" }),
      ),
    );
  });

  it("removes a group or a tag only once it asks", async () => {
    await open();
    api.on("POST", "/groups/4/remove", { body: {} });
    api.on("POST", "/tags/infra/remove", { body: {} });
    const group = row("Group Billing");
    fireEvent.click(within(group).getByRole("button", { name: "Remove" }));
    const asking = within(group).getByRole("group");
    // It names what it detaches.
    expect(asking.getAttribute("aria-label")).toContain("2 sessions");
    expect(posted("/groups/4/remove")).toEqual([]);
    fireEvent.click(within(asking).getByRole("button", { name: "Remove this group" }));
    await waitFor(() => expect(posted("/groups/4/remove")).toEqual([undefined]));
    // Its controls gone with it, focus moves on to the group after it.
    await waitFor(() => expect(document.activeElement).toBe(row("Group Personal")));
    const tag = row("Tag infra");
    fireEvent.click(within(tag).getByRole("button", { name: "Remove" }));
    expect(within(tag).getByRole("group").getAttribute("aria-label")).toContain("1 agent");
    fireEvent.click(within(tag).getByRole("button", { name: "Cancel" }));
    expect(posted("/tags/infra/remove")).toEqual([]);
  });

  it("moves focus to New once the last of a list is removed", async () => {
    await open({ ...start, tags: [{ name: "spare", color: "gray", agents: 0, sessions: 0 }] });
    api.on("POST", "/tags/spare/remove", { body: {} });
    const tag = row("Tag spare");
    fireEvent.click(within(tag).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(tag).getByRole("button", { name: "Remove this tag" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(list("Tags")).getByRole("button", { name: "New tag" }),
      ),
    );
  });

  it("moves a group up and down the order, sending the whole order each time", async () => {
    const state = await open();
    let answer = () => undefined as void;
    api.on("POST", "/groups/order", async (call) => {
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      const ids = (call.body as { groups: number[] }).groups;
      state.known = {
        ...state.known,
        groups: ids.flatMap((id) => state.known.groups.filter((group) => group.id === id)),
      };
      return { body: {} };
    });
    const up = within(row("Group Website")).getByRole("button", { name: "Move Website up" });
    expect(
      within(row("Group Billing"))
        .getByRole<HTMLButtonElement>("button", { name: "Move Billing up" })
        .hasAttribute("disabled"),
    ).toBe(true);
    up.focus();
    fireEvent.click(up);
    await waitFor(() => expect(posted("/groups/order")).toEqual([{ groups: [4, 7, 5] }]));
    // While it is under way, the list shows the order sent and takes no other
    // move, focus staying on the control that moved it.
    expect(groupNames()).toEqual(["Group Billing", "Group Website", "Group Personal"]);
    const again = within(row("Group Website")).getByRole("button", { name: "Move Website up" });
    expect(again.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(again);
    fireEvent.click(again);
    answer();
    await waitFor(() =>
      expect(
        within(row("Group Website"))
          .getByRole("button", { name: "Move Website up" })
          .hasAttribute("aria-disabled"),
      ).toBe(false),
    );
    expect(posted("/groups/order")).toEqual([{ groups: [4, 7, 5] }]);
    expect(groupNames()).toEqual(["Group Billing", "Group Website", "Group Personal"]);
    // Moved to the top, it can go no further up, so focus goes to its down.
    fireEvent.click(within(row("Group Website")).getByRole("button", { name: "Move Website up" }));
    await waitFor(() => expect(posted("/groups/order").at(-1)).toEqual({ groups: [7, 4, 5] }));
    answer();
    await waitFor(() =>
      expect(groupNames()).toEqual(["Group Website", "Group Billing", "Group Personal"]),
    );
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Move Website down");
    // While a search narrows the list, the groups do not move.
    fireEvent.change(within(list("Groups")).getByRole("searchbox"), { target: { value: "i" } });
    expect(
      within(row("Group Billing"))
        .getByRole<HTMLButtonElement>("button", { name: "Move Billing down" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("shows a group another client created while a move is under way", async () => {
    const state = await open();
    let answer = () => undefined as void;
    api.on("POST", "/groups/order", async () => {
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return { body: {} };
    });
    fireEvent.click(within(row("Group Website")).getByRole("button", { name: "Move Website up" }));
    await waitFor(() => expect(posted("/groups/order")).toHaveLength(1));
    // A reload lands meanwhile, listing a group the order sent does not.
    state.known = {
      ...state.known,
      groups: [...state.known.groups, { id: 9, name: "Elsewhere", color: "teal", sessions: 0 }],
    };
    const loads = api.callsTo("GET", "/groups-and-tags").length;
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(api.callsTo("GET", "/groups-and-tags").length).toBe(loads + 1));
    await waitFor(() =>
      expect(groupNames()).toEqual([
        "Group Billing",
        "Group Website",
        "Group Personal",
        "Group Elsewhere",
      ]),
    );
    answer();
  });

  it("keeps the order a move saved when its reload fails, until one brings the groups", async () => {
    const state = await open();
    api.on("POST", "/groups/order", (call) => {
      const ids = (call.body as { groups: number[] }).groups;
      state.known = {
        ...state.known,
        groups: ids.flatMap((id) => state.known.groups.filter((group) => group.id === id)),
      };
      return { body: {} };
    });
    let failing = true;
    api.on("GET", "/groups-and-tags", () =>
      failing ? failure("internal", "internal error") : { body: state.known },
    );
    fireEvent.click(within(row("Group Website")).getByRole("button", { name: "Move Website up" }));
    await waitFor(() => expect(posted("/groups/order")).toHaveLength(1));
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(groupNames()).toEqual(["Group Billing", "Group Website", "Group Personal"]);
    // Another client puts Website first before the retry, which the list
    // then follows.
    failing = false;
    state.known = {
      ...state.known,
      groups: [7, 4, 5].flatMap((id) => state.known.groups.filter((group) => group.id === id)),
    };
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("button", { name: "Try again" })).toBeNull());
    await waitFor(() =>
      expect(groupNames()).toEqual(["Group Website", "Group Billing", "Group Personal"]),
    );
  });

  it("reloads the groups as they are when the server refuses an order as stale", async () => {
    const state = await open();
    api.on("POST", "/groups/order", () => {
      // Another client created a group since the list loaded.
      state.known = {
        ...state.known,
        groups: [...state.known.groups, { id: 9, name: "Elsewhere", color: "teal", sessions: 0 }],
      };
      return failure("invalid_input", "groups must name every group once", { field: "groups" });
    });
    const loads = api.callsTo("GET", "/groups-and-tags").length;
    fireEvent.click(within(row("Group Website")).getByRole("button", { name: "Move Website up" }));
    await within(list("Groups")).findByRole("alert");
    await waitFor(() =>
      expect(api.callsTo("GET", "/groups-and-tags").length).toBeGreaterThan(loads),
    );
    await waitFor(() =>
      expect(groupNames()).toEqual([
        "Group Billing",
        "Group Personal",
        "Group Website",
        "Group Elsewhere",
      ]),
    );
  });

  it("drags a group to another place with a mouse", async () => {
    await open();
    api.on("POST", "/groups/order", { body: {} });
    const item = (name: string) => row(name).closest("li") as HTMLElement;
    const data = new Map<string, string>();
    const transfer = {
      effectAllowed: "",
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? "",
      get types() {
        return [...data.keys()];
      },
    };
    // Only its handle drags it.
    expect(item("Group Website").hasAttribute("draggable")).toBe(false);
    fireEvent.dragStart(row("Group Website").querySelector(".drag-handle") as HTMLElement, {
      dataTransfer: transfer,
    });
    fireEvent.dragOver(item("Group Billing"), { dataTransfer: transfer });
    fireEvent.drop(item("Group Billing"), { dataTransfer: transfer });
    await waitFor(() => expect(posted("/groups/order")).toEqual([{ groups: [7, 4, 5] }]));
  });
});
