import { type DragEvent, type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { request } from "../api.ts";
import type { DropProps } from "../components.tsx";
import { useAction } from "../data.ts";
import { Icon } from "../icons.tsx";

// The operator's order of their session groups, as the lists that change it
// share: Settings' list of groups, and the sessions view's groups in their
// manual order. A group moves up or down by its buttons, or, with a mouse,
// is dragged by its handle onto another to take that one's place. Each move
// sends the whole order to POST /groups/order and, while it is under way,
// the list shows the order sent and takes no other move, its buttons marked
// aria-disabled rather than disabled so focus stays with them; once it
// settles, the list shows the groups as they reload. One the server
// refuses, as when another client changed the groups since, shows them as
// they are.

type Direction = "up" | "down";

// The type a group's drag carries its id in, so a list takes a drop only of
// its own groups, never of a file, a link or text dragged in.
const groupDrag = "application/x-agention-group";

// A group's drag by its handle: the group, starting and ending it, and
// dropping another group, by its id, on this one.
export interface Drag {
  group: number;
  start: () => void;
  end: () => void;
  drop: (moving: number) => void;
}

// useGroupOrder keeps the order a list shows its groups in: the server's, as
// groups lists them once loaded, or the one sent while a move is under way.
// A move puts a group in another's place, both in the order, saying where it
// went among the groups the list shows. The order sent shows until the
// reload the move starts once it is taken has brought the groups, so a reload
// that started before it cannot undo it meanwhile, and until a later one does
// when that reload fails; a group the order sent lacks, as one another client
// created since, shows after those it holds.
export function useGroupOrder({
  groups,
  failure,
  refresh,
  focus,
}: {
  groups: readonly { id: number; name: string }[] | undefined;
  // Why the latest load of the groups failed, until one succeeds, which the
  // same render as the groups it kept brings.
  failure: unknown;
  refresh: () => Promise<boolean>;
  focus: (id: string) => void;
}) {
  const action = useAction();
  const [sent, setSent] = useState<number[]>();
  // An order taken whose own reload failed, kept until a load succeeds,
  // which clears the failure: only a load newer than the failed one can,
  // while groups a poll from before the move brought render beside it.
  const kept = useRef<number[]>(undefined);
  // The order the latest move sent, which alone may be kept: an earlier
  // move's reload settling after a later move's says nothing of the order
  // the later one sent.
  const latest = useRef<number[]>(undefined);
  useEffect(() => {
    const ids = kept.current;
    if (ids !== undefined && failure === undefined) {
      kept.current = undefined;
      setSent((current) => (current === ids ? undefined : current));
    }
  }, [groups, failure]);
  const [said, say] = useState("");
  const [dragging, setDragging] = useState<number>();
  const hush = useCallback(() => say(""), []);
  const order = groups?.map((group) => group.id) ?? [];
  const known = new Set(order);
  const ordered =
    sent === undefined
      ? order
      : [
          ...sent.filter((each) => known.has(each)),
          ...order.filter((each) => !sent.includes(each)),
        ];
  // move puts a group in the place of target, among the groups shown,
  // focus going on to focusOn, when given; a group the order does not hold
  // moves nowhere.
  const move = async (group: number, target: number, shown: number[], focusOn?: string) => {
    if (action.pending || !ordered.includes(group) || !ordered.includes(target)) {
      return;
    }
    const ids = ordered.filter((each) => each !== group);
    ids.splice(ordered.indexOf(target), 0, group);
    latest.current = ids;
    setSent(ids);
    if (focusOn !== undefined) {
      focus(focusOn);
    }
    const done = await action.run((csrf) =>
      request("POST", "/groups/order", { csrf, body: { groups: ids } }),
    );
    if (done === undefined) {
      setSent(undefined);
      say("");
      void refresh();
      return;
    }
    const place = ids.filter((each) => shown.includes(each));
    const name = groups?.find((each) => each.id === group)?.name ?? "";
    say(`${name} is now ${place.indexOf(group) + 1} of ${place.length}.`);
    if (await refresh()) {
      setSent((current) => (current === ids ? undefined : current));
    } else if (latest.current === ids) {
      kept.current = ids;
    }
  };
  // drag is a group's drag by its handle, dropped on another of those shown.
  const drag = (group: number, shown: number[]): Drag => ({
    group,
    start: () => setDragging(group),
    end: () => setDragging(undefined),
    drop: (moving) => {
      setDragging(undefined);
      if (moving !== group) {
        void move(moving, group, shown);
      }
    },
  });
  return {
    ordered,
    pending: action.pending,
    failure: action.failure,
    said,
    // Clears what the last move said, as once nothing shows it.
    hush,
    dragging,
    move,
    drag,
  };
}

// MoveButtons are a group's Move up and Move down among the groups shown,
// each unavailable at its end. Focus stays on the button that moved it, or,
// once that button can move it no further, goes to the other.
export function MoveButtons({
  group,
  name,
  shown,
  idOf,
  pending,
  disabled = false,
  describedBy,
  move,
}: {
  group: number;
  name: string;
  shown: number[];
  idOf: (group: number, direction: Direction) => string;
  pending: boolean;
  // Whether the group cannot move at all, as while a search narrows a list,
  // and what says why.
  disabled?: boolean;
  describedBy?: string | undefined;
  move: (target: number, focusOn: string) => void;
}) {
  const at = shown.indexOf(group);
  return (["up", "down"] as const).map((direction) => {
    const to = direction === "up" ? at - 1 : at + 1;
    const target = shown[to];
    const end = to === 0 || to === shown.length - 1;
    const next = end ? (direction === "up" ? "down" : "up") : direction;
    return (
      <button
        key={direction}
        id={idOf(group, direction)}
        type="button"
        className="secondary icon-button"
        aria-label={`Move ${name} ${direction}`}
        aria-describedby={describedBy}
        disabled={disabled || target === undefined}
        aria-disabled={pending || undefined}
        onClick={() => {
          if (target !== undefined && !pending) {
            move(target, idOf(group, next));
          }
        }}
      >
        <Icon name={direction === "up" ? "arrow-up" : "arrow-down"} />
      </button>
    );
  });
}

// DragHandle is what a mouse drags a group by. The picture dragged is image,
// the group's whole line, or else the section holding the handle. A touch
// screen moves groups by their buttons alone, so the handle hides there, as
// the stylesheet says.
export function DragHandle({
  name,
  image,
  drag,
}: {
  name: string;
  image?: RefObject<HTMLElement | null>;
  drag: Drag;
}) {
  return (
    <span
      className="drag-handle"
      aria-hidden="true"
      title="Drag to move"
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(groupDrag, String(drag.group));
        event.dataTransfer.setData("text/plain", name);
        const picture = image?.current ?? event.currentTarget.closest("section");
        if (picture !== null) {
          event.dataTransfer.setDragImage?.(picture, 0, 0);
        }
        drag.start();
      }}
      onDragEnd={() => drag.end()}
    >
      <Icon name="grip" />
    </span>
  );
}

// useDropTarget gives what a group's line takes a drop of another group by,
// while it can, and whether such a drag is over it; any other drag passes
// over it.
export function useDropTarget(drag: Drag | undefined): [over: boolean, props: DropProps] {
  const [over, setOver] = useState(false);
  const ours = (event: DragEvent) => event.dataTransfer.types.includes(groupDrag);
  return [
    over,
    drag === undefined
      ? {}
      : {
          onDragOver: (event) => {
            if (ours(event)) {
              event.preventDefault();
              setOver(true);
            }
          },
          onDragLeave: () => setOver(false),
          // Only a group's drag is let over, so only one drops here, and
          // move takes only a group the order holds.
          onDrop: (event) => {
            setOver(false);
            event.preventDefault();
            drag.drop(Number(event.dataTransfer.getData(groupDrag)));
          },
        },
  ];
}
