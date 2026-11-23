import { useState } from "react";

// What the operator keeps on one device, in the browser's storage: the
// choices they make, and their drafts. A browser that holds no choice, or
// refuses storage, gives the default; a choice or a draft it cannot keep still
// holds while the page is open.

function read(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

// keep keeps a value, saying whether the browser kept it.
function keep(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    // Storage refused: the choice holds while the page is open.
    return false;
  }
}

function readChoice(key: string): boolean | undefined {
  const value = read(key);
  return value === "true" ? true : value === "false" ? false : undefined;
}

function forget(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage refused: there is nothing kept to forget.
  }
}

// keys lists the keys the browser holds that start with prefix.
function keys(prefix: string): string[] {
  const found: string[] = [];
  try {
    const { localStorage } = window;
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix) === true) {
        found.push(key);
      }
    }
  } catch {
    // Storage refused: it holds nothing.
  }
  return found;
}

function keepChoice(key: string, value: boolean): void {
  keep(key, String(value));
}

// readNames reads a list of names kept as JSON. What is not one, a value
// another release or the operator left, counts as none.
function readNames(key: string): string[] {
  try {
    const value: unknown = JSON.parse(read(key) ?? "[]");
    return Array.isArray(value) ? value.filter((each) => typeof each === "string") : [];
  } catch {
    return [];
  }
}

// useDeviceChoice gives the choice kept under key, or fallback, and a way to
// change and keep it.
export function useDeviceChoice(
  key: string,
  fallback: boolean,
): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => readChoice(key) ?? fallback);
  const choose = (next: boolean) => {
    setValue(next);
    keepChoice(key, next);
  };
  return [value, choose];
}

// useDeviceNames gives the names kept under key, none by default, and a way
// to change and keep them.
function useDeviceNames(key: string): [ReadonlySet<string>, (names: ReadonlySet<string>) => void] {
  const [names, setNames] = useState<ReadonlySet<string>>(() => new Set(readNames(key)));
  const choose = (next: ReadonlySet<string>) => {
    setNames(next);
    keep(key, JSON.stringify([...next]));
  };
  return [names, choose];
}

// Folds are what this browser folded, or unfolded, of a view's headers, by
// name, such as the thread list's groups: whether it holds a name, and a way
// to flip it, which the browser keeps under key.
export interface Folds {
  has(name: string): boolean;
  toggle(name: string): void;
}

export function useFolds(key: string): Folds {
  const [names, keep] = useDeviceNames(key);
  return {
    has: (name) => names.has(name),
    toggle: (name) => {
      const next = new Set(names);
      if (!next.delete(name)) {
        next.add(name);
      }
      keep(next);
    },
  };
}

// A thread's draft, as this browser keeps it: the composer's text and
// details, the message the draft was started from, which its stale-write
// check counts from, whether it left behind what else the composer held,
// staged or attached or being recorded, which is not kept, and when it was
// kept.
export interface KeptDraft {
  text: string;
  detail: string;
  basis: number;
  leftBehind: boolean;
  kept: number;
}

// A thread, as its draft is kept by: the browser keeps one set of storage for
// each origin, so for each server.
export interface DraftThread {
  agent: string;
  session: string;
  number: number;
}

const draftPrefix = "agention.draft.";
// A mark each sign-out of this browser changes: a page that opened before the
// latest keeps no draft, since another person may use the browser next.
const signOutKey = "agention.sign-out";
// A draft is kept for 30 days since it was last kept, as the operator opens
// its thread or types in it, and the browser keeps the latest 50, which caps
// the storage drafts take: an old draft, such as one of a thread archived or
// gone, is forgotten.
export const draftDays = 30;
export const maxDrafts = 50;
const dayMs = 24 * 60 * 60 * 1000;

const draftKey = ({ agent, session, number }: DraftThread) =>
  `${draftPrefix}${JSON.stringify([agent, session, number])}`;

// parseDraft reads a kept draft. What is not one, or was kept too long ago or
// after now, counts as none: another release, another clock or the operator
// may have left it, and the next new draft forgets it.
export function parseDraft(value: string | undefined, now: number): KeptDraft | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    const draft = JSON.parse(value) as Partial<Record<keyof KeptDraft, unknown>> | null;
    if (
      typeof draft?.text !== "string" ||
      typeof draft.detail !== "string" ||
      typeof draft.basis !== "number" ||
      !Number.isSafeInteger(draft.basis) ||
      draft.basis < 0 ||
      typeof draft.leftBehind !== "boolean" ||
      typeof draft.kept !== "number" ||
      !Number.isFinite(draft.kept) ||
      draft.kept > now ||
      now - draft.kept > draftDays * dayMs
    ) {
      return undefined;
    }
    return {
      text: draft.text,
      detail: draft.detail,
      basis: draft.basis,
      leftBehind: draft.leftBehind,
      kept: draft.kept,
    };
  } catch {
    return undefined;
  }
}

// readDraft gives the draft this browser keeps for a thread.
export function readDraft(thread: DraftThread): KeptDraft | undefined {
  return parseDraft(read(draftKey(thread)), Date.now());
}

// signOutMark gives the mark of this browser's latest sign-out, which a page
// reads as it opens, for keepDraft.
export function signOutMark(): string | undefined {
  return read(signOutKey);
}

// keepDraft keeps a thread's draft, giving the record it kept, for
// forgetDraft: not once the browser signed out since the page keeping it read
// signOutMark, and a draft the browser refuses to keep forgets the one it kept
// before, which would come back older. A new draft first forgets those that
// count as none, then the oldest past the latest 50.
export function keepDraft(
  thread: DraftThread,
  draft: Omit<KeptDraft, "kept">,
  since: string | undefined,
): string | undefined {
  if (signOutMark() !== since) {
    return undefined;
  }
  const key = draftKey(thread);
  const now = Date.now();
  if (read(key) === undefined) {
    const kept: { key: string; at: number }[] = [];
    for (const each of keys(draftPrefix)) {
      const other = parseDraft(read(each), now);
      if (other === undefined) {
        forget(each);
      } else {
        kept.push({ key: each, at: other.kept });
      }
    }
    kept.sort((a, b) => b.at - a.at);
    for (const { key: each } of kept.slice(maxDrafts - 1)) {
      forget(each);
    }
  }
  const record = JSON.stringify({ ...draft, kept: now });
  if (keep(key, record)) {
    return record;
  }
  forget(key);
  return undefined;
}

// forgetDraft forgets a thread's draft while it is still the record a page
// kept, so a draft another tab kept since stays.
export function forgetDraft(thread: DraftThread, record: string): void {
  const key = draftKey(thread);
  if (read(key) === record) {
    forget(key);
  }
}

// forgetDrafts forgets every draft this browser keeps, when it signs out,
// then marks the sign-out afresh, so a page open from before keeps none
// again: the drafts go first, which leaves room for the mark.
export function forgetDrafts(): void {
  for (const key of keys(draftPrefix)) {
    forget(key);
  }
  keep(signOutKey, crypto.randomUUID());
}
