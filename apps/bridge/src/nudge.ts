import type { NudgeOutcome, NudgeTexts } from "@wayfarerlabs/agention-harness-observer";
import { randomBytes } from "node:crypto";

// The nudge's side in the bridge: the two texts a nudge asks the harness
// observer to put at the agent's prompt. Both are this file's constants and a
// random token: nothing from the server, the operator, an agent or the screen
// ever reaches them, so nothing anyone wrote reaches the agent's prompt
// through a nudge. The observer refuses a text that is not all printable
// ASCII, so both are.

// The most characters either text takes, so each fits one input line of a
// terminal 80 columns wide, beside the host's prompt marker and border.
export const nudgeTextLimit = 72;

// The message, the same every time: it tells the agent to check in with
// Agention, and names no thread.
export const nudgeMessage =
  "Check in with Agention: read your unread threads and update your status.";

// nudgeTexts gives the texts of a new nudge. The warning says a nudge is
// coming and that typing anything stops it, and ends with a token drawn for
// this nudge alone, in hex, so the observer can tell the bridge's own warning
// from anything else on the screen.
export function nudgeTexts(): NudgeTexts {
  const token = randomBytes(4).toString("hex");
  return {
    warning: `Agention nudge coming; type anything to stop it. [${token}]`,
    message: nudgeMessage,
  };
}

// The outcome of a nudge the bridge cannot ask for, with nothing put in the
// pane.
export const notReady: NudgeOutcome = { sent: false, step: "not-ready" };
