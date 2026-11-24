import { useId } from "react";
import { type Direction, directions, useMoveOnDirection } from "../thread/neighbor-thread.ts";

const directionLabels: Record<Direction, string> = {
  above: "The thread above",
  below: "The thread below",
};

// Settings' threads section: which way a thread's Archive & move on, and
// After sending's ways on, go in the list the thread was opened from. This
// browser keeps the choice.
export function ThreadsSection() {
  const [moveOnTo, setMoveOnTo] = useMoveOnDirection();
  const id = useId();
  return (
    <>
      <label htmlFor={`${id}-move-on`}>Move on to</label>
      <select
        id={`${id}-move-on`}
        value={moveOnTo}
        aria-describedby={`${id}-move-on-hint`}
        onChange={(event) => {
          const chosen = directions.find((direction) => direction === event.target.value);
          if (chosen !== undefined) {
            setMoveOnTo(chosen);
          }
        }}
      >
        {directions.map((direction) => (
          <option key={direction} value={direction}>
            {directionLabels[direction]}
          </option>
        ))}
      </select>
      <p className="hint" id={`${id}-move-on-hint`}>
        Where Archive &amp; move on takes you from a thread, as do After sending&apos;s Move on and
        Archive &amp; move on: the row above it or below it in the list you opened it from, going
        round past the list&apos;s end. This browser keeps the choice.
      </p>
    </>
  );
}
