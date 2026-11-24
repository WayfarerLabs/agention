import { type GroupsAndTags, maxGroups } from "@wayfarerlabs/agention-api";
import { type DragEvent, useEffect, useId, useRef, useState } from "react";
import { request } from "../../api.ts";
import { Failure, Status } from "../../components.tsx";
import { useAction } from "../../data.ts";
import { plural } from "../../format.tsx";
import { nameKey } from "../../organizing.tsx";
import { Icon } from "../../icons.tsx";
import {
  focusNext,
  HoldsLink,
  ListHead,
  Organized,
  useFocusWhenShown,
  useSearch,
} from "./Organizer.tsx";

type Group = GroupsAndTags["groups"][number];

// GroupList is Settings' list of groups, in the operator's order, each moved
// up or down it by its buttons, or, with a mouse, dragged by its handle onto
// another to take that one's place. Each move sends the whole order and, while
// it is under way, the list shows the order sent and takes no other move, its
// buttons staying where they are, focus with them; once it settles, the list
// shows the groups as they reload. One the server refuses, as when another
// client changed the groups since, shows them as they are.
export function GroupList({ groups, refresh }: { groups: Group[]; refresh: () => void }) {
  const id = useId();
  const [search, words] = useSearch("Search groups");
  const create = useAction();
  const order = useAction();
  const [sent, setSent] = useState<number[]>();
  // Whether an order sent was taken, so the groups the next reload brings
  // show it, and a reload landing while it was under way does not undo it.
  const settled = useRef(false);
  const [said, say] = useState("");
  const [dragging, setDragging] = useState<number>();
  const focus = useFocusWhenShown(groups);
  useEffect(() => {
    if (settled.current) {
      settled.current = false;
      setSent(undefined);
    }
  }, [groups]);
  const byId = new Map(groups.map((group) => [group.id, group]));
  const ordered = (sent ?? groups.map((group) => group.id)).flatMap((each) => byId.get(each) ?? []);
  const shown = ordered.filter((group) => nameKey(group.name).includes(words));
  const rowOf = (group: number) => `${id}-row-${group}`;
  const moveOf = (group: number, direction: "up" | "down") => `${id}-${group}-${direction}`;
  const narrowed = words !== "";
  // move sends the order with a group at another place, saying where it
  // went. Focus stays on the button that moved it, or, once that button can
  // move it no further, goes to the other.
  const move = async (group: Group, to: number, direction?: "up" | "down") => {
    if (order.pending) {
      return;
    }
    const ids = ordered.map((each) => each.id).filter((each) => each !== group.id);
    ids.splice(to, 0, group.id);
    setSent(ids);
    if (direction !== undefined) {
      const atEnd = direction === "up" ? to === 0 : to === ids.length - 1;
      focus(moveOf(group.id, atEnd ? (direction === "up" ? "down" : "up") : direction));
    }
    const done = await order.run((csrf) =>
      request("POST", "/groups/order", { csrf, body: { groups: ids } }),
    );
    if (done === undefined) {
      setSent(undefined);
      say("");
    } else {
      settled.current = true;
      say(`${group.name} is now ${to + 1} of ${ids.length}.`);
    }
    refresh();
  };
  const onDrop = (event: DragEvent, target: Group) => {
    event.preventDefault();
    const moving = ordered.find((each) => each.id === dragging);
    setDragging(undefined);
    if (moving !== undefined && moving.id !== target.id) {
      void move(
        moving,
        ordered.findIndex((each) => each.id === target.id),
      );
    }
  };
  const moveButton = (group: Group, index: number, direction: "up" | "down") => {
    const end = direction === "up" ? index === 0 : index === ordered.length - 1;
    return (
      <button
        id={moveOf(group.id, direction)}
        type="button"
        className="secondary icon-button"
        aria-label={`Move ${group.name} ${direction}`}
        aria-describedby={narrowed ? `${id}-narrowed` : undefined}
        disabled={narrowed || end}
        aria-disabled={order.pending || undefined}
        onClick={() => void move(group, index + (direction === "up" ? -1 : 1), direction)}
      >
        <Icon name={direction === "up" ? "arrow-up" : "arrow-down"} />
      </button>
    );
  };
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
      <Status>{said}</Status>
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
            const index = ordered.indexOf(group);
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
                dragging={dragging === group.id}
                drag={
                  narrowed
                    ? undefined
                    : {
                        start: () => setDragging(group.id),
                        end: () => setDragging(undefined),
                        drop: (event) => onDrop(event, group),
                      }
                }
                moves={
                  <>
                    {moveButton(group, index, "up")}
                    {moveButton(group, index, "down")}
                  </>
                }
              />
            );
          })}
        </ul>
      )}
    </section>
  );
}
