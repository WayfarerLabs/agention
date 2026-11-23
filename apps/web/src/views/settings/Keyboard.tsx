import { useId } from "react";
import { useKeyboard } from "../../keyboard.tsx";

// Settings' keyboard section: whether the keyboard shortcuts are on in this
// browser, which they are unless the operator turns them off, and a way to
// see them all.
export function KeyboardSection() {
  const { on, setOn, showHelp } = useKeyboard();
  const id = useId();
  return (
    <>
      <label className="check">
        <input
          type="checkbox"
          checked={on}
          aria-describedby={`${id}-hint`}
          onChange={(event) => setOn(event.target.checked)}
        />
        Keyboard shortcuts
      </label>
      <p className="hint" id={`${id}-hint`}>
        Every shortcut that Show the shortcuts lists: the single keys, such as j and k to move
        through the thread list, which act while focus is outside a text field, and the composer's
        Ctrl+Enter or Cmd+Enter to send and Esc to leave it. The diagram viewer's own keys stay on.
        Turn them off if they get in the way of your screen reader, voice control or another tool.
        This browser keeps the choice.
      </p>
      <div className="actions">
        <button type="button" className="secondary" onClick={showHelp}>
          Show the shortcuts
        </button>
      </div>
    </>
  );
}
