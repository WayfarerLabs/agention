import { type ErrorBody, type SettingsResult } from "@wayfarerlabs/agention-api";
import { afterEach, describe, expect, it } from "vitest";
import { recentSignIn } from "../auth/browser-sessions.ts";
import type { VoiceEnvironment } from "../store/index.ts";
import { codeOf, Harness, type Response } from "./test-harness.ts";

const openAi = "https://api.openai.com/v1";
const ownServer = "http://192.168.1.20:8000/v1";
const secretKey = "sk-Qv7Xm2Zp9Lw4Kt8R-c3dE";
const otherKey = "sk-Ny6Hb1Jg5Fd0Sa9P-x8yZ";
// What a server without files answers its storage as.
const noFiles = { count: 0, bytes: 0 };

let harness: Harness;
// Every answer the tests saw, to check that none carries more of a key than
// its last four characters.
let answers: Response[];

// start opens a harness whose server's environment is environment. The
// object stays the server's, so a test changes it to stand for a restart
// with another environment.
function start(environment: VoiceEnvironment = {}) {
  harness = new Harness({ voiceEnvironment: environment });
  answers = [];
}

// Every run of five characters in a key, none of which an answer may carry.
const fiveOf = (key: string) =>
  Array.from({ length: key.length - 4 }, (_, start) => key.slice(start, start + 5));

afterEach(() => {
  const answered = JSON.stringify(answers);
  for (const key of [secretKey, otherKey]) {
    for (const five of fiveOf(key)) {
      expect(answered).not.toContain(five);
    }
    expect(harness.logged.join("\n")).not.toContain(key);
  }
  harness.close();
});

async function settings(): Promise<SettingsResult> {
  const response = await harness.web("GET", "/settings");
  answers.push(response);
  expect(response.status).toBe(200);
  return response.body as SettingsResult;
}

async function save(body: unknown): Promise<Response> {
  const response = await harness.web("POST", "/settings/voice", body);
  answers.push(response);
  return response;
}

async function clear(): Promise<Response> {
  const response = await harness.web("POST", "/settings/voice/clear");
  answers.push(response);
  return response;
}

const fieldOf = (response: Response) => (response.body as ErrorBody).error.field;

// The saved row, key included, as the database holds it.
function row() {
  return harness.fixture.db
    .prepare("SELECT base_url, model, prompt, api_key FROM voice_settings")
    .get();
}

describe("the settings", () => {
  it("hold no voice until it is set up", async () => {
    start();
    expect(await settings()).toEqual({ voice: null, storage: noFiles });
  });

  it("save a provider, show it with only its key's ending, and clear it", async () => {
    start();
    const saved = await save({
      base_url: `${openAi}/`,
      model: "gpt-transcribe",
      prompt: "Agention, Morgan",
      api_key: secretKey,
    });
    const voice = {
      on: true,
      base_url: openAi,
      model: "gpt-transcribe",
      prompt: "Agention, Morgan",
      key: "set",
      key_ending: "c3dE",
      from_environment: [],
      invalid: false,
    };
    expect(saved.body).toEqual({ voice, storage: noFiles });
    expect(await settings()).toEqual({ voice, storage: noFiles });
    expect(row()).toEqual({
      base_url: openAi,
      model: "gpt-transcribe",
      prompt: "Agention, Morgan",
      api_key: secretKey,
    });

    const cleared = await clear();
    expect(cleared.body).toEqual({ voice: null, storage: noFiles });
    expect(row()).toBeUndefined();
  });

  it("need a recent sign-in for every voice change", async () => {
    start();
    expect(codeOf(await save({ base_url: ownServer, model: "whisper" }))).toBe("ok");
    harness.fixture.now += recentSignIn;
    expect(codeOf(await save({ base_url: ownServer, model: "other" }))).toBe("not_allowed");
    expect(codeOf(await clear())).toBe("not_allowed");
    expect((await settings()).voice?.model).toBe("whisper");
    harness.signIn();
    expect(codeOf(await clear())).toBe("ok");
  });

  it("keep the key while the base URL stays, and clear it when the base URL changes", async () => {
    start();
    await save({ base_url: ownServer, model: "whisper", api_key: secretKey });
    expect(codeOf(await save({ base_url: `${ownServer}/`, model: "whisper-2" }))).toBe("ok");
    expect((await settings()).voice?.key).toBe("set");
    expect(row()).toMatchObject({ api_key: secretKey });
    expect(codeOf(await save({ base_url: "http://192.168.1.21:8000/v1", model: "whisper" }))).toBe(
      "ok",
    );
    expect((await settings()).voice?.key).toBe("none");
    expect(row()).toMatchObject({ api_key: null });
  });

  it("show the ending only of a key of 16 characters or more", async () => {
    start();
    await save({ base_url: ownServer, model: "whisper", api_key: "k".repeat(11) + "abcd" });
    expect((await settings()).voice).toMatchObject({ key: "set", key_ending: null });
    await save({ base_url: ownServer, model: "whisper", api_key: "k".repeat(12) + "abcd" });
    expect((await settings()).voice).toMatchObject({ key: "set", key_ending: "abcd" });
  });

  it("show the environment's key's ending over a saved one's", async () => {
    const environment: VoiceEnvironment = { base_url: ownServer };
    start(environment);
    await save({ model: "whisper", api_key: secretKey });
    expect((await settings()).voice?.key_ending).toBe("c3dE");
    // A restart with a key from the environment, which wins.
    environment.api_key = otherKey;
    expect((await settings()).voice).toMatchObject({ key: "set", key_ending: "x8yZ" });
  });

  it("refuse a preset's base URL without a key, and keep the key it was given", async () => {
    start();
    const keyless = await save({ base_url: openAi, model: "gpt-transcribe" });
    expect([codeOf(keyless), fieldOf(keyless)]).toEqual(["invalid_input", "api_key"]);
    expect(row()).toBeUndefined();
    await save({ base_url: openAi, model: "gpt-transcribe", api_key: secretKey });
    expect(codeOf(await save({ base_url: openAi, model: "gpt-transcribe", prompt: "Hi" }))).toBe(
      "ok",
    );
    expect(row()).toMatchObject({ prompt: "Hi", api_key: secretKey });
  });

  it.each([
    [
      "a base URL over plain http to a name",
      { base_url: "http://transcribe.example/v1" },
      "base_url",
    ],
    ["a link-local base URL", { base_url: "https://169.254.169.254/v1" }, "base_url"],
    ["a metadata address", { base_url: "https://[fd00:ec2::254]/latest" }, "base_url"],
    ["no base URL", { base_url: undefined }, "base_url"],
    ["no model", { model: undefined }, "model"],
    ["a model past 200 characters", { model: "m".repeat(201) }, "model"],
    ["a prompt past 500 characters", { prompt: "p".repeat(501) }, "prompt"],
    ["a key holding a space", { api_key: "sk test" }, "api_key"],
  ])("refuse %s", async (_, change, field) => {
    start();
    const response = await save({ base_url: ownServer, model: "whisper", ...change });
    expect([codeOf(response), fieldOf(response)]).toEqual(["invalid_input", field]);
    expect(row()).toBeUndefined();
  });
});

describe("a saved row the rules refuse", () => {
  it("shows as invalid, is never used, and can be cleared or saved over", async () => {
    start();
    // As a later release's stricter rule would find a row an earlier one saved.
    harness.fixture.db
      .prepare(
        `INSERT INTO voice_settings (id, base_url, model, api_key)
         VALUES (1, 'http://169.254.169.254/latest', 'whisper', ?)`,
      )
      .run(secretKey);
    expect(await settings()).toEqual({
      voice: {
        on: false,
        base_url: null,
        model: null,
        prompt: null,
        key: "none",
        key_ending: null,
        from_environment: [],
        invalid: true,
      },
      storage: noFiles,
    });
    const transcribed = await harness.web("POST", "/transcriptions", new Uint8Array(4000), {
      headers: { "content-type": "audio/webm" },
    });
    expect(codeOf(transcribed)).toBe("not_found");
    expect(codeOf(await clear())).toBe("ok");
    expect(await settings()).toEqual({ voice: null, storage: noFiles });

    harness.fixture.db
      .prepare(
        `INSERT INTO voice_settings (id, base_url, model, api_key)
         VALUES (1, 'http://169.254.169.254/latest', 'whisper', ?)`,
      )
      .run(secretKey);
    expect(codeOf(await save({ base_url: ownServer, model: "whisper" }))).toBe("ok");
    expect(row()).toEqual({ base_url: ownServer, model: "whisper", prompt: null, api_key: null });
  });
});

describe("the settings under the server's environment", () => {
  it("show the environment's values in effect over the saved ones, and refuse saving those", async () => {
    start({ model: "env-model" });
    await save({ base_url: ownServer, api_key: secretKey });
    expect(await settings()).toEqual({
      voice: {
        on: true,
        base_url: ownServer,
        model: "env-model",
        prompt: null,
        key: "set",
        key_ending: "c3dE",
        from_environment: ["model"],
        invalid: false,
      },
      storage: noFiles,
    });
    // The row records the model in effect when it was saved.
    expect(row()).toEqual({
      base_url: ownServer,
      model: "env-model",
      prompt: null,
      api_key: secretKey,
    });
    const carried = await save({ base_url: ownServer, model: "mine" });
    expect([codeOf(carried), fieldOf(carried)]).toEqual(["invalid_input", "model"]);
  });

  it("use a saved key only at the base URL it was entered for", async () => {
    const environment: VoiceEnvironment = {};
    start(environment);
    await save({ base_url: ownServer, model: "whisper", api_key: secretKey });

    // A restart with another base URL from the environment.
    environment.base_url = "http://10.0.0.5:8000/v1";
    expect((await settings()).voice).toMatchObject({
      on: true,
      base_url: "http://10.0.0.5:8000/v1",
      key: "unused",
      key_ending: null,
      from_environment: ["base_url"],
    });

    // And one with the base URL the key was entered for.
    environment.base_url = ownServer;
    expect((await settings()).voice?.key).toBe("set");
  });

  it("drop a saved key that a save would bind to a changed base URL", async () => {
    const environment: VoiceEnvironment = {};
    start(environment);
    await save({ base_url: ownServer, model: "whisper", api_key: secretKey });
    environment.base_url = "http://10.0.0.5:8000/v1";
    expect(codeOf(await save({ model: "whisper", prompt: "Names" }))).toBe("ok");
    expect(row()).toEqual({
      base_url: "http://10.0.0.5:8000/v1",
      model: "whisper",
      prompt: "Names",
      api_key: null,
    });
    environment.base_url = ownServer;
    expect((await settings()).voice?.key).toBe("none");
  });

  it("never write the environment's key, and show its ending", async () => {
    start({ base_url: openAi, api_key: otherKey });
    expect(codeOf(await save({ model: "gpt-transcribe" }))).toBe("ok");
    expect((await settings()).voice).toMatchObject({
      key: "none",
      key_ending: "x8yZ",
      from_environment: ["base_url", "api_key"],
    });
    expect(row()).toMatchObject({ api_key: null });
    const carried = await save({ model: "gpt-transcribe", api_key: "sk-other" });
    expect([codeOf(carried), fieldOf(carried)]).toEqual(["invalid_input", "api_key"]);
  });

  it("take a preset's base URL from the environment and its key from Settings", async () => {
    start({ base_url: openAi });
    const keyless = await save({ model: "gpt-transcribe" });
    expect(fieldOf(keyless)).toBe("api_key");
    expect(codeOf(await save({ model: "gpt-transcribe", api_key: secretKey }))).toBe("ok");
    expect((await settings()).voice).toMatchObject({ on: true, key: "set" });
  });

  it("show an environment base URL alone, and keep voice on under one once cleared", async () => {
    start({ base_url: ownServer });
    expect(await settings()).toEqual({
      voice: {
        on: false,
        base_url: ownServer,
        model: null,
        prompt: null,
        key: "none",
        key_ending: null,
        from_environment: ["base_url"],
        invalid: false,
      },
      storage: noFiles,
    });

    harness.close();
    start({ base_url: ownServer, model: "whisper" });
    await save({ prompt: "Names", api_key: secretKey });
    const cleared = await clear();
    expect(cleared.body).toEqual({
      voice: {
        on: true,
        base_url: ownServer,
        model: "whisper",
        prompt: null,
        key: "none",
        key_ending: null,
        from_environment: ["base_url", "model"],
        invalid: false,
      },
      storage: noFiles,
    });
    expect(row()).toBeUndefined();
  });
});
