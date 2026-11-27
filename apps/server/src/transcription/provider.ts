import type { RecordingType } from "@wayfarerlabs/agention-server-api";
import type { TranscriptionConfig } from "../store/index.ts";

// The server's one way to a transcription provider: transcribe a recording
// with the configuration in effect. The OpenAI-compatible API is implemented
// here; a provider with an API of its own would be another implementation of
// TranscriptionProvider, with its preset. The server keeps nothing: the
// recording goes to the provider and only its text comes back.

export interface Recording {
  audio: Uint8Array<ArrayBuffer>;
  type: RecordingType;
}

export interface TranscriptionProvider {
  // transcribe resolves to what the recording said, which may be nothing, or
  // rejects with a ProviderFailure. Aborting signal, as a browser that leaves
  // does, aborts the call to the provider.
  transcribe(
    config: TranscriptionConfig,
    recording: Recording,
    signal: AbortSignal,
  ): Promise<string>;
}

// Why a transcription failed, said without anything the provider answered.
export type FailureKind =
  | "unreachable"
  | "redirected"
  | "timed_out"
  | "cancelled"
  | "key_refused"
  | "rate_limited"
  | "request_refused"
  | "status"
  | "not_transcript";

export class ProviderFailure extends Error {
  override name = "ProviderFailure";
  readonly kind: FailureKind;
  readonly status: number | undefined;

  constructor(kind: FailureKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

// How long a provider has to answer, the upload to it included.
export const providerTimeout = 60_000;

// The most of a provider's answer that is read: a transcript of five minutes
// is a few kilobytes.
export const maxAnswerBytes = 1024 * 1024;

// The name the recording is sent under, which providers read its format from.
const fileNames: Record<RecordingType, string> = {
  "audio/webm": "audio.webm",
  "audio/mp4": "audio.m4a",
  "audio/ogg": "audio.ogg",
};

function failureForStatus(status: number): ProviderFailure {
  if (status >= 300 && status < 400) {
    return new ProviderFailure(
      "redirected",
      "the transcription provider tried to redirect the request elsewhere, which is not followed; check the base URL",
      status,
    );
  }
  if (status === 401 || status === 403) {
    return new ProviderFailure("key_refused", "the transcription provider refused the key", status);
  }
  if (status === 429) {
    return new ProviderFailure(
      "rate_limited",
      "the transcription provider is limiting requests; try again later",
      status,
    );
  }
  if (status === 400 || status === 404) {
    return new ProviderFailure(
      "request_refused",
      `the transcription provider refused the request (status ${status}); check the model and the base URL`,
      status,
    );
  }
  return new ProviderFailure(
    "status",
    `the transcription provider answered with status ${status}`,
    status,
  );
}

// echoesPrompt says whether a transcript is only the prompt again, ignoring
// case, punctuation and how words are spaced, but not where words break, so
// "now here" never matches "nowhere". Whisper sometimes answers silence with
// its prompt, so such a transcript means nothing was heard.
function echoesPrompt(text: string, prompt: string): boolean {
  const words = (value: string) =>
    value.toLowerCase().replace(/\p{P}/gu, " ").replace(/\s+/g, " ").trim();
  return words(prompt) !== "" && words(text) === words(prompt);
}

const notTranscript = () =>
  new ProviderFailure("not_transcript", "the transcription provider's answer is not a transcript");

// readCapped reads a body up to max bytes, and refuses one longer.
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<string> {
  if (body === null) {
    return "";
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw notTranscript();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// openAiCompatible calls POST {base URL}/audio/transcriptions with the
// recording as multipart/form-data, and reads the JSON answer's text, or
// nothing for a transcript that only echoes the prompt. The base URL it is
// given has passed the base URL rule as this request read it, from the
// environment at start or the saved row now. It follows no redirect and never
// retries.
export function openAiCompatible(options: { timeout?: number } = {}): TranscriptionProvider {
  const timeout = options.timeout ?? providerTimeout;
  return {
    async transcribe(config, recording, signal) {
      const form = new FormData();
      form.append(
        "file",
        new Blob([recording.audio], { type: recording.type }),
        fileNames[recording.type],
      );
      form.append("model", config.model);
      form.append("response_format", "json");
      if (config.prompt !== undefined) {
        form.append("prompt", config.prompt);
      }
      const timer = AbortSignal.timeout(timeout);
      const both = AbortSignal.any([signal, timer]);
      // A failure of fetch itself is turned into a kind here, so no stack
      // naming the URL reaches the log.
      const interrupted = () =>
        signal.aborted
          ? new ProviderFailure("cancelled", "the transcription was cancelled")
          : timer.aborted
            ? new ProviderFailure(
                "timed_out",
                `the transcription provider did not answer within ${timeout / 1000} seconds`,
              )
            : new ProviderFailure("unreachable", "the transcription provider could not be reached");
      let response: Response;
      try {
        response = await fetch(`${config.baseUrl}/audio/transcriptions`, {
          method: "POST",
          body: form,
          headers: config.key === undefined ? {} : { authorization: `Bearer ${config.key}` },
          // A redirect is answered as it is, never followed, and fails below
          // as one, so the operator learns the base URL leads elsewhere.
          redirect: "manual",
          signal: both,
        });
      } catch {
        throw interrupted();
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw failureForStatus(response.status);
      }
      let text: string;
      try {
        text = await readCapped(response.body, maxAnswerBytes);
      } catch (error) {
        throw error instanceof ProviderFailure ? error : interrupted();
      }
      let answer: unknown;
      try {
        answer = JSON.parse(text);
      } catch {
        throw notTranscript();
      }
      if (
        typeof answer !== "object" ||
        answer === null ||
        !("text" in answer) ||
        typeof answer.text !== "string"
      ) {
        throw notTranscript();
      }
      return config.prompt !== undefined && echoesPrompt(answer.text, config.prompt)
        ? ""
        : answer.text;
    },
  };
}
