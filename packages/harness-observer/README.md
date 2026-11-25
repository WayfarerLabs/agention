# Harness observer

Reads the terminal pane an agent harness, such as Claude Code or Codex, runs in, and answers two
questions and gives a reason: is the harness running a turn, at rest or unknown; at rest, what does
its screen hold (its prompt, a permission prompt, another prompt, or nothing the profile
recognizes); and at rest, why did it stop, where its profile can tell. It knows terminals and
harnesses and nothing of Agention, which bundles it into the agent bridge, so it can move to a
package of its own. It needs Linux, for `/proc`, and tmux 3.3 or later.

## Interface

Two seams keep terminals and harnesses apart:

- **`Pane`**, the terminal. `snapshot()` reads it once: the visible screen, the cursor, whether the
  harness holds the terminal, and whether the terminal server holds one pane. It rejects when the
  pane cannot be read at all, and with `PaneUnusable` where the cause is the machine or the choice
  of pane: no `/proc`, a tmux older than 3.3, which leaves the formats it is asked for empty, or a
  pane that is not the reader's. `TmuxPane` implements it for the one pane of a tmux server, named
  by its socket path, with one tmux client call and reads of `/proc/<pid>/stat`. Its
  `requireAncestorOf` option names a process, such as the reader's own, that the pane's first
  process must be an ancestor of, so a socket that names some other pane is refused rather than
  read.
- **`Profile`**, the harness. `screen(snapshot)` says what one screen shows: a permission prompt,
  another prompt, the input line, or anything else, with why the harness stopped where its captured
  screens show it. Claude Code's and Codex's profiles are this package's (see
  [Harness profiles](#harness-profiles)). Adding a harness, or a version whose screens changed, is a
  change inside the package, never through its interface: internally, a harness's profiles are a
  `HarnessProfiles` (`src/profile.ts`), which `versionTable` (`src/version-table.ts`) builds from
  the versions where its screens changed, and the registry (`src/registry.ts`) lists them; none of
  these is exported. The generic profiles, `generic-strict` and `generic-lenient`, serve a harness
  with no profile of its own, and never name a prompt or a reason. `selectProfile(name, client)`
  chooses one, by a name in `profileNames` (`generic-strict`, `generic-lenient`, `claude-code` or
  `codex`) or `auto` for the MCP client's harness and version, with the strict generic profile where
  none applies; a caller checks a configured name against `profileNames` itself.

`PaneObserver` joins them. `observations(signal)` reads the pane once a second until the signal
aborts and yields an `Observation` whenever its activity, screen or stopped-by reason changes:

- `activity`: `running`, `at_rest` or `unknown`;
- `screen`, at rest only: what the profile finds on the screen, `input` for the harness's prompt,
  `permission_prompt`, `other_prompt`, or `other` for nothing it recognizes;
- `stoppedBy`, at rest only: why the harness stopped (`usage_limit`, with its reset time where the
  screen shows it, `block` or `error`), where the profile can tell. It sits beside whatever prompt
  is on the screen: a reason with a prompt means the harness stopped for that reason with the prompt
  beside it, such as a menu shown at a usage limit, and a prompt without one means it stopped on the
  prompt;
- `since`: when the activity or the screen last changed, which a change in the reason alone keeps.

It applies one order for every profile: unknown when the pane cannot be read, holds more than one
pane or the harness lacks the terminal; at rest with the profile's permission or other prompt, from
the latest screen alone, so a dialog's animation never reads as running; running when the screen
changed within two seconds; at rest otherwise, with what the profile finds on the screen.

```ts
import { PaneObserver, selectProfile, TmuxPane } from "@wayfarerlabs/agention-harness-observer";

const profile = selectProfile("auto", { name: "claude-code", version: "2.1.331" });
const observer = new PaneObserver(new TmuxPane("/path/to/tmux.sock"), profile);
for await (const { activity, screen, stoppedBy, since } of observer.observations(signal)) {
  // Report them. Screen text never leaves the observer.
}
```

Snapshots hold the screen's text, which whatever runs in the pane draws, so they stay in memory;
observations carry only fixed kinds, times and fixed reasons.

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
