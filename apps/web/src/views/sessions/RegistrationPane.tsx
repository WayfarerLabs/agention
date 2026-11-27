import type { Registration } from "@wayfarerlabs/agention-api";
import type { AgentList } from "../../api.ts";
import { Loadable, PageHeading } from "../../components.tsx";
import type { Resource } from "../../data.ts";
import { Since, Time } from "../../format.tsx";
import { Link, navigate, registrationHref, sessionHref } from "../../router.tsx";
import { useArranged } from "./arrangement.ts";
import { ApproveForm } from "./ApproveForm.tsx";
import { type Proposal, proposalOf, type WaitingList } from "./Registrations.tsx";
import { PaneBar } from "./SessionPane.tsx";
import { sessionKey } from "./SessionRow.tsx";

// RegistrationPane is a registration waiting for approval at its own
// address, /registrations/<id>, beside the sessions' rows at a desktop's
// width and alone on a narrower screen, as a session is: under a heading
// naming the agent and the session it proposes, its code, what it proposes,
// and its approval (PendingRegistration), over the bar a session's page has.
// Each decision, or its refusal, reloads the view, and once that is done, an
// approval goes on to the session it granted, and a rejection back to the
// rows, in the registration's place in the history, unless the operator has
// gone elsewhere since. A registration not waiting, as one decided or
// expired since, says so.
export function RegistrationPane({
  id,
  waiting,
  sessions,
  arranged,
  refresh,
}: {
  id: number;
  waiting: Resource<WaitingList>;
  sessions: Resource<AgentList>;
  // The rows' arrangement, as the address's query.
  arranged: string;
  // Reloads the view, settling once the registrations waiting and the
  // sessions have.
  refresh: () => Promise<unknown>;
}) {
  const onDecided = async (registration: Registration | undefined) => {
    await refresh();
    const { pathname, search } = window.location;
    if (registration === undefined || pathname !== registrationHref(id)) {
      return;
    }
    const { granted } = registration;
    const to =
      registration.status === "approved" && granted !== undefined
        ? sessionHref(granted.agent, granted.session)
        : "/sessions";
    navigate(`${to}${search}`, { replace: true });
  };
  return (
    <article className="session-page">
      <Loadable data={waiting.data} failure={waiting.failure} retry={waiting.refresh}>
        {({ registrations, truncated }) => {
          const registration = registrations.find((each) => each.id === id);
          return registration === undefined ? (
            <>
              <PageHeading>Registration</PageHeading>
              <p className="empty">
                {truncated
                  ? "No registration among those loaded has this address. More wait than the list holds, so it may be one left out, or it may have been approved, rejected or expired since; Credentials and past requests, under the sessions, lists those."
                  : "No registration waiting for approval has this address. It may have been approved, rejected or expired since; Credentials and past requests, under the sessions, lists those."}
              </p>
            </>
          ) : (
            <>
              <PageHeading>
                {sessionKey(registration.proposed_agent, registration.proposed_session)}
              </PageHeading>
              <PendingRegistration
                registration={registration}
                agents={sessions}
                onDecided={onDecided}
              />
            </>
          );
        }}
      </Loadable>
      <PaneBar rows={`/sessions${arranged}`} />
    </article>
  );
}

// PendingRegistration is a registration waiting for approval, on its own
// page: its code, as large as it can be read and compared with the one the
// agent shows; what it proposes, and when it was submitted and expires; and
// its approval and its rejection (ApproveForm), Reject offered while the
// agents are loading or failed to, as rejecting needs none of them.
function PendingRegistration({
  registration,
  agents,
  onDecided,
}: {
  registration: Registration;
  agents: Resource<AgentList>;
  onDecided: (decided: Registration | undefined) => Promise<void>;
}) {
  return (
    <article className="registration-page" aria-label={`Registration ${registration.code}`}>
      {/* The code, grouped as the agent relays it. */}
      <p className="code">{registration.code}</p>
      <p className="notice warning">
        Approve only if this code is the one your agent showed you. A registration with any other
        key shows a different code.
      </p>
      <Loadable data={agents.data} failure={agents.failure} retry={agents.refresh}>
        {({ agents: directory }) => (
          <Proposed registration={registration} proposal={proposalOf(registration, directory)} />
        )}
      </Loadable>
      <ApproveForm registration={registration} agents={agents.data} onDecided={onDecided} />
    </article>
  );
}

// Proposed says what a registration proposes, the agent and the session,
// each new or there already, an existing session leading to its page, with
// when it was last seen and the credentials it has, which approving onto it
// adds to, and when the registration was submitted and when it expires.
function Proposed({ registration, proposal }: { registration: Registration; proposal: Proposal }) {
  const existing = proposal.kind === "existing" ? proposal.session : undefined;
  const codes = existing?.registrations.map((each) => each.code) ?? [];
  const seen = existing?.presence.last_seen_at;
  const arranged = useArranged();
  return (
    <dl className="registration-facts">
      <dt>Agent</dt>
      <dd>
        <span className="code small">{registration.proposed_agent}</span>,{" "}
        {proposal.kind === "new-agent" ? "a new agent" : "an agent you approved before"}
      </dd>
      <dt>Session</dt>
      <dd>
        {existing === undefined ? (
          <span className="code small">{registration.proposed_session}</span>
        ) : (
          // A session there already leads to its page.
          <Link to={`${sessionHref(registration.proposed_agent, existing.session)}${arranged}`}>
            <span className="code small">{existing.session}</span>
          </Link>
        )}
        ,{" "}
        {existing === undefined ? (
          "a new session"
        ) : (
          <>
            a session it has,{" "}
            {seen === undefined ? (
              "never seen"
            ) : (
              <>
                last seen <Since value={seen} />
              </>
            )}
            ,{" "}
            {codes.length === 0 ? (
              "with no active credential"
            ) : (
              <>
                with the credential{codes.length === 1 ? "" : "s"}{" "}
                {codes.map((code, index) => (
                  <span key={code}>
                    {index > 0 && ", "}
                    <span className="code small">{code}</span>
                  </span>
                ))}
              </>
            )}
          </>
        )}
      </dd>
      <dt>Waiting since</dt>
      <dd>
        <Time value={registration.created_at} />
      </dd>
      <dt>Expires</dt>
      <dd>
        <Time value={registration.expires_at} />
      </dd>
    </dl>
  );
}
