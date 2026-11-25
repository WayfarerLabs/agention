import { useId } from "react";
import { type AutoAdvance, autoAdvanceOptions, useAutoAdvance } from "../thread/neighbor-thread.ts";

const autoAdvanceLabels: Record<AutoAdvance, string> = {
  above: "The thread above",
  below: "The thread below",
  list: "Back to the list",
};

// Settings' threads section: where archiving a thread takes the operator,
// which Archive all and a send set to archive follow. This browser keeps the
// choice.
export function ThreadsSection() {
  const [autoAdvance, setAutoAdvance] = useAutoAdvance();
  const id = useId();
  return (
    <>
      <label htmlFor={`${id}-auto-advance`}>Auto-advance</label>
      <select
        id={`${id}-auto-advance`}
        value={autoAdvance}
        aria-describedby={`${id}-auto-advance-hint`}
        onChange={(event) => {
          const chosen = autoAdvanceOptions.find((option) => option === event.target.value);
          if (chosen !== undefined) {
            setAutoAdvance(chosen);
          }
        }}
      >
        {autoAdvanceOptions.map((option) => (
          <option key={option} value={option}>
            {autoAdvanceLabels[option]}
          </option>
        ))}
      </select>
      <p className="hint" id={`${id}-auto-advance-hint`}>
        Where you go once you archive a thread, with Archive all or by sending with After sending
        set to Archive: the thread that was just above it or just below it in the list you return
        to, or back to that list. At the end of the list that way, you go back to the list. This
        browser keeps the choice.
      </p>
    </>
  );
}
