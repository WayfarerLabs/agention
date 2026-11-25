import { describe, expect, it } from "vitest";
import { captureNames, readCapture } from "../test/captures.ts";
import { type Clock, PaneObserver } from "./observer.ts";
import type { Pane } from "./pane.ts";
import type { Profile, Screen } from "./profile.ts";
import { type HarnessClient, profiles } from "./registry.ts";

// The MCP client each harness's captures came from, by the prefix of their
// names, as the harness names itself in `initialize`.
const clients: Record<string, string> = { "claude-code": "claude-code", codex: "codex-mcp-client" };

// The profile "auto" chooses for the harness and version a capture names.
function profileFor(capture: string): Profile {
  const [, harness, version] = /^(claude-code|codex)-(\d+\.\d+\.\d+)-/.exec(capture) ?? [];
  const client: HarnessClient = { name: clients[harness ?? ""] ?? "", version: version ?? "" };
  return profiles.select("auto", client)!;
}

function input(text: string, cursorAtEnd: boolean, room: number): Screen {
  return { kind: "input", input: { text, cursorAtEnd, room } };
}

const permission: Screen = { kind: "permission-prompt" };
const otherPrompt: Screen = { kind: "other-prompt" };
const other: Screen = { kind: "other" };
const empty = input("", true, 158);

// What each capture reads as, through the profile of its harness and version.
const expected: Record<string, { readonly profile: string; readonly screen: Screen }> = {
  "claude-code-2.1.331-trust-dialog": { profile: "claude-code", screen: otherPrompt },
  // Vim's normal mode leaves the cursor on the draft's last character.
  "claude-code-2.1.331-vim-normal-mode": {
    profile: "claude-code",
    screen: input("Reply with the single word ok.", false, 128),
  },
  "claude-code-2.1.331-vim-permission-dialog-1": { profile: "claude-code", screen: permission },
  "claude-code-2.1.331-vim-permission-dialog-2": { profile: "claude-code", screen: permission },
  "claude-code-2.1.331-vim-prompt-after-denial": { profile: "claude-code", screen: empty },
  "claude-code-2.1.331-vim-prompt-empty": { profile: "claude-code", screen: empty },
  "claude-code-2.1.331-vim-prompt-pasted": {
    profile: "claude-code",
    screen: input("Reply with the single word ok.", true, 128),
  },
  "claude-code-2.1.331-vim-running-1": { profile: "claude-code", screen: empty },
  "claude-code-2.1.331-vim-running-2": { profile: "claude-code", screen: empty },
  "claude-code-2.1.331-vim-shell-mode": { profile: "claude-code", screen: other },
  "claude-code-2.1.332-permission-dialog": { profile: "claude-code", screen: permission },
  "claude-code-2.1.332-prompt-after-denial": { profile: "claude-code", screen: empty },
  "claude-code-2.1.332-prompt-empty": { profile: "claude-code", screen: empty },
  "claude-code-2.1.332-prompt-pasted": {
    profile: "claude-code",
    screen: input("Run the shell command: touch x.txt", true, 124),
  },
  "claude-code-2.1.332-running-1": { profile: "claude-code", screen: empty },
  "claude-code-2.1.332-running-2": { profile: "claude-code", screen: empty },
  "claude-code-2.1.332-shell-mode": { profile: "claude-code", screen: other },
  // No screen tells vim's normal mode from the normal editor, with an empty
  // input or once a paste has gone in.
  "claude-code-2.1.332-vim-normal-mode-empty": { profile: "claude-code", screen: empty },
  "claude-code-2.1.332-vim-normal-mode-pasted": {
    profile: "claude-code",
    screen: input("abc", true, 155),
  },
  "claude-code-2.1.332-vim-prompt-empty": { profile: "claude-code", screen: empty },
  "codex-0.171.0-approval-dialog": { profile: "codex", screen: permission },
  "codex-0.171.0-prompt-after-denial": { profile: "codex", screen: empty },
  "codex-0.171.0-prompt-empty": { profile: "codex", screen: empty },
  "codex-0.171.0-prompt-pasted": {
    profile: "codex",
    screen: input("Run the shell command: touch x.txt", true, 124),
  },
  "codex-0.171.0-running-1": { profile: "codex", screen: empty },
  "codex-0.171.0-running-2": { profile: "codex", screen: empty },
  "codex-0.171.0-trust-dialog": { profile: "codex", screen: otherPrompt },
  "codex-0.171.0-update-dialog": { profile: "codex", screen: otherPrompt },
};

describe("the harness profiles", () => {
  it("expect a reading of every capture", () => {
    expect(Object.keys(expected).sort()).toEqual(captureNames());
  });

  for (const [capture, { profile, screen }] of Object.entries(expected)) {
    it(`read ${capture}`, () => {
      const chosen = profileFor(capture);
      expect(chosen.name).toBe(profile);
      expect(chosen.screen(readCapture(capture))).toEqual(screen);
    });
  }

  it("find no input line on a hint's row once the cursor has moved off its start", () => {
    const snapshot = readCapture("codex-0.171.0-prompt-empty");
    const moved = { ...snapshot, cursor: { ...snapshot.cursor, x: 10 } };
    expect(profileFor("codex-0.171.0-prompt-empty").screen(moved)).toEqual(
      input("Ask Codex to do anything", false, 134),
    );
  });
});

// replay reads captures through the observer, one a second from time 0, with
// the profile of the first capture's harness, and returns what it yielded.
async function replay(captures: readonly string[]): Promise<object[]> {
  const controller = new AbortController();
  let index = 0;
  let now = 0;
  const pane: Pane = {
    async snapshot() {
      const capture = captures[index];
      if (capture === undefined) {
        controller.abort();
        throw new Error("the captures ran out");
      }
      now = index++ * 1000;
      return readCapture(capture, now);
    },
  };
  const clock: Clock = { now: () => now, sleep: async () => {} };
  const seen: object[] = [];
  const observer = new PaneObserver(pane, profileFor(captures[0]!), clock);
  for await (const { condition, since } of observer.observations(controller.signal)) {
    seen.push({ condition, since: since.getTime() });
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
      { condition: "running", since: 1000 },
      { condition: "permission-prompt", since: 4000 },
      { condition: "running", since: 8000 },
      { condition: "at-prompt", since: 10000 },
      { condition: "running", since: 11000 },
      { condition: "waiting", since: 13000 },
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
      { condition: "other-prompt", since: 0 },
      { condition: "running", since: 1000 },
      { condition: "at-prompt", since: 3000 },
      { condition: "running", since: 4000 },
      { condition: "permission-prompt", since: 6000 },
    ]);
  });
});
