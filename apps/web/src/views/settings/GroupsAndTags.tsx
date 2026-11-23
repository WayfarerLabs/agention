import { Loadable } from "../../components.tsx";
import { useResource } from "../../data.ts";
import { loadGroupsAndTags } from "../../organizing.tsx";
import { GroupList } from "./GroupList.tsx";
import { TagList } from "./TagList.tsx";

// Settings' groups and tags: every session group, in the operator's order,
// and every tag, in name order, each in a list with a search box that narrows
// it and New, which names one to create. Each group or tag shows as its chip,
// with what it holds, linking to those threads as the chips do, and Rename,
// its color and Remove, which asks first, saying what it takes the group or
// tag off. Groups move up and down the order by their buttons, or, with a
// mouse, by dragging their handle, each move sending the whole order; one the
// server refuses, as when another client changed the groups since, reloads
// them.
export function GroupsAndTagsSection() {
  const known = useResource(loadGroupsAndTags);
  return (
    <Loadable data={known.data} failure={known.failure} retry={known.refresh}>
      {({ groups, tags, truncated }) => (
        <>
          <GroupList groups={groups} refresh={known.refresh} />
          <TagList tags={tags} truncated={truncated} refresh={known.refresh} />
        </>
      )}
    </Loadable>
  );
}
