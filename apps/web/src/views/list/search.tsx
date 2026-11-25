import { messageSearchFilter, type ThreadsView } from "@wayfarerlabs/agention-api";
import { type RefObject, useEffect, useRef, useState } from "react";

// The thread list's search: one filter, whose text two boxes show and edit,
// the one at the top of the list's head and the one in the filter sheet.

// How long typing must pause before the search applies.
const searchPause = 400;

// The search's text as typed, which may be ahead of the search applied, and
// why it cannot search when the API would refuse it.
export interface SearchText {
  text: string;
  problem: string | undefined;
  // Takes the text typed, applying it once typing pauses, or not while an
  // input method is still composing it.
  type: (text: string, composing?: boolean) => void;
  // Applies the text at once, as the pause would.
  applyNow: () => void;
  // Sets the text to a search set any other way, cancelling one pending.
  reset: (search: string | undefined) => void;
}

// searchProblem says why text cannot search, in the API's words for the
// rule it breaks: text that holds only white space searches nothing, which is
// no problem.
function searchProblem(text: string): string | undefined {
  const search = text.trim();
  const read = messageSearchFilter.safeParse(search);
  return search === "" || read.success
    ? undefined
    : `The search ${read.error.issues[0]?.message ?? "cannot be used"}.`;
}

// useSearchText keeps the search's text, applying it once typing pauses, or
// at once on Enter, to the address as it then stands, so a filter chosen
// meanwhile stays. Text an input method is still composing waits for the
// composition to end, so half-composed text never searches. Text the API
// would refuse is not applied: the list stays as it is, and the boxes keep
// the text and say why. A search set any other way (Reset filters, removing
// its chip, an address from elsewhere) replaces the text and cancels one
// still pending.
export function useSearchText(
  view: ThreadsView,
  apply: (search: string | undefined) => void,
): SearchText {
  const [text, setText] = useState(view.search ?? "");
  const applied = useRef(view.search);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const reset = (search: string | undefined) => {
    clearTimeout(timer.current);
    applied.current = search;
    setText(search ?? "");
  };
  useEffect(() => {
    if (view.search !== applied.current) {
      clearTimeout(timer.current);
      applied.current = view.search;
      setText(view.search ?? "");
    }
  }, [view.search]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const settle = (value: string) => {
    const search = value.trim() || undefined;
    if (search !== applied.current) {
      applied.current = search;
      apply(search);
    }
  };
  const type = (value: string, composing = false) => {
    setText(value);
    clearTimeout(timer.current);
    if (composing || searchProblem(value) !== undefined) {
      return;
    }
    timer.current = setTimeout(() => settle(value), searchPause);
  };
  const applyNow = () => {
    clearTimeout(timer.current);
    if (searchProblem(text) === undefined) {
      settle(text);
    }
  };
  return { text, problem: searchProblem(text), type, applyNow, reset };
}

// SearchBox is a box showing the search's text, which typing in edits and
// Enter applies, with why the text cannot search beneath it when it cannot.
// It is named by a label of its own, given its id, or else by label, which it
// also shows while empty. While an input method composes, typing waits for
// its end, and Enter, which ends it, applies nothing.
export function SearchBox({
  search,
  id,
  label,
  box,
}: {
  search: SearchText;
  id: string;
  label?: string;
  box?: RefObject<HTMLInputElement | null>;
}) {
  const error = `${id}-error`;
  return (
    <>
      <input
        ref={box}
        id={id}
        type="search"
        maxLength={200}
        aria-label={label}
        placeholder={label}
        value={search.text}
        aria-invalid={search.problem === undefined ? undefined : true}
        aria-describedby={search.problem === undefined ? undefined : error}
        onChange={(event) =>
          search.type(event.target.value, (event.nativeEvent as InputEvent).isComposing)
        }
        onCompositionEnd={(event) => search.type(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            search.applyNow();
          }
        }}
      />
      {search.problem !== undefined && (
        <p id={error} className="field-error">
          {search.problem}
        </p>
      )}
    </>
  );
}
