import { useCallback, useState, useSyncExternalStore } from "react";

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

// useDeviceOption gives the option kept under key, one of options, or else
// fallback, as for a value it does not know, and a way to change and keep it.
export function useDeviceOption<T extends string>(
  key: string,
  options: readonly T[],
  fallback: T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(
    () => options.find((option) => option === read(key)) ?? fallback,
  );
  const choose = (next: T) => {
    setValue(next);
    keep(key, next);
  };
  return [value, choose];
}

// The names kept under each key while the page shows them, one set for every
// hook reading the key, so that two parts of a page keeping names under one
// key, as the sessions view's group heads do, see and keep each other's:
// read from storage once something on the page first reads them, and let go
// once nothing does, so the next to read them reads storage afresh.
const keptNames = new Map<string, { names: ReadonlySet<string>; listeners: Set<() => void> }>();

function namesUnder(key: string) {
  let kept = keptNames.get(key);
  if (kept === undefined) {
    kept = { names: new Set(readNames(key)), listeners: new Set() };
    keptNames.set(key, kept);
  }
  return kept;
}

// useDeviceNames gives the names kept under key, none by default, and a way
// to change and keep them, from the names as they stand then.
function useDeviceNames(
  key: string,
): [ReadonlySet<string>, (change: (names: ReadonlySet<string>) => ReadonlySet<string>) => void] {
  const subscribe = useCallback(
    (listener: () => void) => {
      const kept = namesUnder(key);
      kept.listeners.add(listener);
      return () => {
        kept.listeners.delete(listener);
        if (kept.listeners.size === 0 && keptNames.get(key) === kept) {
          keptNames.delete(key);
        }
      };
    },
    [key],
  );
  const names = useSyncExternalStore(subscribe, () => namesUnder(key).names);
  const change = (next: (names: ReadonlySet<string>) => ReadonlySet<string>) => {
    const kept = namesUnder(key);
    kept.names = next(kept.names);
    keep(key, JSON.stringify([...kept.names]));
    for (const listener of [...kept.listeners]) {
      listener();
    }
  };
  return [names, change];
}

// Folds are what this browser folded, or unfolded, of a view's headers, by
// name, such as the thread list's groups: whether it holds a name, and a way
// to flip it, which the browser keeps under key. Every Folds of one key holds
// the same names.
export interface Folds {
  has(name: string): boolean;
  toggle(name: string): void;
}

export function useFolds(key: string): Folds {
  const [names, change] = useDeviceNames(key);
  return {
    has: (name) => names.has(name),
    toggle: (name) =>
      change((current) => {
        const next = new Set(current);
        if (!next.delete(name)) {
          next.add(name);
        }
        return next;
      }),
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

// replaceDraft keeps a thread's draft as keepDraft does, but only while the
// stored record is still record (or none is stored when record is undefined),
// so a draft another tab or a later page kept since stays.
export function replaceDraft(
  thread: DraftThread,
  draft: Omit<KeptDraft, "kept">,
  since: string | undefined,
  record: string | undefined,
): string | undefined {
  if (read(draftKey(thread)) !== record) {
    return undefined;
  }
  return keepDraft(thread, draft, since);
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

// Whether this device receives notifications, as the operator left it here:
// on, which the web UI refreshes with the server as it starts; stopped, with
// why, once a refresh found them ended, which Settings say until the operator
// turns them on again; or off, with nothing kept. Only on is the operator's
// intent: a stopped device is never subscribed again without a tap.
export type StopReason = "dropped" | "removed";
export type DeviceNotifications =
  { state: "on" } | { state: "off" } | { state: "stopped"; why: StopReason };

const notificationsKey = "agention.notifications";
const notificationsListeners = new Set<() => void>();
// What the page holds of it, read from storage once, so it holds while the
// page is open where the browser refuses storage.
let notificationsHeld: { value: string | undefined } | undefined;

const heldNotifications = (): string | undefined => {
  notificationsHeld ??= { value: read(notificationsKey) };
  return notificationsHeld.value;
};

function parseNotifications(value: string | undefined): DeviceNotifications {
  switch (value) {
    case "on":
      return { state: "on" };
    case "stopped:dropped":
      return { state: "stopped", why: "dropped" };
    case "stopped:removed":
      return { state: "stopped", why: "removed" };
    default:
      return { state: "off" };
  }
}

// readDeviceNotifications reads what this device keeps of its notifications.
export const readDeviceNotifications = (): DeviceNotifications =>
  parseNotifications(heldNotifications());

// keepDeviceNotifications keeps it, forgetting it for off, and tells every
// part of the page that shows it.
export function keepDeviceNotifications(next: DeviceNotifications): void {
  const value =
    next.state === "off" ? undefined : next.state === "on" ? "on" : `stopped:${next.why}`;
  notificationsHeld = { value };
  if (value === undefined) {
    forget(notificationsKey);
  } else {
    keep(notificationsKey, value);
  }
  for (const listener of [...notificationsListeners]) {
    listener();
  }
}

const subscribeNotifications = (listener: () => void) => {
  notificationsListeners.add(listener);
  return () => {
    notificationsListeners.delete(listener);
  };
};

// useDeviceNotifications gives what this device keeps of its notifications,
// following each change the page makes.
export function useDeviceNotifications(): DeviceNotifications {
  return parseNotifications(useSyncExternalStore(subscribeNotifications, heldNotifications));
}

// forgetHeldNotifications has the page read the device's notifications from
// storage afresh, for tests that set storage themselves.
export function forgetHeldNotifications(): void {
  notificationsHeld = undefined;
}
