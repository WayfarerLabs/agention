import type { PasskeyList, PasskeySummary } from "@wayfarerlabs/agention-api";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
});

const time = "2026-10-27T12:00:00.000Z";

const passkey = (id: number, name: string, current = false): PasskeySummary => ({
  id,
  name,
  created_at: time,
  ...(current ? { last_used_at: time } : {}),
  current,
});

const both: PasskeyList = {
  passkeys: [passkey(1, "Laptop", true), passkey(2, "Phone")],
  recent: true,
};

function serve(list: PasskeyList) {
  api.on("GET", "/passkeys", { body: list });
}

const article = (name: string) => screen.getByRole("article", { name: `Passkey ${name}` });

// describer names the element that says why a control is unavailable.
const describer = (element: HTMLElement) =>
  document.getElementById(element.getAttribute("aria-describedby") ?? "");

async function open(list: PasskeyList) {
  serve(list);
  renderAt("/settings");
  await screen.findByRole("article", { name: `Passkey ${list.passkeys[0]?.name}` });
}

describe("the passkeys in Settings", () => {
  it("list each passkey, marking the one signed in with", async () => {
    await open(both);
    const passkeys = screen.getByRole("region", { name: "Passkeys" });
    expect(
      within(passkeys)
        .getAllByRole("heading", { level: 3 })
        .slice(0, 2)
        .map((h) => h.textContent),
    ).toEqual(["Laptop", "Phone"]);
    expect(article("Laptop").querySelector(".tags")).not.toBeNull();
    expect(article("Phone").querySelector(".tags")).toBeNull();
  });

  it("renames a passkey", async () => {
    await open(both);
    api.on("POST", "/passkeys/2/name", { body: {} });
    fireEvent.click(within(article("Phone")).getByRole("button", { name: "Rename" }));
    fireEvent.change(within(article("Phone")).getByLabelText("New name"), {
      target: { value: "Work phone" },
    });
    fireEvent.click(within(article("Phone")).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.callsTo("POST", "/passkeys/2/name")).toHaveLength(1));
    const [call] = api.callsTo("POST", "/passkeys/2/name");
    expect(call?.body).toEqual({ name: "Work phone" });
    expect(call?.headers["x-csrf-token"]).toBe(csrf);
  });

  it("adds a passkey on this device under the name given", async () => {
    const created = { id: "new", rawId: "new", type: "public-key", response: {} };
    const { FakePublicKeyCredential } = installPasskeys(created);
    await open(both);
    api
      .on("POST", "/passkeys/register/begin", { body: { options: { challenge: "xyz" } } })
      .on("POST", "/passkeys/register/finish", { body: {} });
    fireEvent.change(screen.getByLabelText("Passkey name"), { target: { value: "Tablet" } });
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    await waitFor(() => expect(api.callsTo("POST", "/passkeys/register/finish")).toHaveLength(1));
    const [begun] = api.callsTo("POST", "/passkeys/register/begin");
    expect([begun?.body, begun?.headers["x-csrf-token"]]).toEqual([{ name: "Tablet" }, csrf]);
    expect(FakePublicKeyCredential.parseCreationOptionsFromJSON).toHaveBeenCalledWith({
      challenge: "xyz",
    });
    expect(api.callsTo("POST", "/passkeys/register/finish")[0]?.body).toEqual({
      credential: created,
    });
  });

  it("reads the list again when a change finds the sign-in too old", async () => {
    installPasskeys({});
    await open(both);
    api.on(
      "POST",
      "/passkeys/register/begin",
      failure("not_allowed", "this needs a recent sign-in"),
    );
    serve({ ...both, recent: false });
    fireEvent.change(screen.getByLabelText("Passkey name"), { target: { value: "Tablet" } });
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add a passkey" })).toHaveProperty(
        "disabled",
        true,
      ),
    );
    expect(api.callsTo("GET", "/passkeys")).toHaveLength(2);
  });

  it("shows why adding or renaming failed", async () => {
    const { credentials } = installPasskeys({});
    credentials.create.mockRejectedValueOnce(new DOMException("cancelled", "NotAllowedError"));
    await open(both);
    api
      .on("POST", "/passkeys/register/begin", { body: { options: { challenge: "xyz" } } })
      .on(
        "POST",
        "/passkeys/2/name",
        failure("invalid_input", "must be one line", { field: "name" }),
      );
    fireEvent.change(screen.getByLabelText("Passkey name"), { target: { value: "Tablet" } });
    fireEvent.click(screen.getByRole("button", { name: "Add a passkey" }));
    const adding = screen.getByRole("region", { name: "Add a passkey on this device" });
    await within(adding).findByRole("alert");
    expect(api.callsTo("POST", "/passkeys/register/finish")).toEqual([]);

    fireEvent.click(within(article("Phone")).getByRole("button", { name: "Rename" }));
    fireEvent.click(within(article("Phone")).getByRole("button", { name: "Save" }));
    await within(article("Phone")).findByRole("alert");
    expect(within(article("Phone")).getByLabelText("New name")).toBeTruthy();
  });

  it("refuses a blank name without asking the server", async () => {
    await open(both);
    fireEvent.click(within(article("Phone")).getByRole("button", { name: "Rename" }));
    const field = within(article("Phone")).getByLabelText("New name");
    fireEvent.change(field, { target: { value: " " } });
    fireEvent.click(within(article("Phone")).getByRole("button", { name: "Save" }));
    expect(field.getAttribute("aria-invalid")).toBe("true");
    const described = (field.getAttribute("aria-describedby") ?? "")
      .split(" ")
      .map((id) => document.getElementById(id));
    expect(described.some((element) => element?.classList.contains("field-error"))).toBe(true);
    expect(api.callsTo("POST", "/passkeys/2/name")).toEqual([]);
  });

  it("says a browser without passkey support cannot add one or sign in again", async () => {
    await open({ ...both, recent: false });
    expect(screen.queryByRole("button", { name: "Add a passkey" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull();
  });

  it("tells how to add another device beside Add, whether or not this browser can", async () => {
    const addSection = () => screen.getByRole("region", { name: "Add a passkey on this device" });
    await open(both);
    expect(addSection().querySelector("p.hint")).not.toBeNull();
    cleanup();
    installPasskeys({});
    await open(both);
    within(addSection()).getByRole("button", { name: "Add a passkey" });
    expect(addSection().querySelector("p.hint")).not.toBeNull();
  });

  it("removes a passkey once confirmed, signing out when it signed this browser in", async () => {
    await open(both);
    api.on("POST", "/passkeys/1/remove", { body: { signed_out: true } });
    api.on("GET", "/session", { body: { signed_in: false, operator_exists: true } });
    fireEvent.click(within(article("Laptop")).getByRole("button", { name: "Remove" }));
    fireEvent.click(within(article("Laptop")).getByRole("button", { name: "Remove this passkey" }));
    await screen.findByRole("heading", { level: 1, name: "Sign in" });
    expect(api.callsTo("POST", "/passkeys/1/remove")[0]?.headers["x-csrf-token"]).toBe(csrf);
  });

  it("keeps the last passkey, saying why", async () => {
    await open({ passkeys: [passkey(1, "Laptop", true)], recent: true });
    const remove = within(article("Laptop")).getByRole("button", { name: "Remove" });
    expect(remove).toHaveProperty("disabled", true);
    expect(describer(remove)).not.toBeNull();
  });

  it("offers a sign-in again when the sign-in is not recent, then allows changes", async () => {
    installPasskeys({ id: "laptop", rawId: "laptop", type: "public-key", response: {} });
    await open({ ...both, recent: false });
    const controls = () => [
      screen.getByRole("button", { name: "Add a passkey" }),
      within(article("Phone")).getByRole("button", { name: "Remove" }),
    ];
    for (const control of controls()) {
      expect(control).toHaveProperty("disabled", true);
      expect(describer(control)).not.toBeNull();
    }
    api
      .on("POST", "/auth/signin/begin", { body: { options: { challenge: "xyz" } } })
      .on("POST", "/auth/signin/finish", { body: signedIn });
    serve(both);
    fireEvent.click(screen.getByRole("button", { name: "Sign in again" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Sign in again" })).toBeNull());
    for (const control of controls()) {
      expect(control).toHaveProperty("disabled", false);
    }
  });
});
