import type { Ref } from "react";
import { Icon, type IconName } from "../icons.tsx";

// The controls a list's head holds, as the thread list's and the sessions
// view's do: one row of compact controls, each an icon in a box the size of a
// touch, named for assistive technology, and showing its words beside the
// icon only where the head has room for them (styles.css, .list-head). Each
// carries a mark while it is set to anything but its default.

// SetMark is the dot a control carries while it is set to anything but its
// default. It is for the eye alone: what the control is set to is in its
// name or its value.
function SetMark() {
  return <span className="set-mark" aria-hidden="true" />;
}

// HeadButton is a button of the head: its icon, the words it shows where
// there is room, and its name, which starts with those words, as speech input
// hears them, and is its tooltip. It carries its mark while marked, or, given
// a count above none, a badge showing it, which its name must say.
export function HeadButton({
  icon,
  shown,
  name,
  marked = false,
  count = 0,
  button,
  popup,
  onClick,
}: {
  icon: IconName;
  shown: string;
  name: string;
  marked?: boolean;
  count?: number;
  button?: Ref<HTMLButtonElement>;
  // The dialog it opens, when it opens one.
  popup?: "dialog";
  onClick: () => void;
}) {
  return (
    <button
      ref={button}
      type="button"
      className="secondary head-control"
      title={name}
      aria-label={name}
      aria-haspopup={popup}
      onClick={onClick}
    >
      <Icon name={icon} />
      <span className="head-label">{shown}</span>
      {count > 0 ? (
        <span className="badge" aria-hidden="true">
          {count}
        </span>
      ) : (
        marked && <SetMark />
      )}
    </button>
  );
}

// HeadSelect is one of the head's choices, a native select, which a phone
// shows as its own picker, drawn as the head's other controls are: its icon,
// and the choice it holds in words where there is room, both its tooltip. The
// select lies over the whole control, unseen, so a tap anywhere on it opens
// the picker, and assistive technology hears its name and the choice it holds.
export function HeadSelect({
  icon,
  label,
  value,
  options,
  marked,
  choose,
}: {
  icon: IconName;
  label: string;
  value: string;
  options: { value: string; label: string }[];
  // Whether the choice is any but the default.
  marked: boolean;
  choose: (value: string) => void;
}) {
  const chosen = options.find((each) => each.value === value);
  return (
    <div className="head-control head-select" title={`${label}: ${chosen?.label ?? ""}`}>
      <Icon name={icon} />
      <span className="head-label" aria-hidden="true">
        {chosen?.label}
      </span>
      {marked && <SetMark />}
      <select aria-label={label} value={value} onChange={(event) => choose(event.target.value)}>
        {options.map((each) => (
          <option key={each.value} value={each.value}>
            {each.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// DirectionButton reverses the list's order when pressed, its arrow pointing
// the way the order runs, beside its direction in words where there is room;
// reversed, it carries its mark. It is a plain button, not a toggle: what it
// shows is the order the list is in, so its name starts with those words, as
// speech input hears them, and goes on to say what pressing it does, as in
// "Newest first, reverse to oldest first".
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
    <HeadButton
      icon={reverse ? "arrow-up" : "arrow-down"}
      shown={current}
      name={`${current}, reverse to ${other.toLowerCase()}`}
      marked={reverse}
      onClick={onReverse}
    />
  );
}
