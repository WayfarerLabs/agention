# Harness observer

Reads the terminal pane an agent harness, such as Claude Code or Codex, runs in, and answers two
questions and gives a reason: is the harness running a turn, at rest or unknown; at rest, what does
its screen hold (its prompt, a permission prompt, another prompt, or nothing the profile
recognizes); and at rest, why did it stop, where its profile can tell. It can also nudge the
harness: put a warning and then a message in its input line, and submit the message, only while it
sits still at its prompt (see [Nudging](#nudging)). It knows terminals and harnesses and nothing of
Agention, which bundles it into the agent bridge, so it can move to a package of its own. It needs
Linux, for `/proc`, and tmux 3.3 or later.

## Interface

Two seams keep terminals and harnesses apart:

- **`Pane`**, the terminal. `snapshot()` reads it once: the visible screen, where it shows faint
  text, drawn dim as a harness draws a hint, the cursor, whether the harness holds the terminal,
  whether the terminal server holds one pane, whether keys reach the harness, and when an attached
  client last sent a key. It rejects when the pane cannot be read at all, and with `PaneUnusable`
  where the cause is the machine or the choice of pane: no `/proc`, a tmux that leaves the formats
  it is asked for empty, which no tmux tested, 3.3 or later, does, or a pane that is not the
  reader's. `paste(line)` puts one line in the pane as a paste, and refuses, before anything reaches
  the pane, a line holding a line break or a control character, so no text can end the paste early
  or arrive as a key; `key(key)` presses Backspace or Enter, the only two keys a pane sends.
  `TmuxPane` implements it for the one pane of a tmux server, named by its socket path: a reading is
  one tmux client call, whose `capture-pane -e` gives the screen's attributes, of which it keeps
  only which text is faint, and reads of `/proc/<pid>/stat`; keys count as blocked in copy mode or
  any other mode and while the pane's input is off, and a client's last key is its
  `client_activity`, which tmux gives to the second, so it reads as the end of that second; a paste
  goes through a buffer of its own, loaded from the client's input and deleted once pasted, so the
  operator's buffers are never read, replaced or reordered, and `paste-buffer -p` brackets it for a
  harness that asked for bracketed paste. Its `requireAncestorOf` option names a process, such as
  the reader's own, that the pane's first process must be an ancestor of, so a socket that names
  some other pane is refused rather than read.
- **`Profile`**, the harness. `screen(snapshot)` says what one screen shows: a permission prompt,
  another prompt, the input line, or anything else, with why the harness stopped where its captured
  screens show it. The input line comes with its text, whether the cursor is at its end, and how
  many more characters fit on its row; text that is not all printable ASCII, whose width terminals
  disagree on, has no end the cursor is known to be at and no room. A harness's own profile knows
  its prompt marker, so the text is what follows it, and reads the hints its captures show in an
  empty input as empty, by their text or, where its harness draws them faint, by faint text that
  fills what follows the marker with the cursor right after it, so a draft never reads as a hint
  wherever the cursor sits; a generic profile gives the cursor's whole row, so it is never nudged
  through. Claude Code's and Codex's profiles are this package's (see
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

## Nudging

`nudge({ warning, message, isNudgeText }, { begin, signal })` puts two texts in the harness's input
line, both the caller's, and submits only the second: a warning that a nudge is coming, which anyone
at the terminal can stop by typing over it, and then the message. `isNudgeText` is how the caller
tells nudge text, its own or an earlier nudge's, from anything else the line may hold, as by a
marker every nudge's texts carry: a nudge pastes only into an empty line, and `isNudgeText` decides
only whether a line that is not empty is reported as nudge text left. It starts from the latest
observation of a running `observations`, so it is never ready without one, and runs one nudge at a
time. It nudges only through a profile that knows its harness's prompt marker, a harness's own: a
generic profile reads the cursor's whole row as the input line, so it cannot tell a draft someone
left at the prompt from an empty prompt, and `nudge` throws, before anything reaches the pane, for
an observer with one. It goes through these steps:

1. **`not-ready`**: nothing is sent unless the latest observation is at rest at the input line, with
   no usage limit before its reset, and a fresh reading shows the same screen, with one pane, the
   harness holding the terminal, keys reaching it, no key from any client for 10 seconds, and an
   empty input line with the cursor at its end and room for the longer text. Then it calls `begin`,
   once, as when its caller claims the nudge, and goes on only where that answers true and a reading
   after it still shows the same screen with no key typed meanwhile.
2. **`warning`**: it pastes the warning and confirms the line holds exactly it, cursor at its end;
   waits 5 seconds; and confirms again, with no client having typed.
3. **`cleared`**: it removes the warning one Backspace at a time, confirming before each next one
   that the last removed one character, until the line is empty, and goes on only where nothing
   beside the line changed since it was ready, both readings showing the line empty.
4. **`message`**: it pastes the message and confirms it as it did the warning.
5. **`submitted`**: it confirms the message once more, presses Enter, and within 5 seconds sees the
   line empty again and another row of the screen changed, as a turn starting shows.

It resolves to `{ outcome, step }`, the step it ended at and one of four outcomes:

- **`deferred`**: nothing of the nudge's stayed in the pane, so it may be tried again. Nothing was
  pasted, at `not-ready`, with `nudgeTextLeft` where it read the input line: `true` where the line
  held nudge text, as `isNudgeText` says, and `false` where it did not; or, at the confirmation
  after the warning's wait or before Enter, the line held exactly the nudge's own text but the rest
  of the screen had changed since it was pasted, as when the harness starts a turn or redraws, and
  the nudge took its text back, one confirmed Backspace at a time; or the screen beside the line
  changed while the warning was removed, before the message went in. Before Enter, where a reading
  finds the line empty, or finds no input line, as under a dialog or with a second pane, or the pane
  fails to be read or written, nothing yet shows the text is gone, since a paste can show late: it
  reads the pane again, and where it may have text in the line and finds it empty, again half a
  second later, and defers only where a reading finds the line empty with no key typed, once it has
  taken back its own text where the line holds exactly it.
- **`stopped`**: someone at the terminal stopped it: a key was typed since the nudge began, or the
  line held something other than the warning, or the nudge's text altered once confirmed.
- **`failed`**: the signal stopped it once something was pasted; the pane could not be read or
  written, or the profile failed on a screen, and no reading after showed the line empty; the input
  line went from the screen and was still gone half a second later; a Backspace did not shorten the
  line by one, such as in vim's normal mode, where Backspace moves the cursor; the message did not
  show exactly; anything went wrong once Enter was sent, or tried, since the harness may have taken
  the message; or the harness did not take it after Enter.
- **`sent`**: the harness took the message.

Only the input line and the cursor are compared for the texts themselves: a change elsewhere on the
screen takes the nudge's text back and defers it, never fails it. A nudge that a check ends before
Enter leaves the warning where it is, unless it took it back, and removes its message where a fresh
reading shows the line holding exactly it, in a pane that takes keys. One the pane fails, or the
profile, takes back whichever of its texts a fresh reading shows the line holding exactly, and
defers only once a reading confirms the line empty; a failure of that removal leaves it failed.
After Enter, the message is the harness's.

`signal` stops it: once it aborts, nothing more reaches the pane, not even a key that would remove
the nudge's own text, as suits a caller that another has taken over from; it ends deferred where
nothing was pasted, and failed otherwise.

Its guarantees:

- Every key directly follows a reading that confirmed the line holds exactly what the nudge expects,
  cursor at its end, in a pane that takes keys, so a key reaches a dialog only if one opens in the
  milliseconds between them. Only Backspace and Enter are ever pressed: never an ordinary character,
  which a dialog may take as a choice, and never Escape, which harnesses bind to leaving modes,
  clearing input and rewinding.
- Text reaches the pane only as pastes, which dialogs drop, and only the caller's two texts.
- It confirms against what the profile reads: the line, after the harness's prompt marker, holds the
  text alone.
- It never puts a text in a line it cannot be shown to fit: it throws a `RangeError`, before
  anything reaches the pane, for an empty text or one that is not all printable ASCII, and is not
  ready where the line has too little room.
- It knows nothing of what the texts say. Its waits and timeouts run on the observer's clock.

A harness that never asked for bracketed paste receives a paste as typed characters, which tmux
gives no way to tell; Claude Code and Codex both ask for it at start.

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
  editor's, so the profile cannot tell them apart and does not read the footer. An empty input shows
  a hint, such as `Try "..."`, or, after a turn where the account has prompt suggestions on, a
  suggestion of what to send next, drawn faint (2.1.332); faint text filling the input, with the
  cursor right after the marker, reads as empty.
- **Codex**: the approval dialog asks "Would you like to run the following command?" over a "› 1.
  Yes, proceed" choice; the trust dialog ("Trust this folder?") and the update offer at start
  ("Update available", "› 1. Update now") are other prompts. The marker is `›` and a space. Its
  captures carry no attributes, so its profile reads its hint by text alone.

Where a harness has no profile, the strict generic profile finds the input line only with the cursor
showing at the end of its row. Terminals disagree on how many columns a wide character, such as a
CJK ideograph or an emoji, or a combining mark takes, so it tells the end of a row only where the
row is all printable ASCII, and reads any other row as no input line; the lenient one finds the
input line wherever the cursor shows. Neither is nudged through.

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

The captures so far came from Claude Code 2.1.331 and 2.1.332 and Codex 0.171.0 on 2026-11-24,
without the screen's attributes, and Claude Code 2.1.332's prompt suggestion on 2026-11-27, with the
faint text marked, from a live test's `capture-pane -e`.

## Tests

`npm run -w packages/harness-observer test` runs the unit tests, the profiles against their
captures, and the tests against real tmux servers, each started with no configuration on a socket in
a temporary directory and killed when the test ends. Those run `test/scripted-harness.ts`, a Node
script that draws a prompt, a running turn and a dialog and switches between them on a key, with an
input line that takes pastes and typed characters, removes one on Backspace and submits on Enter, a
key that redraws part of the screen around the input, and options for a Backspace that only moves
the cursor, an Enter that does nothing, a dialog that opens at the second paste and a suggestion
drawn faint in an empty input. A test that needs a client attached, typing, attaches one through
util-linux's `script`.
