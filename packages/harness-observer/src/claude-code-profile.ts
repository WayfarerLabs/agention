import { markedInput } from "./input-line.ts";
import type { Profile } from "./profile.ts";
import { versionTable } from "./version-table.ts";

// What Claude Code's screens show, from the captures named for it, beginning
// with 2.1.331's. A dialog hides the cursor:
//
// - a tool's permission dialog asks "Do you want to proceed?" over numbered
//   choices, the first "❯ 1. Yes";
// - the dialog that asks to trust a folder shows "Accessing workspace:" and a
//   "Yes, I trust this folder" choice, and is the other prompt.
//
// The input line is the cursor's row while the cursor shows after the
// marker, "❯" and a no-break space. Shell mode, entered by typing "!" at the
// start, puts "!" in place of "❯", so it is no input line. An empty input may
// show a hint, such as Try "fix typecheck errors". Vim mode shows
// "-- INSERT --" in the footer in insert mode and nothing in normal mode, the
// same footer as the normal editor's, so no screen tells vim's normal mode
// from the normal editor and the footer is not read; in vim's normal mode the
// cursor rests on a draft's last character, before its end.
const claudeCode2_1_331: Profile = {
  name: "claude-code",
  screen(snapshot) {
    const rows = snapshot.lines.map((line) => line.trim());
    if (!snapshot.cursor.visible) {
      if (
        rows.includes("Do you want to proceed?") &&
        rows.some((row) => row.startsWith("❯ 1. Yes"))
      ) {
        return { kind: "permission-prompt" };
      }
      if (
        rows.includes("Accessing workspace:") &&
        rows.some((row) => row.endsWith("Yes, I trust this folder"))
      ) {
        return { kind: "other-prompt" };
      }
      return { kind: "other" };
    }
    const input = markedInput(snapshot, "❯\u00a0", (text) => /^Try ".*"$/.test(text));
    return input === undefined ? { kind: "other" } : { kind: "input", input };
  },
};

// Claude Code's profiles, by the version from which each applies.
export const claudeCode = versionTable("claude-code", "claude-code", [
  { from: "2.1.331", profile: claudeCode2_1_331 },
]);
