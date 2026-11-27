import type { Color, GroupRead, GroupRef, SessionSummary } from "@wayfarerlabs/agention-api";
import { type ReactNode, useRef, useState } from "react";
import { OrganizedChip, usePalette } from "../../organizing.tsx";
import { GroupPicker, TagsPicker } from "./GroupsAndTags.tsx";

// What an approval sets of its session's group and tags: those picked alone,
// null for no group, the rest left as they are.
interface Picks {
  group?: number | null;
  tags?: string[];
}

// useOrganize picks the group and tags of the session an approval grants:
// fields showing those it will have, each a button opening its picker, and
// what was picked for the approval to send, and what they show. Unpicked, a
// new session has none and an existing one keeps its own, which the pickers
// start from; before a session is chosen, they start from the one the form
// names as own, if any. The picks
// belong to the destination they were made for, the session as the form
// names it, new or existing, under its agent: another agent, or another
// session once one was chosen, starts them over, and a pick landing after
// that, as a group created in a picker since closed, is dropped. Picks made
// before a session is chosen are for whichever session is approved, so
// choosing one keeps them.
export function useOrganize({
  id,
  label,
  destination,
  own,
  hint,
}: {
  id: string;
  // What the pickers are for, such as "registration 7KQ2M-X9DPA".
  label: string;
  // Where the approval grants, as the form names it: its agent, such as
  // "existing:builder", and an existing session by its name or a new one,
  // such as "existing:main" or "new", or undefined while none is chosen.
  destination: { agent: string; session: string | undefined };
  // The existing session whose group and tags the pickers start from: the
  // one approved onto, if it is one.
  own: SessionSummary | undefined;
  // What the hint under the legend says the picks do.
  hint: string;
}): { picked: Picks; shown: { group: number | null; tags: string[] }; fields: ReactNode } {
  // The group and tags picked, undefined while not picked, null for no
  // group; and the picker open, beside the button that opened it.
  const [group, setGroup] = useState<GroupRead | null>();
  const [tags, setTags] = useState<string[]>();
  const [picking, setPicking] = useState<{ kind: "group" | "tags"; opener: HTMLElement }>();
  // For the group and for the tags apart, how many times that pick has
  // changed, by a pick or by starting over, so a pick that lands late, as a
  // group created in a picker since closed, never undoes a pick of the same
  // since, nor lands after the picks started over. A pick of the tags leaves
  // a late group standing, and the other way round.
  const applied = useRef({ group: 0, tags: 0 });
  const [pickedFor, setPickedFor] = useState(destination);
  if (pickedFor.agent !== destination.agent || pickedFor.session !== destination.session) {
    setPickedFor(destination);
    if (pickedFor.agent !== destination.agent || pickedFor.session !== undefined) {
      applied.current.group++;
      applied.current.tags++;
      setGroup(undefined);
      setTags(undefined);
    }
  }
  const seen = { ...applied.current };
  const pickFor =
    <T,>(kind: "group" | "tags", set: (picked: T) => void) =>
    (picked: T) => {
      if (applied.current[kind] !== seen[kind]) {
        return false;
      }
      applied.current[kind]++;
      set(picked);
      return true;
    };
  // The group and tags shown: those picked, or else its own.
  const shownGroup: (GroupRef & { color?: Color }) | null =
    group !== undefined ? group : (own?.group ?? null);
  const shownTags = tags ?? own?.tags ?? [];
  const donePicking = () => {
    setPicking(undefined);
    picking?.opener.focus({ preventScroll: true });
  };
  return {
    picked: {
      ...(group === undefined ? {} : { group: group?.id ?? null }),
      ...(tags === undefined ? {} : { tags }),
    },
    shown: { group: shownGroup?.id ?? null, tags: shownTags },
    fields: (
      <>
        <Organize
          id={id}
          hint={hint}
          group={shownGroup}
          tags={shownTags}
          open={(kind, opener) => setPicking({ kind, opener })}
        />
        {picking?.kind === "group" && (
          <GroupPicker
            label={`Group for ${label}`}
            anchor={picking.opener}
            group={shownGroup}
            choose={pickFor("group", setGroup)}
            onClose={donePicking}
          />
        )}
        {picking?.kind === "tags" && (
          <TagsPicker
            label={`Tags for ${label}`}
            anchor={picking.opener}
            tags={shownTags}
            choose={pickFor("tags", setTags)}
            onClose={donePicking}
          />
        )}
      </>
    ),
  };
}

// Organize offers the session's group and tags, each a button opening its
// picker, beside those the session will have, in their colors, or that it
// will have none, under a hint saying what the picks do.
function Organize({
  id,
  hint,
  group,
  tags,
  open,
}: {
  id: string;
  hint: string;
  group: (GroupRef & { color?: Color | undefined }) | null;
  tags: string[];
  open: (kind: "group" | "tags", opener: HTMLElement) => void;
}) {
  const palette = usePalette();
  return (
    <fieldset>
      <legend>Group and tags</legend>
      <p className="hint">{hint}</p>
      <div className="organize-pick">
        <button
          type="button"
          className="secondary"
          aria-haspopup="dialog"
          aria-describedby={`${id}-group`}
          onClick={(event) => open("group", event.currentTarget)}
        >
          Group
        </button>
        <span id={`${id}-group`}>
          {group === null ? (
            "No group"
          ) : (
            <OrganizedChip
              kind="group"
              name={group.name}
              color={group.color ?? palette.group(group.id)}
              spoken
            />
          )}
        </span>
      </div>
      <div className="organize-pick">
        <button
          type="button"
          className="secondary"
          aria-haspopup="dialog"
          aria-describedby={`${id}-tags`}
          onClick={(event) => open("tags", event.currentTarget)}
        >
          Tags
        </button>
        <span id={`${id}-tags`} className="organize-picked">
          {tags.length === 0
            ? "No tags"
            : tags.map((tag) => (
                <OrganizedChip key={tag} kind="tag" name={tag} color={palette.tag(tag)} spoken />
              ))}
        </span>
      </div>
    </fieldset>
  );
}
