import type {
  PasskeyList,
  PasskeyRemoved,
  PasskeySummary,
  SessionState,
} from "@wayfarerlabs/agention-server-api";
import { type FormEvent, useId, useState } from "react";
import { request } from "../../api.ts";
import { ConfirmButton, Failure, Loadable, Status, Tags } from "../../components.tsx";
import { useAction, useResource } from "../../data.ts";
import { forgetDrafts } from "../../device.ts";
import { Time } from "../../format.tsx";
import { addPasskey, passkeysSupported } from "../../passkeys.ts";
import { useSession } from "../../session.tsx";
import { loadPasskeys, needingRecent, RecentSignIn, unsupported } from "./RecentSignIn.tsx";
import type { SectionProps } from "./sections.ts";

// Settings' passkeys: the operator's passkeys, each named, with the one that
// signed this browser in marked. They add one on this device, rename any, and
// remove any but the last. Another device signs in with a passkey they hold
// and adds its own there. Adding and removing need a recent sign-in, which
// the section offers up front; the list says whether the sign-in is recent.

// nameProblem says why a passkey name cannot be sent: a blank one.
export const nameProblem = (name: string) =>
  name.trim() === "" ? "Name the passkey first." : undefined;

// PasskeyNameField is the one field that names a passkey.
export function PasskeyNameField({
  label,
  value,
  onChange,
  problem,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  problem: string | undefined;
}) {
  const id = useId();
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <p className="hint" id={`${id}-hint`}>
        Such as the device that holds it.
      </p>
      <input
        id={id}
        value={value}
        maxLength={50}
        aria-invalid={problem === undefined ? undefined : true}
        aria-describedby={`${id}-hint${problem === undefined ? "" : ` ${id}-error`}`}
        onChange={(event) => onChange(event.target.value)}
      />
      {problem !== undefined && (
        <p id={`${id}-error`} className="field-error">
          {problem}
        </p>
      )}
    </>
  );
}

// PasskeysSection is Settings' section of passkeys: the offer to sign in
// again while the list says the sign-in is not recent, then the list.
export function PasskeysSection({ focusHeading }: SectionProps) {
  const passkeys = useResource(loadPasskeys);
  const recentHint = useId();
  return (
    <>
      <RecentSignIn
        recent={passkeys.data?.recent}
        need="Adding or removing a passkey"
        hint={recentHint}
        refresh={passkeys.refresh}
        focusHeading={focusHeading}
      />
      <Loadable data={passkeys.data} failure={passkeys.failure} retry={passkeys.refresh}>
        {(data) => <Passkeys data={data} refresh={passkeys.refresh} recentHint={recentHint} />}
      </Loadable>
    </>
  );
}

// Passkeys lists the operator's passkeys. recentHint names what says a
// recent sign-in is needed, while one is.
function Passkeys({
  data,
  refresh,
  recentHint,
}: {
  data: PasskeyList;
  refresh: () => void;
  recentHint: string;
}) {
  const onlyHint = useId();
  const recent = data.recent ? undefined : recentHint;
  const only = data.passkeys.length === 1;
  return (
    <>
      <ul className="passkeys">
        {data.passkeys.map((passkey) => (
          <PasskeyItem
            key={passkey.id}
            passkey={passkey}
            removable={data.recent && !only}
            describedBy={recent ?? (only ? onlyHint : undefined)}
            refresh={refresh}
          />
        ))}
      </ul>
      {only && (
        <p id={onlyHint} className="hint">
          Your only passkey cannot be removed: add another first.
        </p>
      )}
      <AddHere recent={data.recent} describedBy={recent} refresh={refresh} />
    </>
  );
}

function PasskeyItem({
  passkey,
  removable,
  describedBy,
  refresh,
}: {
  passkey: PasskeySummary;
  removable: boolean;
  describedBy: string | undefined;
  refresh: () => void;
}) {
  const session = useSession();
  const action = useAction();
  const [renaming, setRenaming] = useState(false);
  const [status, setStatus] = useState("");

  const remove = async () => {
    setStatus("");
    // Removing the passkey that signed this browser in signs it out, so from
    // here, as from Sign out, the page asks nothing more that needs the
    // session.
    const leaving = passkey.current;
    const release = leaving ? session.signingOut() : undefined;
    const removed = await action.run((csrf) =>
      needingRecent(
        request<PasskeyRemoved>("POST", `/passkeys/${passkey.id}/remove`, { csrf }),
        refresh,
      ),
    );
    if (removed?.signed_out === true) {
      // Signed out, the browser forgets its drafts as Sign out does.
      forgetDrafts();
      const signedOut: SessionState = { signed_in: false, operator_exists: true };
      session.update(signedOut);
      return;
    }
    release?.();
    // A removal of this browser's passkey that failed reads the list again
    // here, since it could not while the browser was signing out: a sign-in
    // found too old is then offered again.
    if (leaving || removed !== undefined) {
      refresh();
    }
  };

  return (
    <li>
      <article className="passkey" aria-label={`Passkey ${passkey.name}`}>
        <h3>{passkey.name}</h3>
        <p className="where">
          Added <Time value={passkey.created_at} />
          {" · "}
          {passkey.last_used_at === undefined ? (
            "never used to sign in"
          ) : (
            <>
              last signed in <Time value={passkey.last_used_at} />
            </>
          )}
        </p>
        {passkey.current && <Tags tags={[{ label: "Signed in this browser", tone: "accent" }]} />}
        {renaming ? (
          <RenameForm
            passkey={passkey}
            onDone={(renamed) => {
              setRenaming(false);
              if (renamed) {
                setStatus("Renamed.");
                refresh();
              }
            }}
          />
        ) : (
          <div className="actions">
            <button type="button" className="secondary" onClick={() => setRenaming(true)}>
              Rename
            </button>
            <ConfirmButton
              label="Remove"
              confirmLabel="Remove this passkey"
              question={
                passkey.current
                  ? `Remove ${passkey.name}? It signed this browser in, so this browser signs out too.`
                  : `Remove ${passkey.name}? Every browser it signed in signs out.`
              }
              disabled={!removable || action.pending}
              describedBy={describedBy}
              onConfirm={() => void remove()}
            />
          </div>
        )}
        <Failure failure={action.failure} />
        {status !== "" && <Status>{status}</Status>}
      </article>
    </li>
  );
}

function RenameForm({
  passkey,
  onDone,
}: {
  passkey: PasskeySummary;
  onDone: (renamed: boolean) => void;
}) {
  const action = useAction();
  const [name, setName] = useState(passkey.name);
  const [problem, setProblem] = useState<string>();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const blank = nameProblem(name);
    setProblem(blank);
    if (blank !== undefined) {
      return;
    }
    const done = await action.run((csrf) =>
      request("POST", `/passkeys/${passkey.id}/name`, { csrf, body: { name } }),
    );
    if (done !== undefined) {
      onDone(true);
    }
  };
  return (
    <form noValidate onSubmit={(event) => void submit(event)}>
      <PasskeyNameField label="New name" value={name} onChange={setName} problem={problem} />
      <Failure failure={action.failure} />
      <div className="actions">
        <button type="submit" disabled={action.pending}>
          Save
        </button>
        <button type="button" className="secondary" onClick={() => onDone(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// AddHere adds a passkey on this device, under the name given.
function AddHere({
  recent,
  describedBy,
  refresh,
}: {
  recent: boolean;
  describedBy: string | undefined;
  refresh: () => void;
}) {
  const action = useAction();
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string>();
  const [status, setStatus] = useState("");
  const id = useId();
  const add = async (event: FormEvent) => {
    event.preventDefault();
    setStatus("");
    const blank = nameProblem(name);
    setProblem(blank);
    if (blank !== undefined) {
      return;
    }
    const added = await action.run(async (csrf) => {
      await needingRecent(addPasskey(name, csrf), refresh);
      return true;
    });
    if (added === true) {
      setName("");
      setStatus("Passkey added.");
      refresh();
    }
  };
  return (
    <section aria-labelledby={`${id}-heading`}>
      <h3 id={`${id}-heading`}>Add a passkey on this device</h3>
      <p className="hint">
        For another device, sign in there with a passkey you hold, such as your phone's, through
        that browser's cross-device sign-in, then add the device's own passkey there.
      </p>
      {passkeysSupported() ? (
        <form noValidate onSubmit={(event) => void add(event)}>
          <PasskeyNameField
            label="Passkey name"
            value={name}
            onChange={setName}
            problem={problem}
          />
          <Failure failure={action.failure} />
          <div className="actions">
            <button
              type="submit"
              disabled={!recent || action.pending}
              aria-describedby={describedBy}
            >
              Add a passkey
            </button>
          </div>
          {status !== "" && <Status>{status}</Status>}
        </form>
      ) : (
        <p>{unsupported}</p>
      )}
    </section>
  );
}
