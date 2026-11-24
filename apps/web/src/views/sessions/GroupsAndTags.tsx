import {
  type GroupRead,
  type GroupRef,
  groupName,
  maxGroups,
  maxTags,
  tagName,
} from "@wayfarerlabs/agention-server-api";
import { useId, useRef, useState } from "react";
import { request } from "../../api.ts";
import { Failure } from "../../components.tsx";
import { useAction, useResource } from "../../data.ts";
import {
  loadGroupsAndTags,
  nameKey,
  nameProblem,
  OrganizedChip,
  usePalette,
} from "../../organizing.tsx";
import { FilterLink } from "../filter-links.tsx";
import { Picker, type PickerItem } from "./Picker.tsx";

// The operator's session groups and tags in the sessions view: the chips
// that show them on sessions and agents, each in its color and linking to
// its threads; and the pickers that choose a session's group and an agent's
// or a session's tags, each opened from its options menu or from a
// registration's approval. A picker loads the groups and tags as it opens.

// GroupChip shows a session's group, and TagChip one of a session's or an
// agent's tags, each in its color and linking to the threads in that group
// or carrying that tag on the thread list, with no other filter on.
export function GroupChip({ group }: { group: GroupRef }) {
  const palette = usePalette();
  return (
    <FilterLink narrowing={{ session_group: [group.id] }} spoken={`Threads in group ${group.name}`}>
      <OrganizedChip kind="group" name={group.name} color={palette.group(group.id)} />
    </FilterLink>
  );
}

export function TagChip({ tag }: { tag: string }) {
  const palette = usePalette();
  return (
    <FilterLink narrowing={{ tag: [tag] }} spoken={`Threads tagged ${tag}`}>
      <OrganizedChip kind="tag" name={tag} color={palette.tag(tag)} />
    </FilterLink>
  );
}

// What a picker's list says when it has nothing to list: why it could not
// load, that it is loading, that there is nothing yet, or that nothing
// matches.
function emptyWords(
  kind: "groups" | "tags",
  failure: unknown,
  loaded: boolean,
  any: boolean,
): string {
  return failure !== undefined && !loaded
    ? `The ${kind} could not be loaded.`
    : !loaded
      ? "Loading…"
      : any
        ? "None match."
        : `No ${kind} yet. Type a name to create one.`;
}

// GroupPicker chooses a group: one of the operator's, in their order, no
// group, offered as Clear group while there is one, or a new group named as
// typed, which it creates first. choose applies the choice, saying whether
// it did; once it has, the picker closes.
export function GroupPicker({
  label,
  anchor,
  group,
  choose,
  failure,
  onClose,
}: {
  label: string;
  anchor: HTMLElement | null;
  // The group chosen now, null for none.
  group: GroupRef | null;
  choose: (group: GroupRead | null) => Promise<boolean> | boolean;
  // Why choosing last failed, for the picker to say.
  failure?: unknown;
  onClose: () => void;
}) {
  const id = useId();
  const known = useResource(loadGroupsAndTags);
  const create = useAction();
  const chosen = async (picked: GroupRead | null) =>
    picked?.id === group?.id || (await choose(picked)) ? ("close" as const) : undefined;
  const list = (typed: string) => {
    const groups = known.data?.groups ?? [];
    const words = nameKey(typed);
    const shown = groups.filter((each) => nameKey(each.name).includes(words));
    const problem = typed === "" ? undefined : nameProblem(groupName, "name", typed);
    const taken = groups.some((each) => nameKey(each.name) === words);
    const full = groups.length >= maxGroups;
    const items: PickerItem[] = [
      ...(group !== null && typed === ""
        ? [{ key: "clear", content: "Clear group", pick: () => chosen(null) }]
        : []),
      ...shown.map((each) => ({
        key: String(each.id),
        content: <OrganizedChip kind="group" name={each.name} color={each.color} />,
        chosen: each.id === group?.id,
        pick: () => chosen(each),
      })),
      ...(known.data !== undefined && typed !== "" && !taken && problem === undefined
        ? [
            {
              key: "create",
              content: <>Create group “{typed}”</>,
              disabled: full,
              describedBy: full ? `${id}-full` : undefined,
              pick: async () => {
                const made = await create.run((csrf) =>
                  request<GroupRead>("POST", "/groups", { csrf, body: { name: typed } }),
                );
                known.refresh();
                return made === undefined ? undefined : chosen(made);
              },
            },
          ]
        : []),
    ];
    return {
      items,
      empty: emptyWords("groups", known.failure, known.data !== undefined, groups.length > 0),
      notes: (
        <>
          {problem !== undefined && <p className="field-error">{problem}</p>}
          {full && (
            <p id={`${id}-full`} className="muted">
              There can be at most {maxGroups} groups.
            </p>
          )}
          <Failure failure={create.failure ?? failure} />
        </>
      ),
    };
  };
  return (
    <Picker
      label={label}
      searchLabel="Search or create groups"
      anchor={anchor}
      multiple={false}
      list={list}
      onClose={onClose}
    />
  );
}

// TagsPicker chooses tags: each of the operator's tags, in name order, those
// chosen checked, and a new tag named as typed. Each pick applies at once,
// choose setting the whole set, one at a time as the picker takes them; one
// whose choice fails shows the tags as last taken again. Once as many are
// chosen as one can carry, the tags not chosen are unavailable, and a line
// says why.
export function TagsPicker({
  label,
  anchor,
  tags,
  choose,
  failure,
  onClose,
}: {
  label: string;
  anchor: HTMLElement | null;
  tags: string[];
  choose: (tags: string[]) => Promise<boolean> | boolean;
  failure?: unknown;
  onClose: () => void;
}) {
  const id = useId();
  const known = useResource(loadGroupsAndTags);
  // The tags as shown, the pick under way among them, and as choose last
  // took them, which a pick starts from and a failed one shows again.
  const [chosen, setChosen] = useState(tags);
  const taken = useRef(tags);
  const toggle = async (tag: string) => {
    const from = taken.current;
    const next = from.includes(tag) ? from.filter((each) => each !== tag) : [...from, tag];
    setChosen(next);
    if (await choose(next)) {
      taken.current = next;
    } else {
      setChosen(from);
    }
  };
  const list = (typed: string) => {
    const words = typed.toLowerCase();
    const colors = new Map(known.data?.tags.map((each) => [each.name, each.color]));
    const all = [...new Set([...colors.keys(), ...tags, ...chosen])].sort();
    const shown = all.filter((tag) => tag.includes(words));
    const full = chosen.length >= maxTags;
    const problem = words === "" ? undefined : nameProblem(tagName, "tag", words);
    const items: PickerItem[] = [
      ...shown.map((tag) => {
        const on = chosen.includes(tag);
        return {
          key: tag,
          content: <OrganizedChip kind="tag" name={tag} color={colors.get(tag)} />,
          chosen: on,
          disabled: full && !on,
          describedBy: full && !on ? `${id}-full` : undefined,
          pick: async () => {
            await toggle(tag);
            return undefined;
          },
        };
      }),
      ...(words !== "" && problem === undefined && !all.includes(words)
        ? [
            {
              key: "create",
              content: <>Create tag “{words}”</>,
              disabled: full,
              describedBy: full ? `${id}-full` : undefined,
              pick: async () => {
                await toggle(words);
                return "clear" as const;
              },
            },
          ]
        : []),
    ];
    return {
      items,
      empty: emptyWords("tags", known.failure, known.data !== undefined, all.length > 0),
      notes: (
        <>
          {problem !== undefined && <p className="field-error">{problem}</p>}
          {full && (
            <p id={`${id}-full`} className="muted">
              At most {maxTags} tags can be on one.
            </p>
          )}
          <Failure failure={failure} />
        </>
      ),
    };
  };
  return (
    <Picker
      label={label}
      searchLabel="Search or create tags"
      anchor={anchor}
      multiple
      list={list}
      onClose={onClose}
    />
  );
}

// SessionGroupPicker sets a session's group as it is picked.
export function SessionGroupPicker({
  agent,
  session,
  group,
  anchor,
  onChanged,
  onClose,
}: {
  agent: string;
  session: string;
  group: GroupRef | undefined;
  anchor: HTMLElement | null;
  onChanged: () => void;
  onClose: () => void;
}) {
  const action = useAction();
  return (
    <GroupPicker
      label={`Group for ${agent}/${session}`}
      anchor={anchor}
      group={group ?? null}
      failure={action.failure}
      choose={async (picked) => {
        const done = await action.run((csrf) =>
          request("POST", `/s/${agent}/${session}/group`, {
            csrf,
            body: { group: picked?.id ?? null },
          }),
        );
        if (done !== undefined) {
          onChanged();
        }
        return done !== undefined;
      }}
      onClose={onClose}
    />
  );
}

// TagsSetter sets an agent's or a session's tags as each is picked, the
// picker taking no other pick until the change settles.
export function TagsSetter({
  label,
  path,
  tags,
  anchor,
  onChanged,
  onClose,
}: {
  label: string;
  // The API path that sets the tags.
  path: string;
  tags: string[];
  anchor: HTMLElement | null;
  onChanged: () => void;
  onClose: () => void;
}) {
  const action = useAction();
  return (
    <TagsPicker
      label={label}
      anchor={anchor}
      tags={tags}
      failure={action.failure}
      choose={async (next) => {
        const done = await action.run((csrf) =>
          request("POST", path, { csrf, body: { tags: next } }),
        );
        if (done !== undefined) {
          onChanged();
        }
        return done !== undefined;
      }}
      onClose={onClose}
    />
  );
}
