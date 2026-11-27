import { describe, expect, it } from "vitest";
import {
  normalizeBaseUrl,
  presetOf,
  transcriptionKey,
  transcriptionModel,
  transcriptionPrompt,
  voiceSettingsInput,
} from "./settings.ts";

describe("reading a base URL", () => {
  it.each([
    ["https://api.openai.com/v1", "https://api.openai.com/v1"],
    ["https://api.openai.com/v1/", "https://api.openai.com/v1"],
    ["HTTPS://API.OpenAI.com/v1//", "https://api.openai.com/v1"],
    ["https://api.openai.com", "https://api.openai.com"],
    ["https://transcribe.example:8443/openai/v1", "https://transcribe.example:8443/openai/v1"],
    ["https://transcribe.example:443/v1", "https://transcribe.example/v1"],
    ["http://0x7f.1/v1", "http://127.0.0.1/v1"],
    ["http://[::ffff:192.168.1.2]/v1", "http://[::ffff:c0a8:102]/v1"],
  ])("keeps %s as %s", (value, stored) => {
    expect(normalizeBaseUrl(value)).toEqual({ url: stored });
  });

  it.each([
    ["a relative URL", "/v1"],
    ["another scheme", "ftp://transcribe.example/v1"],
    ["a file URL", "file:///v1"],
    ["user information", "https://me:secret@transcribe.example/v1"],
    ["a user name", "https://me@transcribe.example/v1"],
    ["a query", "https://transcribe.example/v1?key=1"],
    ["an empty query", "https://transcribe.example/v1?"],
    ["a fragment", "https://transcribe.example/v1#x"],
    ["an empty fragment", "https://transcribe.example/v1#"],
    ["surrounding whitespace", " https://transcribe.example/v1"],
    ["a control character", "https://transcribe.example/v1\u0007"],
    ["a URL past 2,048 characters", `https://transcribe.example/${"a".repeat(2048)}`],
  ])("refuses %s", (_, value) => {
    expect(normalizeBaseUrl(value)).toHaveProperty("problem");
  });
});

describe("the voice settings' bounds", () => {
  it("reads a base URL into its stored form", () => {
    expect(voiceSettingsInput.parse({ base_url: "https://api.openai.com/v1/" })).toEqual({
      base_url: "https://api.openai.com/v1",
    });
  });

  it.each([
    ["a model", transcriptionModel, "gpt-transcribe", true],
    ["a model of 200 characters", transcriptionModel, "m".repeat(200), true],
    ["an empty model", transcriptionModel, "", false],
    ["a model of spaces", transcriptionModel, "  ", false],
    ["a model past 200 characters", transcriptionModel, "m".repeat(201), false],
    ["a model outside ASCII", transcriptionModel, "model-\u00e9", false],
    ["a prompt", transcriptionPrompt, "Agention, Morgan, release-please", true],
    ["a prompt of 500 characters", transcriptionPrompt, "\u{1F4AC}".repeat(500), true],
    ["a prompt past 500 characters", transcriptionPrompt, "p".repeat(501), false],
    ["a key", transcriptionKey, "sk-proj-abc_123", true],
    ["a key of 1,024 characters", transcriptionKey, "k".repeat(1024), true],
    ["an empty key", transcriptionKey, "", false],
    ["a key holding a space", transcriptionKey, "sk abc", false],
    ["a key past 1,024 characters", transcriptionKey, "k".repeat(1025), false],
    ["a key on two lines", transcriptionKey, "sk\nabc", false],
  ])("judges %s", (_, schema, value, accepted) => {
    expect(schema.safeParse(value).success).toBe(accepted);
  });

  it("names a preset only for its exact base URL", () => {
    expect(presetOf("https://api.openai.com/v1")?.name).toBe("OpenAI");
    expect(presetOf("https://api.groq.com/openai/v1")?.name).toBe("Groq");
    expect(presetOf("https://api.openai.com/v2")).toBeUndefined();
  });
});
