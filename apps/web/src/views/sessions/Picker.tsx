import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Icon } from "../../icons.tsx";

// Picker chooses among the operator's groups or tags, as a labels picker
// does: a popover beside the control that opened it on a wide screen, and a
// sheet rising from the bottom on a phone, each a modal dialog. A search box
// leads, a combobox owning the list beneath it, which narrows as it is typed
// in: each item is a group or a tag, checked while chosen, or an action, such
// as clearing the choice or creating what was typed. The arrow keys move
// through the list from the search box, Enter picks the item, and a click or
// a tap picks one too. Picking applies at once, which the caller does; there
// is no Save. One pick is under way at a time, the items unavailable until it
// settles. Escape clears the search, or, with nothing typed, closes the
// picker, as a tap outside or its own Done does, and the caller returns focus
// to what opened it.

// What a picked item asks of the picker once it has done its part: to
// close, or to clear the search, as after creating what was typed.
export type Picked = "close" | "clear" | undefined;

// An item of the list: what it shows, whether it is chosen, for an item that
// can be, whether it is unavailable and what says why, and what picking it
// does.
export interface PickerItem {
  key: string;
  content: ReactNode;
  // Chosen or not, for a group or a tag; undefined for an action.
  chosen?: boolean | undefined;
  disabled?: boolean | undefined;
  describedBy?: string | undefined;
  pick: () => Promise<Picked> | Picked;
}

// The list for what was typed, trimmed: its items, what it says when it has
// none, and notes beneath it, such as why a name cannot be used.
export interface PickerList {
  items: PickerItem[];
  empty: string;
  notes?: ReactNode;
}

// Where a popover stays clear of the viewport's edges, in pixels.
const edge = 8;

// The width at and above which the picker is a popover, as the stylesheet
// says.
const wide = "(min-width: 40rem)";

export function Picker({
  label,
  searchLabel,
  anchor,
  multiple,
  list,
  onClose,
}: {
  // The dialog's name, such as "Group for builder/main".
  label: string;
  searchLabel: string;
  // What opened it, which a popover lies beside.
  anchor: HTMLElement | null;
  multiple: boolean;
  list: (typed: string) => PickerList;
  onClose: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  // Whether a pick is under way, which the ref says before its render lands.
  const [busy, setBusy] = useState(false);
  const picking = useRef(false);
  const { items, empty, notes } = list(text.trim());
  const current = Math.min(active, items.length - 1);
  const optionId = (index: number) => `${id}-option-${index}`;

  useLayoutEffect(() => {
    const open = dialog.current;
    if (open === null) {
      return;
    }
    open.showModal();
    // A phone's keyboard would rise over the sheet as it opens, so there
    // focus stays on the dialog until the search box is tapped.
    if (window.matchMedia("(hover: none)").matches) {
      open.focus();
    } else {
      search.current?.focus();
    }
    const place = () => {
      if (anchor === null || !window.matchMedia(wide).matches) {
        open.style.removeProperty("top");
        open.style.removeProperty("left");
        return;
      }
      const at = anchor.getBoundingClientRect();
      const { width, height } = open.getBoundingClientRect();
      const below = at.bottom + edge + height <= window.innerHeight;
      const top = below ? at.bottom + edge / 2 : Math.max(edge, at.top - edge / 2 - height);
      const left = Math.min(
        Math.max(edge, at.right - width),
        Math.max(edge, window.innerWidth - width - edge),
      );
      open.style.top = `${top}px`;
      open.style.left = `${left}px`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);

  // The item moved to stays in view as the list scrolls.
  useEffect(() => {
    document.getElementById(optionId(current))?.scrollIntoView?.({ block: "nearest" });
  });

  const close = () => dialog.current?.close();
  const pick = async (item: PickerItem | undefined) => {
    if (item === undefined || item.disabled === true || picking.current) {
      return;
    }
    picking.current = true;
    setBusy(true);
    let then: Picked;
    try {
      then = await item.pick();
    } finally {
      picking.current = false;
      setBusy(false);
    }
    if (then === "close") {
      close();
    } else if (then === "clear") {
      setText("");
      setActive(0);
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // While an input method composes text, its keys are its own: Enter
    // commits what it composed, and picks nothing. WebKit sends the Enter
    // that commits with isComposing false, but with the key code 229.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) {
      return;
    }
    const count = items.length;
    if (event.key === "ArrowDown" && count > 0) {
      event.preventDefault();
      setActive((current + 1) % count);
    } else if (event.key === "ArrowUp" && count > 0) {
      event.preventDefault();
      setActive((current - 1 + count) % count);
    } else if (event.key === "Enter") {
      event.preventDefault();
      void pick(items[current]);
    } else if (event.key === "Escape" && text !== "") {
      // Escape clears the search first, leaving the picker open.
      event.preventDefault();
      setText("");
      setActive(0);
    }
  };
  // A click on the backdrop, outside the dialog's box, closes it.
  const onClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === dialog.current) {
      close();
    }
  };
  return (
    <dialog
      ref={dialog}
      className="labels-picker"
      aria-label={label}
      tabIndex={-1}
      onClose={onClose}
      onClick={onClick}
    >
      <div className="labels-picker-body">
        <input
          ref={search}
          type="search"
          role="combobox"
          aria-label={searchLabel}
          placeholder={searchLabel}
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={current < 0 ? undefined : optionId(current)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
        <ul
          id={`${id}-list`}
          className="labels-picker-list"
          role="listbox"
          aria-label={label}
          aria-multiselectable={multiple || undefined}
          aria-busy={busy || undefined}
        >
          {items.map((item, index) => (
            // The search box takes the keys, naming the item it is on as
            // its active descendant, so the items take clicks alone.
            <li
              key={item.key}
              id={optionId(index)}
              role="option"
              className={index === current ? "labels-picker-item active" : "labels-picker-item"}
              aria-selected={item.chosen === true}
              aria-disabled={item.disabled === true || busy || undefined}
              aria-describedby={item.describedBy}
              onMouseMove={() => setActive(index)}
              onClick={() => void pick(item)}
            >
              <span className="labels-picker-check">
                {item.chosen === true && <Icon name="check" />}
              </span>
              {item.content}
            </li>
          ))}
        </ul>
        {items.length === 0 && <p className="muted">{empty}</p>}
        {notes}
      </div>
      <div className="labels-picker-foot">
        <button type="button" className="secondary" onClick={close}>
          Done
        </button>
      </div>
    </dialog>
  );
}
