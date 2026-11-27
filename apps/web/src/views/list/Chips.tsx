import type {
  Color,
  GroupsAndTags,
  impactFilter,
  priorityFilter,
  SessionGroupsFilter,
  ThreadsView,
} from "@wayfarerlabs/agention-api";
import { PathBadge, type PathKind, pathWord } from "../../components.tsx";
import {
  effortLabel,
  plain,
  plural,
  priorityLabel,
  statusLabel,
  type TerseLabel,
} from "../../format.tsx";
import { Icon } from "../../icons.tsx";
import { Swatch } from "../../organizing.tsx";
import { SessionPageLink } from "../session-page-link.tsx";
import { groupNamed, removedGroup, sessionOf, tagKept, topicShown } from "./listing.ts";

// The filters that are on, each a chip beneath the list's head that removes
// it.

// The priority a filter keeps asks at or above.
export const priorityAtLeast: Record<(typeof priorityFilter.options)[number], TerseLabel> = {
  normal: { shown: "Normal+", spoken: `${priorityLabel.normal} or more` },
  high: { shown: "High+", spoken: `${priorityLabel.high} or more` },
  urgent: { shown: "Urgent", spoken: priorityLabel.urgent },
};

export const impactShown: Record<(typeof impactFilter.options)[number], string> = {
  blocking: "Blocking",
  assuming: "Assuming",
};

// A filter that is on: its chip's label, as shown and as said, what removing
// it changes, and, for a filter on where threads are, the part of it whose
// badge the chip shows, and the one session it names, whose page a link
// beside it opens.
interface Chip {
  key: string;
  kind?: PathKind;
  session?: { agent: string; session: string } | undefined;
  // The icon a chip on pull requests or branches shows before its label.
  icon?: "branch";
  // The color of the one group or tag a chip names, when known.
  color?: Color | undefined;
  label: TerseLabel;
  remove: Partial<ThreadsView>;
}

// several labels the values chosen of a filter on where threads are, which
// a chip shows beside the badge of its part: the one value, shown short and
// said whole after its part's word, such as "Topic builder/main/auth", or
// how many, such as "2 topics".
function several(kind: PathKind, values: string[], shown: (value: string) => string): TerseLabel {
  const [one] = values;
  return values.length === 1 && one !== undefined
    ? { shown: shown(one), spoken: `${pathWord(kind)} ${one}` }
    : plain(plural(values.length, kind));
}

// groupsLabel labels the groups chosen, by their names as the operator's
// groups and tags say: the one group by its name, or how many, saying how
// many of them were removed, since a removed group keeps nothing. A label
// that says so leads with it, so cutting the label short never cuts it.
function groupsLabel(groups: SessionGroupsFilter, known: GroupsAndTags | undefined): TerseLabel {
  const names = groups.map((group) => groupNamed(group, known));
  const [one] = names;
  if (names.length === 1) {
    return one === removedGroup
      ? { shown: "Removed group", spoken: "Removed group, keeping nothing" }
      : one === undefined
        ? plain(plural(1, "group"))
        : { shown: `Group: ${one}`, spoken: `Group ${one}` };
  }
  const removed = names.filter((name) => name === removedGroup).length;
  const several = plural(names.length, "group");
  return removed === 0
    ? plain(several)
    : { shown: `${several}, ${removed} removed`, spoken: `${several}, ${removed} removed` };
}

// tagsLabel labels the tags chosen: the one tag by its name, or how many,
// saying how many were removed, since a removed tag keeps nothing. A label
// that says so leads with it, as a removed group's does.
function tagsLabel(tags: string[], known: GroupsAndTags | undefined): TerseLabel {
  const removed = tags.filter((tag) => !tagKept(tag, known)).length;
  const [one] = tags;
  if (tags.length === 1 && one !== undefined) {
    return removed === 0
      ? { shown: `Tag: ${one}`, spoken: `Tag ${one}` }
      : { shown: `Removed tag: ${one}`, spoken: `Removed tag ${one}, keeping nothing` };
  }
  const several = plural(tags.length, "tag");
  return removed === 0
    ? plain(several)
    : { shown: `${several}, ${removed} removed`, spoken: `${several}, ${removed} removed` };
}

// entriesLabel labels the pull requests or branches chosen: the one by its
// short form, said after the word for its kind, or how many.
function entriesLabel(values: string[], kind: { one: string; several: string }): TerseLabel {
  const [one] = values;
  return values.length === 1 && one !== undefined
    ? { shown: one, spoken: `${kind.one} ${one}` }
    : plain(`${values.length} ${kind.several}`);
}

// oneOf gives what the one value chosen has, as its color, or nothing for
// several.
function oneOf<T, U>(values: T[], what: (value: T) => U | undefined): U | undefined {
  const [one] = values;
  return values.length === 1 && one !== undefined ? what(one) : undefined;
}

// chip gives a filter's chip while it is on: on is true, or the value it is
// on at, which each builds the chip from.
function chip<T>(on: T | false | undefined, each: (value: T) => Chip): Chip[] {
  return on === undefined || on === false ? [] : [each(on)];
}

// chipsOf gives the chips of the filters on in a list, naming groups and
// tags as the operator's groups and tags, when known, say they are.
export function chipsOf(view: ThreadsView, known?: GroupsAndTags): Chip[] {
  const { search, priority, impact, effort } = view;
  return [
    ...chip(search !== undefined, () => ({
      key: "search",
      label: { shown: `"${search}"`, spoken: `Search "${search}"` },
      remove: { search: undefined },
    })),
    ...chip(view.status, (status) => ({
      key: "status",
      label: plain(`Status: ${statusLabel[status].shown}`),
      remove: { status: undefined },
    })),
    ...chip(priority, (level) => ({
      key: "priority",
      label: priorityAtLeast[level],
      remove: { priority: undefined },
    })),
    ...chip(impact, (level) => ({
      key: "impact",
      label: plain(impactShown[level]),
      remove: { impact: undefined },
    })),
    ...chip(view.overdue, () => ({
      key: "overdue",
      label: plain("Overdue"),
      remove: { overdue: false },
    })),
    ...chip(effort, (level) => ({
      key: "effort",
      label: effortLabel[level],
      remove: { effort: undefined },
    })),
    ...chip(view.unread, () => ({
      key: "unread",
      label: plain("Unread"),
      remove: { unread: false },
    })),
    ...chip(view.agent_read, (read) => ({
      key: "agent_read",
      label: plain(read === "stranded" ? "Stranded" : "Unread by agent"),
      remove: { agent_read: undefined },
    })),
    ...chip(view.agent, (agents) => ({
      key: "agent",
      kind: "agent" as const,
      label: several("agent", agents, (agent) => agent),
      remove: { agent: undefined },
    })),
    ...chip(view.session, (sessions) => ({
      key: "session",
      kind: "session" as const,
      session: oneOf(sessions, sessionOf),
      label: several("session", sessions, (path) => sessionOf(path).session),
      remove: { session: undefined },
    })),
    ...chip(view.topic, (topics) => ({
      key: "topic",
      kind: "topic" as const,
      label: several("topic", topics, topicShown),
      remove: { topic: undefined },
    })),
    ...chip(view.session_group, (groups) => ({
      key: "session_group",
      color: oneOf(groups, (group) => known?.groups.find((each) => each.id === group)?.color),
      label: groupsLabel(groups, known),
      remove: { session_group: undefined },
    })),
    ...chip(view.tag, (tags) => ({
      key: "tag",
      color: oneOf(tags, (tag) => known?.tags.find((each) => each.name === tag)?.color),
      label: tagsLabel(tags, known),
      remove: { tag: undefined },
    })),
    ...chip(view.pull_request, (pulls) => ({
      key: "pull_request",
      icon: "branch" as const,
      label: entriesLabel(pulls, { one: "Pull request", several: "pull requests" }),
      remove: { pull_request: undefined },
    })),
    ...chip(view.branch, (branches) => ({
      key: "branch",
      icon: "branch" as const,
      label: entriesLabel(branches, { one: "Branch", several: "branches" }),
      remove: { branch: undefined },
    })),
    ...chip(view.include_archived, () => ({
      key: "include_archived",
      label: plain("Archived shown"),
      remove: { include_archived: false },
    })),
  ];
}

// The most characters a chip shows, a badge counting as two of them.
const chipLength = 20;
const badgeLength = 2;

// chipText fits a label to a chip, beside a badge or an icon when it has
// one. A label past the room is cut short with an ellipsis: a badged one,
// which names where threads are or a pull request or branch, at its front,
// so a topic keeps its own name, a pull request its number, and any name its
// end; any other at its end.
function chipText(label: string, badged: boolean): string {
  const room = chipLength - (badged ? badgeLength : 0);
  const characters = Array.from(label);
  if (characters.length <= room) {
    return label;
  }
  return badged
    ? `…${characters.slice(1 - room).join("")}`
    : `${characters.slice(0, room - 1).join("")}…`;
}

// Chips lists the filters that are on, each a button that removes it, in one
// row that wraps. A chip fits its label, cut short past a generous length,
// and carries the whole of it in words as its tooltip and in its name. A
// chip naming one session ends in a link to the session's page, a control
// of its own beside the button, so the chip still removes its filter.
export function Chips({ chips, remove }: { chips: Chip[]; remove: (chip: Chip) => void }) {
  if (chips.length === 0) {
    return null;
  }
  return (
    <div className="filter-row">
      {chips.map((chip) =>
        chip.session === undefined ? (
          <ChipButton key={chip.key} chip={chip} remove={remove} />
        ) : (
          <span key={chip.key} className="chip-split">
            <ChipButton chip={chip} remove={remove} />
            <SessionPageLink {...chip.session} className="chip" />
          </span>
        ),
      )}
    </div>
  );
}

// ChipButton is a chip's button, which removes its filter.
function ChipButton({ chip, remove }: { chip: Chip; remove: (chip: Chip) => void }) {
  return (
    <button
      type="button"
      className="chip"
      title={chip.label.spoken}
      aria-label={`Remove filter: ${chip.label.spoken}`}
      onClick={() => remove(chip)}
    >
      {chip.kind !== undefined && (
        <>
          <PathBadge kind={chip.kind} />{" "}
        </>
      )}
      {chip.icon !== undefined && <Icon name={chip.icon} />}
      <Swatch color={chip.color} />
      {chipText(chip.label.shown, chip.kind !== undefined || chip.icon !== undefined)}
      <span aria-hidden="true"> ×</span>
    </button>
  );
}
