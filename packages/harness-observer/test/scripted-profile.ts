import { markedInput } from "../src/input-row.ts";
import type { Profile } from "../src/profile.ts";

// A profile of the scripted harness's screens, for tests, as a harness's own
// profile is of its captures: it knows the prompt marker, "> ", reads the
// dialog as a permission prompt, and reads the line "usage limit reached" as
// a usage limit with no known reset.
export const scriptedProfile: Profile = {
  name: "scripted",
  knowsMarker: true,
  screen(snapshot) {
    const limited = snapshot.lines.includes("usage limit reached");
    const stoppedBy = limited ? { stoppedBy: { reason: "usage_limit" as const } } : {};
    if (!snapshot.cursor.visible) {
      const dialog = snapshot.lines.includes("Allow this action?");
      return { kind: dialog ? "permission_prompt" : "other", ...stoppedBy };
    }
    const input = markedInput(snapshot, "> ");
    return input === undefined
      ? { kind: "other", ...stoppedBy }
      : { kind: "input", input, ...stoppedBy };
  },
};
