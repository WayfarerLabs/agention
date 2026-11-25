import type { Registration, SessionSummary } from "@wayfarerlabs/agention-api";
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { type AgentList, describeFailure, listSessions } from "../api.ts";
import { Fold, LeftOut, Loadable, MoreButton, PageHeading, usePageTitle } from "../components.tsx";
import { usePages, useResource } from "../data.ts";
import { useFolds } from "../device.ts";
import { loadGroupsAndTags, PaletteProvider } from "../organizing.tsx";
import { useShortcuts } from "../keyboard.tsx";
import { correctPoppedEntry, matchRoute, navigate, useLocation } from "../router.tsx";
import { openRow, stepRow } from "./row-keys.ts";
import { type SessionsView, sessionsQuery, sessionsViewOf } from "./sessions/arrangement.ts";
import { SessionGroupPicker, TagsSetter } from "./sessions/GroupsAndTags.tsx";
import { NewThreadSheet } from "./sessions/NewThreadSheet.tsx";
import {
  DecidedRegistration,
  listWaiting,
  loadRegistrations,
  type WaitingList,
} from "./sessions/Registrations.tsx";
import { RegistrationPane } from "./sessions/RegistrationPane.tsx";
import {
  type Organizing,
  SessionFolds,
  SessionsHead,
  WaitingFold,
} from "./sessions/SessionFolds.tsx";
import { NoSession, SessionPane } from "./sessions/SessionPane.tsx";
import { findSession, sessionKey, WaitingRegistrations } from "./sessions/SessionRow.tsx";
import { Panes, useSideBySide } from "./side-by-side.tsx";

// The sessions view: every session the operator's agents run, in one view,
// on the rows' address, /sessions, and on each session's,
// /sessions/<agent>/<session>. At a desktop's width the rows and the session
// open stand side by side, as the thread list and a thread do
// (side-by-side.tsx): a row is a link to its session, which shows whole in
// the pane beside the rows, each at its own address, so the browser's Back
// steps through the sessions looked at, and the arrangement on screen is the
// layout's own (useKeptArrangement); a registration waiting opens the same
// way. While nothing is open, the pane holds a word on how to choose. On a
// narrower screen, as on a phone, the rows show alone, and a session opens
// on its own page, as a thread does.
//
// The rows' pane, top to bottom: the registrations waiting for approval, a
// row each in a fold of their own above the rest whatever the arrangement
// (WaitingFold), each opening at its own address, /registrations/<id>, the
// page holding its approval (RegistrationPane); the agents and their
// sessions, under a head choosing how they are grouped and sorted
// (sessions/arrangement.ts), as the thread list's head does, which the
// address keeps, a session's row leading to any registration waiting to be
// approved onto it (WaitingRegistrations); and, folded, the credentials and
// past requests. By default, once some session is in a group, the agents
// fold under their groups, in the operator's order, which each group's head
// moves, and no group last, an agent with sessions in two groups coming
// under each with that group's sessions alone; until then, and grouped by
// agent, each agent folds under its header, rolling up its sessions'
// threads, open asks, unread updates and stranded threads, with links to its
// threads and its stranded threads, its tags and a menu setting them, over a
// row for each of its sessions; grouped by session, the rows stand alone.
// Every chip that stands for threads, the names of groups, agents and
// sessions among them, links to those threads on the thread list, and
// following one never folds anything; a header's chevron folds it, as a
// click on the rest of its bar does. The view reads every session and every
// registration waiting before it shows any, so it arranges them whole. It
// refreshes as every view does. The operator's groups and tags load beside
// the sessions, for their colors and the groups' order; a session's group
// and an agent's or a session's tags are picked from their options menus,
// each pick applied at once. This browser keeps the groups and agents it
// folds and whether the past requests are shown. What a fold hides is not
// loaded, so a session's log loads and is read only while the session is
// open.

// Where this browser keeps its folds: the groups and agents folded, and the
// sections unfolded.
const unfoldedSections = "agention.sessions.unfolded-sections";
const pastRequests = "past-requests";

// What is open from the rows: a session, or a registration waiting.
export type OpenFromRows =
  { name: "session"; agent: string; session: string } | { name: "registration"; id: number };

export function Sessions({
  open,
}: {
  // What the view's address opens, if it opens anything.
  open: OpenFromRows | undefined;
}) {
  const sideBySide = useSideBySide();
  // How the view arranges the sessions, which lives in the address.
  // Choosing another arrangement replaces the address, so going back leaves
  // the view rather than stepping through every choice.
  const location = useLocation();
  const view = sessionsViewOf(location.searchParams);
  const choose = (next: SessionsView) =>
    navigate(`${location.pathname}${sessionsQuery(next)}`, { replace: true });
  const arranged = sessionsQuery(view);
  useKeptArrangement(sideBySide, arranged);
  const waiting = useResource<WaitingList>(listWaiting);
  const sessions = useResource<AgentList>(listSessions);
  const requests = waiting.data?.registrations ?? [];
  // The page has one title and one level-one heading: the session's or the
  // registration's while one is open, and the view's otherwise.
  const openRegistration =
    open?.name === "registration" ? requests.find((each) => each.id === open.id) : undefined;
  usePageTitle(
    open === undefined
      ? "Sessions"
      : open.name === "session"
        ? sessionKey(open.agent, open.session)
        : openRegistration === undefined
          ? "Registration"
          : `Registration ${openRegistration.code}`,
  );
  // Each decision or read the view makes reloads it, and the past requests
  // too, settling once the registrations waiting and the sessions have.
  const [changes, changed] = useReducer((count: number) => count + 1, 0);
  // The operator's groups and tags, for their colors and the groups' order,
  // which a change to a session's group or tags can add to.
  const known = useResource(loadGroupsAndTags);
  const { refresh: refreshWaiting } = waiting;
  const { refresh: refreshSessions } = sessions;
  const { refresh: refreshKnown } = known;
  const refresh = useCallback(async () => {
    changed();
    await Promise.all([refreshWaiting(), refreshSessions(), refreshKnown()]);
  }, [refreshWaiting, refreshSessions, refreshKnown]);
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
      : (findSession(sessions.data?.agents, writing.agent, writing.session.session) ??
        writing.session);
  const handlers = {
    refresh,
    newThread: (agent: string, session: SessionSummary, opener: HTMLElement | null) =>
      setWriting({ agent, session, opener }),
    organize: setOrganizing,
  };
  // The rows wait for the registrations waiting, or their failure, as for
  // the sessions, so the rows do not move as the requests arrive above them;
  // the requests wait for the sessions, or their failure, as what each
  // proposes is told from them.
  const loaded = waiting.data !== undefined || waiting.failure !== undefined;
  const sessionsSettled = sessions.data !== undefined || sessions.failure !== undefined;
  const rows = (
    <>
      <RowKeys />
      {open === undefined && <PageHeading visuallyHidden>Sessions</PageHeading>}
      {/* What fails to load of the registrations waiting says so, with a
          retry, the sessions showing meanwhile. */}
      {waiting.failure !== undefined && (
        <div className="notice danger" role="alert">
          <p>
            The registrations waiting for approval could not be loaded.{" "}
            {describeFailure(waiting.failure)}
          </p>
          <button type="button" className="secondary" onClick={() => void refreshWaiting()}>
            Try again
          </button>
        </div>
      )}
      {loaded && sessionsSettled && (
        <>
          <WaitingFold waiting={requests} agents={sessions.data?.agents} />
          {waiting.data?.truncated === true && (
            <LeftOut items="registrations waiting for approval" />
          )}
        </>
      )}
      <section aria-labelledby="agents-heading">
        <h2 id="agents-heading">Agents</h2>
        <Loadable
          data={loaded ? sessions.data : undefined}
          failure={sessions.failure}
          retry={sessions.refresh}
        >
          {({ agents, truncated }) =>
            agents.length === 0 && requests.length === 0 ? (
              <p className="empty">
                No agent has a session yet. When an agent registers, it shows a code to relay to
                you, and its registration appears here, waiting for your approval.
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
                  {...handlers}
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
    </>
  );
  return (
    <PaletteProvider known={known.data}>
      <WaitingRegistrations.Provider value={requests}>
        <Panes
          sideBySide={sideBySide}
          open={open === undefined ? undefined : location.pathname}
          list={{ label: "Session list", content: rows }}
          detail={{
            label: "Session",
            content:
              open === undefined ? (
                <NoSession />
              ) : open.name === "registration" ? (
                <RegistrationPane
                  id={open.id}
                  waiting={waiting}
                  sessions={sessions}
                  arranged={arranged}
                  refresh={refresh}
                />
              ) : (
                <SessionPane
                  agent={open.agent}
                  session={open.session}
                  sessions={sessions}
                  rows={`/sessions${arranged}`}
                  {...handlers}
                />
              ),
          }}
        />
      </WaitingRegistrations.Provider>
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

// useKeptArrangement keeps the arrangement on screen side by side as the
// layout's own, so going back or forward between sessions, or onto the rows'
// own entry, leaves the rows as arranged: before the page follows the entry
// gone to, its query is corrected to the arrangement as set, so the entry, a
// reload and the rows agree. One at a time, each entry's arrangement shows
// as it was.
function useKeptArrangement(sideBySide: boolean, arranged: string): void {
  useLayoutEffect(() => {
    if (!sideBySide) {
      return;
    }
    return correctPoppedEntry(() => {
      const { pathname, search } = window.location;
      const route = matchRoute(pathname).name;
      if (
        (route === "sessions" || route === "session" || route === "registration") &&
        search !== arranged
      ) {
        window.history.replaceState(window.history.state, "", `${pathname}${arranged}`);
      }
    });
  }, [sideBySide, arranged]);
}

// The rows' leading controls on the page, in order, each its row's chevron,
// a session's or a registration's: a row under a folded header is not
// rendered, so not among them.
const rowLeads = () => Array.from(document.querySelectorAll<HTMLElement>(".session-lead"));

// RowKeys gives the rows' keyboard shortcuts their actions while the rows
// are mounted: moving from row to row, and opening what the row holding
// focus stands for, as following its chevron does (row-keys.ts).
function RowKeys() {
  const row = ".session-row";
  useShortcuts("Session list", {
    nextSession: () => stepRow(rowLeads(), row, 1),
    previousSession: () => stepRow(rowLeads(), row, -1),
    openSession: () => openRow(rowLeads(), row),
  });
  return null;
}

// PastRequests lists the registrations already decided, loading them only
// while shown. A change the view makes elsewhere, which may decide one, as
// approving or revoking does, reloads them at once.
function PastRequests({ changes, refresh }: { changes: number; refresh: () => void }) {
  const all = usePages<Registration>(loadRegistrations);
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
