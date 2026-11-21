import type { Registration, SessionSummary } from "@wayfarerlabs/agention-api";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { type AgentList, type Agents, listSessions } from "../api.ts";
import {
  Fold,
  LeftOut,
  Loadable,
  MoreButton,
  PageHeading,
  PathParts,
  usePageTitle,
} from "../components.tsx";
import { usePages, useResource } from "../data.ts";
import { useFolds } from "../device.ts";
import { plural } from "../format.tsx";
import { Mark } from "../icons.tsx";
import { NewThreadSheet } from "./sessions/NewThreadSheet.tsx";
import {
  DecidedRegistration,
  loadRegistrations,
  PendingRegistration,
} from "./sessions/Registrations.tsx";
import { SessionRow, sessionKey } from "./sessions/SessionRow.tsx";

// The sessions view: every session the operator's agents run, in one view.
// Top to bottom: the registrations waiting for approval; each agent under a
// header that folds, rolling up its sessions' open asks, unread updates and
// stranded threads, over a folded row for each of its sessions; and,
// folded, the credentials and past requests. It refreshes as every view
// does. This browser keeps the agents it folds and whether the past requests
// are shown; a session's row starts folded on every visit. What a fold hides
// is not loaded, so a session's log loads and is read only while its row is
// unfolded under an unfolded agent.

// Where this browser keeps its folds: the agents folded, and the sections
// unfolded.
const foldedAgents = "agention.sessions.folded-agents";
const unfoldedSections = "agention.sessions.unfolded-sections";
const pastRequests = "past-requests";

export function Sessions() {
  usePageTitle("Sessions");
  const pending = usePages<Registration>(loadRegistrations("pending"));
  const sessions = useResource<AgentList>(listSessions);
  // Each decision or read the view makes reloads it, the past requests too
  // while they are shown.
  const [changes, changed] = useReducer((count: number) => count + 1, 0);
  const { refresh: refreshPending } = pending;
  const { refresh: refreshSessions } = sessions;
  const refresh = useCallback(() => {
    refreshPending();
    refreshSessions();
    changed();
  }, [refreshPending, refreshSessions]);
  const sections = useFolds(unfoldedSections);
  // The session the new-thread sheet is open on, as it was when it opened,
  // and the control focus returns to when it closes. The sheet follows the
  // session as the view refreshes.
  const [writing, setWriting] = useState<{
    agent: string;
    session: SessionSummary;
    opener: HTMLElement | null;
  }>();
  const writingOn =
    writing === undefined
      ? undefined
      : (sessions.data?.agents
          .find((entry) => entry.agent === writing.agent)
          ?.sessions.find((session) => session.session === writing.session.session) ??
        writing.session);
  return (
    <>
      <PageHeading visuallyHidden>Sessions</PageHeading>
      <section aria-labelledby="pending-heading">
        <h2 id="pending-heading">Waiting for approval</h2>
        <Loadable data={pending.data} failure={pending.failure} retry={pending.refresh}>
          {({ rows, next }) => (
            <>
              {rows.length === 0 ? (
                <p className="empty">
                  No registration is waiting. When an agent registers, it shows a code to relay to
                  you, and its registration appears here.
                </p>
              ) : (
                <ul className="registrations">
                  {rows.map((registration) => (
                    <li key={registration.id}>
                      <PendingRegistration
                        registration={registration}
                        agents={sessions}
                        onDecided={refresh}
                      />
                    </li>
                  ))}
                </ul>
              )}
              <MoreButton next={next} loading={pending.loading} more={pending.more} />
            </>
          )}
        </Loadable>
      </section>
      <section aria-labelledby="agents-heading">
        <h2 id="agents-heading">Agents</h2>
        <Loadable data={sessions.data} failure={sessions.failure} retry={sessions.refresh}>
          {({ agents, truncated }) =>
            agents.length === 0 ? (
              <p className="empty">
                No agent has a session yet. Once you approve a registration, its agent and session
                appear here.
              </p>
            ) : (
              <>
                <AgentFolds
                  agents={agents}
                  refresh={refresh}
                  newThread={(agent, session, opener) => setWriting({ agent, session, opener })}
                />
                {truncated && <LeftOut items="agents" />}
              </>
            )
          }
        </Loadable>
      </section>
      <Fold
        level={2}
        depth="outer"
        label="Credentials and past requests"
        folded={!sections.has(pastRequests)}
        toggle={() => sections.toggle(pastRequests)}
      >
        <PastRequests changes={changes} refresh={refresh} />
      </Fold>
      {writing !== undefined && writingOn !== undefined && (
        <NewThreadSheet
          agent={writing.agent}
          session={writingOn}
          onClose={() => {
            setWriting(undefined);
            writing.opener?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}

// AgentFolds shows each agent under its header, its sessions' rows beneath.
// This browser keeps the agents it folds; the rows unfolded hold only while
// the view is open.
function AgentFolds({
  agents,
  refresh,
  newThread,
}: {
  agents: Agents;
  refresh: () => void;
  newThread: (agent: string, session: SessionSummary, opener: HTMLElement | null) => void;
}) {
  const folds = useFolds(foldedAgents);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const flip = (key: string) =>
    setUnfolded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });
  return agents.map((entry) => {
    const { asks, unread, stranded } = rollupOf(entry);
    const sessions = plural(entry.sessions.length, "session");
    return (
      <Fold
        key={entry.agent}
        level={3}
        depth="outer"
        label={<PathParts place={[["agent", entry.agent]]} />}
        marks={
          <span className="roll-up" aria-hidden="true">
            <span className="roll-up-count">{sessions}</span>
            {asks > 0 && <span className="flag attention">{plural(asks, "ask")}</span>}
            {unread > 0 && (
              <Mark icon="unread" label={plural(unread, "unread update")} shown={unread} accent />
            )}
            {stranded > 0 && <span className="flag warning">{stranded} stranded</span>}
          </span>
        }
        spoken={[
          `Agent ${entry.agent}`,
          entry.truncated ? `more than ${sessions}` : sessions,
          ...(asks > 0 ? [plural(asks, "open ask")] : []),
          ...(unread > 0 ? [plural(unread, "unread update")] : []),
          ...(stranded > 0 ? [plural(stranded, "stranded thread")] : []),
        ].join(", ")}
        folded={folds.has(entry.agent)}
        toggle={() => folds.toggle(entry.agent)}
      >
        <ul className="session-rows">
          {entry.sessions.map((session) => {
            const key = sessionKey(entry.agent, session.session);
            return (
              <SessionRow
                key={key}
                agent={entry.agent}
                session={session}
                unfolded={unfolded.has(key)}
                toggle={() => flip(key)}
                refresh={refresh}
                newThread={(opener) => newThread(entry.agent, session, opener)}
              />
            );
          })}
        </ul>
        {entry.truncated && <LeftOut items={`sessions of ${entry.agent}`} />}
      </Fold>
    );
  });
}

// rollupOf adds up what an agent's sessions the view lists hold: their open
// asks, unread updates and stranded threads.
function rollupOf(entry: Agents[number]) {
  const sum = (count: (session: SessionSummary) => number) =>
    entry.sessions.reduce((total, session) => total + count(session), 0);
  return {
    asks: sum((session) => session.open_asks.count),
    unread: sum((session) => session.unread_updates),
    stranded: sum((session) => session.threads.stranded),
  };
}

// PastRequests lists the registrations already decided, loading them only
// while shown. A change the view makes elsewhere, which may decide one, as
// approving or revoking does, reloads them at once.
function PastRequests({ changes, refresh }: { changes: number; refresh: () => void }) {
  const all = usePages<Registration>(loadRegistrations(undefined));
  const { refresh: reload } = all;
  const seen = useRef(changes);
  useEffect(() => {
    if (changes !== seen.current) {
      seen.current = changes;
      reload();
    }
  }, [changes, reload]);
  return (
    <Loadable data={all.data} failure={all.failure} retry={all.refresh}>
      {({ rows, next }) => {
        const decided = rows.filter((registration) => registration.status !== "pending");
        return (
          <>
            {decided.length === 0 ? (
              <p className="empty">No registration has been decided yet.</p>
            ) : (
              <ul className="registrations">
                {decided.map((registration) => (
                  <li key={registration.id}>
                    <DecidedRegistration registration={registration} onDecided={refresh} />
                  </li>
                ))}
              </ul>
            )}
            <MoreButton next={next} loading={all.loading} more={all.more} />
          </>
        );
      }}
    </Loadable>
  );
}
