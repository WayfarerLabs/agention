import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TranscriptionConfig } from "../store/index.ts";
import { openAiCompatible, ProviderFailure } from "./provider.ts";
import { recording, StubProvider } from "./test-provider.ts";

let stub: StubProvider;

beforeEach(async () => {
  stub = await StubProvider.start();
});

afterEach(async () => {
  await stub.close();
});

const provider = openAiCompatible({ timeout: 1000 });

function config(overrides: Partial<TranscriptionConfig> = {}): TranscriptionConfig {
  return {
    baseUrl: stub.baseUrl,
    model: "whisper-1",
    prompt: undefined,
    key: "sk-test",
    ...overrides,
  };
}

// failure runs a transcription that must fail, and gives its kind and status.
async function failure(signal = new AbortController().signal, given = config()) {
  try {
    await provider.transcribe(given, { audio: recording(), type: "audio/ogg" }, signal);
  } catch (error) {
    if (error instanceof ProviderFailure) {
      return { kind: error.kind, status: error.status };
    }
    throw error;
  }
  throw new Error("the transcription did not fail");
}

describe("the OpenAI-compatible provider", () => {
  it("sends the recording, the model, the prompt and the key, and answers the text", async () => {
    stub.answer = () => ({ status: 200, body: JSON.stringify({ text: "Hello." }) });
    const text = await provider.transcribe(
      config({ prompt: "Names" }),
      { audio: recording(), type: "audio/ogg" },
      new AbortController().signal,
    );
    expect(text).toBe("Hello.");
    expect(stub.requests).toEqual([
      {
        method: "POST",
        path: "/v1/audio/transcriptions",
        authorization: "Bearer sk-test",
        fields: { model: "whisper-1", response_format: "json", prompt: "Names" },
        file: { name: "audio.ogg", type: "audio/ogg", size: 4000 },
      },
    ]);
  });

  // sent transcribes with a prompt, the stub answering answer, and gives the
  // prompt the provider received and the text that came back.
  async function sent(model: string, prompt: string, answer = "Hello.") {
    stub.answer = () => ({ status: 200, body: JSON.stringify({ text: answer }) });
    const text = await provider.transcribe(
      config({ model, prompt }),
      { audio: recording(), type: "audio/ogg" },
      new AbortController().signal,
    );
    return { prompt: stub.requests[0]?.fields.prompt, text };
  }

  it.each([
    ["the prompt", "Agention, Morgan"],
    ["the prompt in another case and punctuation", " agention morgan. "],
  ])("answers a transcript of %s as nothing heard", async (_, answer) => {
    expect((await sent("whisper-1", "Agention, Morgan", answer)).text).toBe("");
  });

  it.each([
    ["holds the prompt and more", "Agention, Morgan", "Agention, Morgan, please review."],
    ["breaks the prompt's words elsewhere", "now here", "Nowhere."],
  ])("keeps a transcript that %s", async (_, prompt, answer) => {
    expect((await sent("whisper-1", prompt, answer)).text).toBe(answer);
  });

  it.each([
    [401, "key_refused"],
    [403, "key_refused"],
    [429, "rate_limited"],
    [400, "request_refused"],
    [404, "request_refused"],
    [500, "status"],
    [503, "status"],
  ])("fails status %i as %s, carrying the status", async (status, kind) => {
    stub.answer = () => ({ status, body: "{}" });
    expect(await failure()).toEqual({ kind, status });
  });

  it.each([
    ["an answer that is not JSON", "not JSON"],
    ["JSON without a text", JSON.stringify({ words: "Hello." })],
    ["a text that is not a string", JSON.stringify({ text: 3 })],
    ["an answer past 1 MiB", JSON.stringify({ text: "a".repeat(1024 * 1024) })],
  ])("fails %s as not a transcript", async (_, body) => {
    stub.answer = () => ({ status: 200, body });
    expect(await failure()).toEqual({ kind: "not_transcript", status: undefined });
  });

  it("follows no redirect, and fails one as redirected", async () => {
    stub.answer = (request) =>
      request.path.startsWith("/v1/")
        ? { status: 307, body: "", headers: { location: `${stub.baseUrl}/elsewhere` } }
        : { status: 200, body: JSON.stringify({ text: "followed" }) };
    expect(await failure()).toEqual({ kind: "redirected", status: 307 });
    expect(stub.requests).toHaveLength(1);
  });

  it("fails a provider that cannot be reached as unreachable", async () => {
    const closed = config();
    await stub.close();
    expect(await failure(undefined, closed)).toEqual({ kind: "unreachable", status: undefined });
  });

  it("times out a provider that does not answer", async () => {
    stub.answer = () => ({ hang: true });
    expect(await failure()).toEqual({ kind: "timed_out", status: undefined });
    for (let i = 0; i < 200 && stub.abandoned[0] !== true; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(stub.abandoned).toEqual([true]);
  });

  it("aborts the call when its signal does", async () => {
    stub.answer = () => ({ hang: true });
    const abandon = new AbortController();
    const failed = failure(abandon.signal);
    for (let i = 0; i < 200 && stub.requests.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    abandon.abort();
    expect(await failed).toEqual({ kind: "cancelled", status: undefined });
  });
});
