import { randomBytes } from "node:crypto";

// The nudge's side in the bridge: the two texts a nudge puts at the agent's
// prompt, and what the harness observer answers when asked to nudge. Both
// texts are this file's constants and a random token: nothing from the
// server, the operator, an agent or the screen ever reaches them, so nothing
// anyone wrote reaches the agent's prompt through a nudge.

// The step a nudge stopped at: not-ready when the observer found the session
// not ready and put nothing in the pane; warning when the warning was not
// exactly as the bridge put it there; cleared when the line was not empty
// after removing it; message when the message was not exactly as put there;
// and submitted when the host did not take the message once submitted.
export type NudgeStep = "not-ready" | "warning" | "cleared" | "message" | "submitted";

// What a nudge came to: sent, the message submitted and taken, or not sent,
// with the step it stopped at.
export type NudgeOutcome = { sent: true } | { sent: false; step: NudgeStep };

// The texts of one nudge: the warning, which the bridge removes and never
// submits, and the message, which it submits.
export interface NudgeTexts {
  warning: string;
  message: string;
}

// What carries out a nudge, with every check of the session's readiness and
// of each text in the pane: the harness observer's nudge.
export interface Nudger {
  nudge(texts: NudgeTexts): Promise<NudgeOutcome>;
}

// The most characters either text takes, so each fits one input line of a
// terminal 80 columns wide, beside the host's prompt marker and border.
export const nudgeTextLimit = 72;

// The message, the same every time: it tells the agent to check in with
// Agention, and names no thread.
export const nudgeMessage =
  "Check in with Agention: read your unread threads and update your status.";

// nudgeTexts gives the texts of a new nudge. The warning says a nudge is
// coming and that typing anything stops it, and ends with a token drawn for
// this nudge alone, so the observer can tell the bridge's own warning from
// anything else on the screen.
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
