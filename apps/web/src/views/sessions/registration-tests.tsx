import type { Registration, SessionsPage } from "@wayfarerlabs/agention-api";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect } from "vitest";
import { FakeApi, renderAt, sessionSummary } from "../../test-support.tsx";

// What the tests of the sessions view's registrations share: the fake API,
// made afresh for each test, which every importing file gets, and the ways
// they serve and read the view.

export let api: FakeApi;

beforeEach(() => {
  // The credentials and past requests unfolded, as these tests read them.
  window.localStorage.setItem("agention.sessions.unfolded-sections", '["past-requests"]');
  api = new FakeApi();
});

afterEach(() => {
  cleanup();
  expect(api.unhandled).toEqual([]);
});

// Every session with its agent, as a test states them.
export type Sessions = { agent: string; session: string; credential_active: boolean }[];

// agentsOf gives sessions as the sessions view lists them, under their
// agents, those named in truncated saying they left some out.
export function agentsOf(sessions: Sessions, truncated: string[] = []): SessionsPage {
  return {
    agents: [...new Set(sessions.map((each) => each.agent))].map((agent) => ({
      agent,
      tags: [],
      sessions: sessions
        .filter((each) => each.agent === agent)
        .map(({ session, credential_active }) =>
          sessionSummary({
            session,
            registrations: credential_active ? [{ id: 9, code: "WE26Z-8SH11" }] : [],
          }),
        ),
      truncated: truncated.includes(agent),
    })),
  };
}

// serve answers the registrations and the sessions view from a state the
// test can change.
export function serve(state: {
  registrations: Registration[];
  sessions: Sessions;
  truncated?: string[];
}) {
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
    .on("GET", "/sessions", () => ({ body: agentsOf(state.sessions, state.truncated) }));
  return state;
}

// open renders the view at an address, by default the page of the
// registration numbered 1.
export function open(state: Parameters<typeof serve>[0], at = "/registrations/1") {
  serve(state);
  renderAt(at);
  return state;
}

export const card = (code: string) => screen.getByRole("article", { name: `Registration ${code}` });

// pendingCard is the registration waiting on its page, its choice of
// another agent or session shown.
export async function pendingCard(): Promise<HTMLElement> {
  const pending = await screen.findByRole("article", { name: "Registration 7KQ2M-X9DPA" });
  const change = within(pending).queryByRole("button", { name: "Change agent or session" });
  if (change !== null) {
    fireEvent.click(change);
  }
  return pending;
}

// The rows of the registrations waiting for approval, each a link to its
// page.
export const waiting = () => screen.queryAllByRole("link", { name: /^Registration \S+ for / });

// backToRows follows the bar of the page on screen back to the rows.
export async function backToRows(): Promise<void> {
  fireEvent.click(screen.getByRole("link", { name: "Back to sessions" }));
  await screen.findByRole("heading", { level: 2, name: "Agents" });
}

// The warning shown while approving onto an existing session.
export const historyWarning = (pending: HTMLElement) =>
  pending.querySelector(".notice.warning.history");

export function approvals(): unknown[] {
  return api.callsTo("POST", "/registrations/1/approve").map((call) => call.body);
}

// The text of each element that describes a field: the hint about names, and
// a refusal tied to the field.
export function descriptions(field: HTMLElement): string[] {
  return (field.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .flatMap((id) => document.getElementById(id)?.textContent ?? []);
}

// refusesFor runs submit and waits for a refusal to be tied to the field.
export async function refusesFor(field: HTMLElement, submit: () => void): Promise<void> {
  const before = descriptions(field);
  submit();
  await waitFor(() => expect(descriptions(field)).toHaveLength(before.length + 1));
}
