import {
  transcriptionBaseUrl,
  transcriptionKey,
  transcriptionModel,
  type VoiceField,
} from "@wayfarerlabs/agention-server-api";
import type { VoiceEnvironment } from "../store/index.ts";
import { checkBaseUrl } from "./base-url.ts";

// The environment variables that may each supply one field of the voice
// settings, exactly as entering it in Settings would, under the same bounds
// and base URL rule. agention serve reads them once, at start.
export const voiceVariables: Record<VoiceField, string> = {
  base_url: "AGENTION_TRANSCRIPTION_URL",
  model: "AGENTION_TRANSCRIPTION_MODEL",
  api_key: "AGENTION_TRANSCRIPTION_KEY",
};

const schemas = {
  base_url: transcriptionBaseUrl,
  model: transcriptionModel,
  api_key: transcriptionKey,
};

// A variable the server cannot start with. Its message names the variable and
// never shows its value, which may be a key.
export class VoiceEnvironmentError extends Error {
  override name = "VoiceEnvironmentError";
}

// readVoiceEnvironment reads the voice variables that are set. A value
// breaking its bounds or the base URL rule is refused, an empty one included,
// and so is a key without a base URL, so a key from the environment only ever
// goes to an address from it.
export function readVoiceEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): VoiceEnvironment {
  const read: VoiceEnvironment = {};
  for (const field of ["base_url", "model", "api_key"] as const) {
    const variable = voiceVariables[field];
    const value = environment[variable];
    if (value === undefined) {
      continue;
    }
    const parsed = schemas[field].safeParse(value);
    if (!parsed.success) {
      throw new VoiceEnvironmentError(
        `${variable} ${parsed.error.issues[0]?.message ?? "is not valid"}`,
      );
    }
    const reach = field === "base_url" ? checkBaseUrl(parsed.data) : undefined;
    if (reach !== undefined && "problem" in reach) {
      throw new VoiceEnvironmentError(`${variable} ${reach.problem}`);
    }
    read[field] = parsed.data;
  }
  if (read.api_key !== undefined && read.base_url === undefined) {
    throw new VoiceEnvironmentError(
      `${voiceVariables.api_key} needs ${voiceVariables.base_url} too, so a key from the ` +
        "environment only goes to an address from it",
    );
  }
  return read;
}
