import type { AttentionCounts } from "@wayfarerlabs/agention-api";
import { authorizeAdministration, type Identity } from "../identity.ts";
import { countPendingRegistrations } from "./registrations.ts";
import type { Store } from "./store.ts";
import { countUnreadThreads } from "./thread-lists.ts";

// countAttention counts what waits on the operator, as the thread list and
// the sessions view each define it, in one transaction: the threads the
// list's Unread filter holds, and the registrations waiting for approval.
export function countAttention(store: Store, identity: Identity): AttentionCounts {
  const { db } = store;
  return db.transaction(() => {
    const now = store.clock();
    authorizeAdministration(db, identity, now);
    return {
      unread_threads: countUnreadThreads(store, identity, now),
      pending_registrations: countPendingRegistrations(db, now),
    };
  });
}
