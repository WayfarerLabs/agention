import type { Snapshot } from "./pane.ts";

// What the screens of one harness mean, the seam to the harness. screen is a
// pure function of one snapshot, so each profile is tested against screens
// captured from its harness.
export interface Profile {
  // The name a caller reports, such as "generic-strict".
  readonly name: string;
  screen(snapshot: Snapshot): Screen;
}

// What one screen shows: a dialog, the harness's input line, or anything
// else, and why a harness at rest stopped. A profile names a prompt kind or a
// stopped-by reason only where its harness's captured screens show it.
export interface Screen {
  readonly kind: "permission_prompt" | "other_prompt" | "input" | "other";
  readonly stoppedBy?: StoppedBy;
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
