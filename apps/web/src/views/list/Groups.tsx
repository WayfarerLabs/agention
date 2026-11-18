import {
  composePresence,
  composeRollup,
  type Presence,
  type Rollup,
  type ThreadGroups,
  type ThreadGrouping,
  type ThreadSummary,
} from "@wayfarerlabs/agention-api";
import { type ReactNode, useId } from "react";
import { PathParts, pathWord, type Place } from "../../components.tsx";
import { useDeviceNames } from "../../device.ts";
import { lastSeenWords, plural, priorityLabel, priorityTone, Since } from "../../format.tsx";
import { Icon, Mark } from "../../icons.tsx";
import { headings, ThreadRow } from "./ThreadRow.tsx";

// The list grouped, folding the rows loaded inline under headers: by
// session, each session's threads under their topics when they carry two or
// more; or by agent, each agent's under its sessions when it has two or
// more. The list arrives a group at a time, each group's threads together,
// but a group whose first thread changed between pages can arrive in two
// runs, so rows fold under their group's header whichever page brought them.
// Depth shows through the headers' styles, the outer a sticky, tinted bar and
// the inner a light subheader, rather than through indentation. Every header
// rolls up its whole group, loaded or not, from the roll-ups the list
// carries, a session's and an agent's saying when it was last seen while it
// is quiet, and starts expanded; the headers the operator collapses are kept
// on this device for each grouping.

type SessionGroup = ThreadGroups["sessions"][number];

const pathOf = (thread: { agent: string; session: string }) => `${thread.agent}/${thread.session}`;

// Each header's name on this device, by what it heads.
const sessionHeader = (path: string) => `session:${path}`;
const topicHeader = (path: string, topic: string | undefined) => `topic:${path}:${topic ?? ""}`;
const agentHeader = (agent: string) => `agent:${agent}`;

// What a header heads, for the eye: each part of where its threads are behind
// its badge, a topic named alone since its session is right above it, or no
// topic in words; and for assistive technology, such as "Agent reviewer
// Session main".
interface Headed {
  shown: ReactNode;
  spoken: string;
}

// located heads a group by the parts of where its threads are.
function located(place: Place): Headed {
  return {
    shown: <PathParts place={place} />,
    spoken: place.map(([kind, name]) => `${pathWord(kind)} ${name}`).join(" "),
  };
}

const bare = (text: string): Headed => ({ shown: text, spoken: text });

// The words a roll-up is said in, after what it heads: "Agent reviewer
// Session main, 12 threads, 3 unread, blocked on you, high priority, last
// seen 14:02".
function spokenRollup(label: string, rollup: Rollup, presence: Presence | undefined): string {
  return [
    label,
    plural(rollup.threads, "thread"),
    ...(rollup.unread > 0 ? [`${rollup.unread} unread`] : []),
    ...(rollup.blocked ? ["blocked on you"] : []),
    ...(rollup.priority === undefined ? [] : [priorityLabel[rollup.priority].toLowerCase()]),
    ...(rollup.archived ? ["archived"] : []),
    ...(presence?.quiet === true ? [lastSeenWords(presence)] : []),
  ].join(", ");
}

const priorityShown = { urgent: "Urgent", high: "High", normal: "Normal", low: "Low" } as const;

// UnreadCount says whether a group holds threads with messages the operator
// has not read: the closed envelope with how many, or the open envelope.
function UnreadCount({ unread }: { unread: number }) {
  return unread > 0 ? (
    <Mark icon="unread" label={`${unread} unread`} shown={unread} accent />
  ) : (
    <Mark icon="read" label="Read" />
  );
}

// RollupMarks shows a roll-up for the eye: how many threads, the closed
// envelope with how many are unread or the open envelope when none is,
// whether any is blocked on the operator, the highest priority open, the
// archive box when all are archived, and, muted while a session or an agent
// is quiet, when it was last seen. Its header's name says it.
function RollupMarks({ rollup, presence }: { rollup: Rollup; presence: Presence | undefined }) {
  return (
    <span className="roll-up" aria-hidden="true">
      <span className="roll-up-count">{plural(rollup.threads, "thread")}</span>
      <UnreadCount unread={rollup.unread} />
      {rollup.blocked && <span className="flag danger">Blocked</span>}
      {rollup.priority !== undefined && (
        <span className={`flag ${priorityTone[rollup.priority] ?? ""}`}>
          {priorityShown[rollup.priority]}
        </span>
      )}
      {rollup.archived && <Mark icon="archive" label="Archived" />}
      {presence?.quiet === true && (
        <span className="quiet">
          {presence.last_seen_at === undefined ? (
            "never seen"
          ) : (
            <>
              last seen <Since value={presence.last_seen_at} />
            </>
          )}
        </span>
      )}
    </span>
  );
}

// The headers the operator collapsed, and a way to fold or unfold one.
interface Folds {
  collapsed(header: string): boolean;
  toggle(header: string): void;
}

// Fold is a group under its header: a heading wrapping a disclosure button,
// named with the group's roll-up, and a session's or an agent's presence,
// when the list carries them. A collapsed header hides everything under it.
function Fold({
  header,
  outer,
  label,
  rollup,
  presence,
  folds,
  children,
}: {
  header: string;
  outer: boolean;
  label: Headed;
  rollup: Rollup | undefined;
  presence?: Presence | undefined;
  folds: Folds;
  children: ReactNode;
}) {
  const body = useId();
  const Heading = headings[outer ? 2 : 3];
  const collapsed = folds.collapsed(header);
  return (
    <section className={outer ? "group" : "subgroup"}>
      <Heading className={outer ? "group-head" : "subgroup-head"}>
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={body}
          aria-label={
            rollup === undefined ? label.spoken : spokenRollup(label.spoken, rollup, presence)
          }
          onClick={() => folds.toggle(header)}
        >
          <Icon name="expand" />
          <span className="group-label">{label.shown}</span>
          {rollup !== undefined && <RollupMarks rollup={rollup} presence={presence} />}
        </button>
      </Heading>
      <div id={body} hidden={collapsed}>
        {children}
      </div>
    </section>
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
// topic, and of each agent, its roll-up and presence composed from its
// sessions'. When the list left some groups out, the last agent listed may
// be missing sessions, so it shows none.
function headsOf(groups: ThreadGroups | undefined) {
  const sessions = new Map(groups?.sessions.map((each) => [pathOf(each), each]));
  const agents = gather(groups?.sessions ?? [], (each) => each.agent);
  const complete = groups?.truncated === true ? agents.slice(0, -1) : agents;
  const agentHeads = new Map(
    complete.map(([agent, held]) => [
      agent,
      {
        rollup: composeRollup(held.map((each) => each.rollup)),
        presence: composePresence(held.map((each) => each.presence)),
      },
    ]),
  );
  return {
    session: (path: string): SessionGroup | undefined => sessions.get(path),
    agent: (agent: string) => agentHeads.get(agent),
    sessionsOf: (agent: string) => agents.find(([name]) => name === agent)?.[1].length ?? 0,
  };
}

const rowsOf = (threads: ThreadSummary[], level: 3 | 4) => (
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
}: {
  threads: ThreadSummary[];
  groups: ThreadGroups | undefined;
  grouping: ThreadGrouping;
}) {
  const [collapsed, keepCollapsed] = useDeviceNames(`agention.collapsed-groups.${grouping}`);
  const folds: Folds = {
    collapsed: (header) => collapsed.has(header),
    toggle: (header) => {
      const next = new Set(collapsed);
      if (!next.delete(header)) {
        next.add(header);
      }
      keepCollapsed(next);
    },
  };
  const heads = headsOf(groups);
  if (grouping === "session") {
    return gather(threads, pathOf).map(([path, held]) => {
      const [first] = held;
      const session = heads.session(path);
      const topics = gather(held, (thread) => thread.topic ?? "");
      // A session's topics branch when it carries two or more, as its
      // roll-up or the rows loaded say.
      const branches = Math.max(session?.topics?.length ?? 0, topics.length) >= 2;
      return (
        <Fold
          key={path}
          header={sessionHeader(path)}
          outer
          label={located([
            ["agent", first?.agent ?? ""],
            ["session", first?.session ?? ""],
          ])}
          rollup={session?.rollup}
          presence={session?.presence}
          folds={folds}
        >
          {branches
            ? topics.map(([, under]) => {
                const topic = under[0]?.topic;
                return (
                  <Fold
                    key={topic ?? ""}
                    header={topicHeader(path, topic)}
                    outer={false}
                    label={topic === undefined ? bare("No topic") : located([["topic", topic]])}
                    rollup={session?.topics?.find((each) => each.topic === topic)?.rollup}
                    folds={folds}
                  >
                    {rowsOf(under, 4)}
                  </Fold>
                );
              })
            : rowsOf(held, 3)}
        </Fold>
      );
    });
  }
  return gather(threads, (thread) => thread.agent).map(([agent, held]) => {
    const sessions = gather(held, pathOf);
    // An agent's sessions branch when it has two or more, as the roll-ups or
    // the rows loaded say.
    const branches = Math.max(heads.sessionsOf(agent), sessions.length) >= 2;
    return (
      <Fold
        key={agent}
        header={agentHeader(agent)}
        outer
        label={located([["agent", agent]])}
        rollup={heads.agent(agent)?.rollup}
        presence={heads.agent(agent)?.presence}
        folds={folds}
      >
        {branches
          ? sessions.map(([path, under]) => (
              <Fold
                key={path}
                header={sessionHeader(path)}
                outer={false}
                label={located([["session", under[0]?.session ?? ""]])}
                rollup={heads.session(path)?.rollup}
                presence={heads.session(path)?.presence}
                folds={folds}
              >
                {rowsOf(under, 4)}
              </Fold>
            ))
          : rowsOf(held, 3)}
      </Fold>
    );
  });
}
