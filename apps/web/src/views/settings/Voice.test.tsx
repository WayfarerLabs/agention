import type { SettingsResult, VoiceSettings } from "@wayfarerlabs/agention-api";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  csrf,
  FakeApi,
  failure,
  installPasskeys,
  installRecorder,
  renderAt,
  signedIn,
} from "../../test-support.tsx";

let api: FakeApi;

beforeEach(() => {
  api = new FakeApi();
  passkeysRecent(true);
});

afterEach(() => {
  cleanup();
  expect(api.unhandled).toEqual([]);
  Reflect.deleteProperty(navigator, "credentials");
  Reflect.deleteProperty(navigator, "mediaDevices");
});

const openAi = "https://api.openai.com/v1";

// The passkey list says whether the sign-in is recent, for every section.
function passkeysRecent(recent: boolean) {
  api.on("GET", "/passkeys", { body: { passkeys: [], recent } });
}

function voice(overrides: Partial<VoiceSettings> = {}): VoiceSettings {
  return {
    on: true,
    base_url: openAi,
    model: "gpt-transcribe",
    prompt: null,
    key: "set",
    from_environment: [],
    invalid: false,
    ...overrides,
  };
}

const section = () => screen.getByRole("region", { name: "Voice" });
const field = (name: string) => within(section()).getByLabelText<HTMLInputElement>(name);
const button = (name: string) => within(section()).getByRole<HTMLButtonElement>("button", { name });
const describer = (element: HTMLElement) =>
  document.getElementById(element.getAttribute("aria-describedby") ?? "");

async function open(settings: SettingsResult) {
  api.on("GET", "/settings", { body: settings });
  renderAt("/settings");
  await within(await screen.findByRole("region", { name: "Voice" })).findByRole("button", {
    name: /^(Set up|Save)$/,
  });
  await screen.findByRole("region", { name: "Passkeys" });
}

// later answers as a server does, a little after the request, so focus that
// waits for the answer is tested as a browser meets it.
function later(body: SettingsResult) {
  return () =>
    new Promise<{ body: SettingsResult }>((resolve) => {
      setTimeout(() => resolve({ body }), 50);
    });
}

// answerSaves answers a save with the settings given, and lists what each
// save carried.
function answerSaves(settings: SettingsResult) {
  api.on("POST", "/settings/voice", { body: settings });
  return () => api.callsTo("POST", "/settings/voice").map((call) => call.body);
}

describe("the Settings view", () => {
  it("is in the navigation, with passkeys, voice and signing out in that order", async () => {
    await open({ voice: null });
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(["Passkeys", "Voice", "Sign out"]);
    expect(
      within(screen.getByRole("banner")).queryByRole("button", { name: "Sign out" }),
    ).toBeNull();
  });

  it("offers to sign in again up front, holding back voice changes until then", async () => {
    installPasskeys({ id: "laptop", rawId: "laptop", type: "public-key", response: {} });
    passkeysRecent(false);
    await open({ voice: voice() });
    const again = await screen.findByRole("button", { name: "Sign in again" });
    for (const control of [button("Save"), button("Turn off")]) {
      expect(control.disabled).toBe(true);
      expect(describer(control)).not.toBeNull();
    }
    expect(
      again.compareDocumentPosition(screen.getByRole("region", { name: "Passkeys" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    api
      .on("POST", "/auth/signin/begin", { body: { options: { challenge: "xyz" } } })
      .on("POST", "/auth/signin/finish", { body: signedIn });
    passkeysRecent(true);
    fireEvent.click(again);
    await waitFor(() => expect(button("Save").disabled).toBe(false));
    // Focus goes to the first section, not to nothing, as the offer goes.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Passkeys" })),
    );
  });
});

describe("voice in Settings", () => {
  it("is off until set up, then offers OpenAI first, which needs a key", async () => {
    await open({ voice: null });
    fireEvent.click(button("Set up"));
    const provider = within(section()).getByLabelText<HTMLSelectElement>("Provider");
    await waitFor(() => expect(document.activeElement).toBe(provider));
    expect(Array.from(provider.options).map((option) => option.textContent)).toEqual([
      "OpenAI",
      "Groq",
      "Your own server",
    ]);
    expect([field("Base URL").value, field("Model").value]).toEqual([openAi, "gpt-transcribe"]);
    expect(within(section()).getByRole("link").getAttribute("href")).toMatch(/^https:\/\//);

    const saves = answerSaves({ voice: voice() });
    fireEvent.click(button("Save"));
    expect(field("Key").getAttribute("aria-invalid")).toBe("true");
    expect(saves()).toEqual([]);

    fireEvent.change(field("Key"), { target: { value: "sk-new" } });
    fireEvent.change(field("Words to recognize"), { target: { value: "Agention" } });
    api.on("GET", "/settings", later({ voice: voice({ prompt: "Agention" }) }));
    fireEvent.click(button("Save"));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()).toEqual([
      { base_url: openAi, model: "gpt-transcribe", prompt: "Agention", api_key: "sk-new" },
    ]);
    expect(api.callsTo("POST", "/settings/voice")[0]?.headers["x-csrf-token"]).toBe(csrf);
    // The form shows the saved settings afresh, with focus on Save.
    await within(section()).findByRole("status");
    await waitFor(() => expect(field("Words to recognize").value).toBe("Agention"));
    await waitFor(() => expect(document.activeElement).toBe(button("Save")));

    // A later save does the same, once the form shows what it saved.
    answerSaves({ voice: voice({ prompt: "Agention, Wayfarer" }) });
    api.on("GET", "/settings", later({ voice: voice({ prompt: "Agention, Wayfarer" }) }));
    fireEvent.change(field("Words to recognize"), { target: { value: "Agention, Wayfarer" } });
    const before = button("Save");
    fireEvent.click(before);
    await waitFor(() => expect(button("Save")).not.toBe(before));
    await waitFor(() => expect(document.activeElement).toBe(button("Save")));
  });

  it("leaves focus where the operator moved it while a save was answered", async () => {
    await open({ voice: voice() });
    answerSaves({ voice: voice() });
    api.on("GET", "/settings", later({ voice: voice() }));
    const reads = api.callsTo("GET", "/settings").length;
    button("Save").focus();
    fireEvent.click(button("Save"));
    field("Model").focus();
    await within(section()).findByRole("status");
    await waitFor(() => expect(api.callsTo("GET", "/settings").length).toBeGreaterThan(reads));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(document.activeElement).toBe(field("Model"));
  });

  it("goes back to off from a setup not saved, with focus on Set up", async () => {
    await open({ voice: null });
    fireEvent.click(button("Set up"));
    fireEvent.click(button("Cancel"));
    await waitFor(() => expect(document.activeElement).toBe(button("Set up")));
    expect(within(section()).queryByLabelText("Base URL")).toBeNull();
  });

  it("fills the form from the preset chosen, and from the operator's own server", async () => {
    await open({ voice: null });
    fireEvent.click(button("Set up"));
    const provider = within(section()).getByLabelText<HTMLSelectElement>("Provider");
    fireEvent.change(provider, { target: { value: "Groq" } });
    expect(field("Base URL").value).toBe("https://api.groq.com/openai/v1");
    fireEvent.change(provider, { target: { value: "own" } });
    expect([field("Base URL").value, field("Model").value]).toEqual(["", ""]);
    fireEvent.change(field("Base URL"), { target: { value: "http://192.168.1.20:8000/v1" } });
    // Where recordings go, and a warning for plain http.
    expect(within(section()).getAllByText(/192\.168\.1\.20:8000/).length).toBeGreaterThan(0);
    expect(section().querySelector(".notice.warning")).not.toBeNull();
    fireEvent.change(field("Base URL"), { target: { value: "https://transcribe.example/v1" } });
    expect(section().querySelector(".notice.warning")).toBeNull();
  });

  it("refuses a malformed base URL itself, and shows the server's refusal of a host", async () => {
    await open({ voice: null });
    fireEvent.click(button("Set up"));
    fireEvent.change(within(section()).getByLabelText("Provider"), { target: { value: "own" } });
    fireEvent.change(field("Base URL"), { target: { value: "http://transcribe.example/v1?x=1" } });
    fireEvent.change(field("Model"), { target: { value: "whisper" } });
    fireEvent.click(button("Save"));
    expect(field("Base URL").getAttribute("aria-invalid")).toBe("true");
    expect(api.callsTo("POST", "/settings/voice")).toEqual([]);

    // Which hosts a base URL may reach is the server's to judge.
    fireEvent.change(field("Base URL"), { target: { value: "http://transcribe.example/v1" } });
    api.on("POST", "/settings/voice", failure("invalid_input", "x", { field: "base_url" }));
    fireEvent.click(button("Save"));
    await waitFor(() => expect(api.callsTo("POST", "/settings/voice")).toHaveLength(1));
    await waitFor(() => expect(field("Base URL").getAttribute("aria-invalid")).toBe("true"));
  });

  it("shows a refusal at the field it names", async () => {
    await open({ voice: voice() });
    api.on("POST", "/settings/voice", failure("invalid_input", "x", { field: "model" }));
    fireEvent.click(button("Save"));
    await waitFor(() => expect(field("Model").getAttribute("aria-invalid")).toBe("true"));
  });

  it("shows a saved key masked, with Replace, and sends a key only when one is entered", async () => {
    await open({ voice: voice({ prompt: "Names" }) });
    expect(within(section()).queryByLabelText("Key")).toBeNull();
    expect(section().querySelector(".masked-key")).not.toBeNull();
    const saves = answerSaves({ voice: voice() });
    fireEvent.click(button("Save"));
    await waitFor(() => expect(saves()).toHaveLength(1));
    expect(saves()[0]).toEqual({ base_url: openAi, model: "gpt-transcribe", prompt: "Names" });

    fireEvent.click(button("Replace"));
    await waitFor(() => expect(document.activeElement).toBe(field("Key")));
    expect(field("Key").value).toBe("");
    expect(field("Key").type).toBe("password");
  });

  it("asks for the key again when the base URL moves from the one it was saved for", async () => {
    await open({ voice: voice({ base_url: "https://api.groq.com/openai/v1", model: "whisper" }) });
    expect(within(section()).queryByLabelText("Key")).toBeNull();
    fireEvent.change(within(section()).getByLabelText("Provider"), {
      target: { value: "OpenAI" },
    });
    // The saved key would be left behind, so the field shows in place of the
    // mask, and Save says why it waits.
    expect(section().querySelector(".masked-key")).toBeNull();
    fireEvent.click(button("Save"));
    expect(field("Key").getAttribute("aria-invalid")).toBe("true");
    expect(api.callsTo("POST", "/settings/voice")).toEqual([]);
    // Back at the saved address, the key shows masked again.
    fireEvent.change(within(section()).getByLabelText("Provider"), {
      target: { value: "Groq" },
    });
    expect(section().querySelector(".masked-key")).not.toBeNull();
  });

  it("shows a saved key for another address as the field, empty", async () => {
    await open({
      voice: voice({ base_url: "http://10.0.0.5:8000/v1", key: "unused" }),
    });
    expect(field("Key").value).toBe("");
    expect(section().querySelector(".masked-key")).toBeNull();
  });

  it("shows what the environment supplies read-only, and leaves it out of a save", async () => {
    await open({
      voice: voice({ key: "none", from_environment: ["base_url", "api_key"] }),
    });
    expect(within(section()).queryByLabelText("Base URL")).toBeNull();
    expect(within(section()).queryByLabelText("Provider")).toBeNull();
    expect(within(section()).queryByLabelText("Key")).toBeNull();
    expect(within(section()).getByText(openAi).tagName).toBe("CODE");
    expect(section().querySelector(".masked-key")).not.toBeNull();
    expect(within(section()).queryByRole("button", { name: "Replace" })).toBeNull();
    const saves = answerSaves({ voice: voice() });
    fireEvent.click(button("Save"));
    await waitFor(() => expect(saves()).toEqual([{ model: "gpt-transcribe" }]));
  });

  it("turns voice off once confirmed, with focus on Set up", async () => {
    await open({ voice: voice() });
    api.on("POST", "/settings/voice/clear", { body: { voice: null } });
    fireEvent.click(button("Turn off"));
    api.on("GET", "/settings", later({ voice: null }));
    fireEvent.click(button("Turn voice off"));
    await within(section()).findByRole("button", { name: "Set up" });
    await waitFor(() => expect(document.activeElement).toBe(button("Set up")));
    expect(api.callsTo("POST", "/settings/voice/clear")[0]?.headers["x-csrf-token"]).toBe(csrf);
  });

  it("clears the saved settings, leaving voice on, under an environment base URL and model", async () => {
    await open({ voice: voice({ from_environment: ["base_url", "model"], prompt: "Names" }) });
    expect(within(section()).queryByRole("button", { name: "Turn off" })).toBeNull();
    button("Clear saved settings");
  });

  it("turns voice off under an environment base URL alone, since the model is saved here", async () => {
    await open({ voice: voice({ from_environment: ["base_url"] }) });
    expect(within(section()).queryByRole("button", { name: "Clear saved settings" })).toBeNull();
    const cleared = voice({ on: false, model: null, key: "none", from_environment: ["base_url"] });
    api.on("POST", "/settings/voice/clear", { body: { voice: cleared } });
    fireEvent.click(button("Turn off"));
    api.on("GET", "/settings", later({ voice: cleared }));
    fireEvent.click(button("Turn voice off"));
    await waitFor(() =>
      expect(within(section()).queryByRole("button", { name: "Turn off" })).toBeNull(),
    );
    await waitFor(() => expect(document.activeElement).toBe(button("Save")));
  });

  it("shows saved settings the rules refuse as invalid, and clears them", async () => {
    await open({
      voice: voice({ on: false, base_url: null, model: null, key: "none", invalid: true }),
    });
    expect(section().querySelector(".notice.warning")).not.toBeNull();
    api.on("POST", "/settings/voice/clear", { body: { voice: null } });
    fireEvent.click(button("Clear saved settings"));
    api.on("GET", "/settings", { body: { voice: null } });
    fireEvent.click(button("Clear them"));
    await within(section()).findByRole("button", { name: "Set up" });
  });

  it("offers Try it once voice is on, through dictation", async () => {
    installRecorder();
    await open({ voice: voice() });
    const tryIt = within(section()).getByRole("region", { name: "Try it" });
    within(tryIt).getByRole("button", { name: "Dictate" });
  });

  it("clears what Try it heard when it records again", async () => {
    installRecorder();
    await open({ voice: voice() });
    const tryIt = within(section()).getByRole("region", { name: "Try it" });
    const heard = () => tryIt.querySelector(".heard");
    api.on("POST", "/transcriptions", { body: { text: "SQLite" } });
    fireEvent.click(within(tryIt).getByRole("button", { name: "Dictate" }));
    fireEvent.click(await within(tryIt).findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(heard()).not.toBeNull());

    api.on("POST", "/transcriptions", failure("provider_failed", "x"));
    fireEvent.click(within(tryIt).getByRole("button", { name: "Dictate" }));
    await within(tryIt).findByRole("button", { name: "Stop" });
    expect(heard()).toBeNull();
    fireEvent.click(within(tryIt).getByRole("button", { name: "Stop" }));
    await within(tryIt).findByRole("button", { name: "Retry" });
    expect(heard()).toBeNull();
  });
});
