import { maxListed } from "@wayfarerlabs/agention-api";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  failure,
  type Reply,
  registration,
  renderAt,
  sessionSummary,
} from "../../test-support.tsx";
import {
  agentsOf,
  api,
  approvals,
  descriptions,
  historyWarning,
  open,
  pendingCard,
  refusesFor,
  serve,
} from "./registration-tests.tsx";

// The approval form on a registration's page (ApproveForm).
describe("the approval form", () => {
  it("folds the choice of another agent or session until asked for, Approve granting the proposed names", async () => {
    open({ registrations: [registration()], sessions: [] });
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
    const change = within(pending).getByRole("button", { name: "Change agent or session" });
    expect(change.getAttribute("aria-expanded")).toBe("false");
    expect(within(pending).queryByRole("radio")).toBeNull();
    fireEvent.click(change);
    expect(change.getAttribute("aria-expanded")).toBe("true");
    expect(within(pending).getByRole("textbox", { name: "New agent name" })).toBeTruthy();
  });

  it("approves with the group and tags picked, a group picked new created first", async () => {
    const state = open({ registrations: [registration()], sessions: [] });
    api.on("GET", "/groups-and-tags", {
      body: {
        groups: [{ id: 4, name: "Billing", color: "blue", sessions: 0 }],
        tags: [{ name: "infra", color: "teal", agents: 0, sessions: 0 }],
        truncated: false,
      },
    });
    api.on("POST", "/groups", { body: { id: 6, name: "Release", color: "purple" } });
    api.on("POST", "/registrations/1/approve", () => {
      state.registrations = [];
      return { body: { registration: registration({ status: "approved" }) } };
    });
    const pending = await pendingCard();
    const options = (open: HTMLElement) =>
      within(open)
        .queryAllByRole("option")
        .map((item) => item.textContent);
    // A group picked from those there is kept for the approval, sending
    // nothing yet.
    fireEvent.click(within(pending).getByRole("button", { name: "Group" }));
    let picker = screen.getByRole("dialog", { name: "Group for registration 7KQ2M-X9DPA" });
    await waitFor(() => expect(options(picker)).toEqual(["Billing"]));
    fireEvent.click(within(picker).getByRole("option", { name: "Billing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(within(pending).getByText("Billing").closest(".group-chip")).not.toBeNull();
    // A new one is created as it is picked, since an approval names its group
    // by id.
    fireEvent.click(within(pending).getByRole("button", { name: "Group" }));
    picker = screen.getByRole("dialog", { name: "Group for registration 7KQ2M-X9DPA" });
    await waitFor(() => expect(options(picker)).toHaveLength(2));
    fireEvent.change(within(picker).getByRole("combobox"), { target: { value: "Release" } });
    fireEvent.click(within(picker).getByRole("option", { name: "Create group “Release”" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.callsTo("POST", "/groups").map((call) => call.body)).toEqual([{ name: "Release" }]);
    // Tags, a new one among them, are kept for the approval too.
    fireEvent.click(within(pending).getByRole("button", { name: "Tags" }));
    picker = screen.getByRole("dialog", { name: "Tags for registration 7KQ2M-X9DPA" });
    await waitFor(() => expect(options(picker)).toEqual(["infra"]));
    fireEvent.click(within(picker).getByRole("option", { name: "infra" }));
    // The picker takes the next pick once that one has applied.
    await waitFor(() =>
      expect(
        within(picker).getByRole("option", { name: "infra" }).hasAttribute("aria-disabled"),
      ).toBe(false),
    );
    fireEvent.change(within(picker).getByRole("combobox"), { target: { value: "ops" } });
    fireEvent.click(within(picker).getByRole("option", { name: "Create tag “ops”" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(approvals()).toEqual([]);
    fireEvent.click(within(pending).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(approvals()).toEqual([
        {
          agent: { name: "builder", existing: false },
          session: { name: "main", existing: false, group: 6, tags: ["infra", "ops"] },
        },
      ]),
    );
  });

  it("approves into no group when Clear group was picked", async () => {
    open({ registrations: [registration()], sessions: [] });
    api.on("GET", "/groups-and-tags", {
      body: {
        groups: [{ id: 4, name: "Billing", color: "blue", sessions: 0 }],
        tags: [],
        truncated: false,
      },
    });
    api.on("POST", "/registrations/1/approve", { body: { registration: registration() } });
    const pending = await pendingCard();
    const pick = async (name: string) => {
      fireEvent.click(within(pending).getByRole("button", { name: "Group" }));
      const picker = screen.getByRole("dialog", { name: "Group for registration 7KQ2M-X9DPA" });
      fireEvent.click(await within(picker).findByRole("option", { name }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    };
    await pick("Billing");
    await pick("Clear group");
    fireEvent.click(within(pending).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(approvals()).toEqual([
        {
          agent: { name: "builder", existing: false },
          session: { name: "main", existing: false, group: null },
        },
      ]),
    );
  });

  it("starts the pickers from an existing session's own group and tags, and over for another", async () => {
    api
      .on("GET", "/registrations", { body: { registrations: [registration()] } })
      .on("GET", "/sessions", {
        body: {
          agents: [
            {
              agent: "builder",
              tags: [],
              sessions: [
                sessionSummary({
                  session: "main",
                  group: { id: 4, name: "Billing" },
                  tags: ["infra"],
                }),
                sessionSummary({ session: "side" }),
              ],
              truncated: false,
            },
          ],
        },
      })
      .on("GET", "/groups-and-tags", {
        body: {
          groups: [{ id: 4, name: "Billing", color: "blue", sessions: 1 }],
          tags: [
            { name: "infra", color: "teal", agents: 0, sessions: 1 },
            { name: "urgent", color: "red", agents: 0, sessions: 0 },
          ],
          truncated: false,
        },
      })
      .on("POST", "/registrations/1/approve", { body: { registration: registration() } });
    renderAt("/registrations/1");
    const pending = await pendingCard();
    const organize = within(pending).getByRole("group", { name: "Group and tags" });
    const picked = () =>
      Array.from(organize.querySelectorAll(".organize-pick > span")).map(
        (each) => each.textContent,
      );
    const choose = (name: string) =>
      fireEvent.change(within(pending).getByRole("combobox", { name: "Existing session" }), {
        target: { value: name },
      });
    // Before a session is chosen, they start from the proposed one's own.
    expect(picked()).toEqual(["Group Billing", "Tag infra"]);
    fireEvent.click(within(pending).getByRole("radio", { name: /An existing session of builder/ }));
    expect(picked()).toEqual(["Group Billing", "Tag infra"]);
    // Its group can be cleared, and its tags changed from its own.
    fireEvent.click(within(organize).getByRole("button", { name: "Group" }));
    let picker = screen.getByRole("dialog", { name: "Group for registration 7KQ2M-X9DPA" });
    fireEvent.click(await within(picker).findByRole("option", { name: "Clear group" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(within(organize).getByRole("button", { name: "Tags" }));
    picker = screen.getByRole("dialog", { name: "Tags for registration 7KQ2M-X9DPA" });
    const infra = await within(picker).findByRole("option", { name: "infra" });
    expect(infra.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(within(picker).getByRole("option", { name: "urgent" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(picked()).toEqual(["No group", "Tag infraTag urgent"]);
    // Another session starts the picks over, from its own.
    choose("side");
    expect(picked()).toEqual(["No group", "No tags"]);
    choose("main");
    expect(picked()).toEqual(["Group Billing", "Tag infra"]);
    fireEvent.click(within(organize).getByRole("button", { name: "Group" }));
    picker = screen.getByRole("dialog", { name: "Group for registration 7KQ2M-X9DPA" });
    fireEvent.click(await within(picker).findByRole("option", { name: "Clear group" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(within(pending).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(approvals()).toEqual([
        {
          agent: { name: "builder", existing: true },
          session: { name: "main", existing: true, group: null },
        },
      ]),
    );
  });

  it("starts the session and its group and tags over when the agent changes and back", async () => {
    api
      .on("GET", "/registrations", { body: { registrations: [registration()] } })
      .on("GET", "/sessions", {
        body: {
          agents: [
            {
              agent: "builder",
              tags: [],
              sessions: [sessionSummary({ session: "main", tags: ["infra"] })],
              truncated: false,
            },
            {
              agent: "other",
              tags: [],
              sessions: [sessionSummary({ session: "x" })],
              truncated: false,
            },
          ],
        },
      });
    renderAt("/registrations/1");
    const pending = await pendingCard();
    const organize = within(pending).getByRole("group", { name: "Group and tags" });
    const picked = () =>
      Array.from(organize.querySelectorAll(".organize-pick > span")).map(
        (each) => each.textContent,
      );
    const existing = () =>
      within(pending).getByRole<HTMLInputElement>("radio", { name: /An existing session of/ });
    const agentTo = (name: string) =>
      fireEvent.change(within(pending).getByRole("combobox", { name: "Existing agent" }), {
        target: { value: name },
      });
    fireEvent.click(existing());
    expect(picked()).toEqual(["No group", "Tag infra"]);
    agentTo("other");
    agentTo("builder");
    expect(existing().checked).toBe(false);
    expect(picked()).toEqual(["No group", "Tag infra"]);
  });

  it("keeps a new session's picks as it is named, and starts them over for another agent", async () => {
    open({ registrations: [registration()], sessions: [] });
    api.on("GET", "/groups-and-tags", {
      body: {
        groups: [{ id: 4, name: "Billing", color: "blue", sessions: 0 }],
        tags: [],
        truncated: false,
      },
    });
    const pending = await pendingCard();
    const organize = within(pending).getByRole("group", { name: "Group and tags" });
    const picked = () =>
      Array.from(organize.querySelectorAll(".organize-pick > span")).map(
        (each) => each.textContent,
      );
    const pick = async () => {
      fireEvent.click(within(organize).getByRole("button", { name: "Group" }));
      const picker = screen.getByRole("dialog", { name: "Group for registration 7KQ2M-X9DPA" });
      fireEvent.click(await within(picker).findByRole("option", { name: "Billing" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(picked()).toEqual(["Group Billing", "No tags"]);
    };
    await pick();
    fireEvent.change(within(pending).getByLabelText("New session name"), {
      target: { value: "night-shift" },
    });
    expect(picked()).toEqual(["Group Billing", "No tags"]);
    fireEvent.change(within(pending).getByLabelText("New agent name"), {
      target: { value: "deployer" },
    });
    expect(picked()).toEqual(["No group", "No tags"]);
  });

  it("drops a group created for a session the form no longer names", async () => {
    open({ registrations: [registration()], sessions: [] });
    api.on("GET", "/groups-and-tags", { body: { groups: [], tags: [], truncated: false } });
    let answer = () => undefined as void;
    api.on("POST", "/groups", async () => {
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return { body: { id: 6, name: "Release", color: "purple" } };
    });
    api.on("POST", "/registrations/1/approve", { body: { registration: registration() } });
    const pending = await pendingCard();
    const organize = within(pending).getByRole("group", { name: "Group and tags" });
    fireEvent.click(within(organize).getByRole("button", { name: "Group" }));
    const picker = screen.getByRole("dialog", { name: "Group for registration 7KQ2M-X9DPA" });
    const search = within(picker).getByRole("combobox");
    fireEvent.change(search, { target: { value: "Release" } });
    await within(picker).findByRole("option", { name: "Create group “Release”" });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(api.callsTo("POST", "/groups")).toHaveLength(1));
    // Done closes the picker while the group is created, and another agent
    // is named before it is.
    fireEvent.click(within(picker).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.change(within(pending).getByLabelText("New agent name"), {
      target: { value: "deployer" },
    });
    answer();
    await waitFor(() => expect(api.callsTo("GET", "/groups-and-tags").length).toBeGreaterThan(1));
    expect(organize.querySelector(".organize-pick > span")?.textContent).toBe("No group");
    fireEvent.click(within(pending).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(approvals()).toEqual([
        {
          agent: { name: "deployer", existing: false },
          session: { name: "main", existing: false },
        },
      ]),
    );
  });

  it("drops a group created before the form left its session and came back", async () => {
    open({ registrations: [registration()], sessions: [] });
    api.on("GET", "/groups-and-tags", { body: { groups: [], tags: [], truncated: false } });
    let answer = () => undefined as void;
    api.on("POST", "/groups", async () => {
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return { body: { id: 6, name: "Release", color: "purple" } };
    });
    api.on("POST", "/registrations/1/approve", { body: { registration: registration() } });
    const pending = await pendingCard();
    const organize = within(pending).getByRole("group", { name: "Group and tags" });
    fireEvent.click(within(organize).getByRole("button", { name: "Group" }));
    const picker = screen.getByRole("dialog", { name: "Group for registration 7KQ2M-X9DPA" });
    const search = within(picker).getByRole("combobox");
    fireEvent.change(search, { target: { value: "Release" } });
    await within(picker).findByRole("option", { name: "Create group “Release”" });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(api.callsTo("POST", "/groups")).toHaveLength(1));
    // Done closes the picker while the group is created, and another agent
    // is named, then this one again, before it is.
    fireEvent.click(within(picker).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    for (const value of ["deployer", "builder"]) {
      fireEvent.change(within(pending).getByLabelText("New agent name"), { target: { value } });
    }
    answer();
    await waitFor(() => expect(api.callsTo("GET", "/groups-and-tags").length).toBeGreaterThan(1));
    expect(organize.querySelector(".organize-pick > span")?.textContent).toBe("No group");
    fireEvent.click(within(pending).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(approvals()).toEqual([
        {
          agent: { name: "builder", existing: false },
          session: { name: "main", existing: false },
        },
      ]),
    );
  });

  it("keeps a group picked since a group created earlier, which lands after", async () => {
    open({ registrations: [registration()], sessions: [] });
    api.on("GET", "/groups-and-tags", {
      body: {
        groups: [{ id: 4, name: "Billing", color: "blue", sessions: 0 }],
        tags: [],
        truncated: false,
      },
    });
    let answer = () => undefined as void;
    api.on("POST", "/groups", async () => {
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return { body: { id: 6, name: "Release", color: "purple" } };
    });
    const pending = await pendingCard();
    const organize = within(pending).getByRole("group", { name: "Group and tags" });
    const shown = () => organize.querySelector(".organize-pick > span")?.textContent;
    const opened = () => {
      fireEvent.click(within(organize).getByRole("button", { name: "Group" }));
      return screen.getByRole("dialog", { name: "Group for registration 7KQ2M-X9DPA" });
    };
    let picker = opened();
    fireEvent.change(within(picker).getByRole("combobox"), { target: { value: "Release" } });
    fireEvent.click(await within(picker).findByRole("option", { name: "Create group “Release”" }));
    await waitFor(() => expect(api.callsTo("POST", "/groups")).toHaveLength(1));
    fireEvent.click(within(picker).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    picker = opened();
    fireEvent.click(await within(picker).findByRole("option", { name: "Billing" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(shown()).toBe("Group Billing");
    answer();
    await waitFor(() => expect(api.callsTo("GET", "/groups-and-tags").length).toBeGreaterThan(2));
    expect(shown()).toBe("Group Billing");
  });

  it("keeps a group created earlier, which lands after, when tags are picked meanwhile", async () => {
    open({ registrations: [registration()], sessions: [] });
    api.on("GET", "/groups-and-tags", {
      body: { groups: [], tags: [{ name: "infra", color: "teal", sessions: 0 }], truncated: false },
    });
    let answer = () => undefined as void;
    api.on("POST", "/groups", async () => {
      await new Promise<void>((resolve) => {
        answer = resolve;
      });
      return { body: { id: 6, name: "Release", color: "purple" } };
    });
    const pending = await pendingCard();
    const organize = within(pending).getByRole("group", { name: "Group and tags" });
    const picked = () =>
      Array.from(organize.querySelectorAll(".organize-pick > span")).map(
        (each) => each.textContent,
      );
    fireEvent.click(within(organize).getByRole("button", { name: "Group" }));
    let picker = screen.getByRole("dialog", { name: "Group for registration 7KQ2M-X9DPA" });
    fireEvent.change(within(picker).getByRole("combobox"), { target: { value: "Release" } });
    fireEvent.click(await within(picker).findByRole("option", { name: "Create group “Release”" }));
    await waitFor(() => expect(api.callsTo("POST", "/groups")).toHaveLength(1));
    fireEvent.click(within(picker).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(within(organize).getByRole("button", { name: "Tags" }));
    picker = screen.getByRole("dialog", { name: "Tags for registration 7KQ2M-X9DPA" });
    fireEvent.click(await within(picker).findByRole("option", { name: "infra" }));
    fireEvent.click(within(picker).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    answer();
    await waitFor(() => expect(picked()).toEqual(["Group Release", "Tag infra"]));
  });

  it("picks nothing by Enter while an input method composes", async () => {
    open({ registrations: [registration()], sessions: [] });
    api.on("GET", "/groups-and-tags", { body: { groups: [], tags: [], truncated: false } });
    api.on("POST", "/groups", { body: { id: 6, name: "Release", color: "purple" } });
    const pending = await pendingCard();
    fireEvent.click(within(pending).getByRole("button", { name: "Group" }));
    const picker = screen.getByRole("dialog", { name: "Group for registration 7KQ2M-X9DPA" });
    const search = within(picker).getByRole("combobox");
    fireEvent.change(search, { target: { value: "Release" } });
    await within(picker).findByRole("option", { name: "Create group “Release”" });
    // Composing, and WebKit's Enter that commits what was composed, which
    // says it is no longer composing but carries the key code 229.
    fireEvent.keyDown(search, { key: "Enter", isComposing: true });
    fireEvent.keyDown(search, { key: "Enter", keyCode: 229 });
    expect(api.callsTo("POST", "/groups")).toHaveLength(0);
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(api.callsTo("POST", "/groups")).toHaveLength(1));
  });

  it("approves under other names than proposed", async () => {
    open({ registrations: [registration()], sessions: [] });
    api.on("POST", "/registrations/1/approve", failure("internal", "internal error"));
    const pending = await pendingCard();
    fireEvent.change(within(pending).getByLabelText("New agent name"), {
      target: { value: "deployer" },
    });
    fireEvent.change(within(pending).getByLabelText("New session name"), {
      target: { value: "night-shift" },
    });
    fireEvent.click(within(pending).getByRole("button", { name: "Approve" }));
    await screen.findByRole("alert");
    expect(approvals()).toEqual([
      {
        agent: { name: "deployer", existing: false },
        session: { name: "night-shift", existing: false },
      },
    ]);
  });

  it("chooses an existing agent, and a new session of it, by default", async () => {
    open({
      registrations: [registration({ proposed_session: "review" })],
      sessions: [
        { agent: "builder", session: "main", credential_active: true },
        { agent: "other", session: "x", credential_active: true },
      ],
    });
    api.on("POST", "/registrations/1/approve", failure("internal", "internal error"));
    const pending = await pendingCard();
    expect(
      within(pending).getByRole<HTMLSelectElement>("combobox", { name: "Existing agent" }).value,
    ).toBe("builder");
    fireEvent.click(within(pending).getByRole("button", { name: "Approve" }));
    await screen.findByRole("alert");
    expect(approvals()).toEqual([
      { agent: { name: "builder", existing: true }, session: { name: "review", existing: false } },
    ]);
  });

  it("says beside an agent's sessions when the list left some of them out", async () => {
    open({
      registrations: [registration({ proposed_agent: "other" })],
      sessions: [
        { agent: "builder", session: "main", credential_active: true },
        { agent: "other", session: "x", credential_active: true },
      ],
      truncated: ["builder"],
    });
    const pending = await pendingCard();
    const session = () => within(pending).getByRole("group", { name: "Session" });
    expect(session().querySelector("p.muted")).toBeNull();
    expect(within(pending).getByRole("group", { name: "Agent" }).querySelector("p.muted")).toBe(
      null,
    );
    fireEvent.change(within(pending).getByRole("combobox", { name: "Existing agent" }), {
      target: { value: "builder" },
    });
    expect(session().querySelector("p.muted")).not.toBeNull();
  });

  it("says beside the agents when the list stopped with agents left out", async () => {
    serve({
      registrations: [registration()],
      sessions: [{ agent: "builder", session: "main", credential_active: true }],
    });
    // Every page says more follow.
    api.on("GET", "/sessions", (call) => ({
      body: {
        ...agentsOf([{ agent: "builder", session: "main", credential_active: true }]),
        next: `${Number(call.url.searchParams.get("cursor") ?? "0") + 1}`,
      },
    }));
    renderAt("/registrations/1");
    const pending = await pendingCard();
    const agent = within(pending).getByRole("group", { name: "Agent" });
    expect(agent.querySelector("p.muted")).not.toBeNull();
    // It asks for no more agents than the notice says it lists.
    const asked = api
      .callsTo("GET", "/sessions")
      .map((call) => Number(call.url.searchParams.get("limit")));
    expect(asked.length).toBeGreaterThan(1);
    expect(asked.reduce((sum, limit) => sum + limit, 0)).toBe(maxListed);
  });

  it("offers the session the agent has and a new one, each by a button, warning of its history", async () => {
    open({
      registrations: [registration()],
      sessions: [
        { agent: "builder", session: "main", credential_active: false },
        { agent: "builder", session: "main-2", credential_active: true },
      ],
    });
    api.on("POST", "/registrations/1/approve", failure("internal", "internal error"));
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
    const onto = await within(pending).findByRole("button", { name: "Approve as builder/main" });
    expect(pending.querySelector(".decision .notice.warning")).not.toBeNull();
    // The new session's name is one the agent has not, refused before
    // sending when it has.
    const name = within(pending).getByRole<HTMLInputElement>("textbox", {
      name: "New session name",
    });
    expect(name.value).toBe("main-3");
    const asNew = within(pending).getByRole("button", { name: "Approve as a new session" });
    fireEvent.change(name, { target: { value: "main" } });
    await refusesFor(name, () => fireEvent.click(asNew));
    expect(approvals()).toEqual([]);
    fireEvent.change(name, { target: { value: "nightly" } });
    fireEvent.click(asNew);
    await screen.findByRole("alert");
    // Enter in a field approves a new session too, never the one there is.
    fireEvent.submit(name.closest("form") as HTMLFormElement);
    await waitFor(() => expect(approvals()).toHaveLength(2));
    fireEvent.click(onto);
    await waitFor(() => expect(approvals()).toHaveLength(3));
    expect(approvals()).toEqual([
      {
        agent: { name: "builder", existing: true },
        session: { name: "nightly", existing: false, group: null, tags: [] },
      },
      {
        agent: { name: "builder", existing: true },
        session: { name: "nightly", existing: false, group: null, tags: [] },
      },
      {
        agent: { name: "builder", existing: true },
        session: { name: "main", existing: true, group: null, tags: [] },
      },
    ]);
  });

  // serveOwn answers with builder/main in the group Billing, tagged infra,
  // which the registration proposes, and the groups and tags to pick from.
  const serveOwn = () =>
    api
      .on("GET", "/registrations", { body: { registrations: [registration()] } })
      .on("GET", "/sessions", {
        body: {
          agents: [
            {
              agent: "builder",
              tags: [],
              sessions: [
                sessionSummary({
                  session: "main",
                  group: { id: 4, name: "Billing" },
                  tags: ["infra"],
                }),
              ],
              truncated: false,
            },
          ],
        },
      })
      .on("GET", "/groups-and-tags", {
        body: {
          groups: [{ id: 4, name: "Billing", color: "blue", sessions: 1 }],
          tags: [
            { name: "infra", color: "teal", agents: 0, sessions: 1 },
            { name: "urgent", color: "red", agents: 0, sessions: 0 },
          ],
          truncated: false,
        },
      })
      .on("POST", "/registrations/1/approve", failure("internal", "internal error"));

  // The registration's page as serveOwn serves it, and the group and tags
  // its pickers show.
  async function ownPage() {
    serveOwn();
    renderAt("/registrations/1");
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
    const organize = await within(pending).findByRole("group", { name: "Group and tags" });
    const picked = () =>
      Array.from(organize.querySelectorAll(".organize-pick > span")).map(
        (each) => each.textContent,
      );
    const addTag = async (name: string) => {
      fireEvent.click(within(organize).getByRole("button", { name: "Tags" }));
      const picker = screen.getByRole("dialog", { name: "Tags for registration 7KQ2M-X9DPA" });
      fireEvent.click(await within(picker).findByRole("option", { name }));
      fireEvent.click(within(picker).getByRole("button", { name: "Done" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    };
    return { pending, picked, addTag };
  }

  it("approves onto the session the agent has with the group and tags shown, its own and those added", async () => {
    const { pending, picked, addTag } = await ownPage();
    expect(picked()).toEqual(["Group Billing", "Tag infra"]);
    await addTag("urgent");
    expect(picked()).toEqual(["Group Billing", "Tag infraTag urgent"]);
    fireEvent.click(within(pending).getByRole("button", { name: "Approve as builder/main" }));
    await waitFor(() =>
      expect(approvals()).toEqual([
        {
          agent: { name: "builder", existing: true },
          session: { name: "main", existing: true, group: 4, tags: ["infra", "urgent"] },
        },
      ]),
    );
  });

  it("gives a new session by its button the group and tags shown", async () => {
    const { pending, picked } = await ownPage();
    expect(picked()).toEqual(["Group Billing", "Tag infra"]);
    fireEvent.click(within(pending).getByRole("button", { name: "Approve as a new session" }));
    await waitFor(() =>
      expect(approvals()).toEqual([
        {
          agent: { name: "builder", existing: true },
          session: { name: "main-2", existing: false, group: 4, tags: ["infra"] },
        },
      ]),
    );
  });

  it("keeps the group and tags picked before a session is chosen, for the session approved", async () => {
    const { pending, picked, addTag } = await ownPage();
    await addTag("urgent");
    // Choosing a session among the other choices keeps the pick, and shows
    // that session's own beside it; a new one has none of its own.
    fireEvent.click(within(pending).getByRole("button", { name: "Change agent or session" }));
    fireEvent.click(within(pending).getByRole("radio", { name: "A new session" }));
    expect(picked()).toEqual(["No group", "Tag infraTag urgent"]);
    expect(
      within(pending).getByRole<HTMLInputElement>("textbox", { name: "New session name" }).value,
    ).toBe("main-2");
    fireEvent.click(within(pending).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(approvals()).toEqual([
        {
          agent: { name: "builder", existing: true },
          session: { name: "main-2", existing: false, tags: ["infra", "urgent"] },
        },
      ]),
    );
  });

  it("carries a name typed for the new session into the other choices", async () => {
    const { pending } = await ownPage();
    fireEvent.change(within(pending).getByRole("textbox", { name: "New session name" }), {
      target: { value: "nightly" },
    });
    fireEvent.click(within(pending).getByRole("button", { name: "Change agent or session" }));
    fireEvent.click(within(pending).getByRole("radio", { name: "A new session" }));
    expect(
      within(pending).getByRole<HTMLInputElement>("textbox", { name: "New session name" }).value,
    ).toBe("nightly");
  });

  it("shows the server's refusal of the session approved onto by its button as the form's", async () => {
    open({
      registrations: [registration()],
      sessions: [{ agent: "builder", session: "main", credential_active: true }],
    });
    api.on(
      "POST",
      "/registrations/1/approve",
      failure("invalid_input", "names a session that no longer exists", { field: "session.name" }),
    );
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
    const name = await within(pending).findByRole("textbox", { name: "New session name" });
    const before = descriptions(name);
    fireEvent.click(within(pending).getByRole("button", { name: "Approve as builder/main" }));
    await within(pending).findByRole("alert");
    // It is not tied to the new session's name, which the button did not send.
    expect(descriptions(name)).toEqual(before);
    expect(name.getAttribute("aria-invalid")).toBeNull();
  });

  it("offers Reject while the agents fail to load", async () => {
    const state = serve({ registrations: [registration()], sessions: [] });
    api.on("GET", "/sessions", failure("internal", "internal error"));
    api.on("POST", "/registrations/1/reject", () => {
      state.registrations = [registration({ status: "rejected" })];
      return { body: { registration: state.registrations[0] } };
    });
    renderAt("/registrations/1");
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
    await within(pending).findByRole("button", { name: "Try again" });
    expect(within(pending).queryByRole("button", { name: /^Approve/ })).toBeNull();
    fireEvent.click(within(pending).getByRole("button", { name: "Reject" }));
    fireEvent.click(within(pending).getByRole("button", { name: "Reject registration" }));
    await waitFor(() => expect(api.callsTo("POST", "/registrations/1/reject")).toHaveLength(1));
  });

  it("sends Approve or Reject once while either is under way, and reloads when refused", async () => {
    open({ registrations: [registration()], sessions: [] });
    let refuse = () => {};
    api.on(
      "POST",
      "/registrations/1/approve",
      () =>
        new Promise<Reply>((resolve) => {
          refuse = () => resolve(failure("conflict", "is no longer pending"));
        }),
    );
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
    const button = (name: string) =>
      within(pending).getByRole<HTMLButtonElement>("button", { name });
    fireEvent.click(button("Approve"));
    await waitFor(() => expect(approvals()).toHaveLength(1));
    expect([button("Approve").disabled, button("Reject").disabled]).toEqual([true, true]);
    fireEvent.click(button("Approve"));
    fireEvent.click(button("Reject"));
    expect(within(pending).queryByRole("button", { name: "Reject registration" })).toBeNull();
    const loads = api.callsTo("GET", "/registrations").length;
    refuse();
    await within(pending).findByRole("alert");
    expect(button("Approve").disabled).toBe(false);
    expect(approvals()).toHaveLength(1);
    // A refusal, as of a registration decided meanwhile, reloads the view.
    await waitFor(() => expect(api.callsTo("GET", "/registrations").length).toBeGreaterThan(loads));
  });

  it("starts the session choice over when another agent is chosen", async () => {
    open({
      registrations: [registration()],
      sessions: [
        { agent: "builder", session: "main", credential_active: true },
        { agent: "other", session: "x", credential_active: true },
      ],
    });
    api.on("POST", "/registrations/1/approve", failure("internal", "internal error"));
    const pending = await pendingCard();
    fireEvent.click(within(pending).getByRole("radio", { name: /An existing session of builder/ }));
    expect(historyWarning(pending)).not.toBeNull();
    fireEvent.change(within(pending).getByRole("combobox", { name: "Existing agent" }), {
      target: { value: "other" },
    });
    expect(historyWarning(pending)).toBeNull();
    expect(
      within(pending).getByRole<HTMLInputElement>("radio", { name: "A new session" }).checked,
    ).toBe(true);
    fireEvent.click(within(pending).getByRole("button", { name: "Approve" }));
    await screen.findByRole("alert");
    expect(approvals()).toEqual([
      { agent: { name: "other", existing: true }, session: { name: "main", existing: false } },
    ]);
  });

  it("follows the agent list as it changes, until the operator picks", async () => {
    const state = open({ registrations: [registration()], sessions: [] });
    const pending = await pendingCard();
    expect(within(pending).queryByRole("combobox", { name: "Existing agent" })).toBeNull();
    state.sessions = [{ agent: "builder", session: "review", credential_active: true }];
    window.dispatchEvent(new Event("focus"));
    const agent = await within(pending).findByRole<HTMLSelectElement>("combobox", {
      name: "Existing agent",
    });
    expect(agent.value).toBe("builder");
    expect(
      within(pending).getByRole<HTMLInputElement>("radio", { name: "An existing agent" }).checked,
    ).toBe(true);
    fireEvent.click(within(pending).getByRole("radio", { name: "A new agent" }));
    state.sessions = [...state.sessions, { agent: "other", session: "x", credential_active: true }];
    window.dispatchEvent(new Event("focus"));
    await within(pending).findByRole("option", { name: "other" });
    expect(
      within(pending).getByRole<HTMLInputElement>("radio", { name: "A new agent" }).checked,
    ).toBe(true);
  });

  it("keeps a typed agent name when the proposed agent appears meanwhile", async () => {
    const state = open({ registrations: [registration()], sessions: [] });
    api.on("POST", "/registrations/1/approve", failure("internal", "internal error"));
    const pending = await pendingCard();
    fireEvent.change(within(pending).getByLabelText("New agent name"), {
      target: { value: "deployer" },
    });
    state.sessions = [{ agent: "builder", session: "review", credential_active: true }];
    window.dispatchEvent(new Event("focus"));
    await within(pending).findByRole("option", { name: "builder" });
    expect(
      within(pending).getByRole<HTMLInputElement>("radio", { name: "A new agent" }).checked,
    ).toBe(true);
    fireEvent.click(within(pending).getByRole("button", { name: "Approve" }));
    await screen.findByRole("alert");
    expect(approvals()).toEqual([
      { agent: { name: "deployer", existing: false }, session: { name: "main", existing: false } },
    ]);
  });

  it("refuses a malformed name or one that exists before sending, tied to its field", async () => {
    open({
      registrations: [registration()],
      sessions: [{ agent: "builder", session: "main", credential_active: true }],
    });
    const pending = await pendingCard();
    fireEvent.click(within(pending).getByRole("radio", { name: "A new agent" }));
    const agentName = within(pending).getByLabelText("New agent name");
    const approve = () => fireEvent.click(within(pending).getByRole("button", { name: "Approve" }));
    fireEvent.change(agentName, { target: { value: "Bad Name" } });
    await refusesFor(agentName, approve);
    expect(agentName.getAttribute("aria-invalid")).toBe("true");
    // A well-formed name that is taken is refused for another reason.
    const malformed = descriptions(agentName);
    fireEvent.change(agentName, { target: { value: "builder" } });
    approve();
    await waitFor(() => {
      expect(descriptions(agentName)).toHaveLength(malformed.length);
      expect(descriptions(agentName)).not.toEqual(malformed);
    });
    expect(agentName.getAttribute("aria-invalid")).toBe("true");
    expect(approvals()).toEqual([]);
  });

  it("ties the server's refusal to the name it names", async () => {
    open({ registrations: [registration()], sessions: [] });
    api.on(
      "POST",
      "/registrations/1/approve",
      failure("invalid_input", "names an agent that already exists", { field: "agent.name" }),
    );
    const pending = await pendingCard();
    const input = within(pending).getByLabelText("New agent name");
    await refusesFor(input, () =>
      fireEvent.click(within(pending).getByRole("button", { name: "Approve" })),
    );
    expect(approvals()).toHaveLength(1);
  });

  it("ties the server's refusal of the new session's name, by its button, to that name", async () => {
    open({
      registrations: [registration()],
      sessions: [{ agent: "builder", session: "main", credential_active: true }],
    });
    api.on(
      "POST",
      "/registrations/1/approve",
      failure("invalid_input", "names a session the agent already has", { field: "session.name" }),
    );
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
    const name = await within(pending).findByRole("textbox", { name: "New session name" });
    await refusesFor(name, () =>
      fireEvent.click(within(pending).getByRole("button", { name: "Approve as a new session" })),
    );
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(approvals()).toHaveLength(1);
  });

  it("shows the server's refusal of a field other than the names as the form's", async () => {
    open({ registrations: [registration()], sessions: [] });
    api.on(
      "POST",
      "/registrations/1/approve",
      failure("not_found", "not found", { field: "session.group" }),
    );
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
    fireEvent.click(within(pending).getByRole("button", { name: "Approve" }));
    await within(pending).findByRole("alert");
    // The names stay folded, neither of them refused.
    const change = within(pending).getByRole("button", { name: "Change agent or session" });
    expect(change.getAttribute("aria-expanded")).toBe("false");
    for (const name of ["New agent name", "New session name"]) {
      expect(within(pending).getByLabelText(name).getAttribute("aria-invalid")).toBeNull();
    }
  });

  it("moves focus to the confirming button as it asks, and back when cancelled", async () => {
    open({ registrations: [registration()], sessions: [] });
    const pending = await pendingCard();
    fireEvent.click(within(pending).getByRole("button", { name: "Reject" }));
    expect(document.activeElement).toBe(
      within(pending).getByRole("button", { name: "Reject registration" }),
    );
    fireEvent.click(within(pending).getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(within(pending).getByRole("button", { name: "Reject" }));
    expect(approvals()).toEqual([]);
  });
});
