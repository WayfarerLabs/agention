import type { Ref } from "react";
import { Icon, type IconName } from "../icons.tsx";

// The controls a list's head holds, as the thread list's and the sessions
// view's do: its order, the button reversing it, and its grouping.

// HeadSelect is one of the head's choices beside its icon, a native select,
// which a phone shows as its own picker. Its ref is the select's, for a view
// that moves focus to it.
export function HeadSelect({
  icon,
  label,
  value,
  options,
  choose,
  ref,
}: {
  icon: IconName;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  choose: (value: string) => void;
  ref?: Ref<HTMLSelectElement> | undefined;
}) {
  return (
    <div className="head-select">
      <Icon name={icon} />
      <select
        ref={ref}
        aria-label={label}
        value={value}
        onChange={(event) => choose(event.target.value)}
      >
        {options.map((each) => (
          <option key={each.value} value={each.value}>
            {each.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// DirectionButton names the direction the list's order runs in, in words
// beside an arrow, and reverses it when pressed. It is a plain button, not a
// toggle: what it shows is the order the list is in, so its name starts with
// those words, as speech input hears them, and goes on to say what pressing
// it does, as in "Newest first, reverse to oldest first".
export function DirectionButton({
  labels,
  reverse,
  onReverse,
}: {
  // The order's direction in words: its own, then reversed.
  labels: readonly [own: string, reversed: string];
  reverse: boolean;
  onReverse: () => void;
}) {
  const [own, reversed] = labels;
  const [current, other] = reverse ? [reversed, own] : [own, reversed];
  return (
    <button
      type="button"
      className="secondary direction-button"
      aria-label={`${current}, reverse to ${other.toLowerCase()}`}
      onClick={onReverse}
    >
      <Icon name={reverse ? "arrow-up" : "arrow-down"} />
      {current}
    </button>
  );
}
