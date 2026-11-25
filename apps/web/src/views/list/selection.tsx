import type { ThreadSummary } from "@wayfarerlabs/agention-api";
import { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMedia } from "../../media.ts";

// Selecting threads in the list, to act on them together. With a mouse or a
// trackpad each row carries a checkbox; on a phone or a tablet, holding a
// row down selects it, and while any is selected a tap selects or unselects
// a row in place of opening it. Either way the bar at the list's foot then
// holds the actions on them, until Clear or Escape clears the selection.
// The list's header checkbox selects every thread shown, those under a
// folded header left out, and once it has, the list offers to select every
// thread its filters keep instead (everything), which the server finds as it
// acts.
//
// The selection is the list's own, made afresh for each address, as the list
// is. It holds threads by their key, so it survives the list's refresh and
// pages loaded later, and it drops a thread that leaves the list.

// A device whose primary pointer is a finger, as AttachButton tells them.
const touch = "(pointer: coarse)";

// How long a finger rests on a row to select it, in milliseconds.
export const longPress = 500;

// The key a thread is selected by.
export const threadKey = (thread: { agent: string; session: string; number: number }) =>
  `${thread.agent}/${thread.session}/${thread.number}`;

// What a row needs of the selection: whether the device is touch-first,
// whether anything is selected, whether its thread is, and a way to select
// or unselect it.
export interface RowSelection {
  touch: boolean;
  selecting: boolean;
  isSelected: (key: string) => boolean;
  toggle: (key: string) => void;
}

export const ListSelection = createContext<RowSelection | undefined>(undefined);

export interface Selection extends RowSelection {
  // The loaded threads selected, in the list's order.
  chosen: ThreadSummary[];
  // Whether every thread the filters keep is selected, beyond those loaded.
  everything: boolean;
  // How many threads are shown, and whether every one of them is selected.
  shown: number;
  wholePage: boolean;
  // Selects every thread shown, or none.
  selectPage: (on: boolean) => void;
  // Selects every thread the filters keep, or only those shown.
  selectEverything: (on: boolean) => void;
  clear: () => void;
  // Which choice of the operator's the selection stands at: each one, a
  // thread selected or unselected, everything shown or matching selected,
  // or the selection cleared, moves it on, while a thread leaving the list
  // does not. An action takes it as it asks, and clearIf clears the
  // selection only while it still stands there, so an action that lands
  // after the operator chose again leaves their new choice alone.
  revision: () => number;
  clearIf: (revision: number) => void;
}

// useSelection holds the selection of the loaded threads given, of which
// those shown, by key, are the ones not under a folded header.
export function useSelection<T extends ThreadSummary>(
  rows: readonly T[],
  shown: readonly string[],
): Selection {
  const onTouch = useMedia(touch);
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [everything, setEverything] = useState(false);
  const loaded = useMemo(() => rows.map(threadKey), [rows]);
  const revised = useRef(0);

  // A thread that leaves the list leaves the selection, so it is not
  // selected should it come back.
  useEffect(() => {
    setKeys((current) => {
      const kept = new Set(loaded.filter((key) => current.has(key)));
      return kept.size === current.size ? current : kept;
    });
  }, [loaded]);

  const toggle = useCallback(
    (key: string) => {
      revised.current += 1;
      // Unselecting one thread of everything leaves the rest of those shown.
      if (everything) {
        setEverything(false);
        setKeys(new Set(shown.filter((each) => each !== key)));
        return;
      }
      setKeys((current) => {
        const next = new Set(current);
        if (!next.delete(key)) {
          next.add(key);
        }
        return next;
      });
    },
    [everything, shown],
  );
  const selectPage = useCallback(
    (on: boolean) => {
      revised.current += 1;
      setEverything(false);
      setKeys(new Set(on ? shown : []));
    },
    [shown],
  );
  const selectEverything = useCallback(
    (on: boolean) => {
      revised.current += 1;
      setEverything(on);
      setKeys(new Set(shown));
    },
    [shown],
  );
  const clear = useCallback(() => {
    revised.current += 1;
    setEverything(false);
    setKeys(new Set());
  }, []);
  const revision = useCallback(() => revised.current, []);
  const clearIf = useCallback(
    (submitted: number) => {
      if (revised.current === submitted) {
        clear();
      }
    },
    [clear],
  );
  const isSelected = useCallback((key: string) => everything || keys.has(key), [everything, keys]);
  const chosen = useMemo(
    () => (everything ? [...rows] : rows.filter((row) => keys.has(threadKey(row)))),
    [everything, keys, rows],
  );
  return {
    touch: onTouch,
    selecting: everything || chosen.length > 0,
    isSelected,
    toggle,
    chosen,
    everything,
    shown: shown.length,
    wholePage: everything || (shown.length > 0 && shown.every((key) => keys.has(key))),
    selectPage,
    selectEverything,
    clear,
    revision,
    clearIf,
  };
}
