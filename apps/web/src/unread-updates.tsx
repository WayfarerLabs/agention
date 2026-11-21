import type { UnreadUpdates } from "@wayfarerlabs/agention-api";
import { createContext, type ReactNode, useContext, useEffect, useRef } from "react";
import { request } from "./api.ts";
import { type Resource, useResource } from "./data.ts";
import { useLocation } from "./router.tsx";

// How many sessions have updates the operator has not read, which the
// Sessions tab shows: one small read, made while the operator is signed in
// and refreshed as views are, on an interval, on returning to the page and
// on going to another view, and at once when a view that reads a session's
// log refreshes, so reading lowers it.

const Context = createContext<Resource<UnreadUpdates> | undefined>(undefined);

export function UnreadUpdatesProvider({ children }: { children: ReactNode }) {
  const unread = useResource(() => request<UnreadUpdates>("GET", "/sessions/unread-updates"));
  const { pathname } = useLocation();
  const { refresh } = unread;
  // The resource loads as it mounts; each view gone to after loads it again.
  const shown = useRef(pathname);
  useEffect(() => {
    if (shown.current !== pathname) {
      shown.current = pathname;
      refresh();
    }
  }, [pathname, refresh]);
  return <Context.Provider value={unread}>{children}</Context.Provider>;
}

// useUnreadUpdates gives the count and its refresh, or undefined outside the
// provider, as while signed out.
export function useUnreadUpdates(): Resource<UnreadUpdates> | undefined {
  return useContext(Context);
}
