import { rowInput } from "./input-row.ts";
import type { Profile } from "./profile.ts";

// The generic profiles make what sense they can of a harness with no profile
// of its own. Neither knows the harness's prompt marker, dialogs or messages,
// so neither ever names a prompt kind or a stopped-by reason: a screen is the
// input line or "other", and the input line is the cursor's whole row. Both
// take a hidden cursor as no input line, since every dialog of the harnesses
// captured so far hides it.

// The strict generic profile finds the input line only when the cursor shows
// with nothing after it on its row. It tells that from the row's text only
// where every character of the row is printable ASCII, one column each: a
// wide character, such as a CJK ideograph or an emoji, takes two columns and
// a combining mark none, by tables that differ between terminals, so a row
// holding any other character is never the input line.
export const genericStrict: Profile = {
  name: "generic-strict",
  knowsMarker: false,
  screen(snapshot) {
    const input = rowInput(snapshot);
    return input?.cursorAtEnd === true ? { kind: "input", input } : { kind: "other" };
  },
};

// The lenient generic profile finds the input line whenever the cursor shows.
export const genericLenient: Profile = {
  name: "generic-lenient",
  knowsMarker: false,
  screen(snapshot) {
    const input = rowInput(snapshot);
    return input === undefined ? { kind: "other" } : { kind: "input", input };
  },
};
