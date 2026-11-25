import {
  type GroupRef,
  type GroupsAndTags,
  noGroup,
  type SessionSummary,
  type ThreadsView,
} from "@wayfarerlabs/agention-api";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { Agents } from "../../api.ts";
import {
  Failure,
  Fold,
  LeftOut,
  MenuItem,
  OptionsMenu,
  PathParts,
  Status,
  useFocusWhenShown,
} from "../../components.tsx";
import { useFolds } from "../../device.ts";
import { plural, Spoken } from "../../format.tsx";
import { PickList } from "../../icon-controls.tsx";
import { Swatch, usePalette } from "../../organizing.tsx";
import { BlockedLink, FilterLink } from "../filter-links.tsx";
import {
  type Drag,
  DragHandle,
  MoveButtons,
  useDropTarget,
  useGroupOrder,
} from "../group-order.tsx";
import { ReverseCheckbox } from "../list-head.tsx";
import {
  arrange,
  defaultSortOf,
  groupKeyOf,
  type Held,
  type Lone,
  regrouped,
  type SessionGrouping,
  type SessionSort,
  type SessionsView,
  sessionGroupings,
  sessionSorts,
  sortsOf,
} from "./arrangement.ts";
import { TagChip } from "./GroupsAndTags.tsx";
import {
  composeSessions,
  OpenAsksLink,
  SessionsRollupMarks,
  StrandedLink,
  ThreadsLink,
} from "./roll-ups.tsx";
import { SessionRow, sessionKey } from "./SessionRow.tsx";

// The sessions view's agents and sessions, as its arrangement shows them,
// under the head choosing it: grouped by session group, the groups fold,
// each holding its agents, which fold over their sessions' rows; grouped by
// agent, the agents fold over their rows; grouped by session, the rows
// stand alone. Each group's head and agent's header rolls up the sessions
// beneath, and every chip that stands for threads links to them.

// What the operator is organizing, in a picker open on it: a session's group,
// or an agent's or a session's tags; and the control the picker lies beside,
// which focus returns to when it closes.
export type Organizing = { opener: HTMLElement | null } & (
  | { kind: "group"; agent: string; session: SessionSummary }
  | { kind: "tags"; agent: string; session?: SessionSummary; tags: string[] }
);

// Where this browser keeps its folds: the groups and agents folded.
const foldedGroups = "agention.sessions.folded-groups";
const foldedAgents = "agention.sessions.folded-agents";

// The views' parts SessionFolds and AgentFolds pass down: reloading the
// view, and opening the new-thread sheet or a picker organizing sessions.
export interface Handlers {
  refresh: () => void;
  newThread: (agent: string, session: SessionSummary, opener: HTMLElement | null) => void;
  organize: (organizing: Organizing) => void;
}

const sortLabel: Record<SessionSort, string> = {
  manual: "Manual",
  alphabetic: "Alphabetic",
  registered: "Registration time",
};

// Each sort's direction in words, its own, then reversed; Manual has none.
const directionLabel: Record<Exclude<SessionSort, "manual">, [string, string]> = {
  alphabetic: ["A to Z", "Z to A"],
  registered: ["Newest first", "Oldest first"],
};

const groupLabel: Record<SessionGrouping, string> = {
  session_group: "Group",
  agent: "Agent",
  session: "Session",
};

// SessionsHead holds the view's sort, beside the checkbox reversing it, and
// its grouping, as the thread list's head does, the sort and the grouping
// marked while set to anything but their defaults. Choosing another sort takes it in its own
// direction; another grouping keeps the sort while it offers it.
export function SessionsHead({
  view,
  choose,
}: {
  view: SessionsView;
  choose: (view: SessionsView) => void;
}) {
  const { sort } = view;
  return (
    <div className="list-head">
      <div className="sort-control">
        <PickList
          icon="sort"
          label="Sort"
          value={sort}
          options={sortsOf(view.group).map((each) => ({ value: each, label: sortLabel[each] }))}
          marked={sort !== defaultSortOf(view.group)}
          choose={(value) =>
            choose({
              ...view,
              sort: sessionSorts.find((each) => each === value) ?? sort,
              reverse: false,
            })
          }
        />
        {sort !== "manual" && (
          <ReverseCheckbox
            labels={directionLabel[sort]}
            reverse={view.reverse}
            onReverse={() => choose({ ...view, reverse: !view.reverse })}
          />
        )}
      </div>
      <PickList
        icon="group"
        label="Group"
        value={view.group}
        options={sessionGroupings.map((each) => ({ value: each, label: groupLabel[each] }))}
        marked={view.group !== "session_group"}
        choose={(value) =>
          choose(regrouped(view, sessionGroupings.find((each) => each === value) ?? view.group))
        }
      />
    </div>
  );
}

// organizing opens, for a session's row, the picker organizing its group or
// its tags.
const organizing =
  (organize: Handlers["organize"], agent: string, session: SessionSummary) =>
  (what: "group" | "tags", opener: HTMLElement | null) =>
    organize(
      what === "group"
        ? { kind: "group", agent, session, opener }
        : { kind: "tags", agent, session, tags: session.tags, opener },
    );

// useUnfolded keeps which session rows are unfolded, by their paths, while
// the view is open.
function useUnfolded(): [ReadonlySet<string>, (key: string) => void] {
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const flip = (key: string) =>
    setUnfolded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) {
        next.add(key);
      }
      return next;
    });
  return [unfolded, flip];
}

// SessionFolds shows the agents as the view arranges them: under their
// groups, grouped by session group once any session is in one; under their
// headers, grouped by agent, or by session group while no session is in
// any; or each session alone, grouped by session. In the operator's manual
// order, each group's head moves it, as Settings' list of groups does.
export function SessionFolds({
  agents,
  truncated,
  view,
  known,
  knownFailure,
  refreshKnown,
  ...handlers
}: {
  agents: Agents;
  truncated: boolean;
  view: SessionsView;
  // The operator's groups and tags, whose groups' order Manual follows.
  known: GroupsAndTags | undefined;
  // Why the groups and tags last failed to load, until they load.
  knownFailure: unknown;
  refreshKnown: () => Promise<boolean>;
} & Handlers) {
  const id = useId();
  const folds = useFolds(foldedGroups);
  const focus = useFocusWhenShown(known);
  const order = useGroupOrder({
    groups: known?.groups,
    failure: knownFailure,
    refresh: refreshKnown,
    focus,
  });
  const arranged = arrange(view, agents, order.ordered);
  // Groups move in the manual order, those the order holds alone, so none
  // move until the groups have loaded, nor one they no longer list.
  const moving = view.sort === "manual" && arranged.kind === "groups";
  const { hush } = order;
  useEffect(() => {
    if (!moving) {
      hush();
    }
  }, [moving, hush]);
  if (arranged.kind === "agents") {
    return <AgentFolds agents={arranged.agents} {...handlers} />;
  }
  if (arranged.kind === "sessions") {
    return <LoneSessions sessions={arranged.sessions} agents={agents} {...handlers} />;
  }
  const shown = arranged.groups.flatMap((fold) =>
    fold.group !== undefined && order.ordered.includes(fold.group.id) ? [fold.group.id] : [],
  );
  return (
    <>
      {moving && (
        <>
          <Status>{order.said}</Status>
          <Failure failure={order.failure}>
            <p>The groups show in the order they are in now.</p>
          </Failure>
        </>
      )}
      {arranged.groups.map(({ group, agents: held }) => {
        const key = groupKeyOf(group);
        return (
          <GroupFoldOf
            key={key}
            group={group}
            agents={held}
            truncated={truncated}
            folded={folds.has(key)}
            toggle={() => folds.toggle(key)}
            moves={
              moving && group !== undefined && shown.includes(group.id)
                ? {
                    drag: order.drag(group.id, shown),
                    dragging: order.dragging === group.id,
                    buttons: (
                      <MoveButtons
                        group={group.id}
                        name={group.name}
                        shown={shown}
                        idOf={(each, direction) => `${id}-${each}-${direction}`}
                        pending={order.pending}
                        move={(target, focusOn) =>
                          void order.move(group.id, target, shown, focusOn)
                        }
                      />
                    ),
                  }
                : undefined
            }
            {...handlers}
          />
        );
      })}
    </>
  );
}

// GroupFoldOf is a group under its head, which names the group, linking to
// its threads, and carries its sessions' roll-up, with Blocked on you while
// any blocking ask is open in them, unless the view was cut short or an
// agent under it left sessions out, and a link to its threads. In the manual
// order, its head ends in its moves and the handle a mouse drags it by, and
// takes another group dropped on it.
function GroupFoldOf({
  group,
  agents,
  truncated,
  folded,
  toggle,
  moves,
  ...handlers
}: {
  group: GroupRef | undefined;
  agents: Held[];
  truncated: boolean;
  folded: boolean;
  toggle: () => void;
  moves: { drag: Drag; dragging: boolean; buttons: ReactNode } | undefined;
} & Handlers) {
  const palette = usePalette();
  const [over, drop] = useDropTarget(moves?.drag);
  const name = group?.name ?? "No group";
  const rollup =
    truncated || agents.some((entry) => entry.truncated)
      ? undefined
      : composeSessions(agents.flatMap((entry) => entry.sessions));
  const narrowing: Partial<ThreadsView> = { session_group: [group?.id ?? noGroup] };
  const label = group === undefined ? "no group" : name;
  const classes = [moves?.dragging ? "dragging" : "", over ? "drop-over" : ""].join(" ").trim();
  return (
    <Fold
      level={3}
      depth="outer"
      name={group === undefined ? name : `Group ${name}`}
      label={
        <FilterLink
          narrowing={narrowing}
          spoken={group === undefined ? "Threads in no group" : `Threads in group ${name}`}
        >
          {group !== undefined && <Swatch color={palette.group(group.id)} />}
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
      actions={
        moves === undefined ? undefined : (
          <span className="group-moves">
            <DragHandle name={name} drag={moves.drag} />
            {moves.buttons}
          </span>
        )
      }
      className={classes === "" ? undefined : classes}
      drop={drop}
      folded={folded}
      toggle={toggle}
    >
      <AgentFolds agents={agents} group={group ?? noGroup} {...handlers} />
    </Fold>
  );
}

// LoneSessions lists each session alone, under no header, each naming its
// agent, and says which agents left sessions out.
function LoneSessions({
  sessions,
  agents,
  refresh,
  newThread,
  organize,
}: { sessions: Lone[]; agents: Agents } & Handlers) {
  const [unfolded, flip] = useUnfolded();
  return (
    <>
      <ul className="session-rows">
        {sessions.map(({ agent, session }) => {
          const key = sessionKey(agent, session.session);
          return (
            <SessionRow
              key={key}
              level={3}
              alone
              agent={agent}
              session={session}
              unfolded={unfolded.has(key)}
              toggle={() => flip(key)}
              refresh={refresh}
              newThread={(opener) => newThread(agent, session, opener)}
              organize={organizing(organize, agent, session)}
            />
          );
        })}
      </ul>
      {agents
        .filter((entry) => entry.truncated)
        .map((entry) => (
          <LeftOut key={entry.agent} items={`sessions of ${entry.agent}`} />
        ))}
    </>
  );
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
  const [unfolded, flip] = useUnfolded();
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
                organize={organizing(organize, entry.agent, session)}
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
