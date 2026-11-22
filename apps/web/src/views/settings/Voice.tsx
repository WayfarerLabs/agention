import {
  normalizeBaseUrl,
  presetOf,
  type SettingsResult,
  transcriptionKey,
  transcriptionModel,
  transcriptionPresets,
  transcriptionPrompt,
  type VoiceField,
  type VoiceSettings,
  type VoiceSettingsInput,
} from "@wayfarerlabs/agention-api";
import { type FormEvent, useCallback, useId, useLayoutEffect, useRef, useState } from "react";
import { ApiFailure, describeFailure, request } from "../../api.ts";
import { ConfirmButton, Failure, focusLeftWith, Loadable, Status } from "../../components.tsx";
import { useAction, useResource } from "../../data.ts";
import { needingRecent, RecentSignIn, useRecentSignIn } from "./RecentSignIn.tsx";
import type { SectionProps } from "./sections.ts";
import { Destination, Field, KeyField, TryIt } from "./VoiceParts.tsx";

// Settings' voice: the transcription provider dictation sends recordings
// to, through the server, which holds its key. The operator picks a preset
// or enters their own server's address, a model, words to expect, and a key,
// which is written and shown again at most as its last four characters. A
// field the server's environment supplies shows as set there and cannot be
// changed here. Below the fields
// the section says where recordings go, and once voice is on, Try it records
// and transcribes through the composer's own dictation. Changing voice needs
// a recent sign-in, which the section offers up front.

// The choices of provider: the presets, then the operator's own server.
const ownServer = "own";

const loadSettings = () => request<SettingsResult>("GET", "/settings");

// VoiceSection is Settings' section of voice: the offer to sign in again
// while the sign-in is not recent, then the settings, once both are known.
export function VoiceSection({ focusHeading }: SectionProps) {
  const settings = useResource(loadSettings);
  const recent = useRecentSignIn();
  const recentHint = useId();
  const { refresh: refreshSettings } = settings;
  const { refresh: refreshRecent } = recent;
  const refresh = useCallback(() => {
    refreshSettings();
    refreshRecent();
  }, [refreshSettings, refreshRecent]);
  const loaded =
    settings.data === undefined || recent.data === undefined
      ? undefined
      : { settings: settings.data, recent: recent.data };
  return (
    <>
      <RecentSignIn
        recent={recent.data}
        need="Changing voice"
        hint={recentHint}
        refresh={refreshRecent}
        focusHeading={focusHeading}
      />
      <Loadable data={loaded} failure={settings.failure ?? recent.failure} retry={refresh}>
        {(data) => <Voice {...data} refresh={refresh} recentHint={recentHint} />}
      </Loadable>
    </>
  );
}

function Voice({
  settings,
  recent,
  refresh,
  recentHint,
}: {
  settings: SettingsResult;
  // Whether this browser signed in recently enough to change voice.
  recent: boolean;
  refresh: () => void;
  recentHint: string;
}) {
  const [settingUp, setSettingUp] = useState(false);
  const [status, setStatus] = useState("");
  // Where focus goes once the section shows its next state, when one of its
  // own controls replaced another. After a save or a clear, that state is
  // the settings the server holds afterwards, so focus waits for them to
  // arrive, from the refresh that follows, and for its target to show. It
  // moves only from the control pressed, never from where the operator has
  // put it since.
  const [focusNext, setFocusNext] = useState<{
    target: "set-up" | "form" | "save";
    after?: SettingsResult;
    from?: Element | null;
  }>();
  const focusReady =
    focusNext !== undefined && (focusNext.after === undefined || focusNext.after !== settings);
  const focusTarget = focusReady ? focusNext.target : undefined;
  const setUp = useRef<HTMLButtonElement>(null);
  // This runs after every render, since Set up may show later than the
  // request to focus it.
  useLayoutEffect(() => {
    if (focusTarget === "set-up" && setUp.current !== null) {
      setFocusNext(undefined);
      if (focusLeftWith(focusNext?.from)) {
        setUp.current.focus();
      }
    }
  });
  const { voice } = settings;
  if (voice === null && !settingUp) {
    return (
      <>
        <p>
          Voice lets you dictate a reply: you record it in the reply box, a transcription provider
          you choose here turns it into text, and you check the text before you send it. The
          provider receives your recordings.
        </p>
        <div className="actions">
          <button
            ref={setUp}
            type="button"
            onClick={() => {
              setStatus("");
              setFocusNext({ target: "form" });
              setSettingUp(true);
            }}
          >
            Set up
          </button>
        </div>
        {status !== "" && <Status>{status}</Status>}
      </>
    );
  }
  return (
    <>
      <VoiceForm
        // The form starts afresh from what the server holds whenever that
        // changes, as a save does.
        key={JSON.stringify(voice)}
        voice={voice}
        recent={recent}
        recentHint={recentHint}
        refresh={refresh}
        focus={focusTarget === "form" || focusTarget === "save" ? focusTarget : undefined}
        focusFrom={focusNext?.from}
        focused={() => setFocusNext(undefined)}
        cancel={
          voice === null
            ? () => {
                setSettingUp(false);
                setFocusNext({ target: "set-up" });
              }
            : undefined
        }
        done={(said, cleared, from) => {
          setStatus(said);
          // A first save keeps the form up until the saved settings arrive.
          if (cleared) {
            setSettingUp(false);
          }
          setFocusNext({ target: cleared ? "set-up" : "save", after: settings, from });
          refresh();
        }}
      />
      {status !== "" && <Status>{status}</Status>}
      {voice?.on === true && <TryIt />}
    </>
  );
}

// fromEnvironment says whether the environment supplies a field.
const fromEnvironment = (voice: VoiceSettings | null, field: VoiceField) =>
  voice?.from_environment.includes(field) === true;

// hasSaved says whether Settings hold something to clear: the base URL or
// the model in effect is the saved one, or a prompt or a key is saved.
function hasSaved(voice: VoiceSettings | null): boolean {
  return (
    voice !== null &&
    (voice.invalid ||
      (voice.base_url !== null && !fromEnvironment(voice, "base_url")) ||
      (voice.model !== null && !fromEnvironment(voice, "model")) ||
      voice.prompt !== null ||
      voice.key === "set" ||
      voice.key === "unused")
  );
}

type Problems = Partial<Record<keyof VoiceSettingsInput, string>>;

function VoiceForm({
  voice,
  recent,
  recentHint,
  refresh,
  focus,
  focusFrom,
  focused,
  cancel,
  done,
}: {
  voice: VoiceSettings | null;
  recent: boolean;
  recentHint: string;
  refresh: () => void;
  // What takes focus as the form shows: its first field, or Save.
  focus: "form" | "save" | undefined;
  // The control pressed, which focus moves from only if it is still there.
  focusFrom: Element | null | undefined;
  focused: () => void;
  // Goes back to voice off, for a setup not saved yet.
  cancel: (() => void) | undefined;
  // Told what a save or a clear did, whether it cleared, and the control
  // pressed for it.
  done: (status: string, cleared: boolean, from: Element | null) => void;
}) {
  const id = useId();
  const form = useRef<HTMLFormElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const target =
      focus === "save"
        ? saveButton.current
        : form.current?.querySelector<HTMLElement>("select, input");
    if (focus !== undefined && target !== null && target !== undefined) {
      if (focusLeftWith(focusFrom)) {
        target.focus();
      }
      focused();
    }
  }, [focus, focusFrom, focused]);
  const save = useAction();
  const clear = useAction();
  // A new setup starts from the first preset; a saved one shows as a preset
  // only when its base URL is exactly the preset's.
  const initialPreset =
    voice === null || voice.base_url === null ? transcriptionPresets[0] : presetOf(voice.base_url);
  const [preset, setPreset] = useState<string>(initialPreset?.name ?? ownServer);
  const [baseUrl, setBaseUrl] = useState(voice?.base_url ?? initialPreset?.base_url ?? "");
  const [model, setModel] = useState(voice?.model ?? initialPreset?.model ?? "");
  const [prompt, setPrompt] = useState(voice?.prompt ?? "");
  const [key, setKey] = useState("");
  const [replacingKey, setReplacingKey] = useState(false);
  const [problems, setProblems] = useState<Problems>({});
  const envBaseUrl = fromEnvironment(voice, "base_url");
  const envModel = fromEnvironment(voice, "model");
  const envKey = fromEnvironment(voice, "api_key");
  const keyState = voice?.key ?? "none";

  // The base URL the form would save, in its stored form, for what Settings
  // say about where recordings go. Which hosts it may reach is the server's
  // to judge, when it is saved.
  const checked = normalizeBaseUrl(baseUrl);
  const effective = envBaseUrl
    ? (voice?.base_url ?? undefined)
    : "url" in checked
      ? checked.url
      : undefined;
  const effectivePreset = effective === undefined ? undefined : presetOf(effective);
  const keyNeeded = effectivePreset !== undefined;
  // A saved key goes only to the base URL it was entered for, so one about to
  // be saved at another address is shown as left behind, with the field to
  // enter the key again.
  const keyMoved = keyState === "set" && effective !== voice?.base_url;
  const keyShown = envKey || (keyState === "set" && !keyMoved && !replacingKey);

  const choosePreset = (name: string) => {
    setPreset(name);
    const chosen = transcriptionPresets.find((each) => each.name === name);
    setBaseUrl(chosen?.base_url ?? "");
    if (!envModel) {
      setModel(chosen?.model ?? "");
    }
  };

  const problemsOf = (): Problems => {
    const found: Problems = {};
    if (!envBaseUrl && "problem" in checked) {
      found.base_url = baseUrl.trim() === "" ? "Enter the base URL." : `It ${checked.problem}.`;
    }
    if (!envModel && !transcriptionModel.safeParse(model).success) {
      found.model =
        model.trim() === ""
          ? "Enter the model."
          : "Use 1 to 200 printable ASCII characters, such as gpt-transcribe.";
    }
    if (prompt.trim() !== "" && !transcriptionPrompt.safeParse(prompt).success) {
      found.prompt = "Keep it to 500 characters.";
    }
    if (key !== "" && !transcriptionKey.safeParse(key).success) {
      found.api_key = "A key is 1 to 1,024 printable ASCII characters without spaces.";
    } else if (key === "" && keyNeeded && !envKey && !(keyState === "set" && !keyMoved)) {
      found.api_key = `${effectivePreset.name} needs a key.`;
    }
    return found;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const pressed = document.activeElement;
    const found = problemsOf();
    setProblems(found);
    if (Object.keys(found).length > 0) {
      return;
    }
    const body: VoiceSettingsInput = {
      ...(envBaseUrl ? {} : { base_url: baseUrl }),
      ...(envModel ? {} : { model }),
      ...(prompt.trim() === "" ? {} : { prompt }),
      ...(key === "" ? {} : { api_key: key }),
    };
    const saved = await save.run((csrf) =>
      needingRecent(request<SettingsResult>("POST", "/settings/voice", { csrf, body }), refresh),
    );
    if (saved !== undefined) {
      done("Voice saved.", false, pressed);
    }
  };

  // Clearing the saved settings turns voice off unless the environment
  // supplies what voice needs, the base URL and the model, or voice is off
  // already; only then is it offered as clearing them.
  const stays = envBaseUrl && envModel;
  const turnsOff = voice?.on === true && !stays;

  const turnOff = async () => {
    const pressed = document.activeElement;
    const cleared = await clear.run((csrf) =>
      needingRecent(request<SettingsResult>("POST", "/settings/voice/clear", { csrf }), refresh),
    );
    if (cleared !== undefined) {
      done(
        turnsOff ? "Voice turned off." : "Saved settings cleared.",
        cleared.voice === null,
        pressed,
      );
    }
  };

  // A refusal that names a field shows at it; any other shows above Save.
  const refusedField =
    save.failure instanceof ApiFailure && save.failure.field !== undefined
      ? (save.failure.field as keyof VoiceSettingsInput)
      : undefined;
  const problemAt = (field: keyof VoiceSettingsInput) =>
    problems[field] ?? (refusedField === field ? describeFailure(save.failure) : undefined);
  const otherFailure = refusedField === undefined ? save.failure : undefined;
  const held = recent ? undefined : recentHint;

  return (
    <form ref={form} noValidate onSubmit={(event) => void submit(event)}>
      {voice?.invalid === true && (
        <div className="notice warning">
          <p>
            The voice settings saved here no longer meet the rules a save is held to, so voice does
            not use them. Clear them, or save new ones.
          </p>
        </div>
      )}
      {!envBaseUrl && (
        <>
          <label htmlFor={`${id}-preset`}>Provider</label>
          <select
            id={`${id}-preset`}
            value={preset}
            onChange={(event) => choosePreset(event.target.value)}
          >
            {transcriptionPresets.map((each) => (
              <option key={each.name} value={each.name}>
                {each.name}
              </option>
            ))}
            <option value={ownServer}>Your own server</option>
          </select>
        </>
      )}
      <Field
        id={`${id}-base-url`}
        label="Base URL"
        hint="The address the OpenAI-compatible API is under, such as https://api.openai.com/v1."
        problem={problemAt("base_url")}
        fixed={envBaseUrl ? (voice?.base_url ?? "") : undefined}
      >
        {(describedBy, invalid) => (
          <input
            id={`${id}-base-url`}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={baseUrl}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              const now = normalizeBaseUrl(event.target.value);
              setPreset(("url" in now ? presetOf(now.url)?.name : undefined) ?? ownServer);
            }}
          />
        )}
      </Field>
      <Field
        id={`${id}-model`}
        label="Model"
        hint="As the provider names it."
        problem={problemAt("model")}
        fixed={envModel ? (voice?.model ?? "") : undefined}
      >
        {(describedBy, invalid) => (
          <input
            id={`${id}-model`}
            autoComplete="off"
            spellCheck={false}
            value={model}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            onChange={(event) => setModel(event.target.value)}
          />
        )}
      </Field>
      <Field
        id={`${id}-prompt`}
        label="Words to recognize"
        hint="Optional. Such as names, which the provider may otherwise mishear."
        problem={problemAt("prompt")}
      >
        {(describedBy, invalid) => (
          <input
            id={`${id}-prompt`}
            value={prompt}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            onChange={(event) => setPrompt(event.target.value)}
          />
        )}
      </Field>
      <KeyField
        id={`${id}-key`}
        shown={keyShown}
        ending={voice?.key_ending ?? null}
        environment={envKey}
        unused={keyState === "unused"}
        moved={keyMoved}
        needed={keyNeeded ? effectivePreset.name : undefined}
        value={key}
        onChange={setKey}
        onReplace={() => setReplacingKey(true)}
        problem={problemAt("api_key")}
      />
      <Destination baseUrl={effective} />
      <Failure failure={otherFailure} />
      <div className="actions">
        <button
          ref={saveButton}
          type="submit"
          disabled={!recent || save.pending}
          aria-describedby={held}
        >
          Save
        </button>
        {cancel !== undefined && (
          <button type="button" className="secondary" onClick={cancel}>
            Cancel
          </button>
        )}
        {hasSaved(voice) && (
          <ConfirmButton
            label={turnsOff ? "Turn off" : "Clear saved settings"}
            confirmLabel={turnsOff ? "Turn voice off" : "Clear them"}
            question={
              !turnsOff
                ? "Clear the voice settings saved here, and any key saved with them?"
                : envBaseUrl
                  ? "Turn voice off? The model and anything else saved here, and any key saved with them, are deleted; the base URL stays as the server's environment sets it."
                  : "Turn voice off? The settings saved here, and any key saved with them, are deleted."
            }
            disabled={!recent || clear.pending}
            describedBy={held}
            onConfirm={() => void turnOff()}
          />
        )}
      </div>
      <Failure failure={clear.failure} />
      {stays && voice?.on === true && (
        <p className="hint">
          Voice stays on while the server&apos;s environment sets its base URL and model: to turn it
          off, remove AGENTION_TRANSCRIPTION_URL there and restart the server.
        </p>
      )}
    </form>
  );
}
