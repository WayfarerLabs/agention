import type { impactFilter, priorityFilter, ThreadsView } from "@wayfarerlabs/agention-api";
import { PathBadge, type PathKind, pathWord } from "../../components.tsx";
import {
  effortLabel,
  plain,
  plural,
  priorityLabel,
  statusLabel,
  type TerseLabel,
} from "../../format.tsx";
import { sessionOf, topicShown } from "./listing.ts";

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
// badge the chip shows.
interface Chip {
  key: string;
  kind?: PathKind;
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

// chip gives a filter's chip while it is on: on is true, or the value it is
// on at, which each builds the chip from.
function chip<T>(on: T | false | undefined, each: (value: T) => Chip): Chip[] {
  return on === undefined || on === false ? [] : [each(on)];
}

export function chipsOf(view: ThreadsView): Chip[] {
  const { search, priority, impact, effort } = view;
  return [
    ...chip(search !== undefined, () => ({
      key: "search",
      label: { shown: `“${search}”`, spoken: `Search “${search}”` },
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
      label: several("session", sessions, (path) => sessionOf(path).session),
      remove: { session: undefined },
    })),
    ...chip(view.topic, (topics) => ({
      key: "topic",
      kind: "topic" as const,
      label: several("topic", topics, topicShown),
      remove: { topic: undefined },
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

// chipText fits a label to a chip, beside a badge when it has one. A label
// past the room is cut short with an ellipsis: a badged one, which names
// where threads are, at its front, so a topic keeps its own name and any
// name its end; any other at its end.
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
// and carries the whole of it in words as its tooltip and in its name.
export function Chips({ chips, remove }: { chips: Chip[]; remove: (chip: Chip) => void }) {
  if (chips.length === 0) {
    return null;
  }
  return (
    <div className="filter-row">
      {chips.map((chip) => (
        <button
          key={chip.key}
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
          {chipText(chip.label.shown, chip.kind !== undefined)}
          <span aria-hidden="true"> ×</span>
        </button>
      ))}
    </div>
  );
}
