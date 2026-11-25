# Harness observer

Reads the terminal pane an agent harness, such as Claude Code or Codex, runs in, and says what
condition the harness is in: unknown, at a permission prompt or another prompt, running a turn, at
its prompt, or waiting. It knows terminals and harnesses and nothing of Agention, which bundles it
into the agent bridge, so it can move to a package of its own. It needs Linux, for `/proc`, and tmux
3.3 or later.

## Interface

Two seams keep terminals and harnesses apart:

- **`Pane`**, the terminal. `snapshot()` reads it once: the visible screen, the cursor, whether the
  harness holds the terminal, whether keys reach it, the latest key from an attached client, and
  whether the terminal server holds one pane. It rejects when the pane cannot be read at all.
  `TmuxPane` implements it for the one pane of a tmux server, named by its socket path, with one
  tmux client call and a read of `/proc/<pid>/stat`.
- **`Profile`**, the harness. `screen(snapshot)` says what one screen shows: a permission prompt,
  another prompt, the input line, or anything else, with why the harness stopped where its captured
  screens show it. `genericStrict` and `genericLenient` serve a harness with no profile of its own,
  and never name a prompt or a reason. `profiles.select(name, client)` chooses one, by a configured
  name or `auto` for the MCP client's harness and version, with the strict generic profile where
  none applies.

`PaneObserver` joins them. `observations(signal)` reads the pane once a second until the signal
aborts and yields an `Observation`, a condition and since when, whenever the condition or the
stopped-by reason changes. It applies one order for every profile: unknown when the pane cannot be
read, holds more than one pane or the harness lacks the terminal; the profile's prompts, from the
latest screen alone; running when the screen changed within two seconds; at its prompt when the
profile finds the input line; waiting otherwise. A stopped-by reason shows only at rest.

```ts
import { PaneObserver, profiles, TmuxPane } from "@wayfarerlabs/agention-harness-observer";

const profile = profiles.select("auto", { name: "claude-code", version: "2.1.331" })!;
const observer = new PaneObserver(new TmuxPane("/path/to/tmux.sock"), profile);
for await (const { condition, since } of observer.observations(signal)) {
  // Report the condition. Screen text never leaves the observer.
}
```

Snapshots hold the screen's text, which whatever runs in the pane draws, so they stay in memory;
observations carry only conditions, times and fixed reasons.

## Tests

`npm run -w packages/harness-observer test` runs the unit tests and the tests against real tmux
servers, each started with no configuration on a socket in a temporary directory and killed when the
test ends. Those run `test/scripted-harness.ts`, a Node script that draws a prompt, a running turn
and a dialog and switches between them on a key.
