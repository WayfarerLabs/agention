import type { Registration, SessionSummary } from "@wayfarerlabs/agention-server-api";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { type AgentList, describeFailure, listSessions } from "../api.ts";
import { Fold, LeftOut, Loadable, MoreButton, PageHeading, usePageTitle } from "../components.tsx";
import { usePages, useResource } from "../data.ts";
import { useFolds } from "../device.ts";
import { loadGroupsAndTags, PaletteProvider } from "../organizing.tsx";
import { navigate, useLocation } from "../router.tsx";
import { type SessionsView, sessionsQuery, sessionsViewOf } from "./sessions/arrangement.ts";
import { SessionGroupPicker, TagsSetter } from "./sessions/GroupsAndTags.tsx";
import { NewThreadSheet } from "./sessions/NewThreadSheet.tsx";
import {
  DecidedRegistration,
  loadRegistrations,
  PendingRegistration,
} from "./sessions/Registrations.tsx";
import { type Organizing, SessionFolds, SessionsHead } from "./sessions/SessionFolds.tsx";

// The sessions view: every session the operator's agents run, in one view.
// Top to bottom: the registrations waiting for approval, their section one
// muted line while none waits, or explaining how one arrives until some
// agent has a session; the agents and their sessions, under a head choosing
// how they are grouped and sorted (sessions/arrangement.ts), as the thread
// list's head does, which the address keeps; and, folded, the credentials
// and past requests. By default, once some session is in a group, the agents
// fold under their groups, in the operator's order, which each group's head
// moves, and no group last, an agent with sessions in two groups coming
// under each with that group's sessions alone; until then, and grouped by
// agent, each agent folds under its header, rolling up its sessions'
// threads, open asks, unread updates and stranded threads, with links to its
// threads and its stranded threads, its tags and a menu setting them, over a
// folded row for each of its sessions; grouped by session, the rows stand
// alone. Every chip that stands for threads, the names of groups, agents and
// sessions among them, links to those threads on the thread list, and
// following one never folds anything; a header's chevron folds it, as a
// click on the rest of its bar does. The view reads every session before it
// shows any, so it arranges them whole. It refreshes as every view does. The
// operator's groups and tags load beside the sessions, for their colors and
// the groups' order; a session's group and an agent's or a session's tags
// are picked from their options menus, each pick applied at once. This
// browser keeps the groups and agents it folds and whether the past requests
// are shown; a session's row starts folded on every visit. What a fold hides
// is not loaded, so a session's log loads and is read only while its row is
// unfolded and shown.

// Where this browser keeps its folds: the groups and agents folded, and the
// sections unfolded.
const unfoldedSections = "agention.sessions.unfolded-sections";
const pastRequests = "past-requests";

export function Sessions() {
  usePageTitle("Sessions");
  // How the view arranges the sessions, which lives in the address.
  // Choosing another arrangement replaces the address, so going back leaves
  // the view rather than stepping through every choice.
  const location = useLocation();
  const view = sessionsViewOf(location.searchParams);
  const choose = (next: SessionsView) =>
    navigate(`${location.pathname}${sessionsQuery(next)}`, { replace: true });
  const pending = usePages<Registration>(loadRegistrations("pending"));
  const sessions = useResource<AgentList>(listSessions);
  // Each decision or read the view makes reloads it, and the past requests
  // too.
  const [changes, changed] = useReducer((count: number) => count + 1, 0);
  // The operator's groups and tags, for their colors and the groups' order,
  // which a change to a session's group or tags can add to.
  const known = useResource(loadGroupsAndTags);
  const { refresh: refreshPending } = pending;
  const { refresh: refreshSessions } = sessions;
  const { refresh: refreshKnown } = known;
  const refresh = useCallback(() => {
    refreshPending();
    refreshSessions();
    refreshKnown();
    changed();
  }, [refreshPending, refreshSessions, refreshKnown]);
  const organized = () => {
    refreshSessions();
    refreshKnown();
  };
  const sections = useFolds(unfoldedSections);
  // The session the new-thread sheet is open on, as it was when it opened,
  // and the control focus returns to when it closes. The sheet follows the
  // session as the view refreshes.
  const [writing, setWriting] = useState<{
    agent: string;
    session: SessionSummary;
    opener: HTMLElement | null;
  }>();
  const [organizing, setOrganizing] = useState<Organizing>();
  const doneOrganizing = () => {
    setOrganizing(undefined);
    organizing?.opener?.focus({ preventScroll: true });
  };
  const writingOn =
    writing === undefined
      ? undefined
      : (sessions.data?.agents
          .find((entry) => entry.agent === writing.agent)
          ?.sessions.find((session) => session.session === writing.session.session) ??
        writing.session);
  // Until some agent has a session, the empty section explains how a
  // registration arrives. Otherwise, while none waits or the list is still
  // loading, and it has not failed, the section is one line, the loading
  // line until the list arrives and then one saying what the heading
  // would, so the heading is left to screen readers and the top of the
  // view keeps still from the first paint.
  const firstRun = sessions.data?.agents.length === 0;
  const quiet =
    (pending.data?.rows.length ?? 0) === 0 && pending.failure === undefined && !firstRun;
  return (
    <PaletteProvider known={known.data}>
      <PageHeading visuallyHidden>Sessions</PageHeading>
      <section aria-labelledby="pending-heading">
        <h2 id="pending-heading" className={quiet ? "visually-hidden" : undefined}>
          Waiting for approval
        </h2>
        <Loadable data={pending.data} failure={pending.failure} retry={pending.refresh}>
          {({ rows, next }) => (
            <>
              {rows.length === 0 ? (
                firstRun ? (
                  <p className="empty">
                    No registration is waiting. When an agent registers, it shows a code to relay to
                    you, and its registration appears here.
                  </p>
                ) : (
                  <p className="muted">None waiting for approval.</p>
                )
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
                <SessionsHead view={view} choose={choose} />
                {/* The groups and tags color the view and give the groups'
                    order, so a failed load of them says so, with a retry. */}
                {known.failure !== undefined && (
                  <div className="notice danger" role="alert">
                    <p>
                      Your groups and tags could not be loaded. {describeFailure(known.failure)}
                    </p>
                    <button type="button" className="secondary" onClick={() => void refreshKnown()}>
                      Try again
                    </button>
                  </div>
                )}
                <SessionFolds
                  agents={agents}
                  truncated={truncated}
                  view={view}
                  known={known.data}
                  knownFailure={known.failure}
                  refreshKnown={refreshKnown}
                  refresh={refresh}
                  newThread={(agent, session, opener) => setWriting({ agent, session, opener })}
                  organize={setOrganizing}
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
      {organizing?.kind === "group" && (
        <SessionGroupPicker
          agent={organizing.agent}
          session={organizing.session.session}
          group={organizing.session.group}
          anchor={organizing.opener}
          onClose={doneOrganizing}
          onChanged={organized}
        />
      )}
      {organizing?.kind === "tags" && (
        <TagsSetter
          label={
            organizing.session === undefined
              ? `Tags for ${organizing.agent}`
              : `Tags for ${organizing.agent}/${organizing.session.session}`
          }
          path={
            organizing.session === undefined
              ? `/agents/${organizing.agent}/tags`
              : `/s/${organizing.agent}/${organizing.session.session}/tags`
          }
          tags={organizing.tags}
          anchor={organizing.opener}
          onClose={doneOrganizing}
          onChanged={organized}
        />
      )}
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
    </PaletteProvider>
  );
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
