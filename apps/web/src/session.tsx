import type { SessionState } from "@wayfarerlabs/agention-server-api";
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
    }),
    [status, check],
  );
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}
