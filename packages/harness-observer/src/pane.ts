// One terminal pane, the seam to the terminal. The tmux adapter, TmuxPane,
// implements it; tests use a real tmux server or a scripted fake.
export interface Pane {
  // snapshot reads the pane once. It rejects when the pane cannot be read at
  // all, such as when its terminal server is gone, which an observer reads as
  // the harness's activity being unknown.
  snapshot(): Promise<Snapshot>;
  // paste puts one line of text in the pane as a paste, which the harness
  // receives as one paste event where it asked for bracketed paste. It
  // rejects with a RangeError, before anything reaches the pane, for a line
  // that refusePaste refuses, so no text can end the paste early or reach the
  // harness as a key.
  paste(line: string): Promise<void>;
  // key presses one key in the pane. These two are the only keys a pane
  // sends: never an ordinary character, which a dialog may take as a
  // choice, and never Escape, which harnesses bind to leaving modes,
  // clearing input and rewinding.
  key(key: Key): Promise<void>;
}

export type Key = "Backspace" | "Enter";

// A run of faint text on a row, by the indexes of its first character and
// of the one after its last, counted in code points of the row's text.
export interface FaintRun {
  readonly row: number;
  readonly from: number;
  readonly to: number;
}

// What one reading of a pane found. Every field comes from the terminal or
// the operating system; the screen's text is untrusted, since whatever runs
// in the pane draws it.
export interface Snapshot {
  // The visible screen, top to bottom, one entry per row, each without its
  // trailing spaces.
  readonly lines: readonly string[];
  // Where the screen shows faint text, drawn dim as a harness draws a hint
  // or a suggestion in its input: each run by its row and the characters of
  // that row's text it spans, from up to but not including to. Absent from
  // a pane that does not read the screen's attributes.
  readonly faint?: readonly FaintRun[];
  // The pane's width in columns.
  readonly width: number;
  // Where the cursor is, in columns and rows from 0, and whether it shows.
  readonly cursor: { readonly x: number; readonly y: number; readonly visible: boolean };
  // The terminal's foreground process group is the pane's first process, the
  // harness, and not something the harness started, such as an editor.
  readonly hostHasTerminal: boolean;
  // The terminal server holds exactly one pane.
  readonly onePane: boolean;
  // Keys sent to the pane do not reach the harness: the pane is in a mode,
  // such as tmux's copy mode, or its input is off.
  readonly keysBlocked: boolean;
  // When any client attached to the terminal server last sent it a key, in
  // ms since the epoch, at the latest; undefined with no client attached.
  // Keys a pane's own paste and key send are not a client's.
  readonly lastTyped: number | undefined;
  // When the snapshot was taken, in ms since the epoch.
  readonly at: number;
}

// Why a pane cannot be read where the cause is the machine or the caller's
// choice of pane, not the terminal server: "no-proc", no /proc, which reading
// a pane's processes needs and only Linux has; "old-tmux", a tmux that leaves
// the formats a reading asks for empty, which no tmux tested, 3.3 or later,
// does; and
// "not-ancestor", a pane whose first process is not an ancestor of the
// process its reader requires it to be (TmuxPaneOptions.requireAncestorOf).
// A pane rejects with it so its caller can say which.
export class PaneUnusable extends Error {
  readonly reason: "no-proc" | "old-tmux" | "not-ancestor";

  constructor(reason: PaneUnusable["reason"], message: string) {
    super(message);
    this.name = "PaneUnusable";
    this.reason = reason;
  }
}

// refusePaste throws a RangeError for a line a pane must not paste: one that
// holds a line break or a control character, C0, DEL or C1, any of which
// could end a bracketed paste early, submit it, or reach the harness as a
// key.
export function refusePaste(line: string): void {
  if (lineBreakOrControl.test(line)) {
    throw new RangeError("a pasted line cannot hold a line break or a control character");
  }
}

const lineBreakOrControl = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// sameScreen says whether two snapshots show the same screen: the same rows,
// width and cursor.
export function sameScreen(a: Snapshot, b: Snapshot): boolean {
  return (
    a.width === b.width &&
    a.cursor.x === b.cursor.x &&
    a.cursor.y === b.cursor.y &&
    a.cursor.visible === b.cursor.visible &&
    a.lines.length === b.lines.length &&
    a.lines.every((line, i) => line === b.lines[i])
  );
}
