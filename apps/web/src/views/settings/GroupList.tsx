import { type GroupsAndTags, maxGroups } from "@wayfarerlabs/agention-api";
import { useId } from "react";
import { request } from "../../api.ts";
import { Failure, Status, useFocusWhenShown } from "../../components.tsx";
import { useAction } from "../../data.ts";
import { plural } from "../../format.tsx";
import { nameKey } from "../../organizing.tsx";
import { MoveButtons, useGroupOrder } from "../group-order.tsx";
import { focusNext, HoldsLink, ListHead, Organized, useSearch } from "./Organizer.tsx";

type Group = GroupsAndTags["groups"][number];

// GroupList is Settings' list of groups, in the operator's order, each moved
// up or down it by its buttons, or, with a mouse, dragged by its handle onto
// another to take that one's place. Each move sends the whole order and, while
// it is under way, the list shows the order sent and takes no other move, its
// buttons staying where they are, focus with them; once it settles, the list
// shows the groups as they reload. One the server refuses, as when another
// client changed the groups since, shows them as they are.
export function GroupList({
  groups,
  failure,
  refresh,
}: {
  groups: Group[];
  // Why the groups last failed to load, until they load.
  failure: unknown;
  refresh: () => Promise<boolean>;
}) {
  const id = useId();
  const [search, words] = useSearch("Search groups");
  const create = useAction();
  const focus = useFocusWhenShown(groups);
  const order = useGroupOrder({ groups, failure, refresh, focus });
  const byId = new Map(groups.map((group) => [group.id, group]));
  const ordered = order.ordered.flatMap((each) => byId.get(each) ?? []);
  const shown = ordered.filter((group) => nameKey(group.name).includes(words));
  const all = ordered.map((group) => group.id);
  const rowOf = (group: number) => `${id}-row-${group}`;
  const narrowed = words !== "";
  return (
    <section aria-labelledby={`${id}-heading`} className="organizer-section">
      <ListHead
        heading="Groups"
        headingId={`${id}-heading`}
        newId={`${id}-new`}
        kind="group"
        search={search}
        full={groups.length >= maxGroups ? `There can be at most ${maxGroups} groups.` : undefined}
        create={async (name) => {
          const made = await create.run((csrf) =>
            request("POST", "/groups", { csrf, body: { name } }),
          );
          refresh();
          return made !== undefined;
        }}
      />
      <Failure failure={create.failure} />
      <Failure failure={order.failure}>
        <p>The list shows the groups as they are now.</p>
      </Failure>
      <Status>{order.said}</Status>
      {narrowed && groups.length > 1 && (
        <p id={`${id}-narrowed`} className="muted">
          Clear the search to move groups.
        </p>
      )}
      {groups.length === 0 ? (
        <p className="muted">No groups yet.</p>
      ) : shown.length === 0 ? (
        <p className="muted">None match.</p>
      ) : (
        <ul className="organizer">
          {shown.map((group) => {
            return (
              <Organized
                key={group.id}
                kind="group"
                name={group.name}
                color={group.color}
                path={`/groups/${group.id}`}
                holds={
                  group.sessions === 0 ? (
                    <span className="muted">No sessions</span>
                  ) : (
                    <HoldsLink
                      narrowing={{ session_group: [group.id] }}
                      words={plural(group.sessions, "session")}
                      of={`in group ${group.name}`}
                    />
                  )
                }
                removing={
                  group.sessions === 0
                    ? `Remove the group ${group.name}? It holds no sessions.`
                    : `Remove the group ${group.name}? Its ${plural(group.sessions, "session")} will be in no group.`
                }
                refresh={refresh}
                rowId={rowOf(group.id)}
                onRenamed={() => focus(`${rowOf(group.id)}-rename`)}
                onRemoved={() =>
                  focusNext(
                    shown.map((each) => rowOf(each.id)),
                    shown.indexOf(group),
                    `${id}-new`,
                  )
                }
                dragging={order.dragging === group.id}
                drag={narrowed ? undefined : order.drag(group.id, all)}
                moves={
                  <MoveButtons
                    group={group.id}
                    name={group.name}
                    shown={all}
                    idOf={(each, direction) => `${id}-${each}-${direction}`}
                    pending={order.pending}
                    disabled={narrowed}
                    describedBy={narrowed ? `${id}-narrowed` : undefined}
                    move={(target, focusOn) => void order.move(group.id, target, all, focusOn)}
                  />
                }
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}
