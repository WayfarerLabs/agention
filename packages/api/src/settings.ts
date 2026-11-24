import { z } from "zod";
import { fileTotals } from "./files.ts";
import { multilineText } from "./text.ts";

// The operator's settings on the web mount: voice, whose transcription
// provider the server calls with the recordings the web UI sends it. A
// provider is a service speaking the OpenAI-compatible transcription API: a
// base URL, a model, and a key when it needs one. The key is written, and
// read back only as its last four characters.

export const maxBaseUrlLength = 2048;

// The outcome of reading a base URL: the URL in its one stored form, or why
// it is refused. The reason never quotes the value, so a refusal of one the
// server's environment supplied can be printed.
export type BaseUrlCheck = { url: string } | { problem: string };

const whitespaceOrControl = /[\s\u0000-\u001f\u007f-\u009f]/;

// normalizeBaseUrl reads a base URL into its one stored form: an absolute
// http: or https: URL with no user, password, query or fragment, as the
// WHATWG URL parser writes it, without trailing slashes; its path stays,
// such as /v1. Every comparison of base URLs, with a stored one or a
// preset's, is between these forms. Which hosts a base URL may reach is the
// server's half of the rule, which it checks on the host this form holds.
export function normalizeBaseUrl(value: string): BaseUrlCheck {
  if (!value.isWellFormed() || whitespaceOrControl.test(value)) {
    return { problem: "must be written without spaces or control characters" };
  }
  if (value.length > maxBaseUrlLength) {
    return { problem: `must be at most ${maxBaseUrlLength} characters` };
  }
  // new URL rather than URL.parse, which some browsers the web UI supports
  // lack.
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { problem: "must be an absolute http: or https: URL" };
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.hostname === "") {
    return { problem: "must be an absolute http: or https: URL" };
  }
  if (url.username !== "" || url.password !== "") {
    return { problem: "must not carry a user name or password" };
  }
  // An empty query or fragment shows only in the serialized form.
  if (url.href.includes("?") || url.href.includes("#")) {
    return { problem: "must not carry a query or a fragment" };
  }
  return { url: url.href.replace(/\/+$/, "") };
}

// A base URL, which the schema reads into its stored form.
export const transcriptionBaseUrl = z.string().transform((value, context) => {
  const checked = normalizeBaseUrl(value);
  if ("problem" in checked) {
    context.issues.push({ code: "custom", message: checked.problem, input: value });
    return z.NEVER;
  }
  return checked.url;
});

// A model's name, as the provider spells it.
export const transcriptionModel = z
  .string()
  .regex(/^[\x20-\x7e]{1,200}$/, "must be 1 to 200 printable ASCII characters")
  .refine((value) => /\S/.test(value), "must contain a character other than white space");

// Additional context for the transcription: what the operator talks about,
// names and terms. It is the prompt the provider is sent.
export const transcriptionPrompt = multilineText({ min: 1, max: 500 });

// A provider's key, as the provider issued it.
export const transcriptionKey = z
  .string()
  .regex(/^[\x21-\x7e]{1,1024}$/, "must be 1 to 1,024 printable ASCII characters without spaces");

// The fields of the voice settings that the server's environment may supply.
export const voiceField = z.enum(["base_url", "model", "api_key"]);
export type VoiceField = z.infer<typeof voiceField>;

// Saving the voice settings: the base URL, the model and the prompt, which
// replace those saved, and a key when one is given. It leaves out the fields
// the server's environment supplies.
export const voiceSettingsInput = z.object({
  base_url: transcriptionBaseUrl.optional(),
  model: transcriptionModel.optional(),
  prompt: transcriptionPrompt.optional(),
  api_key: transcriptionKey.optional(),
});
export type VoiceSettingsInput = z.infer<typeof voiceSettingsInput>;

// What Settings saved of a key: none; one for the base URL in effect; or one
// left unused, because it was entered for another base URL than the one in
// effect. Whether the environment supplies a key, which then wins, is
// from_environment's to say.
export const keyState = z.enum(["none", "set", "unused"]);
export type KeyState = z.infer<typeof keyState>;

// The last four characters of a key, all a browser is shown of it, so the
// operator can tell which key is in effect. A key shorter than 16 characters
// shows none, so the four are never more than a quarter of it.
export const keyEnding = z.string().regex(/^[\x21-\x7e]{4}$/);

// The voice settings as the web UI shows them, never with more of a key than
// its ending. on says a base URL and a model are in effect; base_url and
// model are those in effect, from the environment or saved; key_ending ends
// the key in effect, the environment's or the one saved for the base URL in
// effect, and is null while there is none or it is too short to show any of;
// from_environment lists the fields the server's environment supplies.
// invalid says the saved settings break the rules a save is held to, as a
// later release's stricter rule can make them, so none of them is used until
// they are cleared or saved anew.
export const voiceSettings = z.object({
  on: z.boolean(),
  base_url: z.string().nullable(),
  model: z.string().nullable(),
  prompt: z.string().nullable(),
  key: keyState,
  key_ending: keyEnding.nullable(),
  from_environment: z.array(voiceField),
  invalid: z.boolean(),
});
export type VoiceSettings = z.infer<typeof voiceSettings>;

// The operator's settings: voice, null while neither Settings nor the
// environment gives any of it, and what the server's files take: every file
// the database holds, pending uploads included, since that is the disk they
// take. Whether the sign-in is recent enough to change them is the passkey
// list's to say, for both.
export const settingsResult = z.object({
  voice: voiceSettings.nullable(),
  storage: fileTotals,
});
export type SettingsResult = z.infer<typeof settingsResult>;

// The types a recording is sent as, by their essence; a codecs parameter may
// follow.
export const recordingTypes = ["audio/webm", "audio/mp4", "audio/ogg"] as const;
export type RecordingType = (typeof recordingTypes)[number];

// A recording smaller than this holds no speech worth sending.
export const minRecordingBytes = 1000;

// What a recording said, which may be nothing.
export const transcriptionResult = z.object({ text: z.string() });
export type TranscriptionResult = z.infer<typeof transcriptionResult>;

// The hosted providers Settings offer, OpenAI first. Each needs a key. A saved
// base URL is a preset's only when it is exactly the preset's, so what
// Settings say about where audio goes matches where it goes. data_use links to
// what the provider says about keeping audio and training on it.
export const transcriptionPresets = [
  {
    name: "OpenAI",
    base_url: "https://api.openai.com/v1",
    model: "gpt-transcribe",
    data_use: "https://developers.openai.com/api/docs/guides/your-data",
  },
  {
    name: "Groq",
    base_url: "https://api.groq.com/openai/v1",
    model: "whisper-large-v3-turbo",
    data_use: "https://console.groq.com/docs/your-data",
  },
] as const;
export type TranscriptionPreset = (typeof transcriptionPresets)[number];

// presetOf finds the preset whose base URL a stored base URL is.
export function presetOf(baseUrl: string): TranscriptionPreset | undefined {
  return transcriptionPresets.find((preset) => preset.base_url === baseUrl);
}
