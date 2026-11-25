import { markedInput } from "./input-line.ts";
import type { Profile } from "./profile.ts";
import { versionTable } from "./version-table.ts";

// What Codex's screens show, from the captures named for it, beginning with
// 0.171.0's. A dialog hides the cursor:
//
// - a command's approval dialog asks "Would you like to run the following
//   command?" over numbered choices, the first "› 1. Yes, proceed (y)";
// - the dialog that asks to trust a folder asks "Trust this folder?" over a
//   "› 1. Trust and continue" choice, and the one that offers an update at
//   start shows "Update available" over a "› 1. Update now" choice; both are
//   other prompts.
//
// The input line is the cursor's row while the cursor shows after the
// marker, "›" and a space. An empty input shows a hint, such as "Ask Codex to
// do anything".
const codex0_171_0: Profile = {
  name: "codex",
  screen(snapshot) {
    const rows = snapshot.lines.map((line) => line.trim());
    if (!snapshot.cursor.visible) {
      if (
        rows.includes("Would you like to run the following command?") &&
        rows.some((row) => row.startsWith("› 1. Yes, proceed"))
      ) {
        return { kind: "permission-prompt" };
      }
      if (
        (rows.some((row) => row.startsWith("Trust this folder?")) &&
          rows.includes("› 1. Trust and continue")) ||
        (rows.some((row) => row.startsWith("Update available")) &&
          rows.some((row) => row.startsWith("› 1. Update now")))
      ) {
        return { kind: "other-prompt" };
      }
      return { kind: "other" };
    }
    const input = markedInput(snapshot, "› ", (text) => text === "Ask Codex to do anything");
    return input === undefined ? { kind: "other" } : { kind: "input", input };
  },
};

// Codex's profiles, by the version from which each applies. Codex's MCP
// client names itself "codex-mcp-client".
export const codex = versionTable("codex", "codex-mcp-client", [
  { from: "0.171.0", profile: codex0_171_0 },
]);
