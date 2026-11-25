import type { Ref } from "react";
import { Icon, type IconName } from "./icons.tsx";

// Compact controls: an icon in a box the size of a touch, named for assistive
// technology, showing its words beside the icon only where the row it sits
// in has room for them (styles.css, .icon-control). The list heads and the
// composer's Send row hold them.
//
// Three kinds share that box, and the eye tells them apart by its lower
// corner, wherever they appear:
//
// - A pick list holds one choice of several: a small down caret in the
//   corner, and its icon and words say the choice it holds. Pressing it
//   changes nothing but opens the choices (PickList).
// - A checkbox holds a setting that is on or off: a small box in the corner,
//   hollow while off; on, the box fills and the control's face is tinted and
//   outlined in the accent (IconCheckbox).
// - A button acts when pressed, or opens a dialog or a menu of things to do:
//   nothing in the corner (the list heads' HeadButton, Attach, Dictate).
//
// The first two are native controls, a select and a checkbox, lying unseen
// over the whole box, so a tap anywhere on it reaches them, a phone shows its
// own picker for a pick list, and assistive technology hears each one's name
// with the choice or the state it holds.

// SetMark is the dot a control carries while it is set to anything but its
// default. It is for the eye alone: what the control is set to is in its
// name or its value.
export function SetMark() {
  return <span className="set-mark" aria-hidden="true" />;
}

// PickList is a pick list: its icon, the choice it holds in words where
// there is room, and its name with those words as its tooltip. Its options
// say in full what each choice is or does, since the picker has the room the
// control lacks; one whose words are too long for the control gives shorter
// ones to show there.
export function PickList<Value extends string>({
  icon,
  label,
  value,
  options,
  marked = false,
  disabled = false,
  select,
  choose,
}: {
  icon: IconName;
  label: string;
  value: Value;
  options: readonly { value: Value; label: string; shown?: string }[];
  // Whether the choice is any but the default, where the control marks that.
  marked?: boolean;
  disabled?: boolean;
  // The caller's hold on its select, for a key that opens it (openPicker).
  select?: Ref<HTMLSelectElement>;
  // Told the value chosen, one of the options'.
  choose: (value: Value) => void;
}) {
  const chosen = options.find((each) => each.value === value);
  const shown = chosen?.shown ?? chosen?.label ?? "";
  return (
    <div className="icon-control pick-list" title={`${label}: ${shown}`}>
      <Icon name={icon} />
      <span className="control-label" aria-hidden="true">
        {shown}
      </span>
      {marked && <SetMark />}
      <select
        ref={select}
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          const picked = options.find((each) => each.value === event.target.value);
          if (picked !== undefined) {
            choose(picked.value);
          }
        }}
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

// openPicker puts focus on a pick list's select and opens its picker, as a
// click on it does, where the browser lets a key open it; elsewhere, with
// focus on it, the keyboard opens it or chooses.
export function openPicker(select: HTMLSelectElement | null): void {
  if (select === null) {
    return;
  }
  select.focus();
  try {
    select.showPicker();
  } catch {
    // A browser without showPicker for a select, or refusing it here, leaves
    // the select with focus.
  }
}

// IconCheckbox is a checkbox: its icon, its words where there is room, and
// its name, which says what it turns on and is its tooltip with whether it
// is on.
export function IconCheckbox({
  icon,
  shown,
  name,
  checked,
  disabled = false,
  onChange,
}: {
  icon: IconName;
  shown: string;
  name: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="icon-control icon-checkbox" title={`${name}: ${checked ? "on" : "off"}`}>
      <Icon name={icon} />
      <span className="control-label" aria-hidden="true">
        {shown}
      </span>
      <input
        type="checkbox"
        aria-label={name}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </div>
  );
}
