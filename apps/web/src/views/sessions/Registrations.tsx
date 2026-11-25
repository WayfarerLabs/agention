import type {
  Registration,
  RegistrationResult,
  RegistrationsPage,
  SessionSummary,
} from "@wayfarerlabs/agention-api";
import { type RefObject, useLayoutEffect, useRef, useState } from "react";
import { type Agents, query, readWhole, request } from "../../api.ts";
import { Confirmation, Failure, Status } from "../../components.tsx";
import { useAction } from "../../data.ts";
import { absoluteTime } from "../../format.tsx";

// The registrations the sessions view shows: those waiting for approval,
// which the operator approves after matching the code the agent relayed
// (ApproveForm.tsx), or rejects, and what each proposes; and those already
// decided, whose credential the operator can revoke.

// loadRegistrations reads a page of the registrations, newest first.
export function loadRegistrations(cursor: string | undefined, signal: AbortSignal) {
  return request<RegistrationsPage>("GET", `/registrations${query({ cursor })}`, {
    signal,
  }).then((page) => ({ rows: page.registrations, next: page.next }));
}

// The registrations waiting for approval, as listWaiting reads them, and
// whether it left any out.
export interface WaitingList {
  registrations: Registration[];
  truncated: boolean;
}

// listWaiting reads the registrations waiting for approval whole, at most
// maxListed of them, as the sessions view shows each as a row of its own.
export async function listWaiting(signal?: AbortSignal): Promise<WaitingList> {
  const { items, truncated } = await readWhole(async (cursor, limit) => {
    const page = await request<RegistrationsPage>(
      "GET",
      `/registrations${query({ status: "pending", cursor, limit })}`,
      { signal },
    );
    return { items: page.registrations, next: page.next };
  });
  return { registrations: items, truncated };
}

// What a registration waiting proposes, as the agents the view lists hold
// it: a new agent, a new session of an agent there is, or a session there
// is, as when an agent that lost its credential registers again.
export type Proposal =
  { kind: "new-agent" } | { kind: "new-session" } | { kind: "existing"; session: SessionSummary };

export function proposalOf(registration: Registration, agents: Agents): Proposal {
  const agent = agents.find((entry) => entry.agent === registration.proposed_agent);
  const session = agent?.sessions.find((each) => each.session === registration.proposed_session);
  return agent === undefined
    ? { kind: "new-agent" }
    : session === undefined
      ? { kind: "new-session" }
      : { kind: "existing", session };
}

// Each proposal in a chip's words.
export const proposalWords: Record<Proposal["kind"], string> = {
  "new-agent": "New agent",
  "new-session": "New session",
  existing: "Existing session",
};

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
