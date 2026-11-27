import { describe, expect, it } from "vitest";
import { captureNames, readCapture } from "../test/captures.ts";
import { type Clock, PaneObserver } from "./observer.ts";
import type { Pane } from "./pane.ts";
import type { Profile, Screen } from "./profile.ts";
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

// What each capture reads as, through the profile of its harness and version.
const expected: Record<string, { readonly profile: string; readonly kind: Kind }> = {
  "claude-code-2.1.331-trust-dialog": { profile: "claude-code", kind: "other_prompt" },
  "claude-code-2.1.331-vim-normal-mode": { profile: "claude-code", kind: "input" },
  "claude-code-2.1.331-vim-permission-dialog-1": {
    profile: "claude-code",
    kind: "permission_prompt",
  },
  "claude-code-2.1.331-vim-permission-dialog-2": {
    profile: "claude-code",
    kind: "permission_prompt",
  },
  "claude-code-2.1.331-vim-prompt-after-denial": { profile: "claude-code", kind: "input" },
  "claude-code-2.1.331-vim-prompt-empty": { profile: "claude-code", kind: "input" },
  "claude-code-2.1.331-vim-prompt-pasted": { profile: "claude-code", kind: "input" },
  "claude-code-2.1.331-vim-running-1": { profile: "claude-code", kind: "input" },
  "claude-code-2.1.331-vim-running-2": { profile: "claude-code", kind: "input" },
  "claude-code-2.1.331-vim-shell-mode": { profile: "claude-code", kind: "other" },
  "claude-code-2.1.332-permission-dialog": { profile: "claude-code", kind: "permission_prompt" },
  "claude-code-2.1.332-prompt-after-denial": { profile: "claude-code", kind: "input" },
  "claude-code-2.1.332-prompt-empty": { profile: "claude-code", kind: "input" },
  "claude-code-2.1.332-prompt-pasted": { profile: "claude-code", kind: "input" },
  "claude-code-2.1.332-running-1": { profile: "claude-code", kind: "input" },
  "claude-code-2.1.332-running-2": { profile: "claude-code", kind: "input" },
  "claude-code-2.1.332-shell-mode": { profile: "claude-code", kind: "other" },
  // No screen tells vim's normal mode from the normal editor, with an empty
  // input or once a paste has gone in.
  "claude-code-2.1.332-vim-normal-mode-empty": { profile: "claude-code", kind: "input" },
  "claude-code-2.1.332-vim-normal-mode-pasted": { profile: "claude-code", kind: "input" },
  "claude-code-2.1.332-vim-prompt-empty": { profile: "claude-code", kind: "input" },
  "codex-0.171.0-approval-dialog": { profile: "codex", kind: "permission_prompt" },
  "codex-0.171.0-prompt-after-denial": { profile: "codex", kind: "input" },
  "codex-0.171.0-prompt-empty": { profile: "codex", kind: "input" },
  "codex-0.171.0-prompt-pasted": { profile: "codex", kind: "input" },
  "codex-0.171.0-running-1": { profile: "codex", kind: "input" },
  "codex-0.171.0-running-2": { profile: "codex", kind: "input" },
  "codex-0.171.0-trust-dialog": { profile: "codex", kind: "other_prompt" },
  "codex-0.171.0-update-dialog": { profile: "codex", kind: "other_prompt" },
};

describe("the harness profiles", () => {
  it("expect a reading of every capture", () => {
    expect(Object.keys(expected).sort()).toEqual(captureNames());
  });

  for (const [capture, { profile, kind }] of Object.entries(expected)) {
    it(`read ${capture}`, () => {
      const chosen = profileFor(capture);
      expect(chosen.name).toBe(profile);
      expect(chosen.screen(readCapture(capture))).toEqual({ kind });
    });
  }
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
