import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { absoluteTime } from "../../format.tsx";
import { csrf, type Reply, registration, renderAt } from "../../test-support.tsx";
import {
  agentsOf,
  api,
  approvals,
  backToRows,
  card,
  open,
  pendingCard,
  waiting,
} from "./registration-tests.tsx";

// facts waits for what the registration waiting on its page proposes.
async function facts(): Promise<HTMLElement> {
  const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
  return waitFor(() => {
    const list = pending.querySelector("dl");
    expect(list).not.toBeNull();
    return list as HTMLElement;
  });
}

// The sessions view's registrations: those waiting, at their addresses, and
// those decided. The approval form's own tests are in ApproveForm.test.tsx.
describe("the sessions view's registrations", () => {
  it("shows a pending registration's code as the agent relays it, and when it expires", async () => {
    open({ registrations: [registration()], sessions: [] });
    const pending = await pendingCard();
    const code = within(pending).getByText("7KQ2M-X9DPA");
    expect(code.className).toBe("code");
    // The page is named for the session it proposes.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("builder/main");
    // It warns to approve only the code the agent showed.
    expect(pending.querySelector(".notice.warning")).not.toBeNull();
  });

  it("says what a registration proposes, with the credentials of a session it has", async () => {
    open({
      registrations: [registration()],
      sessions: [{ agent: "builder", session: "main", credential_active: true }],
    });
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
    const facts = await waitFor(() => {
      const list = pending.querySelector("dl");
      expect(list).not.toBeNull();
      return list as HTMLElement;
    });
    expect(within(facts).getByText("WE26Z-8SH11")).toBeTruthy();
    // Approving onto it, or onto a new session, is a button each, the other
    // choices folded.
    expect(within(pending).getByRole("button", { name: "Approve as builder/main" })).toBeTruthy();
    expect(within(pending).getByRole("button", { name: "Approve as a new session" })).toBeTruthy();
    expect(within(pending).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(pending).queryByRole("group", { name: "Session" })).toBeNull();
    expect(
      within(pending)
        .getByRole("button", { name: "Change agent or session" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });

  it("leads from what a registration proposes to the session it has, the rows' arrangement kept", async () => {
    open(
      {
        registrations: [registration()],
        sessions: [{ agent: "builder", session: "main", credential_active: true }],
      },
      "/registrations/1?group=agent",
    );
    expect(
      within(await facts())
        .getByRole("link", { name: "main" })
        .getAttribute("href"),
    ).toBe("/sessions/builder/main?group=agent");
  });

  it("names a new session it proposes without leading anywhere", async () => {
    open({ registrations: [registration()], sessions: [] });
    expect(within(await facts()).queryByRole("link")).toBeNull();
  });

  it("approves onto a new agent and session under the proposed names, going on to it", async () => {
    const state = open({ registrations: [registration()], sessions: [] });
    api.on("POST", "/registrations/1/approve", () => {
      state.sessions = [{ agent: "builder", session: "main", credential_active: true }];
      state.registrations = [
        registration({
          status: "approved",
          decided_at: "2026-10-27T12:05:00.000Z",
          granted: { agent: "builder", session: "main", credential_active: true },
        }),
      ];
      return { body: { registration: state.registrations[0] } };
    });
    const pending = await pendingCard();
    const entries = window.history.length;
    fireEvent.click(within(pending).getByRole("button", { name: "Approve" }));
    // The page goes on to the session approved, in the registration's place
    // in the history.
    await waitFor(() => expect(window.location.pathname).toBe("/sessions/builder/main"));
    expect(window.history.length).toBe(entries);
    await backToRows();
    await waitFor(() => {
      expect(waiting()).toEqual([]);
      expect(within(card("7KQ2M-X9DPA")).getByText("approved")).toBeTruthy();
    });
    expect(approvals()).toEqual([
      { agent: { name: "builder", existing: false }, session: { name: "main", existing: false } },
    ]);
    expect(api.callsTo("POST", "/registrations/1/approve")[0]?.headers["x-csrf-token"]).toBe(csrf);
  });

  it("goes on to the session approved only once the view lists it", async () => {
    const state = open({ registrations: [registration()], sessions: [] });
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    api.on("POST", "/registrations/1/approve", () => {
      state.registrations = [];
      state.sessions = [{ agent: "builder", session: "main", credential_active: true }];
      // The sessions reload only when let.
      api.on("GET", "/sessions", async () => {
        await held;
        return { body: agentsOf(state.sessions) };
      });
      api.on("GET", "/s/builder/main/updates", { body: { updates: [], read_through: 0 } });
      return {
        body: {
          registration: registration({
            status: "approved",
            granted: { agent: "builder", session: "main", credential_active: true },
          }),
        },
      };
    });
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
    const loads = api.callsTo("GET", "/sessions").length;
    fireEvent.click(within(pending).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(api.callsTo("GET", "/sessions").length).toBeGreaterThan(loads));
    // The approval stays under way meanwhile, so it cannot be sent again.
    expect(window.location.pathname).toBe("/registrations/1");
    expect(
      within(pending).getByRole<HTMLButtonElement>("button", { name: "Approve" }).disabled,
    ).toBe(true);
    release();
    await waitFor(() => expect(window.location.pathname).toBe("/sessions/builder/main"));
    await waitFor(() => expect(document.querySelector(".session-open")).not.toBeNull());
    expect(document.querySelector(".session-page .empty")).toBeNull();
  });

  it("stays where the operator went while a decision was on its way", async () => {
    const state = open({ registrations: [registration()], sessions: [] });
    let answer = () => {};
    api.on(
      "POST",
      "/registrations/1/approve",
      () =>
        new Promise<Reply>((resolve) => {
          answer = () => {
            state.registrations = [];
            state.sessions = [{ agent: "builder", session: "main", credential_active: true }];
            resolve({
              body: {
                registration: registration({
                  status: "approved",
                  granted: { agent: "builder", session: "main", credential_active: true },
                }),
              },
            });
          };
        }),
    );
    const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
    fireEvent.click(within(pending).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(approvals()).toHaveLength(1));
    await backToRows();
    const loads = api.callsTo("GET", "/registrations").length;
    answer();
    await waitFor(() => expect(api.callsTo("GET", "/registrations").length).toBeGreaterThan(loads));
    await waitFor(() => expect(waiting()).toEqual([]));
    expect(window.location.pathname).toBe("/sessions");
  });

  it("lists every registration waiting, page by page", async () => {
    api
      .on("GET", "/registrations", (call) => {
        const status = call.url.searchParams.get("status");
        const cursor = call.url.searchParams.get("cursor");
        return {
          body:
            status !== "pending"
              ? { registrations: [] }
              : cursor === null
                ? { registrations: [registration({ id: 2, code: "AAAAA-AAAAA" })], next: "2" }
                : { registrations: [registration()] },
        };
      })
      .on("GET", "/sessions", { body: agentsOf([]) });
    renderAt("/sessions");
    await waitFor(() => expect(waiting()).toHaveLength(2));
  });

  it("rejects a registration after asking once more", async () => {
    const state = open({ registrations: [registration()], sessions: [] });
    api.on("POST", "/registrations/1/reject", () => {
      state.registrations = [
        registration({ status: "rejected", decided_at: "2026-10-27T12:05:00.000Z" }),
      ];
      return { body: { registration: state.registrations[0] } };
    });
    const pending = await pendingCard();
    const entries = window.history.length;
    fireEvent.click(within(pending).getByRole("button", { name: "Reject" }));
    expect(api.callsTo("POST", "/registrations/1/reject")).toEqual([]);
    fireEvent.click(within(pending).getByRole("button", { name: "Reject registration" }));
    // The page goes back to the rows, in the registration's place in the
    // history, the request among the past ones.
    await waitFor(() => expect(window.location.pathname).toBe("/sessions"));
    expect(window.history.length).toBe(entries);
    await waitFor(() => expect(within(card("7KQ2M-X9DPA")).getByText("rejected")).toBeTruthy());
    expect(api.callsTo("POST", "/registrations/1/reject")).toHaveLength(1);
  });

  it("revokes an approved credential, marking a session left without one", async () => {
    const state = open(
      {
        registrations: [
          registration({
            status: "approved",
            decided_at: "2026-10-27T12:05:00.000Z",
            granted: { agent: "builder", session: "main", credential_active: true },
          }),
        ],
        sessions: [],
      },
      "/sessions",
    );
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

  it("leads from a past request to the session it granted, the rows' arrangement kept", async () => {
    open(
      {
        registrations: [
          registration({
            status: "approved",
            decided_at: "2026-10-27T12:05:00.000Z",
            granted: { agent: "builder", session: "main", credential_active: true },
          }),
        ],
        sessions: [],
      },
      "/sessions?group=session",
    );
    await waitFor(() => expect(card("7KQ2M-X9DPA")).toBeTruthy());
    expect(
      within(card("7KQ2M-X9DPA")).getByRole("link", { name: "builder/main" }).getAttribute("href"),
    ).toBe("/sessions/builder/main?group=session");
  });

  it("says at a registration's address when it no longer waits", async () => {
    open({ registrations: [registration({ status: "expired" })], sessions: [] });
    expect(await screen.findByRole("heading", { level: 1, name: "Registration" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("shows an expired registration as expired, with nothing to approve", async () => {
    open({ registrations: [registration({ status: "expired" })], sessions: [] }, "/sessions");
    await waitFor(() => expect(card("7KQ2M-X9DPA")).toBeTruthy());
    const expired = card("7KQ2M-X9DPA");
    expect(within(expired).getByText("expired")).toBeTruthy();
    expect(expired.textContent).toContain(absoluteTime("2026-10-27T13:00:00.000Z"));
    expect(within(expired).queryByRole("button")).toBeNull();
  });
});
