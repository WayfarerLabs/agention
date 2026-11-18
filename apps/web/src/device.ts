import { useState } from "react";

// Choices the operator makes on one device, kept in the browser's storage. A
// browser that holds no choice, or refuses storage, gives the default; a
// choice it cannot keep still holds while the page is open.

function read(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

function keep(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage refused: the choice holds while the page is open.
  }
}

function readChoice(key: string): boolean | undefined {
  const value = read(key);
  return value === "true" ? true : value === "false" ? false : undefined;
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
export function useDeviceNames(
  key: string,
): [ReadonlySet<string>, (names: ReadonlySet<string>) => void] {
  const [names, setNames] = useState<ReadonlySet<string>>(() => new Set(readNames(key)));
  const choose = (next: ReadonlySet<string>) => {
    setNames(next);
    keep(key, JSON.stringify([...next]));
  };
  return [names, choose];
}
