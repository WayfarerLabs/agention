import {
  composePresence,
  composeRollup,
  type GroupRef,
  keepsAsks,
  noGroup,
  type Presence,
  type Priority,
  priorityFilter,
  type Rollup,
  type ThreadGroups,
  type ThreadGrouping,
  type ThreadsView,
} from "@wayfarerlabs/agention-api";
import type { ReactNode } from "react";
import {
  Fold,
  type FoldDepth,
  type FoldLevel,
  PathParts,
  pathWord,
  type Place,
} from "../../components.tsx";
import { type Folds, useFolds } from "../../device.ts";
import { Swatch, usePalette } from "../../organizing.tsx";
import { plural, priorityLabel, priorityTone, Since } from "../../format.tsx";
import { Mark, UnreadCount } from "../../icons.tsx";
import {
  BlockedFlag,
  BlockedLink,
  FilterLink,
  type ListShown,
  UnreadLink,
} from "../filter-links.tsx";
import type { ListedThread } from "./listing.ts";
import { ThreadRow } from "./ThreadRow.tsx";

// The list grouped, folding the rows loaded inline under headers: by session
// group, the sessions under their groups when the list holds two or more, no
// group counting as one; by session, the sessions alone; by topic, the
// sessions, each session's threads under their topics when they carry two or
// more; or by agent, each agent's under its sessions when it has two or more.
// The list arrives a group at a time, each group's threads together, but a
// group whose first thread changed between pages can arrive in two runs, so
// rows fold under their group's header whichever page brought them.
// Depth shows through the headers' styles, the outer a sticky, tinted bar and
// the inner a light subheader, rather than through indentation. Every header
// rolls up its whole group, loaded or not, from the roll-ups the list
// carries, a session's and an agent's saying when it last checked in while it
// is quiet, and starts expanded; the headers the operator collapses are kept
// on this device for each grouping. A header's label, and each mark of its
// roll-up that a filter matches, links to the list as it is with that
// header's group added to its filters and the mark's own, its other filters,
// order and grouping kept: the label and the count to the group's threads,
// the envelope to its unread, and, while no filter on open asks is on,
// Blocked on you to its blocking and the priority to its asks at that
// priority or higher. No topic, which no filter names, links nothing.

type SessionGroup = ThreadGroups["sessions"][number];

const pathOf = (thread: { agent: string; session: string }) => `${thread.agent}/${thread.session}`;

// Which group a session is in, by its id, or none: the key its group's
// header goes by.
const groupKeyOf = (held: { group?: GroupRef | undefined }) =>
  held.group === undefined ? "none" : String(held.group.id);

// Each header's name on this device, by what it heads, a group by its id,
// since a group can be renamed.
const sessionHeader = (path: string) => `session:${path}`;
const topicHeader = (path: string, topic: string | undefined) => `topic:${path}:${topic ?? ""}`;
const agentHeader = (agent: string) => `agent:${agent}`;
const groupHeader = (key: string) => `group:${key}`;

// What a header heads, for the eye: each part of where its threads are behind
// its badge, a topic named alone since its session is right above it, or no
// topic in words; for assistive technology, such as "Agent reviewer Session
// main"; and as the filter keeping its threads alone, when one does.
interface Headed {
  shown: ReactNode;
  spoken: string;
  narrowing?: Partial<ThreadsView> | undefined;
}

// located heads a group by the parts of where its threads are, with the
// filter keeping them alone.
function located(place: Place, narrowing: Partial<ThreadsView>): Headed {
  return {
    shown: <PathParts place={place} />,
    spoken: place.map(([kind, name]) => `${pathWord(kind)} ${name}`).join(" "),
    narrowing,
  };
}

const bare = (text: string, narrowing?: Partial<ThreadsView>): Headed => ({
  shown: text,
  spoken: text,
  narrowing,
});

const priorityShown = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" } as const;

// The priorities a filter keeps asks at or above.
const filtered = (level: Priority): level is (typeof priorityFilter.options)[number] =>
  priorityFilter.safeParse(level).success;

// RollupMarks shows a roll-up: how many threads, the closed envelope with how
// many are unread or the open envelope when none is, whether any is blocked
// on the operator, the highest priority open, the archive box when all are
// archived, and, in the warning's tone while a session or an agent is quiet,
// when it last checked in. With a header's filter, each mark a filter matches
// links to its threads, named with what it shows and what the header heads,
// as in "Blocked on you: threads of Agent reviewer". While a filter on open
// asks is on, Blocked on you and the priority stay plain: they count every
// open ask of the threads kept, while those filters keep a thread for one
// ask meeting them all, so their own filter could replace the one on or
// keep nothing.
function RollupMarks({
  rollup,
  presence,
  label,
  list,
}: {
  rollup: Rollup;
  presence: Presence | undefined;
  label: Headed;
  list: ListShown;
}) {
  const { narrowing, spoken } = label;
  const scope = narrowing === undefined ? undefined : { narrowing, label: spoken, list };
  const linked = (change: Partial<ThreadsView>, name: string, mark: ReactNode) =>
    scope === undefined ? (
      mark
    ) : (
      <FilterLink list={list} narrowing={{ ...scope.narrowing, ...change }} spoken={name}>
        {mark}
      </FilterLink>
    );
  const asks = keepsAsks(list.view);
  const threads = plural(rollup.threads, "thread");
  const { priority } = rollup;
  const priorityMark = priority !== undefined && (
    <span className={`flag ${priorityTone[priority] ?? ""}`}>{priorityShown[priority]}</span>
  );
  return (
    <span className="roll-up">
      {linked({}, `${threads} of ${spoken}`, <span className="roll-up-count">{threads}</span>)}
      {scope === undefined ? (
        <UnreadCount unread={rollup.unread} />
      ) : (
        <UnreadLink unread={rollup.unread} {...scope} />
      )}
      {rollup.blocked &&
        (scope === undefined || asks ? <BlockedFlag /> : <BlockedLink {...scope} />)}
      {priority !== undefined &&
        (filtered(priority) && !asks
          ? linked({ priority }, `${priorityLabel[priority]} threads of ${spoken}`, priorityMark)
          : priorityMark)}
      {rollup.archived && <Mark icon="archive" label="Archived" />}
      {presence?.quiet === true && (
        <span className="last-check-in warning">
          <span className="visually-hidden">Quiet, </span>
          {presence.last_seen_at === undefined ? (
            "never checked in"
          ) : (
            <>
              last check-in <Since value={presence.last_seen_at} />
            </>
          )}
        </span>
      )}
    </span>
  );
}

// Where a fold sits: its heading's level and its header's depth.
interface Placement {
  level: FoldLevel;
  depth: FoldDepth;
}

// The placement of the fold or row under one.
function under({ level, depth }: Placement): Placement {
  return {
    level: Math.min(level + 1, 5) as FoldLevel,
    depth: depth === "outer" ? "inner" : "innermost",
  };
}

// GroupFold is a group under its header, named for what it heads, with the
// group's roll-up, and a session's or an agent's presence, when the list
// carries them. A header with a filter links its label to the group's
// threads. A collapsed header hides everything under it.
function GroupFold({
  header,
  at,
  label,
  rollup,
  presence,
  folds,
  list,
  children,
}: {
  header: string;
  at: Placement;
  label: Headed;
  rollup: Rollup | undefined;
  presence?: Presence | undefined;
  folds: Folds;
  list: ListShown;
  children: ReactNode;
}) {
  const { narrowing } = label;
  return (
    <Fold
      level={at.level}
      depth={at.depth}
      {...(narrowing === undefined
        ? { label: label.spoken }
        : {
            name: label.spoken,
            label: (
              <FilterLink list={list} narrowing={narrowing} spoken={`Threads of ${label.spoken}`}>
                {label.shown}
              </FilterLink>
            ),
          })}
      marks={
        rollup !== undefined && (
          <RollupMarks rollup={rollup} presence={presence} label={label} list={list} />
        )
      }
      folded={folds.has(header)}
      toggle={() => folds.toggle(header)}
    >
      {children}
    </Fold>
  );
}

// gather groups items by a key, in the order each key first appears.
function gather<T>(items: readonly T[], key: (item: T) => string): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  }
  return [...groups];
}

// headsOf gives what the headers show: the roll-up of each session and
// topic; of each agent, its roll-up and presence composed from its
// sessions'; and of each session group, its roll-up composed likewise. When
// the list left some groups out, the last agent or session group listed may
// be missing sessions, so it shows none.
function headsOf(groups: ThreadGroups | undefined) {
  const sessions = new Map(groups?.sessions.map((each) => [pathOf(each), each]));
  const listed = groups?.sessions ?? [];
  const complete = <T,>(all: T[]) => (groups?.truncated === true ? all.slice(0, -1) : all);
  const agents = gather(listed, (each) => each.agent);
  const agentHeads = new Map(
    complete(agents).map(([agent, held]) => [
      agent,
      {
        rollup: composeRollup(held.map((each) => each.rollup)),
        presence: composePresence(held.map((each) => each.presence)),
      },
    ]),
  );
  const sessionGroups = gather(listed, groupKeyOf);
  const groupHeads = new Map(
    complete(sessionGroups).map(([key, held]) => [
      key,
      composeRollup(held.map((each) => each.rollup)),
    ]),
  );
  return {
    session: (path: string): SessionGroup | undefined => sessions.get(path),
    agent: (agent: string) => agentHeads.get(agent),
    sessionsOf: (agent: string) => agents.find(([name]) => name === agent)?.[1].length ?? 0,
    group: (key: string) => groupHeads.get(key),
    groups: sessionGroups.length,
  };
}

const rowsOf = (threads: ListedThread[], level: FoldLevel) => (
  <ul className="threads">
    {threads.map((thread) => (
      <ThreadRow
        key={`${thread.agent}/${thread.session}/${thread.number}`}
        thread={thread}
        level={level}
      />
    ))}
  </ul>
);

// GroupedRows folds the rows loaded under their groups' headers.
export function GroupedRows({
  threads,
  groups,
  grouping,
  list,
}: {
  threads: ListedThread[];
  groups: ThreadGroups | undefined;
  grouping: ThreadGrouping;
  list: ListShown;
}) {
  const folds = useFolds(`agention.collapsed-groups.${grouping}`);
  const palette = usePalette();
  const heads = headsOf(groups);
  const top: Placement = { level: 2, depth: "outer" };
  if (grouping !== "agent") {
    // Each session under its header, at a placement.
    const sessionFolds = (held: ListedThread[], at: Placement) =>
      gather(held, pathOf).map(([path, inSession]) => {
        const [first] = inSession;
        const session = heads.session(path);
        const topics = gather(inSession, (thread) => thread.topic ?? "");
        // Grouped by topic, a session's topics branch when it carries two or
        // more, as its roll-up or the rows loaded say.
        const branches =
          grouping === "topic" && Math.max(session?.topics?.length ?? 0, topics.length) >= 2;
        const inner = under(at);
        return (
          <GroupFold
            key={path}
            header={sessionHeader(path)}
            at={at}
            label={located(
              [
                ["agent", first?.agent ?? ""],
                ["session", first?.session ?? ""],
              ],
              { session: [path] },
            )}
            rollup={session?.rollup}
            presence={session?.presence}
            folds={folds}
            list={list}
          >
            {branches
              ? topics.map(([, onTopic]) => {
                  const topic = onTopic[0]?.topic;
                  return (
                    <GroupFold
                      key={topic ?? ""}
                      header={topicHeader(path, topic)}
                      at={inner}
                      label={
                        topic === undefined
                          ? bare("No topic")
                          : located([["topic", topic]], { topic: [`${path}/${topic}`] })
                      }
                      rollup={session?.topics?.find((each) => each.topic === topic)?.rollup}
                      folds={folds}
                      list={list}
                    >
                      {rowsOf(onTopic, under(inner).level)}
                    </GroupFold>
                  );
                })
              : rowsOf(inSession, inner.level)}
          </GroupFold>
        );
      });
    const sessionGroups = gather(threads, groupKeyOf);
    // Grouped by session group, the groups branch when the list holds two or
    // more, no group among them, as the roll-ups or the rows loaded say;
    // with every session in one, or none in any, the sessions head the list,
    // as they do grouped by session or by topic.
    if (grouping !== "session_group" || Math.max(heads.groups, sessionGroups.length) < 2) {
      return sessionFolds(threads, top);
    }
    return sessionGroups.map(([key, held]) => {
      const group = held[0]?.group;
      return (
        <GroupFold
          key={key}
          header={groupHeader(key)}
          at={top}
          label={
            group === undefined
              ? bare("No group", { session_group: [noGroup] })
              : {
                  shown: (
                    <>
                      <Swatch color={palette.group(group.id)} />
                      {group.name}
                    </>
                  ),
                  spoken: `Group ${group.name}`,
                  narrowing: { session_group: [group.id] },
                }
          }
          rollup={heads.group(key)}
          folds={folds}
          list={list}
        >
          {sessionFolds(held, under(top))}
        </GroupFold>
      );
    });
  }
  return gather(threads, (thread) => thread.agent).map(([agent, held]) => {
    const sessions = gather(held, pathOf);
    // An agent's sessions branch when it has two or more, as the roll-ups or
    // the rows loaded say.
    const branches = Math.max(heads.sessionsOf(agent), sessions.length) >= 2;
    const inner = under(top);
    return (
      <GroupFold
        key={agent}
        header={agentHeader(agent)}
        at={top}
        label={located([["agent", agent]], { agent: [agent] })}
        rollup={heads.agent(agent)?.rollup}
        presence={heads.agent(agent)?.presence}
        folds={folds}
        list={list}
      >
        {branches
          ? sessions.map(([path, inSession]) => (
              <GroupFold
                key={path}
                header={sessionHeader(path)}
                at={inner}
                label={located([["session", inSession[0]?.session ?? ""]], { session: [path] })}
                rollup={heads.session(path)?.rollup}
                presence={heads.session(path)?.presence}
                folds={folds}
                list={list}
              >
                {rowsOf(inSession, under(inner).level)}
              </GroupFold>
            ))
          : rowsOf(held, inner.level)}
      </GroupFold>
    );
  });
}
