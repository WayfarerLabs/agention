import type { AttentionCounts } from "@wayfarerlabs/agention-server-api";
import { createContext, type ReactNode, useContext, useEffect, useRef } from "react";
import { changeLanded, request } from "./api.ts";
import { type Resource, useResource } from "./data.ts";
import { useLocation } from "./router.tsx";

// What waits on the operator, which the navigation's tabs count: the unread
// threads on Threads and the registrations waiting on Sessions. One small
// read, made while the operator is signed in and refreshed as views are, on
// an interval, on returning to the page and on going to another view, and
// at once after any change the page makes lands, so reading a thread or
// deciding a registration clears its count.

const Context = createContext<Resource<AttentionCounts> | undefined>(undefined);

export function AttentionProvider({ children }: { children: ReactNode }) {
  const attention = useResource(() => request<AttentionCounts>("GET", "/attention"));
  const { pathname } = useLocation();
  const { refresh } = attention;
  // The resource loads as it mounts; each view gone to after loads it again.
  const shown = useRef(pathname);
  useEffect(() => {
    if (shown.current !== pathname) {
      shown.current = pathname;
      refresh();
    }
  }, [pathname, refresh]);
  useEffect(() => {
    window.addEventListener(changeLanded, refresh);
    return () => window.removeEventListener(changeLanded, refresh);
  }, [refresh]);
  return <Context.Provider value={attention}>{children}</Context.Provider>;
}

// useAttention gives the counts and their refresh, or undefined outside the
// provider, as while signed out.
export function useAttention(): Resource<AttentionCounts> | undefined {
  return useContext(Context);
}
