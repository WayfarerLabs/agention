import {
  type KeyState,
  presetOf,
  type SettingsResult,
  transcriptionKey,
  transcriptionModel,
  transcriptionPrompt,
  type VoiceField,
  type VoiceSettings,
  type VoiceSettingsInput,
} from "@wayfarerlabs/agention-api";
import { requireRecentSignIn, signedInSession } from "../auth/browser-sessions.ts";
import type { Database } from "../database/database.ts";
import { invalidInput } from "../errors.ts";
import type { Identity } from "../identity.ts";
import { checkBaseUrl } from "../transcription/base-url.ts";
import type { Store } from "./store.ts";

// Voice: the transcription provider the server calls with the operator's
// recordings. Settings save it in the voice_settings row, and the server's
// environment may supply its base URL, its model and its key, each exactly as
// entering it in Settings would. A value from the environment wins over the
// row's. The row always records the base URL in effect when it was saved, so
// a key saved in Settings goes only to the address it was entered for. A key
// is read only to call the provider: no answer carries more of one than its
// ending (keyEndingOf).

// What the server's environment supplies, read and checked once at start.
export interface VoiceEnvironment {
  base_url?: string;
  model?: string;
  api_key?: string;
}

interface VoiceRow {
  base_url: string;
  model: string;
  prompt: string | null;
  api_key: string | null;
}

// The provider configuration a transcription uses: voice is on.
export interface TranscriptionConfig {
  baseUrl: string;
  model: string;
  prompt: string | undefined;
  key: string | undefined;
}

// What the voice_settings row holds: nothing, a row the rules accept, or one
// they refuse. The row is persisted state, so what it holds is checked
// against the rules a save is held to, the base URL rule among them, on every
// read; a row a later release's stricter rule refuses is reported, not used,
// so it never reaches a provider and the operator can clear it.
type Saved = { row: VoiceRow | undefined; invalid: boolean };

function readRow(db: Database): Saved {
  const row = db
    .prepare("SELECT base_url, model, prompt, api_key FROM voice_settings WHERE id = 1")
    .get() as VoiceRow | undefined;
  if (row === undefined) {
    return { row: undefined, invalid: false };
  }
  const baseUrl = checkBaseUrl(row.base_url);
  const valid =
    "url" in baseUrl &&
    baseUrl.url === row.base_url &&
    transcriptionModel.safeParse(row.model).success &&
    (row.prompt === null || transcriptionPrompt.safeParse(row.prompt).success) &&
    (row.api_key === null || transcriptionKey.safeParse(row.api_key).success);
  return valid ? { row, invalid: false } : { row: undefined, invalid: true };
}

// What is in effect: the base URL and model, from the environment or the row;
// and the key, the environment's, or the row's only while the base URL in
// effect is the one it was entered for.
function inEffect(row: VoiceRow | undefined, environment: VoiceEnvironment) {
  const baseUrl = environment.base_url ?? row?.base_url;
  const model = environment.model ?? row?.model;
  const savedKey = row?.api_key ?? undefined;
  const savedKeyUsed = savedKey !== undefined && row?.base_url === baseUrl;
  const key = environment.api_key ?? (savedKeyUsed ? savedKey : undefined);
  const keyState: KeyState = savedKey === undefined ? "none" : savedKeyUsed ? "set" : "unused";
  return { baseUrl, model, key, keyState };
}

// keyEndingOf is the most of a key an answer carries: its last four
// characters, and none of a key shorter than 16, so they are never more than
// a quarter of it.
function keyEndingOf(key: string | undefined): string | null {
  return key !== undefined && key.length >= 16 ? key.slice(-4) : null;
}

function fieldsFrom(environment: VoiceEnvironment): VoiceField[] {
  return (["base_url", "model", "api_key"] as const).filter(
    (field) => environment[field] !== undefined,
  );
}

function voiceOf(saved: Saved, environment: VoiceEnvironment): VoiceSettings | null {
  const { row, invalid } = saved;
  const fromEnvironment = fieldsFrom(environment);
  if (row === undefined && !invalid && fromEnvironment.length === 0) {
    return null;
  }
  const { baseUrl, model, key, keyState } = inEffect(row, environment);
  return {
    on: baseUrl !== undefined && model !== undefined,
    base_url: baseUrl ?? null,
    model: model ?? null,
    prompt: row?.prompt ?? null,
    key: keyState,
    key_ending: keyEndingOf(key),
    from_environment: fromEnvironment,
    invalid,
  };
}

const settingsOf = (db: Database, environment: VoiceEnvironment): SettingsResult => ({
  voice: voiceOf(readRow(db), environment),
  // Placeholder until the file store counts the server's files.
  storage: { files: 0, bytes: 0 },
});

// readSettings reads the operator's settings, with no more of a key than its
// ending.
export function readSettings(store: Store, environment: VoiceEnvironment): SettingsResult {
  return store.db.transaction(() => settingsOf(store.db, environment));
}

// saveVoiceSettings saves the voice settings, which needs a recent sign-in,
// and returns the settings as they then stand. The input leaves out the
// fields the environment supplies, and its base URL is held to the base URL
// rule. The row takes the base URL and model then in effect, the
// environment's included, and its key is the one given; else the one saved,
// only if it was entered for the base URL written; else none. So a changed
// base URL clears the key, and the environment's key is never written. A
// preset's base URL needs a key in effect. A save replaces a row the rules
// refuse, keeping nothing of it.
export function saveVoiceSettings(
  store: Store,
  identity: Identity,
  environment: VoiceEnvironment,
  input: VoiceSettingsInput,
): SettingsResult {
  const { db } = store;
  return db.transaction(() => {
    requireRecentSignIn(signedInSession(db, identity, store.clock()));
    for (const field of fieldsFrom(environment)) {
      if (input[field] !== undefined) {
        throw invalidInput(field, "is set by the server's environment, so leave it out");
      }
    }
    if (input.base_url !== undefined) {
      const checked = checkBaseUrl(input.base_url);
      if ("problem" in checked) {
        throw invalidInput("base_url", checked.problem);
      }
    }
    const baseUrl = environment.base_url ?? input.base_url;
    const model = environment.model ?? input.model;
    if (baseUrl === undefined) {
      throw invalidInput("base_url", "is required");
    }
    if (model === undefined) {
      throw invalidInput("model", "is required");
    }
    const { row } = readRow(db);
    const key =
      input.api_key ??
      (row?.api_key !== null && row?.api_key !== undefined && row.base_url === baseUrl
        ? row.api_key
        : null);
    const preset = presetOf(baseUrl);
    if (preset !== undefined && key === null && environment.api_key === undefined) {
      throw invalidInput("api_key", `${preset.name} needs a key`);
    }
    db.prepare(
      `INSERT INTO voice_settings (id, base_url, model, prompt, api_key)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET base_url = excluded.base_url, model = excluded.model,
         prompt = excluded.prompt, api_key = excluded.api_key`,
    ).run(baseUrl, model, input.prompt ?? null, key);
    return settingsOf(db, environment);
  });
}

// clearVoiceSettings deletes the saved settings and any saved key, which
// needs a recent sign-in. Voice stays on only while the environment supplies
// a base URL and a model.
export function clearVoiceSettings(
  store: Store,
  identity: Identity,
  environment: VoiceEnvironment,
): SettingsResult {
  const { db } = store;
  return db.transaction(() => {
    requireRecentSignIn(signedInSession(db, identity, store.clock()));
    db.prepare("DELETE FROM voice_settings").run();
    return settingsOf(db, environment);
  });
}

// transcriptionConfig reads the configuration a transcription uses, or
// undefined while voice is off. Each read checks the saved row again.
export function transcriptionConfig(
  store: Store,
  environment: VoiceEnvironment,
): TranscriptionConfig | undefined {
  const { db } = store;
  return db.transaction(() => {
    const { row } = readRow(db);
    const { baseUrl, model, key } = inEffect(row, environment);
    if (baseUrl === undefined || model === undefined) {
      return undefined;
    }
    return { baseUrl, model, prompt: row?.prompt ?? undefined, key };
  });
}
