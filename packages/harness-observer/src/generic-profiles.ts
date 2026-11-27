import type { Snapshot } from "./pane.ts";
import type { Profile } from "./profile.ts";

// The generic profiles make what sense they can of a harness with no profile
// of its own. Neither knows the harness's prompt marker, dialogs or messages,
// so neither ever names a prompt kind or a stopped-by reason: a screen is the
// input line or "other". Both take a hidden cursor as no input line, since
// every dialog of the harnesses captured so far hides it.

// The strict generic profile finds the input line only when the cursor shows
// with nothing after it on its row. It tells that from the row's text only
// where every character of the row is printable ASCII, one column each: a
// wide character, such as a CJK ideograph or an emoji, takes two columns and
// a combining mark none, by tables that differ between terminals, so a row
// holding any other character is never the input line.
export const genericStrict: Profile = {
  name: "generic-strict",
  screen(snapshot) {
    const row = cursorRow(snapshot);
    const atEnd = row !== undefined && printableAscii.test(row) && snapshot.cursor.x >= row.length;
    return { kind: atEnd ? "input" : "other" };
  },
};

// The lenient generic profile finds the input line whenever the cursor shows.
export const genericLenient: Profile = {
  name: "generic-lenient",
  screen(snapshot) {
    return { kind: cursorRow(snapshot) === undefined ? "other" : "input" };
  },
};

const printableAscii = /^[\x20-\x7e]*$/;

// cursorRow is the text of the row the cursor shows on, or undefined where
// it is hidden or off the screen.
function cursorRow(snapshot: Snapshot): string | undefined {
  const { cursor, lines } = snapshot;
  return cursor.visible ? lines[cursor.y] : undefined;
}
