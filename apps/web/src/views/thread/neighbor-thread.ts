import type { ThreadNeighbors, ThreadsView } from "@wayfarerlabs/agention-api";
import { query, request, threadPath } from "../../api.ts";
import { useDeviceOption } from "../../device.ts";
import { queryOf } from "../../router.tsx";
import type { ListedThread } from "../list/listing.ts";

// The thread above or below, from a thread's page: the row just above or
// below it in the list the page returns to, as that list stands, with its
// filters, order, direction and grouping. That is the list Back to threads
// goes to and the list beside the thread side by side, so every layout moves
// the same way. The server answers it, placing the thread where the list's
// order puts it though the filters would leave it out, as they do a thread
// just archived or read out of a list kept to the unread.

// Which way to move from a thread, by its row's place on screen.
export type Direction = "above" | "below";

// Where archiving a thread takes the operator: to the thread that was just
// above or below it, or back to the list.
export const autoAdvanceOptions = ["above", "below", "list"] as const;
export type AutoAdvance = (typeof autoAdvanceOptions)[number];

// Where this device keeps its Auto-advance.
export const autoAdvanceChoice = "agention.auto-advance";

// useAutoAdvance gives where archiving takes the operator on this device, the
// thread above unless they choose otherwise, and a way to change and keep it.
export const useAutoAdvance = () => useDeviceOption(autoAdvanceChoice, autoAdvanceOptions, "above");

interface Place {
  agent: string;
  session: string;
  number: number;
}

// neighborIn asks for the thread above or below a thread in a list, none at
// the end of the list that way.
export async function neighborIn(
  view: ThreadsView,
  place: Place,
  direction: Direction,
): Promise<ListedThread | undefined> {
  const found = await request<ThreadNeighbors>(
    "GET",
    `${threadPath(place.agent, place.session, place.number, "/neighbors")}${query(queryOf(view))}`,
  );
  return found[direction];
}
