import { useId } from "react";
import { useKeyboard } from "../../keyboard.tsx";

// Settings' keyboard section: whether the keyboard shortcuts are on in this
// browser, which they are unless the operator turns them off, whether Enter
// sends from the composer, which it does not unless the operator turns it on,
// and a way to see them all.
export function KeyboardSection() {
  const { on, setOn, enterSends, setEnterSends, showHelp } = useKeyboard();
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
      <label className="check">
        <input
          type="checkbox"
          checked={enterSends}
          aria-describedby={`${id}-enter-hint`}
          onChange={(event) => setEnterSends(event.target.checked)}
        />
        Enter sends
      </label>
      <p className="hint" id={`${id}-enter-hint`}>
        In the composer's Message and Details boxes, Enter sends and Shift+Enter starts a new line,
        as in a terminal. Off, Enter starts a new line. It holds whether or not the keyboard
        shortcuts are on. This browser keeps the choice, so turning it on here leaves your other
        browsers as they are.
      </p>
      <div className="actions">
        <button type="button" className="secondary" onClick={showHelp}>
          Show the shortcuts
        </button>
      </div>
    </>
  );
}
