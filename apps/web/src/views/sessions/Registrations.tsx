import {
  type ApproveInput,
  namePattern,
  type Registration,
  type RegistrationResult,
  type RegistrationsPage,
} from "@wayfarerlabs/agention-api";
import { type RefObject, useId, useLayoutEffect, useRef, useState } from "react";
import {
  type AgentList,
  type Agents,
  ApiFailure,
  describeFailure,
  query,
  request,
} from "../../api.ts";
import {
  ConfirmButton,
  Confirmation,
  Failure,
  LeftOut,
  Loadable,
  Status,
} from "../../components.tsx";
import { type Resource, useAction } from "../../data.ts";
import { absoluteTime, Time } from "../../format.tsx";
import { useOrganize } from "./Organize.tsx";

// The registrations the sessions view shows: one waiting for approval, which
// the operator approves after matching the code the agent relayed, onto an
// agent and a session chosen among those the view lists, perhaps putting the
// session in a group and giving it tags as it does, or rejects; and one
// already decided, whose credential the operator can revoke.

// loadRegistrations reads a page of registrations, only those waiting for
// approval when status says so.
export function loadRegistrations(status: "pending" | undefined) {
  return (cursor: string | undefined, signal: AbortSignal) =>
    request<RegistrationsPage>("GET", `/registrations${query({ status, cursor })}`, {
      signal,
    }).then((page) => ({ rows: page.registrations, next: page.next }));
}

export function PendingRegistration({
  registration,
  agents,
  onDecided,
}: {
  registration: Registration;
  agents: Resource<AgentList>;
  onDecided: () => void;
}) {
  const reject = useAction();
  return (
    <article className="registration" aria-label={`Registration ${registration.code}`}>
      {/* The code, as large as it can be read and compared, grouped as the
          agent relays it. */}
      <p className="code">{registration.code}</p>
      <p>
        Proposed as{" "}
        <strong>
          {registration.proposed_agent}/{registration.proposed_session}
        </strong>
        , submitted <Time value={registration.created_at} />. It expires{" "}
        <Time value={registration.expires_at} />.
      </p>
      <p className="notice warning">
        Approve only if this code is the one your agent showed you. A registration with any other
        key shows a different code.
      </p>
      <Loadable data={agents.data} failure={agents.failure} retry={agents.refresh}>
        {({ agents: directory, truncated }) => (
          <ApproveForm
            registration={registration}
            directory={directory}
            truncated={truncated}
            onApproved={onDecided}
          />
        )}
      </Loadable>
      <Failure failure={reject.failure} />
      <ConfirmButton
        label="Reject"
        confirmLabel="Reject registration"
        question={`Reject the registration with code ${registration.code}?`}
        disabled={reject.pending}
        onConfirm={async () => {
          await reject.run((csrf) =>
            request<RegistrationResult>("POST", `/registrations/${registration.id}/reject`, {
              csrf,
            }),
          );
          onDecided();
        }}
      />
    </article>
  );
}

type Choice = "existing" | "new";

// The session an approval grants, as the form names it: an existing one, or
// a new one, by its name.
interface Destination {
  existing: boolean;
  session: string;
}

// newNameProblem says what is wrong with a name for a new agent or session.
function newNameProblem(value: string, taken: string[], kind: string): string | undefined {
  if (!namePattern.test(value)) {
    return "Use 1 to 63 of a-z, 0-9, _ and -, starting with a letter or digit.";
  }
  return taken.includes(value)
    ? `There is already ${kind} named ${value}; choose it above.`
    : undefined;
}

// The session an approval grants, read from the form's session fields: an
// existing one or a new one by name, or undecided.
function sessionPick(form: HTMLFormElement): { choice: Choice | undefined; name: string } {
  const data = new FormData(form);
  const choice = data.get("session-choice");
  if (choice !== "existing" && choice !== "new") {
    return { choice: undefined, name: "" };
  }
  const name = data.get(choice === "existing" ? "existing-session" : "new-session");
  return { choice, name: typeof name === "string" ? name : "" };
}

// The ids that tie a name field to its hint and its error.
function describedBy(id: string, error: string | undefined, errorId: string): string {
  return error === undefined ? `${id}-name-hint` : `${id}-name-hint ${errorId}`;
}

// ApproveForm grants a pending registration an agent and a session, each
// either an existing one or a new one, under the proposed names or others,
// and the session's group and tags when the operator picks them, which the
// approval applies with the grant. A group picked new is created as it is
// picked, since an approval names its group by id. What is not picked stays
// as it is: none for a new session, and an existing session's own, which
// the pickers start from; choosing another session starts the picks over.
function ApproveForm({
  registration,
  directory,
  truncated,
  onApproved,
}: {
  registration: Registration;
  // Every agent with its sessions, and whether the list left agents out.
  directory: Agents;
  truncated: boolean;
  onApproved: () => void;
}) {
  const id = useId();
  const proposed = registration.proposed_agent;
  const agents = directory.map((entry) => entry.agent);
  // What the operator picked, if anything; otherwise the proposed agent when
  // it exists. The list can change under the form, so the agent shown and the
  // one sent are both worked out from it here. Typing a name or picking an
  // agent counts as picking.
  const [pickedChoice, setPickedChoice] = useState<Choice>();
  const [pickedAgent, setPickedAgent] = useState<string>();
  const agentChoice =
    agents.length === 0
      ? "new"
      : (pickedChoice ?? (agents.includes(proposed) ? "existing" : "new"));
  const existingAgent =
    pickedAgent !== undefined && agents.includes(pickedAgent)
      ? pickedAgent
      : agents.includes(proposed)
        ? proposed
        : (agents[0] ?? "");
  const [newAgent, setNewAgent] = useState(proposed);
  const agentName = agentChoice === "existing" ? existingAgent : newAgent;
  const held =
    agentChoice === "existing" ? directory.find((entry) => entry.agent === agentName) : undefined;
  const agentSessions = held?.sessions ?? [];
  const [problems, setProblems] = useState<{
    agent?: string | undefined;
    session?: string | undefined;
  }>({});
  const approve = useAction();
  // The session chosen to approve onto, new or existing, as SessionFields
  // says once it changes, under the agent it was chosen for, which another
  // agent starts over, as it does SessionFields.
  const sessionKey = `${agentChoice}:${agentName}`;
  const [onto, setOnto] = useState<{ key: string } & Destination>();
  if (onto !== undefined && onto.key !== sessionKey) {
    setOnto(undefined);
  }
  const own = onto?.existing
    ? agentSessions.find((entry) => entry.session === onto.session)
    : undefined;
  const organize = useOrganize({
    id,
    label: `registration ${registration.code}`,
    // A new session has nothing of its own, so it keeps its picks however
    // it is named; an existing one is itself.
    destination: onto?.existing ? `${sessionKey}/existing:${onto.session}` : `${sessionKey}/new`,
    own,
  });

  const submit = async (form: HTMLFormElement) => {
    const session = sessionPick(form);
    const found = {
      agent: agentChoice === "new" ? newNameProblem(newAgent, agents, "an agent") : undefined,
      session:
        session.choice === undefined
          ? "Choose the existing session or a new one."
          : session.choice === "new"
            ? newNameProblem(
                session.name,
                agentSessions.map((entry) => entry.session),
                "a session",
              )
            : undefined,
    };
    setProblems(found);
    approve.clear();
    if (found.agent !== undefined || found.session !== undefined || session.choice === undefined) {
      return;
    }
    const input: ApproveInput = {
      agent: { name: agentName, existing: agentChoice === "existing" },
      session: {
        name: session.name,
        existing: session.choice === "existing",
        ...organize.picked,
      },
    };
    const result = await approve.run((csrf) =>
      request<RegistrationResult>("POST", `/registrations/${registration.id}/approve`, {
        csrf,
        body: input,
      }),
    );
    if (result !== undefined) {
      onApproved();
    }
  };

  // The server names the field at fault as agent.name or session.name.
  const failure = approve.failure;
  const serverField = failure instanceof ApiFailure ? (failure.field ?? "") : "";
  const agentError =
    problems.agent ?? (serverField.startsWith("agent") ? describeFailure(failure) : undefined);
  const sessionError =
    problems.session ?? (serverField.startsWith("session") ? describeFailure(failure) : undefined);
  const formFailure = agentError === undefined && sessionError === undefined ? failure : undefined;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit(event.currentTarget);
      }}
      noValidate
    >
      <fieldset>
        <legend>Agent</legend>
        {agents.length > 0 && (
          <div className="choice">
            <label className="check">
              <input
                type="radio"
                name={`${id}-agent`}
                checked={agentChoice === "existing"}
                onChange={() => setPickedChoice("existing")}
              />
              An existing agent
            </label>
            <select
              aria-label="Existing agent"
              value={existingAgent}
              disabled={agentChoice !== "existing"}
              onChange={(event) => {
                setPickedChoice("existing");
                setPickedAgent(event.target.value);
              }}
            >
              {agents.map((agent) => (
                <option key={agent}>{agent}</option>
              ))}
            </select>
          </div>
        )}
        {truncated && <LeftOut items="agents" />}
        <div className="choice">
          <label className="check">
            <input
              type="radio"
              name={`${id}-agent`}
              checked={agentChoice === "new"}
              onChange={() => setPickedChoice("new")}
            />
            A new agent
          </label>
          <input
            aria-label="New agent name"
            value={newAgent}
            disabled={agentChoice !== "new"}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={63}
            aria-invalid={agentChoice === "new" && agentError !== undefined ? true : undefined}
            aria-describedby={describedBy(id, agentError, `${id}-agent-error`)}
            onChange={(event) => {
              setPickedChoice("new");
              setNewAgent(event.target.value);
            }}
          />
        </div>
        {agentError !== undefined && (
          <p id={`${id}-agent-error`} className="field-error">
            {agentError}
          </p>
        )}
      </fieldset>
      <SessionFields
        // Another agent starts the session choice over.
        key={sessionKey}
        id={id}
        agentName={agentName}
        sessions={agentSessions}
        truncated={held?.truncated === true}
        proposed={registration.proposed_session}
        error={sessionError}
        onTarget={(destination) => setOnto({ key: sessionKey, ...destination })}
      />
      <p className="hint" id={`${id}-name-hint`}>
        Names are 1 to 63 of a-z, 0-9, _ and -, starting with a letter or digit.
      </p>
      {organize.fields}
      <Failure failure={formFailure} />
      <div className="actions">
        <button type="submit" disabled={approve.pending}>
          Approve
        </button>
      </div>
    </form>
  );
}

// SessionFields chooses the session to grant among one agent's sessions, by
// name, saying when the list left some of them out; the form reads the choice
// from its fields when it is sent, and onTarget says which session is
// chosen, new or existing, by its name, as it changes. When the agent
// already has the proposed session, the choice starts undecided: approving
// onto an existing session gives the credential its whole history, so that is
// never chosen for the operator.
function SessionFields({
  id,
  agentName,
  sessions,
  truncated,
  proposed,
  error,
  onTarget,
}: {
  id: string;
  agentName: string;
  sessions: Agents[number]["sessions"];
  truncated: boolean;
  proposed: string;
  error: string | undefined;
  onTarget: (destination: Destination) => void;
}) {
  const byName = [...sessions].sort((a, b) =>
    a.session < b.session ? -1 : a.session > b.session ? 1 : 0,
  );
  const names = byName.map((entry) => entry.session);
  const exists = names.includes(proposed);
  const [choice, setChoice] = useState<Choice | undefined>(
    names.length === 0 || !exists ? "new" : undefined,
  );
  const [existing, setExisting] = useState(exists ? proposed : (names[0] ?? ""));
  const [fresh, setFresh] = useState(exists ? "" : proposed);

  return (
    <fieldset>
      <legend>Session</legend>
      {names.length > 0 && (
        <div className="choice">
          <label className="check">
            <input
              type="radio"
              name="session-choice"
              value="existing"
              checked={choice === "existing"}
              onChange={() => {
                setChoice("existing");
                onTarget({ existing: true, session: existing });
              }}
            />
            An existing session of {agentName}
          </label>
          <select
            aria-label="Existing session"
            name="existing-session"
            value={existing}
            disabled={choice !== "existing"}
            onChange={(event) => {
              setExisting(event.target.value);
              onTarget({ existing: true, session: event.target.value });
            }}
          >
            {byName.map((entry) => (
              <option key={entry.session} value={entry.session}>
                {entry.session}
                {entry.registrations.length > 0 ? "" : " (no active credential)"}
              </option>
            ))}
          </select>
        </div>
      )}
      {truncated && <LeftOut items={`sessions of ${agentName}`} />}
      <div className="choice">
        <label className="check">
          <input
            type="radio"
            name="session-choice"
            value="new"
            checked={choice === "new"}
            onChange={() => {
              setChoice("new");
              onTarget({ existing: false, session: fresh });
            }}
          />
          A new session
        </label>
        <input
          aria-label="New session name"
          name="new-session"
          value={fresh}
          disabled={choice !== "new"}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={63}
          aria-invalid={choice === "new" && error !== undefined ? true : undefined}
          aria-describedby={describedBy(id, error, `${id}-session-error`)}
          onChange={(event) => {
            setFresh(event.target.value);
            onTarget({ existing: false, session: event.target.value });
          }}
        />
      </div>
      {choice === "existing" && (
        <p className="notice warning">
          The credential will see this session's whole history and act as it. Approve onto an
          existing session only to replace a credential the agent lost.
        </p>
      )}
      {error !== undefined && (
        <p id={`${id}-session-error`} className="field-error">
          {error}
        </p>
      )}
    </fieldset>
  );
}

// The tone of each decided status that has one.
const statusTone: Partial<Record<Registration["status"], string>> = {
  approved: "success",
  revoked: "danger",
  rejected: "danger",
};

export function DecidedRegistration({
  registration,
  onDecided,
}: {
  registration: Registration;
  onDecided: () => void;
}) {
  const opener = useRef<HTMLButtonElement>(null);
  const [revoking, setRevoking] = useState(false);
  const granted = registration.granted;
  const grantedName = granted === undefined ? undefined : `${granted.agent}/${granted.session}`;
  // Each time is its own event's: approval and rejection at decided_at,
  // revocation at revoked_at, expiry at expires_at.
  const on = (time: string | undefined) => (time === undefined ? "" : ` on ${absoluteTime(time)}`);
  const approved = `Approved as ${grantedName ?? "?"}${on(registration.decided_at)}`;
  let summary: string;
  switch (registration.status) {
    case "approved":
      summary = `${approved}.`;
      break;
    case "revoked":
      summary = `${approved}, and revoked${on(registration.revoked_at)}.`;
      break;
    case "rejected":
      summary = `Rejected${on(registration.decided_at)}.`;
      break;
    case "expired":
      summary = `Expired${on(registration.expires_at)} before it was approved.`;
      break;
    case "pending":
      summary = "Waiting for approval.";
      break;
  }
  const tone = statusTone[registration.status];
  return (
    <article className="registration" aria-label={`Registration ${registration.code}`}>
      <p className="registration-head">
        <span className="code small">{registration.code}</span>
        <span className={tone === undefined ? "state" : `state ${tone}`}>
          {registration.status}
        </span>
      </p>
      <p>
        {summary} Proposed as {registration.proposed_agent}/{registration.proposed_session}.
      </p>
      {granted !== undefined && !granted.credential_active && (
        <p className="muted">{grantedName} has no active credential.</p>
      )}
      {registration.status === "approved" && !revoking && (
        <button ref={opener} type="button" className="secondary" onClick={() => setRevoking(true)}>
          Revoke
        </button>
      )}
      <Revocation
        asking={
          revoking
            ? {
                id: registration.id,
                code: registration.code,
                session: grantedName ?? "Its session",
              }
            : undefined
        }
        stop={() => setRevoking(false)}
        opener={opener}
        onRevoked={onDecided}
      />
    </article>
  );
}

// A credential as revoking it names it: its registration's id and code, and
// the session it acts as, as "builder/main".
export interface Credential {
  id: number;
  code: string;
  session: string;
}

// Revocation revokes a credential once the operator confirms it, wherever
// they asked from, a session's options or its past request: it asks once
// more, naming the credential and its session, says once it is revoked or
// why it was not, and reloads the view. asking is the credential it asks
// about, while it asks. Once the question is answered, focus returns to
// opener, the control the operator asked from, as it stands then.
export function Revocation({
  asking,
  stop,
  opener,
  onRevoked,
}: {
  asking: Credential | undefined;
  stop: () => void;
  opener: RefObject<HTMLElement | null>;
  onRevoked: () => void;
}) {
  const revoke = useAction();
  const [said, say] = useState("");
  // Whether focus returns to the opener once the question goes.
  const answered = useRef(false);
  useLayoutEffect(() => {
    if (asking === undefined && answered.current) {
      answered.current = false;
      opener.current?.focus({ preventScroll: true });
    }
  }, [asking, opener]);
  const done = () => {
    answered.current = true;
    stop();
  };
  return (
    <>
      {asking !== undefined && (
        <Confirmation
          question={`Revoke the credential ${asking.code}? ${asking.session} keeps its threads, but this key stops working at once.`}
          confirmLabel="Revoke credential"
          disabled={revoke.pending}
          onCancel={done}
          onConfirm={async () => {
            say("");
            const result = await revoke.run((csrf) =>
              request<RegistrationResult>("POST", `/registrations/${asking.id}/revoke`, { csrf }),
            );
            done();
            if (result !== undefined) {
              say(`Revoked ${asking.code}.`);
            }
            onRevoked();
          }}
        />
      )}
      <Failure failure={revoke.failure} />
      {said !== "" && <Status>{said}</Status>}
    </>
  );
}
