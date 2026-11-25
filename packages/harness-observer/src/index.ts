// What the agent bridge uses, and the types its signatures need.
export { genericStrict } from "./generic-profiles.ts";
export { type Observation, PaneObserver } from "./observer.ts";
export type { Pane, Snapshot } from "./pane.ts";
export type { Profile, StoppedBy } from "./profile.ts";
export { type HarnessClient, profileNames, selectProfile } from "./registry.ts";
export { TmuxPane } from "./tmux-pane.ts";
