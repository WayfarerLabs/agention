import {
  type ApproveInput,
  namePattern,
  type Registration,
  type RegistrationResult,
} from "@wayfarerlabs/agention-api";
import { useId, useState } from "react";
import { type AgentList, type Agents, ApiFailure, describeFailure, request } from "../../api.ts";
import { ConfirmButton, Failure, LeftOut } from "../../components.tsx";
import { type Action, useAction } from "../../data.ts";
import { useOrganize } from "./Organize.tsx";

// The approval of a registration waiting, on its page: which agent and which
// session it grants, matched against those the sessions view lists, the
// session's group and tags, and Approve and Reject.

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
    ? `There is already ${kind} named ${value}; choose it instead.`
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

// unusedName gives a name for a new session beside one the agent has, such
// as "main-2", the first of them the agent has not, cut to fit a name.
function unusedName(name: string, taken: string[]): string {
  for (let count = 2; ; count++) {
    const suffix = `-${count}`;
    const candidate = `${name.slice(0, 63 - suffix.length)}${suffix}`;
    if (!taken.includes(candidate)) {
      return candidate;
    }
  }
}

// ApproveForm decides a pending registration, approving or rejecting it.
// Approve grants an agent and a session, each either an existing one or a
// new one, under the proposed names or others, and the session's group and
// tags when the operator picks them, which the approval applies with the
// grant. A group picked new is created as it is picked, since an approval
// names its group by id. What is not picked stays as it is: none for a new
// session, and an existing session's own, which the pickers start from once
// it is chosen; choosing another session starts the picks over. The group
// and tags come first, then what Approve grants, the proposed names unless
// changed; the choice of another agent or session, or other names, stays
// folded under a button until wanted, or while a name is refused. Approving
// onto an existing session warns of its history beside Approve.
//
// When the agent has the proposed session, as when an agent that lost its
// credential registers again, Approve does not choose for the operator:
// after the group and tags, which start from that session's own, a warning
// of its history and the new session's name, which the operator may change,
// then two buttons in place of Approve, one granting the session the agent
// has and one a new session, each with the group and tags as shown. Opening
// the other choices leaves the choice to them.
//
// The form needs the agents and their sessions, the view's list of them,
// once loaded, for all but Reject. Approve and Reject cannot be sent while
// either is under way: a decision made stays under way until onDecided,
// which reloads the view, has settled, while a refused one ends as it is
// refused, the view reloading after it. onDecided gets the registration as
// it now stands once decided, or undefined when refused.
export function ApproveForm({
  registration,
  agents,
  onDecided,
}: {
  registration: Registration;
  agents: AgentList | undefined;
  onDecided: (decided: Registration | undefined) => Promise<void>;
}) {
  const id = useId();
  const proposed = registration.proposed_agent;
  const directory = agents?.agents ?? [];
  const names = directory.map((entry) => entry.agent);
  // What the operator picked, if anything; otherwise the proposed agent when
  // it exists. The list can change under the form, so the agent shown and the
  // one sent are both worked out from it here. Typing a name or picking an
  // agent counts as picking.
  const [pickedChoice, setPickedChoice] = useState<Choice>();
  const [pickedAgent, setPickedAgent] = useState<string>();
  const agentChoice =
    names.length === 0 ? "new" : (pickedChoice ?? (names.includes(proposed) ? "existing" : "new"));
  const existingAgent =
    pickedAgent !== undefined && names.includes(pickedAgent)
      ? pickedAgent
      : names.includes(proposed)
        ? proposed
        : (names[0] ?? "");
  const [newAgent, setNewAgent] = useState(proposed);
  const agentName = agentChoice === "existing" ? existingAgent : newAgent;
  const held =
    agentChoice === "existing" ? directory.find((entry) => entry.agent === agentName) : undefined;
  const agentSessions = held?.sessions ?? [];
  const sessionNames = agentSessions.map((entry) => entry.session);
  const [problems, setProblems] = useState<{
    agent?: string | undefined;
    session?: string | undefined;
  }>({});
  const approve = useAction();
  const reject = useAction();
  const deciding = approve.pending || reject.pending;
  // The session chosen to approve onto, new or existing, as SessionFields
  // says once it changes, under the agent it was chosen for, which another
  // agent starts over, as it does SessionFields.
  const sessionKey = `${agentChoice}:${agentName}`;
  const [onto, setOnto] = useState<{ key: string } & Destination>();
  if (onto !== undefined && onto.key !== sessionKey) {
    setOnto(undefined);
  }
  // The session Approve grants: the one chosen, once the operator chose, or
  // else the proposed one, new, unless the agent has it, which leaves it to
  // choose.
  const proposedExists = sessionNames.includes(registration.proposed_session);
  const target: Destination | undefined =
    onto ??
    (proposedExists ? undefined : { existing: false, session: registration.proposed_session });
  // The session the pickers start from: the existing one chosen, or, while
  // the agent has the proposed one and none is chosen, that one.
  const ownName =
    target === undefined
      ? registration.proposed_session
      : target.existing
        ? target.session
        : undefined;
  const own = agentSessions.find((entry) => entry.session === ownName);
  // The other choices show while the operator wants them, and from when a
  // name in them was refused, which they cannot fold until it is settled.
  const [changing, setChanging] = useState(false);
  const organize = useOrganize({
    id,
    label: `registration ${registration.code}`,
    // A new session has nothing of its own, so it keeps its picks however
    // it is named; an existing one is itself.
    destination: {
      agent: sessionKey,
      session:
        target === undefined ? undefined : target.existing ? `existing:${target.session}` : "new",
    },
    own,
    hint:
      target === undefined
        ? changing
          ? `They start from ${agentName}/${registration.proposed_session}'s own until you choose a session below.`
          : `They start from ${agentName}/${registration.proposed_session}'s own, and either button below gives the session it approves the group and tags shown here.`
        : "A new session starts with none, and an existing one keeps its own unless changed here.",
  });
  // The name of a new session, which the two buttons and the other choices
  // share: the operator's once typed, and until then the proposed one, or
  // one the agent has not when it has that.
  const [typedFresh, setTypedFresh] = useState<string>();
  const fresh =
    typedFresh ??
    (proposedExists
      ? unusedName(registration.proposed_session, sessionNames)
      : registration.proposed_session);
  // Whether the two buttons decide, the session undecided and the other
  // choices folded, and which of them sent the approval last.
  const buttonsDecide = target === undefined && !changing;
  const [sentOntoProposed, setSentOntoProposed] = useState(false);

  // decide sends the approval or the rejection, which, once made, stays
  // under way until the view has reloaded after it; a refusal ends it at
  // once, and the view reloads after it too.
  const decide = async (action: Action, how: "approve" | "reject", body?: ApproveInput) => {
    const decided = await action.run(async (csrf) => {
      const answer = await request<RegistrationResult>(
        "POST",
        `/registrations/${registration.id}/${how}`,
        body === undefined ? { csrf } : { csrf, body },
      );
      await onDecided(answer.registration);
      return answer;
    });
    if (decided === undefined) {
      await onDecided(undefined);
    }
  };

  const submit = async (form: HTMLFormElement, ontoProposed: boolean) => {
    const session: { choice: Choice | undefined; name: string } = buttonsDecide
      ? ontoProposed
        ? { choice: "existing", name: registration.proposed_session }
        : { choice: "new", name: fresh }
      : sessionPick(form);
    const found = {
      agent: agentChoice === "new" ? newNameProblem(newAgent, names, "an agent") : undefined,
      session:
        session.choice === undefined
          ? "Choose the existing session or a new one."
          : session.choice === "new"
            ? newNameProblem(session.name, sessionNames, "a session")
            : undefined,
    };
    setProblems(found);
    setSentOntoProposed(buttonsDecide && ontoProposed);
    approve.clear();
    reject.clear();
    if (found.agent !== undefined || found.session !== undefined || session.choice === undefined) {
      return;
    }
    const input: ApproveInput = {
      agent: { name: agentName, existing: agentChoice === "existing" },
      session: {
        name: session.name,
        existing: session.choice === "existing",
        // Either button sends the group and tags as shown, which started from
        // the session the agent has, so what the operator saw is what the
        // session approved gets.
        ...(buttonsDecide ? organize.shown : organize.picked),
      },
    };
    await decide(approve, "approve", input);
  };

  // The server names the field at fault as agent.name or session.name; a
  // refusal of the session the operator approved onto by its button has no
  // field to show by, so it shows as the form's.
  const failure = approve.failure;
  const serverField = failure instanceof ApiFailure ? (failure.field ?? "") : "";
  const agentError =
    problems.agent ?? (serverField.startsWith("agent") ? describeFailure(failure) : undefined);
  const sessionError =
    problems.session ??
    (serverField.startsWith("session") && !sentOntoProposed ? describeFailure(failure) : undefined);
  const formFailure = agentError === undefined && sessionError === undefined ? failure : undefined;
  const forced = agentError !== undefined || (!buttonsDecide && sessionError !== undefined);
  if (forced && !changing) {
    setChanging(true);
  }
  const grantWords = target?.existing
    ? "an existing session"
    : agentChoice === "new"
      ? "a new agent and session"
      : "a new session";

  const rejection = (
    <ConfirmButton
      label="Reject"
      confirmLabel="Reject registration"
      question={`Reject the registration with code ${registration.code}?`}
      disabled={deciding}
      onConfirm={() => {
        approve.clear();
        void decide(reject, "reject");
      }}
    />
  );
  const historyWarning = (session: string) => (
    <p className="notice warning history">
      Approved as {agentName}/{session}, the new key sees its whole history and acts as it. Approve
      onto it only to replace a credential the agent lost.
    </p>
  );
  const failures = (
    <>
      <Failure failure={formFailure} />
      <Failure failure={reject.failure} />
    </>
  );
  if (agents === undefined) {
    return (
      <>
        {failures}
        <div className="actions">{rejection}</div>
      </>
    );
  }
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit(event.currentTarget, false);
      }}
      noValidate
    >
      {organize.fields}
      {buttonsDecide && (
        <div className="decision">
          {historyWarning(registration.proposed_session)}
          <div className="choice">
            <label htmlFor={`${id}-fresh`}>New session name</label>
            <input
              id={`${id}-fresh`}
              value={fresh}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={63}
              aria-invalid={sessionError === undefined ? undefined : true}
              aria-describedby={describedBy(id, sessionError, `${id}-fresh-error`)}
              onChange={(event) => setTypedFresh(event.target.value)}
            />
          </div>
          {sessionError !== undefined && (
            <p id={`${id}-fresh-error`} className="field-error">
              {sessionError}
            </p>
          )}
        </div>
      )}
      <div className="approve-as">
        {target !== undefined && (
          <p>
            Approve grants{" "}
            <strong>
              {agentName}/{target.session}
            </strong>
            , {grantWords}.
          </p>
        )}
        {target === undefined && (
          <p>
            Approve grants{" "}
            {changing ? (
              "the session you choose"
            ) : (
              <>
                <strong>
                  {agentName}/{registration.proposed_session}
                </strong>
                , the session it has, or a new session
              </>
            )}
            .
          </p>
        )}
        {!forced && (
          <button
            type="button"
            className="secondary"
            aria-expanded={changing}
            aria-controls={`${id}-choices`}
            onClick={() => {
              setChanging(!changing);
              setProblems({});
              approve.clear();
            }}
          >
            Change agent or session
          </button>
        )}
      </div>
      <div id={`${id}-choices`} hidden={!changing}>
        <fieldset>
          <legend>Agent</legend>
          {names.length > 0 && (
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
                {names.map((agent) => (
                  <option key={agent}>{agent}</option>
                ))}
              </select>
            </div>
          )}
          {agents.truncated && <LeftOut items="agents" />}
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
          error={buttonsDecide ? undefined : sessionError}
          fresh={fresh}
          onFresh={setTypedFresh}
          onTarget={(destination) => setOnto({ key: sessionKey, ...destination })}
        />
        <p className="hint" id={`${id}-name-hint`}>
          Names are 1 to 63 of a-z, 0-9, _ and -, starting with a letter or digit.
        </p>
      </div>
      {target?.existing === true && historyWarning(target.session)}
      {failures}
      <div className="actions">
        {buttonsDecide ? (
          <>
            <button
              type="button"
              className="secondary"
              disabled={deciding}
              onClick={(event) => {
                const form = event.currentTarget.form;
                if (form !== null) {
                  void submit(form, true);
                }
              }}
            >
              Approve as {agentName}/{registration.proposed_session}
            </button>
            {/* The form's own button, which Enter in a field presses, grants
                a new session, so Enter never approves onto the one there is. */}
            <button type="submit" disabled={deciding}>
              Approve as a new session
            </button>
            {rejection}
          </>
        ) : (
          <>
            <button type="submit" disabled={deciding}>
              Approve
            </button>
            {rejection}
          </>
        )}
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
  fresh,
  onFresh,
  onTarget,
}: {
  id: string;
  agentName: string;
  sessions: Agents[number]["sessions"];
  truncated: boolean;
  proposed: string;
  error: string | undefined;
  // The new session's name, which the form holds.
  fresh: string;
  onFresh: (name: string) => void;
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
            onFresh(event.target.value);
            onTarget({ existing: false, session: event.target.value });
          }}
        />
      </div>
      {error !== undefined && (
        <p id={`${id}-session-error`} className="field-error">
          {error}
        </p>
      )}
    </fieldset>
  );
}
