import type { Snapshot } from "./pane.ts";

// What the screens of one harness mean, the seam to the harness. screen is a
// pure function of one snapshot, so each profile is tested against screens
// captured from its harness.
export interface Profile {
  // The name a caller reports, such as "generic-strict".
  readonly name: string;
  // Whether the profile knows its harness's prompt marker, so that an input
  // line's text is what was typed after it, and empty at an empty prompt. A
  // profile that does not, a generic one, gives the cursor's whole row, which
  // cannot tell a draft from the prompt, so a nudge refuses it.
  readonly knowsMarker: boolean;
  screen(snapshot: Snapshot): Screen;
}

// What one screen shows: a dialog, the harness's input line, or anything
// else, and why a harness at rest stopped. A profile names a prompt kind or a
// stopped-by reason only where its harness's captured screens show it.
export type Screen =
  | { readonly kind: "input"; readonly input: InputLine; readonly stoppedBy?: StoppedBy }
  | {
      readonly kind: "permission_prompt" | "other_prompt" | "other";
      readonly stoppedBy?: StoppedBy;
    };

// The harness's input line, as the cursor's row shows it.
export interface InputLine {
  // What the line holds: after the prompt marker for a profile that knows
  // it, the whole row otherwise, with the spaces before the cursor that a
  // capture trims. A hint the harness shows in an empty input, as its
  // profile's captures show it, reads as empty.
  readonly text: string;
  // The cursor is right after the text. Where the text is not all printable
  // ASCII, whose width every terminal agrees on, it never is.
  readonly cursorAtEnd: boolean;
  // How many characters of printable ASCII can follow the text on its row,
  // leaving the cursor a column after them; none where the text is not all
  // printable ASCII.
  readonly room: number;
}

// Why a harness at rest stopped.
export type StoppedBy =
  | { readonly reason: "usage_limit"; readonly resetsAt?: Date }
  | { readonly reason: "block" }
  | { readonly reason: "error" };

// The profiles of one harness, by version: each entry applies from its
// version until the next.
export interface HarnessProfiles {
  // The name a configuration chooses these profiles by, such as "codex".
  readonly harness: string;
  // The name the harness's MCP client gives itself in `initialize`, such as
  // "codex-mcp-client", by which "auto" chooses these profiles.
  readonly client: string;
  // The profile for a version of the harness, or undefined for a version
  // below the oldest entry. The version comes from the MCP client, outside
  // this package, so anything it cannot read is undefined too.
  forVersion(version: string): Profile | undefined;
}
