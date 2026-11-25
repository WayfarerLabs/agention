import { inputLine } from "./input-line.ts";
import type { Snapshot } from "./pane.ts";
import type { InputLine, Profile, Screen } from "./profile.ts";

// The generic profiles make what sense they can of a harness with no profile
// of its own. Neither knows the harness's prompt marker, dialogs or messages,
// so neither ever names a prompt kind or a stopped-by reason: a screen is the
// input line or "other". Both take a hidden cursor as no input line, since
// every dialog of the harnesses captured so far hides it.

// The strict generic profile finds the input line only when the cursor shows
// with nothing after it on its row.
export const genericStrict: Profile = {
  name: "generic-strict",
  screen(snapshot) {
    return inputScreen(snapshot, (input) => input.cursorAtEnd);
  },
};

// The lenient generic profile finds the input line whenever the cursor shows.
export const genericLenient: Profile = {
  name: "generic-lenient",
  screen(snapshot) {
    return inputScreen(snapshot, () => true);
  },
};

function inputScreen(snapshot: Snapshot, accept: (input: InputLine) => boolean): Screen {
  // Without a known prompt marker, the whole row is the input line's text.
  const input = inputLine(snapshot, 0);
  return input !== undefined && accept(input) ? { kind: "input", input } : { kind: "other" };
}
