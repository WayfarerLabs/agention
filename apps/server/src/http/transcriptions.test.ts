import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAiCompatible } from "../transcription/provider.ts";
import { recording, StubProvider } from "../transcription/test-provider.ts";
import { listen } from "./listener.ts";
import { codeOf, Harness, host, origin, type Response, sessionCookie } from "./test-harness.ts";

const secretKey = "sk-test-0123456789-never-shown";

let stub: StubProvider;
let harness: Harness;

beforeEach(async () => {
  stub = await StubProvider.start();
  harness = new Harness({ transcription: openAiCompatible({ timeout: 2000 }) });
});

afterEach(async () => {
  expect(harness.logged.join("\n")).not.toContain(secretKey);
  harness.close();
  await stub.close();
});

async function setUp(fields: Record<string, string> = {}) {
  const response = await harness.web("POST", "/settings/voice", {
    base_url: stub.baseUrl,
    model: "whisper-1",
    ...fields,
  });
  expect(response.status).toBe(200);
}

function transcribe(
  type = "audio/webm;codecs=opus",
  body: Uint8Array = recording(),
): Promise<Response> {
  return harness.web("POST", "/transcriptions", body, { headers: { "content-type": type } });
}

describe("a transcription", () => {
  it("is not found while voice is off", async () => {
    const response = await transcribe();
    expect(codeOf(response)).toBe("not_found");
    expect(stub.requests).toEqual([]);
  });

  it("sends the recording to the provider and answers its text", async () => {
    await setUp({ prompt: "Agention", api_key: secretKey });
    const response = await transcribe();
    expect(response).toMatchObject({ status: 200, body: { text: "Hello from the stub." } });
    expect(stub.requests).toEqual([
      {
        method: "POST",
        path: "/v1/audio/transcriptions",
        authorization: `Bearer ${secretKey}`,
        fields: { model: "whisper-1", response_format: "json", prompt: "Agention" },
        file: { name: "audio.webm", type: "audio/webm", size: 4000 },
      },
    ]);
  });

  it.each([
    ["audio/webm", "audio.webm"],
    ["audio/mp4", "audio.m4a"],
    ["AUDIO/MP4; codecs=mp4a.40.2", "audio.m4a"],
    ["audio/ogg;codecs=opus", "audio.ogg"],
  ])("names a recording sent as %s %s", async (type, name) => {
    await setUp();
    expect(codeOf(await transcribe(type))).toBe("ok");
    expect(stub.requests[0]?.file?.name).toBe(name);
    expect(stub.requests[0]?.authorization).toBeUndefined();
  });

  it.each([
    ["another type", "audio/wav", recording()],
    ["no type", "", recording()],
    ["a recording under 1,000 bytes", "audio/webm", recording(999)],
  ])("refuses %s", async (_, type, body) => {
    await setUp();
    expect(codeOf(await transcribe(type, body))).toBe("invalid_input");
    expect(stub.requests).toEqual([]);
  });

  it("is held to the API's body cap", async () => {
    await setUp();
    const response = await transcribe("audio/webm", recording(2 * 1024 * 1024 + 1));
    expect([response.status, codeOf(response)]).toEqual([413, "invalid_input"]);
    expect(stub.requests).toEqual([]);
  });

  it("needs the CSRF token, as every change does", async () => {
    await setUp();
    const response = await harness.web("POST", "/transcriptions", recording(), {
      csrf: null,
      headers: { "content-type": "audio/webm" },
    });
    expect(codeOf(response)).toBe("unauthenticated");
  });

  it("answers an empty transcript as it is", async () => {
    await setUp();
    stub.answer = () => ({ status: 200, body: JSON.stringify({ text: "" }) });
    expect((await transcribe()).body).toEqual({ text: "" });
  });
});

describe("a provider's failure", () => {
  const providerBody = "PROVIDER-SAYS-SOMETHING-PRIVATE";

  // failed checks a failure's answer: status 502, provider_failed, nothing of
  // what the provider said, and one log line naming the kind.
  function failed(response: Response, logged: string) {
    expect([response.status, codeOf(response)]).toEqual([502, "provider_failed"]);
    expect(JSON.stringify(response.body)).not.toContain(providerBody);
    expect(harness.logged).toEqual([logged]);
  }

  it.each([
    [401, "key_refused"],
    [403, "key_refused"],
    [429, "rate_limited"],
    [400, "request_refused"],
    [404, "request_refused"],
    [500, "status"],
  ])("answers status %i as provider_failed, logging %s", async (status, kind) => {
    await setUp({ api_key: secretKey });
    stub.answer = () => ({ status, body: JSON.stringify({ error: providerBody }) });
    failed(await transcribe(), `transcription failed: ${kind} (status ${status})`);
  });

  it("answers a redirect as provider_failed, following none", async () => {
    await setUp();
    stub.answer = () => ({
      status: 302,
      body: providerBody,
      headers: { location: `${stub.baseUrl}/elsewhere` },
    });
    failed(await transcribe(), "transcription failed: redirected (status 302)");
    expect(stub.requests).toHaveLength(1);
  });

  it("answers what is not a transcript as provider_failed", async () => {
    await setUp();
    stub.answer = () => ({ status: 200, body: providerBody });
    failed(await transcribe(), "transcription failed: not_transcript");
  });

  it("answers a provider that cannot be reached as provider_failed", async () => {
    await setUp();
    // Closed, the stub's port refuses connections; closing it again after is
    // harmless.
    await stub.close();
    failed(await transcribe(), "transcription failed: unreachable");
  });
});

describe("a transcription the browser abandons", () => {
  // send starts an upload through a real listener with the declared length,
  // writing only part of the body unless whole is set.
  async function send(port: number, whole: boolean) {
    const body = recording();
    const client = httpRequest({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/api/web/transcriptions",
      headers: {
        host,
        origin,
        cookie: `${sessionCookie}=${harness.cookie}`,
        "x-csrf-token": harness.csrf,
        "content-type": "audio/webm",
        "content-length": body.byteLength,
      },
    });
    client.on("error", () => undefined);
    if (whole) {
      client.end(body);
    } else {
      client.write(body.subarray(0, 100));
    }
    return client;
  }

  const until = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };

  it("aborts the call to the provider", async () => {
    await setUp();
    stub.answer = () => ({ hang: true });
    const listening = await listen(harness.app, { host: "127.0.0.1", port: 0 }, undefined);
    try {
      const client = await send(listening.address.port, true);
      await until(() => stub.requests.length > 0);
      expect(stub.requests).toHaveLength(1);
      client.destroy();
      await until(() => stub.abandoned[0] === true);
      expect(stub.abandoned).toEqual([true]);
      expect(harness.logged).toEqual(["transcription failed: cancelled"]);
    } finally {
      await listening.close();
    }
  });

  it("logs a cancelled upload as cancelled, not as an internal error", async () => {
    await setUp();
    const listening = await listen(harness.app, { host: "127.0.0.1", port: 0 }, undefined);
    try {
      const client = await send(listening.address.port, false);
      await new Promise((resolve) => setTimeout(resolve, 50));
      client.destroy();
      await until(() => harness.logged.length > 0);
      expect(harness.logged).toEqual(["transcription failed: cancelled"]);
      expect(stub.requests).toEqual([]);
    } finally {
      await listening.close();
    }
  });
});
