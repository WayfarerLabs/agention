import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
  // Loads afresh, settling once that load's answer, or its failure, has
  // applied or been passed over for a newer one's. It settles true when the
  // data shown then is at least as new as that load, brought by it or by a
  // newer one, and false when it is older, as when the load failed. Once an
  // ending of the session has started it loads nothing and settles false.
  refresh(): Promise<boolean>;
}

// useResource loads what load returns, and refreshes it on an interval while
// the page is visible and when it regains focus, skipping a refresh while one
// is still under way; refresh() always loads, unless an ending of the session
// has started (Session.askSignal). Answers can arrive out of order, and an
// older request never overwrites a newer one's result. Each view loads one
// thing for its whole life: the shell mounts a view afresh for each route.
//
// load is given a signal that aborts once an ending starts, which a load that
// asks more than once passes on, so it stops before it asks again. A load
// stopped that way fails quietly.
export function useResource<T>(load: (signal: AbortSignal) => Promise<T>): Resource<T> {
  const [state, setState] = useState<{ data?: T; failure?: unknown }>({});
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const started = useRef(0);
  const applied = useRef(0);
  // The sequence of the load whose data is shown, 0 before any.
  const shown = useRef(0);
  const running = useRef(0);
  const onFailure = useUnauthenticatedCheck();
  const { askSignal } = useSession();

  const refresh = useCallback(() => {
    const signal = askSignal();
    if (signal.aborted) {
      return Promise.resolve(false);
    }
    const sequence = ++started.current;
    running.current++;
    setLoading(true);
    return loadRef
      .current(signal)
      .then(
        (data) => {
          if (sequence > applied.current) {
            applied.current = sequence;
            shown.current = sequence;
            setState({ data });
          }
          return shown.current >= sequence;
        },
        (failure: unknown) => {
          if (!signal.aborted && sequence > applied.current) {
            applied.current = sequence;
            setState((current) => ({ ...current, failure }));
            onFailure(failure);
          }
          return shown.current >= sequence;
        },
      )
      .finally(() => {
        running.current--;
        if (sequence === started.current) {
          setLoading(false);
        }
      });
  }, [onFailure, askSignal]);

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
// along with the rows. A load aborted, as useResource's are, reads no further
// page.
export function usePages<T, Extra extends object = object>(
  loadPage: (cursor: string | undefined, signal: AbortSignal) => Promise<Page<T> & Extra>,
): PagedResource<T, Extra> {
  const pages = useRef(1);
  const resource = useResource<Page<T> & Extra>(async (signal) => {
    const rows: T[] = [];
    let first: (Page<T> & Extra) | undefined;
    let next: string | undefined;
    for (let page = 0; page < pages.current; page++) {
      signal.throwIfAborted();
      const answer = await loadPage(next, signal);
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

// useVisible says whether the page is visible, and follows it.
export function useVisible(): boolean {
  return useSyncExternalStore(subscribeVisibility, () => document.visibilityState === "visible");
}

function subscribeVisibility(onChange: () => void): () => void {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

// What a view that reads something shows of it, such as a thread's messages
// or a session's log: the latest entry it shows, by sequence, and how far the
// reader has read.
export interface Shown {
  through: number;
  read: number;
}

export interface Reading {
  // Whether any mark the view started is still under way: marks overlap, as
  // when the view shows more before the last mark's answer, so this settles
  // only once every one has.
  pending: boolean;
  // Why the latest mark failed, until the view shows the entries read.
  failure: unknown;
  // stop ends reading for good, so nothing the view sends after the reader
  // marks something unread can undo that, even when marking fails, since its
  // answer may be lost after it landed.
  stop(): void;
}

// useReading reads what a view shows, as opening an email does: while the
// page is visible, it marks read through the latest entry shown whenever that
// is beyond the reader's mark, which happens on opening, when a refresh shows
// new entries and when later ones are shown. shown is undefined until the
// view has loaded, and a new value of it, as each answer of the view's
// resource gives, is when it looks again. It never reads an entry twice, so
// what another tab marks unread while this view shows it stays unread until a
// new entry arrives and this view reads through it. A failed mark stays shown,
// and the next answer tries again until the view shows the entries read. mark
// sends the mark through an entry, and onRead follows one that landed.
export function useReading(
  shown: Shown | undefined,
  mark: (through: number, csrf: string | undefined) => Promise<unknown>,
  onRead: () => void,
): Reading {
  const visible = useVisible();
  const { failure, run, clear } = useAction();
  // How many marks are under way, which the action's own pending, cleared as
  // each settles, cannot tell.
  const [outstanding, setOutstanding] = useState(0);
  const markRef = useRef(mark);
  markRef.current = mark;
  const onReadRef = useRef(onRead);
  onReadRef.current = onRead;
  // The furthest entry the view has marked read, is marking or found read
  // already.
  const marked = useRef(0);
  const stopped = useRef(false);
  useEffect(() => {
    if (shown === undefined || !visible || stopped.current) {
      return;
    }
    const { through, read } = shown;
    if (through <= read) {
      // Read already, perhaps by a mark whose answer was lost.
      marked.current = Math.max(marked.current, through);
      clear();
      return;
    }
    if (through <= marked.current) {
      return;
    }
    const before = marked.current;
    marked.current = through;
    setOutstanding((count) => count + 1);
    void run((csrf) => markRef.current(through, csrf))
      .then((done) => {
        if (done === undefined) {
          // The next answer tries again, unless the view has read further.
          if (marked.current === through) {
            marked.current = before;
          }
        } else {
          onReadRef.current();
        }
      })
      .finally(() => setOutstanding((count) => count - 1));
  }, [shown, visible, run, clear]);
  const stop = useCallback(() => {
    stopped.current = true;
  }, []);
  return { pending: outstanding > 0, failure, stop };
}

// useFresh remembers which entries, by sequence, were unread when a view
// showed them, so they stay marked unread while the view is open, though
// showing them reads them at once. unread is what is unread among the
// entries shown, as each answer gives it.
export function useFresh(unread: readonly number[] | undefined): ReadonlySet<number> {
  const fresh = useRef(new Set<number>());
  return useMemo(() => {
    for (const seq of unread ?? []) {
      fresh.current.add(seq);
    }
    return new Set(fresh.current);
  }, [unread]);
}

// newRequestId makes the id that lets the server recognize a retried write.
// Each user action gets one, and keeps it across retries of that action.
export function newRequestId(): string {
  return `web-${crypto.randomUUID()}`;
}
