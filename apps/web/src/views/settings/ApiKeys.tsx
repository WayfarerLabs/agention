import {
  type ApiKeyCreated,
  type ApiKeyList,
  type ApiKeyRevoked,
  type ApiKeySummary,
  maxApiKeys,
} from "@wayfarerlabs/agention-api";
import { useEffect, useId, useRef, useState } from "react";
import { request } from "../../api.ts";
import {
  ConfirmButton,
  Failure,
  focusLeftWith,
  Loadable,
  Status,
  Tags,
} from "../../components.tsx";
import { useAction, useResource } from "../../data.ts";
import { DueTime, Time } from "../../format.tsx";
import { ApiKeyForm } from "./ApiKeyForm.tsx";
import { needingRecent, RecentSignIn } from "./RecentSignIn.tsx";
import type { SectionProps } from "./sections.ts";

// Settings' API keys: the keys a program the operator runs holds to call the
// operator API as them, within each key's scopes. The section lists every
// key, with its scopes, when it was created, expires and was last used, and
// any the server still lists revoked or expired. The operator creates a key,
// whose secret shows once, in this page's memory only, until they dismiss
// it, and revokes any live key. Creating and revoking need a recent sign-in,
// which the section offers up front; the list says whether the sign-in is
// recent.

const loadKeys = () => request<ApiKeyList>("GET", "/keys");

// ApiKeysSection is Settings' section of API keys: the offer to sign in
// again while the list says the sign-in is not recent, then the keys.
export function ApiKeysSection({ focusHeading }: SectionProps) {
  const keys = useResource(loadKeys);
  const recentHint = useId();
  return (
    <>
      <RecentSignIn
        recent={keys.data?.recent}
        need="Creating or revoking an API key"
        hint={recentHint}
        refresh={keys.refresh}
        focusHeading={focusHeading}
      />
      <Loadable data={keys.data} failure={keys.failure} retry={keys.refresh}>
        {(data) => <ApiKeys data={data} refresh={keys.refresh} recentHint={recentHint} />}
      </Loadable>
    </>
  );
}

// ApiKeys shows the list with the way to create a key, or, once one is
// created, its secret alone until the operator is done with it. Focus moves
// with each: to the form's first field as it opens, back to Create an API
// key when it is cancelled, to the secret as it shows, and to the new key in
// the list once the secret is dismissed.
function ApiKeys({
  data,
  refresh,
  recentHint,
}: {
  data: ApiKeyList;
  refresh: () => void;
  recentHint: string;
}) {
  const fullHint = useId();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<ApiKeyCreated>();
  const [focusNext, setFocusNext] = useState<"create" | number>();
  const create = useRef<HTMLButtonElement>(null);
  // This runs after every render, since Create an API key shows a render
  // after the form goes.
  useEffect(() => {
    if (focusNext === "create" && create.current !== null) {
      setFocusNext(undefined);
      if (focusLeftWith()) {
        create.current.focus();
      }
    }
  });
  if (created !== undefined) {
    return (
      <NewSecret
        created={created}
        onDone={() => {
          setCreated(undefined);
          setFocusNext(created.key.id);
        }}
      />
    );
  }
  const live = data.keys.filter((key) => key.status === "active").length;
  const full = live >= maxApiKeys;
  const held = data.recent ? undefined : recentHint;
  return (
    <>
      <p>
        An API key lets a program you run call Agention&apos;s operator API as you, within the
        scopes you give it.
      </p>
      {data.keys.length === 0 ? (
        <p className="empty">No API keys yet.</p>
      ) : (
        <ul className="api-keys">
          {data.keys.map((key) => (
            <ApiKeyItem
              key={key.id}
              apiKey={key}
              recent={data.recent}
              describedBy={held}
              focus={focusNext === key.id}
              focused={() => setFocusNext(undefined)}
              refresh={refresh}
            />
          ))}
        </ul>
      )}
      {creating ? (
        <ApiKeyForm
          recent={data.recent}
          recentHint={recentHint}
          refresh={refresh}
          onCreated={(key) => {
            setCreating(false);
            setCreated(key);
            refresh();
          }}
          onCancel={() => {
            setCreating(false);
            setFocusNext("create");
          }}
        />
      ) : (
        <div className="actions">
          <button
            ref={create}
            type="button"
            disabled={full}
            aria-describedby={full ? fullHint : undefined}
            onClick={() => setCreating(true)}
          >
            Create an API key
          </button>
        </div>
      )}
      {full && !creating && (
        <p id={fullHint} className="hint">
          You hold {maxApiKeys} keys, the most there can be: revoke one to create another.
        </p>
      )}
    </>
  );
}

// ApiKeyItem is one key in the list. A live key can be revoked, once
// confirmed; focus then goes to the key's heading, as the Revoke button goes.
function ApiKeyItem({
  apiKey,
  recent,
  describedBy,
  focus,
  focused,
  refresh,
}: {
  apiKey: ApiKeySummary;
  recent: boolean;
  // What says why Revoke is unavailable, when it is.
  describedBy: string | undefined;
  // Whether the key's heading takes focus as it shows.
  focus: boolean;
  focused: () => void;
  refresh: () => void;
}) {
  const action = useAction();
  const [status, setStatus] = useState("");
  const article = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (focus) {
      focused();
      if (focusLeftWith(article.current)) {
        heading.current?.focus();
      }
    }
  }, [focus, focused]);

  const revoke = async () => {
    setStatus("");
    const revoked = await action.run((csrf) =>
      needingRecent(request<ApiKeyRevoked>("POST", `/keys/${apiKey.id}/revoke`, { csrf }), refresh),
    );
    if (revoked !== undefined) {
      setStatus("Revoked.");
      if (focusLeftWith(article.current)) {
        heading.current?.focus();
      }
      refresh();
    }
  };

  const { status: state } = apiKey;
  return (
    <li>
      <article ref={article} className="api-key" aria-label={`API key ${apiKey.name}`}>
        <h3 ref={heading} tabIndex={-1}>
          {apiKey.name}
        </h3>
        <p className="where">
          Created <Time value={apiKey.created_at} />
          {" · "}
          {apiKey.expires_at === undefined ? (
            "never expires"
          ) : (
            <>
              {state === "expired" ? (
                <>
                  expired <Time value={apiKey.expires_at} />
                </>
              ) : (
                <>
                  expires <DueTime value={apiKey.expires_at} />
                </>
              )}
            </>
          )}
          {" · "}
          {apiKey.last_used_at === undefined ? (
            "never used"
          ) : (
            <>
              last used <Time value={apiKey.last_used_at} />
            </>
          )}
        </p>
        {state === "active" && apiKey.expires_at === undefined && (
          <Tags tags={[{ label: "No expiry", tone: "warning" }]} />
        )}
        {state !== "active" && (
          <Tags
            tags={[
              state === "revoked"
                ? {
                    label:
                      apiKey.revoked_at === undefined ? (
                        "Revoked"
                      ) : (
                        <>
                          Revoked <Time value={apiKey.revoked_at} />
                        </>
                      ),
                    tone: "danger",
                  }
                : { label: "Expired", tone: "warning" },
            ]}
          />
        )}
        <ul className="tags" aria-label="Scopes">
          {apiKey.scopes.map((scope) => (
            <li key={scope}>
              <code>{scope}</code>
            </li>
          ))}
        </ul>
        {state === "active" && (
          <div className="actions">
            <ConfirmButton
              label="Revoke"
              confirmLabel="Revoke this key"
              question={`Revoke ${apiKey.name}? Any program using it is refused from now on.`}
              disabled={!recent || action.pending}
              describedBy={describedBy}
              onConfirm={() => void revoke()}
            />
          </div>
        )}
        <Failure failure={action.failure} />
        {status !== "" && <Status>{status}</Status>}
      </article>
    </li>
  );
}

// NewSecret shows a new key's secret, once, with Copy, which falls back to
// selecting it where the clipboard is unavailable. The secret is held in
// memory only, in ApiKeys' state until Done clears it, and passed here as a
// prop: never in storage, the address or a log.
function NewSecret({ created, onDone }: { created: ApiKeyCreated; onDone: () => void }) {
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [status, setStatus] = useState("");
  useEffect(() => field.current?.focus(), []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.secret);
      setStatus("Copied.");
    } catch {
      field.current?.focus();
      field.current?.select();
      setStatus("This browser would not copy it: the key is selected, so copy it from there.");
    }
  };
  return (
    <section aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>{created.key.name} is ready</h3>
      <div className="notice warning">
        <p id={`${id}-note`}>
          Copy the key now and keep it somewhere safe: Agention will not show it again. Whoever
          holds it can act as you, within its scopes.
        </p>
      </div>
      <label htmlFor={`${id}-secret`}>API key</label>
      {/* A text area, so the whole key shows, wrapped, even on a phone. */}
      <textarea
        ref={field}
        rows={2}
        id={`${id}-secret`}
        className="secret"
        readOnly
        value={created.secret}
        autoComplete="off"
        spellCheck={false}
        aria-describedby={`${id}-note`}
        onFocus={(event) => event.target.select()}
      />
      <div className="actions">
        <button type="button" onClick={() => void copy()}>
          Copy
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Done
        </button>
      </div>
      {status !== "" && <Status>{status}</Status>}
    </section>
  );
}
