import { z } from "zod";
import { queryNumber, threadNumber } from "./bounds.ts";
import { groupId, tagName } from "./groups-and-tags.ts";
import { name } from "./names.ts";
import { registrationId } from "./registrations.ts";

// What the routes share: the parameters their paths carry, each read from the
// path's text, and the answer of a change that has nothing to report.

export const sessionParams = z.object({ agent: name, session: name });
export type SessionParams = z.infer<typeof sessionParams>;

export const threadParams = sessionParams.extend({ thread: queryNumber(threadNumber) });
export type ThreadParams = z.infer<typeof threadParams>;

export const agentParams = z.object({ agent: name });
export const registrationParams = z.object({ id: queryNumber(registrationId) });
export const groupParams = z.object({ id: queryNumber(groupId) });
export const tagParams = z.object({ tag: tagName });

// The answer of a change that has nothing to report beyond its success.
export const done = z.object({});
export type Done = z.infer<typeof done>;
