import type { ApiKeyCreated, ApiKeyList, ApiKeySummary, Scope } from "@wayfarerlabs/agention-api";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  csrf,
  FakeApi,
  failure,
  installPasskeys,
  renderAt,
  signedIn,
} from "../../test-support.tsx";

let api: FakeApi;

beforeEach(() => {
  api = new FakeApi();
});

afterEach(() => {
  cleanup();
  expect(api.unhandled).toEqual([]);
  Reflect.deleteProperty(navigator, "credentials");
  Reflect.deleteProperty(navigator, "clipboard");
});

const time = "2026-10-27T12:00:00.000Z";
const later = "2026-12-27T12:00:00.000Z";
// cspell:disable-next-line
const secret = "agention_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const apiKey = (
  id: number,
  name: string,
  overrides: Partial<ApiKeySummary> = {},
): ApiKeySummary => ({
  id,
  name,
  scopes: ["threads:read"],
  status: "active",
  created_at: time,
  expires_at: later,
  ...overrides,
});

const dashboard = apiKey(1, "dashboard", {
  scopes: ["threads:read", "sessions:read"],
  last_used_at: time,
});
const forever = apiKey(2, "forever", { scopes: ["sessions:approve"], expires_at: undefined });
const two: ApiKeyList = { keys: [dashboard, forever], recent: true };

function serve(list: ApiKeyList) {
  api.on("GET", "/keys", { body: list });
}

const section = () => screen.getByRole("region", { name: "API keys" });
const article = (name: string) => screen.getByRole("article", { name: `API key ${name}` });
const button = (name: string) => within(section()).getByRole<HTMLButtonElement>("button", { name });
const describer = (element: HTMLElement) =>
  document.getElementById(element.getAttribute("aria-describedby") ?? "");
const scopeBox = (scope: Scope) =>
  within(section()).getByRole<HTMLInputElement>("checkbox", { name: scope });

async function open(list: ApiKeyList) {
  serve(list);
  renderAt("/settings/api-keys");
  await within(await screen.findByRole("region", { name: "API keys" })).findByRole("button", {
    name: "Create an API key",
  });
}

// startCreating opens the form and names the key.
function startCreating(name = "client") {
  fireEvent.click(button("Create an API key"));
  fireEvent.change(within(section()).getByLabelText("Name"), { target: { value: name } });
}

function created(scopes: Scope[]): ApiKeyCreated {
  return { key: apiKey(3, "client", { scopes }), secret };
}

describe("the API keys in Settings", () => {
  it("list each key with its scopes, expiry and last use, and none while there are none", async () => {
    await open(two);
    const scopesOf = (name: string) =>
      within(within(article(name)).getByRole("list", { name: "Scopes" }))
        .getAllByRole("listitem")
        .map((item) => item.textContent);
    expect(scopesOf("dashboard")).toEqual(["threads:read", "sessions:read"]);
    expect(scopesOf("forever")).toEqual(["sessions:approve"]);
    // Created, expires and last used are times; a key without an expiry or a
    // use shows fewer.
    const times = (name: string) =>
      [...article(name).querySelectorAll(".where time")].map((each) =>
        each.getAttribute("datetime"),
      );
    expect(times("dashboard")).toEqual([time, later, time]);
    expect(times("forever")).toEqual([time]);
    cleanup();

    await open({ keys: [], recent: true });
    expect(within(section()).queryAllByRole("article")).toEqual([]);
    expect(section().querySelector(".empty")).not.toBeNull();
  });

  it("marks revoked and expired keys, and offers no revoke for them", async () => {
    await open({
      keys: [
        apiKey(1, "gone", { status: "revoked", revoked_at: time }),
        apiKey(2, "old", { status: "expired", expires_at: time }),
        apiKey(3, "live"),
      ],
      recent: true,
    });
    expect(article("gone").querySelector(".tags .danger")).not.toBeNull();
    expect(article("old").querySelector(".tags .warning")).not.toBeNull();
    expect(within(article("gone")).queryByRole("button", { name: "Revoke" })).toBeNull();
    expect(within(article("old")).queryByRole("button", { name: "Revoke" })).toBeNull();
    within(article("live")).getByRole("button", { name: "Revoke" });
  });

  it("creates a key with the scopes chosen, sending a write without the read it includes", async () => {
    await open(two);
    startCreating();
    expect(document.activeElement).toBe(within(section()).getByLabelText("Name"));
    fireEvent.click(scopeBox("threads:write"));
    expect([scopeBox("threads:read").checked, scopeBox("threads:read").disabled]).toEqual([
      true,
      true,
    ]);
    fireEvent.click(scopeBox("sessions:approve"));
    expect(scopeBox("sessions:read").disabled).toBe(true);
    api.on("POST", "/keys", { body: created(["threads:write", "sessions:approve"]) });
    fireEvent.click(button("Create key"));
    await waitFor(() => expect(api.callsTo("POST", "/keys")).toHaveLength(1));
    const [call] = api.callsTo("POST", "/keys");
    expect(call?.headers["x-csrf-token"]).toBe(csrf);
    expect(call?.body).toEqual({
      name: "client",
      scopes: ["threads:write", "sessions:approve"],
      expiry: { kind: "days", days: 30 },
    });
  });

  it("keeps a read chosen before its write once the write is unchosen", async () => {
    await open(two);
    startCreating();
    fireEvent.click(scopeBox("sessions:read"));
    fireEvent.click(scopeBox("sessions:write"));
    fireEvent.click(scopeBox("sessions:write"));
    expect([scopeBox("sessions:read").checked, scopeBox("sessions:read").disabled]).toEqual([
      true,
      false,
    ]);
  });

  it("sends each expiry chosen: days, the end of a date, or none, which warns", async () => {
    const expiryOf = async (choose: () => void) => {
      startCreating();
      fireEvent.click(scopeBox("threads:read"));
      choose();
      api.on("POST", "/keys", { body: created(["threads:read"]) });
      const before = api.callsTo("POST", "/keys").length;
      fireEvent.click(button("Create key"));
      await waitFor(() => expect(api.callsTo("POST", "/keys")).toHaveLength(before + 1));
      fireEvent.click(await within(section()).findByRole("button", { name: "Done" }));
      return api.callsTo("POST", "/keys")[before]?.body;
    };
    const expiry = () => within(section()).getByLabelText<HTMLSelectElement>("Expiry");
    await open(two);

    expect(await expiryOf(() => fireEvent.change(expiry(), { target: { value: "90" } }))).toEqual(
      expect.objectContaining({ expiry: { kind: "days", days: 90 } }),
    );

    const next = new Date();
    next.setDate(next.getDate() + 10);
    const date = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`;
    const end = new Date(next.getFullYear(), next.getMonth(), next.getDate() + 1).toISOString();
    expect(
      await expiryOf(() => {
        fireEvent.change(expiry(), { target: { value: "date" } });
        fireEvent.change(within(section()).getByLabelText("Expiry date"), {
          target: { value: date },
        });
      }),
    ).toEqual(expect.objectContaining({ expiry: { kind: "date", at: end } }));

    expect(
      await expiryOf(() => {
        expect(section().querySelector("form .notice.warning")).toBeNull();
        fireEvent.change(expiry(), { target: { value: "none" } });
        // The warning is what the choice is described by.
        expect(describer(expiry())?.classList.contains("warning")).toBe(true);
      }),
    ).toEqual(expect.objectContaining({ expiry: { kind: "none" } }));
  });

  it("refuses a form without a name, a scope or a date in range, without asking the server", async () => {
    await open(two);
    fireEvent.click(button("Create an API key"));
    const expiry = within(section()).getByLabelText<HTMLSelectElement>("Expiry");
    fireEvent.change(expiry, { target: { value: "date" } });
    fireEvent.change(within(section()).getByLabelText("Expiry date"), {
      target: { value: "2000-01-01" },
    });
    fireEvent.click(button("Create key"));
    const invalid = within(section()).getByLabelText("Name");
    expect(invalid.getAttribute("aria-invalid")).toBe("true");
    expect(within(section()).getByLabelText("Expiry date").getAttribute("aria-invalid")).toBe(
      "true",
    );
    expect(section().querySelectorAll(".field-error")).toHaveLength(3);
    expect(api.callsTo("POST", "/keys")).toEqual([]);
  });

  it("shows the server's refusals: at the field it names, or above Create", async () => {
    await open(two);
    startCreating();
    fireEvent.click(scopeBox("threads:read"));
    api.on("POST", "/keys", failure("invalid_input", "must be one line", { field: "name" }));
    fireEvent.click(button("Create key"));
    await waitFor(() =>
      expect(within(section()).getByLabelText("Name").getAttribute("aria-invalid")).toBe("true"),
    );
    expect(within(section()).queryByRole("alert")).toBeNull();

    api.on(
      "POST",
      "/keys",
      failure("invalid_input", "you already have 20 API keys, the most there can be"),
    );
    fireEvent.click(button("Create key"));
    await within(section()).findByRole("alert");
    expect(within(section()).getByLabelText("Name").getAttribute("aria-invalid")).toBeNull();
  });

  it("holds back Create an API key while the operator holds the most keys there can be", async () => {
    const keys = Array.from({ length: 20 }, (_, index) => apiKey(index + 1, `key ${index + 1}`));
    await open({ keys, recent: true });
    const create = button("Create an API key");
    expect(create.disabled).toBe(true);
    expect(describer(create)).not.toBeNull();
  });

  it("shows the new secret once, copies it, and forgets it when dismissed", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await open(two);
    startCreating();
    fireEvent.click(scopeBox("sessions:read"));
    api.on("POST", "/keys", { body: created(["sessions:read"]) });
    const after: ApiKeyList = { ...two, keys: [created(["sessions:read"]).key, ...two.keys] };
    serve(after);
    fireEvent.click(button("Create key"));

    const field = await within(section()).findByLabelText<HTMLTextAreaElement>("API key");
    expect([field.value, field.readOnly]).toEqual([secret, true]);
    expect(document.activeElement).toBe(field);
    // The secret shows alone, without the list.
    expect(within(section()).queryAllByRole("article")).toEqual([]);
    fireEvent.click(button("Copy"));
    await within(section()).findByRole("status");
    expect(writeText).toHaveBeenCalledWith(secret);
    // Nothing of it reaches storage or the address.
    expect([localStorage.length, sessionStorage.length]).toEqual([0, 0]);
    expect(window.location.href).not.toContain(secret);

    fireEvent.click(button("Done"));
    await waitFor(() =>
      expect(document.activeElement).toBe(within(article("client")).getByRole("heading")),
    );
    expect(document.body.innerHTML).not.toContain(secret);
    expect(api.callsTo("GET", "/keys").length).toBeGreaterThanOrEqual(2);
  });

  it("selects the secret to copy by hand where the clipboard refuses", async () => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new DOMException("denied", "NotAllowedError")) },
      configurable: true,
    });
    await open(two);
    startCreating();
    fireEvent.click(scopeBox("threads:read"));
    api.on("POST", "/keys", { body: created(["threads:read"]) });
    fireEvent.click(button("Create key"));
    const field = await within(section()).findByLabelText<HTMLTextAreaElement>("API key");
    field.setSelectionRange(0, 0);
    fireEvent.click(button("Copy"));
    await within(section()).findByRole("status");
    expect([document.activeElement, field.selectionStart, field.selectionEnd]).toEqual([
      field,
      0,
      secret.length,
    ]);
  });

  it("cancelling the form returns focus to Create an API key", async () => {
    await open(two);
    fireEvent.click(button("Create an API key"));
    fireEvent.click(button("Cancel"));
    await waitFor(() => expect(document.activeElement).toBe(button("Create an API key")));
    expect(api.callsTo("POST", "/keys")).toEqual([]);
  });

  it("revokes a key once confirmed, moving focus to its heading", async () => {
    await open(two);
    api.on("POST", "/keys/1/revoke", {
      body: { key: { ...dashboard, status: "revoked", revoked_at: time } },
    });
    fireEvent.click(within(article("dashboard")).getByRole("button", { name: "Revoke" }));
    expect(api.callsTo("POST", "/keys/1/revoke")).toEqual([]);
    serve({ ...two, keys: [{ ...dashboard, status: "revoked", revoked_at: time }, forever] });
    fireEvent.click(within(article("dashboard")).getByRole("button", { name: "Revoke this key" }));
    await waitFor(() => expect(api.callsTo("POST", "/keys/1/revoke")).toHaveLength(1));
    expect(api.callsTo("POST", "/keys/1/revoke")[0]?.headers["x-csrf-token"]).toBe(csrf);
    await waitFor(() =>
      expect(within(article("dashboard")).queryByRole("button", { name: "Revoke" })).toBeNull(),
    );
    expect(document.activeElement).toBe(within(article("dashboard")).getByRole("heading"));
  });

  it("holds back creating and revoking until a recent sign-in, then allows them", async () => {
    installPasskeys({ id: "laptop", rawId: "laptop", type: "public-key", response: {} });
    await open({ ...two, recent: false });
    fireEvent.click(button("Create an API key"));
    const controls = () => [
      button("Create key"),
      within(article("dashboard")).getByRole("button", { name: "Revoke" }),
    ];
    for (const control of controls()) {
      expect(control).toHaveProperty("disabled", true);
      expect(describer(control)).not.toBeNull();
    }
    api
      .on("POST", "/auth/signin/begin", { body: { options: { challenge: "xyz" } } })
      .on("POST", "/auth/signin/finish", { body: signedIn });
    serve(two);
    fireEvent.click(button("Sign in again"));
    await waitFor(() =>
      expect(within(section()).queryByRole("button", { name: "Sign in again" })).toBeNull(),
    );
    for (const control of controls()) {
      expect(control).toHaveProperty("disabled", false);
    }
  });

  it("reads the list again when creating finds the sign-in too old", async () => {
    await open(two);
    startCreating();
    fireEvent.click(scopeBox("threads:read"));
    api.on("POST", "/keys", failure("not_allowed", "this needs a recent sign-in"));
    serve({ ...two, recent: false });
    fireEvent.click(button("Create key"));
    await waitFor(() => expect(button("Create key").disabled).toBe(true));
    expect(api.callsTo("GET", "/keys")).toHaveLength(2);
  });
});
