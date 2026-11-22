import { z } from "zod";
import { sequence } from "./bounds.ts";

// What waits on the operator, counted for the web UI's navigation, each in
// the view that clears it: the threads not archived that hold an unread
// message, the thread list's total with Unread the only filter on, and the
// registrations waiting for approval, pending and not expired.
export const attentionCounts = z.object({
  unread_threads: sequence,
  pending_registrations: sequence,
});
export type AttentionCounts = z.infer<typeof attentionCounts>;
