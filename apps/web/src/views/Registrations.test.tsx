import { type AgentsPage, maxListed, type Registration } from "@wayfarerlabs/agention-api";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { absoluteTime } from "../format.tsx";
import { csrf, FakeApi, failure, registration, renderAt } from "../test-support.tsx";

let api: FakeApi;

beforeEach(() => {
  api = new FakeApi();
});

afterEach(() => {
  cleanup();
  expect(api.unhandled).toEqual([]);
});

// Every session with its agent, as a test states them.
type Sessions = { agent: string; session: string; credential_active: boolean }[];

// agentsOf gives sessions as the agents list does, under their agents, those
// named in truncated saying they left some out.
function agentsOf(sessions: Sessions, truncated: string[] = []): AgentsPage {
  return {
    agents: [...new Set(sessions.map((each) => each.agent))].map((agent) => ({
      agent,
      sessions: sessions
        .filter((each) => each.agent === agent)
        .map(({ session, credential_active }) => ({ session, credential_active })),
      truncated: truncated.includes(agent),
    })),
  };
}

// serve answers the registrations and agents lists from a state the test can
// change.
function serve(state: { registrations: Registration[]; sessions: Sessions; truncated?: string[] }) {
  api
    .on("GET", "/registrations", (call) => {
      const status = call.url.searchParams.get("status");
      return {
        body: {
          registrations: state.registrations.filter(
            (entry) => status === null || entry.status === status,
          ),
        },
      };
    })
    .on("GET", "/agents", () => ({ body: agentsOf(state.sessions, state.truncated) }));
  return state;
}

async function open(state: Parameters<typeof serve>[0]) {
  serve(state);
  renderAt("/registrations");
  await screen.findByRole("heading", { name: "Waiting for approval" });
  return state;
}

const card = (code: string) => screen.getByRole("article", { name: `Registration ${code}` });

// The registrations waiting for approval, as their cards.
const waiting = () =>
  within(screen.getByRole("region", { name: "Waiting for approval" })).queryAllByRole("article");

// The warning shown while approving onto an existing session.
const historyWarning = (pending: HTMLElement) =>
  within(pending).getByRole("group", { name: "Session" }).querySelector(".notice.warning");

function approvals(): unknown[] {
  return api.callsTo("POST", "/registrations/1/approve").map((call) => call.body);
}

// The text of each element that describes a field: the hint about names, and
// a refusal tied to the field.
function descriptions(field: HTMLElement): string[] {
  return (field.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .flatMap((id) => document.getElementById(id)?.textContent ?? []);
}

// refusesFor runs submit and waits for a refusal to be tied to the field.
async function refusesFor(field: HTMLElement, submit: () => void): Promise<void> {
  const before = descriptions(field);
  submit();
  await waitFor(() => expect(descriptions(field)).toHaveLength(before.length + 1));
}

describe("the registrations page", () => {
  it("shows a pending registration's code as the agent relays it, and when it expires", async () => {
    await open({ registrations: [registration()], sessions: [] });
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
    const code = within(pending).getByText("7KQ2M-X9DPA");
    expect(code.className).toBe("code");
    expect(within(pending).getByText("builder/main")).toBeTruthy();
    // It warns to approve only the code the agent showed.
    expect(pending.querySelector(".notice.warning")).not.toBeNull();
  });

  it("approves onto a new agent and session under the proposed names", async () => {
    const state = await open({ registrations: [registration()], sessions: [] });
    api.on("POST", "/registrations/1/approve", () => {
      state.registrations = [
        registration({
          status: "approved",
          decided_at: "2026-10-27T12:05:00.000Z",
          granted: { agent: "builder", session: "main", credential_active: true },
        }),
      ];
      return { body: { registration: state.registrations[0] } };
    });
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
    fireEvent.click(within(pending).getByRole("button", { name: "Approve" }));
    await waitFor(() => {
      expect(waiting()).toEqual([]);
      expect(within(card("7KQ2M-X9DPA")).getByText("approved")).toBeTruthy();
    });
    expect(approvals()).toEqual([
      { agent: { name: "builder", existing: false }, session: { name: "main", existing: false } },
    ]);
    expect(api.callsTo("POST", "/registrations/1/approve")[0]?.headers["x-csrf-token"]).toBe(csrf);
  });

  it("approves under other names than proposed", async () => {
    await open({ registrations: [registration()], sessions: [] });
    api.on("POST", "/registrations/1/approve", failure("internal", "internal error"));
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
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
    await open({
      registrations: [registration({ proposed_session: "review" })],
      sessions: [
        { agent: "builder", session: "main", credential_active: true },
        { agent: "other", session: "x", credential_active: true },
      ],
    });
    api.on("POST", "/registrations/1/approve", failure("internal", "internal error"));
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
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
    await open({
      registrations: [registration({ proposed_agent: "other" })],
      sessions: [
        { agent: "builder", session: "main", credential_active: true },
        { agent: "other", session: "x", credential_active: true },
      ],
      truncated: ["builder"],
    });
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
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
    api.on("GET", "/agents", (call) => ({
      body: {
        ...agentsOf([{ agent: "builder", session: "main", credential_active: true }]),
        next: `${Number(call.url.searchParams.get("cursor") ?? "0") + 1}`,
      },
    }));
    renderAt("/registrations");
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
    const agent = within(pending).getByRole("group", { name: "Agent" });
    expect(agent.querySelector("p.muted")).not.toBeNull();
    // It asks for no more agents than the notice says it lists.
    const asked = api
      .callsTo("GET", "/agents")
      .map((call) => Number(call.url.searchParams.get("limit")));
    expect(asked.length).toBeGreaterThan(1);
    expect(asked.reduce((sum, limit) => sum + limit, 0)).toBe(maxListed);
  });

  it("makes the operator choose when the proposed session exists, and warns of its history", async () => {
    await open({
      registrations: [registration()],
      sessions: [{ agent: "builder", session: "main", credential_active: false }],
    });
    api.on("POST", "/registrations/1/approve", failure("internal", "internal error"));
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
    const sessionRadios = within(
      within(pending).getByRole("group", { name: "Session" }),
    ).getAllByRole("radio");
    expect(sessionRadios.map((radio) => (radio as HTMLInputElement).checked)).toEqual([
      false,
      false,
    ]);
    await refusesFor(within(pending).getByLabelText("New session name"), () =>
      fireEvent.click(within(pending).getByRole("button", { name: "Approve" })),
    );
    expect(approvals()).toEqual([]);

    fireEvent.click(within(pending).getByRole("radio", { name: /An existing session of builder/ }));
    expect(historyWarning(pending)).not.toBeNull();
    expect(
      within(pending).getByRole("option", { name: "main (no active credential)" }),
    ).toBeTruthy();
    fireEvent.click(within(pending).getByRole("button", { name: "Approve" }));
    await screen.findByRole("alert");
    expect(approvals()).toEqual([
      { agent: { name: "builder", existing: true }, session: { name: "main", existing: true } },
    ]);
  });

  it("starts the session choice over when another agent is chosen", async () => {
    await open({
      registrations: [registration()],
      sessions: [
        { agent: "builder", session: "main", credential_active: true },
        { agent: "other", session: "x", credential_active: true },
      ],
    });
    api.on("POST", "/registrations/1/approve", failure("internal", "internal error"));
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
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
    const state = await open({ registrations: [registration()], sessions: [] });
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
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
    const state = await open({ registrations: [registration()], sessions: [] });
    api.on("POST", "/registrations/1/approve", failure("internal", "internal error"));
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
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
    await open({
      registrations: [registration()],
      sessions: [{ agent: "builder", session: "main", credential_active: true }],
    });
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
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
    await open({ registrations: [registration()], sessions: [] });
    api.on(
      "POST",
      "/registrations/1/approve",
      failure("invalid_input", "names an agent that already exists", { field: "agent.name" }),
    );
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
    const input = within(pending).getByLabelText("New agent name");
    await refusesFor(input, () =>
      fireEvent.click(within(pending).getByRole("button", { name: "Approve" })),
    );
    expect(approvals()).toHaveLength(1);
  });

  it("rejects a registration after asking once more", async () => {
    const state = await open({ registrations: [registration()], sessions: [] });
    api.on("POST", "/registrations/1/reject", () => {
      state.registrations = [
        registration({ status: "rejected", decided_at: "2026-10-27T12:05:00.000Z" }),
      ];
      return { body: { registration: state.registrations[0] } };
    });
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
    fireEvent.click(within(pending).getByRole("button", { name: "Reject" }));
    expect(api.callsTo("POST", "/registrations/1/reject")).toEqual([]);
    fireEvent.click(within(pending).getByRole("button", { name: "Reject registration" }));
    await waitFor(() => expect(within(card("7KQ2M-X9DPA")).getByText("rejected")).toBeTruthy());
    expect(api.callsTo("POST", "/registrations/1/reject")).toHaveLength(1);
  });

  it("moves focus to the confirming button as it asks, and back when cancelled", async () => {
    await open({ registrations: [registration()], sessions: [] });
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
    fireEvent.click(within(pending).getByRole("button", { name: "Reject" }));
    expect(document.activeElement).toBe(
      within(pending).getByRole("button", { name: "Reject registration" }),
    );
    fireEvent.click(within(pending).getByRole("button", { name: "Cancel" }));
    expect(document.activeElement).toBe(within(pending).getByRole("button", { name: "Reject" }));
    expect(approvals()).toEqual([]);
  });

  it("revokes an approved credential, marking a session left without one", async () => {
    const state = await open({
      registrations: [
        registration({
          status: "approved",
          decided_at: "2026-10-27T12:05:00.000Z",
          granted: { agent: "builder", session: "main", credential_active: true },
        }),
      ],
      sessions: [],
    });
    api.on("POST", "/registrations/1/revoke", () => {
      state.registrations = [
        registration({
          status: "revoked",
          decided_at: "2026-10-27T12:05:00.000Z",
          revoked_at: "2026-10-27T13:00:00.000Z",
          granted: { agent: "builder", session: "main", credential_active: false },
        }),
      ];
      return { body: { registration: state.registrations[0] } };
    });
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    // The mark for a session left without a credential.
    expect(card("7KQ2M-X9DPA").querySelector(".muted")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Revoke credential" }));
    await within(card("7KQ2M-X9DPA")).findByText("revoked");
    // The approval keeps its own time, and the revocation shows at its own.
    const text = card("7KQ2M-X9DPA").textContent ?? "";
    const approvedAt = text.indexOf(absoluteTime("2026-10-27T12:05:00.000Z"));
    expect(approvedAt).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(absoluteTime("2026-10-27T13:00:00.000Z"))).toBeGreaterThan(approvedAt);
    expect(card("7KQ2M-X9DPA").querySelector(".muted")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();
  });

  it("shows an expired registration as expired, with nothing to approve", async () => {
    await open({ registrations: [registration({ status: "expired" })], sessions: [] });
    await waitFor(() => expect(card("7KQ2M-X9DPA")).toBeTruthy());
    const expired = card("7KQ2M-X9DPA");
    expect(within(expired).getByText("expired")).toBeTruthy();
    expect(expired.textContent).toContain(absoluteTime("2026-10-27T13:00:00.000Z"));
    expect(within(expired).queryByRole("button")).toBeNull();
  });
});
