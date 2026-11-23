import {
  type GroupRef,
  noGroup,
  type Registration,
  type SessionSummary,
  type ThreadsView,
} from "@wayfarerlabs/agention-api";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { type AgentList, type Agents, listSessions } from "../api.ts";
import {
  Fold,
  LeftOut,
  Loadable,
  MenuItem,
  MoreButton,
  OptionsMenu,
  PageHeading,
  PathParts,
  usePageTitle,
} from "../components.tsx";
import { usePages, useResource } from "../data.ts";
import { useFolds } from "../device.ts";
import { plural, Spoken } from "../format.tsx";
import { GroupSheet, GroupsAndTagsSheet, TagChip, TagsSheet } from "./sessions/GroupsAndTags.tsx";
import { NewThreadSheet } from "./sessions/NewThreadSheet.tsx";
import {
  DecidedRegistration,
  loadRegistrations,
  PendingRegistration,
} from "./sessions/Registrations.tsx";
import { BlockedLink, FilterLink } from "./filter-links.tsx";
import {
  composeSessions,
  OpenAsksLink,
  SessionsRollupMarks,
  StrandedLink,
  ThreadsLink,
} from "./sessions/roll-ups.tsx";
import { SessionRow, sessionKey } from "./sessions/SessionRow.tsx";

// The sessions view: every session the operator's agents run, in one view.
// Top to bottom: the Groups and tags button, which opens the sheet listing
// the operator's groups and tags; the registrations waiting for approval;
// each agent under a header that folds, rolling up its sessions' threads,
// open asks, unread updates and stranded threads, with links to its threads
// and its stranded threads, its tags and a menu setting them, over a folded
// row for each of its sessions; and, folded, the credentials and past
// requests. Once some session is in a group, the agents fold under their
// groups, groups in name order and no group last, each group's head rolling
// up its sessions with a link to their threads, and an agent with sessions
// in two groups comes under each with that group's sessions alone. Every
// chip that stands for threads, the names of groups, agents and sessions
// among them, links to those threads on the thread list, and following one
// never folds anything; a header's chevron folds it, as a click on the rest
// of its bar does. The view reads every session before it shows any, so it
// folds them by the group each session carries. It refreshes as every view
// does. This browser keeps the groups and agents it folds and whether the
// past requests are shown; a session's row starts folded on every visit.
// What a fold hides is not loaded, so a session's log loads and is read
// only while its row is unfolded under an unfolded agent.

// What the operator is organizing, in a sheet open on it: every group and
// tag, a session's group, or an agent's or a session's tags; and the control
// focus returns to when the sheet closes.
type Organizing = { opener: HTMLElement | null } & (
  | { kind: "all" }
  | { kind: "group"; agent: string; session: SessionSummary }
  | { kind: "tags"; agent: string; session?: SessionSummary; tags: string[] }
);

// Where this browser keeps its folds: the groups and agents folded, and the
// sections unfolded.
const foldedGroups = "agention.sessions.folded-groups";
const foldedAgents = "agention.sessions.folded-agents";
const unfoldedSections = "agention.sessions.unfolded-sections";
const pastRequests = "past-requests";

export function Sessions() {
  usePageTitle("Sessions");
  const pending = usePages<Registration>(loadRegistrations("pending"));
  const sessions = useResource<AgentList>(listSessions);
  // Each decision or read the view makes reloads it, and the past requests
  // too.
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
  return (
    <>
      <PageHeading visuallyHidden>Sessions</PageHeading>
      <div className="view-actions">
        <button
          type="button"
          className="secondary"
          aria-haspopup="dialog"
          onClick={(event) => setOrganizing({ kind: "all", opener: event.currentTarget })}
        >
          Groups and tags
        </button>
      </div>
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
                <SessionFolds
                  agents={agents}
                  truncated={truncated}
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
      {organizing?.kind === "all" && (
        <GroupsAndTagsSheet onClose={doneOrganizing} onChanged={refreshSessions} />
      )}
      {organizing?.kind === "group" && (
        <GroupSheet
          agent={organizing.agent}
          session={organizing.session.session}
          group={organizing.session.group}
          onClose={doneOrganizing}
          onChanged={refreshSessions}
        />
      )}
      {organizing?.kind === "tags" && (
        <TagsSheet
          heading={
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
          onClose={doneOrganizing}
          onChanged={refreshSessions}
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
    </>
  );
}

// The views' parts SessionFolds and AgentFolds pass down: reloading the
// view, and opening the new-thread sheet or a sheet organizing sessions.
interface Handlers {
  refresh: () => void;
  newThread: (agent: string, session: SessionSummary, opener: HTMLElement | null) => void;
  organize: (organizing: Organizing) => void;
}

// An agent with its sessions as the view folds them: all of them, or under a
// group, those in that group, or in none.
type Held = Agents[number];

// A group of the view: the group, absent for no group, and its agents.
interface GroupFold {
  group: GroupRef | undefined;
  agents: Held[];
}

// A group's key: its id, since a group can be renamed, or none.
const groupKeyOf = (group: GroupRef | undefined) =>
  group === undefined ? noGroup : String(group.id);

// A group's name for its order: ignoring the case of ASCII letters, as the
// server compares names.
const nameOrder = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

// foldByGroup splits each agent's sessions by their group: the groups in name
// order and no group last, each holding the agents with sessions in it, in
// the page's order, each with that group's sessions only.
function foldByGroup(agents: Agents): GroupFold[] {
  const folds = new Map<string, GroupFold>();
  for (const entry of agents) {
    const split = new Map<string, Held>();
    for (const session of entry.sessions) {
      const key = groupKeyOf(session.group);
      const held = split.get(key) ?? { ...entry, sessions: [] };
      held.sessions.push(session);
      split.set(key, held);
      if (!folds.has(key)) {
        folds.set(key, { group: session.group, agents: [] });
      }
    }
    for (const [key, held] of split) {
      folds.get(key)?.agents.push(held);
    }
  }
  const ordered = (fold: GroupFold) =>
    fold.group === undefined ? undefined : ([nameOrder(fold.group.name), fold.group.id] as const);
  return [...folds.values()].sort((a, b) => {
    const [x, y] = [ordered(a), ordered(b)];
    if (x === undefined || y === undefined) {
      return x === y ? 0 : x === undefined ? 1 : -1;
    }
    return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : x[1] - y[1];
  });
}

// SessionFolds shows the agents, folded under their groups once any session
// is in one. Each group's head names the group, linking to its threads, and
// carries its sessions' roll-up, with Blocked on you while any blocking ask
// is open in them, unless the view was cut short or an agent under it left
// sessions out, and a link to its threads.
function SessionFolds({
  agents,
  truncated,
  ...handlers
}: { agents: Agents; truncated: boolean } & Handlers) {
  const folds = useFolds(foldedGroups);
  if (!agents.some((entry) => entry.sessions.some((session) => session.group !== undefined))) {
    return <AgentFolds agents={agents} {...handlers} />;
  }
  return foldByGroup(agents).map(({ group, agents: held }) => {
    const key = groupKeyOf(group);
    const name = group?.name ?? "No group";
    const rollup =
      truncated || held.some((entry) => entry.truncated)
        ? undefined
        : composeSessions(held.flatMap((entry) => entry.sessions));
    const narrowing: Partial<ThreadsView> = { session_group: [group?.id ?? noGroup] };
    const label = group === undefined ? "no group" : name;
    return (
      <Fold
        key={key}
        level={3}
        depth="outer"
        name={group === undefined ? name : `Group ${name}`}
        label={
          <FilterLink
            narrowing={narrowing}
            spoken={group === undefined ? "Threads in no group" : `Threads in group ${name}`}
          >
            {name}
          </FilterLink>
        }
        marks={
          <>
            {rollup !== undefined && (
              <span className="roll-up">
                <SessionsRollupMarks rollup={rollup} narrowing={narrowing} label={label} />
                {rollup.blocked && <BlockedLink narrowing={narrowing} label={label} />}
              </span>
            )}
            <ThreadsLink rollup={rollup} narrowing={narrowing} label={label} />
          </>
        }
        folded={folds.has(key)}
        toggle={() => folds.toggle(key)}
      >
        <AgentFolds agents={held} group={group ?? noGroup} {...handlers} />
      </Fold>
    );
  });
}

// AgentFolds shows each agent under its header, its sessions' rows beneath,
// a level below; the headers sit a level below a group's head when under
// one, and at the group's own level otherwise. Each header's name, its
// roll-up's marks and its open asks link to the threads they stand for, and
// its tags to the threads carrying them. Under a group, an agent's links
// lead to the threads in that group, its tags' aside, and this
// browser keeps its fold by the group's id and the agent's name, so an agent
// under two groups folds under each apart; an agent in no group keeps its
// fold by its name alone, as without groups. The rows unfolded hold only
// while the view is open.
function AgentFolds({
  agents,
  group,
  refresh,
  newThread,
  organize,
}: {
  agents: Held[];
  // The group the agents are folded under, no group among them, or none when
  // the view does not fold by group.
  group?: GroupRef | typeof noGroup;
} & Handlers) {
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
  const inGroup = group === undefined ? undefined : group === noGroup ? noGroup : group.id;
  const level = group === undefined ? 3 : 4;
  return agents.map((entry) => {
    const { asks, blocking, stranded } = countsOf(entry);
    // The roll-up of an agent that left sessions out would be short, and so
    // would its count of stranded threads, which then shows whether any of
    // the sessions it lists has some, but not how many.
    const rollup = entry.truncated ? undefined : composeSessions(entry.sessions);
    const sessions = plural(entry.sessions.length, "session");
    const fold =
      inGroup === undefined || inGroup === noGroup ? entry.agent : `${inGroup}/${entry.agent}`;
    const narrowing: Partial<ThreadsView> = {
      agent: [entry.agent],
      ...(inGroup === undefined ? {} : { session_group: [inGroup] }),
    };
    return (
      <Fold
        key={fold}
        level={level}
        depth={level === 3 ? "outer" : "inner"}
        name={`Agent ${entry.agent}`}
        label={
          <FilterLink narrowing={narrowing} spoken={`Threads of agent ${entry.agent}`}>
            <PathParts place={[["agent", entry.agent]]} />
          </FilterLink>
        }
        marks={
          <>
            <span className="roll-up">
              <span className="roll-up-count">
                <Spoken
                  shown={sessions}
                  spoken={entry.truncated ? `more than ${sessions}` : sessions}
                />
              </span>
              {rollup !== undefined && (
                <SessionsRollupMarks rollup={rollup} narrowing={narrowing} label={entry.agent} />
              )}
              {blocking > 0 && <BlockedLink narrowing={narrowing} label={entry.agent} />}
              {asks > 0 && <OpenAsksLink count={asks} narrowing={narrowing} label={entry.agent} />}
              {entry.tags.map((tag) => (
                <TagChip key={tag} tag={tag} />
              ))}
            </span>
            <ThreadsLink rollup={rollup} narrowing={narrowing} label={entry.agent} />
            {stranded > 0 && (
              <StrandedLink
                stranded={entry.truncated ? undefined : stranded}
                narrowing={narrowing}
                label={entry.agent}
              />
            )}
          </>
        }
        actions={
          <AgentMenu
            agent={entry.agent}
            tags={entry.tags}
            onTags={(opener) =>
              organize({ kind: "tags", agent: entry.agent, tags: entry.tags, opener })
            }
          />
        }
        folded={folds.has(fold)}
        toggle={() => folds.toggle(fold)}
      >
        <ul className="session-rows">
          {entry.sessions.map((session) => {
            const key = sessionKey(entry.agent, session.session);
            return (
              <SessionRow
                key={key}
                level={level === 3 ? 4 : 5}
                agent={entry.agent}
                session={session}
                unfolded={unfolded.has(key)}
                toggle={() => flip(key)}
                refresh={refresh}
                newThread={(opener) => newThread(entry.agent, session, opener)}
                organize={(what, opener) =>
                  organize(
                    what === "group"
                      ? { kind: "group", agent: entry.agent, session, opener }
                      : { kind: "tags", agent: entry.agent, session, tags: session.tags, opener },
                  )
                }
              />
            );
          })}
        </ul>
        {entry.truncated && <LeftOut items={`sessions of ${entry.agent}`} />}
      </Fold>
    );
  });
}

// AgentMenu is an agent's options at its header's end: Tags, which opens the
// sheet setting its tags.
function AgentMenu({
  agent,
  tags,
  onTags,
}: {
  agent: string;
  tags: string[];
  onTags: (opener: HTMLElement | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <OptionsMenu label={`Options for ${agent}`} open={open} setOpen={setOpen} button={button}>
      <MenuItem onChoose={() => onTags(button.current)}>
        Tags: {tags.length === 0 ? "none" : tags.join(", ")}
      </MenuItem>
    </OptionsMenu>
  );
}

// countsOf adds up what an agent's sessions the view lists hold beyond their
// roll-up: their open asks, the blocking among them, and stranded threads.
function countsOf(entry: Held) {
  const sum = (count: (session: SessionSummary) => number) =>
    entry.sessions.reduce((total, session) => total + count(session), 0);
  return {
    asks: sum((session) => session.open_asks.count),
    blocking: sum((session) => session.open_asks.blocking_count),
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
