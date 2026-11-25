import type { Ref } from "react";
import { IconCheckbox, SetMark } from "../icon-controls.tsx";
import { Icon, type IconName } from "../icons.tsx";

// What a list's head holds beside its pick lists, as the thread list's and
// the sessions view's do: its buttons, and the checkbox that reverses its
// order. The head is one row of compact controls (icon-controls.tsx), which
// show their words only where it has room for them (styles.css, .list-head).
// A button or a pick list carries a mark while it is set to anything but its
// default.

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
      className="secondary icon-control"
      title={name}
      aria-label={name}
      aria-haspopup={popup}
      onClick={onClick}
    >
      <Icon name={icon} />
      <span className="control-label">{shown}</span>
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

// ReverseCheckbox is the checkbox that reverses the list's order, on while
// the order runs against its own direction: an arrow pointing up, beside
// what turning it on gives, the order's reversed direction in words, where
// there is room, as in "Oldest first". Those words are its name, on or off,
// as a checkbox's say what it turns on; whether it is on is the checkbox's
// own state, and the box in its corner shows it, so it carries no mark
// besides.
export function ReverseCheckbox({
  labels,
  reverse,
  onReverse,
}: {
  // The order's direction in words: its own, then reversed.
  labels: readonly [own: string, reversed: string];
  reverse: boolean;
  onReverse: () => void;
}) {
  const reversed = labels[1];
  return (
    <IconCheckbox
      icon="arrow-up"
      shown={reversed}
      name={reversed}
      checked={reverse}
      onChange={onReverse}
    />
  );
}
