// One terminal pane, the seam to the terminal. The tmux adapter, TmuxPane,
// implements it; tests use a real tmux server or a scripted fake.
export interface Pane {
  // snapshot reads the pane once. It rejects when the pane cannot be read at
  // all, such as when its terminal server is gone, which an observer reads as
  // the harness's condition being unknown.
  snapshot(): Promise<Snapshot>;
}

// What one reading of a pane found. Every field comes from the terminal or
// the operating system; the screen's text is untrusted, since whatever runs
// in the pane draws it.
export interface Snapshot {
  // The visible screen, top to bottom, one entry per row, each without its
  // trailing spaces.
  readonly lines: readonly string[];
  // The pane's width in columns.
  readonly width: number;
  // Where the cursor is, in columns and rows from 0, and whether it shows.
  readonly cursor: { readonly x: number; readonly y: number; readonly visible: boolean };
  // The terminal's foreground process group is the pane's first process, the
  // harness, and not something the harness started, such as an editor.
  readonly hostHasTerminal: boolean;
  // A mode, such as tmux's copy mode, keeps keys from the harness.
  readonly keysBlocked: boolean;
  // The latest key from any attached client, in ms since the epoch, or
  // undefined when no client is attached.
  readonly lastTyped: number | undefined;
  // The terminal server holds exactly one pane.
  readonly onePane: boolean;
  // When the snapshot was taken, in ms since the epoch.
  readonly at: number;
}
