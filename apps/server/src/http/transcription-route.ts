import {
  minRecordingBytes,
  type RecordingType,
  recordingTypes,
  type TranscriptionResult,
} from "@wayfarerlabs/agention-api";
import type { Context } from "hono";
import { ApiError, invalidInput } from "../errors.ts";
import { type Store, transcriptionConfig, type VoiceEnvironment } from "../store/index.ts";
import { ProviderFailure, type TranscriptionProvider } from "../transcription/provider.ts";

// POST /transcriptions on the web mount: one recording in, its text out. The
// body is the recording itself, within the API's body cap like every other,
// and the server passes it to the provider in effect and keeps none of it.

// recordingTypeOf reads the recording's declared type, whose essence must be
// one the API takes; a codecs parameter may follow.
function recordingTypeOf(header: string | undefined): RecordingType | undefined {
  const essence = /^([^;\s]+)\s*(?:;.*)?$/s.exec(header ?? "")?.[1]?.toLowerCase();
  return recordingTypes.find((type) => type === essence);
}

export async function transcribe(
  c: Context,
  store: Store,
  environment: VoiceEnvironment,
  provider: TranscriptionProvider,
  log: (message: string) => void,
): Promise<Response> {
  const config = transcriptionConfig(store, environment);
  if (config === undefined) {
    throw new ApiError("not_found", "voice is not set up");
  }
  const type = recordingTypeOf(c.req.header("content-type"));
  if (type === undefined) {
    throw invalidInput(undefined, `send the recording as ${recordingTypes.join(", ")}`);
  }
  // A body that stops arriving is a browser that cancelled or lost its
  // connection: the transcription was cancelled, which is no server fault.
  let audio: Uint8Array<ArrayBuffer>;
  try {
    audio = new Uint8Array(await c.req.arrayBuffer());
  } catch {
    log("transcription failed: cancelled");
    throw invalidInput(undefined, "the recording did not arrive whole");
  }
  if (audio.byteLength < minRecordingBytes) {
    throw invalidInput(undefined, `the recording is under ${minRecordingBytes} bytes`);
  }
  let text: string;
  try {
    text = await provider.transcribe(config, { audio, type }, c.req.raw.signal);
  } catch (error) {
    if (error instanceof ProviderFailure) {
      // Only the kind and the status: never the request, the key or the audio.
      log(
        `transcription failed: ${error.kind}` +
          (error.status === undefined ? "" : ` (status ${error.status})`),
      );
      throw new ApiError("provider_failed", error.message);
    }
    throw error;
  }
  const result: TranscriptionResult = { text };
  return c.json(result);
}
