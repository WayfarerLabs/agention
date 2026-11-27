import { z } from "zod";
import { nameBody, namePattern } from "./name-pattern.ts";

// The name grammar lives in its own module, which imports nothing.
export { namePattern };

// A session as the operator's list names it: its agent's name and its own,
// as agent/session.
export const sessionPathPattern = new RegExp(`^${nameBody}/${nameBody}$`);

// A topic as the operator's list names it, with the session it belongs to,
// as agent/session/topic.
export const topicPathPattern = new RegExp(`^${nameBody}/${nameBody}/${nameBody}$`);

export const name = z
  .string()
  .regex(namePattern, "must be 1 to 63 of a-z, 0-9, _ and -, starting with a letter or digit");
