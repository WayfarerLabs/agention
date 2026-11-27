import { useRef } from "react";
import { ActionBar, BarLink, BarSlots } from "../../action-bar.tsx";
import type { AgentList } from "../../api.ts";
import { Loadable, PageHeading } from "../../components.tsx";
import type { Resource } from "../../data.ts";
import { useShortcuts } from "../../keyboard.tsx";
import { navigate } from "../../router.tsx";
import { type Handlers, organizing } from "./SessionFolds.tsx";
import { findSession, SessionOpen, sessionKey } from "./SessionRow.tsx";

// The root's property holding how tall the session's bar is, which the
// page's scroll padding keeps clear.
const sessionBarHeight = "--session-bar-height";

// SessionPane is a session at its own address: beside the sessions' rows at
// a desktop's width, and alone on a narrower screen. It shows the session as
// the view's own reading of the sessions holds it, so it follows every
// refresh and change the rows do, its facts leading to any registration
// waiting to be approved onto it, over a bar at its foot (PaneBar). A
// session the view does not list, as one never approved or one its agent
// left out past the most a list holds, says so.
export function SessionPane({
  agent,
  session,
  sessions,
  rows,
  refresh,
  newThread,
  organize,
}: {
  agent: string;
  session: string;
  sessions: Resource<AgentList>;
  // The address of the rows, as arranged.
  rows: string;
} & Handlers) {
  const path = sessionKey(agent, session);
  const found = findSession(sessions.data?.agents, agent, session);
  return (
    <article className="session-page">
      <Loadable data={sessions.data} failure={sessions.failure} retry={sessions.refresh}>
        {() =>
          found === undefined ? (
            <>
              <PageHeading>{path}</PageHeading>
              <p className="empty">The sessions listed hold no session {path}.</p>
            </>
          ) : (
            <SessionOpen
              agent={agent}
              session={found}
              refresh={refresh}
              newThread={(opener) => newThread(agent, found, opener)}
              organize={organizing(organize, agent, found)}
            />
          )
        }
      </Loadable>
      <PaneBar rows={rows} />
    </article>
  );
}

// PaneBar is the bar at the foot of what is open from the rows, a session
// or a registration: Sessions, back to the rows as arranged (rows), as u and
// Escape go.
export function PaneBar({ rows }: { rows: string }) {
  const bar = useRef<HTMLElement>(null);
  useShortcuts("Session", { backToSessions: () => navigate(rows) });
  return (
    <ActionBar label="Session actions" height={sessionBarHeight} bar={bar}>
      <BarSlots>
        <BarLink to={rows} icon="arrow-left" label="Sessions" name="Back to sessions" />
      </BarSlots>
    </ActionBar>
  );
}

// NoSession holds the session's pane while nothing is open.
export function NoSession() {
  return <p className="empty">Choose a session in the list to see it here.</p>;
}
