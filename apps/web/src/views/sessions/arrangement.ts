import { type GroupRef, noGroup, type SessionSummary } from "@wayfarerlabs/agention-api";
import type { Agents } from "../../api.ts";
import { needsYou, observedOf } from "../../format.tsx";
import { nameKey } from "../../organizing.tsx";

// How the sessions view arranges its sessions, as the thread list arranges
// its threads: how it groups them, how it sorts them at every level, and in
// which direction. Grouped by session group, the groups hold their agents,
// which hold their sessions; by agent, the agents hold their sessions; by
// session, the sessions stand alone, in one list. Sorted alphabetically,
// each level goes by its name; by registration time, a session goes by when
// it was approved, created by its first approval, and an agent or a group by
// its earliest session, newest first, as the thread list's Created starts;
// reversed, every level runs the other way. Manual is
// offered only grouped by session group: the groups go in the operator's
// order, the agents and sessions within them alphabetically, and it has no
// direction. Under any of them, no group comes last. The view's one filter,
// Needs you, keeps only the sessions that need the operator (sessionNeedsYou),
// and the agents and groups holding any, arranged as they would be without
// it. All of it lives in the address, as
// /sessions?group=agent&sort=registered&reverse=true&needs_you=true, each part
// left out at its default: grouped by session group, sorted manually, or,
// grouped otherwise, alphabetically, in the sort's own direction, and with no
// filter.

export const sessionGroupings = ["session_group", "agent", "session"] as const;
export type SessionGrouping = (typeof sessionGroupings)[number];

export const sessionSorts = ["manual", "alphabetic", "registered"] as const;
export type SessionSort = (typeof sessionSorts)[number];

export interface SessionsView {
  group: SessionGrouping;
  sort: SessionSort;
  reverse: boolean;
  needsYou: boolean;
}

// The sorts a grouping offers, in the order the operator is offered them,
// and the one it takes by default.
export const sortsOf = (group: SessionGrouping): readonly SessionSort[] =>
  group === "session_group" ? sessionSorts : sessionSorts.filter((each) => each !== "manual");
const defaultSortOf = (group: SessionGrouping): SessionSort =>
  group === "session_group" ? "manual" : "alphabetic";

// sessionsViewOf reads the arrangement an address names, each part given
// once and one the view takes, or else at its default: a sort the grouping
// does not offer is its default, and Manual is never reversed.
export function sessionsViewOf(search: URLSearchParams): SessionsView {
  const one = (part: string) => {
    const given = search.getAll(part);
    return given.length === 1 ? given[0] : undefined;
  };
  const group = sessionGroupings.find((each) => each === one("group")) ?? "session_group";
  const sort = sortsOf(group).find((each) => each === one("sort")) ?? defaultSortOf(group);
  return {
    group,
    sort,
    reverse: sort !== "manual" && one("reverse") === "true",
    needsYou: one("needs_you") === "true",
  };
}

// sessionsQuery writes an arrangement as the address's query, its parts not
// at their default, in the order sessionsViewOf names them.
export function sessionsQuery(view: SessionsView): string {
  const parts = new URLSearchParams();
  if (view.group !== "session_group") {
    parts.set("group", view.group);
  }
  if (view.sort !== defaultSortOf(view.group)) {
    parts.set("sort", view.sort);
  }
  if (view.reverse) {
    parts.set("reverse", "true");
  }
  if (view.needsYou) {
    parts.set("needs_you", "true");
  }
  const text = parts.toString();
  return text === "" ? "" : `?${text}`;
}

// regrouped gives the arrangement another grouping leaves: the sort and its
// direction as they were, while the grouping offers that sort, and else its
// default sort in its own direction; the filter stays as it was.
export function regrouped(view: SessionsView, group: SessionGrouping): SessionsView {
  return sortsOf(group).includes(view.sort)
    ? { ...view, group }
    : { group, sort: defaultSortOf(group), reverse: false, needsYou: view.needsYou };
}

// sessionNeedsYou says whether a session needs the operator: its terminal,
// as its bridge last observed it, shows a permission prompt or another
// prompt, or something that stopped it.
export const sessionNeedsYou = (session: SessionSummary): boolean =>
  needsYou(observedOf(session.presence));

// keepNeedingYou keeps, of each agent, the sessions that need the operator,
// and the agents left holding any.
function keepNeedingYou(agents: Agents): Agents {
  return agents.flatMap((entry) => {
    const sessions = entry.sessions.filter(sessionNeedsYou);
    return sessions.length === 0 ? [] : [{ ...entry, sessions }];
  });
}

// An agent with its sessions as the view arranges them: all of them, or
// under a group, those in that group.
export type Held = Agents[number];

// A group of the view: the group, absent for no group, and its agents.
export interface GroupFold {
  group: GroupRef | undefined;
  agents: Held[];
}

// A session standing alone, with its agent, as grouped by session.
export interface Lone {
  agent: string;
  session: SessionSummary;
}

// What the view shows: groups, each holding its agents; agents, as grouped
// by agent or by session group while no session is in any; or sessions.
export type Arranged =
  | { kind: "groups"; groups: GroupFold[] }
  | { kind: "agents"; agents: Held[] }
  | { kind: "sessions"; sessions: Lone[] };

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// The earliest time any of some sessions was approved, as the API writes
// it, which sorts as text.
const earliest = (sessions: SessionSummary[]) =>
  sessions.reduce<string | undefined>(
    (first, session) =>
      first === undefined || session.created_at < first ? session.created_at : first,
    undefined,
  ) ?? "";

// byNames compares things by their names, part by part, as an agent's and
// then a session's.
const byNames = (a: readonly string[], b: readonly string[]) =>
  a.reduce((order, part, index) => order || byText(part, b[index] ?? ""), 0);

// sorted puts things in an arrangement's order: by their names, A to Z; by
// registration time, by their earliest session, newest first, their names
// A to Z breaking a tie; and Manual by their names, as it is never
// reversed. Reversed, the names or the times run the other way.
function sorted<T>(
  view: SessionsView,
  things: T[],
  names: (thing: T) => readonly string[],
  sessions: (thing: T) => SessionSummary[],
): T[] {
  const sign = view.reverse ? -1 : 1;
  return [...things].sort((a, b) =>
    view.sort === "registered"
      ? -sign * byText(earliest(sessions(a)), earliest(sessions(b))) || byNames(names(a), names(b))
      : sign * byNames(names(a), names(b)),
  );
}

// arrangeAgents sorts agents and the sessions each holds.
function arrangeAgents(view: SessionsView, agents: Held[]): Held[] {
  return sorted(
    view,
    agents.map((entry) => ({
      ...entry,
      sessions: sorted(
        view,
        entry.sessions,
        (session) => [session.session],
        (session) => [session],
      ),
    })),
    (entry) => [entry.agent],
    (entry) => entry.sessions,
  );
}

// foldByGroup splits each agent's sessions by their group, each group
// holding the agents with sessions in it, each with that group's sessions
// only.
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
  return [...folds.values()];
}

// A group's key: its id, since a group can be renamed, or none.
export const groupKeyOf = (group: GroupRef | undefined) =>
  group === undefined ? noGroup : String(group.id);

// arrange gives what the view shows of the agents under an arrangement and
// its filter, the groups in the operator's order, by their ids, when Manual,
// any the order does not hold yet after them by name. Whether the agents
// fold under their groups goes by every session, so the filter never
// changes it.
export function arrange(view: SessionsView, all: Agents, order: number[]): Arranged {
  const grouped = all.some((entry) =>
    entry.sessions.some((session) => session.group !== undefined),
  );
  const agents = view.needsYou ? keepNeedingYou(all) : all;
  if (view.group === "session") {
    const lone = agents.flatMap((entry) =>
      entry.sessions.map((session) => ({ agent: entry.agent, session })),
    );
    return {
      kind: "sessions",
      sessions: sorted(
        view,
        lone,
        ({ agent, session }) => [agent, session.session],
        ({ session }) => [session],
      ),
    };
  }
  if (view.group === "agent" || !grouped) {
    return { kind: "agents", agents: arrangeAgents(view, agents) };
  }
  const folds = foldByGroup(agents).map((fold) => ({
    ...fold,
    agents: arrangeAgents(view, fold.agents),
  }));
  const groups = folds.filter((fold) => fold.group !== undefined);
  const none = folds.filter((fold) => fold.group === undefined);
  // A group's name is its own, whatever the case of its letters.
  const name = (fold: GroupFold) => [nameKey(fold.group?.name ?? "")];
  const place = (fold: GroupFold) => {
    const at = order.indexOf(fold.group?.id ?? -1);
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  };
  const placed =
    view.sort === "manual"
      ? [...groups].sort((a, b) => place(a) - place(b) || byNames(name(a), name(b)))
      : sorted(view, groups, name, (fold) => fold.agents.flatMap((entry) => entry.sessions));
  return { kind: "groups", groups: [...placed, ...none] };
}
