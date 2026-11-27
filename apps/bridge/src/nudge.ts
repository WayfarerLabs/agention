import type { NudgeTexts } from "@wayfarerlabs/agention-harness-observer";
import { randomBytes } from "node:crypto";

// The nudge's side in the bridge: the two texts a nudge asks the harness
// observer to put at the agent's prompt. Both are this file's constants, the
// nudge marker and an attempt id drawn at random: nothing from the server,
// the operator, an agent or the screen ever reaches them, so nothing anyone
// wrote reaches the agent's prompt through a nudge. The observer refuses a
// text that is not all printable ASCII, so both are.

// The most characters either text takes, so each fits one input line of a
// terminal 80 columns wide, beside the host's prompt marker and border.
export const nudgeTextLimit = 72;

// The marker every nudge's texts carry, followed by the attempt's id, so
// nudge text is known for what it is wherever it is seen, and an attempt
// takes only its own texts, which bear its own id, as its own.
export const nudgeMarker = "Agention nudge";

// The attempt id's length in hex digits: 48 random bits, so two attempts
// never share one.
const idDigits = 12;

// markedBy matches nudge text: whatever starts with the marker, as either
// text does, and so does what is left of one partly removed from its end or
// typed after, however little of its id is left.
export const markedBy = new RegExp(`^${nudgeMarker}`);

// The texts of one nudge attempt, with the id they carry.
export interface AttemptTexts extends NudgeTexts {
  readonly id: string;
}

// nudgeTexts gives the texts of a new attempt, each starting with the marker
// and an id drawn for this attempt alone. The warning says a nudge is coming
// and that typing anything stops it; the message, the same every time beyond
// its id, tells the agent to check in with Agention, names no thread, and
// keeps the id, so the harness's transcript records which attempt woke it.
// No nudge pastes over any text, since the observer nudges only at an empty
// input line; nudge text, any attempt's, is whatever markedBy matches, which
// decides only that a line holding it is reported as nudge text left at the
// prompt, which the operator is to clear, rather than as not ready.
export function nudgeTexts(): AttemptTexts {
  const id = randomBytes(idDigits / 2).toString("hex");
  const mark = `${nudgeMarker} ${id}`;
  return {
    id,
    warning: `${mark} coming; type anything to stop it.`,
    message: `${mark}: read unread threads, update your status.`,
    isNudgeText: (text) => markedBy.test(text),
  };
}
