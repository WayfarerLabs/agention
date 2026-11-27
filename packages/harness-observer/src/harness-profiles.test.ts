import { describe, expect, it } from "vitest";
import { captureNames, readCapture } from "../test/captures.ts";
import { readingPane } from "../test/reading-pane.ts";
import { type Clock, PaneObserver } from "./observer.ts";
import type { InputLine, Profile, Screen } from "./profile.ts";
import { type HarnessClient, selectProfile } from "./registry.ts";

// The MCP client each harness's captures came from, by the prefix of their
// names, as the harness names itself in `initialize`.
const clients: Record<string, string> = { "claude-code": "claude-code", codex: "codex-mcp-client" };

// The profile "auto" chooses for the harness and version a capture names.
function profileFor(capture: string): Profile {
  const [, harness, version] = /^(claude-code|codex)-(\d+\.\d+\.\d+)-/.exec(capture) ?? [];
  const client: HarnessClient = { name: clients[harness ?? ""] ?? "", version: version ?? "" };
  return selectProfile("auto", client);
}

type Kind = Screen["kind"];

// The input line holding a text, typed after a marker two columns wide on a
// capture's 160 columns; "" for an empty input, a hint included.
function input(text: string, cursorAtEnd = true): InputLine {
  return { text, cursorAtEnd, room: 160 - 1 - 2 - text.length };
}

// What each capture reads as, through the profile of its harness and version.
const expected: Record<
  string,
  { readonly profile: string; readonly kind: Kind; readonly input?: InputLine }
> = {
  "claude-code-2.1.331-trust-dialog": { profile: "claude-code", kind: "other_prompt" },
  "claude-code-2.1.331-vim-normal-mode": {
    profile: "claude-code",
    kind: "input",
    input: input("Reply with the single word ok.", false),
  },
  "claude-code-2.1.331-vim-permission-dialog-1": {
    profile: "claude-code",
    kind: "permission_prompt",
  },
  "claude-code-2.1.331-vim-permission-dialog-2": {
    profile: "claude-code",
    kind: "permission_prompt",
  },
  "claude-code-2.1.331-vim-prompt-after-denial": {
    profile: "claude-code",
    kind: "input",
    input: input(""),
  },
  "claude-code-2.1.331-vim-prompt-empty": {
    profile: "claude-code",
    kind: "input",
    input: input(""),
  },
  "claude-code-2.1.331-vim-prompt-pasted": {
    profile: "claude-code",
    kind: "input",
    input: input("Reply with the single word ok."),
  },
  "claude-code-2.1.331-vim-running-1": { profile: "claude-code", kind: "input", input: input("") },
  "claude-code-2.1.331-vim-running-2": { profile: "claude-code", kind: "input", input: input("") },
  "claude-code-2.1.331-vim-shell-mode": { profile: "claude-code", kind: "other" },
  "claude-code-2.1.332-permission-dialog": { profile: "claude-code", kind: "permission_prompt" },
  "claude-code-2.1.332-prompt-after-denial": {
    profile: "claude-code",
    kind: "input",
    input: input(""),
  },
  "claude-code-2.1.332-prompt-empty": { profile: "claude-code", kind: "input", input: input("") },
  "claude-code-2.1.332-prompt-pasted": {
    profile: "claude-code",
    kind: "input",
    input: input("Run the shell command: touch x.txt"),
  },
  "claude-code-2.1.332-running-1": { profile: "claude-code", kind: "input", input: input("") },
  "claude-code-2.1.332-running-2": { profile: "claude-code", kind: "input", input: input("") },
  "claude-code-2.1.332-shell-mode": { profile: "claude-code", kind: "other" },
  // No screen tells vim's normal mode from the normal editor, with an empty
  // input or once a paste has gone in; at 2.1.331 the cursor sat on the
  // pasted text's last character rather than after it.
  "claude-code-2.1.332-vim-normal-mode-empty": {
    profile: "claude-code",
    kind: "input",
    input: input(""),
  },
  "claude-code-2.1.332-vim-normal-mode-pasted": {
    profile: "claude-code",
    kind: "input",
    input: input("abc"),
  },
  "claude-code-2.1.332-vim-prompt-empty": {
    profile: "claude-code",
    kind: "input",
    input: input(""),
  },
  // A suggestion of what to send next, drawn faint after a turn, is a hint.
  "claude-code-2.1.332-vim-prompt-suggestion": {
    profile: "claude-code",
    kind: "input",
    input: input(""),
  },
  "codex-0.171.0-approval-dialog": { profile: "codex", kind: "permission_prompt" },
  "codex-0.171.0-prompt-after-denial": { profile: "codex", kind: "input", input: input("") },
  "codex-0.171.0-prompt-empty": { profile: "codex", kind: "input", input: input("") },
  "codex-0.171.0-prompt-pasted": {
    profile: "codex",
    kind: "input",
    input: input("Run the shell command: touch x.txt"),
  },
  "codex-0.171.0-running-1": { profile: "codex", kind: "input", input: input("") },
  "codex-0.171.0-running-2": { profile: "codex", kind: "input", input: input("") },
  "codex-0.171.0-trust-dialog": { profile: "codex", kind: "other_prompt" },
  "codex-0.171.0-update-dialog": { profile: "codex", kind: "other_prompt" },
};

describe("the harness profiles", () => {
  it("expect a reading of every capture", () => {
    expect(Object.keys(expected).sort()).toEqual(captureNames());
  });

  it("read a hint as an empty input only with the cursor right after the marker", () => {
    for (const capture of ["claude-code-2.1.332-prompt-empty", "codex-0.171.0-prompt-empty"]) {
      const snapshot = readCapture(capture);
      const moved = { ...snapshot, cursor: { ...snapshot.cursor, x: 3 } };
      expect(profileFor(capture).screen(moved)).toMatchObject({
        kind: "input",
        input: { text: expect.stringMatching(/^(Try|Ask Codex)/), cursorAtEnd: false },
      });
    }
  });

  it("read faint text as a hint only where all of it is faint, the cursor right after the marker", () => {
    const capture = "claude-code-2.1.332-vim-prompt-suggestion";
    const snapshot = readCapture(capture);
    const profile = profileFor(capture);
    const suggestion = "approved, check again";
    const typed = (changed: Partial<typeof snapshot>) =>
      profile.screen({ ...snapshot, ...changed });
    // Without the screen's attributes, as a draft typed there.
    const { faint: _, ...bare } = snapshot;
    expect(profile.screen(bare)).toMatchObject({ input: { text: suggestion } });
    // A draft with the cursor moved to its start, or partly faint.
    expect(typed({ faint: [] })).toMatchObject({ input: { text: suggestion } });
    expect(typed({ faint: [{ row: 42, from: 2, to: 10 }] })).toMatchObject({
      input: { text: suggestion },
    });
    // Faint, with the cursor anywhere but right after the marker.
    expect(typed({ cursor: { ...snapshot.cursor, x: 5 } })).toMatchObject({
      input: { text: suggestion, cursorAtEnd: false },
    });
    // Codex's profile reads no faint text as a hint, which its captures do
    // not show.
    const codex = profileFor("codex-0.171.0-prompt-empty");
    const codexScreen = readCapture("codex-0.171.0-prompt-pasted");
    const row = codexScreen.cursor.y;
    const text = codex.screen({
      ...codexScreen,
      cursor: { ...codexScreen.cursor, x: 2 },
      faint: [{ row, from: 2, to: 200 }],
    });
    expect(text).toMatchObject({ input: { text: "Run the shell command: touch x.txt" } });
  });

  for (const [capture, { profile, ...screen }] of Object.entries(expected)) {
    it(`read ${capture}`, () => {
      const chosen = profileFor(capture);
      expect(chosen.name).toBe(profile);
      expect(chosen.screen(readCapture(capture))).toEqual(screen);
    });
  }
});

// replay reads captures through the observer, one a second from time 0, with
// the profile of the first capture's harness, and returns what it yielded.
async function replay(captures: readonly string[]): Promise<object[]> {
  const controller = new AbortController();
  let index = 0;
  let now = 0;
  const pane = readingPane(async () => {
    const capture = captures[index];
    if (capture === undefined) {
      controller.abort();
      throw new Error("the captures ran out");
    }
    now = index++ * 1000;
    return readCapture(capture, now);
  });
  const clock: Clock = { now: () => now, sleep: async () => {} };
  const seen: object[] = [];
  const observer = new PaneObserver(pane, profileFor(captures[0]!), clock);
  for await (const { activity, screen, since } of observer.observations(controller.signal)) {
    seen.push({ activity, ...(screen !== undefined && { screen }), since: since.getTime() });
  }
  return seen;
}

describe("the observer, replaying captures", () => {
  it("reads Claude Code's turn, its blinking permission dialog, its prompt and shell mode", async () => {
    const running = ["claude-code-2.1.331-vim-running-1", "claude-code-2.1.331-vim-running-2"];
    const dialog = [
      "claude-code-2.1.331-vim-permission-dialog-1",
      "claude-code-2.1.331-vim-permission-dialog-2",
    ];
    expect(
      await replay([
        ...running,
        ...running,
        ...dialog,
        ...dialog,
        ...Array(3).fill("claude-code-2.1.331-vim-prompt-after-denial"),
        ...Array(3).fill("claude-code-2.1.331-vim-shell-mode"),
      ]),
    ).toEqual([
      { activity: "running", since: 1000 },
      { activity: "at_rest", screen: "permission_prompt", since: 4000 },
      { activity: "running", since: 8000 },
      { activity: "at_rest", screen: "input", since: 10000 },
      { activity: "running", since: 11000 },
      { activity: "at_rest", screen: "other", since: 13000 },
    ]);
  });

  it("reads Codex's trust dialog, its prompt, a turn and its approval dialog", async () => {
    expect(
      await replay([
        "codex-0.171.0-trust-dialog",
        ...Array(3).fill("codex-0.171.0-prompt-empty"),
        "codex-0.171.0-running-1",
        "codex-0.171.0-running-2",
        ...Array(3).fill("codex-0.171.0-approval-dialog"),
      ]),
    ).toEqual([
      { activity: "at_rest", screen: "other_prompt", since: 0 },
      { activity: "running", since: 1000 },
      { activity: "at_rest", screen: "input", since: 3000 },
      { activity: "running", since: 4000 },
      { activity: "at_rest", screen: "permission_prompt", since: 6000 },
    ]);
  });
});
