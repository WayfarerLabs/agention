# Harness observer

Reads the terminal pane an agent harness, such as Claude Code or Codex, runs in, and says what
condition the harness is in: unknown, at a permission prompt or another prompt, running a turn, at
its prompt, or waiting. It knows terminals and harnesses and nothing of Agention, which bundles it
into the agent bridge, so it can move to a package of its own. It needs Linux, for `/proc`, and tmux
3.3 or later.

## Interface

Two seams keep terminals and harnesses apart:

- **`Pane`**, the terminal. `snapshot()` reads it once: the visible screen, the cursor, whether the
  harness holds the terminal, and whether the terminal server holds one pane. It rejects when the
  pane cannot be read at all. `TmuxPane` implements it for the one pane of a tmux server, named by
  its socket path, with one tmux client call and a read of `/proc/<pid>/stat`.
- **`Profile`**, the harness. `screen(snapshot)` says what one screen shows: a permission prompt,
  another prompt, the input line, or anything else, with why the harness stopped where its captured
  screens show it. A harness's profiles are a `HarnessProfiles`, which `versionTable` builds from
  the versions where its screens changed. Claude Code's and Codex's are this package's (see
  [Harness profiles](#harness-profiles)); the generic profiles, `generic-strict` and
  `generic-lenient`, serve a harness with no profile of its own, and never name a prompt or a
  reason. `selectProfile(name, client)` chooses one, by a name in `profileNames` (`generic-strict`,
  `generic-lenient`, `claude-code` or `codex`) or `auto` for the MCP client's harness and version,
  with the strict generic profile where none applies; a caller checks a configured name against
  `profileNames` itself.

`PaneObserver` joins them. `observations(signal)` reads the pane once a second until the signal
aborts and yields an `Observation`, a condition and since when, whenever the condition or the
stopped-by reason changes. It applies one order for every profile: unknown when the pane cannot be
read, holds more than one pane or the harness lacks the terminal; the profile's prompts, from the
latest screen alone; running when the screen changed within two seconds; at its prompt when the
profile finds the input line; waiting otherwise. A stopped-by reason shows only at rest.

```ts
import { PaneObserver, selectProfile, TmuxPane } from "@wayfarerlabs/agention-harness-observer";

const profile = selectProfile("auto", { name: "claude-code", version: "2.1.331" });
const observer = new PaneObserver(new TmuxPane("/path/to/tmux.sock"), profile);
for await (const { condition, since } of observer.observations(signal)) {
  // Report the condition. Screen text never leaves the observer.
}
```

Snapshots hold the screen's text, which whatever runs in the pane draws, so they stay in memory;
observations carry only conditions, times and fixed reasons.

## Harness profiles

Each harness's profiles apply from the version their screens were captured from. `auto` chooses them
by the name the harness's MCP client gives itself in `initialize`, which differs from the configured
name for Codex. A version that is not plain `major.minor.patch`, a prerelease included, gets the
strict generic profile.

| Configured name | MCP client name    | From      | Profile                                     |
| --------------- | ------------------ | --------- | ------------------------------------------- |
| `claude-code`   | `claude-code`      | `2.1.331` | `src/claude-code-profile.ts`, from captures |
| `codex`         | `codex-mcp-client` | `0.171.0` | `src/codex-profile.ts`, from captures       |

The MCP client names were recorded on 2026-11-24 from each host's `initialize` request: Claude Code
2.1.332 sent `clientInfo` with name `claude-code` and version `2.1.332`, and Codex 0.171.0 sent name
`codex-mcp-client` and version `0.171.0`.

Both hosts hide the cursor in every dialog seen, and show it on the input row, after a prompt
marker, at their prompt and during a turn. So a profile names a prompt only with the cursor hidden
and the dialog's own text on screen, and finds the input line only with the cursor showing on a row
that starts with the marker:

- **Claude Code**: the permission dialog asks "Do you want to proceed?" over a "❯ 1. Yes" choice;
  the trust dialog, an other prompt, shows "Accessing workspace:" and "Yes, I trust this folder".
  The marker is `❯` and a no-break space. Shell mode, entered with `!`, replaces `❯` with `!` and is
  no input line. Vim's normal mode shows no mode in the footer, the same footer as the normal
  editor's, so the profile cannot tell them apart and does not read the footer.
- **Codex**: the approval dialog asks "Would you like to run the following command?" over a "› 1.
  Yes, proceed" choice; the trust dialog ("Trust this folder?") and the update offer at start
  ("Update available", "› 1. Update now") are other prompts. The marker is `›` and a space.

Where a harness has no profile, the strict generic profile finds the input line only with the cursor
showing at the end of its row. Terminals disagree on how many columns a wide character, such as a
CJK ideograph or an emoji, or a combining mark takes, so it tells the end of a row only where the
row is all printable ASCII, and reads any other row as no input line; the lenient one finds the
input line wherever the cursor shows.

No profile names a stopped-by reason yet: usage limits, blocks and errors have no captures.

## Captures

The profiles' screens live in `src/captures`, one text file per screen, named for the harness, its
version and what it shows; `test/captures.ts` describes the format and reads them. The tests read
every capture through the profile `auto` chooses for it, and fail for a capture with no expected
reading.

To capture a harness's screens, run it in a tmux server of your own, 160 by 45, in a scratch Git
folder with a clean environment and Agention's plugin off, then save each screen with
`node test/capture.ts <socket> <file>`. Never press a key that approves a dialog. Before adding a
capture, scrub it: replace paths, user and host names, and account, plan, organization and email
text with neutral placeholders (the captures use `/path/to/project` and `PLAN`), keeping the
screen's structure, its glyphs and the cursor's row, as they were; then read it through.

The captures so far came from Claude Code 2.1.331 and 2.1.332 and Codex 0.171.0 on 2026-11-24.

## Tests

`npm run -w packages/harness-observer test` runs the unit tests, the profiles against their
captures, and the tests against real tmux servers, each started with no configuration on a socket in
a temporary directory and killed when the test ends. Those run `test/scripted-harness.ts`, a Node
script that draws a prompt, a running turn and a dialog and switches between them on a key.
