import type { SessionState } from "@wayfarerlabs/agention-api";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { request } from "./api.ts";

// The browser's sign-in, as GET /session reports it. Signed in, it holds the
// CSRF token every change sends.

export type SessionStatus =
  | { status: "loading" }
  | { status: "unreachable"; failure: unknown }
  | { status: "ready"; state: SessionState };

export interface Session {
  status: SessionStatus;
  // The CSRF token, while signed in.
  csrf: string | undefined;
  // Records the state a passkey ceremony or sign-out answered with.
  update(state: SessionState): void;
  // Re-reads the session after an answer said the request was not
  // authenticated: signed out, the page then returns to sign-in; still signed
  // in (another tab signed in again, say), the new CSRF token replaces the old.
  recheck(): void;
  // Reads the session again after it could not be reached.
  retry(): void;
  // Holds the page's own asking from the moment the operator starts ending
  // the session, by signing out or by removing the passkey that signed this
  // browser in, and returns the release for an ending that failed or did not
  // sign the browser out. The signed-out page releases every hold.
  signingOut(): () => void;
  // Aborted while any ending holds the page's asking, and renewed once none
  // does. While it is aborted the page asks nothing that needs the session on
  // its own, as its polls and refreshes do, since the server may sign the
  // browser out before anything sent meanwhile arrives, which it would
  // refuse; a load under way that asks again, such as for its next page,
  // stops before it does.
  askSignal(): AbortSignal;
}

const SessionContext = createContext<Session | undefined>(undefined);

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (session === undefined) {
    throw new Error("useSession needs a SessionProvider");
  }
  return session;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>({ status: "loading" });
  const checking = useRef<Promise<void> | undefined>(undefined);
  // The endings under way, each held until it is released, and the signal
  // they abort, replaced once none is held.
  const holds = useRef(new Set<object>());
  const asking = useRef(new AbortController());
  const releaseAll = useCallback(() => {
    holds.current.clear();
    if (asking.current.signal.aborted) {
      asking.current = new AbortController();
    }
  }, []);
  const signedOut = status.status === "ready" && !status.state.signed_in;
  // Signed out, the page holds nothing that asks on its own, and signing in
  // again starts afresh.
  useEffect(() => {
    if (signedOut) {
      releaseAll();
    }
  }, [signedOut, releaseAll]);

  // Several views can be told at once that the session ended; they share one
  // check. A recheck that cannot reach the server keeps the state it knew.
  const check = useCallback(() => {
    checking.current ??= request<SessionState>("GET", "/session")
      .then(
        (state) => setStatus({ status: "ready", state }),
        (failure: unknown) =>
          setStatus((current) =>
            current.status === "ready" ? current : { status: "unreachable", failure },
          ),
      )
      .finally(() => {
        checking.current = undefined;
      });
  }, []);

  useEffect(check, [check]);

  // Kept the same across renders, so what depends on them does not reload as
  // the status changes.
  const signingOut = useCallback(() => {
    const hold = {};
    holds.current.add(hold);
    asking.current.abort();
    return () => {
      holds.current.delete(hold);
      if (holds.current.size === 0) {
        releaseAll();
      }
    };
  }, [releaseAll]);
  const askSignal = useCallback(() => asking.current.signal, []);

  const session = useMemo<Session>(
    () => ({
      status,
      csrf:
        status.status === "ready" && status.state.signed_in ? status.state.csrf_token : undefined,
      update: (state) => setStatus({ status: "ready", state }),
      recheck: check,
      retry: () => {
        setStatus({ status: "loading" });
        check();
      },
      signingOut,
      askSignal,
    }),
    [status, check, signingOut, askSignal],
  );
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}
