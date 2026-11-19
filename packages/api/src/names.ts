import { z } from "zod";

// Agent, session and topic names: 1 to 63 lowercase ASCII letters, digits,
// hyphens and underscores, starting with a letter or digit. Names appear
// unescaped in URL paths and directory names, so the grammar admits nothing
// that needs escaping in either.
const nameBody = "[a-z0-9][a-z0-9_-]{0,62}";
export const namePattern = new RegExp(`^${nameBody}$`);

// A session as the operator's list names it: its agent's name and its own,
// as agent/session.
export const sessionPathPattern = new RegExp(`^${nameBody}/${nameBody}$`);

// A topic as the operator's list names it, with the session it belongs to,
// as agent/session/topic.
export const topicPathPattern = new RegExp(`^${nameBody}/${nameBody}/${nameBody}$`);

export const name = z
  .string()
  .regex(namePattern, "must be 1 to 63 of a-z, 0-9, _ and -, starting with a letter or digit");
