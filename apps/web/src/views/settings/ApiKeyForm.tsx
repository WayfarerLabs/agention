import {
  type ApiKeyCreated,
  type ApiKeyCreateInput,
  apiKeyDays,
  type ApiKeyExpiry,
  holdsScope,
  maxApiKeyLifetimeDays,
  type Scope,
  scopes,
} from "@wayfarerlabs/agention-api";
import { type FormEvent, useId, useLayoutEffect, useRef, useState } from "react";
import { ApiFailure, describeFailure, request } from "../../api.ts";
import { Failure } from "../../components.tsx";
import { useAction } from "../../data.ts";
import { absoluteTime } from "../../format.tsx";
import { needingRecent } from "./RecentSignIn.tsx";

// The API keys section's create form: a name, the scopes, and an expiry. A
// scope that another chosen scope includes, as threads:write includes
// threads:read, shows as chosen with it and is not sent, since the key holds
// it through the other. Choosing no expiry shows a warning.

// What each scope lets the key's holder do, beside what it includes, which
// the form says from the shared scope rules.
const grants: Record<Scope, string> = {
  "threads:read": "Read the thread list and its counts, and any thread with its messages.",
  "threads:write":
    "Also start threads, write in them, answer asks, and mark threads read, unread or archived.",
  "sessions:read":
    "Read the sessions view with its agents, groups and tags, each session's log, and agents' registrations.",
  "sessions:write": "Also mark a session's log read, and manage groups and tags.",
  "sessions:approve":
    "Also approve, reject and revoke agents' registrations: whoever holds the key can let an agent into your sessions.",
  "saved-views:read": "Read your saved views, each with its thread list.",
  "saved-views:write": "Also save, rename, replace and remove saved views.",
};

// The scopes a scope includes besides itself.
const includes = (scope: Scope) =>
  scopes.filter((other) => other !== scope && holdsScope([scope], other));

// The expiry choices: a number of days, a date, or none.
type ExpiryChoice = `${(typeof apiKeyDays)[number]}` | "date" | "none";
const defaultExpiry: ExpiryChoice = "30";

const dayMs = 24 * 60 * 60 * 1000;

// A local date as a date input writes it, YYYY-MM-DD.
const dateValue = (at: Date) =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;

const daysAfter = (at: Date, days: number) =>
  new Date(at.getFullYear(), at.getMonth(), at.getDate() + days);

// endOfDay is when a key given an expiry date stops working: the start of the
// next local day, so the key works through the date chosen.
function endOfDay(value: string): Date | undefined {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (parts === null) {
    return undefined;
  }
  const [, year, month, day] = parts.map(Number);
  return year === undefined || month === undefined || day === undefined
    ? undefined
    : new Date(year, month - 1, day + 1);
}

type Field = "name" | "scopes" | "expiry";
type Problems = Partial<Record<Field, string>>;

// The form field a refusal names, from its dotted path, such as expiry.at.
const fieldOf = (failure: unknown): Field | undefined => {
  const first = failure instanceof ApiFailure ? failure.field?.split(".")[0] : undefined;
  return first === "name" || first === "scopes" || first === "expiry" ? first : undefined;
};

export function ApiKeyForm({
  recent,
  recentHint,
  refresh,
  onCreated,
  onCancel,
}: {
  // Whether this browser signed in recently enough to create a key.
  recent: boolean;
  recentHint: string;
  refresh: () => void;
  onCreated: (created: ApiKeyCreated) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const action = useAction();
  const nameField = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<readonly Scope[]>([]);
  const [expiry, setExpiry] = useState<ExpiryChoice>(defaultExpiry);
  const [date, setDate] = useState("");
  const [problems, setProblems] = useState<Problems>({});
  useLayoutEffect(() => nameField.current?.focus(), []);

  // The chosen scope that includes another, if one does.
  const includedBy = (scope: Scope) =>
    chosen.find((other) => other !== scope && holdsScope([other], scope));
  const toggle = (scope: Scope) =>
    setChosen((now) =>
      now.includes(scope) ? now.filter((each) => each !== scope) : [...now, scope],
    );

  const today = new Date();
  const earliestDate = dateValue(today);
  const latestDate = dateValue(daysAfter(today, maxApiKeyLifetimeDays - 1));
  const days = apiKeyDays.find((each) => String(each) === expiry);

  const problemsOf = (): Problems => {
    const found: Problems = {};
    if (name.trim() === "") {
      found.name = "Name the key first.";
    }
    if (chosen.length === 0) {
      found.scopes = "Choose at least one scope.";
    }
    if (expiry === "date") {
      if (endOfDay(date) === undefined) {
        found.expiry = "Choose the date.";
      } else if (date < earliestDate || date > latestDate) {
        found.expiry = "Choose a date from today to a year from now.";
      }
    }
    return found;
  };

  const expiryOf = (): ApiKeyExpiry => {
    const end = endOfDay(date);
    if (days !== undefined) {
      return { kind: "days", days };
    }
    return expiry === "date" && end !== undefined
      ? { kind: "date", at: end.toISOString() }
      : { kind: "none" };
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = problemsOf();
    setProblems(found);
    if (Object.keys(found).length > 0) {
      return;
    }
    const body: ApiKeyCreateInput = {
      name,
      scopes: chosen.filter((scope) => includedBy(scope) === undefined),
      expiry: expiryOf(),
    };
    const created = await action.run((csrf) =>
      needingRecent(request<ApiKeyCreated>("POST", "/keys", { csrf, body }), refresh),
    );
    if (created !== undefined) {
      onCreated(created);
    }
  };

  // A refusal that names a field shows at it; any other shows above Create.
  const refused = fieldOf(action.failure);
  const problemAt = (field: Field) =>
    problems[field] ?? (refused === field ? describeFailure(action.failure) : undefined);
  const otherFailure = refused === undefined ? action.failure : undefined;
  const described = (field: Field, hint?: string) =>
    [hint, problemAt(field) === undefined ? undefined : `${id}-${field}-error`]
      .filter((each) => each !== undefined)
      .join(" ") || undefined;
  const error = (field: Field) => {
    const problem = problemAt(field);
    return (
      problem !== undefined && (
        <p id={`${id}-${field}-error`} className="field-error">
          {problem}
        </p>
      )
    );
  };

  return (
    <form aria-labelledby={`${id}-heading`} noValidate onSubmit={(event) => void submit(event)}>
      <h3 id={`${id}-heading`}>New API key</h3>
      <label htmlFor={`${id}-name`}>Name</label>
      <p className="hint" id={`${id}-name-hint`}>
        Such as the program that will hold it.
      </p>
      <input
        ref={nameField}
        id={`${id}-name`}
        value={name}
        maxLength={50}
        autoComplete="off"
        aria-invalid={problemAt("name") === undefined ? undefined : true}
        aria-describedby={described("name", `${id}-name-hint`)}
        onChange={(event) => setName(event.target.value)}
      />
      {error("name")}

      <fieldset aria-describedby={described("scopes", `${id}-scopes-hint`)}>
        <legend>Scopes</legend>
        <p className="hint" id={`${id}-scopes-hint`}>
          What the key may do, as you. A write or approve scope includes its read. No key can manage
          keys, passkeys or Settings.
        </p>
        <ul className="choices">
          {scopes.map((scope) => {
            const by = includedBy(scope);
            const also = includes(scope);
            return (
              <li key={scope}>
                <label>
                  {/* Named by the scope alone, and described by what it grants. */}
                  <input
                    type="checkbox"
                    checked={by !== undefined || chosen.includes(scope)}
                    disabled={by !== undefined}
                    aria-labelledby={`${id}-${scope}`}
                    aria-describedby={`${id}-${scope}-grants`}
                    onChange={() => toggle(scope)}
                  />
                  <span>
                    <span className="choice-label" id={`${id}-${scope}`}>
                      <code>{scope}</code>
                    </span>
                    <span className="choice-description" id={`${id}-${scope}-grants`}>
                      {grants[scope]}
                      {also.length > 0 && <> Includes {also.join(", ")}.</>}
                      {by !== undefined && <> Included with {by}.</>}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        {error("scopes")}
      </fieldset>

      <label htmlFor={`${id}-expiry`}>Expiry</label>
      <select
        id={`${id}-expiry`}
        value={expiry}
        aria-describedby={
          expiry === "date" ? `${id}-expiry-hint` : described("expiry", `${id}-expiry-hint`)
        }
        onChange={(event) => setExpiry(event.target.value as ExpiryChoice)}
      >
        {apiKeyDays.map((each) => (
          <option key={each} value={String(each)}>
            {each} days
          </option>
        ))}
        <option value="date">A date you choose</option>
        <option value="none">No expiry</option>
      </select>
      {expiry === "none" ? (
        <div className="notice warning" id={`${id}-expiry-hint`}>
          <p>
            A key without an expiry works until you revoke it, so if it leaks, whoever holds it can
            act as you, within its scopes, until you notice. Choose an expiry unless the program
            that holds it truly needs a key that lasts.
          </p>
        </div>
      ) : (
        <p className="hint" id={`${id}-expiry-hint`}>
          {days !== undefined
            ? `The key will expire ${absoluteTime(new Date(Date.now() + days * dayMs).toISOString())}.`
            : "The key works through the end of the date you choose, at most a year from now."}
        </p>
      )}
      {expiry === "date" && (
        <>
          <label htmlFor={`${id}-date`}>Expiry date</label>
          <input
            id={`${id}-date`}
            type="date"
            min={earliestDate}
            max={latestDate}
            value={date}
            aria-invalid={problemAt("expiry") === undefined ? undefined : true}
            aria-describedby={described("expiry")}
            onChange={(event) => setDate(event.target.value)}
          />
        </>
      )}
      {error("expiry")}

      <Failure failure={otherFailure} />
      <div className="actions">
        <button
          type="submit"
          disabled={!recent || action.pending}
          aria-describedby={recent ? undefined : recentHint}
        >
          Create key
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
