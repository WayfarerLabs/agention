import { useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure } from "./api.ts";
import { useSession } from "./session.tsx";

// Data hooks: every view loads and changes data through these, so loading,
// live refresh, answers that arrive out of order and an ended sign-in are
// handled in one place. Thread writes, which also carry request ids and can
// be stale, go through useWriter, built on the same pieces.

// Views refresh this often while the page is visible, and whenever it regains
// focus.
export const refreshInterval = 10_000;

// An answer that says the browser is not signed in sends the session to be
// checked, which returns the page to sign-in if the session ended.
export function useUnauthenticatedCheck(): (failure: unknown) => void {
  const { recheck } = useSession();
  return useCallback(
    (failure: unknown) => {
      if (failure instanceof ApiFailure && failure.code === "unauthenticated") {
        recheck();
      }
    },
    [recheck],
  );
}

export interface Resource<T> {
  // The latest answer, kept while a refresh runs or after one fails.
  data: T | undefined;
  // Why the latest load failed, until one succeeds.
  failure: unknown;
  loading: boolean;
  refresh(): void;
}

// useResource loads what load returns, and refreshes it on an interval while
// the page is visible and when it regains focus, skipping a refresh while one
// is still under way; refresh() always loads. Answers can arrive out of order,
// and an older request never overwrites a newer one's result. Each view loads
// one thing for its whole life: the shell mounts a view afresh for each route.
export function useResource<T>(load: () => Promise<T>): Resource<T> {
  const [state, setState] = useState<{ data?: T; failure?: unknown }>({});
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const started = useRef(0);
  const applied = useRef(0);
  const running = useRef(0);
  const onFailure = useUnauthenticatedCheck();

  const refresh = useCallback(() => {
    const sequence = ++started.current;
    running.current++;
    setLoading(true);
    loadRef
      .current()
      .then(
        (data) => {
          if (sequence > applied.current) {
            applied.current = sequence;
            setState({ data });
          }
        },
        (failure: unknown) => {
          if (sequence > applied.current) {
            applied.current = sequence;
            setState((current) => ({ ...current, failure }));
            onFailure(failure);
          }
        },
      )
      .finally(() => {
        running.current--;
        if (sequence === started.current) {
          setLoading(false);
        }
      });
  }, [onFailure]);

  useEffect(() => {
    refresh();
    const poll = () => {
      if (document.visibilityState === "visible" && running.current === 0) {
        refresh();
      }
    };
    const timer = window.setInterval(poll, refreshInterval);
    window.addEventListener("focus", poll);
    document.addEventListener("visibilitychange", poll);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", poll);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [refresh]);

  return { data: state.data, failure: state.failure, loading, refresh };
}

// useFollowing loads what load returns while enabled, again whenever key
// changes, keeping the last answer until the next arrives; an answer for an
// earlier key never replaces a later one's. It serves what is wanted only
// while something is open, such as the filter sheet's counts, so it does not
// refresh on an interval, and a failed load leaves the last answer.
export function useFollowing<T>(
  key: string,
  enabled: boolean,
  load: () => Promise<T>,
): T | undefined {
  const [data, setData] = useState<T>();
  const loadRef = useRef(load);
  loadRef.current = load;
  const onFailure = useUnauthenticatedCheck();
  useEffect(() => {
    if (!enabled) {
      return;
    }
    let current = true;
    loadRef.current().then(
      (answer) => {
        if (current) {
          setData(answer);
        }
      },
      (failure: unknown) => {
        if (current) {
          onFailure(failure);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [key, enabled, onFailure]);
  return data;
}

export interface Page<T> {
  rows: T[];
  next?: string | undefined;
}

export interface PagedResource<T, Extra extends object = object> extends Resource<Page<T> & Extra> {
  // Loads one more page, which later refreshes keep.
  more(): void;
}

// usePages loads a paged list through useResource. Each refresh reloads every
// page shown so far, following the cursors, so the list stays whole and
// current as it changes. The first page's other fields, such as its total, come
// along with the rows.
export function usePages<T, Extra extends object = object>(
  loadPage: (cursor: string | undefined) => Promise<Page<T> & Extra>,
): PagedResource<T, Extra> {
  const pages = useRef(1);
  const resource = useResource<Page<T> & Extra>(async () => {
    const rows: T[] = [];
    let first: (Page<T> & Extra) | undefined;
    let next: string | undefined;
    for (let page = 0; page < pages.current; page++) {
      const answer = await loadPage(next);
      first ??= answer;
      rows.push(...answer.rows);
      next = answer.next;
      if (next === undefined) {
        break;
      }
    }
    return { ...(first as Page<T> & Extra), rows, next };
  });
  const { refresh } = resource;
  const more = useCallback(() => {
    pages.current += 1;
    refresh();
  }, [refresh]);
  return { ...resource, more };
}

export interface Action {
  pending: boolean;
  failure: unknown;
  // Runs a change with the session's CSRF token. It resolves to the change's
  // result, or to undefined when it failed, leaving the failure in failure.
  run<T>(change: (csrf: string | undefined) => Promise<T>): Promise<T | undefined>;
  clear(): void;
}

// useAction runs one kind of change the operator makes, such as approving a
// registration: whether one is under way, and why the last one failed.
export function useAction(): Action {
  const { csrf } = useSession();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<unknown>(undefined);
  const onFailure = useUnauthenticatedCheck();
  const run = useCallback(
    async <T>(change: (csrf: string | undefined) => Promise<T>) => {
      setPending(true);
      setFailure(undefined);
      try {
        return await change(csrf);
      } catch (error) {
        setFailure(error);
        onFailure(error);
        return undefined;
      } finally {
        setPending(false);
      }
    },
    [csrf, onFailure],
  );
  const clear = useCallback(() => setFailure(undefined), []);
  return { pending, failure, run, clear };
}

// useStillOpen gives a check of whether the component that called it is still
// on screen, so a change that lands after the operator moved on to another
// page does not act on the page they left.
export function useStillOpen(): () => boolean {
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  return useCallback(() => open.current, []);
}

// newRequestId makes the id that lets the server recognize a retried write.
// Each user action gets one, and keeps it across retries of that action.
export function newRequestId(): string {
  return `web-${crypto.randomUUID()}`;
}
