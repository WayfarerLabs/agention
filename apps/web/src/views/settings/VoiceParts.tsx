import { presetOf } from "@wayfarerlabs/agention-server-api";
import { type ReactNode, useId, useLayoutEffect, useRef, useState } from "react";
import { ExternalLink } from "../../markdown/Markdown.tsx";
import { recorderType, useDictation } from "../../voice/Dictation.tsx";

// The Voice section's parts: a setting's field, the write-only key, where
// recordings go, and Try it.

const setByEnvironment = "Set by the server's environment.";

// masked is how a key in effect shows: masked, but for its last four
// characters when the server shows them.
const masked = (ending: string | null) => "\u2022".repeat(8) + (ending ?? "");

// Field is one labelled setting: an input, or, when the environment
// supplies it, its value, which cannot be changed here.
export function Field({
  id,
  label,
  hint,
  problem,
  fixed,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  problem?: string | undefined;
  fixed?: string | undefined;
  children: (describedBy: string, invalid: true | undefined) => ReactNode;
}) {
  if (fixed !== undefined) {
    return (
      <div className="setting">
        <p className="label" id={id}>
          {label}
        </p>
        <p className="setting-value">
          <code>{fixed}</code>
        </p>
        <p className="hint">{setByEnvironment}</p>
      </div>
    );
  }
  return (
    <div className="setting">
      <label htmlFor={id}>{label}</label>
      <p className="hint" id={`${id}-hint`}>
        {hint}
      </p>
      {children(
        `${id}-hint${problem === undefined ? "" : ` ${id}-error`}`,
        problem === undefined ? undefined : true,
      )}
      {problem !== undefined && (
        <p id={`${id}-error`} className="field-error">
          {problem}
        </p>
      )}
    </div>
  );
}

// KeyField is the provider's key, write-only. A key in effect shows in the
// key's own input, read-only and masked but for its last four characters, all
// of it that reaches the browser: one from the environment as set there, one
// saved here with Replace, which empties the field for a new key. A saved key
// for another address says so, and the field is empty to enter one.
export function KeyField({
  id,
  shown,
  ending,
  environment,
  unused,
  moved,
  needed,
  value,
  onChange,
  onReplace,
  problem,
}: {
  id: string;
  shown: boolean;
  // The last four characters of the key in effect, when the server shows
  // them.
  ending: string | null;
  environment: boolean;
  // A saved key for another address than the one in effect.
  unused: boolean;
  // A saved key for the saved address, which the address about to be saved
  // would leave behind.
  moved: boolean;
  // The preset that needs a key, if one does.
  needed: string | undefined;
  value: string;
  onChange: (value: string) => void;
  onReplace: () => void;
  problem: string | undefined;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [replaced, setReplaced] = useState(false);
  useLayoutEffect(() => {
    if (replaced && input.current !== null) {
      setReplaced(false);
      input.current.focus();
    }
  }, [replaced]);
  if (shown) {
    return (
      <Field
        id={id}
        label="Key"
        hint={environment ? setByEnvironment : "Saved here. Replace it to enter another."}
        problem={problem}
      >
        {(describedBy, invalid) => (
          <div className="masked-key">
            <input
              id={id}
              readOnly
              autoComplete="off"
              spellCheck={false}
              value={masked(ending)}
              aria-invalid={invalid}
              aria-describedby={describedBy}
            />
            {!environment && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setReplaced(true);
                  onReplace();
                }}
              >
                Replace
              </button>
            )}
          </div>
        )}
      </Field>
    );
  }
  return (
    <Field
      id={id}
      label="Key"
      hint={
        (moved
          ? "The saved key is for the saved address, and is not used at another, so enter the key for this one. "
          : unused
            ? "The saved key was for another address, so enter it again. "
            : "") +
        (needed === undefined
          ? "If your server needs one. It is kept on the server, which shows at most its last four characters."
          : `${needed} needs one. It is kept on the server, which shows at most its last four characters.`)
      }
      problem={problem}
    >
      {(describedBy, invalid) => (
        <input
          ref={input}
          id={id}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={value}
          aria-invalid={invalid}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}

// Destination says where recordings go: to a preset's provider, with what it
// says about keeping them and training on them, or to the address entered;
// and that plain http carries the key and recordings unencrypted.
export function Destination({ baseUrl }: { baseUrl: string | undefined }) {
  if (baseUrl === undefined) {
    return null;
  }
  const preset = presetOf(baseUrl);
  const url = new URL(baseUrl);
  return (
    <>
      <div className="notice">
        {preset === undefined ? (
          <p>
            Your recordings go to <strong>{url.host}</strong>, and only their text comes back.
          </p>
        ) : (
          <p>
            Your recordings go to {preset.name}, and only their text comes back.{" "}
            <ExternalLink url={new URL(preset.data_use)} text={dataUseLabel(preset.name)}>
              {dataUseLabel(preset.name)}
            </ExternalLink>
            .
          </p>
        )}
      </div>
      {url.protocol === "http:" && (
        <div className="notice warning">
          <p>
            This address uses plain http, so your key and your recordings cross your network
            unencrypted.
          </p>
        </div>
      )}
    </>
  );
}

const dataUseLabel = (provider: string) =>
  `What ${provider} says about keeping them and training on them`;

// TryIt records and transcribes through dictation itself, showing the text
// here, so it tests the configuration dictation uses.
export function TryIt() {
  const id = useId();
  const [heard, setHeard] = useState<string>();
  const recordable = recorderType() !== undefined;
  return (
    <section aria-labelledby={id}>
      <h3 id={id}>Try it</h3>
      {recordable ? (
        <>
          <p className="hint">Record a few words to check that voice works.</p>
          <TryDictation onText={setHeard} onStart={() => setHeard(undefined)} />
          {heard !== undefined && (
            <p className="plain heard" aria-live="polite">
              {heard}
            </p>
          )}
        </>
      ) : (
        <p>This browser cannot record, so dictation is not offered here.</p>
      )}
    </section>
  );
}

// TryDictation is dictation's controls, with what it says after them. A new
// recording clears the text the last one gave.
function TryDictation({
  onText,
  onStart,
}: {
  onText: (text: string) => void;
  onStart: () => void;
}) {
  const { controls, problem, said } = useDictation({
    onText,
    onActive: (active) => {
      if (active) {
        onStart();
      }
    },
  });
  return (
    <>
      {controls}
      {problem}
      {said}
    </>
  );
}
